/** The public types of browser sign-in (`@noblecloak/react/auth`), and the `AuthError` class. */

/** Where the one refresh token lives. `BrowserAuthOptions.storage` takes any object that implements it. */
export interface RefreshTokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
}

/** A sign-in failure. `code` is `signed_out` when there is no session to take a token from. */
export class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * The sign-in state machine. `redirecting` happens only on an explicit `signIn()`; `denied` is a callback
 * with `error=access_denied`; nothing signs in automatically from any state.
 */
export type AuthState =
  | { readonly status: 'signed_out'; readonly message?: string }
  | { readonly status: 'redirecting' }
  | { readonly status: 'completing' }
  | { readonly status: 'signed_in'; readonly returnTo?: string }
  | { readonly status: 'denied' }
  | { readonly status: 'error'; readonly error: AuthError };

export interface BrowserAuthOptions {
  /** The authorization server's issuer; endpoints come from its metadata document. */
  readonly issuer: string;
  /** The public client's id. There is no client secret in a browser. */
  readonly clientId: string;
  /** Absolute, exact, no wildcard and no fragment. */
  readonly redirectUri: string;
  /** The API's origin, byte-exact, with no path. */
  readonly resource: string;
  /**
   * The scope asked for on the authorize request, space-separated. Absent: `approvals:resolve`, which the
   * deployment's `Capabilities.user_resolve_scope` names as the scope a person's token must carry to resolve,
   * approve or deny an approval. `''`: no `scope` parameter at all (a sign-in that only reads). An authorization
   * server that does not know the scope may drop it, so a token that lacks it is refused by the API at resolve, not here.
   */
  readonly scope?: string;
  readonly fetch?: typeof fetch;
  readonly storage?: RefreshTokenStore;
  readonly now?: () => number;
  /**
   * Called with a fault in a subscriber or in the `storage` the host gave (a listener or a store method that
   * threw). Without it the fault is reported like an uncaught exception (`reportError`) where the runtime has
   * one, and written to `console.error` as `name: message` otherwise.
   */
  readonly onFault?: (fault: unknown) => void;
}

export interface BrowserAuth {
  /** Starts the authorization request. Called from a user gesture only. */
  signIn(returnTo?: string): Promise<void>;
  /** Handles the callback: validates it, exchanges the code and moves to `signed_in`, `denied` or `error`. */
  completeSignIn(): Promise<void>;
  /** On load: one refresh from a stored refresh token, without a redirect. */
  restore(): Promise<void>;
  /** The access token; throws `AuthError('signed_out')` without a session. */
  getToken(options?: { forceRefresh?: boolean }): Promise<string>;
  signOut(): Promise<void>;
  getSnapshot(): AuthState;
  subscribe(listener: () => void): () => void;
}
