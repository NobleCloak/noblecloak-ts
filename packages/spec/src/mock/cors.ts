/**
 * CORS for the mock, so a browser on another origin can call it. It mirrors what the hosted API does:
 * an exact-match origin allowlist, never `*`, never a reflected origin. The allowlist is the static list
 * (`--allow-origin`, which the mock passes together with its own module origin: the deployment's own origins) plus, from rev 12, every organisation's registered origins (`PUT /v1/origins`): a
 * preflight carries no token, so it is answered against that union. A request whose `Origin` is absent or
 * not in the union gets no `Access-Control-*` header, only `Vary: Origin`; with no origin listed or
 * registered the middleware adds nothing at all. A preflight from an unadmitted origin is not answered
 * here: it falls through to the router (404 for it, 401 for other methods), and the hosted API's status
 * for that case is not asserted. An actual request whose origin the caller's organisation does not admit
 * is refused after authentication (403 `forbidden`, in `app.ts`) and carries no `Access-Control-*` header.
 */
import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

/** Methods, request headers and exposed response headers of the hosted API's CORS answer. */
export const CORS_ALLOW_METHODS = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'] as const;
export const CORS_ALLOW_HEADERS = [
  'Content-Type',
  'Authorization',
  'Idempotency-Key',
  'X-Request-Id',
  'DPoP',
] as const;
export const CORS_EXPOSE_HEADERS = ['X-Request-Id'] as const;
export const CORS_MAX_AGE_SECONDS = 600;

/**
 * Checks that `values` are exact origins (`scheme://host[:port]`, as a browser sends them) and returns
 * them without duplicates. Throws an Error naming the first value that is not: `*`, a pattern, a path,
 * a trailing slash or an origin written in a form a browser never sends all fail, because a list that
 * cannot match would silently allow nothing.
 */
export function parseAllowedOrigins(values: readonly string[]): readonly string[] {
  for (const value of values) {
    if (value.includes('*'))
      throw new Error(`origin ${JSON.stringify(value)} is not exact: a wildcard is not allowed`);
    let origin: string | undefined;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') origin = url.origin;
    } catch {
      origin = undefined;
    }
    if (origin === undefined || origin !== value)
      throw new Error(
        `origin ${JSON.stringify(value)} is not an exact http(s) origin such as http://localhost:3000 (no path, no trailing slash)`
      );
  }
  return [...new Set(values)];
}

/**
 * Whether `value` is an exact origin a registered-origin write may carry (rev 12): `scheme://host[:port]`,
 * the form a browser sends in `Origin`, with no path, query, fragment, trailing slash, userinfo or wildcard,
 * and `https`, or `http` only for `localhost` and `127.0.0.1`. Nothing is normalised: `HTTPS://App.example.com`
 * and `https://app.example.com:443` are refused because a browser never sends them.
 */
export function isExactRegisteredOrigin(value: string): boolean {
  if (value.includes('*')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const schemeAllowed = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  return schemeAllowed && url.origin === value;
}

/**
 * Requests whose `Origin` the deployment refused after authentication (rev 12). `mockCors` strips the CORS
 * headers it added from the response to one of these, so a refused request never carries
 * `Access-Control-Allow-Origin`.
 */
const refusedOrigin = new WeakSet<Request>();
export const markOriginRefused = (request: Request): void => void refusedOrigin.add(request);

/** The registered origins `mockCors` consults (rev 12). */
export interface RegisteredOrigins {
  /** Every organisation's registered origins: a preflight carries no token, so it is answered against all of them. */
  readonly all: () => readonly string[];
  /** The defect: a preflight is answered against the static list only. */
  readonly ignoreForPreflight?: () => boolean;
}

/**
 * The middleware for an already-validated static list and the organisations' registered origins. A
 * preflight is answered for an origin in the union of the two; an actual request gets
 * `Access-Control-Allow-Origin` the same way, and a request the deployment refuses after authentication
 * (see `markOriginRefused`) loses it. With no origin listed or registered it adds nothing.
 */
export function mockCors(
  allowedOrigins: readonly string[],
  registered?: RegisteredOrigins
): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  const admitted = (origin: string, preflight: boolean): boolean =>
    allowed.has(origin) ||
    (registered !== undefined &&
      !(preflight && registered.ignoreForPreflight?.() === true) &&
      registered.all().includes(origin));
  const listed = cors({
    origin: (origin, c) => (admitted(origin, c.req.method === 'OPTIONS') ? origin : null),
    allowMethods: [...CORS_ALLOW_METHODS],
    allowHeaders: [...CORS_ALLOW_HEADERS],
    exposeHeaders: [...CORS_EXPOSE_HEADERS],
    maxAge: CORS_MAX_AGE_SECONDS,
  });
  return async (c, next) => {
    if (allowed.size === 0 && (registered === undefined || registered.all().length === 0))
      return next();
    const origin = c.req.header('origin');
    // A preflight is answered here, without `next()`: that response is the one returned.
    let answered: Response | undefined;
    if (origin !== undefined && admitted(origin, c.req.method === 'OPTIONS')) {
      const result = await listed(c, next);
      if (result instanceof Response) answered = result;
    } else {
      await next();
    }
    const response = answered ?? c.res;
    if (refusedOrigin.has(c.req.raw)) {
      for (const name of [...response.headers.keys()])
        if (name.startsWith('access-control-')) response.headers.delete(name);
    }
    // The answer depends on Origin: keep a shared cache from serving one origin's headers to another.
    // Set on the finished response, because a handler that builds its own `Response` drops headers set
    // earlier with `c.header`.
    const vary = response.headers.get('vary') ?? '';
    if (!vary.split(',').some((token) => token.trim().toLowerCase() === 'origin'))
      response.headers.append('Vary', 'Origin');
    return answered;
  };
}
