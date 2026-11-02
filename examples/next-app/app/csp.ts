/**
 * The content-security policy of the example: scripts and styles only from this origin or with this
 * request's nonce, no `'unsafe-inline'`, and network calls only to this origin, the API and the issuer.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** A fresh, unguessable value for one response. */
export function newNonce(): string {
  return btoa(crypto.randomUUID());
}

/** The origin of `value`, or undefined when it is not an absolute URL. */
export function originOf(value: string | undefined): string | undefined {
  return value !== undefined && URL.canParse(value) ? new URL(value).origin : undefined;
}

export interface CspOptions {
  readonly nonce: string;
  /** Origins the page may call besides its own (the API, the issuer). Duplicates and gaps are dropped. */
  readonly connectOrigins: readonly (string | undefined)[];
}

export function buildCsp({ nonce, connectOrigins }: CspOptions): string {
  const connect = [
    "'self'",
    ...new Set(connectOrigins.filter((origin): origin is string => origin !== undefined)),
  ];
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export interface CspEnvironment {
  readonly nodeEnv: string | undefined;
  readonly apiUrl: string | undefined;
  readonly issuer: string | undefined;
}

/**
 * The response for a page request: the request carries the policy too (Next reads the nonce from it), and so
 * does the response. Development gets neither.
 */
export function withCsp(request: NextRequest, environment: CspEnvironment): NextResponse {
  if (environment.nodeEnv === 'development') return NextResponse.next();
  const policy = buildCsp({
    nonce: newNonce(),
    connectOrigins: [originOf(environment.apiUrl), originOf(environment.issuer)],
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  return response;
}
