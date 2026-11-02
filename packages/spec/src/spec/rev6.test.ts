/**
 * What rev 6 of the document says, as assertions: who is named on an approval and why a read shows no
 * arguments, the stream and list filters, batch resolve, the problem members and the 413, the capability
 * members, and the narrowing of principal-owned tools.
 */
import { describe, expect, it } from 'vitest';

import { loadScenarios } from '../conformance/scenarios.js';
import { MATRIX } from '../conformance/matrix.js';
import { loadSpec } from './load.js';
import type { JsonObject } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';
import { obj, str } from './testing.js';

const doc = loadSpec(PUBLIC_SOURCE());
const paths = doc.paths as JsonObject;
const components = doc.components as JsonObject;
const schemas = components.schemas as Record<string, JsonObject>;
const parameters = components.parameters as Record<string, JsonObject>;
const responses = components.responses as Record<string, JsonObject>;
const registry = (doc.info as JsonObject)['x-noblecloak-problem-types'] as Record<
  string,
  JsonObject
>;
const flat = (text: unknown): string => str(text as never).replace(/\s+/g, ' ');
const op = (path: string, method: string): JsonObject =>
  obj((paths[path] as JsonObject)[method], `${method} ${path}`);
const props = (name: string): Record<string, JsonObject> =>
  obj(schemas[name], name).properties as Record<string, JsonObject>;
const info = flat((doc.info as JsonObject).description);

describe('who is named on an approval', () => {
  it('NamedPrincipalRef has an optional display_name; PrincipalRef stays id and kind, with no name', () => {
    expect(obj(schemas.NamedPrincipalRef, 'NamedPrincipalRef').required).toEqual(['id', 'kind']);
    expect(props('NamedPrincipalRef').display_name).toMatchObject({ type: 'string', minLength: 1 });
    expect(obj(schemas.PrincipalRef, 'PrincipalRef').required).toEqual(['id', 'kind']);
    expect(props('PrincipalRef').display_name).toBeUndefined();
  });

  it('names a principal only inside an approval: records and the Resumption use the plain reference', () => {
    const named = '#/components/schemas/NamedPrincipalRef';
    const plain = '#/components/schemas/PrincipalRef';
    expect(props('Approval').requester).toMatchObject({ $ref: named });
    expect(props('Approval').approver).toMatchObject({ $ref: named });
    expect(props('Resumption').approver).toMatchObject({ $ref: plain });
    expect(props('Record').actor).toMatchObject({ $ref: plain });
  });

  it('Approval gains requester, arguments_state, waiting_on and agent.name, none of them required', () => {
    const approval = obj(schemas.Approval, 'Approval');
    const required = approval.required as string[];
    for (const member of ['requester', 'arguments_state', 'waiting_on'])
      expect(required, member).not.toContain(member);
    expect(props('Approval').requester).toMatchObject({
      $ref: '#/components/schemas/NamedPrincipalRef',
    });
    expect(props('Approval').arguments_state?.enum).toEqual([
      'shown',
      'not_enabled',
      'not_sent',
      'withheld',
      'final',
    ]);
    const waiting = obj(props('Approval').waiting_on, 'waiting_on');
    expect(waiting.required).toEqual(['count']);
    expect(obj((waiting.properties as JsonObject).principals).maxItems).toBe(5);
    const agent = obj(props('Approval').agent) as { properties: Record<string, JsonObject> };
    expect(agent.properties.name).toMatchObject({ type: 'string' });
    expect(obj(agent as unknown as JsonObject).required).toEqual(['id']);
  });

  it('says who sees the requester, the names and waiting_on, and what arguments_state discloses', () => {
    expect(info).toContain('**Who is named on an approval.**');
    expect(info).toContain('never the id repeated and never null');
    expect(info).toContain(
      'is absent when the deployment cannot name the principal, which is never an error'
    );
    expect(info).toContain("`Approval.waiting_on` is the creator's alone");
    expect(info).toContain('for a service-principal creator it is the count only');
    expect(info).toContain(
      '`Approval.arguments_state` says why a read shows what it shows, on `GET /v1/approvals/{id}` and on each approval of `GET /v1/approvals`'
    );
    expect(info).toContain(
      'is told `final` for an approval in a final state and `withheld` otherwise'
    );
    expect(info).not.toContain('reads from `GET /v1/tools`');
    expect(info).toContain('carry ids and kinds only (`PrincipalRef`), never names');
  });

  it('keeps the 503 for an eligibility the deployment cannot determine, and names it', () => {
    expect(info).toContain('503 `service_unavailable`, never the digest-only view');
    expect(info).toContain('the documented value is `eligibility_lookup`');
    expect(flat(op('/v1/approvals/{id}', 'get').description)).toContain('`reason`');
  });
});

describe('the problem members and the 413', () => {
  it('Problem gains retry_after_seconds, reason and max_bytes, all optional', () => {
    const problem = obj(schemas.Problem, 'Problem');
    expect(problem.required).toEqual(['type', 'title', 'status', 'request_id']);
    expect(props('Problem').retry_after_seconds).toMatchObject({ type: 'integer', minimum: 0 });
    expect(props('Problem').reason).toMatchObject({
      type: 'string',
      pattern: '^[a-z][a-z0-9_]{0,63}$',
    });
    expect(props('Problem').max_bytes).toMatchObject({ type: 'integer', minimum: 1 });
  });

  it('says the hint is in the body and that Retry-After and X-Request-Id SHOULD be exposed to browsers', () => {
    expect(info).toContain(
      '`Problem.retry_after_seconds` is present on every `service_unavailable` and `rate_limited` problem that carries the `Retry-After` header, equal to it'
    );
    expect(info).toContain(
      'SHOULD list `Retry-After` and `X-Request-Id` in `Access-Control-Expose-Headers`'
    );
    expect(responses.TooManyRequests?.headers).toHaveProperty('Retry-After');
  });

  it('registers payload_too_large (413) and puts it on every operation that takes a body', () => {
    expect(registry.payload_too_large).toMatchObject({ status: 413 });
    expect(responses.PayloadTooLarge?.['x-noblecloak-problem-types']).toEqual([
      'payload_too_large',
    ]);
    const missing: string[] = [];
    for (const [path, item] of Object.entries(paths))
      for (const [method, operation] of Object.entries(item as JsonObject)) {
        const o = operation as JsonObject;
        if (o.requestBody === undefined) continue;
        if ((o.responses as JsonObject)['413'] === undefined) missing.push(`${method} ${path}`);
      }
    expect(missing).toEqual([]);
  });

  it('a run_id on a deployment that does not advertise runs is 404, and the operations that take one can say so', () => {
    expect(info).toContain('A deployment that does not advertise `runs` has no run to name');
    for (const [path, method] of [
      ['/v1/decisions', 'post'],
      ['/v1/decisions/batch', 'post'],
      ['/v1/approvals', 'post'],
    ] as const)
      expect((op(path, method).responses as JsonObject)['404'], path).toBeDefined();
  });

  it('keeps the AGT media type mandatory and says so, with the refusal of an event it cannot map', () => {
    const text = flat(op('/v1/records', 'post').description);
    expect(text).toContain('by every deployment, since records are in the floor');
    expect(text).toContain('an event the deployment cannot map is 400 `invalid_request`');
  });
});

describe('the approval queue filters and the batch resolve', () => {
  it('the list takes a state set and an order, the stream takes approver, state and created_by', () => {
    const names = (path: string): string[] =>
      (op(path, 'get').parameters as JsonObject[]).map(
        (p) => (p.name as string | undefined) ?? (p.$ref as string).split('/').pop() ?? ''
      );
    expect(names('/v1/approvals')).toEqual(
      expect.arrayContaining(['ApprovalStateSet', 'ApprovalOrder', 'approver', 'CreatedBy'])
    );
    expect(names('/v1/approvals/stream')).toEqual(
      expect.arrayContaining(['approver', 'ApprovalStateSet', 'CreatedBy'])
    );
    expect(parameters.ApprovalOrder?.schema).toMatchObject({
      enum: ['created_at', 'resolved_at'],
      default: 'created_at',
    });
    expect(flat(parameters.ApprovalStateSet?.description)).toContain('comma-separated set');
    // The set is written out as a pattern, so it cannot follow the enum by reference: pin it to the
    // states of the enum, so a state added to the enum without the pattern fails here.
    const alternatives = (obj(schemas.ApprovalState).enum as string[]).join('|');
    expect((parameters.ApprovalStateSet?.schema as JsonObject).pattern).toBe(
      `^(${alternatives})(,(${alternatives}))*$`
    );
    expect(flat(op('/v1/approvals/stream', 'get').description)).toContain(
      'eligibility does not depend on the state, so the event that resolves such an approval still arrives'
    );
  });

  it('POST /v1/approvals/resolve/batch takes at most 100 items, each a resolve with its digest, and answers per element', () => {
    const batch = op('/v1/approvals/resolve/batch', 'post');
    expect(batch.operationId).toBe('resolveApprovalsBatch');
    expect(batch['x-noblecloak-family']).toBe('approvals');
    expect(flat(batch.description)).toContain(
      'A service principal never resolves: the call is 403 `not_eligible` as a whole'
    );
    expect(props('ResolveBatchRequest').items).toMatchObject({ minItems: 1, maxItems: 100 });
    expect(obj(schemas.ResolveBatchItem, 'ResolveBatchItem').required).toEqual([
      'approval_id',
      'resolution',
      'expected_action_digest',
    ]);
    expect(obj(schemas.ResolveBatchResult, 'ResolveBatchResult').oneOf).toEqual([
      { $ref: '#/components/schemas/Approval' },
      { $ref: '#/components/schemas/Problem' },
    ]);
    expect(responses.BadRequestResolveBatch?.['x-noblecloak-problem-types']).toEqual([
      'invalid_request',
      'batch_too_large',
    ]);
  });
});

describe('what the capabilities may say about a restriction', () => {
  it('adds resolutions_batch_max_items, approval_arguments_max_bytes, continuation_deliveries and tool_registration', () => {
    const capabilities = props('Capabilities');
    expect(capabilities.continuation_deliveries).toMatchObject({
      type: 'array',
      items: { enum: ['push', 'pull', 'held'] },
    });
    expect(capabilities.tool_registration?.enum).toEqual(['any', 'administrators']);
    const required = obj(schemas.Capabilities, 'Capabilities').required as string[];
    for (const member of ['continuation_deliveries', 'tool_registration', 'limits'])
      expect(required, member).not.toContain(member);
    expect(flat(capabilities.tool_registration?.description)).toContain(
      'The per-tool setting `show_arguments_to_approvers` has no member of its own'
    );
  });
});

describe('principal-owned tools', () => {
  it('are visible to the registering principal and the administrators, and 404 for anyone else', () => {
    expect(flat(op('/v1/tools', 'get').description)).toContain(
      'listed only to the principal that registered it and to administrators'
    );
    expect(flat(op('/v1/tools', 'get').description)).toContain(
      'an administrator is a user, never a service principal'
    );
    expect(info).toContain('A service principal is never an administrator for visibility');
    expect(info).toContain("no other principal's `principal`-owned tools");
    expect(flat(op('/v1/tools/{id}', 'get').description)).toContain(
      'any other reader gets 404 `not_found`'
    );
    expect(flat(op('/v1/tools', 'get').description)).toContain(
      'answered as for a tool with no catalog row'
    );
  });
});

describe('the rev 6 scenarios', () => {
  const scenarios = loadScenarios();
  const ids = new Set(scenarios.map((s) => s.id));
  const NEW = [
    'approval-requester-is-the-creator',
    'approval-principals-carry-display-names',
    'approval-waiting-on-is-the-creators',
    'negative-eligibility-outage-is-named',
    'approvals-stream-for-approver',
    'negative-approver-filter-takes-only-me',
    'approvals-list-state-set-ordered-by-resolution',
    'negative-retry-hint-is-in-the-body',
    'resolve-batch-mixed-outcomes',
    'resolve-batch-order-preserved',
    'negative-resolve-batch-over-limit',
    'negative-oversized-body-is-413',
    'negative-tool-registration-refused-to-a-non-administrator',
    'negative-unserved-resolution-is-refused',
    'negative-undeclared-delivery-is-refused',
    'approval-arguments-beyond-the-advertised-bound',
    'tools-principal-owned-hidden-from-colleagues',
    'negative-principal-owned-tool-read-by-colleague-is-404',
    'negative-run-id-without-runs-served',
  ];

  it('are all present, and each negative among them is named by a row of the matrix', () => {
    for (const id of NEW) expect(ids.has(id), id).toBe(true);
    const named = new Set(MATRIX.flatMap((row) => row.fails));
    const unnamed = NEW.filter(
      (id) => scenarios.find((s) => s.id === id)?.tags.includes('negative') && !named.has(id)
    );
    expect(unnamed).toEqual([]);
  });

  it('every scenario that gates on a capability names a capability the contract has', () => {
    // loadScenarios throws on an unknown member; reaching here proves the loader accepted them all.
    expect(
      scenarios.filter((s) => s.advertises !== undefined).map((s) => s.advertises)
    ).not.toEqual([]);
  });
});
