import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  at,
  call,
  cannedApproval,
  ids,
  jsonResponse,
  live,
  openApproval,
  problemResponse,
  recorder,
  startHarness,
  toolHidingArguments,
  until,
} from './testing/approvals-harness.js';
import type { Harness, Live } from './testing/approvals-harness.js';

// Contract revision 6, proved against the mock that vendors it: the stream filter that narrows the events,
// more of the queue and the recently decided requests, approving several at once, and the problem members.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

// The digests the queue holds for `wanted`, as a person who confirmed them would have seen them.
const seen = (l: Live, wanted: readonly string[]): ReadonlyMap<string, string> =>
  new Map(
    l
      .snapshot()
      .approvals.filter((r) => wanted.includes(r.id))
      .map((r) => [r.id, r.action_digest])
  );

let open: Live[] = [];
afterEach(() => {
  for (const l of open) l.close();
  open = [];
});

const approverLive = (
  extra: Parameters<typeof live>[0] extends infer O ? Partial<O> : never = {}
): Live => {
  const l = live({
    baseUrl: h.baseUrl,
    getToken: () => h.tokens.approver,
    reconcileMs: 600_000,
    ...extra,
  });
  open.push(l);
  return l;
};

describe('the stream filter narrows the events', () => {
  it('opens the stream with approver=me, and an event for an approval this person may decide prompts a list read, and the row comes from that read', async () => {
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    await until(l.store, (s) => s.status === 'ready' && s.connection === 'live');
    const stream = rec.calls.find((c) => c.path === '/v1/approvals/stream');
    expect(new URLSearchParams(stream?.query).get('approver')).toBe('me');
    // Let the connect re-list finish, then count lists.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const lists = rec.count('GET', '/v1/approvals');
    // A pending approval by a service principal, escalated: an update that leaves it pending, which the stream delivers.
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const escalated = await call(
      h.baseUrl,
      h.tokens.creator_user,
      'POST',
      `/v1/approvals/${opened.id}/resolve`,
      {
        resolution: 'escalated',
        expected_action_digest: opened.digest,
      }
    );
    expect(escalated.status).toBe(200);
    const seen = await until(l.store, (s) => ids(s.approvals).includes(opened.id));
    expect(seen.connection).toBe('live');
    // The event is a prompt: the filtered list read produced the row.
    expect(rec.count('GET', '/v1/approvals')).toBeGreaterThan(lists);
  });

  it('is not shown an event for an approval this person created, and still sees the event that resolves one it may decide', async () => {
    const l = approverLive();
    await until(l.store, (s) => s.status === 'ready' && s.connection === 'live');
    const own = await openApproval(h.baseUrl, h.tokens.approver);
    await call(h.baseUrl, h.tokens.approver, 'POST', `/v1/approvals/${own.id}/withdraw`);
    const theirs = await openApproval(h.baseUrl, h.tokens.creator);
    await call(h.baseUrl, h.tokens.creator_user, 'POST', `/v1/approvals/${theirs.id}/resolve`, {
      resolution: 'escalated',
      expected_action_digest: theirs.digest,
    });
    await until(l.store, (s) => ids(s.approvals).includes(theirs.id));
    expect(ids(l.snapshot().approvals)).not.toContain(own.id);
    // The decision by someone else is delivered although the approval is no longer pending, so the row goes.
    await call(h.baseUrl, h.tokens.creator_user, 'POST', `/v1/approvals/${theirs.id}/approve`, {
      expected_action_digest: theirs.digest,
    });
    await until(l.store, (s) => !ids(s.approvals).includes(theirs.id));
  });

  it('puts an event in the queue newest first, and leaves out one outside the store scope', async () => {
    const l = approverLive({ scope: 'scope_nobody_has' });
    await until(l.store, (s) => s.status === 'ready' && s.connection === 'live');
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    await call(h.baseUrl, h.tokens.creator_user, 'POST', `/v1/approvals/${opened.id}/resolve`, {
      resolution: 'escalated',
      expected_action_digest: opened.digest,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ids(l.snapshot().approvals)).not.toContain(opened.id);
  });

  it('falls back to the unfiltered stream, and lists to confirm an event, when the service answers 400 to approver', async () => {
    const rec = recorder();
    rec.intercept((c, request) =>
      c.path === '/v1/approvals/stream' && new URL(request.url).searchParams.has('approver')
        ? problemResponse(400, 'invalid_request')
        : undefined
    );
    const l = approverLive({ fetch: rec.fetch });
    await until(l.store, (s) => s.status === 'ready' && s.connection === 'live');
    const streams = rec.calls.filter((c) => c.path === '/v1/approvals/stream');
    expect(streams.length).toBeGreaterThanOrEqual(2);
    expect(new URLSearchParams(at(streams, 0).query).get('approver')).toBe('me');
    expect(new URLSearchParams(at(streams, 1).query).has('approver')).toBe(false);
    // The unfiltered stream carries events for approvals that are not this person's: the list decides.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const lists = rec.count('GET', '/v1/approvals');
    // An approval this person created, escalated by someone else: a pending event that is not for their queue.
    const own = await openApproval(h.baseUrl, h.tokens.approver);
    await call(h.baseUrl, h.tokens.creator_user, 'POST', `/v1/approvals/${own.id}/resolve`, {
      resolution: 'escalated',
      expected_action_digest: own.digest,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(rec.count('GET', '/v1/approvals')).toBeGreaterThan(lists);
    expect(ids(l.snapshot().approvals)).not.toContain(own.id);
  });
});

describe('more of the queue', () => {
  it('grows the page by 50 up to the 200 the service returns at once, and shows the rows it adds', async () => {
    const rec = recorder();
    rec.intercept((c) => {
      if (c.method !== 'GET' || c.path !== '/v1/approvals') return undefined;
      const limit = Number(new URLSearchParams(c.query).get('limit'));
      // A service with 120 waiting: the page is cut at the limit asked for.
      const rows = Array.from({ length: 120 }, (_v, n) =>
        cannedApproval(`apr_more_${String(n).padStart(3, '0')}`, {
          created_at: new Date(Date.UTC(2026, 9, 5, 0, 0, 120 - n)).toISOString(),
        })
      );
      return jsonResponse({
        data: rows.slice(0, limit),
        meta: { request_id: 'r', deployment: 'hosted', next: limit < 120 ? String(limit) : null },
      });
    });
    const l = approverLive({ fetch: rec.fetch });
    await until(l.store, (s) => s.status === 'ready');
    expect(l.snapshot().approvals).toHaveLength(50);
    expect(l.snapshot().truncated).toBe(true);
    await l.store.loadMore();
    const second = await until(l.store, (s) => s.approvals.length === 100);
    expect(second.truncated).toBe(true);
    await l.store.loadMore();
    const third = await until(l.store, (s) => s.approvals.length === 120);
    expect(third.truncated).toBe(false);
    // Nothing more to ask for: no further list is sent for it.
    const lists = rec.count('GET', '/v1/approvals');
    await l.store.loadMore();
    expect(rec.count('GET', '/v1/approvals')).toBe(lists);
    expect(
      new Set(
        rec.calls
          .filter((c) => c.path === '/v1/approvals')
          .map((c) => new URLSearchParams(c.query).get('limit'))
      )
    ).toEqual(new Set(['50', '100', '150']));
  });
});

describe('the recently decided requests', () => {
  it('reads state=approved,rejected,consumed ordered by resolution time, newest decision first, with names', async () => {
    const first = await openApproval(h.baseUrl, h.tokens.creator);
    const second = await openApproval(h.baseUrl, h.tokens.creator);
    await call(h.baseUrl, h.tokens.approver, 'POST', `/v1/approvals/${first.id}/deny`, {
      expected_action_digest: first.digest,
    });
    await call(h.baseUrl, h.tokens.approver, 'POST', `/v1/approvals/${second.id}/approve`, {
      expected_action_digest: second.digest,
    });
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    await until(l.store, (s) => s.status === 'ready');
    expect(l.snapshot().recent).toBeUndefined();
    await l.store.loadRecent();
    const seen = await until(l.store, (s) => s.recent?.status === 'ready');
    const query = new URLSearchParams(
      rec.calls.filter((c) => c.path === '/v1/approvals' && c.query.includes('order')).at(-1)?.query
    );
    expect(query.get('state')).toBe('approved,rejected,consumed');
    expect(query.get('order')).toBe('resolved_at');
    const rows = seen.recent?.approvals ?? [];
    expect(ids(rows).slice(0, 2)).toEqual([second.id, first.id]);
    expect(at(rows, 0).approver).toMatchObject({ id: 'user_approver', display_name: 'Approver' });
    expect(at(rows, 0).requester).toMatchObject({ kind: 'service' });
    expect(rows.every((r) => !('arguments' in r))).toBe(true);
  });

  it('shows an older page after the first, without repeating a row, and keeps what it has when a read fails', async () => {
    const page = (from: number, to: number, next: string | null): Response =>
      jsonResponse({
        data: Array.from({ length: to - from }, (_v, n) =>
          cannedApproval(`apr_old_${String(from + n)}`, {
            state: 'approved',
            resolved_at: '2026-10-05T00:00:00.000Z',
          })
        ),
        meta: { request_id: 'r', deployment: 'hosted', next },
      });
    const rec = recorder();
    let failNext = false;
    rec.intercept((c) => {
      if (
        c.method !== 'GET' ||
        c.path !== '/v1/approvals' ||
        !c.query.includes('order=resolved_at')
      )
        return undefined;
      const cursor = new URLSearchParams(c.query).get('cursor');
      if (cursor === null) return page(0, 3, 'c2');
      if (failNext) return problemResponse(503, 'service_unavailable');
      // The second page repeats the last row of the first, as a list that moved under the cursor can.
      return page(2, 5, null);
    });
    const l = approverLive({ fetch: rec.fetch });
    await until(l.store, (s) => s.status === 'ready');
    await l.store.loadRecent();
    await until(l.store, (s) => s.recent?.status === 'ready');
    expect(l.snapshot().recent).toMatchObject({ more: true });
    failNext = true;
    await l.store.loadMoreRecent();
    const failed = await until(l.store, (s) => s.recent?.status === 'error');
    expect(ids(failed.recent?.approvals ?? [])).toEqual(['apr_old_0', 'apr_old_1', 'apr_old_2']);
    expect(failed.recent?.error).toMatchObject({ kind: 'unavailable' });
    failNext = false;
    await l.store.loadMoreRecent();
    const done = await until(
      l.store,
      (s) => s.recent?.status === 'ready' && s.recent.approvals.length === 5
    );
    expect(ids(done.recent?.approvals ?? [])).toEqual([
      'apr_old_0',
      'apr_old_1',
      'apr_old_2',
      'apr_old_3',
      'apr_old_4',
    ]);
    expect(done.recent?.more).toBe(false);
    // No cursor left: asking again sends nothing.
    const reads = rec.calls.length;
    await l.store.loadMoreRecent();
    expect(rec.calls.length).toBe(reads);
  });

  it('a read that fails and has shown nothing is an error, never an empty list', async () => {
    const rec = recorder();
    rec.intercept((c) =>
      c.path === '/v1/approvals' && c.query.includes('order=resolved_at')
        ? jsonResponse({ data: [{ id: '' }], meta: {} })
        : undefined
    );
    const l = approverLive({ fetch: rec.fetch });
    await until(l.store, (s) => s.status === 'ready');
    await l.store.loadRecent();
    const seen = await until(l.store, (s) => s.recent?.status === 'error');
    expect(seen.recent?.approvals).toEqual([]);
    expect(seen.recent?.error).toMatchObject({ kind: 'malformed_response' });
  });
});

describe('approving several at once', () => {
  const openMany = async (n: number): Promise<{ id: string; digest: string }[]> => {
    const out: { id: string; digest: string }[] = [];
    const tool = await toolHidingArguments(h.baseUrl);
    for (let i = 0; i < n; i += 1)
      out.push(await openApproval(h.baseUrl, h.tokens.creator, { tool }));
    return out;
  };

  it('approves each as the queue lists it, in one call, and the rows leave the queue', async () => {
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    const [a, b, c] = await openMany(3);
    await until(l.store, (s) => [a, b, c].every((x) => ids(s.approvals).includes(x?.id ?? '')));
    const sent = [a?.id ?? '', b?.id ?? '', c?.id ?? ''];
    const result = await l.store.approveMany(sent, seen(l, sent));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results.map((r) => r.id)).toEqual(sent);
    expect(result.results.every((r) => r.ok && r.approval.state === 'approved')).toBe(true);
    const batch = rec.calls.filter((x) => x.path === '/v1/approvals/resolve/batch');
    expect(batch).toHaveLength(1);
    const items = (
      at(batch, 0).body as {
        items: { approval_id: string; resolution: string; expected_action_digest: string }[];
      }
    ).items;
    expect(items.map((i) => i.approval_id)).toEqual(sent);
    expect(items.map((i) => i.expected_action_digest)).toEqual([a?.digest, b?.digest, c?.digest]);
    expect(new Set(items.map((i) => i.resolution))).toEqual(new Set(['approved']));
    for (const id of sent) expect(ids(l.snapshot().approvals)).not.toContain(id);
    expect(l.snapshot().resolving.size).toBe(0);
  });

  it('answers a request that conflicts on its own, and an id the queue does not hold with no request', async () => {
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    const [a, b] = await openMany(2);
    await until(l.store, (s) => [a, b].every((x) => ids(s.approvals).includes(x?.id ?? '')));
    // The second is withdrawn by its creator after the approver listed it and the person confirmed both.
    const confirmed = seen(l, [a?.id ?? '', b?.id ?? '']);
    await call(h.baseUrl, h.tokens.creator, 'POST', `/v1/approvals/${b?.id ?? ''}/withdraw`);
    const result = await l.store.approveMany(
      [a?.id ?? '', b?.id ?? '', 'apr_not_in_the_queue', a?.id ?? ''],
      confirmed
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Asked once each, in the order given.
    expect(result.results.map((r) => r.id)).toEqual([a?.id, b?.id, 'apr_not_in_the_queue']);
    expect(result.results[0]).toMatchObject({ ok: true });
    expect(result.results[1]).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(result.results[2]).toMatchObject({
      ok: false,
      error: { kind: 'conflict', code: 'already_resolved', local: true },
    });
    const batch = rec.calls.filter((x) => x.path === '/v1/approvals/resolve/batch');
    expect((at(batch, 0).body as { items: unknown[] }).items).toHaveLength(2);
  });

  it('splits a selection above the service limit into calls it accepts', async () => {
    await call(h.baseUrl, h.tokens.creator, 'POST', '/__mock/control', {
      limits: { resolutions_batch_max_items: 2 },
    });
    try {
      const rec = recorder();
      const l = approverLive({ fetch: rec.fetch });
      const made = await openMany(5);
      await until(l.store, (s) => made.every((x) => ids(s.approvals).includes(x.id)));
      const result = await l.store.approveMany(
        made.map((x) => x.id),
        seen(
          l,
          made.map((x) => x.id)
        )
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.results.every((r) => r.ok)).toBe(true);
      const sizes = rec.calls
        .filter((x) => x.path === '/v1/approvals/resolve/batch')
        .map((x) => (x.body as { items?: unknown[] }).items?.length ?? 0);
      // Refused whole at 50, 25, 12, 6 and 3, then sent two or fewer at a time.
      expect(sizes.filter((n) => n <= 2).reduce((a, b) => a + b, 0)).toBe(5);
      expect(sizes.some((n) => n > 2)).toBe(true);
    } finally {
      await call(h.baseUrl, h.tokens.creator, 'POST', '/__mock/control', { reset: true });
    }
  });

  it('reports a call that failed whole with the service reason, and decides nothing', async () => {
    const l = approverLive();
    const [a] = await openMany(1);
    await until(l.store, (s) => ids(s.approvals).includes(a?.id ?? ''));
    await call(h.baseUrl, h.tokens.creator, 'POST', '/__mock/control', {
      fail: {
        operation: 'resolveApprovalsBatch',
        status: 503,
        retry_after: 3,
        reason: 'eligibility_lookup',
      },
    });
    const result = await l.store.approveMany([a?.id ?? ''], seen(l, [a?.id ?? '']));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'unavailable', reason: 'eligibility_lookup', retryAfterMs: 3000 },
    });
    expect(ids(l.snapshot().approvals)).toContain(a?.id);
    expect(l.snapshot().resolving.size).toBe(0);
  });

  it('answers a malformed batch as one the page could not read, and nothing for an empty selection', async () => {
    const rec = recorder();
    rec.intercept((c) =>
      c.path === '/v1/approvals/resolve/batch' ? jsonResponse({ data: [], meta: {} }) : undefined
    );
    const l = approverLive({ fetch: rec.fetch });
    const [a] = await openMany(1);
    await until(l.store, (s) => ids(s.approvals).includes(a?.id ?? ''));
    expect(await l.store.approveMany([a?.id ?? ''], seen(l, [a?.id ?? '']))).toMatchObject({
      ok: false,
      error: { kind: 'malformed_response' },
    });
    expect(await l.store.approveMany([], new Map())).toEqual({ ok: true, results: [] });
  });
});

describe('the batch approves only what showed no arguments', () => {
  it('never approves a request whose arguments the approver could read, and sends no batch that contains it', async () => {
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    // The reviewer's case: a request with readable arguments, never opened, batch-approved.
    const readable = await openApproval(h.baseUrl, h.tokens.creator);
    await until(l.store, (s) => ids(s.approvals).includes(readable.id));
    expect(l.snapshot().approvals.find((r) => r.id === readable.id)?.arguments_state).toBe('shown');
    const result = await l.store.approveMany([readable.id], seen(l, [readable.id]));
    expect(result).toMatchObject({
      ok: true,
      results: [{ id: readable.id, ok: false, error: { kind: 'precondition' } }],
    });
    expect(rec.calls.filter((x) => x.path === '/v1/approvals/resolve/batch')).toHaveLength(0);
    expect(l.snapshot().approvals.find((r) => r.id === readable.id)?.state).toBe('pending');
  });

  // A service whose list says one thing about every row's arguments: `undefined` removes the member.
  const listSaying =
    (state: string | undefined): typeof fetch =>
    async (input, init) => {
      const request = new Request(input, init);
      const response = await globalThis.fetch(request);
      if (new URL(request.url).pathname !== '/v1/approvals') return response;
      const body = (await response.json()) as { data: Record<string, unknown>[] };
      const data = body.data.map((row) => {
        const rest = Object.fromEntries(
          Object.entries(row).filter(([k]) => k !== 'arguments_state')
        );
        return state === undefined ? rest : { ...rest, arguments_state: state };
      });
      return new Response(JSON.stringify({ ...body, data }), {
        status: response.status,
        headers: response.headers,
      });
    };

  it.each([
    ['absent', undefined],
    ['withheld', 'withheld'],
  ])(
    'refuses a row whose arguments_state is %s with precondition, and sends no request',
    async (_name, state) => {
      const rec = recorder(listSaying(state));
      const l = approverLive({ fetch: rec.fetch });
      const tool = await toolHidingArguments(h.baseUrl);
      const opened = await openApproval(h.baseUrl, h.tokens.creator, { tool });
      await until(l.store, (s) => ids(s.approvals).includes(opened.id));
      expect(l.snapshot().approvals.find((r) => r.id === opened.id)?.arguments_state).toBe(state);
      const before = rec.calls.length;
      const result = await l.store.approveMany([opened.id], new Map([[opened.id, opened.digest]]));
      expect(result).toMatchObject({
        ok: true,
        results: [{ id: opened.id, ok: false, error: { kind: 'precondition' } }],
      });
      expect(rec.calls.slice(before).filter((x) => x.method !== 'GET')).toHaveLength(0);
      expect(rec.calls.filter((x) => x.path === '/v1/approvals/resolve/batch')).toHaveLength(0);
    }
  );

  it('sends nothing for a row the person has no confirmed digest for', async () => {
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    const tool = await toolHidingArguments(h.baseUrl);
    const a = await openApproval(h.baseUrl, h.tokens.creator, { tool });
    await until(l.store, (s) => ids(s.approvals).includes(a.id));
    const result = await l.store.approveMany([a.id], new Map());
    expect(result).toMatchObject({
      ok: true,
      results: [{ id: a.id, ok: false, error: { kind: 'conflict' } }],
    });
    expect(rec.calls.filter((x) => x.path === '/v1/approvals/resolve/batch')).toHaveLength(0);
  });

  it('drops an item whose digest is not the one the person confirmed, and sends the confirmed digest for the rest', async () => {
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    const tool = await toolHidingArguments(h.baseUrl);
    const a = await openApproval(h.baseUrl, h.tokens.creator, { tool });
    const b = await openApproval(h.baseUrl, h.tokens.creator, { tool });
    await until(l.store, (s) => [a, b].every((x) => ids(s.approvals).includes(x.id)));
    const result = await l.store.approveMany(
      [a.id, b.id],
      new Map([
        [a.id, a.digest],
        [b.id, 'sha256:the-digest-before-the-change'],
      ])
    );
    expect(result).toMatchObject({
      ok: true,
      results: [
        { id: a.id, ok: true },
        { id: b.id, ok: false, error: { kind: 'conflict' } },
      ],
    });
    const batch = rec.calls.filter((x) => x.path === '/v1/approvals/resolve/batch');
    const items = (
      at(batch, 0).body as { items: { approval_id: string; expected_action_digest: string }[] }
    ).items;
    expect(items).toEqual([
      expect.objectContaining({ approval_id: a.id, expected_action_digest: a.digest }),
    ]);
    expect(l.snapshot().approvals.find((r) => r.id === b.id)?.state).toBe('pending');
  });
});

describe('a service that ignores the stream filter', () => {
  // It answers 200 to `approver=me` on the stream and delivers every approval: nothing in the contract says
  // whether a stream is filtered, so an event is only a prompt to read the filtered list.
  const ignoringFilter: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname !== '/v1/approvals/stream') return globalThis.fetch(request);
    url.searchParams.delete('approver');
    return globalThis.fetch(new Request(url, request));
  };

  it('never puts an approval this person cannot decide in their queue, though the stream delivers it', async () => {
    const rec = recorder(ignoringFilter);
    const l = approverLive({ fetch: rec.fetch });
    await until(l.store, (s) => s.status === 'ready' && s.connection === 'live');
    expect(
      rec.calls.some(
        (c) =>
          c.path === '/v1/approvals/stream' && new URLSearchParams(c.query).get('approver') === 'me'
      )
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const lists = rec.count('GET', '/v1/approvals');
    const everInQueue = new Set<string>();
    l.store.subscribe(() => {
      for (const r of l.snapshot().approvals) everInQueue.add(r.id);
    });
    // An approval this person created, escalated by another: pending, and not theirs to decide.
    const own = await openApproval(h.baseUrl, h.tokens.approver);
    await call(h.baseUrl, h.tokens.creator_user, 'POST', `/v1/approvals/${own.id}/resolve`, {
      resolution: 'escalated',
      expected_action_digest: own.digest,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(rec.count('GET', '/v1/approvals')).toBeGreaterThan(lists);
    expect(everInQueue.has(own.id)).toBe(false);
  });
});

describe("waiting_on is the single read's alone", () => {
  const waiting = { count: 2, principals: [{ id: 'user_x', kind: 'user', display_name: 'Xi' }] };

  it('is not kept from a list row, and is kept from the single read of the same approval', async () => {
    const rec = recorder();
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    rec.intercept((c) => {
      if (c.method === 'GET' && c.path === '/v1/approvals') {
        return jsonResponse({
          data: [cannedApproval(opened.id, { waiting_on: waiting })],
          meta: { request_id: 'r', deployment: 'hosted', next: null },
        });
      }
      if (c.method === 'GET' && c.path === `/v1/approvals/${opened.id}`) {
        return jsonResponse({
          data: cannedApproval(opened.id, { waiting_on: waiting }),
          meta: { request_id: 'r', deployment: 'hosted' },
        });
      }
      return undefined;
    });
    const l = approverLive({ fetch: rec.fetch });
    await until(l.store, (s) => ids(s.approvals).includes(opened.id));
    expect(l.snapshot().approvals[0]?.waiting_on).toBeUndefined();
    l.store.openDetail(opened.id);
    await until(l.store, (s) => s.detail?.status === 'loaded');
    const shown = l.snapshot().detail;
    expect(shown !== undefined && 'approval' in shown ? shown.approval.waiting_on : 'none').toEqual(
      waiting
    );
    expect(l.snapshot().approvals[0]?.waiting_on).toBeUndefined();
  });
});

describe('nothing a person was shown reaches storage or the console', () => {
  it('keeps names, the waiting_on principals and the batch confirmation out of both, across the queue, the recently resolved view, the open request and a batch', async () => {
    const NAME = 'NAME_MARKER_5f2c';
    const bag = new Map<string, string>();
    const storage = {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: vi.fn((k: string, v: string) => void bag.set(k, v)),
      removeItem: (k: string) => void bag.delete(k),
      clear: () => {
        bag.clear();
      },
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    try {
      const named = { id: 'user_n', kind: 'user', display_name: NAME };
      const pending = cannedApproval('apr_named', {
        requester: named,
        arguments_state: 'not_enabled',
      });
      const rec = recorder();
      rec.intercept((c) => {
        if (c.method === 'GET' && c.path === '/v1/approvals') {
          const recent = (new URLSearchParams(c.query).get('state') ?? '').includes(',');
          return jsonResponse({
            data: [
              recent
                ? cannedApproval('apr_done', {
                    state: 'approved',
                    approver: named,
                    requester: named,
                  })
                : pending,
            ],
            meta: { request_id: 'r', deployment: 'hosted', next: null },
          });
        }
        if (c.method === 'GET' && c.path === '/v1/approvals/apr_named') {
          return jsonResponse({
            data: { ...pending, waiting_on: { count: 1, principals: [named] } },
            meta: { request_id: 'r', deployment: 'hosted' },
          });
        }
        return undefined;
      });
      const l = approverLive({ fetch: rec.fetch });
      await until(l.store, (s) => ids(s.approvals).includes('apr_named'));
      await l.store.loadRecent();
      l.store.openDetail('apr_named');
      await until(l.store, (s) => s.detail?.status === 'loaded');
      await l.store.approveMany(['apr_named'], new Map([['apr_named', 'sha256:shown']]));
      // The names are in the snapshot a view renders from, and nowhere else.
      expect(JSON.stringify(l.snapshot())).toContain(NAME);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(JSON.stringify([...bag])).not.toContain(NAME);
      for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(NAME);
      expect(JSON.stringify(rec.calls.map((c) => [c.path, c.query]))).not.toContain(NAME);
      l.store.dispose();
    } finally {
      vi.unstubAllGlobals();
      for (const spy of spies) spy.mockRestore();
    }
  });
});
