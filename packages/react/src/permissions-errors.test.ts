import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS_EXEC_ERRORS,
  isWriteForbidden,
  permissionsErrorFromResponse,
  precondition,
} from './permissions-errors.js';

const problem = (code: string, status: number, extra: Record<string, unknown> = {}): unknown => ({
  type: `https://api.example/problems/${code}`,
  title: `title of ${code}`,
  status,
  request_id: 'req_1',
  ...extra,
});

describe('permissionsErrorFromResponse', () => {
  it('maps a 422 unsupported_policy_form to unprocessable, keeping detail verbatim', () => {
    const detail =
      'config.mode: not_granted is provisional, and this deployment does not implement it.';
    expect(
      permissionsErrorFromResponse(422, problem('unsupported_policy_form', 422, { detail }))
    ).toEqual({
      kind: 'unprocessable',
      code: 'unsupported_policy_form',
      title: 'title of unsupported_policy_form',
      status: 422,
      requestId: 'req_1',
      type: 'https://api.example/problems/unsupported_policy_form',
      detail,
    });
  });

  it('keeps the policy_id of a 409 policy_conflict', () => {
    expect(
      permissionsErrorFromResponse(
        409,
        problem('policy_conflict', 409, { policy_id: 'pol_default' })
      )
    ).toMatchObject({ kind: 'conflict', code: 'policy_conflict', policyId: 'pol_default' });
  });

  it('keeps detail on a 400 invalid_request', () => {
    expect(
      permissionsErrorFromResponse(
        400,
        problem('invalid_request', 400, { detail: 'config does not fit' })
      )
    ).toMatchObject({ kind: 'invalid_request', detail: 'config does not fit' });
  });

  it('maps by code, never by prose: a 422 of another code stays invalid_request', () => {
    expect(permissionsErrorFromResponse(422, problem('approval_unroutable', 422)).kind).toBe(
      'invalid_request'
    );
    // A policy_id on another code is not read.
    expect(
      permissionsErrorFromResponse(409, problem('approval_conflict', 409, { policy_id: 'x' }))
    ).not.toHaveProperty('policyId');
  });

  it('maps the remaining kinds as the approvals module does', () => {
    expect(permissionsErrorFromResponse(403, problem('forbidden', 403)).kind).toBe('forbidden');
    expect(permissionsErrorFromResponse(404, problem('not_found', 404)).kind).toBe('not_found');
    expect(permissionsErrorFromResponse(503, 'down').kind).toBe('unavailable');
    expect(permissionsErrorFromResponse(400, 'not json').kind).toBe('malformed_response');
    expect(permissionsErrorFromResponse(429, problem('rate_limited', 429), '2')).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 2000,
    });
  });
});

describe('the local errors of the request layer', () => {
  it('are permissions errors of the same kinds', () => {
    expect(PERMISSIONS_EXEC_ERRORS.session()).toMatchObject({
      kind: 'unauthorized',
      code: 'session_expired',
      local: true,
    });
    const cause = new TypeError('failed');
    expect(PERMISSIONS_EXEC_ERRORS.network('network', cause)).toMatchObject({
      kind: 'network',
      code: 'network',
      cause,
    });
  });
});

describe('precondition and isWriteForbidden', () => {
  it('builds a local precondition', () => {
    expect(precondition('read_only')).toMatchObject({
      kind: 'precondition',
      code: 'read_only',
      local: true,
    });
  });

  it('a write refused with 403 is forbidden; a local refusal is not', () => {
    expect(isWriteForbidden(permissionsErrorFromResponse(403, problem('forbidden', 403)))).toBe(
      true
    );
    expect(isWriteForbidden(precondition('read_only'))).toBe(false);
  });
});
