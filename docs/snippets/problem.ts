/**
 * The client returns an API error; it never throws one. A problem document (RFC 9457) names its kind in
 * `type`, a URI whose last path segment is the code the guide lists.
 */
export function problemCode(problem: { readonly type?: string }): string {
  return problem.type?.split('/').at(-1) ?? 'unknown';
}

/** What every call of the typed client resolves to: a body or a problem, plus the raw response. */
interface Result<T> {
  readonly data?: T;
  readonly error?: { readonly type?: string };
  readonly response: Response;
}

/** The body of a successful call. Anything else throws, naming the status and the problem code. */
export function unwrap<T>(result: Result<T>): T {
  if (result.error !== undefined || result.data === undefined) {
    const code = result.error === undefined ? 'no body' : problemCode(result.error);
    throw new Error(`${String(result.response.status)} ${code}`);
  }
  return result.data;
}
