// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthError } from '../auth-types.js';
import type { AuthState, RefreshTokenStore } from '../auth-types.js';
import {
  arriveAt,
  clock,
  completeFlow,
  harness,
  must,
  newStub,
  now,
} from '../testing/auth-harness.js';
import type { Harness } from '../testing/auth-harness.js';
import { urlOf } from '../testing/auth-stub.js';
import { createBrowserAuthWith } from './browser-auth.js';
import { PENDING_MAX_AGE_MS } from './pending.js';
import { codeChallengeS256 } from './pkce.js';
import { memoryRefreshStore } from './stores.js';

const MESSAGE_ENDED = 'Your session ended. Sign in again.';
const MESSAGE_TWO_TABS =
  'Your session ended. This can happen if the page was opened in two tabs. Sign in again.';

beforeEach(() => {
  clock.now = 1_000_000;
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const pendingKeys = (): string[] =>
  Object.keys(sessionStorage).filter((key) => key.startsWith('nc.auth.pending.'));

const signedInToken = async (h: Harness): Promise<string> => {
  await completeFlow(h);
  return h.auth.getToken();
};

const errorOf = (state: AuthState): AuthError => {
  if (state.status !== 'error') throw new Error(`expected error, got ${state.status}`);
  return state.error;
};

describe('T20-A1 authorization code with PKCE S256, no secret, no implicit flow', () => {
  it('T20-A1: the authorize URL and the token body are the PKCE code flow', async () => {
    const h = harness();
    await h.auth.signIn();
    const url = new URL(must(h.navigations[0]));
    expect(url.origin + url.pathname).toBe(h.stub.authorizationEndpoint);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_id')).toBe(h.stub.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(h.stub.redirectUri);
    // The challenge is the SHA-256 of the 32-random-byte verifier kept for the callback.
    const record = JSON.parse(
      must(sessionStorage.getItem(`nc.auth.pending.${must(url.searchParams.get('state'))}`))
    ) as { verifier: string };
    expect(record.verifier).toHaveLength(43);
    expect(url.searchParams.get('code_challenge')).toBe(await codeChallengeS256(record.verifier));

    arriveAt(h.stub.authorize(must(h.navigations[0])));
    await h.auth.completeSignIn();
    const exchange = must(h.stub.requestsTo('/token')[0]).body;
    expect([...must(exchange).keys()].sort()).toEqual([
      'client_id',
      'code',
      'code_verifier',
      'grant_type',
      'redirect_uri',
    ]);
    expect(exchange?.get('grant_type')).toBe('authorization_code');
    expect(exchange?.get('code_verifier')).toBe(record.verifier);
    await h.auth.getToken({ forceRefresh: true });
    for (const request of h.stub.requests) {
      expect(['authorization_code', 'refresh_token', undefined]).toContain(
        request.body?.get('grant_type') ?? undefined
      );
      expect(request.body?.has('client_secret') ?? false).toBe(false);
    }
  });
});

describe('T20-A2 exact redirect-URI matching', () => {
  it('T20-A2: a callback on another path is refused and no token request is made', async () => {
    const h = harness();
    await h.auth.signIn();
    const callback = new URL(h.stub.authorize(must(h.navigations[0])));
    window.history.replaceState(null, '', `/elsewhere${callback.search}`);
    await h.auth.completeSignIn();
    expect(errorOf(h.auth.getSnapshot()).code).toBe('redirect_uri_mismatch');
    expect(h.stub.requestsTo('/token')).toHaveLength(0);
  });
});

describe('T20-A3 state generated and checked', () => {
  it('T20-A3: a wrong, a missing and a replayed state are errors with no token request', async () => {
    const wrong = harness();
    await wrong.auth.signIn();
    const callback = new URL(wrong.stub.authorize(must(wrong.navigations[0])));
    arriveAt(`${callback.origin}${callback.pathname}?code=x&state=not-the-state`);
    await wrong.auth.completeSignIn();
    expect(errorOf(wrong.auth.getSnapshot()).code).toBe('no_pending_request');
    expect(wrong.stub.requestsTo('/token')).toHaveLength(0);

    const missing = harness();
    await missing.auth.signIn();
    arriveAt(`${callback.origin}${callback.pathname}?code=x`);
    await missing.auth.completeSignIn();
    expect(errorOf(missing.auth.getSnapshot()).code).toBe('state_mismatch');
    expect(missing.stub.requestsTo('/token')).toHaveLength(0);

    // Replay: the same callback delivered to a second instance after the first used the state.
    const first = harness();
    await first.auth.signIn();
    const replayUrl = first.stub.authorize(must(first.navigations[0]));
    arriveAt(replayUrl);
    await first.auth.completeSignIn();
    expect(first.auth.getSnapshot().status).toBe('signed_in');
    const second = harness({ stub: first.stub });
    arriveAt(replayUrl);
    await second.auth.completeSignIn();
    expect(errorOf(second.auth.getSnapshot()).code).toBe('no_pending_request');
    expect(first.stub.requestsTo('/token')).toHaveLength(1);
  });

  it('T20-A3: every sign-in draws a fresh state', async () => {
    const h = harness();
    await h.auth.signIn();
    await h.auth.signIn();
    const states = h.navigations.map((url) => new URL(url).searchParams.get('state'));
    expect(states[0]).not.toBe(states[1]);
    expect(must(states[0]).length).toBeGreaterThanOrEqual(22);
  });
});

describe('T20-A4 resource is always sent and exact', () => {
  it('T20-A4: resource is on every authorize request', async () => {
    const h = harness();
    await h.auth.signIn();
    await h.auth.signIn('/inbox');
    for (const url of h.navigations) {
      expect(new URL(url).searchParams.get('resource')).toBe(h.stub.resource);
    }
  });

  const options = (overrides: Record<string, string>) => ({
    issuer: 'https://auth.example.test',
    clientId: 'bnoauth_REPLACE_ME',
    redirectUri: 'http://localhost:3000/approvals/callback',
    resource: 'https://govern.example.test',
    fetch: newStub().fetch,
    ...overrides,
  });
  const codeOf = (build: () => unknown): string | undefined => {
    try {
      build();
    } catch (error) {
      return error instanceof AuthError ? error.code : 'not-an-AuthError';
    }
    return undefined;
  };

  it('T20-A4: createBrowserAuth throws at construction for a resource that is not an origin', () => {
    for (const resource of [
      'https://govern.example.test/',
      'https://govern.example.test/api',
      'https://govern.example.test?x=1',
      'http://govern.example.test',
      'govern.example.test',
      'ftp://govern.example.test',
    ]) {
      expect(codeOf(() => createBrowserAuthWith(options({ resource })))).toBe('invalid_target');
    }
    expect(
      codeOf(() => createBrowserAuthWith(options({ resource: 'http://localhost:4000' })))
    ).toBe(undefined);
    expect(
      codeOf(() => createBrowserAuthWith(options({ resource: 'https://govern.example.test' })))
    ).toBe(undefined);
  });

  it('M3-RESOURCE-MSG-IMPRECISE: the resource error names the actual problem and the value', () => {
    const messageOf = (resource: string): string => {
      try {
        createBrowserAuthWith(options({ resource }));
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
      return '';
    };
    expect(messageOf('http://govern.example.test')).toMatch(/https/);
    expect(messageOf('http://govern.example.test')).toContain('http://govern.example.test');
    expect(messageOf('https://govern.example.test/api')).toMatch(/no path/);
    expect(messageOf('govern.example.test')).toMatch(/absolute URL/);
    expect(messageOf('http://govern.example.test')).not.toMatch(/no path/);
  });

  it('M3-ISSUER-UNVALIDATED: createBrowserAuth throws at construction for an issuer that is not an https (or localhost) URL', () => {
    for (const issuer of ['not a url', '', 'http://auth.example.test', 'ftp://auth.example.test']) {
      expect(codeOf(() => createBrowserAuthWith(options({ issuer })))).toBe('server_error');
    }
    for (const issuer of [
      'https://auth.example.test',
      'https://auth.example.test/tenant',
      'http://localhost:9000',
    ]) {
      expect(codeOf(() => createBrowserAuthWith(options({ issuer })))).toBe(undefined);
    }
  });

  it('T20-A4: createBrowserAuth throws at construction for a redirect URI that is not exact or not on this origin', () => {
    for (const redirectUri of [
      '/approvals/callback',
      'http://localhost:3001/approvals/callback',
      'https://app.example.test/approvals/callback',
      'http://localhost:3000/approvals/callback#x',
      'http://localhost:3000/approvals/callback?x=1',
      'http://localhost:3000/*',
    ]) {
      expect(codeOf(() => createBrowserAuthWith(options({ redirectUri })))).toBe(
        'redirect_uri_mismatch'
      );
    }
  });
});

describe('T20-A5 fewest scopes that work', () => {
  it('T20-A5: the authorize request asks for approvals:resolve and nothing else by default (rev 8)', async () => {
    const h = harness();
    await h.auth.signIn();
    expect(new URL(must(h.navigations[0])).searchParams.getAll('scope')).toEqual([
      'approvals:resolve',
    ]);
  });

  it('T20-A5: a host-given scope replaces the default, and an empty one sends no scope parameter', async () => {
    const given = harness({ scope: 'approvals:resolve offline_access' });
    await given.auth.signIn();
    expect(new URL(must(given.navigations[0])).searchParams.getAll('scope')).toEqual([
      'approvals:resolve offline_access',
    ]);
    const none = harness({ scope: '' });
    await none.auth.signIn();
    expect(new URL(must(none.navigations[0])).searchParams.has('scope')).toBe(false);
  });

  it('T20-A5: a scope that is not space-separated scope tokens is refused at construction', () => {
    for (const scope of [' a', 'a ', 'a  b', 'a"b', 'a\\b', 'a\tb', 'é']) {
      let code: string | undefined;
      try {
        createBrowserAuthWith({
          issuer: 'https://auth.example.test',
          clientId: 'bnoauth_REPLACE_ME',
          redirectUri: 'http://localhost:3000/approvals/callback',
          resource: 'https://govern.example.test',
          scope,
        });
      } catch (error) {
        code = error instanceof AuthError ? error.code : undefined;
      }
      expect(code, JSON.stringify(scope)).toBe('invalid_scope');
    }
  });
});

describe('T20-A6 the access token is in memory only; the refresh token only in the tab-scoped store', () => {
  it('T20-A6: no storage, cookie or URL ever holds the access token; sessionStorage holds the refresh token under its key', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const cookieWrites: string[] = [];
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => '',
      set: (value: string) => {
        cookieWrites.push(value);
      },
    });
    const replaceState = vi.spyOn(window.history, 'replaceState');
    try {
      const h = harness({ useDefaultStore: true });
      const token = await signedInToken(h);
      const rotated = await h.auth.getToken({ forceRefresh: true });
      const refreshKey = `nc.auth.refresh.${h.stub.clientId}`;
      const refreshToken = must(sessionStorage.getItem(refreshKey));
      for (const [index, call] of setItem.mock.calls.entries()) {
        const [key, value] = call;
        expect(setItem.mock.contexts[index]).toBe(sessionStorage);
        expect(key.startsWith('nc.auth.pending.') || key === refreshKey).toBe(true);
        expect(value).not.toContain(token);
        expect(value).not.toContain(rotated);
      }
      expect(localStorage.length).toBe(0);
      expect(cookieWrites).toEqual([]);
      const refreshKeys = Object.keys(sessionStorage).filter((key) => key === refreshKey);
      expect(refreshKeys).toEqual([refreshKey]);
      const everywhere = [
        ...Object.keys(sessionStorage)
          .filter((key) => key !== refreshKey)
          .map((key) => String(sessionStorage.getItem(key))),
        ...h.navigations,
        window.location.href,
        ...replaceState.mock.calls.map((call) => String(call[2])),
      ].join('\n');
      expect(everywhere).not.toContain(token);
      expect(everywhere).not.toContain(rotated);
      expect(everywhere).not.toContain(refreshToken);
      expect(
        Object.keys(sessionStorage).filter((key) => key.startsWith('nc.auth.refresh.'))
      ).toEqual([refreshKey]);
    } finally {
      Reflect.deleteProperty(document, 'cookie');
    }
  });

  it('T20-A6: a store the host supplies is the only place the refresh token goes', async () => {
    const h = harness();
    await completeFlow(h);
    expect(must(h.store.get())).toMatch(/^rt-/);
    expect(Object.keys(sessionStorage).filter((key) => key.startsWith('nc.auth.refresh.'))).toEqual(
      []
    );
  });
});

describe('T20-A7 refresh rotation, single flight and no retry', () => {
  it('T20-A7: two instances over one server with separate stores are independent', async () => {
    const stub = newStub();
    const a = harness({ stub });
    const b = harness({ stub });
    await completeFlow(a);
    await completeFlow(b);
    expect(a.store.get()).not.toBe(b.store.get());
    await a.auth.getToken({ forceRefresh: true });
    await b.auth.getToken({ forceRefresh: true });
    expect(a.auth.getSnapshot().status).toBe('signed_in');
    expect(b.auth.getSnapshot().status).toBe('signed_in');
  });

  it('T20-A7: five concurrent getToken calls share one refresh', async () => {
    const h = harness();
    await completeFlow(h);
    const before = h.stub.requestsTo('/token').length;
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => h.auth.getToken({ forceRefresh: true }))
    );
    expect(new Set(tokens).size).toBe(1);
    expect(h.stub.requestsTo('/token').length - before).toBe(1);
  });

  it('T20-A7: a cached token is returned until shortly before it expires, then renewed', async () => {
    const h = harness();
    const first = await signedInToken(h);
    clock.now += 800_000;
    expect(await h.auth.getToken()).toBe(first);
    expect(h.stub.requestsTo('/token')).toHaveLength(1);
    clock.now += 80_000;
    expect(await h.auth.getToken()).not.toBe(first);
    expect(h.stub.requestsTo('/token')).toHaveLength(2);
  });

  it('T20-A7: each rotation is stored before the new access token is used', async () => {
    const h = harness();
    const seen: (string | null)[] = [];
    h.auth.subscribe(() => {
      seen.push(h.store.get());
    });
    await completeFlow(h);
    expect(seen.at(-1)).toMatch(/^rt-/);
    const before = h.store.get();
    const token = await h.auth.getToken({ forceRefresh: true });
    expect(token).toMatch(/^at-/);
    expect(h.store.get()).not.toBe(before);
    expect(h.stub.isRevoked(must(h.store.get()))).toBe(false);
  });

  it('T20-A7: a refresh whose response was lost is not retried; the state is signed_out', async () => {
    const h = harness();
    await completeFlow(h);
    h.stub.loseNextRefreshResponse();
    await expect(h.auth.getToken({ forceRefresh: true })).rejects.toMatchObject({
      code: 'network',
    });
    const requests = h.stub.requestsTo('/token').length;
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_out', message: MESSAGE_ENDED });
    expect(h.store.get()).toBeNull();
    await expect(h.auth.getToken()).rejects.toMatchObject({ code: 'signed_out' });
    await h.auth.restore();
    expect(h.stub.requestsTo('/token')).toHaveLength(requests);
  });

  it('T20-A7: a refresh the server refuses with a 500 ends the session without a retry', async () => {
    const h = harness();
    await completeFlow(h);
    h.stub.failNextToken(500, { error: 'server_error' });
    await expect(h.auth.getToken({ forceRefresh: true })).rejects.toMatchObject({
      code: 'server_error',
    });
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_out', message: MESSAGE_ENDED });
    expect(h.stub.requestsTo('/token')).toHaveLength(2);
  });

  it('T20-A7: a sign-out during a refresh drops its answer and writes no token', async () => {
    const stub = newStub();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    const slow = harness({
      stub,
      fetch: async (input, init) => {
        if (hold && urlOf(input).endsWith('/token')) await gate;
        return stub.fetch(input, init);
      },
    });
    await completeFlow(slow);
    hold = true;
    const pendingRefresh = slow.auth.getToken({ forceRefresh: true });
    const outcome = expect(pendingRefresh).rejects.toMatchObject({ code: 'signed_out' });
    await slow.auth.signOut();
    release();
    await outcome;
    expect(slow.store.get()).toBeNull();
    expect(slow.auth.getSnapshot()).toEqual({ status: 'signed_out' });
  });

  it('c1-5: a sign-in started during a refresh does not drop the rotated token', async () => {
    const stub = newStub();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    const h = harness({
      stub,
      fetch: async (input, init) => {
        if (hold && urlOf(input).endsWith('/token')) await gate;
        return stub.fetch(input, init);
      },
    });
    await completeFlow(h);
    const first = must(h.store.get());
    hold = true;
    const pendingRefresh = h.auth.getToken({ forceRefresh: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.auth.signIn();
    release();
    const token = await pendingRefresh;
    const rotated = must(h.store.get());
    expect(rotated).not.toBe(first);
    expect(token).toMatch(/^at-/);
    // The rotated token is the live one: the next refresh presents it and is accepted.
    hold = false;
    await expect(h.auth.getToken({ forceRefresh: true })).resolves.toMatch(/^at-/);
    expect(stub.isRevoked(rotated)).toBe(false);
  });

  it('c1-8 a refresh response with no new refresh_token keeps the stored one', async () => {
    const stub = newStub();
    let strip = false;
    const h = harness({
      stub,
      fetch: async (input, init) => {
        const response = await stub.fetch(input, init);
        if (!strip || !urlOf(input).endsWith('/token')) return response;
        const body = (await response.json()) as Record<string, unknown>;
        delete body.refresh_token;
        return Response.json(body);
      },
    });
    await completeFlow(h);
    const first = must(h.store.get());
    strip = true;
    await expect(h.auth.getToken({ forceRefresh: true })).resolves.toMatch(/^at-/);
    expect(h.store.get()).toBe(first);
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_in' });
  });

  it('c1-11 a metadata failure during a refresh is metadata_unavailable and keeps the stored token', async () => {
    const stub = newStub();
    const store = memoryRefreshStore();
    store.set('rt-from-an-earlier-page');
    const h = harness({ stub, store });
    stub.setMetadataStatus(503);
    const restoring = h.auth.restore();
    // The host's data layer asks for a token while the restore's refresh is in flight.
    await expect(h.auth.getToken()).rejects.toMatchObject({ code: 'metadata_unavailable' });
    await restoring;
    expect(store.get()).toBe('rt-from-an-earlier-page');
    expect(stub.requestsTo('/token')).toEqual([]);
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'signed_out' });
  });

  it('T20-A7: a missing refresh token ends the session when a token is needed', async () => {
    const h = harness();
    h.stub.failNextToken(200, { access_token: 'at-only', expires_in: 60 });
    await completeFlow(h);
    expect(await h.auth.getToken()).toBe('at-only');
    expect(h.store.get()).toBeNull();
    clock.now += 61_000;
    await expect(h.auth.getToken()).rejects.toMatchObject({ code: 'signed_out' });
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_out', message: MESSAGE_ENDED });
  });
});

describe('T30 a duplicated tab', () => {
  it('T30: two instances sharing one refresh token end signed_out with the message, storage cleared, no loop', async () => {
    const stub = newStub();
    const first = harness({ stub });
    await completeFlow(first);
    // The duplicated tab copied sessionStorage: it holds the same refresh token.
    const copy = memoryRefreshStore();
    copy.set(must(first.store.get()));
    const second = harness({ stub, store: copy });

    await first.auth.getToken({ forceRefresh: true });
    const afterFirst = stub.requestsTo('/token').length;

    await second.auth.restore();
    expect(second.auth.getSnapshot()).toEqual({ status: 'signed_out', message: MESSAGE_TWO_TABS });
    expect(copy.get()).toBeNull();
    expect(stub.requestsTo('/token').length - afterFirst).toBe(1);
    await second.auth.restore();
    await expect(second.auth.getToken()).rejects.toMatchObject({ code: 'signed_out' });
    expect(stub.requestsTo('/token').length - afterFirst).toBe(1);

    // The family is revoked, so the first tab ends the same way at its next refresh, once.
    const beforeNext = stub.requestsTo('/token').length;
    await expect(first.auth.getToken({ forceRefresh: true })).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(first.auth.getSnapshot()).toEqual({ status: 'signed_out', message: MESSAGE_TWO_TABS });
    expect(first.store.get()).toBeNull();
    await expect(first.auth.getToken()).rejects.toMatchObject({ code: 'signed_out' });
    expect(stub.requestsTo('/token').length - beforeNext).toBe(1);
  });
});

describe('T20-A8 the code leaves the URL before the token request', () => {
  it('T20-A8: the address bar is clean when the token request is made, and after', async () => {
    const stub = newStub();
    const seen: { search: string; href: string }[] = [];
    const h = harness({
      stub,
      fetch: (input, init) => {
        if (urlOf(input).endsWith('/token')) {
          seen.push({ search: window.location.search, href: window.location.href });
        }
        return stub.fetch(input, init);
      },
    });
    await h.auth.signIn();
    arriveAt(stub.authorize(must(h.navigations[0])));
    expect(window.location.search).toContain('code=');
    await h.auth.completeSignIn();
    expect(seen).toEqual([{ search: '', href: 'http://localhost:3000/approvals/callback' }]);
    expect(window.location.search).toBe('');
  });
});

describe('T20-A9 returnTo is limited to same-origin paths', () => {
  it.each(['//evil.test', 'https://evil.test', 'javascript:alert(1)', '/\\evil', '/a\nb', 'plain'])(
    'T20-A9: %j becomes /',
    async (bad) => {
      const h = harness();
      await completeFlow(h, 'approve', bad);
      expect(h.auth.getSnapshot()).toEqual({ status: 'signed_in', returnTo: '/' });
    }
  );

  it('T20-A9: a same-origin path is kept, and none given leaves returnTo out', async () => {
    const kept = harness();
    await completeFlow(kept, 'approve', '/approvals?tab=open#top');
    expect(kept.auth.getSnapshot()).toEqual({
      status: 'signed_in',
      returnTo: '/approvals?tab=open#top',
    });
    const none = harness();
    await completeFlow(none);
    expect(none.auth.getSnapshot()).toEqual({ status: 'signed_in' });
  });

  it('T20-A9: it is validated again when read back from the pending record', async () => {
    const h = harness();
    await h.auth.signIn('/fine');
    const key = must(pendingKeys()[0]);
    const record = JSON.parse(must(sessionStorage.getItem(key))) as Record<string, unknown>;
    sessionStorage.setItem(key, JSON.stringify({ ...record, returnTo: '//evil.test' }));
    arriveAt(h.stub.authorize(must(h.navigations[0])));
    await h.auth.completeSignIn();
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_in', returnTo: '/' });
  });
});

describe('T20-A10 sign-out drops every token and says what it does not end', () => {
  it('T20-A10: the refresh token is revoked, memory and storage are cleared, and getToken throws signed_out', async () => {
    const h = harness({ useDefaultStore: true });
    await completeFlow(h);
    const refreshToken = must(sessionStorage.getItem(`nc.auth.refresh.${h.stub.clientId}`));
    await h.auth.signIn();
    expect(pendingKeys()).toHaveLength(1);
    await h.auth.signOut();
    const revoke = must(h.stub.requestsTo('/revoke')[0]);
    expect(revoke.method).toBe('POST');
    expect(revoke.body?.get('token')).toBe(refreshToken);
    expect(revoke.body?.get('token_type_hint')).toBe('refresh_token');
    expect(h.stub.isRevoked(refreshToken)).toBe(true);
    expect(sessionStorage.getItem(`nc.auth.refresh.${h.stub.clientId}`)).toBeNull();
    expect(pendingKeys()).toEqual([]);
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_out' });
    await expect(h.auth.getToken()).rejects.toMatchObject({ code: 'signed_out' });
  });

  it('T20-A10: sign-out completes locally when revocation fails or the service is down', async () => {
    const stub = newStub();
    let down = false;
    const h = harness({
      stub,
      fetch: (input, init) => {
        if (down) return Promise.reject(new TypeError('Failed to fetch'));
        return stub.fetch(input, init);
      },
    });
    await completeFlow(h);
    down = true;
    await h.auth.signOut();
    expect(h.store.get()).toBeNull();
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_out' });
  });

  it('T20-A10: signing out with no session makes no request', async () => {
    const h = harness();
    await h.auth.signOut();
    expect(h.stub.requests).toHaveLength(0);
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_out' });
  });
});

describe('T20-A12 / T20-A13 credential-free CORS and only the headers the module needs', () => {
  it('T20-A12: every request, metadata, authorization code, refresh and revoke, is credentials omit and mode cors', async () => {
    const h = harness();
    await completeFlow(h);
    await h.auth.getToken({ forceRefresh: true });
    await h.auth.signOut();
    const paths = new Set(h.stub.requests.map((request) => new URL(request.url).pathname));
    expect(paths).toEqual(
      new Set(['/.well-known/oauth-authorization-server', '/token', '/revoke'])
    );
    for (const request of h.stub.requests) {
      expect(request.credentials).toBe('omit');
      expect(request.mode).toBe('cors');
    }
  });

  it('T20-A13: the request headers are within Authorization, Accept and Content-Type', async () => {
    const h = harness();
    await completeFlow(h);
    await h.auth.getToken({ forceRefresh: true });
    await h.auth.signOut();
    const allowed = new Set(['authorization', 'accept', 'content-type']);
    for (const request of h.stub.requests) {
      for (const name of Object.keys(request.headers)) expect(allowed.has(name)).toBe(true);
    }
    expect(h.stub.requests.length).toBeGreaterThan(3);
  });
});

describe('T20-A15 a reload keeps the session; nothing is revoked on pagehide', () => {
  it('T20-A15: restore from a stored refresh token signs in with one refresh and no navigation', async () => {
    const stub = newStub();
    const store = memoryRefreshStore();
    const first = harness({ stub, store });
    await completeFlow(first);
    // A reload: a new auth object over the same tab-scoped store.
    const reloaded = harness({ stub, store });
    const states: string[] = [];
    reloaded.auth.subscribe(() => states.push(reloaded.auth.getSnapshot().status));
    await reloaded.auth.restore();
    expect(reloaded.auth.getSnapshot()).toEqual({ status: 'signed_in' });
    expect(states).toEqual(['completing', 'signed_in']);
    expect(reloaded.navigations).toEqual([]);
    expect(stub.requestsTo('/token').at(-1)?.body?.get('grant_type')).toBe('refresh_token');
    expect(await reloaded.auth.getToken()).toMatch(/^at-/);
    expect(stub.requestsTo('/token')).toHaveLength(2);
  });

  it('T20-A15: restore is single-flight and does nothing without a stored token or when already signed in', async () => {
    const stub = newStub();
    const none = harness({ stub });
    await none.auth.restore();
    expect(stub.requests).toHaveLength(0);
    expect(none.auth.getSnapshot()).toEqual({ status: 'signed_out' });

    const store = memoryRefreshStore();
    await completeFlow(harness({ stub, store }));
    const h = harness({ stub, store });
    await Promise.all([h.auth.restore(), h.auth.restore()]);
    expect(stub.requestsTo('/token')).toHaveLength(2);
    await h.auth.restore();
    expect(stub.requestsTo('/token')).toHaveLength(2);
  });

  it('T20-A15: a pagehide event sends no request', async () => {
    const h = harness();
    await completeFlow(h);
    const before = h.stub.requests.length;
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    expect(h.stub.requests).toHaveLength(before);
    expect(h.auth.getSnapshot().status).toBe('signed_in');
  });

  it('T20-A15: a failed restore ends signed_out with the stored token gone', async () => {
    const stub = newStub();
    const store = memoryRefreshStore();
    store.set('rt-never-issued');
    const h = harness({ stub, store });
    await h.auth.restore();
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_out', message: MESSAGE_TWO_TABS });
    expect(store.get()).toBeNull();
  });

  it('ADV-5: a restore against metadata that names another issuer shows that error and keeps the token', async () => {
    const stub = newStub();
    const store = memoryRefreshStore();
    store.set('rt-kept');
    const h = harness({
      stub,
      store,
      fetch: async (input, init) => {
        const response = await stub.fetch(input, init);
        if (!urlOf(input).includes('/.well-known/')) return response;
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...body, issuer: 'https://other.example.test' });
      },
    });
    await h.auth.restore();
    expect(errorOf(h.auth.getSnapshot()).message).toMatch(/different issuer/);
    expect(store.get()).toBe('rt-kept');
    expect(stub.requestsTo('/token')).toHaveLength(0);
  });

  it('T20-A15: a restore that cannot reach the service keeps the stored token and ends signed_out', async () => {
    const stub = newStub();
    stub.setMetadataStatus(503);
    const store = memoryRefreshStore();
    store.set('rt-kept');
    const h = harness({ stub, store });
    await h.auth.restore();
    const snapshot = h.auth.getSnapshot();
    expect(snapshot.status).toBe('signed_out');
    // The session did not end, so the message must not say it did.
    expect(snapshot.status === 'signed_out' ? snapshot.message : undefined).toMatch(/reload/i);
    expect(snapshot).not.toEqual({ status: 'signed_out', message: MESSAGE_ENDED });
    expect(store.get()).toBe('rt-kept');
    expect(stub.requestsTo('/token')).toHaveLength(0);
  });
});

describe('T20-A16 a denied or failed consent never loops (state machine)', () => {
  it('T20-A16: error=access_denied with the original state is denied, with no token request, no navigation and a clean URL', async () => {
    const h = harness();
    await h.auth.signIn();
    expect(h.auth.getSnapshot()).toEqual({ status: 'redirecting' });
    arriveAt(h.stub.authorize(must(h.navigations[0]), 'deny'));
    expect(window.location.search).toContain('error=access_denied');
    const changes: string[] = [];
    h.auth.subscribe(() => changes.push(h.auth.getSnapshot().status));
    await h.auth.completeSignIn();
    expect(h.auth.getSnapshot()).toEqual({ status: 'denied' });
    expect(window.location.search).toBe('');
    expect(h.stub.requestsTo('/token')).toHaveLength(0);
    expect(h.navigations).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(changes).toEqual(['completing', 'denied']);
    expect(h.navigations).toHaveLength(1);
    // Trying again is the host's explicit call, and starts a new request.
    await h.auth.signIn();
    expect(h.navigations).toHaveLength(2);
  });

  it('T20-A16: another error is an error state; invalid_target says the deployment is not configured', async () => {
    const h = harness();
    await h.auth.signIn();
    const callback = new URL(h.stub.authorize(must(h.navigations[0])));
    const state = must(callback.searchParams.get('state'));
    arriveAt(`${callback.origin}${callback.pathname}?error=invalid_target&state=${state}`);
    await h.auth.completeSignIn();
    const error = errorOf(h.auth.getSnapshot());
    expect(error.code).toBe('invalid_target');
    expect(error.message).toBe(
      'the sign-in service does not accept this API as a target; the deployment is not configured for it'
    );

    const other = harness();
    await other.auth.signIn();
    const second = new URL(other.stub.authorize(must(other.navigations[0])));
    arriveAt(
      `${second.origin}${second.pathname}?error=temporarily_unavailable&state=${must(second.searchParams.get('state'))}`
    );
    await other.auth.completeSignIn();
    expect(errorOf(other.auth.getSnapshot()).code).toBe('server_error');
    expect(h.stub.requestsTo('/token')).toHaveLength(0);
    expect(other.stub.requestsTo('/token')).toHaveLength(0);
  });

  it('T20-A16: a sign-in is never started by mounting, constructing, restoring or a failure', async () => {
    const h = harness();
    await h.auth.restore();
    await h.auth.completeSignIn();
    expect(h.navigations).toEqual([]);
    expect(h.stub.requestsTo('/authorize')).toHaveLength(0);
  });
});

describe('T20-A17 the sign-in exits are complete', () => {
  it('T20-A17: a page restored from the back/forward cache while redirecting is signed out, with the pending record gone', async () => {
    const h = harness();
    await h.auth.signIn();
    expect(pendingKeys()).toHaveLength(1);
    window.dispatchEvent(new Event('pageshow'));
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_out' });
    expect(pendingKeys()).toEqual([]);
  });

  it('ADV-6: signIn from signed_in then a back/forward-cache return is signed_in again, not signed_out with a live token', async () => {
    const h = harness();
    await completeFlow(h);
    await h.auth.signIn();
    expect(h.auth.getSnapshot()).toEqual({ status: 'redirecting' });
    window.dispatchEvent(new Event('pageshow'));
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_in' });
    await expect(h.auth.getToken()).resolves.toEqual(expect.any(String));
    expect(h.store.get()).not.toBeNull();
  });

  it('T20-A17: pageshow without persistence or in another state changes nothing', async () => {
    const h = harness();
    await h.auth.signIn();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(h.auth.getSnapshot()).toEqual({ status: 'redirecting' });
    await h.auth.signOut();
    await h.auth.signIn();
    arriveAt(h.stub.authorize(must(h.navigations.at(-1))));
    await h.auth.completeSignIn();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(h.auth.getSnapshot().status).toBe('signed_in');
  });

  it('T20-A17: a token endpoint 400 invalid_grant is an error and the exchange is not repeated', async () => {
    const h = harness();
    await h.auth.signIn();
    arriveAt(h.stub.authorize(must(h.navigations[0])));
    h.stub.failNextToken(400, { error: 'invalid_grant' });
    await h.auth.completeSignIn();
    expect(errorOf(h.auth.getSnapshot()).code).toBe('invalid_grant');
    await h.auth.completeSignIn();
    expect(h.stub.requestsTo('/token')).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('T20-A17: a token endpoint 400 invalid_request, a 500 and an unusable 200 are errors', async () => {
    for (const [status, body] of [
      [400, { error: 'invalid_request' }],
      [500, { error: 'server_error' }],
      [200, { nothing: true }],
    ] as const) {
      const h = harness();
      await h.auth.signIn();
      arriveAt(h.stub.authorize(must(h.navigations[0])));
      h.stub.failNextToken(status, body);
      await h.auth.completeSignIn();
      expect(errorOf(h.auth.getSnapshot()).code).toBe('server_error');
      expect(h.stub.requestsTo('/token')).toHaveLength(1);
    }
  });

  it('T20-A17: a network failure during the exchange is an error and the exchange is not repeated', async () => {
    const stub = newStub();
    let tokenCalls = 0;
    const h = harness({
      stub,
      fetch: (input, init) => {
        if (urlOf(input).endsWith('/token')) {
          tokenCalls += 1;
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return stub.fetch(input, init);
      },
    });
    await h.auth.signIn();
    arriveAt(stub.authorize(must(h.navigations[0])));
    await h.auth.completeSignIn();
    expect(errorOf(h.auth.getSnapshot()).code).toBe('network');
    await h.auth.completeSignIn();
    expect(tokenCalls).toBe(1);
  });

  it('T20-A17: a callback with no parameters is an error that says the page is for signing in only', async () => {
    const h = harness();
    arriveAt('http://localhost:3000/approvals/callback');
    await h.auth.completeSignIn();
    const error = errorOf(h.auth.getSnapshot());
    expect(error.code).toBe('missing_callback_parameters');
    expect(error.message).toBe('This page is used only while signing in');
    expect(h.stub.requests).toHaveLength(0);
  });

  it('T20-A17: a callback with a state but no code is an error', async () => {
    const h = harness();
    await h.auth.signIn();
    const callback = new URL(h.stub.authorize(must(h.navigations[0])));
    arriveAt(
      `${callback.origin}${callback.pathname}?state=${must(callback.searchParams.get('state'))}`
    );
    await h.auth.completeSignIn();
    expect(errorOf(h.auth.getSnapshot()).code).toBe('missing_callback_parameters');
    expect(h.stub.requestsTo('/token')).toHaveLength(0);
  });

  it('T20-A17: a missing pending record is an error; the record is deleted on first read and ignored after ten minutes', async () => {
    const missing = harness();
    arriveAt('http://localhost:3000/approvals/callback?code=c&state=never-written');
    await missing.auth.completeSignIn();
    expect(errorOf(missing.auth.getSnapshot()).code).toBe('no_pending_request');

    const read = harness();
    await read.auth.signIn();
    expect(pendingKeys()).toHaveLength(1);
    arriveAt(read.stub.authorize(must(read.navigations[0])));
    await read.auth.completeSignIn();
    expect(pendingKeys()).toEqual([]);

    const old = harness();
    await old.auth.signIn();
    arriveAt(old.stub.authorize(must(old.navigations[0])));
    clock.now += PENDING_MAX_AGE_MS + 1;
    await old.auth.completeSignIn();
    expect(errorOf(old.auth.getSnapshot()).code).toBe('no_pending_request');
    expect(old.stub.requestsTo('/token')).toHaveLength(0);
    expect(pendingKeys()).toEqual([]);

    const edge = harness();
    await edge.auth.signIn();
    arriveAt(edge.stub.authorize(must(edge.navigations[0])));
    clock.now += PENDING_MAX_AGE_MS;
    await edge.auth.completeSignIn();
    expect(edge.auth.getSnapshot().status).toBe('signed_in');
  });

  it('T20-A17: a pending record that cannot be read is treated as absent', async () => {
    const h = harness();
    await h.auth.signIn();
    const key = must(pendingKeys()[0]);
    const state = key.slice('nc.auth.pending.'.length);
    for (const garbage of ['not json', '"text"', '{"verifier":1}', '{"verifier":"v"}']) {
      sessionStorage.setItem(key, garbage);
      const again = harness({ stub: h.stub });
      arriveAt(`http://localhost:3000/approvals/callback?code=c&state=${state}`);
      await again.auth.completeSignIn();
      expect(errorOf(again.auth.getSnapshot()).code).toBe('no_pending_request');
    }
  });
});

describe('the sign-in service and the browser', () => {
  it('reports an unreachable or unusable metadata document as an error state', async () => {
    const down = harness({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    await down.auth.signIn();
    expect(errorOf(down.auth.getSnapshot()).code).toBe('network');
    expect(down.navigations).toEqual([]);

    const broken = harness();
    broken.stub.setMetadataStatus(500);
    await broken.auth.signIn();
    expect(errorOf(broken.auth.getSnapshot()).code).toBe('server_error');
    // A later sign-in asks again: a failed metadata fetch is not remembered.
    broken.stub.setMetadataStatus(200);
    await broken.auth.signIn();
    expect(broken.auth.getSnapshot()).toEqual({ status: 'redirecting' });
  });

  it('reports an error state when the metadata is not usable at the callback', async () => {
    const stub = newStub();
    const h = harness({ stub });
    await h.auth.signIn();
    arriveAt(stub.authorize(must(h.navigations[0])));
    stub.setMetadataStatus(500);
    const fresh = harness({ stub, store: memoryRefreshStore() });
    // The pending record is shared storage, so the callback can be completed by another object.
    await fresh.auth.completeSignIn();
    expect(errorOf(fresh.auth.getSnapshot()).code).toBe('server_error');
  });

  it('M3-METADATA-ISSUER-NOT-CHECKED: metadata that names another issuer or a non-https endpoint is refused', async () => {
    const stub = newStub();
    const altered =
      (change: Record<string, unknown>): typeof fetch =>
      async (input, init) => {
        const response = await stub.fetch(input, init);
        if (!(typeof input === 'string' && input.includes('/.well-known/'))) return response;
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...body, ...change });
      };
    const refused: Record<string, unknown>[] = [
      { issuer: 'https://other.example.test' },
      { issuer: undefined },
      { token_endpoint: 'http://auth.example.test/token' },
      { authorization_endpoint: 'http://auth.example.test/authorize' },
      { revocation_endpoint: 'http://auth.example.test/revoke' },
    ];
    for (const change of refused) {
      const h = harness({ stub, fetch: altered(change) });
      await h.auth.signIn();
      expect(errorOf(h.auth.getSnapshot()).code).toBe('server_error');
      expect(h.navigations).toEqual([]);
    }
    // A trailing slash on the issuer is not a different issuer.
    const ok = harness({
      stub,
      fetch: altered({ issuer: `${stub.issuer}/`, token_endpoint: `${stub.issuer}/oauth/token` }),
    });
    await ok.auth.signIn();
    expect(ok.auth.getSnapshot()).toEqual({ status: 'redirecting' });
  });

  it('c1-7 a token or revocation endpoint on another origin than the issuer is refused, naming which', async () => {
    const stub = newStub();
    const altered =
      (change: Record<string, unknown>): typeof fetch =>
      async (input, init) => {
        const response = await stub.fetch(input, init);
        if (!(typeof input === 'string' && input.includes('/.well-known/'))) return response;
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...body, ...change });
      };
    for (const name of ['token_endpoint', 'revocation_endpoint'] as const) {
      const h = harness({
        stub,
        fetch: altered({ [name]: 'https://tokens.other.example.test/x' }),
      });
      await h.auth.signIn();
      const error = errorOf(h.auth.getSnapshot());
      expect(error.code).toBe('server_error');
      expect(error.message).toContain(name);
      expect(error.message).toContain('another origin');
      expect(h.navigations).toEqual([]);
    }
  });

  it('M3-ERR-CAUSE-LOST: an unexpected failure keeps its cause and says what went wrong', async () => {
    const h = harness();
    const failure = new TypeError('crypto.subtle is unavailable');
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(failure);
    await h.auth.signIn();
    const error = errorOf(h.auth.getSnapshot());
    expect(error.code).toBe('server_error');
    expect(error.message).toContain('secure context');
    expect(error.cause).toBe(failure);
    expect(h.navigations).toEqual([]);
  });

  it('M3-CALLBACK-META-NO-EPOCH-GUARD: a metadata failure that arrives after sign-out does not overwrite signed_out', async () => {
    const stub = newStub();
    const first = harness({ stub });
    await first.auth.signIn();
    arriveAt(stub.authorize(must(first.navigations[0])));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      stub,
      fetch: async () => {
        await gate;
        throw new TypeError('Failed to fetch');
      },
    });
    const completing = h.auth.completeSignIn();
    await h.auth.signOut();
    release();
    await completing;
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_out' });
  });

  describe('ADV-2 a sign-out or a new sign-in during the code exchange drops the late answer', () => {
    const exchangeHeldBack = async () => {
      const stub = newStub();
      const first = harness({ stub });
      await first.auth.signIn();
      arriveAt(stub.authorize(must(first.navigations[0])));
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = harness({
        stub,
        fetch: async (input, init) => {
          if (urlOf(input).endsWith('/token')) await gate;
          return stub.fetch(input, init);
        },
      });
      const done = h.auth.completeSignIn();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { h, done, release };
    };

    it('ADV-2: a sign-out mid-exchange stays signed out and writes no refresh token', async () => {
      const { h, done, release } = await exchangeHeldBack();
      await h.auth.signOut();
      release();
      await done;
      expect(h.auth.getSnapshot()).toEqual({ status: 'signed_out' });
      expect(h.store.get()).toBeNull();
    });

    it('ADV-2: a new sign-in mid-exchange stays redirecting and writes no refresh token', async () => {
      const { h, done, release } = await exchangeHeldBack();
      await h.auth.signIn();
      release();
      await done;
      expect(h.auth.getSnapshot()).toEqual({ status: 'redirecting' });
      expect(h.store.get()).toBeNull();
    });
  });

  it('ADV-3: completeSignIn is memoised: two calls make one token request and never show an error', async () => {
    const stub = newStub();
    const first = harness({ stub });
    await first.auth.signIn();
    arriveAt(stub.authorize(must(first.navigations[0])));
    let tokenRequests = 0;
    const h = harness({
      stub,
      fetch: (input, init) => {
        if (urlOf(input).endsWith('/token')) tokenRequests += 1;
        return stub.fetch(input, init);
      },
    });
    const statuses: string[] = [];
    h.auth.subscribe(() => {
      statuses.push(h.auth.getSnapshot().status);
    });
    await Promise.all([h.auth.completeSignIn(), h.auth.completeSignIn()]);
    expect(tokenRequests).toBe(1);
    expect(statuses).not.toContain('error');
    expect(h.auth.getSnapshot().status).toBe('signed_in');
  });

  it('M3-PENDING-LEAK: a second sign-in replaces the pending record of an abandoned first one', async () => {
    const h = harness();
    await h.auth.signIn();
    const first = must(pendingKeys()[0]);
    await h.auth.signIn();
    expect(pendingKeys()).toHaveLength(1);
    expect(pendingKeys()).not.toContain(first);
  });

  it('reports an error state when this browser will not keep the pending record', async () => {
    const h = harness();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    await h.auth.signIn();
    expect(errorOf(h.auth.getSnapshot()).code).toBe('server_error');
    expect(h.navigations).toEqual([]);
  });

  it('navigates with location.assign by default', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', {
      origin: 'http://localhost:3000',
      pathname: '/',
      search: '',
      assign,
    });
    const stub = newStub();
    const auth = createBrowserAuthWith({
      issuer: stub.issuer,
      clientId: stub.clientId,
      redirectUri: stub.redirectUri,
      resource: stub.resource,
      fetch: stub.fetch,
      now,
    });
    await auth.signIn();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]?.[0])).toContain('/authorize?');
  });

  it('uses the global fetch when none is given, and the issuer path in the metadata address', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (input: string) => {
      calls.push(input);
      return Promise.resolve(new Response('{}', { status: 500 }));
    });
    const auth = createBrowserAuthWith({
      issuer: 'https://auth.example.test/tenant/',
      clientId: 'bnoauth_REPLACE_ME',
      redirectUri: 'http://localhost:3000/approvals/callback',
      resource: 'https://govern.example.test',
    });
    await auth.signIn();
    expect(calls).toEqual([
      'https://auth.example.test/.well-known/oauth-authorization-server/tenant',
    ]);
  });

  it('notifies subscribers of every change and stops after unsubscribe; a signed_in refresh is not a change', async () => {
    const h = harness();
    const seen: string[] = [];
    const unsubscribe = h.auth.subscribe(() => seen.push(h.auth.getSnapshot().status));
    await completeFlow(h);
    await h.auth.getToken({ forceRefresh: true });
    expect(seen).toEqual(['redirecting', 'completing', 'signed_in']);
    unsubscribe();
    await h.auth.signOut();
    expect(seen).toHaveLength(3);
    expect(h.auth.getSnapshot()).toBe(h.auth.getSnapshot());
  });

  it('keeps the returnTo of the session across a refresh', async () => {
    const h = harness();
    await completeFlow(h, 'approve', '/inbox');
    await h.auth.getToken({ forceRefresh: true });
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_in', returnTo: '/inbox' });
  });

  it('refuses a token it has not been given a session for', async () => {
    const h = harness();
    await expect(h.auth.getToken()).rejects.toMatchObject({ code: 'signed_out' });
    await expect(h.auth.getToken({ forceRefresh: true })).rejects.toBeInstanceOf(AuthError);
    expect(h.stub.requests).toHaveLength(0);
  });

  it('exposes a store the host supplies and works with any RefreshTokenStore', async () => {
    const log: string[] = [];
    let held: string | null = null;
    const store: RefreshTokenStore = {
      get: () => held,
      set: (token) => {
        log.push('set');
        held = token;
      },
      clear: () => {
        log.push('clear');
        held = null;
      },
    };
    const h = harness({ store });
    await completeFlow(h);
    expect(log).toEqual(['set']);
    await h.auth.signOut();
    expect(log).toEqual(['set', 'clear']);
  });
});

describe('c1-13 a throwing page or host store cannot strand sign-in', () => {
  const throwing = (over: Partial<RefreshTokenStore>): RefreshTokenStore => ({
    ...memoryRefreshStore(),
    ...over,
  });

  it('a history.replaceState that throws ends in the error state with the cause, not in completing', async () => {
    const h = harness();
    await h.auth.signIn();
    arriveAt(h.stub.authorize(must(h.navigations[0])));
    const failure = new Error('SecurityError');
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw failure;
    });
    await h.auth.completeSignIn();
    const error = errorOf(h.auth.getSnapshot());
    expect(error.code).toBe('server_error');
    expect(error.cause).toBe(failure);
  });

  it('a store.set that throws after the code exchange keeps the session in memory and reports the fault', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const fault = new Error('quota');
    const h = harness({
      store: throwing({
        set: () => {
          throw fault;
        },
      }),
    });
    await completeFlow(h);
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_in' });
    await expect(h.auth.getToken()).resolves.toMatch(/^at-/);
    expect(reported).toEqual([fault]);
  });

  it('a store.set that throws after a successful refresh keeps the new token and stays signed_in', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const inner = memoryRefreshStore();
    let broken = false;
    const h = harness({
      store: throwing({
        get: () => inner.get(),
        clear: () => {
          inner.clear();
        },
        set: (token) => {
          if (broken) throw new Error('quota');
          inner.set(token);
        },
      }),
    });
    await completeFlow(h);
    broken = true;
    const token = await h.auth.getToken({ forceRefresh: true });
    expect(token).toMatch(/^at-/);
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_in' });
    expect(reported).toHaveLength(1);
    await expect(h.auth.getToken()).resolves.toBe(token);
  });

  it('a subscriber that throws does not stop the others or the state change', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const h = harness();
    const seen: string[] = [];
    h.auth.subscribe(() => {
      throw new Error('bad listener');
    });
    h.auth.subscribe(() => seen.push(h.auth.getSnapshot().status));
    await completeFlow(h);
    expect(seen.at(-1)).toBe('signed_in');
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed_in' });
    expect(reported.length).toBeGreaterThan(0);
  });
});

describe('c2-1 a host store whose get() throws cannot stop sign-out or restore', () => {
  const brokenGet = (): RefreshTokenStore => ({
    ...memoryRefreshStore(),
    get: () => {
      throw new Error('storage blocked');
    },
  });

  it('signOut completes, reports the fault and ends signed_out', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const h = harness({ store: brokenGet() });
    await completeFlow(h);
    await expect(h.auth.signOut()).resolves.toBeUndefined();
    expect(h.auth.getSnapshot().status).toBe('signed_out');
    await expect(h.auth.getToken()).rejects.toMatchObject({ code: 'signed_out' });
    expect(reported.length).toBeGreaterThan(0);
  });

  it('restore completes and stays signed_out', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const h = harness({ store: brokenGet() });
    await expect(h.auth.restore()).resolves.toBeUndefined();
    expect(h.auth.getSnapshot().status).toBe('signed_out');
    expect(reported.length).toBeGreaterThan(0);
  });

  it('a refresh treats the unreadable token as no session', async () => {
    vi.stubGlobal('reportError', () => undefined);
    const h = harness({ store: brokenGet() });
    await completeFlow(h);
    await expect(h.auth.getToken({ forceRefresh: true })).rejects.toMatchObject({
      code: 'signed_out',
    });
    expect(h.auth.getSnapshot().status).toBe('signed_out');
  });
});

describe('c2-7 faults of the sign-in reach the host', () => {
  it('onFault receives a throwing store and a throwing subscriber instead of reportError', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const faults: unknown[] = [];
    const quota = new Error('quota');
    const stub = newStub();
    const navigations: string[] = [];
    const auth = createBrowserAuthWith(
      {
        issuer: stub.issuer,
        clientId: stub.clientId,
        redirectUri: stub.redirectUri,
        resource: stub.resource,
        fetch: stub.fetch,
        storage: {
          ...memoryRefreshStore(),
          set: () => {
            throw quota;
          },
        },
        now,
        onFault: (fault) => faults.push(fault),
      },
      { navigate: (url) => navigations.push(url) }
    );
    const listenerFault = new Error('bad listener');
    auth.subscribe(() => {
      throw listenerFault;
    });
    await auth.signIn();
    arriveAt(stub.authorize(must(navigations[0])));
    await auth.completeSignIn();
    expect(auth.getSnapshot()).toEqual({ status: 'signed_in' });
    expect(faults).toContain(quota);
    expect(faults).toContain(listenerFault);
    expect(reported).toEqual([]);
  });

  it('restore reports a failure that is not an AuthError and still ends signed_out', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const first = harness();
    await completeFlow(first);
    // The same server and store, a new page whose clock fails when the refreshed token is stamped.
    const clockBug = new Error('clock failed');
    const restored = createBrowserAuthWith({
      issuer: first.stub.issuer,
      clientId: first.stub.clientId,
      redirectUri: first.stub.redirectUri,
      resource: first.stub.resource,
      fetch: first.stub.fetch,
      storage: first.store,
      now: () => {
        throw clockBug;
      },
    });
    await expect(restored.restore()).resolves.toBeUndefined();
    expect(restored.getSnapshot().status).toBe('signed_out');
    expect(reported).toEqual([clockBug]);
  });
});

describe('c1-14 the callback error parameter is matched, never interpolated', () => {
  const callbackWith = async (error: string): Promise<AuthError> => {
    const h = harness();
    await h.auth.signIn();
    const callback = new URL(h.stub.authorize(must(h.navigations[0])));
    const state = must(callback.searchParams.get('state'));
    arriveAt(
      `${callback.origin}${callback.pathname}?error=${encodeURIComponent(error)}&state=${state}`
    );
    await h.auth.completeSignIn();
    return errorOf(h.auth.getSnapshot());
  };

  it('names an RFC 6749 code and shows anything else as an unknown error', async () => {
    expect((await callbackWith('temporarily_unavailable')).message).toBe(
      'Sign-in failed: temporarily_unavailable.'
    );
    const unknown = await callbackWith('<img src=x onerror=alert(1)> Your account is locked');
    expect(unknown.message).toBe('Sign-in failed: unknown error.');
    expect(unknown.code).toBe('server_error');
  });
});
