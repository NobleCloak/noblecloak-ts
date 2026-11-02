/**
 * The `auth` entry: browser sign-in for a public client (authorization code with PKCE, S256 only).
 * `createBrowserAuth` makes the sign-in object, `useAuthState` reads its state, and
 * `sessionStorageRefreshStore` (the default) and `memoryRefreshStore` are the two places the one refresh token
 * can live; the access token is never stored. `AuthError` and the types are the public shapes.
 */
export * from './auth/index.js';
