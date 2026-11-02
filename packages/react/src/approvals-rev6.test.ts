import { describe, expect, it } from 'vitest';

import {
  asUnavailable,
  errorFromResponse,
  makeError,
  retryAfterBodyMs,
  REASON_ELIGIBILITY_LOOKUP,
} from './approvals-errors.js';
import { approvalOf, approvalPageOf, isApproval } from './approvals-parse.js';
import { cannedApproval } from './testing/approvals-harness.js';

// Contract revision 6: the members an approval gained, and the problem members the errors read.

const base = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  cannedApproval('apr_1', extra);

describe('an approval with the rev 6 members', () => {
  it('accepts a requester, names on every principal reference, an agent name, arguments_state and waiting_on', () => {
    const approval = base({
      requester: { id: 'user_a', kind: 'user', display_name: 'Ada' },
      approver: { id: 'user_b', kind: 'user', display_name: 'Bo' },
      agent: { id: 'agent_1', name: 'Ledger agent', parent: null },
      arguments_state: 'withheld',
      waiting_on: { count: 2, principals: [{ id: 'user_b', kind: 'user', display_name: 'Bo' }] },
      resolution_history: [
        {
          resolution: 'approved',
          at: '2026-10-05T00:00:00Z',
          by: { id: 'user_b', kind: 'user', display_name: 'Bo' },
        },
      ],
    });
    expect(isApproval(approval)).toBe(true);
    expect(approvalOf({ data: approval })).toBe(approval);
  });

  it('accepts the rev 5 shape, which carries none of them', () => {
    expect(isApproval(base({ approver: { id: 'user_b', kind: 'user' } }))).toBe(true);
    expect(isApproval(base())).toBe(true);
  });

  it('keeps an arguments_state this version does not know, and refuses one that is not a string', () => {
    expect(isApproval(base({ arguments_state: 'something_new' }))).toBe(true);
    expect(isApproval(base({ arguments_state: 7 }))).toBe(false);
    expect(isApproval(base({ arguments_state: null }))).toBe(false);
  });

  it.each([
    ['a requester that is not a reference', { requester: 'user_a' }],
    ['a requester with no id', { requester: { kind: 'user' } }],
    ['a name that is null', { requester: { id: 'u', kind: 'user', display_name: null } }],
    ['a name that is empty', { requester: { id: 'u', kind: 'user', display_name: '' } }],
    ['a name that is not text', { approver: { id: 'u', kind: 'user', display_name: 4 } }],
    [
      'a name in the history that is not text',
      {
        resolution_history: [
          { resolution: 'approved', at: 'x', by: { id: 'u', display_name: {} } },
        ],
      },
    ],
    ['an agent name that is not text', { agent: { id: 'a', name: 3 } }],
    ['a waiting_on with no count', { waiting_on: { principals: [] } }],
    ['a waiting_on with a negative count', { waiting_on: { count: -1 } }],
    [
      'a waiting_on with more than five principals',
      {
        waiting_on: {
          count: 6,
          principals: Array.from({ length: 6 }, (_v, n) => ({ id: `u${String(n)}`, kind: 'user' })),
        },
      },
    ],
    [
      'a waiting_on principal that is not a reference',
      { waiting_on: { count: 1, principals: ['u'] } },
    ],
  ])('is not an approval with %s', (_name, extra) => {
    expect(isApproval(base(extra))).toBe(false);
  });

  it('a page that carries one such row is not a page, and a page names the cursor of the next', () => {
    const bad = base({ requester: { kind: 'user' } });
    expect(approvalPageOf({ data: [base(), bad], meta: {} })).toBeUndefined();
    const page = approvalPageOf({ data: [base()], meta: { next: '50' } });
    expect(page).toMatchObject({ more: true, next: '50' });
    expect(approvalPageOf({ data: [base()], meta: { next: null } })).toEqual({
      approvals: [base()],
      more: false,
    });
  });
});

describe('the problem members', () => {
  it('reads the wait from the body when the header is not readable, and prefers the header when it is', () => {
    const problem = {
      type: 'https://x/problems/service_unavailable',
      title: 'x',
      status: 503,
      request_id: 'r',
      retry_after_seconds: 9,
    };
    expect(errorFromResponse(503, problem, null)).toMatchObject({
      kind: 'unavailable',
      retryAfterMs: 9000,
    });
    expect(errorFromResponse(503, problem, '4')).toMatchObject({ retryAfterMs: 4000 });
    const limited = { ...problem, type: 'https://x/problems/rate_limited', status: 429 };
    expect(errorFromResponse(429, limited, null)).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 9000,
    });
  });

  it.each([[-1], [1.5], ['9'], [null], [undefined]])(
    'reads no wait from a body member of %s',
    (value) => {
      expect(retryAfterBodyMs({ retry_after_seconds: value })).toBeUndefined();
      expect(retryAfterBodyMs(undefined)).toBeUndefined();
    }
  );

  it('keeps a well-formed reason on a 503, and drops one that is not a code or is on another status', () => {
    const problem = (reason: unknown, status = 503): Record<string, unknown> => ({
      type: 'https://x/problems/service_unavailable',
      title: 'x',
      status,
      request_id: 'r',
      reason,
    });
    expect(errorFromResponse(503, problem('eligibility_lookup'))).toMatchObject({
      kind: 'unavailable',
      reason: REASON_ELIGIBILITY_LOOKUP,
    });
    // A code this version does not know is kept: the component then says only that the service is unavailable.
    expect(errorFromResponse(503, problem('cache_cold'))).toMatchObject({ reason: 'cache_cold' });
    for (const bad of ['Eligibility Lookup', '1abc', '', 'x'.repeat(65), 5, null])
      expect(errorFromResponse(503, problem(bad)), String(bad)).not.toHaveProperty('reason');
    expect(errorFromResponse(500, problem('eligibility_lookup', 500))).not.toHaveProperty('reason');
    expect(
      errorFromResponse(503, { type: 'https://x/problems/service_unavailable' })
    ).not.toHaveProperty('reason');
  });

  it('keeps the reason and the wait when an error is shown as unavailable', () => {
    const error = makeError('unavailable', 'service_unavailable', 'x', {
      reason: 'eligibility_lookup',
      retryAfterMs: 3000,
      status: 503,
    });
    expect(asUnavailable(error)).toBe(error);
    const other = makeError('network', 'network', 'x', { local: true });
    expect(asUnavailable(other)).not.toHaveProperty('reason');
  });

  it('maps a 413 to the kind of any other request the service did not accept', () => {
    const problem = {
      type: 'https://docs.noblecloak.com/problems/payload_too_large',
      title: 'big',
      status: 413,
      request_id: 'r',
      max_bytes: 10,
    };
    expect(errorFromResponse(413, problem)).toMatchObject({
      kind: 'invalid_request',
      code: 'payload_too_large',
    });
  });
});
