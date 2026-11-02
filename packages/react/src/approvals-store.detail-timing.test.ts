import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARG_MARKER,
  at,
  cannedApproval,
  eventFrame,
  handStream,
  ids,
  inProcessFetch,
  jsonResponse,
  live,
  openApprovalIn,
  problemResponse,
  recorder,
  startHarness,
} from './testing/approvals-harness.js';
import type { Harness, Live, Recorder } from './testing/approvals-harness.js';
import { advance, advanceUntil, fakeTime } from './testing/approvals-fake-time.js';
import type { Approval, ApprovalDetailStatus, ApprovalsSnapshot } from './approvals-types.js';

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

const started = async (
  rec: Recorder,
  extra: Partial<Parameters<typeof live>[0]> = {}
): Promise<Live> => {
  const l = live({
    baseUrl: h.baseUrl,
    getToken: () => h.tokens.approver,
    fetch: rec.fetch,
    reconcileMs: 600_000,
    ...extra,
  });
  open.push(l);
  await advanceUntil(() => l.snapshot().status === 'ready' && l.snapshot().connection === 'live');
  return l;
};

const loaded = (l: Live, id: string): boolean =>
  l.snapshot().detail?.id === id && l.snapshot().detail?.status === 'loaded';

const isRead = (c: { method: string; path: string }, id: string): boolean =>
  c.method === 'GET' && c.path === `/v1/approvals/${id}`;

describe('T34 the 503 of a read: backoff and actions', () => {
  it('retries at 1 s, 2 s, 4 s ... capped at 30 s, keeps the actions off, and recovers on the next success', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = await started(rec);
    const times: number[] = [];
    let failing = true;
    rec.intercept((c, request) => {
      if (!isRead(c, a.id)) return mockFetch(request);
      times.push(Date.now());
      return failing ? problemResponse(503, 'service_unavailable') : mockFetch(request);
    });
    l.store.openDetail(a.id);
    await advanceUntil(() => times.length >= 8, 200_000, 100);
    const gaps = times.slice(1).map((t, i) => t - at(times, i));
    const wanted = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
    gaps.forEach((gap, i) => {
      const want = at(wanted, i);
      expect(gap).toBeGreaterThanOrEqual(Math.min(want * 0.8, 30_000) - 150);
      expect(gap).toBeLessThanOrEqual(Math.min(want * 1.2, 30_000) + 150);
    });
    const detail = l.snapshot().detail;
    expect(detail?.status).toBe('unavailable');
    if (detail?.status === 'unavailable') {
      expect(detail.error.kind).toBe('unavailable');
      expect(detail.retryingInMs).toBeGreaterThan(0);
      expect(detail.retryingInMs).toBeLessThanOrEqual(30_000);
    }
    const posts = rec.count('POST', /resolve$/);
    expect(await l.store.approve(a.id)).toMatchObject({
      ok: false,
      error: { code: 'detail_not_read' },
    });
    expect(await l.store.deny(a.id)).toMatchObject({
      ok: false,
      error: { code: 'detail_not_read' },
    });
    expect(rec.count('POST', /resolve$/)).toBe(posts);
    failing = false;
    await advanceUntil(() => loaded(l, a.id), 40_000, 100);
    expect((await Promise.all([l.store.approve(a.id), advance(100)]))[0].ok).toBe(true);
  }, 60_000);

  it('stops retrying an unavailable detail once the session has expired', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    let expired = false;
    rec.intercept((c, request) => {
      if (isRead(c, a.id)) return problemResponse(503, 'service_unavailable');
      if (expired && c.path !== '/v1/approvals/stream') {
        return problemResponse(401, 'unauthorized');
      }
      return mockFetch(request);
    });
    const l = await started(rec, { reconcileMs: 5000 });
    l.store.openDetail(a.id);
    await advanceUntil(() => l.snapshot().detail?.status === 'unavailable');
    expired = true;
    await advanceUntil(() => l.snapshot().error?.kind === 'unauthorized', 20_000, 100);
    const reads = rec.count('GET', `/v1/approvals/${a.id}`);
    await advance(120_000, 500);
    expect(rec.count('GET', `/v1/approvals/${a.id}`)).toBe(reads);
    // No countdown is left ticking for a retry that will not come; refresh() re-reads the unauthorized detail (c2-11).
    expect(l.snapshot().detail?.status).toBe('unauthorized');
  }, 60_000);

  it('retryDetail reads at once and cancels the timer, so one read, not two', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = await started(rec);
    let failing = true;
    let reads = 0;
    rec.intercept((c, request) => {
      if (!isRead(c, a.id)) return mockFetch(request);
      reads += 1;
      return failing ? problemResponse(503, 'service_unavailable') : mockFetch(request);
    });
    l.store.openDetail(a.id);
    await advanceUntil(() => l.snapshot().detail?.status === 'unavailable');
    expect(reads).toBe(1);
    failing = false;
    l.store.retryDetail();
    await advanceUntil(() => loaded(l, a.id), 200);
    expect(reads).toBe(2);
    await advance(10_000);
    expect(reads).toBe(2);
  });

  it('counts 429 and a network failure on a read as unavailable, with the same retry', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = await started(rec);
    let mode: '429' | 'network' | 'ok' = '429';
    rec.intercept((c, request) => {
      if (!isRead(c, a.id)) return mockFetch(request);
      if (mode === 'network') throw new TypeError('Failed to fetch');
      return mode === '429' ? problemResponse(429, 'rate_limited') : mockFetch(request);
    });
    l.store.openDetail(a.id);
    await advanceUntil(() => l.snapshot().detail?.status === 'unavailable');
    expect(l.snapshot().detail).toMatchObject({
      error: { kind: 'unavailable', code: 'rate_limited', status: 429 },
    });
    mode = 'network';
    await advanceUntil(() => {
      const d = l.snapshot().detail;
      return d?.status === 'unavailable' && d.error.code === 'network';
    }, 10_000);
    mode = 'ok';
    await advanceUntil(() => loaded(l, a.id), 10_000);
  });

  it('stops retrying when the detail is closed', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = await started(rec);
    let reads = 0;
    rec.intercept((c, request) => {
      if (!isRead(c, a.id)) return mockFetch(request);
      reads += 1;
      return problemResponse(503, 'service_unavailable');
    });
    l.store.openDetail(a.id);
    await advanceUntil(() => reads >= 2, 10_000);
    l.store.closeDetail();
    const seen = reads;
    await advance(120_000, 500);
    expect(reads).toBe(seen);
  });
});

describe('T35 updates to the open approval', () => {
  const setup = async (): Promise<{
    l: Live;
    rec: Recorder;
    id: string;
    stream: ReturnType<typeof handStream>;
    statuses: ApprovalDetailStatus[];
    reads: () => number;
  }> => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const stream = handStream();
    rec.intercept((c, request) =>
      c.path === '/v1/approvals/stream' ? stream.response() : mockFetch(request)
    );
    const l = await started(rec);
    l.store.openDetail(a.id);
    await advanceUntil(() => loaded(l, a.id));
    const statuses: ApprovalDetailStatus[] = [];
    open.push({
      ...l,
      close: l.store.subscribe(() => {
        const s = l.snapshot().detail?.status;
        if (s !== undefined && statuses[statuses.length - 1] !== s) statuses.push(s);
      }),
    });
    return {
      l,
      rec,
      id: a.id,
      stream,
      statuses,
      reads: () => rec.count('GET', `/v1/approvals/${a.id}`),
    };
  };

  it('re-reads once for a pending event: refreshing with actions off, then loaded', async () => {
    const { l, rec, id, stream, statuses, reads } = await setup();
    await advance(1500);
    const before = reads();
    // Hold the re-read's response so `refreshing` lasts until released, however fast the run is; the
    // recorded `statuses` (not a sampled snapshot) prove the transition.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    rec.intercept(async (c, request) => {
      if (c.path === '/v1/approvals/stream') return stream.response();
      if (c.method === 'GET' && c.path === `/v1/approvals/${id}`) await gate;
      return mockFetch(request);
    });
    stream.push(eventFrame(cannedApproval(id)));
    await advanceUntil(() => statuses.includes('refreshing'), 1000, 5);
    expect(statuses[statuses.length - 1]).toBe('refreshing');
    expect(await l.store.approve(id)).toMatchObject({
      ok: false,
      error: { code: 'detail_not_read' },
    });
    release();
    await advanceUntil(() => loaded(l, id));
    expect(statuses).toEqual(['loaded', 'refreshing', 'loaded']);
    expect(reads()).toBe(before + 1);
  });

  it('turns refreshing at once for an event inside the 1 s floor, and sends no POST on the old digest', async () => {
    const { l, rec, id, stream, statuses, reads } = await setup();
    const before = reads();
    // The read landed less than a second ago: the re-read waits for the floor, the actions must not.
    await advance(100);
    stream.push(eventFrame(cannedApproval(id, { action_digest: `sha256:${'b'.repeat(64)}` })));
    await advance(100);
    expect(l.snapshot().detail?.status).toBe('refreshing');
    expect(await l.store.approve(id)).toMatchObject({
      ok: false,
      error: { code: 'detail_not_read' },
    });
    expect(rec.count('POST', /resolve$/)).toBe(0);
    await advanceUntil(() => loaded(l, id));
    expect(statuses).toEqual(['refreshing', 'loaded']);
    expect(reads()).toBe(before + 1);
  });

  it('applies a read that an event overtook as refreshing, not loaded', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const stream = handStream();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = true;
    rec.intercept(async (c, request) => {
      if (c.path === '/v1/approvals/stream') return stream.response();
      if (!isRead(c, a.id) || !gated) return undefined;
      gated = false;
      const answer = await mockFetch(request);
      await gate;
      return answer;
    });
    const l = await started(rec);
    l.store.openDetail(a.id);
    await advance(50);
    stream.push(eventFrame(cannedApproval(a.id)));
    await advance(50);
    release();
    await advance(50);
    expect(l.snapshot().detail?.status).toBe('refreshing');
    await advanceUntil(() => loaded(l, a.id));
  });

  it('keeps the previous content, arguments included, visible while refreshing', async () => {
    const { l, rec, id, stream } = await setup();
    await advance(1500);
    const before = l.snapshot().detail;
    expect(before && 'arguments' in before).toBe(true);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    rec.intercept(async (c, request) => {
      if (!isRead(c, id)) return c.path === '/v1/approvals/stream' ? stream.response() : undefined;
      const answer = await mockFetch(request);
      await gate;
      return answer;
    });
    stream.push(eventFrame(cannedApproval(id)));
    await advanceUntil(() => l.snapshot().detail?.status === 'refreshing');
    const during = l.snapshot().detail;
    expect(during).toMatchObject({ status: 'refreshing', approval: { id } });
    expect(JSON.stringify(during)).toContain(ARG_MARKER);
    release();
    await advanceUntil(() => loaded(l, id));
  });

  it("ten events in a burst re-read at most twice, and the re-reads' own responses trigger none", async () => {
    const { l, id, stream, reads } = await setup();
    await advance(1500);
    const before = reads();
    for (let i = 0; i < 10; i += 1) stream.push(eventFrame(cannedApproval(id)));
    await advance(5000);
    expect(reads() - before).toBeGreaterThanOrEqual(1);
    expect(reads() - before).toBeLessThanOrEqual(2);
    await advance(60_000, 500);
    expect(reads() - before).toBeLessThanOrEqual(2);
    expect(loaded(l, id)).toBe(true);
  });

  it('a re-read is at most one per second', async () => {
    const { id, stream, reads } = await setup();
    await advance(1500);
    const before = reads();
    // Fifteen events spread over three seconds: never more than one read a second.
    for (let i = 0; i < 15; i += 1) {
      stream.push(eventFrame(cannedApproval(id)));
      await advance(200);
    }
    await advance(2000);
    expect(reads() - before).toBeLessThanOrEqual(4);
    expect(reads() - before).toBeGreaterThanOrEqual(2);
  });

  it('a non-pending event makes the detail resolved from the event, with no read and no arguments', async () => {
    const { l, id, stream, reads } = await setup();
    await advance(1500);
    const before = reads();
    stream.push(eventFrame(cannedApproval(id, { state: 'rejected' })));
    await advanceUntil(() => l.snapshot().detail?.status === 'resolved');
    const detail = l.snapshot().detail;
    expect(detail).toMatchObject({ id, status: 'resolved', approval: { state: 'rejected' } });
    expect(detail && 'arguments' in detail).toBe(false);
    expect(ids(l.snapshot().approvals)).not.toContain(id);
    await advance(10_000);
    expect(reads()).toBe(before);
  });

  it('a read in flight when the approval resolves does not bring the detail back to loaded', async () => {
    const { l, rec, id, stream } = await setup();
    await advance(1500);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    rec.intercept(async (c, request) => {
      if (c.path === '/v1/approvals/stream') return undefined;
      if (!isRead(c, id)) return undefined;
      const answer = await mockFetch(request);
      await gate;
      return answer;
    });
    stream.push(eventFrame(cannedApproval(id)));
    await advanceUntil(() => l.snapshot().detail?.status === 'refreshing');
    stream.push(eventFrame(cannedApproval(id, { state: 'expired' })));
    await advanceUntil(() => l.snapshot().detail?.status === 'resolved');
    release();
    await advance(2000);
    expect(l.snapshot().detail?.status).toBe('resolved');
  });

  it('an identical row in a reconcile list triggers no re-read; a changed digest or expires_at triggers one', async () => {
    const { l, rec, id, reads } = await setup();
    const before = reads();
    await Promise.all([l.store.refresh(), advance(1500)]);
    expect(reads()).toBe(before);
    expect(loaded(l, id)).toBe(true);
    const change = async (patch: Record<string, unknown>): Promise<void> => {
      let once = true;
      rec.intercept(async (c, request) => {
        if (c.path === '/v1/approvals/stream') return handStream().response();
        if (!(once && c.method === 'GET' && c.path === '/v1/approvals')) return undefined;
        once = false;
        const body = (await (await mockFetch(request)).json()) as {
          data: Record<string, unknown>[];
        };
        return jsonResponse({
          ...body,
          data: body.data.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        });
      });
      const seen = reads();
      void l.store.refresh();
      await advanceUntil(() => reads() === seen + 1, 5000);
      await advance(2000);
      expect(reads()).toBe(seen + 1);
    };
    await change({ action_digest: `sha256:${'e'.repeat(64)}` });
    await change({ expires_at: '2031-06-01T00:00:00.000Z' });
    await change({
      state: 'pending',
      resolution_history: [
        { resolution: 'escalated', by: { id: 'x' }, at: '2026-10-05T00:00:00Z' },
      ],
    });
  });
});

describe('T37a canned responses that all carry arguments', () => {
  it('reach the queue, the error, the result and the snapshot only through a single read', async () => {
    const marked = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
      cannedApproval(id, { arguments: { secret: ARG_MARKER }, ...extra });
    const stream = handStream();
    const calls: string[] = [];
    let resolveStep: 'conflict' | 'ok' = 'conflict';
    let listed = [marked('apr_1'), marked('apr_2')];
    const canned: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === '/v1/capabilities') {
        return Promise.resolve(
          jsonResponse({ data: { resolutions: ['approved', 'rejected'], dpop: 'off' } })
        );
      }
      if (url.pathname === '/v1/approvals/stream') return Promise.resolve(stream.response());
      if (url.pathname === '/v1/approvals') {
        return Promise.resolve(jsonResponse({ data: listed, meta: { next: null } }));
      }
      if (request.method === 'POST') {
        return Promise.resolve(
          resolveStep === 'conflict'
            ? problemResponse(409, 'approval_conflict')
            : jsonResponse({ data: marked('apr_1', { state: 'approved' }) })
        );
      }
      // The single read, and the 409's re-read: both carry the arguments, which is what a read does.
      return Promise.resolve(jsonResponse({ data: marked(url.pathname.split('/').pop() ?? '') }));
    };
    const rec = recorder(canned);
    const l = await started(rec);
    const noMarker = (what: unknown): void => {
      expect(JSON.stringify(what)).not.toContain(ARG_MARKER);
    };
    // The list.
    noMarker(l.snapshot());
    expect(ids(l.snapshot().approvals)).toEqual(['apr_1', 'apr_2']);
    // A stream frame for a row in the queue, and one for a new id (which asks for a re-list).
    stream.push(eventFrame(marked('apr_1', { expires_at: '2031-01-01T00:00:00Z' })));
    listed = [marked('apr_1'), marked('apr_2'), marked('apr_3')];
    stream.push(eventFrame(marked('apr_3')));
    await advanceUntil(() => ids(l.snapshot().approvals).includes('apr_3'), 5000);
    noMarker(l.snapshot());
    // Only a single read returns them, and only into the open detail.
    l.store.openDetail('apr_1');
    await advanceUntil(() => loaded(l, 'apr_1'));
    expect(JSON.stringify(l.snapshot().detail)).toContain(ARG_MARKER);
    noMarker(l.snapshot().approvals);
    // A 409 and its re-read.
    const conflict = await l.store.approve('apr_1');
    expect(conflict).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    noMarker(conflict);
    noMarker(l.snapshot().approvals);
    await advanceUntil(() => loaded(l, 'apr_1'));
    // A resolve 200.
    resolveStep = 'ok';
    const result = await l.store.approve('apr_1');
    expect(result).toMatchObject({ ok: true, approval: { state: 'approved' } });
    noMarker(result);
    noMarker(l.snapshot());
    expect(calls.filter((c) => c.startsWith('POST')).length).toBe(2);
  });

  it('is what the type says: a summary has no arguments member', () => {
    type Row = ApprovalsSnapshot['approvals'][number];
    const wide = {} as Approval;
    // @ts-expect-error a row with arguments does not compile
    const row: Row = wide;
    expect(row).toBeDefined();
  });
});
