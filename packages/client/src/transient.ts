import { ModuleApiError } from './module-api-error.js';

/** A 4xx answer: the status and the problem type's code (the last segment of its `type` URI). */
export interface Problem {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
}

export type Answer<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly problem: Problem };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether an HTTP status is one a caller may send the same request again for: 5xx, 408 and 429. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * The single place that says which failures are transient. Takes an `Answer`, a `Problem` or a thrown
 * error. True for a `ModuleApiError` (its one code is `unreachable`), including one from another installed copy of the client (an `Error` named `ModuleApiError` with code `unreachable`), for a refused answer (or bare `Problem`) whose status is 5xx, 408 or 429, and false for
 * a successful answer, any other status (400, 403, 404, 409 ...) and any other error, including an `Error` that carries a numeric `status` (an SDK error is not a `Problem`).
 * `jwks` and `stream` throw `ModuleApiError` for every non-ok status, 4xx included, so `isTransient` is true for those.
 */
export function isTransient(subject: unknown): boolean {
  // The only ModuleApiError code is `unreachable`.
  if (subject instanceof ModuleApiError) return true;
  // Two installed copies of the client have two ModuleApiError classes, so instanceof misses the other copy's.
  if (
    subject instanceof Error &&
    subject.name === 'ModuleApiError' &&
    (subject as { code?: unknown }).code === 'unreachable'
  ) {
    return true;
  }
  if (!isObject(subject)) return false;
  if (subject.ok === false && isObject(subject.problem)) {
    return typeof subject.problem.status === 'number' && isTransientStatus(subject.problem.status);
  }
  if (
    !(subject instanceof Error) &&
    subject.ok === undefined &&
    typeof subject.status === 'number'
  ) {
    return isTransientStatus(subject.status);
  }
  return false;
}
