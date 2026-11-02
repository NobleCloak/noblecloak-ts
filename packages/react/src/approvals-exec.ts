/**
 * The request layer shared by the module stores: one request with the 401 rule, credential-free CORS, and the mapping
 * of a failed token, a failed fetch or an error response to the store's error type (`ApprovalsError` unless a store
 * passes its own mapping). No React.
 */
import { createClient } from '@noblecloak/client';
import type { ModuleApiClient } from '@noblecloak/client';

import { errorFromResponse, networkError, sessionError } from './approvals-errors.js';
import { parseJson } from './approvals-parse.js';
import type { ApprovalsError } from './approvals-types.js';
import { AuthError } from './auth-types.js';

/** The outcome of one request, after the 401 rule. `data` is the body text, or the stream for a stream. */
export type Reply<E = ApprovalsError> =
  | { readonly kind: 'ok'; readonly data: unknown }
  | { readonly kind: 'error'; readonly error: E }
  | { readonly kind: 'aborted' };

export interface Sent {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response: Response;
}
export type Send = (client: ModuleApiClient) => Promise<Sent>;
export type Exec<E = ApprovalsError> = (signal: AbortSignal, send: Send) => Promise<Reply<E>>;

/**
 * How a store's module names a failure: an error response (`status`, the parsed problem document or the body as
 * text, and the `Retry-After` header), a request that produced no response (`network`: a failed fetch;
 * `client_error`: any other exception; `token_unavailable`: a token could not be obtained now), and a session that is
 * over. The 401 rule and the token handling are the same for every mapping.
 */
export interface ExecErrors<E> {
  readonly fromResponse: (status: number, body: unknown, retryAfter: string | null) => E;
  readonly network: (code: 'network' | 'client_error' | 'token_unavailable', cause?: unknown) => E;
  readonly session: () => E;
}

/** The approvals module's mapping, the default. */
const APPROVALS_ERRORS: ExecErrors<ApprovalsError> = {
  fromResponse: (status, body, retryAfter) => errorFromResponse(status, body, retryAfter),
  network: networkError,
  session: sessionError,
};

/** What the request layer reads from the options of either store. */
export interface ExecOptions {
  readonly baseUrl: string;
  readonly getToken: (x?: { forceRefresh?: boolean }) => string | Promise<string>;
  readonly fetch?: typeof fetch;
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof AuthError || (error instanceof Error && error.name === 'AuthError');
}

/**
 * What a failed `getToken` means. Only an `AuthError` that says the session is over ends it: `signed_out`,
 * `invalid_grant`, and `server_error`, which browser sign-in raises only after it has ended the session.
 * Anything else (a metadata outage, a network failure, a host's own exception) is a token that could not be
 * obtained now, and is retried. A `network` code on the token POST after `endSession` is therefore retried once
 * and then yields `signed_out`, one round trip late.
 */
function tokenFailure<E>(cause: unknown, errors: ExecErrors<E>): E {
  if (isAuthFailure(cause)) {
    const code = (cause as AuthError).code;
    if (code === 'signed_out' || code === 'invalid_grant' || code === 'server_error') {
      return errors.session();
    }
  }
  return errors.network('token_unavailable', cause);
}

/** The text of a 200 as JSON; `undefined` when it is not JSON (every reader then reports `malformed_response`). */
export function jsonOf(reply: Extract<Reply<unknown>, { kind: 'ok' }>): unknown {
  const text = typeof reply.data === 'string' ? reply.data : undefined;
  return text === undefined ? undefined : parseJson(text)?.value;
}

/**
 * Builds `exec`: one request with the 401 rule. A 401 asks `getToken({forceRefresh: true})` once and retries
 * once; a failed refresh, or an `AuthError`, is an `unauthorized` error. A fresh client per request carries
 * that request's token. Every request is credential-free CORS: no cookie and no ambient credential rides along.
 * `errors` names the failures; without it they are `ApprovalsError`s.
 */
export function createExec(options: ExecOptions, reportFault: (fault: unknown) => void): Exec;
export function createExec<E>(
  options: ExecOptions,
  reportFault: (fault: unknown) => void,
  errors: ExecErrors<E>
): Exec<E>;
export function createExec<E>(
  options: ExecOptions,
  reportFault: (fault: unknown) => void,
  errors: ExecErrors<E> = APPROVALS_ERRORS as unknown as ExecErrors<E>
): Exec<E> {
  const credentialFree: typeof fetch = (input, init) =>
    (options.fetch ?? globalThis.fetch)(input, { ...init, credentials: 'omit', mode: 'cors' });

  return async function exec(signal, send) {
    const aborted = (): boolean => signal.aborted;
    const attempt = async (
      token: string
    ): Promise<Sent | 'aborted' | { readonly thrown: unknown }> => {
      try {
        const client = createClient({
          baseUrl: options.baseUrl,
          getToken: () => token,
          fetch: credentialFree,
        });
        return await send(client);
      } catch (thrown) {
        return aborted() ? 'aborted' : { thrown };
      }
    };
    let token: string;
    try {
      token = await options.getToken();
    } catch (cause) {
      return { kind: 'error', error: tokenFailure(cause, errors) };
    }
    if (aborted()) return { kind: 'aborted' };
    let sent = await attempt(token);
    if (typeof sent !== 'string' && 'response' in sent && sent.response.status === 401) {
      try {
        token = await options.getToken({ forceRefresh: true });
      } catch (cause) {
        return { kind: 'error', error: tokenFailure(cause, errors) };
      }
      if (aborted()) return { kind: 'aborted' };
      sent = await attempt(token);
    }
    if (sent === 'aborted') return { kind: 'aborted' };
    if (!('response' in sent)) {
      // A failed fetch is a TypeError (or an abort/timeout DOMException); anything else is a bug.
      const failed = sent.thrown;
      const fetchFailure =
        failed instanceof TypeError ||
        (failed instanceof Error &&
          (failed.name === 'AbortError' || failed.name === 'TimeoutError'));
      // Anything but a failed fetch is a bug in the host's fetch or in this module: it is reported, not only shown.
      if (!fetchFailure) reportFault(failed);
      return {
        kind: 'error',
        error: errors.network(fetchFailure ? 'network' : 'client_error', failed),
      };
    }
    if (sent.response.ok) return { kind: 'ok', data: sent.data };
    return {
      kind: 'error',
      error: errors.fromResponse(
        sent.response.status,
        sent.error,
        sent.response.headers.get('Retry-After')
      ),
    };
  };
}
