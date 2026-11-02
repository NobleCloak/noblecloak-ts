import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  call,
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

let h: Harness;
let broken: Harness;
let mockFetch: typeof fetch;
let brokenFetch: typeof fetch;
beforeAll(async () => {
  h = await startHarness();
  broken = await startHarness({ breaks: new Set(['capabilities_unreadable']) });
  mockFetch = inProcessFetch(h.mock);
  brokenFetch = inProcessFetch(broken.mock);
});
afterAll(async () => {
  await h.stop();
  await broken.stop();
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

const settled = (l: Live): boolean =>
  l.snapshot().status === 'ready' && l.snapshot().connection === 'live';

const fail = async (operation: string, status: 500 | 503, fetchImpl = mockFetch): Promise<void> => {
  const response = await fetchImpl(
    new Request(`${h.baseUrl}/__mock/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fail: { operation, status } }),
    })
  );
  expect(response.status).toBe(200);
};

describe('T27 a 503 is unavailable, retried, and never an empty-looking queue', () => {
  it('on the list: unavailable, rows kept, backoff, then ready again', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const l = track(
      live({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.approver,
        fetch: rec.fetch,
        reconcileMs: 5000,
      })
    );
    await advanceUntil(() => settled(l));
    expect(ids(l.snapshot().approvals)).toContain(a.id);
    await fail('listApprovals', 503);
    await advanceUntil(() => l.snapshot().status === 'error', 12_000);
    expect(l.snapshot().error).toMatchObject({ kind: 'unavailable', status: 503 });
    expect(l.snapshot().error?.kind).not.toBe('forbidden');
    expect(ids(l.snapshot().approvals)).toContain(a.id);
    await advanceUntil(() => l.snapshot().status === 'ready', 5000);
    expect(l.snapshot().error).toBeUndefined();
  });

  it('on the first list: still no rows claimed, an unavailable error and a timer armed', async () => {
    await fail('listApprovals', 503);
    const l = track(
      live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, fetch: mockFetch })
    );
    await advanceUntil(() => l.snapshot().status === 'error');
    expect(l.snapshot().error).toMatchObject({ kind: 'unavailable' });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await advanceUntil(() => l.snapshot().status === 'ready', 5000);
  });

  it('on the stream: polling with a correct queue, then live again', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    await fail('streamApprovals', 503);
    const l = track(
      live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, fetch: mockFetch })
    );
    await advanceUntil(() => l.snapshot().connection === 'polling');
    await advanceUntil(() => l.snapshot().status === 'ready');
    expect(ids(l.snapshot().approvals)).toContain(a.id);
    expect(l.snapshot().error).toBeUndefined();
    await advanceUntil(() => l.snapshot().connection === 'live', 8000);
  });

  it('a stream that answers 403 or 404 stays polling and is tried again no sooner than 30 s', async () => {
    for (const [status, code] of [
      [403, 'forbidden'],
      [404, 'not_found'],
    ] as const) {
      const rec = recorder(mockFetch);
      rec.intercept((c, request) =>
        c.path === '/v1/approvals/stream' ? problemResponse(status, code) : mockFetch(request)
      );
      const l = track(
        live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, fetch: rec.fetch })
      );
      await advanceUntil(() => l.snapshot().status === 'ready');
      expect(l.snapshot().connection).toBe('polling');
      await advance(29_000);
      expect(rec.count('GET', '/v1/approvals/stream')).toBe(1);
      await advance(8000);
      expect(rec.count('GET', '/v1/approvals/stream')).toBe(2);
      l.close();
    }
  });

  it('a 401 on the stream follows the 401 rule', async () => {
    const onExpired = vi.fn();
    const rec = recorder(mockFetch);
    let streamCalls = 0;
    rec.intercept((c, request) => {
      if (c.path !== '/v1/approvals/stream') return mockFetch(request);
      streamCalls += 1;
      return problemResponse(401, 'invalid_token');
    });
    const l = track(
      live({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.approver,
        fetch: rec.fetch,
        onSessionExpired: onExpired,
      })
    );
    await advanceUntil(
      () => l.snapshot().status === 'error' && l.snapshot().error?.kind === 'unauthorized'
    );
    expect(onExpired).toHaveBeenCalledTimes(1);
    // The first try and its one retry after a forced refresh, and nothing after.
    await advance(60_000);
    expect(streamCalls).toBe(2);
    expect(l.snapshot().connection).toBe('offline');
  });
});

describe('what an exception behind a request is called', () => {
  const firstError = async (fetchImpl: typeof fetch, getToken: () => string): Promise<Live> => {
    const l = track(live({ baseUrl: h.baseUrl, getToken, fetch: fetchImpl }));
    await advanceUntil(() => l.snapshot().error !== undefined);
    return l;
  };

  it('keeps a failed fetch as network, and the TypeError as its cause', async () => {
    const failure = new TypeError('Failed to fetch');
    const l = await firstError(
      () => {
        throw failure;
      },
      () => h.tokens.approver
    );
    expect(l.snapshot().error).toMatchObject({ kind: 'network', code: 'network', local: true });
    expect(l.snapshot().error?.cause).toBe(failure);
  });

  it('names any other exception from the fetch client_error, with the exception as cause', async () => {
    const bug = new RangeError('boom');
    const l = await firstError(
      () => {
        throw bug;
      },
      () => h.tokens.approver
    );
    expect(l.snapshot().error).toMatchObject({ kind: 'network', code: 'client_error' });
    expect(l.snapshot().error?.cause).toBe(bug);
  });

  it('names a token provider failure that is not an AuthError token_unavailable, and keeps retrying', async () => {
    const broken = new Error('keychain locked');
    let calls = 0;
    const l = await firstError(mockFetch, () => {
      calls += 1;
      throw broken;
    });
    expect(l.snapshot().error).toMatchObject({ kind: 'network', code: 'token_unavailable' });
    expect(l.snapshot().error?.cause).toBe(broken);
    expect(l.snapshot().status).toBe('loading');
    await advance(5000);
    expect(calls).toBeGreaterThan(1);
  });
});

describe('T28 capabilities', () => {
  it('backs off a 503 and recovers; the store stays loading, never without a timer', async () => {
    await fail('getCapabilities', 503);
    const rec = recorder(mockFetch);
    const l = track(
      live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, fetch: rec.fetch })
    );
    await advanceUntil(() => l.snapshot().error !== undefined);
    expect(l.snapshot()).toMatchObject({ status: 'loading', error: { kind: 'unavailable' } });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await advanceUntil(() => settled(l), 5000);
    expect(l.snapshot().error).toBeUndefined();
    expect(rec.count('GET', '/v1/capabilities')).toBe(2);
  });

  it('settles refresh() after the first failed capabilities attempt, and keeps retrying', async () => {
    const rec = recorder(mockFetch);
    rec.intercept((c, request) =>
      c.path === '/v1/capabilities'
        ? problemResponse(503, 'service_unavailable')
        : mockFetch(request)
    );
    const l = track(
      live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, fetch: rec.fetch })
    );
    await advanceUntil(() => l.snapshot().error !== undefined);
    let settledRefresh = false;
    const pending = l.store.refresh().then(() => {
      settledRefresh = true;
    });
    await advanceUntil(() => settledRefresh, 3000);
    await pending;
    // Settled, yet still loading with the failure kept, and the retries have not stopped.
    expect(l.snapshot()).toMatchObject({ status: 'loading', error: { kind: 'unavailable' } });
    const before = rec.count('GET', '/v1/capabilities');
    await advance(10_000);
    expect(rec.count('GET', '/v1/capabilities')).toBeGreaterThan(before);
  });

  it('backs off the capabilities_unreadable break with a retry timer each time, and the code stays unavailable', async () => {
    const rec = recorder(brokenFetch);
    const l = track(
      live({ baseUrl: broken.baseUrl, getToken: () => broken.tokens.approver, fetch: rec.fetch })
    );
    await advanceUntil(() => l.snapshot().error !== undefined);
    expect(l.snapshot().error).toMatchObject({ kind: 'unavailable' });
    expect(l.snapshot().status).toBe('loading');
    await advance(40_000);
    expect(rec.count('GET', '/v1/capabilities')).toBeGreaterThanOrEqual(5);
    // 1, 2, 4, 8, 16 s of backoff in 40 s: about six requests, never a hot loop.
    expect(rec.count('GET', '/v1/capabilities')).toBeLessThanOrEqual(9);
    expect(rec.count('GET', '/v1/approvals')).toBe(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('follows rule 7 on a 401, and error/unauthorized exits through refresh()', async () => {
    let token = h.tokens.expired;
    const onExpired = vi.fn();
    const l = track(
      live({
        baseUrl: h.baseUrl,
        getToken: () => token,
        fetch: mockFetch,
        onSessionExpired: onExpired,
      })
    );
    await advanceUntil(() => l.snapshot().status === 'error');
    expect(l.snapshot().error).toMatchObject({ kind: 'unauthorized' });
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    token = h.tokens.approver;
    await Promise.all([l.store.refresh(), advance(200)]);
    await advanceUntil(() => settled(l));
    expect(l.snapshot().error).toBeUndefined();
    // And it can end again, once more.
    token = h.tokens.expired;
    await Promise.all([l.store.refresh(), advance(200)]);
    await advanceUntil(() => l.snapshot().status === 'error');
    expect(onExpired).toHaveBeenCalledTimes(2);
  });

  it('reports a throwing onSessionExpired instead of rejecting or going unhandled', async () => {
    const reported = vi.fn();
    vi.stubGlobal('reportError', reported);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const boom = new Error('host-bug');
      const onExpired = vi.fn(() => {
        throw boom;
      });
      // From the bootstrap (a fire-and-forget path).
      const first = track(
        live({
          baseUrl: h.baseUrl,
          getToken: () => h.tokens.expired,
          fetch: mockFetch,
          onSessionExpired: onExpired,
        })
      );
      await advanceUntil(() => first.snapshot().status === 'error');
      expect(first.snapshot().error).toMatchObject({ kind: 'unauthorized' });
      expect(reported).toHaveBeenCalledWith(boom);

      // From approve(), which never rejects.
      const a = await openApprovalIn(h.mock, h.tokens.creator_user);
      const rec = recorder(mockFetch);
      rec.intercept((c) =>
        c.method === 'POST' ? problemResponse(401, 'invalid_token') : undefined
      );
      const second = track(
        live({
          baseUrl: h.baseUrl,
          getToken: () => h.tokens.approver,
          fetch: rec.fetch,
          onSessionExpired: onExpired,
          reconcileMs: 600_000,
        })
      );
      await advanceUntil(() => settled(second));
      second.store.openDetail(a.id);
      await advanceUntil(() => second.snapshot().detail?.status === 'loaded');
      const result = await Promise.all([second.store.approve(a.id), advance(500)]);
      expect(result[0]).toMatchObject({ ok: false, error: { kind: 'unauthorized' } });
      expect(reported).toHaveBeenCalledTimes(2);
      await advance(1000);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('is unsupported without resolutions, with dpop required and on a 404, and refresh() exits it', async () => {
    let advertise: 'none' | 'dpop' | 'all' | '404' = 'none';
    const rec = recorder(mockFetch);
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/capabilities') return undefined;
      if (advertise === '404') return problemResponse(404, 'not_available_on_deployment');
      const body = (await (await mockFetch(request)).json()) as { data: Record<string, unknown> };
      if (advertise === 'none')
        return jsonResponse({ ...body, data: { ...body.data, resolutions: [] } });
      if (advertise === 'dpop')
        return jsonResponse({ ...body, data: { ...body.data, dpop: 'required' } });
      return jsonResponse(body);
    });
    const l = track(
      live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, fetch: rec.fetch })
    );
    await advanceUntil(() => l.snapshot().status === 'error');
    expect(l.snapshot()).toMatchObject({ error: { kind: 'unsupported' }, connection: 'offline' });
    expect(rec.count('GET', '/v1/approvals')).toBe(0);
    expect(rec.count('GET', '/v1/approvals/stream')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    for (const next of ['dpop', '404'] as const) {
      advertise = next;
      await Promise.all([l.store.refresh(), advance(100)]);
      expect(l.snapshot()).toMatchObject({ status: 'error', error: { kind: 'unsupported' } });
    }
    advertise = 'all';
    await Promise.all([l.store.refresh(), advance(100)]);
    await advanceUntil(() => settled(l));
    expect(l.snapshot().error).toBeUndefined();
  });

  it('reads a capabilities answer it cannot parse as an error to retry', async () => {
    const rec = recorder(mockFetch);
    let bad = true;
    rec.intercept((c, request) =>
      c.path === '/v1/capabilities' && bad
        ? new Response('[]', { status: 200 })
        : mockFetch(request)
    );
    const l = track(
      live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, fetch: rec.fetch })
    );
    await advanceUntil(() => l.snapshot().error?.kind === 'malformed_response');
    bad = false;
    await advanceUntil(() => settled(l), 5000);
  });
});

describe('T29 the stream watchdog', () => {
  const withStreams = (rec: Recorder, streams: ReturnType<typeof handStream>[]): void => {
    let next = 0;
    rec.intercept((c, request) => {
      if (c.path !== '/v1/approvals/stream') return mockFetch(request);
      const s = streams[next] ?? handStream();
      next += 1;
      return s.response();
    });
  };

  it('aborts a stream that went silent after keepalives, goes polling, reconnects and re-lists', async () => {
    const first = handStream();
    const second = handStream();
    const rec = recorder(mockFetch);
    withStreams(rec, [first, second]);
    const l = track(
      live({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.approver,
        fetch: rec.fetch,
        reconcileMs: 600_000,
      })
    );
    first.push(': connected\n\n');
    await advanceUntil(() => settled(l));
    for (let i = 0; i < 4; i += 1) {
      first.push(':keepalive\n\n');
      await advance(15_000);
    }
    expect(l.snapshot().connection).toBe('live');
    expect(first.cancelled()).toBe(false);
    const lists = rec.count('GET', '/v1/approvals');
    // Silence: more than 45 s without any bytes (the last keepalive was 15 s ago).
    await advance(29_000);
    expect(l.snapshot().connection).toBe('live');
    await advanceUntil(() => first.cancelled(), 3000);
    expect(rec.count('GET', '/v1/approvals/stream')).toBe(1);
    expect(l.snapshot().connection).not.toBe('live');
    await advanceUntil(() => rec.count('GET', '/v1/approvals/stream') === 2, 5000);
    await advanceUntil(() => l.snapshot().connection === 'live', 3000);
    await advanceUntil(() => rec.count('GET', '/v1/approvals') > lists, 5000);
  });

  it('is not armed by events alone, and not by the opening comment', async () => {
    const quiet = handStream();
    const rec = recorder(mockFetch);
    withStreams(rec, [quiet]);
    const l = track(
      live({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.approver,
        fetch: rec.fetch,
        reconcileMs: 600_000,
      })
    );
    quiet.push(': connected\n\n');
    await advanceUntil(() => settled(l));
    quiet.push(eventFrame(cannedApproval('apr_x', { state: 'approved' })));
    await advance(10 * 60_000, 1000);
    expect(quiet.cancelled()).toBe(false);
    expect(l.snapshot().connection).toBe('live');
    expect(rec.count('GET', '/v1/approvals/stream')).toBe(1);
  });

  it('re-arms on every byte, so a stream that keeps talking is never cut', async () => {
    const chatty = handStream();
    const rec = recorder(mockFetch);
    withStreams(rec, [chatty]);
    const l = track(
      live({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.approver,
        fetch: rec.fetch,
        reconcileMs: 600_000,
      })
    );
    await advanceUntil(() => settled(l));
    chatty.push(':keepalive\n\n');
    for (let i = 0; i < 6; i += 1) {
      await advance(40_000, 1000);
      chatty.push(':keepalive\n\n');
    }
    expect(chatty.cancelled()).toBe(false);
    expect(l.snapshot().connection).toBe('live');
  });

  it('treats a stream that ends cleanly as down, and reconnects', async () => {
    const ended = handStream();
    const rec = recorder(mockFetch);
    withStreams(rec, [ended]);
    const l = track(
      live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, fetch: rec.fetch })
    );
    await advanceUntil(() => settled(l));
    ended.end();
    await advanceUntil(() => l.snapshot().connection === 'polling');
    await advanceUntil(() => rec.count('GET', '/v1/approvals/stream') === 2, 5000);
  });
});

describe('the stream carries every approval of the organisation', () => {
  it('ignores a non-pending event for an unknown id, except to tombstone it', async () => {
    const stream = handStream();
    const rec = recorder(mockFetch);
    rec.intercept((c, request) =>
      c.path === '/v1/approvals/stream' ? stream.response() : mockFetch(request)
    );
    const l = track(
      live({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.approver,
        fetch: rec.fetch,
        reconcileMs: 600_000,
      })
    );
    await advanceUntil(() => settled(l));
    await advance(1500);
    const lists = rec.count('GET', '/v1/approvals');
    stream.push(eventFrame(cannedApproval('apr_gone', { state: 'rejected' })));
    await advance(3000);
    expect(rec.count('GET', '/v1/approvals')).toBe(lists);
    // Dropped frames are ignored: a bad one and one of another kind.
    stream.push('event: approval.updated\ndata: nope\n\n');
    stream.push('event: other\ndata: {}\n\n');
    await advance(3000);
    expect(l.snapshot().status).toBe('ready');
  });

  it('is ignored for an id that is tombstoned: a pending event does not re-list', async () => {
    const stream = handStream();
    const rec = recorder(mockFetch);
    rec.intercept((c, request) =>
      c.path === '/v1/approvals/stream' ? stream.response() : mockFetch(request)
    );
    const l = track(
      live({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.approver,
        fetch: rec.fetch,
        reconcileMs: 600_000,
      })
    );
    await advanceUntil(() => settled(l));
    await advance(1500);
    const lists = rec.count('GET', '/v1/approvals');
    stream.push(eventFrame(cannedApproval('apr_t', { state: 'expired' })));
    stream.push(eventFrame(cannedApproval('apr_t', { state: 'pending' })));
    await advance(3000);
    expect(rec.count('GET', '/v1/approvals')).toBe(lists);
  });

  it('works through the mock too: an event for a row in the queue replaces it', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const l = track(
      live({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.approver,
        fetch: mockFetch,
        reconcileMs: 600_000,
      })
    );
    await advanceUntil(() => settled(l));
    expect(ids(l.snapshot().approvals)).toContain(a.id);
    // The creator withdraws it: the stream says so and the row leaves without a list.
    const withdrawn = await call(
      h.baseUrl,
      h.tokens.creator_user,
      'POST',
      `/v1/approvals/${a.id}/withdraw`
    );
    expect(withdrawn.status).toBe(200);
    await advanceUntil(() => !ids(l.snapshot().approvals).includes(a.id));
  });
});

describe('T18 the store leaves nothing behind', () => {
  it('stops every timer and aborts every request when the last subscriber leaves', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    const signals: AbortSignal[] = [];
    rec.intercept((_c, request) => {
      signals.push(request.signal);
      return undefined;
    });
    const store = (await import('./approvals-store.js')).createApprovalsStore({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.approver,
      fetch: rec.fetch,
    });
    // Two subscribers, as under StrictMode: the first leaving stops nothing, the last stops all.
    const first = store.subscribe(() => undefined);
    const second = store.subscribe(() => undefined);
    await advanceUntil(
      () => store.getSnapshot().status === 'ready' && store.getSnapshot().connection === 'live'
    );
    store.openDetail(a.id);
    await advanceUntil(() => store.getSnapshot().detail?.status === 'loaded');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    first();
    expect(store.getSnapshot().connection).toBe('live');
    second();
    expect(vi.getTimerCount()).toBe(0);
    expect(signals.length).toBeGreaterThanOrEqual(4);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(store.getSnapshot().detail).toBeUndefined();
    // Starting again works from the capabilities, and leaves nothing behind either.
    const again = store.subscribe(() => undefined);
    await advanceUntil(() => store.getSnapshot().status === 'ready');
    again();
    expect(vi.getTimerCount()).toBe(0);
    store.dispose();
  });

  it('ends a retry timer of the open detail on the last unsubscribe', async () => {
    const a = await openApprovalIn(h.mock, h.tokens.creator_user);
    const rec = recorder(mockFetch);
    rec.intercept((c, request) =>
      c.path === `/v1/approvals/${a.id}`
        ? problemResponse(503, 'service_unavailable')
        : mockFetch(request)
    );
    const l = track(
      live({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.approver,
        fetch: rec.fetch,
        reconcileMs: 600_000,
      })
    );
    await advanceUntil(() => settled(l));
    l.store.openDetail(a.id);
    await advanceUntil(() => l.snapshot().detail?.status === 'unavailable');
    l.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
