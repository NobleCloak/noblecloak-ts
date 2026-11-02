/**
 * The checks on an issuer and its endpoints that browser sign-in and the registration tool share. Internal:
 * the package entry does not export it.
 */

/** True for `https:`, or `http:` on `localhost`: the only schemes a token or a client registration is sent over. */
export const isSecureUrl = (url: URL): boolean =>
  url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');

/** True when `value` parses as an absolute URL over `https:` (or `http://localhost`). */
export function isSecureEndpoint(value: string): boolean {
  try {
    return isSecureUrl(new URL(value));
  } catch {
    return false;
  }
}

/** RFC 8414 section 3.3: the metadata names the issuer it was asked about, ignoring one trailing slash. */
export function sameIssuer(value: unknown, issuer: string): boolean {
  return typeof value === 'string' && value.replace(/\/$/, '') === issuer.replace(/\/$/, '');
}
