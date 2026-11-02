/**
 * What rev 10 of the document says, as assertions: the policy-kind vocabulary and its configurations,
 * the display-ready policy shape, `not_granted`, the rejected-duplicate rule and its answers, the batch
 * rule, and a simulate result that explains. Every member rev 10 adds is optional, so a rev 9 server's
 * responses still validate.
 */
import { describe, expect, it } from 'vitest';

import { createMock } from '../mock/app.js';
import { FEATURES } from './families.js';
import { loadSpec } from './load.js';
import type { JsonObject } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';
import { obj, str } from './testing.js';
import { SpecIndex } from './validate.js';

const doc = loadSpec(PUBLIC_SOURCE());
const paths = doc.paths as JsonObject;
const components = doc.components as JsonObject;
const schemas = components.schemas as Record<string, JsonObject>;
const responses = components.responses as Record<string, JsonObject>;
const info = doc.info as JsonObject;
const registry = info['x-noblecloak-problem-types'] as Record<string, JsonObject>;
const flat = (text: unknown): string => str(text as never).replace(/\s+/g, ' ');
const op = (path: string, method: string): JsonObject =>
  obj((paths[path] as JsonObject)[method], `${method} ${path}`);
const props = (name: string): Record<string, JsonObject> =>
  obj(schemas[name], name).properties as Record<string, JsonObject>;
const description = flat(info.description);
const index = new SpecIndex(doc);
const closed = new SpecIndex(doc, { rejectUndeclared: true });

/** The problem types a response component lists. */
const problemTypesOf = (operation: JsonObject, status: string): string[] => {
  const ref = str(
    obj((operation.responses as JsonObject)[status], status).$ref,
    `${status} $ref`
  ).replace('#/components/responses/', '');
  return obj(responses[ref], ref)['x-noblecloak-problem-types'] as string[];
};

describe('policy kinds', () => {
  it('PolicyKind is an open string of the three documented kinds, and both Policy and PolicyWrite use it', () => {
    const kind = obj(schemas.PolicyKind, 'PolicyKind');
    expect(kind.type).toBe('string');
    expect(kind['x-noblecloak-known-values']).toEqual([
      'tool_invocation',
      'spending',
      'duplicate_requests',
    ]);
    expect(flat(kind.description)).toContain('never as a decision');
    const ref = '#/components/schemas/PolicyKind';
    expect(props('Policy').kind).toEqual({ $ref: ref });
    expect(props('PolicyWrite').kind).toEqual({ $ref: ref });
    // The obligation keeps its own, closed kind.
    expect(props('Approval').obligation_kind).toEqual({
      $ref: '#/components/schemas/ObligationKind',
    });
  });

  it('PolicyKind names its known values and accepts a kind from the future', () => {
    const kind = obj(schemas.PolicyKind, 'PolicyKind');
    expect(kind.enum).toBeUndefined();
    expect(flat(kind.description)).toContain(
      'Known values: tool_invocation | spending | duplicate_requests.'
    );
    expect(closed.schema('PolicyKind')('a_kind_from_the_future')).toBe(true);
  });

  it('PolicyConfig is a named anyOf of the three closed configurations, which createPolicy cites', () => {
    const config = obj(schemas.PolicyConfig, 'PolicyConfig');
    expect(config.anyOf).toEqual([
      { $ref: '#/components/schemas/ToolInvocationConfig' },
      { $ref: '#/components/schemas/SpendingConfig' },
      { $ref: '#/components/schemas/DuplicateRequestsConfig' },
    ]);
    // No if/then on the policy: closeSchema would stop checking undeclared fields under it.
    expect(obj(schemas.Policy, 'Policy').if).toBeUndefined();
    expect(props('Policy').config).toEqual({ $ref: '#/components/schemas/PolicyConfig' });
    expect(props('PolicyWrite').config).toEqual({ $ref: '#/components/schemas/PolicyConfig' });
    for (const name of ['ToolInvocationConfig', 'SpendingConfig', 'DuplicateRequestsConfig'])
      expect(obj(schemas[name], name).additionalProperties, name).toBe(false);
    expect(flat(op('/v1/policies', 'post').description)).toContain('(`PolicyConfig`)');
    expect(flat(config.description)).toContain('400 `invalid_request`');
  });

  it('DuplicateRequestsConfig: after_rejection required, a bounded window, max_reasks only with ask_again', () => {
    const validate = index.schema('DuplicateRequestsConfig');
    expect(validate({ after_rejection: 'deny' })).toBe(true);
    expect(validate({ after_rejection: 'ask_again', max_reasks: 1, window_seconds: 60 })).toBe(
      true
    );
    expect(validate({ after_rejection: 'ask_again', window_seconds: 2_592_000 })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ after_rejection: 'deny', max_reasks: 2 })).toBe(false);
    expect(validate({ after_rejection: 'ask_again', max_reasks: 0 })).toBe(false);
    expect(validate({ after_rejection: 'deny', window_seconds: 59 })).toBe(false);
    expect(validate({ after_rejection: 'deny', window_seconds: 2_592_001 })).toBe(false);
    expect(validate({ after_rejection: 'deny', extra: true })).toBe(false);
    expect(props('DuplicateRequestsConfig').window_seconds?.default).toBe(86_400);
  });

  it('not_granted is a mode, provisional, and legal exactly where deny is', () => {
    const mode = obj(schemas.PolicyMode, 'PolicyMode');
    expect(mode.enum).toContain('not_granted');
    expect(flat(mode.description)).toContain('provisional');
    expect(mode['x-noblecloak-status']).toBeUndefined();
    const config = index.schema('ToolInvocationConfig');
    expect(config({ mode: 'not_granted' })).toBe(true);
    expect(config({ mode: 'not_granted', on_deny: 'halt' })).toBe(false);
    expect(config({ mode: 'not_granted', expires_after: 'PT1H' })).toBe(false);
    expect(config({ mode: 'not_granted', approver_groups: ['g'] })).toBe(false);
  });
});

describe('the policy shape', () => {
  it('Policy gains display members, all optional; updated_by is a PrincipalRef, never named', () => {
    const required = obj(schemas.Policy, 'Policy').required as string[];
    expect(required).toEqual(['id', 'version', 'source', 'kind', 'subjects', 'config']);
    const p = props('Policy');
    for (const member of [
      'name',
      'description',
      'state',
      'targets',
      'unenforced_targets',
      'updated_at',
      'updated_by',
    ])
      expect(p[member], member).toBeDefined();
    expect(p.updated_by).toMatchObject({ $ref: '#/components/schemas/PrincipalRef' });
    expect(p.name).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(p.description).toMatchObject({ maxLength: 2000 });
    expect(obj(schemas.PolicyState, 'PolicyState').enum).toEqual(['draft', 'published']);
  });

  it('subjects are a non-empty list of distinct subjects, a principal or the organisation', () => {
    const write = index.schema('PolicyWrite');
    const base = { kind: 'tool_invocation', config: { mode: 'ask' } };
    expect(write({ ...base, subjects: [{ type: 'role', id: 'member' }] })).toBe(true);
    expect(write({ ...base, subjects: [{ type: 'organization' }] })).toBe(true);
    expect(write({ ...base, subjects: [] })).toBe(false);
    expect(
      write({
        ...base,
        subjects: [
          { type: 'role', id: 'member' },
          { type: 'role', id: 'member' },
        ],
      })
    ).toBe(false);
    expect(write({ ...base, subjects: [{ type: 'organization', id: 'org_1' }] })).toBe(false);
    expect(write({ ...base, subjects: [{ type: 'tool', id: 't' }] })).toBe(false);
    // PrincipalKind is shared with PrincipalRef, so it does not gain `organization`.
    expect(obj(schemas.PrincipalKind, 'PrincipalKind').enum).not.toContain('organization');
  });

  it('targets are every tool or 1 to 100 tool references; name, description and targets are optional on a write', () => {
    const write = index.schema('PolicyWrite');
    const base = {
      kind: 'tool_invocation',
      subjects: [{ type: 'user', id: 'u' }],
      config: { mode: 'ask' },
    };
    expect(write(base)).toBe(true);
    expect(write({ ...base, targets: { tools: 'all' } })).toBe(true);
    expect(write({ ...base, targets: { tools: ['mcp:a:b'] }, name: 'n', description: 'd' })).toBe(
      true
    );
    expect(write({ ...base, targets: { tools: [] } })).toBe(false);
    expect(
      write({ ...base, targets: { tools: Array.from({ length: 101 }, (_, i) => `t${String(i)}`) } })
    ).toBe(false);
    expect(write({ ...base, targets: { tools: 'some' } })).toBe(false);
    expect(write({ ...base, name: '' })).toBe(false);
    expect(write({ ...base, name: 'x'.repeat(201) })).toBe(false);
    expect(write({ ...base, unenforced_targets: [] })).toBe(false);
  });

  it('the list filters by kind, tool, subject type and state, and pages with meta.next', () => {
    const list = op('/v1/policies', 'get');
    const names = (list.parameters as JsonObject[]).map((p) =>
      typeof p.$ref === 'string' ? p.$ref : p.name
    );
    expect(names).toEqual([
      'source',
      'kind',
      'tool',
      'subject_type',
      'state',
      '#/components/parameters/Cursor',
      '#/components/parameters/Limit',
    ]);
    expect(flat(list.description)).toContain('`meta.next`');
    expect(obj(schemas.PolicySubjectType, 'PolicySubjectType').enum).toContain('organization');
  });

  it('versions include the pending draft, and the read rule says which version a read returns', () => {
    expect(flat(op('/v1/policies/{id}/versions', 'get').description)).toContain(
      'the pending draft included (`published_at: null`)'
    );
    expect(flat(op('/v1/policies/{id}', 'get').description)).toContain(
      'or its draft (`state: draft`, `published_at: null`) when it was never published'
    );
    expect(flat(op('/v1/policies/{id}', 'put').description)).toContain(
      'writes a draft as the next version'
    );
  });

  it('a policy on a tool the caller cannot see is left out of lists and 404 on read', () => {
    expect(flat(op('/v1/policies', 'get').description)).toContain('is left out of the list');
    expect(flat(op('/v1/policies/{id}', 'get').description)).toContain('is 404 `not_found`');
  });

  it('authoring needs an administrator, and 404 for an unseen policy comes before the 403', () => {
    for (const [path, method] of [
      ['/v1/policies', 'post'],
      ['/v1/policies/{id}', 'put'],
      ['/v1/policies/{id}/publish', 'post'],
    ] as const) {
      const text = flat(op(path, method).description);
      expect(text, `${method} ${path}`).toContain('administrator');
      expect(text, `${method} ${path}`).toContain('a service principal never is');
      expect(problemTypesOf(op(path, method), '403'), `${method} ${path}`).toContain('forbidden');
    }
    for (const path of ['/v1/policies/{id}', '/v1/policies/{id}/publish'])
      expect(flat(op(path, path.endsWith('publish') ? 'post' : 'put').description)).toContain(
        'before the administrator check'
      );
    expect(flat(op('/v1/policies/{id}/simulate', 'post').description)).toContain(
      'needs no administrator'
    );
  });

  it('publish records a version, names the webhook event, the cache interval and policy_conflict', () => {
    const publish = op('/v1/policies/{id}/publish', 'post');
    const text = flat(publish.description);
    expect(text).toContain('the pending draft becomes the published version, keeping');
    expect(text).toContain('A deployment that serves webhooks delivers `policy.published`');
    expect(text).toContain('hosted: up to 60 seconds');
    expect(text).not.toContain('emits');
    expect(problemTypesOf(publish, '409')).toEqual(['policy_conflict']);
    expect(problemTypesOf(publish, '422')).toEqual(['unsupported_policy_form']);
    // Rev 14 adds `policy_immutable` to the two routes that take a policy body.
    for (const [path, method] of [
      ['/v1/policies', 'post'],
      ['/v1/policies/{id}', 'put'],
    ] as const)
      expect(problemTypesOf(op(path, method), '422')).toEqual([
        'unsupported_policy_form',
        'policy_immutable',
      ]);
  });
});

describe('unsupported_policy_form covers a config member (noblecloak-ui#60)', () => {
  const FORM = 'a kind, a subject type, a target form, a mode or a config member';

  it('create names a config member such as expires_after or approver_groups among the forms a deployment may refuse', () => {
    const create = flat(op('/v1/policies', 'post').description);
    expect(create).toContain(
      `A deployment may refuse a form it cannot enforce (${FORM}, such as \`expires_after\` or \`approver_groups\`, it does not implement for the kind)`
    );
    expect(create).toContain(
      'with 422 `unsupported_policy_form`, whose `member` names it (rev 13; see `Problem.member`).'
    );
  });

  it('replace and publish repeat the same list', () => {
    for (const [path, method] of [
      ['/v1/policies/{id}', 'put'],
      ['/v1/policies/{id}/publish', 'post'],
    ] as const)
      expect(flat(op(path, method).description)).toContain(
        `${FORM} it does not implement for the kind`
      );
  });

  it('the problem title and the 422 response name a config member', () => {
    expect(str(registry.unsupported_policy_form?.title as never)).toContain(
      'kind, subject type, target form, mode or config member this deployment cannot enforce'
    );
    expect(flat(responses.UnprocessablePolicyForm?.description)).toContain(
      `${FORM} this deployment cannot enforce`
    );
  });

  it('no description still lists the four forms without the config member', () => {
    expect(JSON.stringify(doc).replace(/\\n|\s+/g, ' ')).not.toMatch(
      /target forms?,? (?:or|and) (?:a )?(?:policy )?modes?\b(?!,? or (?:a )?config member)/
    );
  });
});

describe('features on operations', () => {
  it('marks policy import and export with the feature policies.import_export, and names no unknown feature', () => {
    const marked = Object.entries(paths).flatMap(([path, item]) =>
      Object.entries(item as JsonObject)
        .filter(([, operation]) => (operation as JsonObject)['x-noblecloak-feature'] !== undefined)
        .map(([method, operation]) => [
          `${method} ${path}`,
          (operation as JsonObject)['x-noblecloak-feature'],
        ])
    );
    // Rev 11 marks more operations with features of their own (see rev11.test.ts).
    expect(marked.filter(([, feature]) => feature === 'policies.import_export')).toEqual([
      ['post /v1/policies/import', 'policies.import_export'],
      ['get /v1/policies/{id}/export', 'policies.import_export'],
    ]);
    for (const [, feature] of marked) expect(FEATURES).toContain(feature);
    expect(index.match('POST', '/v1/policies/import')?.feature).toBe('policies.import_export');
    expect(index.match('GET', '/v1/policies')?.feature).toBeUndefined();
  });
});

describe('the rejected-duplicate rule', () => {
  it('the new problem types are registered, with their members on Problem', () => {
    expect(registry.unsupported_policy_form).toMatchObject({ status: 422 });
    expect(registry.policy_conflict).toMatchObject({ status: 409 });
    expect(registry.rejected_duplicate).toMatchObject({ status: 409 });
    const problem = props('Problem');
    expect(flat(problem.policy_id?.description)).toContain('Only on `policy_conflict`');
    expect(flat(problem.rejected_approval_id?.description)).toContain(
      'Only on `rejected_duplicate`'
    );
    expect(obj(schemas.Problem, 'Problem').required).toEqual([
      'type',
      'title',
      'status',
      'request_id',
    ]);
  });

  it('POST /v1/approvals lists rejected_duplicate on its 409', () => {
    expect(problemTypesOf(op('/v1/approvals', 'post'), '409')).toEqual([
      'continuation_conflict',
      'rejected_duplicate',
    ]);
  });

  it('the vocabulary maps rejected_duplicate to deny, in the table and the prose', () => {
    const vocabulary = info['x-noblecloak-vocabulary'] as JsonObject;
    // Rev 11 adds credential_link_required (see rev11.test.ts).
    expect(vocabulary.decision_from_reason).toMatchObject({ rejected_duplicate: 'deny' });
    expect(description).toContain('The reason `rejected_duplicate` is a `deny`');
    expect(flat(props('Decision').reason?.description)).toContain('`rejected_duplicate`');
  });

  it('Decision gains only an optional rejected_approval_id; Approval an optional prior_rejections', () => {
    expect(obj(schemas.Decision, 'Decision').required).toEqual([
      'decision',
      'action_digest',
      'enforced',
    ]);
    expect(Object.keys(props('Decision'))).toEqual([
      'decision',
      'reason',
      'action_digest',
      'policy',
      'approval',
      'enforced',
      'would_be',
      'condition',
      'rejected_approval_id',
    ]);
    const prior = obj(props('Approval').prior_rejections, 'prior_rejections');
    expect(prior.required).toEqual(['count', 'last_at']);
    expect(obj(schemas.Approval, 'Approval').required).not.toContain('prior_rejections');
    expect(flat(prior.description)).toContain('to every reader who can see the approval');
  });

  it('states the rule once, gated on the feature', () => {
    expect(description).toContain(
      '**Terminal states free the identity.** `consumed`, `expired` and `withdrawn`'
    );
    expect(description).toContain('advertise the feature `approvals.rejected_duplicate`');
    expect(description).toContain('a consumed approval resets it');
    expect(description).toContain("Only a resolver's rejection counts");
    expect(description).toContain('it is not a security control');
    expect(description).toContain("A service principal's calls that name no run");
  });

  it('the batch decides identical elements as one obligation', () => {
    const text = flat(op('/v1/decisions/batch', 'post').description);
    expect(text).not.toContain('decided independently');
    expect(text).toContain('Identical elements');
    expect(text).toContain('are one obligation');
  });

  it('capabilities name the feature', () => {
    expect(flat(props('Capabilities').features?.description)).toContain(
      '`approvals.rejected_duplicate`'
    );
  });
});

describe('simulate explains', () => {
  it('answers SimulateEnvelope, whose SimulateResult copies every member of Decision and adds considered', () => {
    const simulate = op('/v1/policies/{id}/simulate', 'post');
    const ok = obj((simulate.responses as JsonObject)['200'], '200');
    expect(JSON.stringify(ok)).toContain('#/components/schemas/SimulateEnvelope');
    const result = obj(schemas.SimulateResult, 'SimulateResult');
    // A copy, not an allOf: closeSchema skips composed schemas.
    expect(result.allOf).toBeUndefined();
    expect(result.required).toEqual(obj(schemas.Decision, 'Decision').required);
    for (const member of Object.keys(props('Decision')))
      expect(props('SimulateResult')[member], member).toBeDefined();
    expect(props('SimulateResult').considered).toEqual({
      $ref: '#/components/schemas/ConsideredPolicies',
    });
    expect(result.required).not.toContain('considered');
    // Decide's envelope is unchanged.
    expect(JSON.stringify(op('/v1/decisions', 'post').responses)).toContain(
      '#/components/schemas/DecisionEnvelope'
    );
  });

  it('ConsideredPolicies lists entries with null ids for defaults, and the composed decision', () => {
    const validate = index.schema('ConsideredPolicies');
    expect(
      validate({
        policies: [
          {
            kind: 'tool_invocation',
            id: 'pol_1',
            version: 2,
            result: 'ask',
            subject: { type: 'role', id: 'member' },
          },
          { kind: 'tool_invocation', id: null, version: null, result: 'deny', source: 'default' },
          {
            kind: 'duplicate_requests',
            id: null,
            version: null,
            result: 'none',
            source: 'default',
          },
        ],
        composed: { decision: 'step_up' },
      })
    ).toBe(true);
    expect(validate({ policies: [], composed: {} })).toBe(false);
    expect(
      validate({
        policies: [{ kind: 'tool_invocation', result: 'ask' }],
        composed: { decision: 'allow' },
      })
    ).toBe(false);
  });
});

describe('a rev 9 server stays valid', () => {
  it('a rev 9 policy, decision, simulate answer and approval validate against the closed document', () => {
    const policy = {
      id: 'pol_1',
      version: 3,
      source: 'authored',
      kind: 'tool_invocation',
      subjects: [{ type: 'role', id: 'member' }],
      config: { mode: 'ask', on_deny: 'resume', expires_after: 'PT1H' },
      published_at: '2026-10-20T00:00:00.000Z',
    };
    const decision = {
      decision: 'deny',
      reason: 'deny',
      action_digest: 'a'.repeat(64),
      enforced: true,
      policy: { id: 'pol_1', version: 3, side_effect_level: 'read' },
    };
    const approval = {
      id: 'ap_1',
      state: 'pending',
      tool_ref: 'mcp:a:b',
      obligation_kind: 'tool_invocation',
      action_digest: 'a'.repeat(64),
      scope_id: 's',
      side_effect_level: 'write',
      created_at: '2026-10-20T00:00:00.000Z',
    };
    const meta = { request_id: 'req_1', deployment: 'hosted' };
    expect(closed.schema('PolicyEnvelope')({ data: policy, meta })).toBe(true);
    expect(closed.schema('PolicyListEnvelope')({ data: [policy], meta })).toBe(true);
    expect(closed.schema('DecisionEnvelope')({ data: decision, meta })).toBe(true);
    expect(
      closed.schema('SimulateEnvelope')({
        data: { ...decision, enforced: false, would_be: 'deny' },
        meta,
      })
    ).toBe(true);
    expect(closed.schema('ApprovalEnvelope')({ data: approval, meta })).toBe(true);
  });

  it('rev 10 answers of a hosted mock, with every member rev 10 adds stripped, still validate', async () => {
    const mock = await createMock({ spec: doc });
    const tokens = await mock.tokens();
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const response = await mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await response.json()) as { data: Record<string, unknown>; meta: unknown };
    };
    const strip = (value: Record<string, unknown>, ...members: string[]): Record<string, unknown> =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !members.includes(key)));
    const POLICY_MEMBERS = [
      'name',
      'description',
      'state',
      'targets',
      'unenforced_targets',
      'updated_at',
      'updated_by',
    ];
    const policy = await call(tokens.admin, 'GET', '/v1/policies/pol_default');
    expect(policy.data.state).toBe('published');
    expect(
      closed.schema('PolicyEnvelope')({ ...policy, data: strip(policy.data, ...POLICY_MEMBERS) })
    ).toBe(true);
    const action = { tool_ref: 'mcp:tracker:create_issue', arguments: { title: 'rev 9 shape' } };
    const simulated = await call(tokens.creator_user, 'POST', '/v1/policies/pol_default/simulate', {
      action,
    });
    expect(simulated.data.considered).toBeDefined();
    expect(
      closed.schema('SimulateEnvelope')({ ...simulated, data: strip(simulated.data, 'considered') })
    ).toBe(true);
    const decided = await call(tokens.creator_user, 'POST', '/v1/decisions', {
      action,
      continuation: { kind: 'langgraph', delivery: 'pull' },
    });
    const id = (decided.data.approval as { id: string }).id;
    await call(tokens.approver, 'POST', `/v1/approvals/${id}/deny`, {
      expected_action_digest: decided.data.action_digest,
    });
    const denied = await call(tokens.creator_user, 'POST', '/v1/decisions', { action });
    expect(denied.data.reason).toBe('rejected_duplicate');
    expect(
      closed.schema('DecisionEnvelope')({
        ...denied,
        data: strip(denied.data, 'rejected_approval_id'),
      })
    ).toBe(true);
    const approval = await call(tokens.creator_user, 'GET', `/v1/approvals/${id}`);
    expect(closed.schema('ApprovalEnvelope')(approval)).toBe(true);
  });
});
