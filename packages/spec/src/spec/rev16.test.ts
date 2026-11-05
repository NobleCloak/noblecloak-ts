/**
 * What rev 16 of the document says, as assertions: fact bindings on a tool (`FactName`, `FactBinding`, `ToolFacts`,
 * `Tool.facts`), rules and approvers in `ToolInvocationConfig` (`PolicyCondition`, `PolicyConditions`, `PolicyRule`,
 * `PolicyApprover`), the `approval_routing` kind (`ApprovalRoutingConfig`), the requirements of an approval
 * (`ApprovalRequirement`, `ApproverRef`, `Approval.requirements`), the `rule` and `missing_facts` of a considered
 * entry, `Decision.missing_facts`, and the three features. Every addition is optional on the wire, so a rev 15 body still validates.
 */
import { describe, expect, it } from 'vitest';

import { FEATURES } from './families.js';
import { loadSpec } from './load.js';
import type { JsonObject } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';
import { obj, str } from './testing.js';
import { SpecIndex } from './validate.js';

const doc = loadSpec(PUBLIC_SOURCE());
const paths = doc.paths as JsonObject;
const schemas = (doc.components as JsonObject).schemas as Record<string, JsonObject>;
const flat = (text: unknown): string => str(text as never).replace(/\s+/g, ' ');
const props = (name: string): Record<string, JsonObject> =>
  obj(schemas[name], name).properties as Record<string, JsonObject>;
const index = new SpecIndex(doc);

const toolWrite = {
  tool_ref: 'ext:travel:book',
  transport: 'external',
  input_schema: { type: 'object' },
  side_effect_level: 'write',
};
const binding = { path: '.amount', type: 'number' };
const config = (extra: Record<string, unknown>): Record<string, unknown> => ({
  mode: 'ask',
  ...extra,
});
const rule = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  when: [{ fact: 'amount', op: 'gt', value: 5000 }],
  then: 'deny',
  ...extra,
});

describe('fact bindings on a tool (rev 16)', () => {
  const write = index.schema('ToolWrite');
  const patch = index.schema('ToolPatch');

  it('accepts bindings of every type, on a write and on a patch, and a patch that clears them with null', () => {
    const facts = {
      amount: binding,
      currency: { path: '.currency', type: 'string' },
      urgent: { path: '.flags.urgent', type: 'boolean' },
      recipients: { path: '.to', type: 'count', description: 'How many people it goes to.' },
      first_price: { path: '.lines[0].price', type: 'number' },
    };
    expect(write({ ...toolWrite, facts })).toBe(true);
    expect(patch({ facts })).toBe(true);
    expect(patch({ facts: null })).toBe(true);
    // A rev 15 write, with no facts, still validates.
    expect(write(toolWrite)).toBe(true);
  });

  it('refuses a path that selects a set, or is not a path, and a binding beyond the closed object', () => {
    for (const path of [
      '.lines[*].price',
      '..amount',
      'amount',
      '.',
      '.a.',
      '.[0]',
      '.1a',
      '[-1]',
      '',
    ])
      expect(write({ ...toolWrite, facts: { amount: { path, type: 'number' } } }), path).toBe(
        false
      );
    expect(write({ ...toolWrite, facts: { amount: { path: '.amount', type: 'integer' } } })).toBe(
      false
    );
    expect(write({ ...toolWrite, facts: { amount: { type: 'number' } } })).toBe(false);
    expect(write({ ...toolWrite, facts: { amount: { ...binding, extra: 1 } } })).toBe(false);
    expect(
      write({ ...toolWrite, facts: { amount: { ...binding, description: 'x'.repeat(501) } } })
    ).toBe(false);
  });

  it('bounds the names of facts and their number', () => {
    for (const name of ['Amount', '1amount', 'amount-total', '_amount', `a${'b'.repeat(63)}`])
      expect(write({ ...toolWrite, facts: { [name]: binding } }), name).toBe(false);
    expect(write({ ...toolWrite, facts: { [`a${'b'.repeat(62)}`]: binding } })).toBe(true);
    const many = (n: number): Record<string, unknown> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${String(i)}`, binding]));
    expect(write({ ...toolWrite, facts: many(32) })).toBe(true);
    expect(write({ ...toolWrite, facts: many(33) })).toBe(false);
  });

  it('declares Tool.facts as the read of what was written, and states extraction without coercion', () => {
    expect(props('Tool').facts?.$ref).toBe('#/components/schemas/ToolFacts');
    expect(props('ToolWrite').facts?.$ref).toBe('#/components/schemas/ToolFacts');
    expect(flat(props('ToolPatch').facts?.description)).toContain(
      "replaces the tool's whole map of facts; `null` removes every fact"
    );
    expect(flat(props('ToolPatch').facts?.description)).toContain(
      'a condition naming it is unevaluable (false under `exists`)'
    );
    const text = flat(schemas.FactBinding?.description);
    expect(text).toContain('Nothing is coerced (`"42"` is not a number)');
    expect(text).toContain('`count` an array, whose length is the fact');
    expect(text).toContain('a client never asserts a fact');
    expect(flat(props('FactBinding').path?.description)).toContain(
      'is refused with 400 `invalid_request` naming the binding in `member`'
    );
  });
});

describe('rules, approvers and exclude in ToolInvocationConfig (rev 16)', () => {
  const fits = index.schema('ToolInvocationConfig');

  it('accepts rules, approvers and exclude with every mode', () => {
    const body = {
      rules: [
        rule(),
        rule({ when: [{ fact: 'amount', op: 'lte', value: 50 }], then: 'always_allow' }),
        rule({
          when: [{ fact: 'amount', op: 'lte', value: 500 }],
          then: 'ask',
          approvers: [{ role: 'team_lead' }],
        }),
      ],
      approvers: [
        { role: 'finance' },
        { user: 'user_1', when: [{ fact: 'environment', op: 'eq', value: 'production' }] },
      ],
      exclude: ['requester'],
    };
    for (const mode of ['always_allow', 'ask', 'escalate', 'deny', 'not_granted'])
      expect(fits({ ...body, mode }), mode).toBe(true);
  });

  it('accepts every operator in its own form', () => {
    for (const condition of [
      { fact: 'currency', op: 'eq', value: 'EUR' },
      { fact: 'currency', op: 'ne', value: null },
      { fact: 'urgent', op: 'eq', value: true },
      { fact: 'currency', op: 'in', value: ['EUR', 'USD'] },
      { fact: 'amount', op: 'not_in', value: [1, 2, 3] },
      { fact: 'amount', op: 'gt', value: 0 },
      { fact: 'amount', op: 'gte', value: 1.5 },
      { fact: 'recipients', op: 'lt', value: 10 },
      { fact: 'recipients', op: 'lte', value: 10 },
      { fact: 'environment', op: 'exists' },
    ])
      expect(fits(config({ rules: [rule({ when: [condition] })] })), condition.op).toBe(true);
  });

  it('refuses a value in the wrong form for its operator', () => {
    for (const condition of [
      // gt, gte, lt, lte compare numbers.
      { fact: 'amount', op: 'gt', value: '5000' },
      { fact: 'amount', op: 'lte', value: [1] },
      { fact: 'amount', op: 'gt' },
      // eq and ne take one scalar.
      { fact: 'currency', op: 'eq', value: ['EUR'] },
      { fact: 'currency', op: 'eq', value: { a: 1 } },
      { fact: 'currency', op: 'eq' },
      // in and not_in take a non-empty list of at most 100 scalars.
      { fact: 'currency', op: 'in', value: 'EUR' },
      { fact: 'currency', op: 'in', value: [] },
      { fact: 'currency', op: 'in', value: [['EUR']] },
      { fact: 'amount', op: 'not_in', value: Array.from({ length: 101 }, (_, i) => i) },
      // exists takes none.
      { fact: 'environment', op: 'exists', value: true },
      // An operator the grammar does not have, a fact that is not a name, a member beyond the closed object.
      { fact: 'currency', op: 'matches', value: 'E.*' },
      { fact: 'Currency', op: 'eq', value: 'EUR' },
      { fact: 'currency', op: 'eq', value: 'EUR', extra: 1 },
    ])
      expect(
        fits(config({ rules: [rule({ when: [condition] })] })),
        JSON.stringify(condition)
      ).toBe(false);
  });

  it('bounds a when to 1..8 conditions, and the rules and approvers to 32 each', () => {
    const condition = { fact: 'amount', op: 'gt', value: 1 };
    expect(fits(config({ rules: [rule({ when: [] })] }))).toBe(false);
    expect(fits(config({ rules: [rule({ when: Array(8).fill(condition) })] }))).toBe(true);
    expect(fits(config({ rules: [rule({ when: Array(9).fill(condition) })] }))).toBe(false);
    expect(fits(config({ rules: Array(32).fill(rule()) }))).toBe(true);
    expect(fits(config({ rules: Array(33).fill(rule()) }))).toBe(false);
    expect(fits(config({ rules: [] }))).toBe(false);
    expect(fits(config({ approvers: Array(32).fill({ role: 'finance' }) }))).toBe(true);
    expect(fits(config({ approvers: Array(33).fill({ role: 'finance' }) }))).toBe(false);
    expect(fits(config({ approvers: [] }))).toBe(false);
  });

  it('allows approvers on a rule only when its then is ask', () => {
    const approvers = [{ role: 'team_lead' }];
    expect(fits(config({ rules: [rule({ then: 'ask', approvers })] }))).toBe(true);
    expect(fits(config({ rules: [rule({ then: 'deny', approvers })] }))).toBe(false);
    expect(fits(config({ rules: [rule({ then: 'always_allow', approvers })] }))).toBe(false);
    // A rule's then is one of three outcomes; escalate is a mode, not an outcome of a rule.
    expect(fits(config({ rules: [rule({ then: 'escalate' })] }))).toBe(false);
  });

  it('takes an approver as a role or a user, never both, and exclude only as requester', () => {
    expect(fits(config({ approvers: [{ role: 'finance', user: 'user_1' }] }))).toBe(false);
    expect(fits(config({ approvers: [{ group: 'finance' }] }))).toBe(false);
    expect(fits(config({ approvers: [{ role: '' }] }))).toBe(false);
    expect(fits(config({ approvers: [{ role: 'finance', when: [] }] }))).toBe(false);
    expect(fits(config({ exclude: ['creator'] }))).toBe(false);
    expect(fits(config({ exclude: ['requester', 'requester'] }))).toBe(false);
    expect(fits(config({ exclude: [] }))).toBe(false);
  });

  it('keeps the rev 9 legality of on_deny, expires_after and approver_groups', () => {
    expect(fits({ mode: 'deny', on_deny: 'halt' })).toBe(false);
    expect(fits({ mode: 'deny', rules: [rule({ then: 'always_allow' })] })).toBe(true);
  });

  it('states the evaluation of one policy in ToolInvocationConfig, and how each member is served', () => {
    const text = flat(schemas.ToolInvocationConfig?.description);
    expect(text).toContain(
      'A rule with a false condition is skipped, whatever its other conditions.'
    );
    expect(text).toContain(
      "Otherwise a rule with an unevaluable condition stops the walk: the policy's result is `ask`, and the facts with no value are its `missing_facts`."
    );
    expect(text).toContain('(the first matching rule wins)');
    expect(text).toContain('When no rule matches, the result is `mode`.');
    expect(text).toContain('`exists` is never unevaluable');
    expect(text).toContain('a call that sends only `arg_digest` has no facts');
    expect(text).toContain('`rules`, `approvers` and `exclude` are legal with every mode');
    expect(text).toContain(
      'A deployment that does not list the feature `policies.rules` refuses `rules`, and one that does not list `approvals.requirements` refuses `approvers`, `exclude` and the `approvers` of a rule'
    );
    expect(flat(props('ToolInvocationConfig').approvers?.description)).toContain(
      'unlike `approver_groups`, which it leaves as it was'
    );
  });
});

describe('the approval_routing kind (rev 16)', () => {
  const fits = index.schema('ApprovalRoutingConfig');

  it('is a known kind whose configuration is one boolean', () => {
    expect(schemas.PolicyKind?.['x-noblecloak-known-values']).toContain('approval_routing');
    expect(fits({ org_admin_break_glass: false })).toBe(true);
    expect(fits({ org_admin_break_glass: true })).toBe(true);
    expect(fits({})).toBe(false);
    expect(fits({ org_admin_break_glass: 'yes' })).toBe(false);
    expect(fits({ org_admin_break_glass: true, extra: 1 })).toBe(false);
    expect(index.schema('PolicyConfig')({ org_admin_break_glass: true })).toBe(true);
  });

  it('states the subject and target form, the setting in force and its default', () => {
    const text = flat(schemas.ApprovalRoutingConfig?.description);
    expect(text).toContain('takes the organisation subject only and targets every tool');
    expect(text).toContain('422 `unsupported_policy_form`');
    expect(text).toContain('most recently published `approval_routing` policy');
    expect(text).toContain('with none, `org_admin_break_glass` is `true`');
  });
});

describe('the requirements of an approval (rev 16)', () => {
  const approval = {
    id: 'apr_1',
    state: 'pending',
    tool_ref: 'ext:travel:book',
    obligation_kind: 'tool_invocation',
    action_digest: 'a'.repeat(64),
    scope_id: 'scope_1',
    side_effect_level: 'write',
    created_at: '2026-11-05T12:00:00Z',
  };
  const requirement = {
    id: 'r1',
    policies: [{ id: 'pol_1', version: 2 }],
    approvers: [{ role: 'finance' }, { user: 'user_1' }],
    exclude: ['requester'],
    needed: 1,
    met: true,
    approvals: [
      {
        by: { id: 'user_1', kind: 'user', display_name: 'One' },
        at: '2026-11-05T12:01:00Z',
        basis: 'listed',
      },
    ],
  };
  const meta = { request_id: 'req_1', deployment: 'hosted' };
  const fits = (body: unknown): boolean => index.schema('ApprovalEnvelope')({ data: body, meta });

  it('validates a rev 15 approval, and one that carries requirements', () => {
    expect(fits(approval)).toBe(true);
    expect(fits({ ...approval, requirements: [requirement] })).toBe(true);
    expect(
      fits({
        ...approval,
        requirements: [
          requirement,
          { ...requirement, id: 'r2', approvers: [], exclude: [], met: false, approvals: [] },
        ],
      })
    ).toBe(true);
  });

  it('refuses a requirement beyond its closed shape', () => {
    for (const bad of [
      { ...requirement, extra: 1 },
      { ...requirement, needed: 0 },
      { ...requirement, policies: [] },
      { ...requirement, approvers: [{ role: 'finance', when: [] }] },
      { ...requirement, exclude: ['creator'] },
      {
        ...requirement,
        approvals: [{ ...(requirement.approvals[0] as object), basis: 'override' }],
      },
      { ...requirement, met: undefined },
    ])
      expect(fits({ ...approval, requirements: [bad] }), JSON.stringify(bad)).toBe(false);
  });

  it('states who is eligible, break-glass, and the approve, partial and reject semantics', () => {
    const shape = flat(schemas.ApprovalRequirement?.description);
    expect(shape).toContain('with `approvers` empty, an administrator of the organisation');
    expect(shape).toContain('`basis: break_glass`');
    expect(shape).toContain('A principal `exclude` names is eligible for none of it');
    const member = flat(props('Approval').requirements?.description);
    expect(member).toContain('one person may satisfy several');
    expect(member).toContain(
      'An approve that leaves a requirement unmet answers 200 with the approval still `pending`'
    );
    expect(member).toContain('it emits `approval.updated`');
    expect(member).toContain(
      'any principal eligible for at least one unmet requirement rejects the approval'
    );
    expect(member).toContain('a deployment that does not list it never sets the member');
    expect(member).toContain('contribute one requirement between them, which lists both');
    expect(flat(props('Approval').waiting_on?.description)).toContain(
      'those eligible for at least one unmet requirement, never the creator'
    );
    const resolve = obj((paths['/v1/approvals/{id}/resolve'] as JsonObject).post, 'resolve');
    expect(flat(resolve.description)).toContain(
      'answers 200 with the approval still `pending` while any requirement is unmet'
    );
  });
});

describe('what a simulation considered, and the features (rev 16)', () => {
  const item = obj(obj(props('ConsideredPolicies').policies, 'policies').items, 'item');
  const members = item.properties as Record<string, JsonObject>;

  it('adds rule and missing_facts to a considered entry, both optional', () => {
    expect(item.required).not.toContain('rule');
    expect(item.required).not.toContain('missing_facts');
    const considered = index.schema('ConsideredPolicies');
    const entry = { kind: 'tool_invocation', id: 'pol_1', version: 1, result: 'deny' };
    const composed = { decision: 'deny' };
    expect(considered({ policies: [entry], composed })).toBe(true);
    expect(
      considered({ policies: [{ ...entry, rule: { index: 0, then: 'deny' } }], composed })
    ).toBe(true);
    expect(
      considered({
        policies: [{ ...entry, result: 'ask', missing_facts: ['amount'] }],
        composed: { decision: 'step_up' },
      })
    ).toBe(true);
    expect(
      considered({ policies: [{ ...entry, rule: { index: -1, then: 'deny' } }], composed })
    ).toBe(false);
    expect(
      considered({ policies: [{ ...entry, rule: { index: 0, then: 'maybe' } }], composed })
    ).toBe(false);
    expect(considered({ policies: [{ ...entry, missing_facts: [] }], composed })).toBe(false);
    expect(flat(members.missing_facts?.description)).toContain(
      'A simulation whose `action` carries only `arg_digest` supplies no fact'
    );
  });

  it('adds an optional missing_facts to Decision and SimulateResult, a non-empty set of fact names', () => {
    for (const name of ['Decision', 'SimulateResult']) {
      expect(obj(schemas[name], name).required).not.toContain('missing_facts');
      const valid = index.schema(name);
      const decision = { decision: 'step_up', action_digest: 'a'.repeat(64), enforced: true };
      expect(valid(decision)).toBe(true);
      expect(valid({ ...decision, missing_facts: ['amount'] })).toBe(true);
      expect(valid({ ...decision, missing_facts: [] })).toBe(false);
      expect(valid({ ...decision, missing_facts: ['amount', 'amount'] })).toBe(false);
      expect(valid({ ...decision, missing_facts: ['Amount'] })).toBe(false);
    }
    expect(flat(props('Decision').missing_facts?.description)).toContain('on a `step_up`');
    expect(flat(props('Capabilities').features?.description)).toContain(
      'and sets `Decision.missing_facts`'
    );
  });

  it('names the three features in Capabilities.features and in the features a scenario may require', () => {
    const features = flat(props('Capabilities').features?.description);
    for (const name of ['tools.facts', 'policies.rules', 'approvals.requirements']) {
      expect(features).toContain(`\`${name}\``);
      expect(FEATURES).toContain(name);
    }
    expect(features).toContain('so it behaves as rev 15');
  });

  it('lists approval_routing in policy_forms, with its config members', () => {
    const forms = obj(props('Capabilities').policy_forms, 'policy_forms');
    const routing = obj((forms.properties as JsonObject).approval_routing, 'approval_routing');
    expect(routing.required).toEqual(['config_members']);
    expect(flat(forms.description)).toContain(
      'rev 16 adds `rules` under `policies.rules`, and `approvers` and `exclude` under `approvals.requirements`'
    );
  });
});
