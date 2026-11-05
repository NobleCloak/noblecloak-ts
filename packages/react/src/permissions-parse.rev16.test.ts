import { describe, expect, it } from 'vitest';

import { permissionsErrorFromResponse } from './permissions-errors.js';
import {
  breakGlassOf,
  currentRoutingPolicy,
  otherViewOf,
  policyCapabilitiesOf,
  simulationOf,
  toolOf,
} from './permissions-parse.js';
import type { OtherPolicy, PolicyInfo } from './permissions-types.js';

const routing = (over: Partial<PolicyInfo> & { breakGlass?: unknown } = {}): OtherPolicy => {
  const { breakGlass, ...rest } = over;
  const policy: PolicyInfo = {
    id: 'p',
    version: 1,
    source: 'authored',
    kind: 'approval_routing',
    kindKnown: true,
    state: 'published',
    subjects: [{ type: 'organization' }],
    targets: 'all',
    unenforcedTargets: [],
    config: { org_admin_break_glass: breakGlass ?? true },
    modeKnown: false,
    publishedAt: '2026-11-01T00:00:00Z',
    ...rest,
  };
  return { policy, view: otherViewOf(policy) };
};

describe('the break-glass setting', () => {
  it('is on, from no policy, when none is published', () => {
    expect(breakGlassOf([])).toEqual({ on: true, fromPolicy: false });
    expect(breakGlassOf([routing({ state: 'draft', breakGlass: false })])).toEqual({
      on: true,
      fromPolicy: false,
    });
  });

  it('is the most recently published policy’s value, and the later one in the list on a tie', () => {
    expect(
      breakGlassOf([
        routing({ id: 'a', publishedAt: '2026-11-02T00:00:00Z', breakGlass: false }),
        routing({ id: 'b', publishedAt: '2026-11-01T00:00:00Z', breakGlass: true }),
      ])
    ).toEqual({ on: false, fromPolicy: true });
    expect(
      breakGlassOf([
        routing({ id: 'a', publishedAt: '2026-11-01T00:00:00Z', breakGlass: false }),
        routing({ id: 'b', publishedAt: '2026-11-01T00:00:00Z', breakGlass: true }),
      ])
    ).toEqual({ on: true, fromPolicy: true });
  });

  it('compares publication times as instants, not as text', () => {
    // As text '…59.5Z' sorts before '…59Z'; as instants it is later.
    expect(
      breakGlassOf([
        routing({ id: 'a', publishedAt: '2026-11-01T00:00:59.500Z', breakGlass: false }),
        routing({ id: 'b', publishedAt: '2026-11-01T00:00:59Z', breakGlass: true }),
      ])
    ).toEqual({ on: false, fromPolicy: true });
    expect(
      currentRoutingPolicy([
        routing({ id: 'a', publishedAt: '2026-11-01T00:00:59Z', breakGlass: true }),
        routing({ id: 'b', publishedAt: '2026-11-01T00:00:59.500Z', breakGlass: false }),
      ])?.policy.id
    ).toBe('b');
  });

  it('ignores a policy of another kind and one it cannot read', () => {
    const other = routing({ kind: 'duplicate_requests', breakGlass: false });
    expect(breakGlassOf([other])).toEqual({ on: true, fromPolicy: false });
    const unreadable = routing({ breakGlass: 'maybe' });
    expect(unreadable.view).toEqual({ kind: 'opaque' });
    expect(breakGlassOf([unreadable])).toEqual({ on: true, fromPolicy: false });
  });

  it('reads the setting as an approval_routing view', () => {
    expect(routing({ breakGlass: false }).view).toEqual({
      kind: 'approval_routing',
      breakGlass: false,
    });
  });
});

describe('the capabilities rev 16 adds', () => {
  const form = (extra: Record<string, unknown>) =>
    policyCapabilitiesOf({
      data: {
        features: ['policies'],
        policy_forms: {
          tool_invocation: {
            modes: ['ask'],
            subject_types: ['role'],
            targets_all: true,
            config_members: ['rules', 'approvers', 'exclude'],
          },
          ...extra,
        },
      },
    })?.policyForms;

  it('reads approval_routing when it lists its member', () => {
    expect(form({ approval_routing: { config_members: ['org_admin_break_glass'] } })).toMatchObject(
      {
        approvalRouting: true,
        toolInvocation: { configMembers: ['rules', 'approvers', 'exclude'] },
      }
    );
  });

  it('does not read it when it is missing or lists no such member', () => {
    expect(form({})).not.toHaveProperty('approvalRouting');
    expect(form({ approval_routing: { config_members: [] } })).not.toHaveProperty(
      'approvalRouting'
    );
    expect(form({ approval_routing: 'yes' })).not.toHaveProperty('approvalRouting');
  });
});

describe('a tool with facts', () => {
  const tool = { id: 't', tool_ref: 'a:b', connection_id: null };
  it('keeps readable facts and drops a map it cannot read in full', () => {
    expect(
      toolOf({ ...tool, facts: { amount: { path: '.amount', type: 'number' } } })?.facts
    ).toEqual({
      amount: { path: '.amount', type: 'number' },
    });
    expect(
      toolOf({ ...tool, facts: { amount: { path: '.amount', type: 'float' } } })?.facts
    ).toBeUndefined();
    expect(toolOf(tool)).not.toHaveProperty('facts');
  });

  it('flags a facts member it cannot read, and not one it can or one that is absent', () => {
    expect(
      toolOf({ ...tool, facts: { amount: { path: '.amount', type: 'float' } } })?.factsUnreadable
    ).toBe(true);
    expect(toolOf(tool)).not.toHaveProperty('factsUnreadable');
    expect(
      toolOf({ ...tool, facts: { amount: { path: '.amount', type: 'number' } } })
    ).not.toHaveProperty('factsUnreadable');
  });
});

describe('a simulation with rules', () => {
  const answer = (considered: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    data: {
      decision: 'step_up',
      action_digest: 'sha256:aa',
      enforced: false,
      considered: {
        policies: [{ kind: 'tool_invocation', id: 'p', version: 1, result: 'deny', ...considered }],
        composed: { decision: 'deny' },
      },
      ...extra,
    },
  });
  const names = new Map<string, string>();

  it('reads the rule that gave a result and the facts a rule needed', () => {
    const rule = simulationOf(answer({ rule: { index: 2, then: 'deny' } }), 'p', names);
    expect(rule?.considered?.policies[0]).toMatchObject({ rule: { index: 2, then: 'deny' } });
    const missing = simulationOf(
      answer({ result: 'ask', missing_facts: ['amount', 'env'] }, { missing_facts: ['amount'] }),
      'p',
      names
    );
    expect(missing?.considered?.policies[0]?.missingFacts).toEqual(['amount', 'env']);
    expect(missing?.missingFacts).toEqual(['amount']);
  });

  it('carries neither when the service sent neither', () => {
    const plain = simulationOf(answer({}), 'p', names);
    expect(plain?.considered?.policies[0]).not.toHaveProperty('rule');
    expect(plain?.considered?.policies[0]).not.toHaveProperty('missingFacts');
    expect(plain).not.toHaveProperty('missingFacts');
  });

  it.each([
    ['a rule that is no object', { rule: 'x' }],
    ['a rule without an index', { rule: { then: 'deny' } }],
    ['a rule with a negative index', { rule: { index: -1, then: 'deny' } }],
    ['a rule without an outcome', { rule: { index: 0 } }],
    ['missing facts that are no list', { missing_facts: 'amount' }],
    ['missing facts with a non-text', { missing_facts: ['a', 1] }],
  ])('treats %s as an answer it cannot read, never as the mode’s result', (_why, entry) => {
    expect(simulationOf(answer(entry), 'p', names)).toBeUndefined();
  });

  it('treats top-level missing facts that are not a list of text as unreadable', () => {
    expect(simulationOf(answer({}, { missing_facts: 'amount' }), 'p', names)).toBeUndefined();
    expect(simulationOf(answer({}, { missing_facts: [3] }), 'p', names)).toBeUndefined();
  });
});

describe('a refusal that names its member', () => {
  const problem = (status: number, code: string, member?: unknown) => ({
    type: `https://x/problems/${code}`,
    title: 't',
    status,
    detail: 'd',
    ...(member === undefined ? {} : { member }),
  });

  it('keeps the member of a 400 and of a 422, verbatim', () => {
    expect(
      permissionsErrorFromResponse(
        400,
        problem(400, 'invalid_request', 'config.rules[0].when[1].fact')
      )
    ).toMatchObject({
      kind: 'invalid_request',
      member: 'config.rules[0].when[1].fact',
      detail: 'd',
    });
    expect(
      permissionsErrorFromResponse(422, problem(422, 'unsupported_policy_form', 'config.rules'))
    ).toMatchObject({ kind: 'unprocessable', member: 'config.rules' });
  });

  it('keeps no member that is not text, and none that was not sent', () => {
    expect(
      permissionsErrorFromResponse(400, problem(400, 'invalid_request', 3))
    ).not.toHaveProperty('member');
    expect(permissionsErrorFromResponse(400, problem(400, 'invalid_request'))).not.toHaveProperty(
      'member'
    );
  });
});
