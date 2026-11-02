/**
 * Test support for the sign-in tests: one auth object over the in-test authorization server, a recorded
 * navigation, and a callback helper that plays the redirect round trip in a jsdom window.
 */
import { createBrowserAuthWith } from '../auth/browser-auth.js';
import { memoryRefreshStore } from '../auth/stores.js';
import type { BrowserAuth, RefreshTokenStore } from '../auth-types.js';
import { StubAuthorizationServer } from './auth-stub.js';

export const clock = { now: 1_000_000 };
export const now = (): number => clock.now;

export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}`);
  return value;
}

export interface Harness {
  readonly stub: StubAuthorizationServer;
  readonly auth: BrowserAuth;
  readonly store: RefreshTokenStore;
  readonly navigations: string[];
}

export interface HarnessOptions {
  readonly stub?: StubAuthorizationServer;
  readonly store?: RefreshTokenStore;
  readonly fetch?: typeof fetch;
  readonly useDefaultStore?: boolean;
  /** `BrowserAuthOptions.scope`; absent leaves the module's default. */
  readonly scope?: string;
}

export function newStub(): StubAuthorizationServer {
  return new StubAuthorizationServer({ now });
}

export function harness(options: HarnessOptions = {}): Harness {
  const stub = options.stub ?? newStub();
  const store = options.store ?? memoryRefreshStore();
  const navigations: string[] = [];
  const auth = createBrowserAuthWith(
    {
      issuer: stub.issuer,
      clientId: stub.clientId,
      redirectUri: stub.redirectUri,
      resource: stub.resource,
      fetch: options.fetch ?? stub.fetch,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.useDefaultStore === true ? {} : { storage: store }),
      now,
    },
    {
      navigate: (url) => {
        navigations.push(url);
      },
    }
  );
  return { stub, auth, store, navigations };
}

/** Puts a callback URL in the window's address bar, as the redirect back from the server does. */
export function arriveAt(callback: string): void {
  const url = new URL(callback);
  window.history.replaceState(null, '', url.pathname + url.search);
}

/** `signIn`, the person's decision at the server, the redirect back, `completeSignIn`. */
export async function completeFlow(
  h: Harness,
  decision: 'approve' | 'deny' = 'approve',
  returnTo?: string
): Promise<void> {
  await h.auth.signIn(returnTo);
  const authorizeUrl = must(h.navigations.at(-1), 'navigation');
  arriveAt(h.stub.authorize(authorizeUrl, decision));
  await h.auth.completeSignIn();
}
