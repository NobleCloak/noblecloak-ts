import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cannedApproval,
  eventFrame,
  jsonResponse,
  live,
  problemResponse,
  recorder,
  until,
} from './testing/approvals-harness.js';
import { advanceUntil, fakeTime } from './testing/approvals-fake-time.js';
import type { Live } from './testing/approvals-harness.js';
import type { ApprovalsLabels } from './approvals.js';
import { AuthError } from './auth-types.js';
import { canned } from './testing/canned-api.js';
import type { Canned } from './testing/canned-api.js';

let open: Live[] = [];
afterEach(() => {
  for (const l of open) l.close();
  open = [];
});

async function started(api: Canned): Promise<Live> {
  const l = live({ baseUrl: 'https://api.test', getToken: () => 'tok', fetch: api.fetch });
  open.push(l);
  await until(l.store, (s) => s.status === 'ready');
  return l;
}

const other = (): Response =>
  jsonResponse({ data: cannedApproval('apr_other', { arguments: { stolen: true } }) });

describe('c1-1 the id returned must be the id requested', () => {
  it('a single read for another approval is a malformed response and is never applied', async () => {
    const api = canned();
    api.read = other;
    const l = await started(api);
    l.store.openDetail('apr_1');
    const s = await until(l.store, (x) => x.detail?.status === 'error');
    expect(s.detail).toMatchObject({
      id: 'apr_1',
      status: 'error',
      error: { kind: 'malformed_response' },
    });
    expect(JSON.stringify(s.detail)).not.toContain('stolen');
  });

  it('a 409 whose re-read names another approval is returned without current', async () => {
    const api = canned();
    const l = await started(api);
    l.store.openDetail('apr_1');
    await until(l.store, (x) => x.detail?.status === 'loaded');
    api.read = other;
    const result = await l.store.approve('apr_1');
    expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(result.ok ? undefined : (result.error as { current?: unknown }).current).toBeUndefined();
  });

  it('the fallback re-read of a 409 (the detail was closed meanwhile) also refuses another id', async () => {
    const api = canned();
    const l = await started(api);
    l.store.openDetail('apr_1');
    await until(l.store, (x) => x.detail?.status === 'loaded');
    api.resolve = () => {
      l.store.closeDetail();
      api.read = other;
      return problemResponse(409, 'approval_conflict');
    };
    const result = await l.store.approve('apr_1');
    expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(result.ok ? undefined : (result.error as { current?: unknown }).current).toBeUndefined();
    expect(api.calls.filter((c) => c === 'GET /v1/approvals/apr_1').length).toBe(2);
  });

  it('a resolve 200 for another approval is a malformed response and changes nothing', async () => {
    const api = canned();
    const l = await started(api);
    l.store.openDetail('apr_1');
    await until(l.store, (x) => x.detail?.status === 'loaded');
    api.resolve = () => jsonResponse({ data: cannedApproval('apr_other', { state: 'approved' }) });
    const result = await l.store.approve('apr_1');
    expect(result).toMatchObject({ ok: false, error: { kind: 'malformed_response' } });
    expect(l.snapshot().detail?.status).toBe('loaded');
    expect(l.snapshot().approvals.map((a) => a.id)).toEqual(['apr_1']);
  });

  it('a stream event for another id leaves the open detail alone', async () => {
    const api = canned(['apr_1', 'apr_2']);
    const l = await started(api);
    l.store.openDetail('apr_1');
    await until(l.store, (x) => x.detail?.status === 'loaded');
    api.stream.push(eventFrame(cannedApproval('apr_2', { state: 'rejected' })));
    await until(l.store, (x) => !x.approvals.some((a) => a.id === 'apr_2'));
    expect(l.snapshot().detail).toMatchObject({ id: 'apr_1', status: 'loaded' });
  });
});

describe('c1-9 a stream line over 1 MiB ends the attempt and reconnects on the backoff', () => {
  beforeEach(() => {
    fakeTime();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the connection, polls, and asks for the stream again', async () => {
    const api = canned();
    const l = await started(api);
    await advanceUntil(() => l.snapshot().connection === 'live');
    const connects = (): number => api.calls.filter((c) => c === 'GET /v1/approvals/stream').length;
    expect(connects()).toBe(1);
    const piece = 'x'.repeat(256 * 1024);
    api.stream.push(`data: ${piece}`);
    for (let i = 0; i < 4; i += 1) api.stream.push(piece);
    await advanceUntil(() => l.snapshot().connection === 'polling');
    expect(api.stream.cancelled()).toBe(true);
    await advanceUntil(() => connects() === 2, 5000);
  });
});

describe('c1-10 a capabilities 503 leaves the store loading with the error held', () => {
  it('keeps the status loading and the error unavailable while it retries', async () => {
    const api = canned();
    const answer = api.fetch;
    const failing: typeof fetch = (input, init) =>
      new URL(new Request(input, init).url).pathname === '/v1/capabilities'
        ? Promise.resolve(problemResponse(503, 'service_unavailable'))
        : answer(input, init);
    const l = live({ baseUrl: 'https://api.test', getToken: () => 'tok', fetch: failing });
    open.push(l);
    const s = await until(l.store, (x) => x.error !== undefined);
    expect(s.status).toBe('loading');
    expect(s.error?.kind).toBe('unavailable');
  });
});

describe('c1-11 only a session-ending auth error ends the session', () => {
  beforeEach(() => {
    fakeTime();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function failingTokenSource(code: string) {
    const api = canned();
    let failing = false;
    let expired = 0;
    const l = live({
      baseUrl: 'https://api.test',
      getToken: () => {
        if (failing) throw new AuthError(code, 'x');
        return 'tok';
      },
      fetch: api.fetch,
      onSessionExpired: () => {
        expired += 1;
      },
    });
    open.push(l);
    await advanceUntil(() => l.snapshot().connection === 'live' && l.snapshot().status === 'ready');
    failing = true;
    // A new id on the stream asks for a list, which asks for a token.
    api.list = [...api.list, cannedApproval('apr_2')];
    api.stream.push(eventFrame(cannedApproval('apr_2')));
    await advanceUntil(() => l.snapshot().status === 'error', 8000);
    return { api, l, expired: () => expired };
  }

  it('a metadata outage is a token that could not be obtained: unavailable, stream up, no expiry', async () => {
    const { api, l, expired } = await failingTokenSource('metadata_unavailable');
    expect(l.snapshot().error).toMatchObject({ kind: 'network', code: 'token_unavailable' });
    expect(l.snapshot().connection).toBe('live');
    expect(api.stream.cancelled()).toBe(false);
    expect(expired()).toBe(0);
  });

  it('signed_out, invalid_grant and server_error end the session', async () => {
    for (const code of ['signed_out', 'invalid_grant', 'server_error']) {
      const { l, expired } = await failingTokenSource(code);
      expect(l.snapshot().error).toMatchObject({ kind: 'unauthorized', code: 'session_expired' });
      expect(expired()).toBe(1);
      l.close();
    }
  });
});

describe('c1-12 session expiry does not strand the open detail', () => {
  beforeEach(() => {
    fakeTime();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A store with `apr_1` open whose next read is held, and a token source that can start failing. */
  async function expiring(startFrom: 'loading' | 'refreshing') {
    const api = canned();
    const state = { failing: false, expired: 0 };
    const l = live({
      baseUrl: 'https://api.test',
      getToken: () => {
        if (state.failing) throw new AuthError('signed_out', 'x');
        return 'tok';
      },
      fetch: api.fetch,
      onSessionExpired: () => {
        state.expired += 1;
      },
    });
    open.push(l);
    await advanceUntil(() => l.snapshot().connection === 'live' && l.snapshot().status === 'ready');
    const original = api.read;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (startFrom === 'loading') {
      api.read = async (id) => {
        await gate;
        return original(id);
      };
      l.store.openDetail('apr_1');
    } else {
      l.store.openDetail('apr_1');
      await advanceUntil(() => l.snapshot().detail?.status === 'loaded');
      api.read = async (id) => {
        await gate;
        return original(id);
      };
      api.stream.push(
        eventFrame(cannedApproval('apr_1', { action_digest: `sha256:${'c'.repeat(64)}` }))
      );
      await advanceUntil(() => l.snapshot().detail?.status === 'refreshing');
    }
    expect(l.snapshot().detail?.status).toBe(startFrom);
    state.failing = true;
    api.list = [...api.list, cannedApproval('apr_2')];
    api.stream.push(eventFrame(cannedApproval('apr_2')));
    await advanceUntil(() => state.expired === 1, 8000);
    return { api, l, state, release, original };
  }

  it.each(['loading', 'refreshing'] as const)(
    'a %s detail becomes unauthorized with its arguments dropped',
    async (from) => {
      const { l, release } = await expiring(from);
      expect(l.snapshot().detail).toMatchObject({ id: 'apr_1', status: 'unauthorized' });
      expect(JSON.stringify(l.snapshot().detail)).not.toContain('amount');
      release();
      await advanceUntil(() => true);
      expect(l.snapshot().detail?.status).toBe('unauthorized');
    }
  );

  it('refresh() re-reads the open detail once the new run has started', async () => {
    const { l, state, api, release } = await expiring('loading');
    state.failing = false;
    release();
    await l.store.refresh();
    await advanceUntil(() => l.snapshot().detail?.status === 'loaded');
    expect(JSON.stringify(l.snapshot().detail)).toContain('amount');
    expect(api.calls.filter((c) => c === 'GET /v1/approvals/apr_1').length).toBeGreaterThan(1);
  });

  it('retryDetail accepts an unauthorized detail', async () => {
    const { l, state, release } = await expiring('loading');
    state.failing = false;
    release();
    l.store.retryDetail();
    await advanceUntil(() => l.snapshot().detail?.status === 'loaded');
    expect(l.snapshot().detail?.status).toBe('loaded');
  });
});

describe('c1-14 seams in the store', () => {
  it('a summary carries neither arguments nor continuation, in the queue, a detail or a result', async () => {
    const api = canned();
    const withContinuation = { continuation: { kind: 'langgraph', secret: 'CONT-MARKER' } };
    api.list = [cannedApproval('apr_1', withContinuation)];
    api.read = (id) =>
      jsonResponse({
        data: cannedApproval(id, { ...withContinuation, arguments: { amount: 1 } }),
      });
    api.resolve = (id) =>
      jsonResponse({ data: cannedApproval(id, { ...withContinuation, state: 'approved' }) });
    const l = await started(api);
    expect(JSON.stringify(l.snapshot().approvals)).not.toContain('CONT-MARKER');
    l.store.openDetail('apr_1');
    await until(l.store, (x) => x.detail?.status === 'loaded');
    expect(JSON.stringify(l.snapshot())).not.toContain('CONT-MARKER');
    const result = await l.store.approve('apr_1');
    expect(JSON.stringify(result)).not.toContain('CONT-MARKER');
    expect(JSON.stringify(l.snapshot())).not.toContain('CONT-MARKER');
  });

  it('the 409 fallback re-read that is answered 401 ends the session', async () => {
    const api = canned();
    let expired = 0;
    const l = live({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: api.fetch,
      onSessionExpired: () => {
        expired += 1;
      },
    });
    open.push(l);
    await until(l.store, (x) => x.status === 'ready');
    l.store.openDetail('apr_1');
    await until(l.store, (x) => x.detail?.status === 'loaded');
    api.resolve = () => {
      l.store.closeDetail();
      api.read = () => problemResponse(401, 'unauthorized');
      return problemResponse(409, 'approval_conflict');
    };
    const result = await l.store.approve('apr_1');
    expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(expired).toBe(1);
    expect(l.snapshot().status).toBe('error');
  });
});

describe('c1-15 the public surface', () => {
  it('onFault receives a fault in a subscriber and replaces the default report', async () => {
    const api = canned();
    const faults: unknown[] = [];
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const l = live({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: api.fetch,
      onFault: (fault) => faults.push(fault),
    });
    open.push(l);
    const boom = new Error('listener failed');
    l.store.subscribe(() => {
      throw boom;
    });
    await until(l.store, (x) => x.status === 'ready');
    expect(faults).toContain(boom);
    expect(reported).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('an onFault that throws does not lose the fault: it is reported with reportError', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const l = live({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: canned().fetch,
      onFault: () => {
        throw new Error('handler failed');
      },
    });
    open.push(l);
    const boom = new Error('listener failed');
    l.store.subscribe(() => {
      throw boom;
    });
    await until(l.store, (x) => x.status === 'ready');
    expect(reported).toContain(boom);
    vi.unstubAllGlobals();
  });

  it('without onFault a fault is reported with reportError, and dropped where there is none', async () => {
    const boom = new Error('listener failed');
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const first = live({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: canned().fetch,
    });
    open.push(first);
    first.store.subscribe(() => {
      throw boom;
    });
    await until(first.store, (x) => x.status === 'ready');
    expect(reported).toContain(boom);
    vi.stubGlobal('reportError', undefined);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const second = live({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: canned().fetch,
    });
    open.push(second);
    second.store.subscribe(() => {
      throw boom;
    });
    // No microtask rethrow: this would fail the run as an unhandled error.
    await until(second.store, (x) => x.status === 'ready');
    // Written as text, never as the object, which may carry host data.
    expect(logged).toHaveBeenCalledWith('Error: listener failed');
    vi.unstubAllGlobals();
  });

  it('approve ignores an expectedActionDigest a JavaScript caller passes', async () => {
    const api = canned();
    const rec = recorder(api.fetch);
    api.resolve = (id) => jsonResponse({ data: cannedApproval(id, { state: 'approved' }) });
    const l = live({ baseUrl: 'https://api.test', getToken: () => 'tok', fetch: rec.fetch });
    open.push(l);
    await until(l.store, (x) => x.status === 'ready');
    l.store.openDetail('apr_1');
    await until(l.store, (x) => x.detail?.status === 'loaded');
    await l.store.approve('apr_1', { expectedActionDigest: 'sha256:forged' } as never);
    const post = rec.calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ expected_action_digest: `sha256:${'a'.repeat(64)}` });
  });

  it('exports ApprovalsLabels from the approvals entry', () => {
    const labels: ApprovalsLabels = { approve: 'Accept' };
    expect(labels.approve).toBe('Accept');
  });
});

describe('c1-18 a decision carries the digest of the read that enabled it', () => {
  beforeEach(() => {
    fakeTime();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const A = `sha256:${'a'.repeat(64)}`;
  const B = `sha256:${'b'.repeat(64)}`;

  it('a list that advances the row digest blocks the decision until a read, which sends its own digest', async () => {
    const api = canned();
    const rec = recorder(api.fetch);
    api.resolve = (id) => jsonResponse({ data: cannedApproval(id, { state: 'approved' }) });
    const l = live({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: rec.fetch,
      pollMs: 1000,
    });
    open.push(l);
    await advanceUntil(() => l.snapshot().connection === 'live' && l.snapshot().status === 'ready');
    l.store.openDetail('apr_1');
    await advanceUntil(() => l.snapshot().detail?.status === 'loaded');
    // The list moves on to digest B while the single read keeps answering A (a lagging replica).
    api.list = [cannedApproval('apr_1', { action_digest: B })];
    api.stream.push(eventFrame(cannedApproval('apr_1', { action_digest: B })));
    await advanceUntil(() => l.snapshot().detail?.status === 'refreshing');
    // Blocked while the read is owed: no request leaves, whatever digest the row now shows.
    const blocked = await l.store.approve('apr_1');
    expect(blocked).toMatchObject({ ok: false, error: { kind: 'precondition' } });
    expect(rec.calls.filter((c) => c.method === 'POST')).toEqual([]);
    // The read answers A; the detail is loaded again, and the decision carries the digest of that read.
    await advanceUntil(() => l.snapshot().detail?.status === 'loaded');
    expect(l.snapshot().detail).toMatchObject({ approval: { action_digest: A } });
    await l.store.approve('apr_1');
    const post = rec.calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ expected_action_digest: A });
    expect(post?.body).not.toMatchObject({ expected_action_digest: B });
  });
});

describe('c2-3 the single read keeps the exact text of the arguments', () => {
  const textResponse = (body: string): Response =>
    new Response(body, { headers: { 'content-type': 'application/json' } });
  const approvalText = (args: string): string =>
    JSON.stringify(cannedApproval('apr_1')).slice(0, -1) + `,"arguments":${args}}`;

  it('holds the member as sent, for a bare approval and for an envelope', async () => {
    const args = '{"n": 12345678901234567890, "x":1.0,"s":"\\"arguments\\""}';
    for (const body of [approvalText(args), `{"data":${approvalText(args)},"meta":{}}`]) {
      const api = canned();
      api.read = () => textResponse(body);
      const l = await started(api);
      l.store.openDetail('apr_1');
      const s = await until(l.store, (x) => x.detail?.status === 'loaded');
      expect(s.detail).toMatchObject({ argumentsSource: args });
      l.close();
    }
  });

  it('keeps the source through a refreshing read', async () => {
    const api = canned();
    api.read = () => textResponse(approvalText('{"n":1.0}'));
    const l = await started(api);
    l.store.openDetail('apr_1');
    await until(l.store, (x) => x.detail?.status === 'loaded');
    api.stream.push(eventFrame(cannedApproval('apr_1', { action_digest: 'sha256:changed' })));
    const s = await until(l.store, (x) => x.detail?.status === 'refreshing');
    expect(s.detail).toMatchObject({ argumentsSource: '{"n":1.0}' });
  });

  it('a body that names arguments twice is a malformed response', async () => {
    const api = canned();
    api.read = () => textResponse(approvalText('{"a":1}').slice(0, -1) + ',"arguments":{"a":2}}');
    const l = await started(api);
    l.store.openDetail('apr_1');
    const s = await until(l.store, (x) => x.detail?.status === 'error');
    expect(s.detail).toMatchObject({ status: 'error', error: { kind: 'malformed_response' } });
  });
});

describe('c2-4 every request is credential-free CORS', () => {
  it('a list, a read, a resolve and the stream all carry credentials omit and mode cors', async () => {
    const api = canned();
    const seen: { path: string; init: RequestInit | undefined }[] = [];
    const l = live({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: (input, init) => {
        seen.push({ path: new URL(new Request(input).url).pathname, init });
        return api.fetch(input, init);
      },
    });
    open.push(l);
    await until(l.store, (s) => s.status === 'ready');
    l.store.openDetail('apr_1');
    await until(l.store, (s) => s.detail?.status === 'loaded');
    await l.store.approve('apr_1');
    const paths = new Set(seen.map((s) => s.path));
    for (const path of [
      '/v1/capabilities',
      '/v1/approvals',
      '/v1/approvals/apr_1',
      '/v1/approvals/apr_1/resolve',
      '/v1/approvals/stream',
    ]) {
      expect(paths.has(path), path).toBe(true);
    }
    for (const { path, init } of seen) {
      expect(init, path).toMatchObject({ credentials: 'omit', mode: 'cors' });
    }
  });
});

describe('c2-7 faults the module meets are reported, and a bug ends an operation in an error state', () => {
  it('a fetch that throws something other than a failed request is reported, not only shown', async () => {
    const faults: unknown[] = [];
    const bug = new RangeError('host fetch bug');
    const l = live({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: () => Promise.reject(bug),
      onFault: (fault) => faults.push(fault),
    });
    open.push(l);
    await until(l.store, (x) => x.error !== undefined);
    expect(faults).toContain(bug);
    expect(l.snapshot().error).toMatchObject({ kind: 'network', code: 'client_error' });
  });

  it('a fetch factory failure inside the client is also a client_error, not an escaped rejection', async () => {
    const l = live({
      baseUrl: 'not a url',
      getToken: () => 'tok',
      fetch: canned().fetch,
      onFault: () => undefined,
    });
    open.push(l);
    const s = await until(l.store, (x) => x.error !== undefined);
    expect(s.error?.kind).toBe('network');
  });

  it('a bug in an async entry point is reported and the queue ends in error instead of an unhandled rejection', async () => {
    const faults: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const boom = new Error('clock bug');
    let calls = 0;
    const api = canned();
    try {
      const l = live({
        baseUrl: 'https://api.test',
        getToken: () => {
          calls += 1;
          // After the capabilities request, the next thing the store does with the clock fails.
          if (calls === 1)
            vi.spyOn(Date, 'now').mockImplementation(() => {
              throw boom;
            });
          return 'tok';
        },
        fetch: api.fetch,
        onFault: (fault) => faults.push(fault),
      });
      open.push(l);
      const s = await until(l.store, (x) => x.status === 'error');
      expect(s.error).toMatchObject({ kind: 'malformed_response', code: 'internal_error' });
      expect(s.connection).toBe('offline');
      expect(faults).toContain(boom);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('an open detail whose read hit a bug says so instead of loading for ever', async () => {
    const faults: unknown[] = [];
    const api = canned();
    const l = live({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: api.fetch,
      onFault: (fault) => faults.push(fault),
    });
    open.push(l);
    await until(l.store, (x) => x.status === 'ready');
    const boom = new Error('clock bug');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw boom;
    });
    l.store.openDetail('apr_1');
    clock.mockRestore();
    const s = await until(l.store, (x) => x.detail?.status === 'error');
    expect(s.detail).toMatchObject({
      status: 'error',
      error: { kind: 'malformed_response', code: 'internal_error' },
    });
    expect(faults).toContain(boom);
  });
});

describe('c2-11 a session that ends under an unavailable detail leaves it re-readable', () => {
  it('the detail becomes unauthorized, and refresh() reads it again', async () => {
    const api = canned();
    let signedIn = true;
    const l = live({
      baseUrl: 'https://api.test',
      getToken: () =>
        signedIn ? Promise.resolve('tok') : Promise.reject(new AuthError('signed_out')),
      fetch: api.fetch,
    });
    open.push(l);
    await until(l.store, (x) => x.status === 'ready');
    api.read = () => problemResponse(503, 'unavailable');
    l.store.openDetail('apr_1');
    await until(l.store, (x) => x.detail?.status === 'unavailable');
    signedIn = false;
    await l.store.refresh();
    expect(l.snapshot().detail).toMatchObject({ id: 'apr_1', status: 'unauthorized' });
    signedIn = true;
    api.read = (id) => jsonResponse({ data: cannedApproval(id, { arguments: { amount: 1 } }) });
    await l.store.refresh();
    const s = await until(l.store, (x) => x.detail?.status === 'loaded');
    expect(s.detail).toMatchObject({ id: 'apr_1', status: 'loaded' });
  });
});

describe('c2-13 a decided approval is not revived by a list that still holds it', () => {
  it('after a successful decision a later list that lags behind keeps the row out (the resolve-path tombstone)', async () => {
    const api = canned();
    api.resolve = (id) => jsonResponse({ data: cannedApproval(id, { state: 'approved' }) });
    const l = await started(api);
    l.store.openDetail('apr_1');
    await until(l.store, (x) => x.detail?.status === 'loaded');
    expect(await l.store.approve('apr_1')).toMatchObject({ ok: true });
    expect(l.snapshot().approvals.map((a) => a.id)).not.toContain('apr_1');
    // The service's list is behind: it still shows the approval as pending. A new run lists it again.
    await l.store.refresh();
    const s = await until(l.store, (x) => x.status === 'ready');
    expect(api.list.map((r) => r.id)).toContain('apr_1');
    expect(s.approvals.map((a) => a.id)).not.toContain('apr_1');
  });
});
