/**
 * A canned approvals API for store tests that need a reply the mock cannot produce (another id, a changed
 * digest, a hand-written stream). Not part of the published package.
 */
import { cannedApproval, handStream, jsonResponse, problemResponse } from './approvals-harness.js';
import type { HandStream } from './approvals-harness.js';

export interface Canned {
  readonly fetch: typeof fetch;
  readonly stream: HandStream;
  /** The rows of the list. */
  list: Record<string, unknown>[];
  /** The answer to a single read; the default is the approval of the requested id. */
  read: (id: string) => Response | Promise<Response>;
  /** The answer to a resolve POST; the default is a 409 `approval_conflict`. */
  resolve: (id: string) => Response;
  /** The paths and methods requested, in order. */
  readonly calls: string[];
}

/** A canned API whose list holds `rows` and whose reads answer `cannedApproval(id)` with `arguments`. */
export function canned(rows: readonly string[] = ['apr_1']): Canned {
  const stream = handStream();
  const calls: string[] = [];
  const api: Canned = {
    stream,
    calls,
    list: rows.map((id) => cannedApproval(id)),
    read: (id) => jsonResponse({ data: cannedApproval(id, { arguments: { amount: 1 } }) }),
    resolve: () => problemResponse(409, 'approval_conflict'),
    fetch: (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === '/v1/capabilities') {
        return Promise.resolve(
          jsonResponse({ data: { resolutions: ['approved', 'rejected'], dpop: 'off' } })
        );
      }
      if (url.pathname === '/v1/approvals/stream') return Promise.resolve(stream.response());
      if (url.pathname === '/v1/approvals') {
        return Promise.resolve(jsonResponse({ data: api.list, meta: { next: null } }));
      }
      const id =
        url.pathname
          .split('/')
          .filter((p) => p !== 'resolve')
          .pop() ?? '';
      if (request.method === 'POST') return Promise.resolve(api.resolve(id));
      return Promise.resolve(api.read(id));
    },
  };
  return api;
}
