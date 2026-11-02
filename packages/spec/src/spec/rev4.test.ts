/**
 * What rev 4 of the document says, as assertions: the approval visibility rules, and the additions that
 * came out of the first two consumers.
 */
import { describe, expect, it } from 'vitest';

import { loadSpec, operationsOf } from './load.js';
import type { JsonObject } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';
import { obj, str } from './testing.js';
import { SpecIndex } from './validate.js';

const doc = loadSpec(PUBLIC_SOURCE());
const paths = doc.paths as JsonObject;
const components = doc.components as JsonObject;
const schemas = components.schemas as Record<string, JsonObject>;
const parameters = components.parameters as Record<string, JsonObject>;
const flat = (text: unknown): string => str(text as never).replace(/\s+/g, ' ');
const op = (path: string, method: string): JsonObject =>
  obj((paths[path] as JsonObject)[method], `${method} ${path}`);
const parameterRefs = (operation: JsonObject): string[] =>
  ((operation.parameters ?? []) as JsonObject[]).map((p) => str((p.$ref ?? p.name) as never));

describe('approval visibility', () => {
  it('gives Approval an optional continuation that is the Continuation schema, and states who sees it', () => {
    const approval = obj(schemas.Approval, 'Approval');
    const continuation = (approval.properties as JsonObject).continuation as JsonObject;
    expect(continuation.$ref).toBe('#/components/schemas/Continuation');
    expect(approval.required as string[]).not.toContain('continuation');
    expect(flat(approval.description)).toContain(
      'is present only when the reader is the principal that created the approval, in every state'
    );
    expect((approval.properties as JsonObject).continuation_kind).toBeDefined();
  });

  it('echoes a continuation as the same JSON value, not the same bytes, wherever it is echoed', () => {
    const member = (name: string): string => {
      const schema = obj(schemas[name], name);
      const continuation = obj(
        (schema.properties as JsonObject).continuation,
        `${name}.continuation`
      );
      return flat(continuation.description);
    };
    for (const name of ['Approval', 'Resumption']) {
      const text = member(name);
      expect(text, name).toContain('the same JSON value, not the same bytes');
      expect(text, name).toContain(
        'insignificant whitespace are not preserved and carry no meaning'
      );
    }
    expect(flat(obj(schemas.Continuation, 'Continuation').description)).toContain(
      'two continuations are the same when their RFC 8785 canonical forms are equal'
    );
    expect(flat(op('/v1/decisions', 'post').description)).toContain(
      'the same JSON value; member order does not matter'
    );
    expect(JSON.stringify(doc)).not.toMatch(/byte[- ]identical|byte for byte/i);
  });

  it('adds created_by, with the single value me, to the list and the stream', () => {
    const created = obj(parameters.CreatedBy, 'CreatedBy');
    expect(created).toMatchObject({ name: 'created_by', in: 'query' });
    expect((created.schema as JsonObject).enum).toEqual(['me']);
    for (const [path, method] of [
      ['/v1/approvals', 'get'],
      ['/v1/approvals/stream', 'get'],
    ] as const)
      expect(parameterRefs(op(path, method)), path).toContain('#/components/parameters/CreatedBy');
  });

  it('documents a 400 on the stream, for a created_by that is not me', () => {
    const responses = op('/v1/approvals/stream', 'get').responses as JsonObject;
    expect(responses['400']).toEqual({ $ref: '#/components/responses/BadRequest' });
  });

  it('states the service-principal rule once in the description of the API and references it from each read', () => {
    const description = flat((doc.info as JsonObject).description);
    expect(description).toContain('**Who sees an approval.**');
    expect(description).toContain(
      'A service principal (kind `service`) sees only the approvals it created'
    );
    expect(description).toContain(
      'is 404 `not_found`, exactly as for an approval of another organisation'
    );
    expect(description).toContain(
      'withdraw and consume, and `POST /v1/records` and `POST /v1/records/batch` with an `approval_id`, answer 404 `not_found` to a service principal that did not create it'
    );
    expect(description).toContain("orphans the old one's open approvals");
    for (const [path, method] of [
      ['/v1/approvals', 'get'],
      ['/v1/approvals/{id}', 'get'],
      ['/v1/approvals/{id}/wait', 'get'],
      ['/v1/approvals/stream', 'get'],
      ['/v1/approvals/{id}/resumption', 'get'],
    ] as const)
      expect(flat(op(path, method).description), `${method} ${path}`).toContain(
        'Who sees an approval'
      );
    const tags = (doc.tags as JsonObject[]).find((t) => t.name === 'Approvals');
    expect(flat(tags?.description)).toContain('Who sees an approval');
  });

  it('requires an approval id to be unguessable, where the 403 exception is described and on both id members', () => {
    const description = flat((doc.info as JsonObject).description);
    expect(description).toContain('So the 403 relies on the id being unguessable');
    // The 404 is not claimed to hide an id: the organisation's records list can carry one.
    expect(description).not.toContain('learns from no list or read');
    expect(description).toContain('the `approval_id` member of the records the organisation');
    // The check follows the request's own validation, as the mock orders it.
    expect(description).toContain('once the request itself is valid and before any other check');
    expect(description).toContain('an approval `id` MUST be unguessable');
    expect(description).toContain(
      'not sequential and not derivable from the action, the scope or any other value a caller can compute'
    );
    for (const name of ['Approval', 'ApprovalHandle']) {
      const id = obj((obj(schemas[name], name).properties as JsonObject).id, `${name}.id`);
      const text = flat(id.description);
      expect(text, name).toContain('It MUST be unguessable');
      expect(text, name).toContain('not sequential and not derivable from the action');
      expect(text, name).toContain('relies on this');
    }
  });
});

describe('degraded records', () => {
  const degraded = obj(schemas.Degraded, 'Degraded');
  const members = degraded.properties as Record<string, JsonObject>;

  it('is a closed object of reason, status and request_id, with no kind, and requires the reason only', () => {
    expect(degraded.additionalProperties).toBe(false);
    expect(degraded.required).toEqual(['reason']);
    expect(Object.keys(members)).toEqual(['reason', 'status', 'request_id']);
  });

  it('bounds each member: a code for the reason, an error status, a request id of 1 to 128 characters', () => {
    expect(members.reason?.pattern).toBe('^[a-z][a-z0-9_]{0,63}$');
    expect(members.status).toMatchObject({ type: 'integer', minimum: 400, maximum: 599 });
    expect(members.request_id).toMatchObject({ type: 'string', minLength: 1, maxLength: 128 });
  });

  it('admits the documented codes and no hostname, URL, stack trace or free text', () => {
    const pattern = new RegExp(str(members.reason?.pattern));
    for (const code of ['timeout', 'unreachable', 'http_error', 'no_token', 'internal_error'])
      expect(pattern.test(code), code).toBe(true);
    for (const text of [
      'api.example.com',
      'https://host/x',
      'unreachable: refused',
      'timed out',
      'Timeout',
      '',
    ])
      expect(pattern.test(text), text).toBe(false);
    expect(pattern.test('a'.repeat(64))).toBe(true);
    expect(pattern.test('a'.repeat(65))).toBe(false);
  });

  it('names the documented codes, says a reader tolerates an unknown one, and says reason is never free text', () => {
    const text = flat(degraded.description);
    for (const code of ['timeout', 'unreachable', 'http_error', 'no_token', 'internal_error'])
      expect(text, code).toContain(`\`${code}\``);
    expect(text).toContain('`reason` is a code, never free text');
    expect(text).toContain('a reader tolerates one it does not know');
    expect(text).toContain('is `asserted`, like every record appended through `/v1`');
  });

  it('is an optional member of Record and RecordCreate, and a degraded RecordCreate refuses a policy', () => {
    for (const name of ['Record', 'RecordCreate']) {
      const schema = obj(schemas[name], name);
      expect(((schema.properties as JsonObject).degraded as JsonObject).$ref, name).toBe(
        '#/components/schemas/Degraded'
      );
      expect(schema.required as string[], name).not.toContain('degraded');
    }
    // The rule is the same on the request and on the response.
    for (const name of ['Record', 'RecordCreate']) {
      const schema = obj(schemas[name], name);
      expect(schema.if, name).toEqual({ required: ['degraded'] });
      expect(schema.then, name).toEqual({ not: { required: ['policy'] } });
    }
    const create = obj(schemas.RecordCreate, 'RecordCreate');
    expect(flat(((create.properties as JsonObject).degraded as JsonObject).description)).toContain(
      '`policy` must be absent (400 `invalid_request` otherwise)'
    );
  });

  it('a Record that carries degraded and a policy does not validate; a degraded Record without one does, and Degraded stays closed', () => {
    const index = new SpecIndex(doc);
    const record = {
      id: 'rec_1',
      ts: '2026-10-05T00:00:00Z',
      actor: { id: 'svc', kind: 'service' },
      tool_ref: 'ext:t:x',
      decision: 'allow',
      attestation: 'asserted',
    };
    const degraded = { reason: 'timeout' };
    const validate = index.schema('Record');
    expect(validate({ ...record, degraded })).toBe(true);
    expect(validate({ ...record, degraded, policy: { id: 'p', version: 1 } })).toBe(false);
    expect(validate({ ...record, policy: { id: 'p', version: 1 } })).toBe(true);
    expect(validate({ ...record, degraded: { reason: 'timeout', extra: 1 } })).toBe(false);
    expect(
      flat(
        ((obj(schemas.Record, 'Record').properties as JsonObject).degraded as JsonObject)
          .description
      )
    ).toContain(
      'a deployment returns the members `Degraded` defines'.replace('a deployment', 'A deployment')
    );
  });

  it('adds the degraded filter, true or false, to the list of records', () => {
    const parameter =
      (op('/v1/records', 'get').parameters as JsonObject[]).find((p) => p.name === 'degraded') ??
      {};
    expect(parameter.in).toBe('query');
    expect((parameter.schema as JsonObject).enum).toEqual(['true', 'false']);
  });

  it('documents the fallback semantics on the append route', () => {
    const text = flat(op('/v1/records', 'post').description);
    expect(text).toContain("The record's `decision` is then the fallback the caller applied");
    expect(text).toContain('carries no `policy`');
  });
});

describe('problems, server failures and batch limits', () => {
  const registry = (doc.info as JsonObject)['x-noblecloak-problem-types'] as Record<
    string,
    JsonObject
  >;
  const responses = components.responses as Record<string, JsonObject>;
  const operations = (): [string, string, JsonObject][] =>
    operationsOf(doc).map(([path, method, operation]) => [path, method, operation]);

  it('requires a request_id on every problem, and declares the max_items extension member', () => {
    const problem = obj(schemas.Problem, 'Problem');
    expect(problem.required).toEqual(['type', 'title', 'status', 'request_id']);
    expect((problem.properties as JsonObject).request_id).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect((problem.properties as JsonObject).max_items).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    });
    expect(flat(doc.info && (doc.info as JsonObject).description)).toContain(
      'Every problem this API produces carries `request_id`'
    );
  });

  it.each([
    ['internal_error', 500],
    ['service_unavailable', 503],
    ['reserved_tool_ref', 422],
    ['system_tool_ref', 422],
    ['side_effect_level_downgrade', 409],
    ['batch_too_large', 400],
  ])('registers %s with status %i', (type, status) => {
    expect(registry[type]?.status).toBe(status);
  });

  it('answers a server failure on every operation, with the same two shared responses', () => {
    const all = operations();
    expect(all.length).toBeGreaterThan(50);
    for (const [path, method, operation] of all) {
      const answers = operation.responses as JsonObject;
      expect(answers['500'], `${method} ${path}`).toEqual({
        $ref: '#/components/responses/InternalError',
      });
      expect(answers['503'], `${method} ${path}`).toEqual({
        $ref: '#/components/responses/ServiceUnavailable',
      });
    }
    expect(responses.InternalError?.['x-noblecloak-problem-types']).toEqual(['internal_error']);
    expect(responses.ServiceUnavailable?.['x-noblecloak-problem-types']).toEqual([
      'service_unavailable',
    ]);
  });

  it('documents Retry-After on the 503 as a response header', () => {
    const headers = obj(responses.ServiceUnavailable?.headers, 'headers');
    expect(Object.keys(headers)).toEqual(['Retry-After']);
    expect((headers['Retry-After'] as JsonObject).schema).toMatchObject({ type: 'integer' });
    expect(responses.InternalError?.headers).toBeUndefined();
  });

  it('keeps maxItems 100 on both batch requests and registers batch_too_large on both batch routes', () => {
    expect((schemas.DecisionBatchRequest?.properties as JsonObject).requests).toMatchObject({
      maxItems: 100,
    });
    expect((schemas.RecordBatchRequest?.properties as JsonObject).records).toMatchObject({
      maxItems: 100,
    });
    for (const path of ['/v1/decisions/batch', '/v1/records/batch']) {
      const ref = str(((op(path, 'post').responses as JsonObject)['400'] as JsonObject).$ref);
      expect(responses[ref.split('/').pop() ?? '']?.['x-noblecloak-problem-types'], path).toEqual(
        expect.arrayContaining(['invalid_request', 'batch_too_large'])
      );
    }
  });

  it('advertises batch limits on the capabilities as optional integers of 1 to 100 with no default', () => {
    const limits = (obj(schemas.Capabilities, 'Capabilities').properties as JsonObject)
      .limits as JsonObject;
    expect(limits.additionalProperties).toBe(false);
    expect(limits.required).toBeUndefined();
    // The three batch limits (rev 6 added resolutions) and, since rev 6, the bound on stored arguments.
    expect(Object.keys(limits.properties as JsonObject)).toEqual([
      'decisions_batch_max_items',
      'records_batch_max_items',
      'resolutions_batch_max_items',
      'approval_arguments_max_bytes',
    ]);
    const members = limits.properties as Record<string, JsonObject>;
    for (const name of [
      'decisions_batch_max_items',
      'records_batch_max_items',
      'resolutions_batch_max_items',
    ]) {
      expect(members[name]).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
    }
    for (const member of Object.values(members)) {
      expect(member).not.toHaveProperty('default');
    }
    expect(members.approval_arguments_max_bytes).toMatchObject({ type: 'integer', minimum: 1 });
    expect(members.approval_arguments_max_bytes).not.toHaveProperty('maximum');
    expect((schemas.Capabilities?.required as string[]).includes('limits')).toBe(false);
  });

  it('puts the tool-reference and side-effect-level problems on the tool routes', () => {
    const post = op('/v1/tools', 'post').responses as JsonObject;
    expect(post['422']).toEqual({ $ref: '#/components/responses/UnprocessableToolRef' });
    expect(post['409']).toEqual({ $ref: '#/components/responses/ConflictToolLevel' });
    expect(
      ((op('/v1/tools/{id}', 'patch').responses as JsonObject)['409'] as JsonObject).$ref
    ).toBe('#/components/responses/ConflictToolLevel');
    expect(responses.UnprocessableToolRef?.['x-noblecloak-problem-types']).toEqual([
      'reserved_tool_ref',
      'system_tool_ref',
      'tool_ref_in_use',
    ]);
    expect(responses.ConflictToolLevel?.['x-noblecloak-problem-types']).toEqual([
      'side_effect_level_downgrade',
    ]);
  });

  it('states the side-effect ranking once, on SideEffectLevel, with write and external tied, and references it from the operations', () => {
    const level = flat(obj(schemas.SideEffectLevel, 'SideEffectLevel').description);
    expect(level).toContain('`read` < `write` = `external` < `delete` < `admin`');
    expect(level).toContain('a tie counts as no change');
    expect(level).toContain('between `write` and `external` in either direction, is allowed');
    expect(obj(schemas.SideEffectLevel, 'SideEffectLevel').enum).toEqual([
      'read',
      'write',
      'delete',
      'external',
      'admin',
    ]);
    for (const operation of [op('/v1/tools', 'post'), op('/v1/tools/{id}', 'patch')]) {
      const text = flat(operation.description);
      expect(text).toContain('The ranking is on `SideEffectLevel`');
      expect(text).toContain('strictly lower rank');
      expect(text).not.toContain('in the order of the vocabulary');
    }
    expect(flat(registry.side_effect_level_downgrade?.title)).toContain('equal rank');
  });

  it('does not name the reserved namespaces, only that a deployment reserves some', () => {
    const text = flat(op('/v1/tools', 'post').description);
    expect(text).toContain('a namespace this deployment reserves');
    expect(flat(registry.reserved_tool_ref?.title)).toContain(
      'a namespace this deployment reserves'
    );
  });
});

describe('the AuthZEN pin', () => {
  const evaluation = op('/access/v1/evaluation', 'post');

  it('is x-noblecloak-authzen-version on the evaluation operation, with the version as its value', () => {
    expect(evaluation['x-noblecloak-authzen-version']).toBe('AuthZEN Authorization API 1.0');
  });

  it('is named nowhere under its old key, and nowhere else under the new one', () => {
    const text = JSON.stringify(doc);
    expect(text).not.toContain('x-noblecloak-authzen-draft');
    expect(text.split('x-noblecloak-authzen-version').length - 1).toBe(1);
  });

  it('says in the description that this is the Final Specification and not a draft', () => {
    const text = flat(evaluation.description);
    expect(text).toContain(
      "the OpenID Foundation's Final Specification (approved 2026-01-12), not a draft"
    );
    expect(text).toContain('`resource.type` is `tool`');
  });
});

describe('the approval handle', () => {
  const handle = obj(schemas.ApprovalHandle, 'ApprovalHandle');
  const properties = handle.properties as Record<string, JsonObject>;

  it('says that a caller with resume_token_will_issue false has nothing to consume and must not execute the action', () => {
    const text = flat(properties.resume_token_will_issue?.description);
    expect(text).toContain('When it is `false` the caller will receive no `resume_token`');
    expect(text).toContain('must not execute the action itself');
    expect(text).toContain('the deployment executes the tool');
    expect(flat(op('/v1/decisions', 'post').description)).toContain(
      'when it is `false` the caller has nothing to consume and must not execute the action itself'
    );
  });

  it('requires the five members a caller reads', () => {
    expect(handle.required).toEqual([
      'id',
      'state',
      'created',
      'created_at',
      'resume_token_will_issue',
    ]);
  });
});
