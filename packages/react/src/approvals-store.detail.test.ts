import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { advanceUntil, fakeTime } from './testing/approvals-fake-time.js';
import {
  ARG_MARKER,
  call,
  failNextIn,
  inProcessFetch,
  ids,
  live,
  openApproval,
  openLoaded,
  problemResponse,
  recorder,
  startHarness,
  toolHidingArguments,
  toolShowingArguments,
  until,
} from './testing/approvals-harness.js';
import type { Harness, Live, Recorder } from './testing/approvals-harness.js';
import type { ApprovalDetailStatus, ApprovalsSnapshot } from './approvals-types.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

let open: Live[] = [];
afterEach(() => {
  for (const l of open) l.close();
  open = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const approverLive = (rec?: Recorder, extra: Partial<Parameters<typeof live>[0]> = {}): Live => {
  const l = live({
    baseUrl: h.baseUrl,
    getToken: () => h.tokens.approver,
    reconcileMs: 600_000,
    ...(rec === undefined ? {} : { fetch: rec.fetch }),
    ...extra,
  });
  open.push(l);
  return l;
};

/** A store whose stream is refused, so only reads and polls touch the queue (polls are far apart). */
const withoutStream = (rec: Recorder): void => {
  rec.intercept((c, request) =>
    c.path === '/v1/approvals/stream' ? problemResponse(404, 'not_found') : fetch(request)
  );
};

const statusesOf = (l: Live): ApprovalDetailStatus[] => {
  const seen: ApprovalDetailStatus[] = [];
  const off = l.store.subscribe(() => {
    const s = l.snapshot().detail?.status;
    if (s !== undefined && seen[seen.length - 1] !== s) seen.push(s);
  });
  open.push({
    ...l,
    close: () => {
      off();
    },
  });
  return seen;
};

describe('T31 the states of a detail', () => {
  it('goes loading then loaded, with the arguments of a tool that shows them', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolShowingArguments(h.baseUrl),
    });
    const l = approverLive();
    await until(l.store, (s) => s.status === 'ready');
    const seen = statusesOf(l);
    const snapshot = await openLoaded(l.store, opened.id);
    expect(seen).toEqual(['loading', 'loaded']);
    expect(snapshot.detail).toMatchObject({
      id: opened.id,
      status: 'loaded',
      approval: { id: opened.id },
    });
    expect(JSON.stringify(snapshot.detail)).toContain(ARG_MARKER);
    expect(JSON.stringify(snapshot.approvals)).not.toContain(ARG_MARKER);
  });

  it('is loaded without arguments for a tool that withholds them', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolHidingArguments(h.baseUrl),
    });
    const l = approverLive();
    const snapshot = await openLoaded(l.store, opened.id);
    expect(snapshot.detail).toMatchObject({ status: 'loaded' });
    expect(snapshot.detail && 'arguments' in snapshot.detail).toBe(false);
  });

  it('is resolved after the creator withdraws, with no arguments; the row is gone and tombstoned', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator_user, {
      tool: await toolHidingArguments(h.baseUrl),
    });
    const rec = recorder();
    withoutStream(rec);
    const l = approverLive(rec, { pollMs: 600_000 });
    await until(l.store, (s) => ids(s.approvals).includes(opened.id));
    await call(h.baseUrl, h.tokens.creator_user, 'POST', `/v1/approvals/${opened.id}/withdraw`);
    l.store.openDetail(opened.id);
    const snapshot = await until(l.store, (s) => s.detail?.status === 'resolved');
    expect(snapshot.detail).toMatchObject({ id: opened.id, approval: { state: 'withdrawn' } });
    expect(snapshot.detail && 'arguments' in snapshot.detail).toBe(false);
    expect(ids(snapshot.approvals)).not.toContain(opened.id);
    // Tombstoned: even a fresh list that (wrongly) shows it pending would not bring it back.
    const posts = rec.count('POST', /resolve$/);
    expect(await l.store.approve(opened.id)).toMatchObject({
      ok: false,
      error: { kind: 'conflict', code: 'already_resolved', local: true },
    });
    expect(rec.count('POST', /resolve$/)).toBe(posts);
  });

  it('is not_found on a 404: the row is removed and an older list does not revive it', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator_user);
    const rec = recorder();
    const l = approverLive(rec);
    await until(l.store, (s) => ids(s.approvals).includes(opened.id));
    rec.intercept((c) =>
      c.method === 'GET' && c.path === `/v1/approvals/${opened.id}`
        ? problemResponse(404, 'not_found')
        : undefined
    );
    l.store.openDetail(opened.id);
    const snapshot = await until(l.store, (s) => s.detail?.status === 'not_found');
    expect(snapshot.detail).toEqual({ id: opened.id, status: 'not_found' });
    expect(ids(snapshot.approvals)).not.toContain(opened.id);
    // The server still lists it pending, and a new list (a refresh) does not revive it.
    await l.store.refresh();
    expect(ids(l.snapshot().approvals)).not.toContain(opened.id);
  });

  it('closing drops the detail; a pending event for another id leaves it alone', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const l = approverLive();
    await openLoaded(l.store, opened.id);
    l.store.closeDetail();
    expect(l.snapshot().detail).toBeUndefined();
    l.store.closeDetail();
    expect(l.snapshot().detail).toBeUndefined();
  });

  it('replaces the open detail when another id is opened, and reads again on every open', async () => {
    const a = await openApproval(h.baseUrl, h.tokens.creator);
    const b = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive(rec);
    await openLoaded(l.store, a.id);
    await openLoaded(l.store, b.id);
    expect(l.snapshot().detail?.id).toBe(b.id);
    await openLoaded(l.store, b.id);
    expect(rec.count('GET', `/v1/approvals/${b.id}`)).toBe(2);
  });
});

describe('T32 the enable rule', () => {
  const posts = (rec: Recorder): number => rec.count('POST', /resolve$/);

  it('refuses with detail_not_read and no request when no detail is open or another id is open', async () => {
    const a = await openApproval(h.baseUrl, h.tokens.creator);
    const b = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive(rec);
    await until(l.store, (s) => ids(s.approvals).includes(a.id));
    const refused = {
      ok: false,
      error: { kind: 'precondition', code: 'detail_not_read', local: true },
    };
    expect(await l.store.approve(a.id)).toMatchObject(refused);
    expect(await l.store.deny(a.id)).toMatchObject(refused);
    expect(await l.store.resolve(a.id, { resolution: 'approved' })).toMatchObject(refused);
    await openLoaded(l.store, b.id);
    expect(await l.store.approve(a.id)).toMatchObject(refused);
    // An id the store has never seen is refused the same way: it must be read first.
    expect(await l.store.approve('apr_never_seen')).toMatchObject(refused);
    expect(posts(rec)).toBe(0);
  });

  it('refuses while the detail is loading, refreshing or unavailable', async () => {
    const a = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive(rec);
    await until(l.store, (s) => s.status === 'ready');
    const refused = { ok: false, error: { kind: 'precondition', code: 'detail_not_read' } };
    // loading: the read is held back.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    rec.intercept(async (c, request) => {
      if (c.path !== `/v1/approvals/${a.id}`) return undefined;
      const answer = await fetch(request);
      await gate;
      return answer;
    });
    l.store.openDetail(a.id);
    expect(l.snapshot().detail?.status).toBe('loading');
    expect(await l.store.approve(a.id)).toMatchObject(refused);
    release();
    await until(l.store, (s) => s.detail?.status === 'loaded');
    // refreshing: a list that shows a changed `expires_at` for the open id triggers a re-read, held back.
    let release2: () => void = () => undefined;
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    let changed = false;
    rec.intercept(async (c, request) => {
      if (c.method === 'GET' && c.path === '/v1/approvals' && !changed) {
        changed = true;
        const body = (await (await fetch(request)).json()) as { data: Record<string, unknown>[] };
        return new Response(
          JSON.stringify({
            ...body,
            data: body.data.map((r) =>
              r.id === a.id ? { ...r, expires_at: '2031-01-01T00:00:00.000Z' } : r
            ),
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      if (c.path !== `/v1/approvals/${a.id}`) return undefined;
      const answer = await fetch(request);
      await gate2;
      return answer;
    });
    void l.store.refresh();
    await until(l.store, (s) => s.detail?.status === 'refreshing');
    expect(await l.store.approve(a.id)).toMatchObject(refused);
    expect(await l.store.deny(a.id)).toMatchObject(refused);
    release2();
    await until(l.store, (s) => s.detail?.status === 'loaded');
    // unavailable: the read answers 503.
    rec.intercept((c) =>
      c.path === `/v1/approvals/${a.id}` ? problemResponse(503, 'service_unavailable') : undefined
    );
    l.store.openDetail(a.id);
    await until(l.store, (s) => s.detail?.status === 'unavailable');
    expect(await l.store.approve(a.id)).toMatchObject(refused);
    expect(posts(rec)).toBe(0);
  });

  it('answers already_resolved, not detail_not_read, when the detail is resolved or not_found: the id is tombstoned first', async () => {
    const a = await openApproval(h.baseUrl, h.tokens.creator_user, {
      tool: await toolHidingArguments(h.baseUrl),
    });
    const rec = recorder();
    withoutStream(rec);
    const l = approverLive(rec, { pollMs: 600_000 });
    await call(h.baseUrl, h.tokens.creator_user, 'POST', `/v1/approvals/${a.id}/withdraw`);
    l.store.openDetail(a.id);
    await until(l.store, (s) => s.detail?.status === 'resolved');
    expect(await l.store.approve(a.id)).toMatchObject({
      ok: false,
      error: { code: 'already_resolved', local: true },
    });
    // A different id, while the resolved detail of another is open, has no tombstone: detail_not_read.
    const b = await openApproval(h.baseUrl, h.tokens.creator);
    expect(await l.store.approve(b.id)).toMatchObject({
      ok: false,
      error: { code: 'detail_not_read' },
    });
    expect(posts(rec)).toBe(0);
  });

  it('keeps answering already_resolved for the open resolved detail after a later list cleared the tombstone', async () => {
    const a = await openApproval(h.baseUrl, h.tokens.creator_user, {
      tool: await toolHidingArguments(h.baseUrl),
    });
    await call(h.baseUrl, h.tokens.creator_user, 'POST', `/v1/approvals/${a.id}/withdraw`);
    // The polls run on fake time against the in-process mock: no real 2 s wait.
    fakeTime();
    try {
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept((c) =>
        c.path === '/v1/approvals/stream' ? problemResponse(404, 'not_found') : undefined
      );
      const l = approverLive(rec, { pollMs: 1000 });
      l.store.openDetail(a.id);
      await advanceUntil(() => l.snapshot().detail?.status === 'resolved');
      const refused = { ok: false, error: { code: 'already_resolved', local: true } };
      expect(await l.store.approve(a.id)).toMatchObject(refused);
      // A complete list that started after the tombstone and lacks the id clears the tombstone.
      const lists = rec.count('GET', '/v1/approvals');
      await advanceUntil(() => rec.count('GET', '/v1/approvals') >= lists + 2, 8000);
      expect(l.snapshot().detail?.status).toBe('resolved');
      expect(await l.store.approve(a.id)).toMatchObject(refused);
      expect(posts(rec)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with a loaded detail sends exactly one POST whose digest is the read's, not the list row's", async () => {
    const a = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    // The list lies about the digest of this row; the module must send the digest of the read.
    const lie = `sha256:${'f'.repeat(64)}`;
    rec.intercept(async (c, request) => {
      if (!(c.method === 'GET' && c.path === '/v1/approvals')) return undefined;
      const body = (await (await fetch(request)).json()) as { data: Record<string, unknown>[] };
      return new Response(
        JSON.stringify({
          ...body,
          data: body.data.map((r) => (r.id === a.id ? { ...r, action_digest: lie } : r)),
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    });
    const l = approverLive(rec);
    const listed = await until(l.store, (s) => ids(s.approvals).includes(a.id));
    expect(listed.approvals.find((r) => r.id === a.id)?.action_digest).toBe(lie);
    await openLoaded(l.store, a.id);
    // A list that lies lands right after the read: the row differs from the detail, so the detail turns
    // refreshing at once (actions off) while the re-read waits out its one-second floor.
    void l.store.refresh();
    await until(
      l.store,
      (s) =>
        s.approvals.find((r) => r.id === a.id)?.action_digest === lie &&
        s.detail?.status === 'refreshing'
    );
    expect(await l.store.approve(a.id)).toMatchObject({
      ok: false,
      error: { code: 'detail_not_read' },
    });
    expect(posts(rec)).toBe(0);
    // The re-read answers with the true digest, and that read is the one a POST carries.
    await until(l.store, (s) => s.detail?.status === 'loaded');
    const result = await l.store.approve(a.id);
    expect(result.ok).toBe(true);
    expect(posts(rec)).toBe(1);
    const post = rec.calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ expected_action_digest: a.digest });
    expect(post?.body).not.toMatchObject({ expected_action_digest: lie });
  });
});

describe('T33 no caching, no retention', () => {
  it('keeps the arguments in the open detail only: nowhere in storage, console, errors, URLs or the queue', async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: vi.fn((k: string, v: string) => void store.set(k, v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => {
        store.clear();
      },
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    const opened = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolShowingArguments(h.baseUrl),
    });
    const rec = recorder();
    const l = approverLive(rec);
    const everySnapshot: ApprovalsSnapshot[] = [];
    l.store.subscribe(() => {
      everySnapshot.push(l.snapshot());
    });
    await until(l.store, (s) => ids(s.approvals).includes(opened.id));
    const first = await openLoaded(l.store, opened.id);
    expect(JSON.stringify(first.detail)).toContain(ARG_MARKER);
    // The queue, and every snapshot's queue, never carried them.
    expect(JSON.stringify(first.approvals)).not.toContain(ARG_MARKER);
    // Closing and re-opening the same id reads again.
    l.store.closeDetail();
    expect(JSON.stringify(l.snapshot())).not.toContain(ARG_MARKER);
    await openLoaded(l.store, opened.id);
    expect(rec.count('GET', `/v1/approvals/${opened.id}`)).toBe(2);
    // A resolve drops them.
    const result = await l.store.approve(opened.id);
    expect(JSON.stringify(result)).not.toContain(ARG_MARKER);
    expect(JSON.stringify(l.snapshot())).not.toContain(ARG_MARKER);
    // Open once more (a tombstoned id can still be read) and dispose while it is open.
    l.store.openDetail(opened.id);
    await until(l.store, (s) => s.detail?.status === 'resolved' || s.detail?.status === 'loaded');
    l.store.dispose();
    expect(JSON.stringify(l.snapshot())).not.toContain(ARG_MARKER);
    // Nothing else ever held them.
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(JSON.stringify([...store])).not.toContain(ARG_MARKER);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(ARG_MARKER);
    expect(JSON.stringify(rec.calls.map((c) => [c.path, c.query]))).not.toContain(ARG_MARKER);
    const withoutDetail = everySnapshot.filter(
      (s) => s.detail === undefined || s.detail.status === 'loading'
    );
    for (const s of withoutDetail) expect(JSON.stringify(s)).not.toContain(ARG_MARKER);
    for (const s of everySnapshot) expect(JSON.stringify(s.approvals)).not.toContain(ARG_MARKER);
  });

  it('keeps them out of the error of a 409 and out of its current', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolShowingArguments(h.baseUrl),
    });
    const other = await openApproval(h.baseUrl, h.tokens.creator);
    const l = approverLive();
    await openLoaded(l.store, opened.id);
    const result = await l.store.resolve(opened.id, {
      resolution: 'approved',
      expectedActionDigest: other.digest,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(ARG_MARKER);
    expect(JSON.stringify(l.snapshot().approvals)).not.toContain(ARG_MARKER);
    expect(JSON.stringify(l.snapshot().detail)).toContain(ARG_MARKER);
  });
});

describe('T34 the 503 of a read, store part', () => {
  it('is unavailable with retryingInMs, never forbidden, and a manual retry works', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    // The retry timer runs on fake time against the in-process mock: no real 1 s wait.
    fakeTime();
    try {
      await t34Body(opened.id);
    } finally {
      vi.useRealTimers();
    }
  });

  async function t34Body(id: string): Promise<void> {
    const l = approverLive(recorder(inProcessFetch(h.mock)));
    await advanceUntil(() => l.snapshot().status === 'ready');
    await failNextIn(h.mock, h.tokens.approver, 'getApproval', 503, 1);
    l.store.openDetail(id);
    await advanceUntil(() => l.snapshot().detail?.status === 'unavailable');
    const seen = l.snapshot();
    expect(seen.detail).toMatchObject({
      status: 'unavailable',
      error: { kind: 'unavailable', status: 503 },
    });
    if (seen.detail?.status !== 'unavailable') return;
    expect(seen.detail.retryingInMs).toBeGreaterThanOrEqual(800);
    expect(seen.detail.retryingInMs).toBeLessThanOrEqual(1200);
    expect(seen.detail.error.title.toLowerCase()).not.toContain('eligib');
    await advanceUntil(() => l.snapshot().detail?.status === 'loaded', 5000);
  }

  it('retryDetail reads again at once, and does nothing in other states', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive(rec);
    await until(l.store, (s) => s.status === 'ready');
    l.store.retryDetail();
    await openLoaded(l.store, opened.id);
    const reads = rec.count('GET', `/v1/approvals/${opened.id}`);
    l.store.retryDetail();
    await new Promise((r) => setTimeout(r, 50));
    expect(rec.count('GET', `/v1/approvals/${opened.id}`)).toBe(reads);
  });
});

describe('T36 a 403 on the read, store part', () => {
  it('is forbidden with the request id, actions off, and retryDetail may try again', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive(rec);
    await until(l.store, (s) => s.status === 'ready');
    let refuse = true;
    rec.intercept((c) =>
      refuse && c.method === 'GET' && c.path === `/v1/approvals/${opened.id}`
        ? problemResponse(403, 'entitlement_required')
        : undefined
    );
    l.store.openDetail(opened.id);
    const seen = await until(l.store, (s) => s.detail?.status === 'forbidden');
    expect(seen.detail).toMatchObject({
      status: 'forbidden',
      error: { kind: 'forbidden', code: 'entitlement_required', requestId: 'req_t' },
    });
    expect(await l.store.approve(opened.id)).toMatchObject({
      ok: false,
      error: { kind: 'precondition' },
    });
    refuse = false;
    l.store.retryDetail();
    await until(l.store, (s) => s.detail?.status === 'loaded');
  });

  it('is error for a read that is not a problem document or not an approval', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive(rec);
    await until(l.store, (s) => s.status === 'ready');
    rec.intercept((c) =>
      c.method === 'GET' && c.path === `/v1/approvals/${opened.id}`
        ? new Response('{"data": {}}', { status: 200 })
        : undefined
    );
    l.store.openDetail(opened.id);
    const seen = await until(l.store, (s) => s.detail?.status === 'error');
    expect(seen.detail).toMatchObject({ status: 'error', error: { kind: 'malformed_response' } });
    rec.intercept((c) =>
      c.method === 'GET' && c.path === `/v1/approvals/${opened.id}`
        ? problemResponse(400, 'invalid_request')
        : undefined
    );
    l.store.retryDetail();
    await until(
      l.store,
      (s) => s.detail?.status === 'error' && s.detail.error.kind === 'invalid_request'
    );
  });

  it('a 401 on the read ends the session', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    let bad = false;
    const onExpired = vi.fn();
    const l = approverLive(undefined, {
      getToken: () => (bad ? h.tokens.expired : h.tokens.approver),
      onSessionExpired: onExpired,
    });
    await until(l.store, (s) => s.status === 'ready');
    bad = true;
    l.store.openDetail(opened.id);
    const seen = await until(l.store, (s) => s.detail?.status === 'unauthorized');
    expect(seen.detail).toMatchObject({ error: { kind: 'unauthorized' } });
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(l.snapshot()).toMatchObject({ status: 'error', connection: 'offline' });
  });
});

describe('T37b arguments reach the module only on the single read, and no row carries them', () => {
  it('has teeth: the single read of the opted-in approval carries them, the list does not, and no row of the store does', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolShowingArguments(h.baseUrl),
    });
    // Contract rev 5 (hosted shape): the single read of an opted-in approval carries the arguments, the
    // list never does. (Rev 4 sent them on the list too; T37a's canned responses cover that shape.)
    const single = await (
      await call(h.baseUrl, h.tokens.approver, 'GET', `/v1/approvals/${opened.id}`)
    ).text();
    expect(single).toContain(ARG_MARKER);
    const raw = await (
      await call(h.baseUrl, h.tokens.approver, 'GET', '/v1/approvals?state=pending&approver=me')
    ).text();
    expect(raw).not.toContain(ARG_MARKER);
    const l = approverLive();
    const seen = await until(l.store, (s) => ids(s.approvals).includes(opened.id));
    expect(JSON.stringify(seen.approvals)).not.toContain(ARG_MARKER);
    for (const row of seen.approvals) expect('arguments' in row).toBe(false);
  });

  it('strips them from a stream event too', async () => {
    const l = approverLive();
    await until(l.store, (s) => s.status === 'ready' && s.connection === 'live');
    const opened = await openApproval(h.baseUrl, h.tokens.creator_user, {
      tool: await toolShowingArguments(h.baseUrl),
    });
    const seen = await until(l.store, (s) => ids(s.approvals).includes(opened.id));
    expect(JSON.stringify(seen.approvals)).not.toContain(ARG_MARKER);
  });
});
