import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  at,
  call,
  cannedApproval,
  eventFrame,
  handStream,
  ids,
  inProcessFetch,
  jsonResponse,
  live,
  openApproval,
  openApprovalIn,
  problemResponse,
  recorder,
  startHarness,
  until,
} from './testing/approvals-harness.js';
import type { Harness, Live, Recorder } from './testing/approvals-harness.js';
import { advance, advanceUntil, fakeTime } from './testing/approvals-fake-time.js';

let h: Harness;
let mockFetch: typeof fetch;
beforeAll(async () => {
  h = await startHarness();
  mockFetch = inProcessFetch(h.mock);
});
afterAll(async () => {
  await h.stop();
});

let open: Live[] = [];
beforeEach(() => {
  fakeTime();
});
afterEach(() => {
  for (const l of open) l.close();
  open = [];
  vi.useRealTimers();
});

const track = (l: Live): Live => {
  open.push(l);
  return l;
};

const isList = (c: { method: string; path: string }): boolean =>
  c.method === 'GET' && c.path === '/v1/approvals';

/** Holds the next list response back until `release()`; the server answered it at once, so it is stale. */
function holdNextList(rec: Recorder): () => void {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;
  rec.intercept(async (c, request) => {
    if (!armed || !isList(c)) return undefined;
    armed = false;
    const answer = await mockFetch(request);
    await gate;
    return answer;
  });
  return release;
}

const fromApprover = (rec: Recorder, extra: Partial<Parameters<typeof live>[0]> = {}): Live =>
  track(
    live({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.approver,
      fetch: rec.fetch,
      reconcileMs: 5000,
      ...extra,
    })
  );

const settled = (l: Live): boolean =>
  l.snapshot().status === 'ready' && l.snapshot().connection === 'live';

async function started(
  rec: Recorder,
  extra: Partial<Parameters<typeof live>[0]> = {}
): Promise<Live> {
  const l = fromApprover(rec, extra);
  await advanceUntil(() => settled(l));
  return l;
}

const loaded = (l: Live, id: string): boolean =>
  l.snapshot().detail?.id === id && l.snapshot().detail?.status === 'loaded';

describe('T24 tombstones and the queued re-list', () => {
  it('(a) a stream event for an id, arriving during a delayed list, keeps the row from reappearing', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = await started(rec);
    expect(ids(l.snapshot().approvals)).toContain(a.id);
    const release = holdNextList(rec);
    const refreshed = l.store.refresh();
    await advanceUntil(() => rec.count('GET', '/v1/approvals') >= 2);
    // Someone approves it while the (stale) list is still on its way.
    await mockFetch(
      new Request(`${h.baseUrl}/v1/approvals/${a.id}/resolve`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${h.tokens.approver}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ resolution: 'approved', expected_action_digest: a.digest }),
      })
    );
    await advanceUntil(() => !ids(l.snapshot().approvals).includes(a.id));
    release();
    await refreshed;
    await advance(100);
    expect(ids(l.snapshot().approvals)).not.toContain(a.id);
  });

  it('(b) a resolve 200 for an id, arriving during a delayed list, keeps the row from reappearing', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = await started(rec);
    l.store.openDetail(a.id);
    await advanceUntil(() => loaded(l, a.id));
    const release = holdNextList(rec);
    const refreshed = l.store.refresh();
    await advanceUntil(() => rec.count('GET', '/v1/approvals') >= 2);
    const result = l.store.approve(a.id);
    await advanceUntil(() => !ids(l.snapshot().approvals).includes(a.id));
    expect((await result).ok).toBe(true);
    release();
    await refreshed;
    await advance(100);
    expect(ids(l.snapshot().approvals)).not.toContain(a.id);
  });

  it('(c) a pending event for a new id, arriving during a delayed list, runs exactly one more list after it', async () => {
    const rec = recorder(mockFetch);
    const l = await started(rec);
    const release = holdNextList(rec);
    const refreshed = l.store.refresh();
    await advanceUntil(() => rec.count('GET', '/v1/approvals') >= 2);
    const lists = rec.count('GET', '/v1/approvals');
    const fresh = await openApprovalIn(h.mock, h.tokens.creator_user);
    // The event reaches the store (its stream is live), which asks for a re-list; the held list is in flight.
    await advance(600);
    expect(rec.count('GET', '/v1/approvals')).toBe(lists);
    release();
    await refreshed;
    await advanceUntil(() => ids(l.snapshot().approvals).includes(fresh.id), 3000);
    // One more list, not the reconcile (5 s at the floor): the new approval came from the queued re-list.
    expect(rec.count('GET', '/v1/approvals')).toBe(lists + 1);
  });

  it('(d) a 404 on resolve tombstones: an older list does not bring the row back', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = await started(rec);
    l.store.openDetail(a.id);
    await advanceUntil(() => loaded(l, a.id));
    const release = holdNextList(rec);
    const refreshed = l.store.refresh();
    await advanceUntil(() => rec.count('GET', '/v1/approvals') >= 2);
    rec.intercept((c) => (c.method === 'POST' ? problemResponse(404, 'not_found') : undefined));
    const result = await l.store.approve(a.id);
    expect(result).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    release();
    await refreshed;
    await advance(100);
    expect(ids(l.snapshot().approvals)).not.toContain(a.id);
    expect(l.snapshot().detail).toEqual({ id: a.id, status: 'not_found' });
  });

  it('(e) an approval_conflict whose re-read is still pending keeps the row; a later approve reaches the network', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const other = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = await started(rec);
    l.store.openDetail(a.id);
    await advanceUntil(() => loaded(l, a.id));
    const stale = await l.store.resolve(a.id, {
      resolution: 'approved',
      expectedActionDigest: other.digest,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'approval_conflict' } });
    expect(ids(l.snapshot().approvals)).toContain(a.id);
    await advanceUntil(() => loaded(l, a.id));
    const posts = rec.count('POST', /resolve$/);
    const real = l.store.approve(a.id);
    await advanceUntil(() => rec.count('POST', /resolve$/) > posts);
    expect((await real).ok).toBe(true);
  });

  it('(f) a list that started after the tombstone and still shows the id pending does not revive it', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = await started(rec);
    const lagging = await (
      await mockFetch(
        new Request(`${h.baseUrl}/v1/approvals?state=pending&approver=me&limit=50`, {
          headers: { authorization: `Bearer ${h.tokens.approver}` },
        })
      )
    ).text();
    expect(lagging).toContain(a.id);
    l.store.openDetail(a.id);
    await advanceUntil(() => loaded(l, a.id));
    expect((await Promise.all([l.store.approve(a.id), advance(100)]))[0].ok).toBe(true);
    // Every list now answers with the old page, which shows the id pending.
    rec.intercept((c) =>
      isList(c)
        ? new Response(lagging, { headers: { 'content-type': 'application/json' } })
        : undefined
    );
    const lists = rec.count('GET', '/v1/approvals');
    await advanceUntil(() => rec.count('GET', '/v1/approvals') >= lists + 2, 12_000);
    expect(ids(l.snapshot().approvals)).not.toContain(a.id);
  });

  it('(g) a 403 suppresses the id for 30 s: lists inside the window do not re-add it, one after does', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = await started(rec);
    l.store.openDetail(a.id);
    await advanceUntil(() => loaded(l, a.id));
    rec.intercept((c) => (c.method === 'POST' ? problemResponse(403, 'not_eligible') : undefined));
    const refused = await Promise.all([l.store.approve(a.id), advance(50)]);
    expect(refused[0]).toMatchObject({
      ok: false,
      error: { kind: 'forbidden', code: 'not_eligible' },
    });
    expect(ids(l.snapshot().approvals)).not.toContain(a.id);
    // One re-list happens at once and drops the id; the lists of the next 25 s drop it too.
    await advance(25_000);
    expect(rec.count('GET', '/v1/approvals')).toBeGreaterThanOrEqual(4);
    expect(ids(l.snapshot().approvals)).not.toContain(a.id);
    await advanceUntil(() => ids(l.snapshot().approvals).includes(a.id), 12_000);
  });

  it('the 403 re-list runs once', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = await started(rec, { reconcileMs: 600_000 });
    l.store.openDetail(a.id);
    await advanceUntil(() => loaded(l, a.id));
    const lists = rec.count('GET', '/v1/approvals');
    rec.intercept((c) => (c.method === 'POST' ? problemResponse(403, 'not_eligible') : undefined));
    await Promise.all([l.store.approve(a.id), advance(3000)]);
    expect(rec.count('GET', '/v1/approvals')).toBe(lists + 1);
  });
});

/**
 * The stream of a contract rev 5 service: it answers 400 to `approver`, so the store opens it again without, and
 * a pending event for an id outside the queue is confirmed by a list (the behaviour these tests are about).
 * Against a rev 6 service the event is itself the row; `approvals-store.rev6.test.ts` has that.
 */
const legacyStream = (stream: ReturnType<typeof handStream>, request: Request): Response =>
  new URL(request.url).searchParams.has('approver')
    ? problemResponse(400, 'invalid_request')
    : stream.response();

describe('T25 polling bounds', () => {
  const noStream = (rec: Recorder): void => {
    rec.intercept((c, request) =>
      c.path === '/v1/approvals/stream' ? problemResponse(404, 'not_found') : mockFetch(request)
    );
  };

  it('clamps pollMs: 0 to the floor and never hot-loops', async () => {
    const rec = recorder(mockFetch);
    noStream(rec);
    const l = fromApprover(rec, { pollMs: 0 });
    await advanceUntil(() => l.snapshot().status === 'ready');
    const before = rec.count('GET', '/v1/approvals');
    await advance(10_000);
    const lists = rec.count('GET', '/v1/approvals') - before;
    expect(lists).toBeGreaterThanOrEqual(8);
    expect(lists).toBeLessThanOrEqual(11);
    expect(l.snapshot().connection).toBe('polling');
  });

  it('polls at pollMs while the stream is down', async () => {
    const rec = recorder(mockFetch);
    noStream(rec);
    const l = fromApprover(rec, { pollMs: 3000 });
    await advanceUntil(() => l.snapshot().status === 'ready');
    const before = rec.count('GET', '/v1/approvals');
    await advance(10_000);
    expect(rec.count('GET', '/v1/approvals') - before).toBe(3);
  });

  it('polls at pollMs while the stream answers 503 and retries on its own backoff', async () => {
    const rec = recorder(mockFetch);
    rec.intercept((c, request) =>
      c.path === '/v1/approvals/stream'
        ? problemResponse(503, 'service_unavailable')
        : mockFetch(request)
    );
    const l = fromApprover(rec, { pollMs: 60_000 });
    await advanceUntil(() => l.snapshot().status === 'ready');
    const before = rec.count('GET', '/v1/approvals');
    const attempts = rec.count('GET', '/v1/approvals/stream');
    await advance(300_000);
    // Stream retries (1 s doubling to 30 s) must not push the 60 s poll back: about one list a minute.
    expect(rec.count('GET', '/v1/approvals/stream') - attempts).toBeGreaterThanOrEqual(8);
    const lists = rec.count('GET', '/v1/approvals') - before;
    expect(lists).toBeGreaterThanOrEqual(4);
    expect(lists).toBeLessThanOrEqual(6);
  });

  it('reads reconcileMs: 0 as the 30 s default, and clamps a smaller value to 5 s', async () => {
    const recDefault = recorder(mockFetch);
    await started(recDefault, { reconcileMs: 0 });
    // The connect re-list runs a second after the first; after that only the reconcile.
    await advance(2000);
    const base = recDefault.count('GET', '/v1/approvals');
    await advance(26_000);
    expect(recDefault.count('GET', '/v1/approvals')).toBe(base);
    await advance(6000);
    expect(recDefault.count('GET', '/v1/approvals')).toBe(base + 1);

    const recFast = recorder(mockFetch);
    await started(recFast, { reconcileMs: 1 });
    await advance(2000);
    const fastBase = recFast.count('GET', '/v1/approvals');
    await advance(11_000);
    expect(recFast.count('GET', '/v1/approvals') - fastBase).toBeLessThanOrEqual(2);
    expect(recFast.count('GET', '/v1/approvals') - fastBase).toBeGreaterThanOrEqual(1);
  });

  it('backs off a failing list: 1 s doubling to 30 s with jitter, and resets after a good one', async () => {
    const rec = recorder(mockFetch);
    const starts: number[] = [];
    let failing = true;
    rec.intercept((c, request) => {
      if (!isList(c)) return mockFetch(request);
      starts.push(Date.now());
      return failing ? problemResponse(503, 'service_unavailable') : mockFetch(request);
    });
    const l = fromApprover(rec, { reconcileMs: 5000 });
    await advanceUntil(() => starts.length >= 8, 200_000, 100);
    const gaps = starts.slice(1).map((t, i) => t - at(starts, i));
    // Each gap is within 20% of 1, 2, 4, 8, 16 s, then capped at 30 s.
    const wanted = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
    gaps.forEach((gap, i) => {
      const want = at(wanted, i);
      expect(gap).toBeGreaterThanOrEqual(Math.min(want * 0.8, 30_000) - 150);
      expect(gap).toBeLessThanOrEqual(Math.min(want * 1.2, 30_000) + 150);
    });
    expect(l.snapshot()).toMatchObject({ status: 'error', error: { kind: 'unavailable' } });
    failing = false;
    await advanceUntil(() => l.snapshot().status === 'ready', 40_000, 100);
    // A good list reset the backoff: the next failure waits about one second again.
    failing = true;
    const mark = starts.length;
    await advanceUntil(() => starts.length >= mark + 3, 60_000, 100);
    const after = starts.slice(mark).map((t, i, all) => (i === 0 ? 0 : t - at(all, i - 1)));
    expect(at(after, 1)).toBeLessThanOrEqual(1200 + 150);
    expect(at(after, 2)).toBeLessThanOrEqual(2400 + 150);
    expect(at(after, 2)).toBeGreaterThan(1500);
  }, 60_000);

  it('keeps the list backoff while the stream is also failing, whatever pollMs says', async () => {
    const rec = recorder(mockFetch);
    const starts: number[] = [];
    rec.intercept((c, request) => {
      if (c.path === '/v1/approvals/stream') return problemResponse(503, 'service_unavailable');
      if (!isList(c)) return mockFetch(request);
      starts.push(Date.now());
      return problemResponse(503, 'service_unavailable');
    });
    const l = fromApprover(rec, { pollMs: 1000 });
    await advanceUntil(() => starts.length >= 6, 200_000, 100);
    const gaps = starts.slice(1).map((t, i) => t - at(starts, i));
    // The stream reconnects every 1 to 30 s; none of those may pull a list forward of its 1, 2, 4, 8, 16 s.
    const wanted = [1000, 2000, 4000, 8000, 16_000];
    gaps.forEach((gap, i) => {
      expect(gap).toBeGreaterThanOrEqual(at(wanted, i) * 0.8 - 150);
    });
    expect(l.snapshot().status).toBe('error');
  }, 60_000);

  it('holds a 429 backoff against stream events too', async () => {
    const rec = recorder(mockFetch);
    const stream = handStream();
    let limited = false;
    const starts: number[] = [];
    rec.intercept((c, request) => {
      if (c.path === '/v1/approvals/stream') return legacyStream(stream, request);
      if (!isList(c)) return mockFetch(request);
      if (!limited) return mockFetch(request);
      starts.push(Date.now());
      return problemResponse(429, 'rate_limited');
    });
    const l = fromApprover(rec, { reconcileMs: 600_000 });
    await advanceUntil(() => settled(l));
    await advance(1500);
    limited = true;
    // A pending event for an id outside the queue every 300 ms asks for a re-list each time.
    for (let n = 0; n < 100; n += 1) {
      stream.push(eventFrame(cannedApproval(`apr_other_${String(n)}`)));
      await advance(300);
    }
    // 1, 2, 4, 8, 16 s of backoff in 30 s: about five lists, never one a second.
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect(starts.length).toBeLessThanOrEqual(7);
    const gaps = starts.slice(1).map((t, i) => t - at(starts, i));
    expect(at(gaps, 1)).toBeGreaterThanOrEqual(1500);
    expect(at(gaps, 2)).toBeGreaterThanOrEqual(3000);
  }, 60_000);

  it('backs off on 429 and on a network failure alike, and a 429 keeps the rows', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    let mode: 'ok' | '429' | 'network' = 'ok';
    const starts: number[] = [];
    rec.intercept((c, request) => {
      if (!isList(c)) return mockFetch(request);
      if (mode === 'ok') return mockFetch(request);
      starts.push(Date.now());
      if (mode === 'network') throw new TypeError('Failed to fetch');
      return problemResponse(429, 'rate_limited');
    });
    const l = await started(rec, { reconcileMs: 5000 });
    expect(ids(l.snapshot().approvals)).toContain(a.id);
    mode = '429';
    await advanceUntil(() => starts.length >= 3, 60_000, 100);
    expect(l.snapshot()).toMatchObject({ status: 'error', error: { kind: 'rate_limited' } });
    expect(ids(l.snapshot().approvals)).toContain(a.id);
    mode = 'network';
    await advanceUntil(() => l.snapshot().error?.kind === 'network', 60_000, 100);
    expect(ids(l.snapshot().approvals)).toContain(a.id);
    mode = 'ok';
    await advanceUntil(() => l.snapshot().status === 'ready', 60_000, 100);
    expect(l.snapshot().error).toBeUndefined();
  }, 60_000);

  it('still re-lists within 2 s of the first event while events keep arriving', async () => {
    const rec = recorder(mockFetch);
    const stream = handStream();
    rec.intercept((c, request) =>
      c.path === '/v1/approvals/stream' ? legacyStream(stream, request) : mockFetch(request)
    );
    const l = fromApprover(rec, { reconcileMs: 600_000 });
    await advanceUntil(() => settled(l));
    await advance(1500);
    const lists = rec.count('GET', '/v1/approvals');
    const started = Date.now();
    // A new pending id every 100 ms: a plain trailing debounce would wait for them to stop.
    let fresh = 0;
    let firedAt: number | undefined;
    for (let t = 0; t < 4000 && firedAt === undefined; t += 100) {
      fresh += 1;
      stream.push(eventFrame(cannedApproval(`apr_burst_${String(fresh)}`)));
      await advance(100);
      if (rec.count('GET', '/v1/approvals') > lists) firedAt = Date.now() - started;
    }
    expect(firedAt).toBeDefined();
    expect(firedAt).toBeDefined();
    expect(firedAt ?? 0).toBeLessThanOrEqual(2200);
    expect(firedAt).toBeDefined();
    expect(firedAt ?? 0).toBeGreaterThan(1000);
  });

  it('reports a throwing subscriber and keeps the stream open', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const reported = vi.fn();
    vi.stubGlobal('reportError', reported);
    const rec = recorder(mockFetch);
    const stream = handStream();
    rec.intercept((c, request) =>
      c.path === '/v1/approvals/stream' ? stream.response() : mockFetch(request)
    );
    const l = fromApprover(rec, { reconcileMs: 600_000 });
    await advanceUntil(() => settled(l));
    const boom = new Error('listener bug');
    let armed = true;
    const off = l.store.subscribe(() => {
      if (armed) throw boom;
    });
    stream.push(eventFrame(cannedApproval(a.id, { scope_id: 'scope_changed' })));
    await advance(500);
    armed = false;
    off();
    expect(reported).toHaveBeenCalledWith(boom);
    // Still one stream, still live: the fault was not read as a cut stream.
    expect(rec.count('GET', '/v1/approvals/stream')).toBe(1);
    expect(l.snapshot().connection).toBe('live');
    vi.unstubAllGlobals();
  });

  it('asks for a list when a frame cannot be read, instead of trusting the queue', async () => {
    const rec = recorder(mockFetch);
    const stream = handStream();
    rec.intercept((c, request) =>
      c.path === '/v1/approvals/stream' ? stream.response() : mockFetch(request)
    );
    const l = fromApprover(rec, { reconcileMs: 600_000 });
    await advanceUntil(() => settled(l));
    await advance(1500);
    const lists = rec.count('GET', '/v1/approvals');
    stream.push('event: approval.updated\ndata: {not json\n\n');
    await advance(1500);
    expect(rec.count('GET', '/v1/approvals')).toBe(lists + 1);
    expect(l.snapshot().connection).toBe('live');
  });

  it('re-lists once for a pending id that is beyond the first page, not once per event', async () => {
    const rec = recorder(mockFetch);
    const stream = handStream();
    // A truncated first page: the mock's page is cut at 50 by a wrapper that sets meta.next.
    rec.intercept(async (c, request) => {
      if (c.path === '/v1/approvals/stream') return legacyStream(stream, request);
      if (!isList(c)) return mockFetch(request);
      const body = (await (await mockFetch(request)).json()) as {
        data: unknown[];
        meta: Record<string, unknown>;
      };
      return jsonResponse({ ...body, meta: { ...body.meta, next: 'page-2' } });
    });
    const l = fromApprover(rec, { reconcileMs: 600_000 });
    await advanceUntil(() => settled(l));
    expect(l.snapshot().truncated).toBe(true);
    await advance(1500);
    const lists = rec.count('GET', '/v1/approvals');
    const beyond = cannedApproval('apr_beyond_the_page');
    for (let i = 0; i < 6; i += 1) {
      stream.push(eventFrame(beyond));
      await advance(1500);
    }
    expect(rec.count('GET', '/v1/approvals')).toBe(lists + 1);
  });

  it('without a truncated page, an event for an id the list leaves out asks again each time (the floor bounds it)', async () => {
    const rec = recorder(mockFetch);
    const stream = handStream();
    rec.intercept((c, request) =>
      c.path === '/v1/approvals/stream' ? legacyStream(stream, request) : mockFetch(request)
    );
    const l = fromApprover(rec, { reconcileMs: 600_000 });
    await advanceUntil(() => settled(l));
    await advance(1500);
    const lists = rec.count('GET', '/v1/approvals');
    for (let i = 0; i < 3; i += 1) {
      stream.push(eventFrame(cannedApproval('apr_not_for_me')));
      await advance(1500);
    }
    expect(rec.count('GET', '/v1/approvals')).toBe(lists + 3);
  });

  it('schedules an expiry re-list once per (id, expires_at) even when the list keeps showing the row pending', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const expiresAt = new Date(Date.now() + 6000).toISOString();
    // The wrapper lists the row as pending with an `expires_at` that passes, and keeps doing so.
    rec.intercept(async (c, request) => {
      if (!isList(c)) return mockFetch(request);
      const body = (await (await mockFetch(request)).json()) as {
        data: Record<string, unknown>[];
        meta: unknown;
      };
      return jsonResponse({
        ...body,
        data: body.data.map((row) => (row.id === a.id ? { ...row, expires_at: expiresAt } : row)),
      });
    });
    const l = await started(rec, { reconcileMs: 600_000 });
    expect(ids(l.snapshot().approvals)).toContain(a.id);
    await advance(1500);
    const lists = rec.count('GET', '/v1/approvals');
    await advance(4000);
    expect(rec.count('GET', '/v1/approvals')).toBe(lists);
    await advance(2500);
    // One re-list shortly after the expiry (+1 s), and then no more however long it goes on.
    expect(rec.count('GET', '/v1/approvals')).toBe(lists + 1);
    await advance(120_000);
    expect(rec.count('GET', '/v1/approvals')).toBe(lists + 1);
    expect(ids(l.snapshot().approvals)).toContain(a.id);
  });

  it('does not arm the expiry timer for an expires_at beyond the timer range', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    // 30 days is past 2^31-1 ms: a raw setTimeout would fire at once and spend the one expiry re-list.
    const far = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    rec.intercept(async (c, request) => {
      if (!isList(c)) return mockFetch(request);
      const body = (await (await mockFetch(request)).json()) as { data: Record<string, unknown>[] };
      return jsonResponse({
        ...body,
        data: body.data.map((row) => (row.id === a.id ? { ...row, expires_at: far } : row)),
      });
    });
    // The fake clock does not wrap an oversized delay as real timers do, so check the delays handed over.
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const l = await started(rec, { reconcileMs: 600_000 });
    await advance(1500);
    const lists = rec.count('GET', '/v1/approvals');
    await advance(30_000);
    expect(rec.count('GET', '/v1/approvals')).toBe(lists);
    expect(ids(l.snapshot().approvals)).toContain(a.id);
    const delays = timeouts.mock.calls.map((args) => args[1] ?? 0);
    expect(delays.every((ms) => ms <= 2 ** 31 - 1)).toBe(true);
    timeouts.mockRestore();
  });

  it('does not schedule an expiry re-list for a time that is already past when the list started', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const past = new Date(Date.now() - 60_000).toISOString();
    rec.intercept(async (c, request) => {
      if (!isList(c)) return mockFetch(request);
      const body = (await (await mockFetch(request)).json()) as { data: Record<string, unknown>[] };
      return jsonResponse({
        ...body,
        data: body.data.map((row) => (row.id === a.id ? { ...row, expires_at: past } : row)),
      });
    });
    const l = await started(rec, { reconcileMs: 600_000 });
    await advance(1500);
    const lists = rec.count('GET', '/v1/approvals');
    await advance(30_000);
    expect(rec.count('GET', '/v1/approvals')).toBe(lists);
    expect(ids(l.snapshot().approvals)).toContain(a.id);
  });
});

describe('what the harness itself relies on', () => {
  it('serves the mock in this process and over HTTP', async () => {
    vi.useRealTimers();
    const over = await call(h.baseUrl, h.tokens.approver, 'GET', '/v1/capabilities');
    const inside = await mockFetch(
      new Request(`${h.baseUrl}/v1/capabilities`, {
        headers: { authorization: `Bearer ${h.tokens.approver}` },
      })
    );
    expect([over.status, inside.status]).toEqual([200, 200]);
    const opened = await openApproval(h.baseUrl, h.tokens.creator_user);
    const l = track(live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver }));
    expect(ids((await until(l.store, (s) => s.status === 'ready')).approvals)).toContain(opened.id);
  });
});
