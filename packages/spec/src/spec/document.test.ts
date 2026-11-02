/**
 * The acceptance list for the document, as assertions: what the contract must contain and must not.
 */
import { describe, expect, it } from 'vitest';

import { HTTP_METHODS, loadSpec, operationsOf } from './load.js';
import type { Json, JsonObject } from './load.js';
import { FAMILIES, FLOOR_NAMES } from './families.js';
import { GATEWAY_HEADER_PREFIX, REJECTED_IDENTITY_HEADERS } from './gateway-header.js';
import { PUBLIC_SOURCE } from './paths.js';
import { obj, str } from './testing.js';

const doc = loadSpec(PUBLIC_SOURCE());
const paths = doc.paths as JsonObject;
const schemas = (doc.components as JsonObject).schemas as Record<string, JsonObject>;
const props = (name: string): string[] =>
  Object.keys((schemas[name]?.properties ?? {}) as JsonObject);
const op = (path: string, method: string): JsonObject => {
  const item = paths[path] as JsonObject | undefined;
  const found = item?.[method];
  if (typeof found !== 'object' || found === null || Array.isArray(found)) {
    throw new Error(`${method} ${path} is not in the document`);
  }
  return found;
};
const bodySchema = (operation: JsonObject): JsonObject => {
  const content = (operation.requestBody as JsonObject).content as JsonObject;
  return ((content['application/json'] as JsonObject).schema ?? {}) as JsonObject;
};

describe('the document contains', () => {
  it.each([
    ['post', '/v1/decisions'],
    ['post', '/v1/decisions/batch'],
    ['post', '/access/v1/evaluation'],
    ['get', '/.well-known/authzen-configuration'],
    ['post', '/v1/approvals'],
    ['get', '/v1/approvals'],
    ['get', '/v1/approvals/{id}'],
    ['post', '/v1/approvals/{id}/resolve'],
    ['post', '/v1/approvals/{id}/approve'],
    ['post', '/v1/approvals/{id}/deny'],
    ['post', '/v1/approvals/{id}/withdraw'],
    ['get', '/v1/approvals/{id}/wait'],
    ['get', '/v1/approvals/stream'],
    ['get', '/v1/approvals/{id}/resumption'],
    ['post', '/v1/approvals/{id}/consume'],
    ['post', '/v1/continuations/test'],
    ['post', '/v1/records'],
    ['post', '/v1/records/batch'],
    ['get', '/v1/records'],
    ['get', '/v1/records/{id}'],
    ['get', '/v1/records/{id}/chain'],
    ['post', '/v1/records/checkpoints'],
    ['get', '/v1/records/verify'],
    ['post', '/v1/evidence/exports'],
    ['post', '/v1/tools'],
    ['get', '/v1/capabilities'],
    ['get', '/v1/origins'],
    ['put', '/v1/origins'],
    ['get', '/.well-known/jwks.json'],
    ['post', '/v1/runs'],
    ['post', '/v1/agents'],
    ['put', '/v1/agents/{id}/principal'],
    ['delete', '/v1/agents/{id}/principal'],
    ['post', '/v1/policies/simulate'],
    ['post', '/v1/webhooks'],
  ])('%s %s', (method, path) => {
    expect(() => op(path, method)).not.toThrow();
  });

  it('serves every route family of the contract', () => {
    for (const prefix of [
      '/v1/policies',
      '/v1/connections',
      '/v1/tools',
      '/v1/principals',
      '/v1/edge',
    ]) {
      expect(
        Object.keys(paths).some((p) => p.startsWith(prefix)),
        prefix
      ).toBe(true);
    }
  });
});

describe('the document does not contain', () => {
  it('a POST /approvals/{id}/resume route', () => {
    expect(Object.keys(paths).filter((p) => p.endsWith('resume'))).toEqual([]);
    expect(Object.keys(paths)).not.toContain('/v1/approvals/{id}/resume');
  });

  it('prev_hash or hash on Record', () => {
    expect(props('Record')).not.toContain('prev_hash');
    expect(props('Record')).not.toContain('hash');
    expect(props('RecordCreate')).not.toContain('hash');
  });

  it('a principal_id a caller asserts about itself: the actor hint and the request bodies of a decision, a record and a simulation carry none', () => {
    for (const name of [
      'ActorHint',
      'DecisionRequest',
      'RecordCreate',
      'SimulateRequest',
      'SimulateSetRequest',
    ])
      expect(props(name), name).not.toContain('principal_id');
  });

  it('principal_id (rev 13) appears only where an agent is bound to a service principal, anywhere in the document', () => {
    // Every property or parameter named `principal_id`, by where it sits: components, paths, inline request and
    // response bodies, composed schemas and array items alike. A `$ref` is not followed; what it names is walked
    // where it is defined.
    const found: string[] = [];
    const walk = (node: Json, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => {
          walk(item, `${at}[${String(i)}]`);
        });
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      if ('principal_id' in ((node.properties ?? {}) as JsonObject))
        found.push(`${at}.properties.principal_id`);
      if (node.name === 'principal_id' && typeof node.in === 'string')
        found.push(`${at} (parameter)`);
      for (const [key, child] of Object.entries(node)) walk(child, `${at}.${key}`);
    };
    walk(doc, '#');
    // `AgentPrincipalWrite` is an administrator naming the principal to bind, never the caller's own identity;
    // so is the `principal_id` of a policy-set proposal (rev 14), which an administrator approves before the
    // deployment binds it.
    expect(found.sort()).toEqual([
      '#.components.schemas.Agent.properties.principal_id',
      '#.components.schemas.AgentPrincipalWrite.properties.principal_id',
      '#.components.schemas.PolicySetProposal.properties.agent.properties.principal_id',
    ]);
    expect(found.filter((where) => where.endsWith('(parameter)'))).toEqual([]);
  });

  it('an attestation field a caller may supply', () => {
    expect(props('RecordCreate')).not.toContain('attestation');
    expect(props('Record')).toContain('attestation');
  });
});

describe('the decision doors', () => {
  it('carry continuation? and expect_approval_id? on /decisions, and run_id? on both doors', () => {
    expect(props('DecisionRequest')).toEqual(
      expect.arrayContaining(['continuation', 'expect_approval_id', 'actor'])
    );
    expect(props('ActorHint')).toContain('run_id');
    expect(props('CreateApprovalRequest')).toContain('run_id');
    expect(props('DecisionRequest')).not.toContain('approval_id');
  });

  it('say that /decisions never consumes and /consume carries an action', () => {
    expect(str(op('/v1/decisions', 'post').description)).toContain('never consumes');
    expect((schemas.ConsumeRequest?.required as string[]).sort()).toEqual([
      'action',
      'resume_token',
    ]);
  });

  it('bind the tool and the obligation kind into the Resumption', () => {
    expect(props('Resumption')).toEqual(
      expect.arrayContaining([
        'tool_ref',
        'obligation_kind',
        'action_digest',
        'resume_token',
        'continuation',
        'signature',
      ])
    );
    expect(schemas.Resumption?.required).toEqual(
      expect.arrayContaining(['tool_ref', 'obligation_kind'])
    );
    expect(schemas.Resumption?.required).not.toContain('resume_token');
  });

  it('take no identity from a body: the create-approval body refuses unknown fields', () => {
    expect(schemas.CreateApprovalRequest?.additionalProperties).toBe(false);
    expect(bodySchema(op('/v1/approvals', 'post'))).toEqual({
      $ref: '#/components/schemas/CreateApprovalRequest',
    });
  });
});

describe('runs', () => {
  it('carry kind and the scope propagation rule in prose, and document governed as 405', () => {
    expect(props('Run')).toEqual(expect.arrayContaining(['kind', 'scope_id']));
    const run = op('/v1/runs', 'post');
    expect(str(run.description)).toMatch(/fresh `scope_id`/);
    expect(Object.keys(run.responses as JsonObject)).toContain('405');
  });
});

describe('every operation', () => {
  const operations = operationsOf(doc);

  it('is tagged with where it is served', () => {
    expect(operations.length).toBeGreaterThan(50);
    for (const [path, method, operation] of operations) {
      expect(['both', 'hosted'], `${method} ${path}`).toContain(
        operation['x-noblecloak-deployment']
      );
    }
  });

  it('has a unique operationId', () => {
    const ids = operations.map(([, , o]) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks the paid routes with their entitlement', () => {
    const entitlements = Object.fromEntries(
      operations
        .filter(([, , o]) => o['x-noblecloak-entitlement'] !== undefined)
        .map(([p, m, o]) => [`${m} ${p}`, o['x-noblecloak-entitlement']])
    );
    expect(entitlements).toEqual({
      'post /v1/records/checkpoints': 'records.verify',
      'get /v1/records/verify': 'records.verify',
      'post /v1/evidence/exports': 'evidence.export',
    });
  });

  it('tags the entitlement of GET /v1/policies on the one parameter value that needs it, not on the whole route', () => {
    const list = op('/v1/policies', 'get');
    expect(list['x-noblecloak-entitlement']).toBeUndefined();
    expect(list['x-noblecloak-deployment']).toBe('both');
    const source = (list.parameters as JsonObject[]).find((p) => p.name === 'source');
    expect(source?.['x-noblecloak-entitlement-for-values']).toEqual({
      suggested: 'policies.suggested',
    });
    expect(str(list.description)).toContain('only `source=suggested` is paid');
  });

  it('documents a 404 not_available_on_deployment on every hosted operation', () => {
    for (const [path, method, operation] of operations) {
      if (operation['x-noblecloak-deployment'] !== 'hosted') continue;
      let notFound = (operation.responses as JsonObject)['404'] as JsonObject | undefined;
      const ref = notFound?.$ref;
      if (typeof ref === 'string') {
        notFound = (doc.components as JsonObject).responses as JsonObject;
        notFound = notFound[ref.split('/').pop() ?? ''] as JsonObject | undefined;
      }
      expect(notFound?.['x-noblecloak-problem-types'], `${method} ${path}`).toContain(
        'not_available_on_deployment'
      );
    }
  });

  it('only uses HTTP methods the lint recognises', () => {
    for (const item of Object.values(paths)) {
      for (const key of Object.keys(item as JsonObject)) {
        if (!['parameters', 'summary', 'description', 'servers'].includes(key)) {
          expect(HTTP_METHODS as readonly string[]).toContain(key);
        }
      }
    }
  });
});

describe('auth', () => {
  it('has the bearer scheme only, and the unauthenticated discovery routes opt out', () => {
    const schemes = ((doc.components as JsonObject).securitySchemes ?? {}) as JsonObject;
    expect(Object.keys(schemes)).toEqual(['bearer']);
    expect(doc.security).toEqual([{ bearer: [] }]);
    for (const [path, method, operation] of operationsOf(doc)) {
      const open = operation.security as Json[] | undefined;
      if (open !== undefined) {
        expect(
          ['/.well-known/authzen-configuration', '/.well-known/jwks.json'],
          `${method} ${path}`
        ).toContain(path);
      }
    }
  });

  it('marks the machine flow specified', () => {
    const bearer = ((doc.components as JsonObject).securitySchemes as JsonObject)
      .bearer as JsonObject;
    const acquisition = bearer['x-noblecloak-token-acquisition'] as JsonObject;
    expect((acquisition.machine as JsonObject)['x-noblecloak-status']).toBe('specified');
  });

  it('names the gateway identity-header prefix a caller is refused for, in the prose and the bearer scheme', () => {
    const info = str((doc.info as JsonObject).description);
    expect(info).toContain(`\`${GATEWAY_HEADER_PREFIX}\``);
    const bearer = ((doc.components as JsonObject).securitySchemes as JsonObject)
      .bearer as JsonObject;
    expect(str(bearer.description)).toContain(GATEWAY_HEADER_PREFIX);
  });

  it('names all five rejected identity headers and the problem type in the prose and the bearer scheme', () => {
    expect(REJECTED_IDENTITY_HEADERS).toHaveLength(5);
    const bearer = ((doc.components as JsonObject).securitySchemes as JsonObject)
      .bearer as JsonObject;
    for (const text of [str((doc.info as JsonObject).description), str(bearer.description)]) {
      const flat = text.replace(/\s+/g, ' ');
      for (const name of REJECTED_IDENTITY_HEADERS) expect(flat).toContain(`\`${name}\``);
      expect(flat).toContain('header_identity_rejected');
    }
  });

  it('names all five headers in the shared 401 description, and names no header or prefix in the header_identity_rejected title', () => {
    const types = (doc.info as JsonObject)['x-noblecloak-problem-types'] as JsonObject;
    const unauthorized = ((doc.components as JsonObject).responses as JsonObject)
      .Unauthorized as JsonObject;
    const flat = str(unauthorized.description).replace(/\s+/g, ' ');
    for (const name of REJECTED_IDENTITY_HEADERS) expect(flat).toContain(name);
    const title = str((types.header_identity_rejected as JsonObject).title);
    expect(title).not.toContain(GATEWAY_HEADER_PREFIX);
    expect(title).not.toMatch(/\bx-/i);
    for (const name of REJECTED_IDENTITY_HEADERS) expect(title).not.toContain(name);
  });

  it('states that aud is the govern origin exactly, in the Authentication paragraph and on the bearer scheme', () => {
    const bearer = ((doc.components as JsonObject).securitySchemes as JsonObject)
      .bearer as JsonObject;
    for (const text of [str((doc.info as JsonObject).description), str(bearer.description)]) {
      const flat = text.replace(/\s+/g, ' ');
      expect(flat).toMatch(/no path,? (and )?no trailing slash/);
      expect(flat).toContain('`/v1` is a path under that origin and is never part of `aud`');
      expect(flat).not.toContain("this API's URI");
    }
    // `servers` is origin-only: the audience can be read straight off it.
    const server = obj((doc.servers as Json[])[0], 'servers[0]');
    expect(new URL(str(server.url).replace(/\{[^}]+\}/g, 'x')).pathname).toBe('/');
    expect(str(server.url)).not.toMatch(/\/$/);
  });

  it('lists header_identity_rejected on the shared 401 response, and no other name for it', () => {
    const unauthorized = ((doc.components as JsonObject).responses as JsonObject)
      .Unauthorized as JsonObject;
    expect(unauthorized['x-noblecloak-problem-types']).toContain('header_identity_rejected');
    expect(JSON.stringify(doc)).not.toContain(['actor', 'headers', 'rejected'].join('_'));
  });
});

describe('the rev 3 problem types', () => {
  it('every registry entry has exactly the keys status and title, an integer status and a string title', () => {
    const entries = Object.entries(
      (doc.info as JsonObject)['x-noblecloak-problem-types'] as Record<string, JsonObject>
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [type, entry] of entries) {
      expect(Object.keys(entry).sort(), type).toEqual(['status', 'title']);
      expect(Number.isInteger(entry.status), type).toBe(true);
      expect(entry.status as number, type).toBeGreaterThanOrEqual(400);
      expect(entry.status as number, type).toBeLessThanOrEqual(599);
      expect(typeof entry.title, type).toBe('string');
      expect((entry.title as string).trim(), type).not.toBe('');
    }
  });

  it('every problem type any operation or shared response lists is registered', () => {
    const known = new Set(
      Object.keys(
        (doc.info as JsonObject)['x-noblecloak-problem-types'] as Record<string, JsonObject>
      )
    );
    const listed: [string, Json[]][] = [];
    const sharedResponses = (doc.components as JsonObject).responses as Record<string, JsonObject>;
    for (const [name, response] of Object.entries(sharedResponses))
      listed.push([
        `components.responses.${name}`,
        (response['x-noblecloak-problem-types'] ?? []) as Json[],
      ]);
    for (const [path, method, operation] of operationsOf(doc))
      for (const [status, answer] of Object.entries(
        operation.responses as Record<string, JsonObject>
      ))
        listed.push([
          `${method} ${path} ${status}`,
          (answer['x-noblecloak-problem-types'] ?? []) as Json[],
        ]);
    expect(listed.flatMap(([, types]) => types).length).toBeGreaterThan(50);
    for (const [where, types] of listed)
      for (const type of types as string[]) expect(known.has(type), `${where}: ${type}`).toBe(true);
  });

  const registry = (doc.info as JsonObject)['x-noblecloak-problem-types'] as Record<
    string,
    JsonObject
  >;
  const responses = (doc.components as JsonObject).responses as Record<string, JsonObject>;
  const types = (response: string): Json[] =>
    (responses[response]?.['x-noblecloak-problem-types'] ?? []) as Json[];

  it.each([
    ['continuation_unsupported', 422],
    ['header_identity_rejected', 401],
    ['dpop_unsupported', 401],
    ['organization_context_required', 403],
    ['insufficient_scope', 403],
  ])('registers %s with status %i', (type, status) => {
    expect(registry[type]?.status).toBe(status);
  });

  it('lists the 401 types on the shared 401 and the 403 types on every shared 403, on every authenticated operation', () => {
    expect(types('Unauthorized')).toEqual(
      expect.arrayContaining(['header_identity_rejected', 'dpop_unsupported'])
    );
    for (const name of [
      'Forbidden',
      'ForbiddenEntitlement',
      'ForbiddenNotEligible',
      'ForbiddenNotOwner',
    ])
      expect(types(name), name).toEqual(
        expect.arrayContaining(['organization_context_required', 'insufficient_scope'])
      );
    for (const [path, method, operation] of operationsOf(doc)) {
      if (Array.isArray(operation.security) && operation.security.length === 0) continue;
      const answers = operation.responses as Record<string, JsonObject>;
      const list = (status: string): Json[] => {
        const answer = answers[status] ?? {};
        const ref = typeof answer.$ref === 'string' ? answer.$ref.split('/').pop() : undefined;
        return (ref === undefined ? answer['x-noblecloak-problem-types'] : types(ref)) as Json[];
      };
      expect(list('401'), `${method} ${path}`).toEqual(
        expect.arrayContaining(['header_identity_rejected', 'dpop_unsupported'])
      );
      expect(list('403'), `${method} ${path}`).toEqual(
        expect.arrayContaining(['organization_context_required', 'insufficient_scope'])
      );
    }
  });

  it('documents continuation_unsupported on both decision routes, and the module_api scope on the machine flow', () => {
    for (const path of ['/v1/decisions', '/v1/decisions/batch']) {
      const answer = (op(path, 'post').responses as JsonObject)['422'] as JsonObject;
      expect(answer.$ref).toBe('#/components/responses/UnprocessableContinuation');
    }
    expect(types('UnprocessableContinuation')).toEqual(['continuation_unsupported']);
    const bearer = ((doc.components as JsonObject).securitySchemes as JsonObject)
      .bearer as JsonObject;
    const machine = (bearer['x-noblecloak-token-acquisition'] as JsonObject).machine as JsonObject;
    expect(machine.scope).toBe('module_api');
    for (const text of [str((doc.info as JsonObject).description), str(bearer.description)])
      expect(text).toContain('module_api');
  });
});

describe('capability families', () => {
  const familyOf = (operation: JsonObject): Json | undefined => operation['x-noblecloak-family'];

  it('puts each operation of the eleven families in its family, and leaves the floor without one', () => {
    const byFamily: Record<string, string[]> = {};
    const floor: string[] = [];
    for (const [, , operation] of operationsOf(doc)) {
      const family = familyOf(operation);
      const id = str(operation.operationId);
      if (family === undefined) floor.push(id);
      else (byFamily[str(family)] ??= []).push(id);
    }
    expect(Object.keys(byFamily).sort()).toEqual([...FAMILIES].sort());
    expect(byFamily.approvals).toEqual(
      expect.arrayContaining(['createApproval', 'consumeApproval', 'testContinuation'])
    );
    expect(byFamily['records.chain']).toEqual(['getRecordChain']);
    expect(byFamily['records.checkpoints']).toEqual(['createCheckpoint', 'verifyRecords']);
    expect(byFamily.evidence).toEqual(['createEvidenceExport']);
    expect(byFamily.runs).toEqual(['createRun', 'getRun']);
    // Rev 13 adds the binding of an agent to a service principal.
    expect(byFamily.agents).toEqual([
      'createAgent',
      'getAgent',
      'bindAgentPrincipal',
      'unbindAgentPrincipal',
    ]);
    expect(byFamily.principals).toEqual(['listPrincipals']);
    expect(byFamily.origins).toEqual(['getOrigins', 'putOrigins']);
    expect(byFamily.webhooks).toHaveLength(3);
    // Rev 11 adds retire and discard; rev 13 adds the simulation of a set.
    expect(byFamily.policies).toHaveLength(12);
    // Rev 11 adds refresh, authorize, link, unlink and consent revocation.
    expect(byFamily.connections).toHaveLength(11);
    // The floor: decisions, records (append, batch, list, get), tools, AuthZEN, capabilities, keys.
    expect(floor).toEqual(
      expect.arrayContaining([
        'decide',
        'decideBatch',
        'authzenEvaluate',
        'authzenConfiguration',
        'appendRecord',
        'appendRecords',
        'listRecords',
        'getRecord',
        'listTools',
        'registerTool',
        'getTool',
        'updateTool',
        'getCapabilities',
        'getJwks',
      ])
    );
    for (const id of floor) expect(byFamily, id).not.toHaveProperty(id);
  });

  it('defines the advertisement rule on GET /v1/capabilities and names the floor', () => {
    const flat = str(op('/v1/capabilities', 'get').description).replace(/\s+/g, ' ');
    expect(flat).toContain('`approvals` is advertised if and only if `resolutions` is non-empty');
    expect(flat).toContain(
      'every other family is advertised if and only if its name is in `features`'
    );
    for (const family of FAMILIES) expect(flat).toContain(`\`${family}\``);
    expect(flat).toContain('**Floor.**');
    expect(FLOOR_NAMES).toContain('decisions');
    const features = (schemas.Capabilities?.properties as JsonObject).features as JsonObject;
    for (const family of FAMILIES.filter((f) => f !== 'approvals'))
      expect(str(features.description)).toContain(`\`${family}\``);
  });
});

describe('absent-means members carry no default', () => {
  const members = [
    ['Capabilities', 'dpop'],
    ['Record', 'enforced'],
    ['RecordCreate', 'enforced'],
  ] as const;
  it.each(members)('%s.%s has no default and is not required', (schema, member) => {
    const definition = obj(schemas[schema], schema);
    const property = (definition.properties as JsonObject)[member] as JsonObject;
    expect(property).toBeDefined();
    expect(property).not.toHaveProperty('default');
    expect((definition.required ?? []) as string[]).not.toContain(member);
  });
});

describe('record context', () => {
  const channel = { $ref: '#/components/schemas/InvocationChannel' };
  it('is the narrow RecordContext on Record and RecordCreate, sharing the channel enum with DecisionContext', () => {
    for (const name of ['Record', 'RecordCreate'])
      expect(((schemas[name]?.properties as JsonObject).context as JsonObject).$ref, name).toBe(
        '#/components/schemas/RecordContext'
      );
    expect(schemas.RecordContext?.additionalProperties).toBe(false);
    expect(props('RecordContext')).toEqual(['invocation_channel']);
    expect((schemas.RecordContext?.properties as JsonObject).invocation_channel).toEqual(channel);
    expect((schemas.DecisionContext?.properties as JsonObject).invocation_channel).toEqual(channel);
    expect(schemas.InvocationChannel?.enum).toEqual(['interactive', 'headless', 'workflow']);
  });
  it('says on Record that context is optional and never defaulted', () => {
    const flat = str(schemas.Record?.description).replace(/\s+/g, ' ');
    expect(flat).toContain(
      '`context` is optional; a deployment that needs the channel and does not receive it rejects the record with 400, it never defaults it.'
    );
  });
});

describe('RecordCreate', () => {
  it('accepts none of the fields a deployment derives, and rejects unknown members', () => {
    const properties = props('RecordCreate');
    for (const derived of ['tool_use_id', 'source', 'side_effect_level'])
      expect(properties, derived).not.toContain(derived);
    expect(schemas.RecordCreate?.additionalProperties).toBe(false);
    expect(schemas.RecordBatchRequest?.additionalProperties).toBe(false);
  });
});

describe('the decision policy is optional, never null', () => {
  const policyOf = (name: string): JsonObject =>
    (schemas[name]?.properties as JsonObject).policy as JsonObject;
  const embeddingsOf = (target: string): string[] =>
    Object.entries(schemas)
      .filter(([, schema]) => JSON.stringify(schema.properties ?? {}).includes(target))
      .map(([name]) => name);

  it('is in no required list of the decision object and carries no default', () => {
    expect(policyOf('Decision')).toBeDefined();
    expect((schemas.Decision?.required ?? []) as string[]).not.toContain('policy');
    expect(policyOf('Decision')).not.toHaveProperty('default');
    // Rev 11 describes the member (one contributing entry, the deployment's choice) beside the reference.
    expect(policyOf('Decision')).toMatchObject({ $ref: '#/components/schemas/DecisionPolicy' });
  });
  it('keeps id and version required and non-null when it is present', () => {
    const policy = obj(schemas.DecisionPolicy, 'DecisionPolicy');
    expect(policy.required as string[]).toEqual(
      expect.arrayContaining(['id', 'version', 'side_effect_level'])
    );
    const members = policy.properties as Record<string, JsonObject>;
    expect(members.id?.type).toBe('string');
    expect(members.version?.type).toBe('integer');
    expect(members.id).not.toHaveProperty('default');
    expect(members.version).not.toHaveProperty('default');
  });
  it('states the rule in the decision description in one sentence', () => {
    const flat = str(schemas.Decision?.description).replace(/\s+/g, ' ');
    expect(flat).toContain(
      '`policy` is optional: absent means no explicit policy matched and the default applied, and when present its `id` and `version` are required and never null.'
    );
  });
  it('is reached through Decision and its rev 10 copy SimulateResult, by the decision, batch, AuthZEN and simulate responses', () => {
    // SimulateResult copies Decision's members (not allOf, which closeSchema would leave open), so the
    // policy rule holds there too.
    expect(embeddingsOf('#/components/schemas/DecisionPolicy')).toEqual([
      'Decision',
      'SimulateResult',
    ]);
    expect(policyOf('SimulateResult')).toEqual(policyOf('Decision'));
    expect((schemas.SimulateResult?.required ?? []) as string[]).not.toContain('policy');
    expect(embeddingsOf('#/components/schemas/Decision"')).toEqual(
      expect.arrayContaining(['AuthzenEvaluationResponse', 'DecisionEnvelope'])
    );
    expect(JSON.stringify(schemas.DecisionBatchEnvelope)).toContain(
      '#/components/schemas/Decision"'
    );
  });
  it('is optional and never null on the Record read side, as on RecordCreate', () => {
    expect((schemas.Record?.required ?? []) as string[]).not.toContain('policy');
    expect(policyOf('Record')).not.toHaveProperty('default');
    expect(policyOf('Record')).not.toHaveProperty('oneOf');
    expect(policyOf('Record').$ref).toBe('#/components/schemas/PolicyRef');
    expect(JSON.stringify(schemas.Record)).not.toContain('"null"');
    const flat = str(policyOf('Record').description).replace(/\s+/g, ' ');
    expect(flat).toContain('Absent when no policy matched explicitly and the default applied');
  });
});
