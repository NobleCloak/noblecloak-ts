import { describe, expect, it } from 'vitest';

import { loadSpec } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';
import { SpecIndex, describeErrors } from './validate.js';

const index = new SpecIndex(loadSpec(PUBLIC_SOURCE()));

describe('SpecIndex.match', () => {
  it('finds an operation by method and concrete path', () => {
    expect(index.match('POST', '/v1/approvals/abc/resolve')?.operationId).toBe('resolveApproval');
    expect(index.match('get', '/v1/approvals/abc')?.operationId).toBe('getApproval');
  });

  it('prefers the more specific template: /approvals/stream is not an approval id', () => {
    expect(index.match('GET', '/v1/approvals/stream')?.operationId).toBe('streamApprovals');
    expect(index.match('GET', '/v1/records/verify')?.operationId).toBe('verifyRecords');
    expect(index.match('GET', '/v1/records/rec_1')?.operationId).toBe('getRecord');
  });

  it('knows nothing of an undocumented route or method', () => {
    expect(index.match('GET', '/v1/nowhere')).toBeUndefined();
    expect(index.match('DELETE', '/v1/approvals/abc')).toBeUndefined();
  });

  it('reports where each route is served and whether it is authenticated', () => {
    const jwks = index.match('GET', '/.well-known/jwks.json');
    expect(jwks).toMatchObject({ deployment: 'both', authenticated: false });
    const verify = index.match('GET', '/v1/records/verify');
    expect(verify).toMatchObject({
      deployment: 'hosted',
      entitlement: 'records.verify',
      authenticated: true,
    });
  });
});

describe('validators', () => {
  it('validate a request body against the document, through a $ref', () => {
    const decide = index.match('POST', '/v1/decisions');
    const validate =
      decide === undefined ? undefined : index.requestBody(decide, 'application/json');
    expect(validate?.({ action: { tool_ref: 't', arguments: {} } })).toBe(true);
    expect(validate?.({ action: { arguments: {} } })).toBe(false);
    expect(validate === undefined ? '' : describeErrors(validate)).toMatch(/tool_ref|oneOf/);
  });

  it('enforce oneOf: arg_digest or arguments, not both and not neither', () => {
    const action = index.schema('Action');
    expect(action({ tool_ref: 't', arg_digest: 'a'.repeat(64) })).toBe(true);
    expect(action({ tool_ref: 't', arguments: {}, arg_digest: 'a'.repeat(64) })).toBe(false);
    expect(action({ tool_ref: 't' })).toBe(false);
    expect(action({ tool_ref: 't', arg_digest: 'ABC' })).toBe(false);
  });

  it('enforce the push continuation rule and the tool-invocation legality matrix', () => {
    const continuation = index.schema('Continuation');
    expect(continuation({ kind: 'webhook', delivery: 'push' })).toBe(false);
    expect(
      continuation({ kind: 'webhook', delivery: 'push', callback_url: 'https://x.test/h' })
    ).toBe(true);
    expect(
      continuation({ kind: 'webhook', delivery: 'push', callback_url: 'http://x.test/h' })
    ).toBe(false);
    const config = index.schema('ToolInvocationConfig');
    expect(config({ mode: 'ask', on_deny: 'halt', expires_after: 'PT1H' })).toBe(true);
    expect(config({ mode: 'always_allow', on_deny: 'halt' })).toBe(false);
    expect(config({ mode: 'deny', approver_groups: ['g'] })).toBe(false);
  });

  it('look up a response by status and media type', () => {
    const decide = index.match('POST', '/v1/decisions');
    if (decide === undefined) throw new Error('decide missing');
    expect(index.response(decide, 200, 'application/json').validate).toBeDefined();
    expect(index.response(decide, 401, 'application/problem+json').validate).toBeDefined();
    expect(index.response(decide, 200, 'text/plain')).toEqual({
      documented: true,
      validate: undefined,
    });
    expect(index.response(decide, 418, 'application/json').documented).toBe(false);
    expect(index.responseStatuses(decide)).toContain('409');
    expect(index.requestContentTypes(decide)).toEqual(['application/json']);
  });

  it('a problem body validates against the Problem schema through a shared response', () => {
    const resolve = index.match('POST', '/v1/approvals/x/resolve');
    if (resolve === undefined) throw new Error('resolve missing');
    const { validate } = index.response(resolve, 409, 'application/problem+json');
    expect(
      validate?.({
        type: 'https://docs.noblecloak.com/problems/approval_conflict',
        title: 't',
        status: 409,
        request_id: 'req_1',
      })
    ).toBe(true);
    expect(validate?.({ title: 't' })).toBe(false);
    // Rev 4: every problem carries a request id.
    expect(
      validate?.({
        type: 'https://docs.noblecloak.com/problems/approval_conflict',
        title: 't',
        status: 409,
      })
    ).toBe(false);
  });
});

describe('SpecIndex rejectUndeclared', () => {
  const handle = {
    id: 'a',
    state: 'pending',
    created: true,
    created_at: '2026-10-04T00:00:00.000Z',
    expires_at: null,
    resume_token_will_issue: false,
  };

  it('accepts an undeclared field by default and rejects it when asked', () => {
    const open = new SpecIndex(loadSpec(PUBLIC_SOURCE())).schema('ApprovalHandle');
    const closed = new SpecIndex(loadSpec(PUBLIC_SOURCE()), { rejectUndeclared: true }).schema(
      'ApprovalHandle'
    );
    expect(open(handle)).toBe(true);
    expect(open({ ...handle, surprise: 1 })).toBe(true);
    expect(closed(handle)).toBe(true);
    expect(closed({ ...handle, surprise: 1 })).toBe(false);
    expect(describeErrors(closed)).toMatch(/additional properties/);
  });

  it('leaves a schema that is open on purpose open', () => {
    const closed = new SpecIndex(loadSpec(PUBLIC_SOURCE()), { rejectUndeclared: true });
    const action = closed.schema('Action');
    expect(action({ tool_ref: 't', arguments: { anything: { goes: true } } })).toBe(true);
  });
});
