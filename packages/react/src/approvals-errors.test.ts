import { loadDocument } from '@noblecloak/spec';
import { describe, expect, it } from 'vitest';

import {
  PROBLEM_KINDS,
  asUnavailable,
  codeOfType,
  detailNotRead,
  errorFromResponse,
  isRetryable,
  kindOfStatus,
  localConflict,
  makeError,
  malformed,
  networkError,
  retryAfterMs,
  sessionError,
} from './approvals-errors.js';

const problem = (code: string, status: number, extra: Record<string, unknown> = {}): unknown => ({
  type: `https://api.example/problems/${code}`,
  title: `title of ${code}`,
  status,
  request_id: 'req_1',
  ...extra,
});

describe('the known problem codes', () => {
  it("are exactly the contract's x-noblecloak-problem-types, each mapped as its status maps", () => {
    const spec = loadDocument();
    const info = spec.info as { 'x-noblecloak-problem-types': Record<string, { status: number }> };
    const documented = info['x-noblecloak-problem-types'];
    expect(Object.keys(PROBLEM_KINDS).sort()).toEqual(Object.keys(documented).sort());
    for (const [code, { status }] of Object.entries(documented)) {
      // The code table never disagrees with the status, so an unknown code and a known one behave alike.
      expect([code, PROBLEM_KINDS[code]]).toEqual([code, kindOfStatus(status)]);
    }
    // Loading the contract parses a large YAML document: slow when the machine is busy.
  }, 60_000);
});

describe('errorFromResponse', () => {
  it.each([
    [401, 'invalid_token', 'unauthorized'],
    [403, 'not_eligible', 'forbidden'],
    [404, 'not_found', 'not_found'],
    [409, 'approval_conflict', 'conflict'],
    [400, 'invalid_request', 'invalid_request'],
    [422, 'approval_unroutable', 'invalid_request'],
    [422, 'tool_ref_in_use', 'invalid_request'],
    [429, 'rate_limited', 'rate_limited'],
    [503, 'service_unavailable', 'unavailable'],
    [500, 'internal_error', 'unavailable'],
  ])("maps %i %s to %s and keeps the document's members", (status, code, kind) => {
    const error = errorFromResponse(status, problem(code, status));
    expect(error).toMatchObject({
      kind,
      code,
      status,
      requestId: 'req_1',
      type: `https://api.example/problems/${code}`,
    });
  });

  it('maps an unknown code by status and keeps the code and the type', () => {
    const error = errorFromResponse(409, problem('a_new_code', 409));
    expect(error).toMatchObject({ kind: 'conflict', code: 'a_new_code' });
    expect(errorFromResponse(422, problem('shiny_new', 422))).toMatchObject({
      kind: 'invalid_request',
    });
    expect(errorFromResponse(502, problem('shiny_new', 502))).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('uses the status as the code when there is no type, and says so in the title', () => {
    const error = errorFromResponse(503, {});
    expect(error).toMatchObject({ kind: 'unavailable', code: 'unavailable', status: 503 });
    expect(error.title).toContain('503');
  });

  it('answers a body that is not a problem document as malformed, unless the status drives behaviour', () => {
    expect(errorFromResponse(404, '<html>')).toMatchObject({ kind: 'malformed_response' });
    expect(errorFromResponse(409, undefined)).toMatchObject({ kind: 'malformed_response' });
    expect(errorFromResponse(503, '<html>bad gateway</html>')).toMatchObject({
      kind: 'unavailable',
    });
    expect(errorFromResponse(429, 'slow down')).toMatchObject({ kind: 'rate_limited' });
    expect(errorFromResponse(401, 'no')).toMatchObject({ kind: 'unauthorized' });
  });

  it('carries Retry-After only when it was readable', () => {
    expect(errorFromResponse(503, problem('service_unavailable', 503), '7')).toMatchObject({
      retryAfterMs: 7000,
    });
    expect(
      'retryAfterMs' in errorFromResponse(503, problem('service_unavailable', 503), null)
    ).toBe(false);
  });
});

describe('small helpers', () => {
  it('reads the last segment of a type URI', () => {
    expect(codeOfType('https://x/problems/approval_conflict')).toBe('approval_conflict');
    expect(codeOfType('https://x/problems/approval_conflict/?a=1#b')).toBe('approval_conflict');
    expect(codeOfType('')).toBe('');
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(' 0 ')).toBe(0);
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:05 GMT', Date.parse('2026-10-21T07:28:00Z'))).toBe(
      5000
    );
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:05 GMT', Date.parse('2026-10-22T00:00:00Z'))).toBe(
      0
    );
    expect(retryAfterMs('soon')).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });

  it('builds the local errors', () => {
    expect(networkError()).toMatchObject({ kind: 'network', local: true });
    expect(sessionError()).toMatchObject({ kind: 'unauthorized', local: true });
    expect(detailNotRead()).toMatchObject({
      kind: 'precondition',
      code: 'detail_not_read',
      local: true,
    });
    expect(localConflict('resolve_in_flight')).toMatchObject({ kind: 'conflict', local: true });
    expect(localConflict('already_resolved').title).not.toBe(
      localConflict('resolve_in_flight').title
    );
    expect(malformed(200, 'a list')).toMatchObject({ kind: 'malformed_response', status: 200 });
    expect(makeError('network', 'x', 't')).toEqual({ kind: 'network', code: 'x', title: 't' });
  });

  it('turns a failure into an unavailable error without losing what it knew', () => {
    const rate = errorFromResponse(429, problem('rate_limited', 429), '2');
    expect(asUnavailable(rate)).toMatchObject({
      kind: 'unavailable',
      code: 'rate_limited',
      status: 429,
      requestId: 'req_1',
      retryAfterMs: 2000,
    });
    expect(asUnavailable(networkError())).toMatchObject({ kind: 'unavailable', local: true });
    const already = errorFromResponse(503, problem('service_unavailable', 503));
    expect(asUnavailable(already)).toBe(already);
  });

  it('says which failures are retried on a timer', () => {
    expect(isRetryable(networkError())).toBe(true);
    expect(isRetryable(errorFromResponse(429, {}))).toBe(true);
    expect(isRetryable(errorFromResponse(503, {}))).toBe(true);
    expect(isRetryable(errorFromResponse(403, problem('forbidden', 403)))).toBe(false);
  });
});
