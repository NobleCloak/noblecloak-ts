import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  call,
  ids,
  inProcessFetch,
  live,
  openApproval,
  recorder,
  renewing,
  startHarness,
  until,
} from './testing/approvals-harness.js';
import type { Harness } from './testing/approvals-harness.js';
import { AuthError } from './auth-types.js';
import { advance, advanceUntil, fakeTime, trackInFlight } from './testing/approvals-fake-time.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

describe('T1 the waiting-on-me list', () => {
  it('shows an approval opened by a user to another user, and not to the user who opened it', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator_user);
    const rec = recorder();
    const approver = live({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.approver,
      fetch: rec.fetch,
    });
    const creator = live({ baseUrl: h.baseUrl, getToken: () => h.tokens.creator_user });
    try {
      const seen = await until(approver.store, (s) => s.status === 'ready');
      expect(ids(seen.approvals)).toContain(opened.id);
      const own = await until(creator.store, (s) => s.status === 'ready');
      expect(ids(own.approvals)).not.toContain(opened.id);
      // Both filters, always: the module never relies on the server's default for either.
      const list = rec.calls.find((c) => c.path === '/v1/approvals');
      expect(new URLSearchParams(list?.query).get('state')).toBe('pending');
      expect(new URLSearchParams(list?.query).get('approver')).toBe('me');
    } finally {
      approver.close();
      creator.close();
    }
  });

  it('sends the scope when one is set', async () => {
    const rec = recorder();
    const l = live({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.approver,
      fetch: rec.fetch,
      scope: 'run_1',
    });
    try {
      await until(l.store, (s) => s.status === 'ready' || s.status === 'error');
      const list = rec.calls.find((c) => c.path === '/v1/approvals');
      expect(new URLSearchParams(list?.query).get('scope')).toBe('run_1');
    } finally {
      l.close();
    }
  });
});

describe('start order and capabilities', () => {
  it('opens the stream before it lists, and reads capabilities first', async () => {
    const rec = recorder();
    const l = live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, fetch: rec.fetch });
    try {
      await until(l.store, (s) => s.status === 'ready' && s.connection === 'live');
      const order = rec.calls.map((c) => c.path);
      expect(order[0]).toBe('/v1/capabilities');
      expect(order.indexOf('/v1/approvals/stream')).toBeGreaterThan(-1);
      expect(order.indexOf('/v1/approvals/stream')).toBeLessThan(order.indexOf('/v1/approvals'));
    } finally {
      l.close();
    }
  });

  it('re-lists on connect and sets no Cache-Control or Last-Event-ID, and no token in a URL', async () => {
    const rec = recorder();
    const seen: Request[] = [];
    rec.intercept((_c, request) => {
      seen.push(request);
      return undefined;
    });
    const l = live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, fetch: rec.fetch });
    try {
      await until(l.store, (s) => s.connection === 'live');
      const stream = seen.find((r) => new URL(r.url).pathname === '/v1/approvals/stream');
      expect(stream?.headers.get('accept')).toBe('text/event-stream');
      expect(stream?.headers.has('cache-control')).toBe(false);
      expect(stream?.headers.has('last-event-id')).toBe(false);
      expect(stream?.headers.get('authorization')).toBe(`Bearer ${h.tokens.approver}`);
      expect(seen.every((r) => !r.url.includes(h.tokens.approver))).toBe(true);
    } finally {
      l.close();
    }
  });
});

describe('T2 the stream', () => {
  it('shows an approval created after start, with no refresh', async () => {
    const l = live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, reconcileMs: 600_000 });
    try {
      await until(l.store, (s) => s.status === 'ready' && s.connection === 'live');
      const opened = await openApproval(h.baseUrl, h.tokens.creator_user);
      const seen = await until(l.store, (s) => ids(s.approvals).includes(opened.id));
      expect(seen.connection).toBe('live');
    } finally {
      l.close();
    }
  });

  it('goes live without AbortSignal.any, and closing the store still ends the stream', async () => {
    vi.stubGlobal('AbortSignal', Object.assign(Object.create(AbortSignal), { any: undefined }));
    const l = live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, reconcileMs: 600_000 });
    try {
      await until(l.store, (s) => s.status === 'ready' && s.connection === 'live');
      l.close();
      expect(l.snapshot().connection).toBe('offline');
    } finally {
      l.close();
      vi.unstubAllGlobals();
    }
  });
});

describe('T9 a 401', () => {
  it('forces one refresh and retries once, with no error', async () => {
    const src = renewing(h.tokens.expired, h.tokens.approver);
    const onExpired = vi.fn();
    const l = live({ baseUrl: h.baseUrl, getToken: src.getToken, onSessionExpired: onExpired });
    try {
      const seen = await until(l.store, (s) => s.status === 'ready');
      expect(seen.error).toBeUndefined();
      expect(src.calls.forced).toBeGreaterThanOrEqual(1);
      expect(onExpired).not.toHaveBeenCalled();
    } finally {
      l.close();
    }
  });

  it('ends the session once when the refresh does not help, and does nothing further', async () => {
    const forced = vi.fn();
    const rec = recorder();
    const onExpired = vi.fn();
    const l = live({
      baseUrl: h.baseUrl,
      getToken: (x) => {
        if (x?.forceRefresh === true) forced();
        return h.tokens.expired;
      },
      fetch: rec.fetch,
      onSessionExpired: onExpired,
    });
    try {
      const seen = await until(l.store, (s) => s.status === 'error');
      expect(seen.error).toMatchObject({ kind: 'unauthorized' });
      expect(seen.connection).toBe('offline');
      expect(onExpired).toHaveBeenCalledTimes(1);
      expect(forced).toHaveBeenCalledTimes(1);
      const sent = rec.calls.length;
      await new Promise((r) => setTimeout(r, 300));
      expect(rec.calls.length).toBe(sent);
      expect(onExpired).toHaveBeenCalledTimes(1);
    } finally {
      l.close();
    }
  });

  it('treats a getToken that throws AuthError as the end of the session, and any other throw as a network failure', async () => {
    const onExpired = vi.fn();
    const signedOut = live({
      baseUrl: h.baseUrl,
      getToken: () => {
        throw new AuthError('signed_out');
      },
      onSessionExpired: onExpired,
    });
    try {
      const seen = await until(signedOut.store, (s) => s.status === 'error');
      expect(seen.error).toMatchObject({ kind: 'unauthorized', code: 'session_expired' });
      expect(onExpired).toHaveBeenCalledTimes(1);
    } finally {
      signedOut.close();
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const broken = live({
      baseUrl: h.baseUrl,
      getToken: () => {
        throw new Error('storage unavailable');
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(broken.snapshot().status).toBe('loading');
      expect(broken.snapshot().error).toMatchObject({ kind: 'network' });
    } finally {
      broken.close();
      vi.useRealTimers();
    }
  });
});

describe('T10 a short-lived token', () => {
  // The token's life and the polls run on fake time against the in-process mock: no real 4.5 s wait.
  beforeEach(() => {
    fakeTime();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps working across its expiry when getToken renews it', async () => {
    let minted = 0;
    let token: { value: string; expiresAt: number } | undefined;
    // Minting signs with `crypto.subtle`, which finishes on the threadpool after an unpredictable number of event-loop
    // turns. Fake time must not move while a mint is pending: the token's `exp` is read from fake time before the
    // signing, so a mint that lags a few fake seconds yields a token that is already expired when the request lands.
    // `trackInFlight` makes the helpers' `settle()` wait for the mint, as it does for the mock's responses.
    const getToken = (): Promise<string> => trackInFlight(renewToken());
    const renewToken = async (): Promise<string> => {
      // A renewing source: a token with 2 seconds to live, replaced once less than a second is left.
      if (token === undefined || token.expiresAt - Date.now() < 1000) {
        minted += 1;
        const exp = Math.floor(Date.now() / 1000) + 2;
        token = {
          value: await h.mock.issuer.mint({
            sub: 'user_short',
            org: 'org_mock',
            aud: h.mock.config.audience,
            exp,
            principal_kind: 'user',
          }),
          expiresAt: exp * 1000,
        };
      }
      return token.value;
    };
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.path === '/v1/approvals/stream'
        ? new Response('{}', {
            status: 404,
            headers: { 'content-type': 'application/problem+json' },
          })
        : undefined
    );
    const l = live({ baseUrl: h.baseUrl, getToken, fetch: rec.fetch, pollMs: 1000 });
    const statuses: string[] = [];
    const off = l.store.subscribe(() => {
      statuses.push(l.snapshot().status);
    });
    try {
      await advanceUntil(() => l.snapshot().status === 'ready');
      // Poll long enough for the first token to have expired.
      await advance(4500);
      // The in-process mock verifies each token on the real clock's thread pool, so on a slow run a poll lands in a
      // later fake step than on a fast one. What the test pins is that the polls go on past the expiry: wait for
      // them rather than count the ones that fit in a fixed span of fake time.
      await advanceUntil(() => minted >= 2 && rec.count('GET', '/v1/approvals') >= 3, 30_000);
      expect(minted).toBeGreaterThanOrEqual(2);
      expect(rec.count('GET', '/v1/approvals')).toBeGreaterThanOrEqual(3);
      expect(statuses).not.toContain('error');
      expect(l.snapshot().status).toBe('ready');
    } finally {
      off();
      l.close();
    }
  });
});

describe('T11 a cut stream', () => {
  it('goes polling, still shows a new approval within pollMs, then goes live with a re-list', async () => {
    const rec = recorder();
    let cut: AbortController | undefined;
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/approvals/stream') return undefined;
      // Serve the stream from the mock but let the test cut it.
      cut = new AbortController();
      const upstream = await fetch(request.url, {
        headers: request.headers,
        signal: cut.signal,
      });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    });
    const l = live({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.approver,
      fetch: rec.fetch,
      pollMs: 1000,
      reconcileMs: 600_000,
    });
    try {
      await until(l.store, (s) => s.connection === 'live');
      const listsBefore = rec.count('GET', '/v1/approvals');
      cut?.abort();
      await until(l.store, (s) => s.connection === 'polling');
      const opened = await openApproval(h.baseUrl, h.tokens.creator_user);
      await until(l.store, (s) => ids(s.approvals).includes(opened.id), 4000);
      await until(l.store, (s) => s.connection === 'live', 8000);
      expect(rec.count('GET', '/v1/approvals')).toBeGreaterThan(listsBefore);
    } finally {
      l.close();
    }
  }, 20_000);
});

describe('T12 no stream', () => {
  it('stays polling with a correct queue when the stream path answers 404', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator_user);
    const rec = recorder();
    rec.intercept((c) =>
      c.path === '/v1/approvals/stream'
        ? new Response(
            JSON.stringify({
              type: 'https://x/problems/not_found',
              title: 'Not found',
              status: 404,
            }),
            { status: 404, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined
    );
    const l = live({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.approver,
      fetch: rec.fetch,
      pollMs: 1000,
    });
    try {
      const seen = await until(l.store, (s) => s.status === 'ready');
      expect(seen.connection).toBe('polling');
      expect(ids(seen.approvals)).toContain(opened.id);
      const later = await openApproval(h.baseUrl, h.tokens.creator_user);
      await until(l.store, (s) => ids(s.approvals).includes(later.id), 4000);
      expect(l.snapshot().connection).toBe('polling');
      // A refused stream is not hammered: one attempt in this window.
      expect(rec.count('GET', '/v1/approvals/stream')).toBe(1);
    } finally {
      l.close();
    }
  }, 15_000);
});

describe('a malformed list', () => {
  it('is an error and never an empty queue', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator_user);
    const rec = recorder();
    let bad = false;
    rec.intercept((c) =>
      bad && c.method === 'GET' && c.path === '/v1/approvals'
        ? new Response('{"data": "nope"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : undefined
    );
    const l = live({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.approver,
      fetch: rec.fetch,
      pollMs: 1000,
    });
    try {
      await until(l.store, (s) => ids(s.approvals).includes(opened.id));
      bad = true;
      const seen = await until(l.store, (s) => s.status === 'error', 4000);
      expect(seen.error).toMatchObject({ kind: 'malformed_response' });
      expect(ids(seen.approvals)).toContain(opened.id);
    } finally {
      l.close();
    }
  }, 10_000);

  it('is an error when the body is not JSON at all', async () => {
    const rec = recorder();
    rec.intercept((c) =>
      c.method === 'GET' && c.path === '/v1/approvals'
        ? new Response('<html>', { status: 200 })
        : undefined
    );
    const l = live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, fetch: rec.fetch });
    try {
      const seen = await until(l.store, (s) => s.status === 'error');
      expect(seen.error).toMatchObject({ kind: 'malformed_response' });
      expect(seen.approvals).toEqual([]);
    } finally {
      l.close();
    }
  });
});

describe('T8 a service principal', () => {
  it('lists nothing (the hook always sends approver=me)', async () => {
    await openApproval(h.baseUrl, h.tokens.creator);
    const l = live({ baseUrl: h.baseUrl, getToken: () => h.tokens.creator });
    try {
      const seen = await until(l.store, (s) => s.status === 'ready');
      expect(seen.approvals).toEqual([]);
    } finally {
      l.close();
    }
  });
});

describe('the lifecycle of a store', () => {
  it('starts nothing until it is subscribed, and a stopped store holds no connection', async () => {
    const rec = recorder();
    const store = (await import('./approvals-store.js')).createApprovalsStore({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.approver,
      fetch: rec.fetch,
    });
    expect(store.getSnapshot()).toMatchObject({ status: 'loading', connection: 'connecting' });
    await new Promise((r) => setTimeout(r, 50));
    expect(rec.calls).toEqual([]);
    const off = store.subscribe(() => undefined);
    await until(store, (s) => s.status === 'ready');
    off();
    expect(store.getSnapshot().connection).toBe('offline');
    const sent = rec.calls.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(rec.calls.length).toBe(sent);
    // A second subscription starts again from the capabilities.
    const again = store.subscribe(() => undefined);
    await until(store, (s) => s.status === 'ready');
    again();
    store.dispose();
    store.dispose();
    expect(store.subscribe(() => undefined)).toBeTypeOf('function');
    expect(store.getSnapshot().connection).toBe('offline');
  });

  it('does nothing when it is not enabled', async () => {
    const rec = recorder();
    const { createApprovalsStore } = await import('./approvals-store.js');
    const store = createApprovalsStore({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.approver,
      fetch: rec.fetch,
      enabled: false,
    });
    expect(store.getSnapshot()).toBe(store.getServerSnapshot());
    const off = store.subscribe(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getSnapshot()).toMatchObject({ status: 'idle', connection: 'offline' });
    expect(rec.calls).toEqual([]);
    store.openDetail('x');
    await store.refresh();
    expect(rec.calls).toEqual([]);
    off();
  });

  it('offers the constant server snapshot: idle, no approvals, offline', async () => {
    const { createApprovalsStore } = await import('./approvals-store.js');
    const store = createApprovalsStore({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver });
    expect(store.getServerSnapshot()).toMatchObject({
      status: 'idle',
      approvals: [],
      connection: 'offline',
    });
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
  });

  it('reads another organisation as an empty queue, not an error', async () => {
    const l = live({ baseUrl: h.baseUrl, getToken: () => h.tokens.other_org });
    try {
      const seen = await until(l.store, (s) => s.status === 'ready');
      expect(seen.approvals).toEqual([]);
    } finally {
      l.close();
    }
  });
});

describe('the mock stays reachable while the suite runs', () => {
  it('answers a plain request', async () => {
    const response = await call(h.baseUrl, h.tokens.approver, 'GET', '/v1/capabilities');
    expect(response.status).toBe(200);
  });
});
