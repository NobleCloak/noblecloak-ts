/**
 * The mock's rev 16 behaviour: fact bindings on a tool, the write-time checks of rules and approvers, the decision of a
 * call that a rule-bearing policy matches (each outcome, and the unevaluable cases: a missing path, a wrong type, a
 * digest-only call), what a simulation considered, and the requirements of an approval (partial approve, reject,
 * dedupe of identical eligible sets, `exclude: requester`, the `approval_routing` break-glass setting, `waiting_on`),
 * with the features it advertises and the breaks that drop each rule.
 */
import { describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { createMock } from './app.js';
import type { Mock, MockOptions } from './app.js';
import type { Break } from './breaks.js';

const spec = loadCommittedDocument();
type Json = Record<string, unknown>;
const ADMIN_ROLE = 'policy_admin';

const AMOUNT_RULES = [
  { when: [{ fact: 'amount', op: 'gt', value: 5000 }], then: 'deny' },
  { when: [{ fact: 'amount', op: 'lte', value: 50 }], then: 'always_allow' },
];

const make = async (options: Partial<MockOptions> = {}) => {
  const mock: Mock = await createMock({ control: true, spec, ...options });
  const tokens = await mock.tokens();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  /** A user of the organisation holding `roles`, with the resolve scope. */
  const userWith = (sub: string, roles: readonly string[]): Promise<string> =>
    mock.issuer.mint({
      sub,
      org: 'org_mock',
      aud: mock.config.audience,
      exp,
      principal_kind: 'user',
      scope: ['approvals:resolve', ...roles.map((r) => `role:${r}`)].join(' '),
    } as never);
  const call = async (
    token: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: Json }> => {
    const response = await mock.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const data = (answer: { body: Json }): Json => answer.body.data as Json;
  let n = 0;
  /** Registers an organisation-owned tool with `facts` and returns its reference. */
  const tool = async (facts: unknown = { amount: { path: '.amount', type: 'number' } }) => {
    n += 1;
    const ref = `ext:rev16:${String(n)}`;
    const answer = await call(tokens.admin, 'POST', '/v1/tools', {
      tool_ref: ref,
      transport: 'external',
      input_schema: { type: 'object' },
      side_effect_level: 'write',
      owner_kind: 'org',
      ...(facts === undefined ? {} : { facts }),
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    return { ref, id: String(data(answer).id) };
  };
  /** Creates and publishes a policy; returns its id. */
  const publish = async (body: Json): Promise<string> => {
    const created = await call(tokens.admin, 'POST', '/v1/policies', body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(data(created).id);
    const published = await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    return id;
  };
  const policy = (ref: string, config: Json, subject: Json = { type: 'organization' }): Json => ({
    kind: 'tool_invocation',
    subjects: [subject],
    targets: { tools: [ref] },
    config,
  });
  /** A decision by the creator user. */
  const decide = (ref: string, action: Json, token = tokens.creator_user) =>
    call(token, 'POST', '/v1/decisions', {
      action: { tool_ref: ref, ...action },
      continuation: { kind: 'langgraph', delivery: 'pull' },
    });
  /** Opens an approval with a decision and reads it back by the approver. */
  const open = async (ref: string, args: Json, token = tokens.creator_user) => {
    const answer = await decide(ref, { arguments: args }, token);
    expect(data(answer).decision, JSON.stringify(answer.body)).toBe('step_up');
    const id = String((data(answer).approval as Json).id);
    return { id, digest: String(data(answer).action_digest) };
  };
  const approve = (token: string, approval: { id: string; digest: string }) =>
    call(token, 'POST', `/v1/approvals/${approval.id}/approve`, {
      expected_action_digest: approval.digest,
    });
  const read = async (token: string, id: string): Promise<Json> =>
    data(await call(token, 'GET', `/v1/approvals/${id}`));
  return {
    mock,
    tokens,
    userWith,
    call,
    data,
    tool,
    publish,
    policy,
    decide,
    open,
    approve,
    read,
  };
};

describe('the mock, rev 16: features and forms', () => {
  it('advertises tools.facts everywhere, and policies.rules and approvals.requirements where it authors policies', async () => {
    const hosted = await make();
    const caps = hosted.data(await hosted.call(hosted.tokens.creator, 'GET', '/v1/capabilities'));
    expect(caps.features).toEqual(
      expect.arrayContaining(['tools.facts', 'policies.rules', 'approvals.requirements'])
    );
    const edge = await make({ deployment: 'edge' });
    const edgeCaps = edge.data(await edge.call(edge.tokens.creator, 'GET', '/v1/capabilities'));
    expect(edgeCaps.features).toContain('tools.facts');
    expect(edgeCaps.features).not.toContain('policies.rules');
    expect(edgeCaps.features).not.toContain('approvals.requirements');
  });

  it('without approvals, keeps rules but neither the requirement members nor the routing kind, and refuses them 422', async () => {
    const m = await make({ advertise: ['policies', 'agents', 'principals'] });
    const caps = m.data(await m.call(m.tokens.creator, 'GET', '/v1/capabilities'));
    expect(caps.features).toContain('policies.rules');
    expect(caps.features).not.toContain('approvals.requirements');
    expect(caps.policy_forms).toEqual({
      tool_invocation: expect.objectContaining({
        config_members: ['on_deny', 'expires_after', 'approver_groups', 'rules'],
      }) as unknown,
    });
    const { ref } = await m.tool();
    const approvers = await m.call(
      m.tokens.admin,
      'POST',
      '/v1/policies',
      m.policy(ref, { mode: 'ask', approvers: [{ role: 'finance' }] })
    );
    expect(approvers.status).toBe(422);
    expect(approvers.body.member).toBe('config.approvers');
    const ruleApprovers = await m.call(
      m.tokens.admin,
      'POST',
      '/v1/policies',
      m.policy(ref, {
        mode: 'ask',
        rules: [{ ...AMOUNT_RULES[0], then: 'ask', approvers: [{ role: 'finance' }] }],
      })
    );
    expect(ruleApprovers.status).toBe(422);
    expect(ruleApprovers.body.member).toBe('config.rules[0].approvers');
    const routing = await m.call(m.tokens.admin, 'POST', '/v1/policies', {
      kind: 'approval_routing',
      subjects: [{ type: 'organization' }],
      config: { org_admin_break_glass: false },
    });
    expect(routing.status).toBe(422);
    expect(routing.body.member).toBe('kind');
    // Rules alone are served.
    const rules = await m.call(
      m.tokens.admin,
      'POST',
      '/v1/policies',
      m.policy(ref, { mode: 'ask', rules: AMOUNT_RULES })
    );
    expect(rules.status, JSON.stringify(rules.body)).toBe(201);
  });
});

describe('the mock, rev 16: fact bindings', () => {
  it('keeps the facts of a registration, replaces them on a patch and clears them with null', async () => {
    const m = await make();
    const { id } = await m.tool({ amount: { path: '.amount', type: 'number' } });
    expect(m.data(await m.call(m.tokens.admin, 'GET', `/v1/tools/${id}`)).facts).toEqual({
      amount: { path: '.amount', type: 'number' },
    });
    const patched = await m.call(m.tokens.admin, 'PATCH', `/v1/tools/${id}`, {
      facts: { recipients: { path: '.to', type: 'count' } },
    });
    expect(m.data(patched).facts).toEqual({ recipients: { path: '.to', type: 'count' } });
    const cleared = await m.call(m.tokens.admin, 'PATCH', `/v1/tools/${id}`, { facts: null });
    expect(cleared.status).toBe(200);
    expect(m.data(cleared)).not.toHaveProperty('facts');
  });

  it('refuses a path that selects a set with 400 naming the binding, on a write and on a patch', async () => {
    const m = await make();
    for (const path of ['.lines[*].price', '..amount']) {
      const refused = await m.call(m.tokens.admin, 'POST', '/v1/tools', {
        tool_ref: 'ext:rev16:set',
        transport: 'external',
        input_schema: { type: 'object' },
        side_effect_level: 'write',
        facts: { price: { path, type: 'number' } },
      });
      expect(refused.status).toBe(400);
      expect(refused.body.member).toBe('facts.price.path');
    }
    const { id } = await m.tool();
    const patched = await m.call(m.tokens.admin, 'PATCH', `/v1/tools/${id}`, {
      facts: { price: { path: '.lines[*]', type: 'count' } },
    });
    expect(patched.status).toBe(400);
    expect(patched.body.member).toBe('facts.price.path');
  });
});

describe('the mock, rev 16: write-time checks of a condition', () => {
  it('refuses a condition whose fact a known target does not declare, naming it', async () => {
    const m = await make();
    const { ref } = await m.tool({ amount: { path: '.amount', type: 'number' } });
    const refused = await m.call(
      m.tokens.admin,
      'POST',
      '/v1/policies',
      m.policy(ref, {
        mode: 'ask',
        rules: [
          AMOUNT_RULES[0],
          {
            when: [
              { fact: 'amount', op: 'gt', value: 1 },
              { fact: 'region', op: 'exists' },
            ],
            then: 'deny',
          },
        ],
      })
    );
    expect(refused.status).toBe(400);
    expect(refused.body.member).toBe('config.rules[1].when[1].fact');
    const approver = await m.call(
      m.tokens.admin,
      'POST',
      '/v1/policies',
      m.policy(ref, {
        mode: 'ask',
        approvers: [{ role: 'finance', when: [{ fact: 'region', op: 'eq', value: 'eu' }] }],
      })
    );
    expect(approver.status).toBe(400);
    expect(approver.body.member).toBe('config.approvers[0].when[0].fact');
  });

  it('refuses gt on a string fact, and accepts it on a number or a count', async () => {
    const m = await make();
    const { ref } = await m.tool({
      currency: { path: '.currency', type: 'string' },
      recipients: { path: '.to', type: 'count' },
    });
    const refused = await m.call(
      m.tokens.admin,
      'POST',
      '/v1/policies',
      m.policy(ref, {
        mode: 'ask',
        rules: [{ when: [{ fact: 'currency', op: 'gt', value: 1 }], then: 'deny' }],
      })
    );
    expect(refused.status).toBe(400);
    expect(refused.body.member).toBe('config.rules[0].when[0].fact');
    const accepted = await m.call(
      m.tokens.admin,
      'POST',
      '/v1/policies',
      m.policy(ref, {
        mode: 'ask',
        rules: [{ when: [{ fact: 'recipients', op: 'gt', value: 10 }], then: 'deny' }],
      })
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  });

  it('accepts any condition when a target is not known yet, or the policy targets every tool', async () => {
    const m = await make();
    const rules = [{ when: [{ fact: 'region', op: 'eq', value: 'eu' }], then: 'deny' }];
    for (const targets of [{ tools: ['ext:rev16:not-yet'] }, { tools: 'all' }]) {
      const answer = await m.call(m.tokens.admin, 'POST', '/v1/policies', {
        kind: 'tool_invocation',
        subjects: [{ type: 'role', id: 'member' }],
        targets,
        config: { mode: 'ask', rules },
      });
      expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    }
  });

  it('takes an approval_routing policy for the organisation and every tool only', async () => {
    const m = await make();
    const base = { kind: 'approval_routing', config: { org_admin_break_glass: false } };
    const role = await m.call(m.tokens.admin, 'POST', '/v1/policies', {
      ...base,
      subjects: [{ type: 'role', id: 'member' }],
    });
    expect(role.status).toBe(422);
    expect(role.body.member).toBe('subjects[0].type');
    const named = await m.call(m.tokens.admin, 'POST', '/v1/policies', {
      ...base,
      subjects: [{ type: 'organization' }],
      targets: { tools: ['ext:rev16:x'] },
    });
    expect(named.status).toBe(422);
    expect(named.body.member).toBe('targets.tools');
    const wrong = await m.call(m.tokens.admin, 'POST', '/v1/policies', {
      ...base,
      subjects: [{ type: 'organization' }],
      config: { mode: 'ask' },
    });
    expect(wrong.status).toBe(400);
  });
});

describe('the mock, rev 16: decisions over facts', () => {
  const setup = async (breaks: Break[] = []) => {
    const m = await make({ breaks: new Set(breaks) });
    const { ref } = await m.tool();
    const id = await m.publish(
      m.policy(ref, { mode: 'ask', rules: AMOUNT_RULES, approvers: [{ role: 'finance' }] })
    );
    return { m, ref, id };
  };

  it('decides by the first rule that matches, and by mode when none does', async () => {
    const { m, ref, id } = await setup();
    const deny = m.data(await m.decide(ref, { arguments: { amount: 6000 } }));
    expect(deny).toMatchObject({ decision: 'deny', reason: 'deny', policy: { id } });
    const allow = m.data(await m.decide(ref, { arguments: { amount: 20 } }));
    expect(allow).toMatchObject({ decision: 'allow', policy: { id } });
    const ask = m.data(await m.decide(ref, { arguments: { amount: 300 } }));
    expect(ask).toMatchObject({ decision: 'step_up', policy: { id } });
  });

  it('asks when the fact has no value: a digest-only call, a missing path, a value of another type', async () => {
    const { m, ref } = await setup();
    const digest = m.data(await m.decide(ref, { arg_digest: 'a'.repeat(64) }));
    expect(digest).toMatchObject({ decision: 'step_up', missing_facts: ['amount'] });
    expect(m.data(await m.decide(ref, { arguments: { other: 1 } }))).toMatchObject({
      decision: 'step_up',
      missing_facts: ['amount'],
    });
    expect(m.data(await m.decide(ref, { arguments: { amount: '6000' } }))).toMatchObject({
      decision: 'step_up',
      missing_facts: ['amount'],
    });
    // A step-up its mode gave names no missing fact, nor does any other decision.
    expect(m.data(await m.decide(ref, { arguments: { amount: 300 } }))).not.toHaveProperty(
      'missing_facts'
    );
    expect(m.data(await m.decide(ref, { arguments: { amount: 6000 } }))).not.toHaveProperty(
      'missing_facts'
    );
  });

  it('names the missing facts on the step-up of a deployment that does not serve approvals', async () => {
    const m = await make({ advertise: ['policies', 'agents', 'principals'] });
    const { ref } = await m.tool();
    await m.publish(m.policy(ref, { mode: 'ask', rules: AMOUNT_RULES }));
    // No continuation: a deployment that serves no approvals has nowhere to keep one.
    const answer = await m.call(m.tokens.creator_user, 'POST', '/v1/decisions', {
      action: { tool_ref: ref, arg_digest: 'f'.repeat(64) },
    });
    expect(m.data(answer)).toMatchObject({
      decision: 'step_up',
      missing_facts: ['amount'],
    });
  });

  it('lists the rule and the missing facts in what a simulation considered', async () => {
    const { m, ref, id } = await setup();
    const simulate = async (action: Json): Promise<Json[]> =>
      (
        m.data(
          await m.call(m.tokens.admin, 'POST', `/v1/policies/${id}/simulate`, {
            action: { tool_ref: ref, ...action },
            subject: { type: 'organization' },
          })
        ).considered as { policies: Json[] }
      ).policies;
    expect(await simulate({ arguments: { amount: 6000 } })).toContainEqual(
      expect.objectContaining({ id, result: 'deny', rule: { index: 0, then: 'deny' } })
    );
    const asked = (await simulate({ arguments: { amount: 300 } })).find((e) => e.id === id);
    expect(asked).toMatchObject({ result: 'ask' });
    expect(asked).not.toHaveProperty('rule');
    expect(asked).not.toHaveProperty('missing_facts');
    expect(await simulate({ arg_digest: 'b'.repeat(64) })).toContainEqual(
      expect.objectContaining({ id, result: 'ask', missing_facts: ['amount'] })
    );
    // The simulated decision names them too, as a decision does, and only on that step-up.
    const result = async (action: Json): Promise<Json> =>
      m.data(
        await m.call(m.tokens.admin, 'POST', `/v1/policies/${id}/simulate`, {
          action: { tool_ref: ref, ...action },
          subject: { type: 'organization' },
        })
      );
    expect(await result({ arg_digest: 'b'.repeat(64) })).toMatchObject({
      decision: 'step_up',
      missing_facts: ['amount'],
    });
    expect(await result({ arguments: { amount: 300 } })).not.toHaveProperty('missing_facts');
  });

  it('names no missing fact on a deny that the rejected-duplicate rule made of such a step-up', async () => {
    const m = await make();
    const finance = await m.userWith('user_finance', ['finance']);
    const { ref } = await m.tool();
    const id = await m.publish(
      m.policy(ref, {
        mode: 'ask',
        rules: [
          {
            when: [{ fact: 'amount', op: 'gt', value: 100 }],
            then: 'ask',
            approvers: [{ role: 'finance' }],
          },
        ],
      })
    );
    const digest = '9'.repeat(64);
    const opened = m.data(await m.decide(ref, { arg_digest: digest }, m.tokens.admin));
    expect(opened.missing_facts).toEqual(['amount']);
    const rejected = await m.call(
      finance,
      'POST',
      `/v1/approvals/${String((opened.approval as Json).id)}/deny`,
      { expected_action_digest: digest }
    );
    expect(m.data(rejected).state).toBe('rejected');
    const simulated = m.data(
      await m.call(m.tokens.admin, 'POST', `/v1/policies/${id}/simulate`, {
        action: { tool_ref: ref, arg_digest: digest },
      })
    );
    expect(simulated).toMatchObject({ decision: 'deny', reason: 'rejected_duplicate' });
    expect(simulated).not.toHaveProperty('missing_facts');
    const decided = m.data(await m.decide(ref, { arg_digest: digest }, m.tokens.admin));
    expect(decided).toMatchObject({ decision: 'deny', reason: 'rejected_duplicate' });
    expect(decided).not.toHaveProperty('missing_facts');
  });

  it('leaves the fixture decision of a call no rule-bearing policy matches as it was', async () => {
    const m = await make();
    const { ref } = await m.tool();
    // An always_allow policy for the organisation with no rev 16 member: the fixture (the tool's own `ask`) decides.
    await m.publish(m.policy(ref, { mode: 'always_allow' }));
    const answer = m.data(await m.decide(ref, { arguments: { amount: 1 } }));
    expect(answer.decision).toBe('step_up');
    expect(answer).not.toHaveProperty('policy');
  });

  it('composes only the rule-bearing policies whose subject the caller holds', async () => {
    const m = await make();
    const finance = await m.userWith('user_finance', ['finance']);
    const { ref } = await m.tool();
    const id = await m.publish(
      m.policy(
        ref,
        {
          mode: 'ask',
          rules: [{ when: [{ fact: 'amount', op: 'gt', value: 100 }], then: 'deny' }],
        },
        { type: 'role', id: 'finance' }
      )
    );
    // The creator holds no finance role: the policy is not its, and the fixture (the tool's own ask) decides.
    const outside = m.data(await m.decide(ref, { arguments: { amount: 300 } }));
    expect(outside.decision).toBe('step_up');
    expect(outside).not.toHaveProperty('policy');
    const holder = m.data(await m.decide(ref, { arguments: { amount: 300 } }, finance));
    expect(holder).toMatchObject({ decision: 'deny', policy: { id } });
  });

  it('composes rule-bearing policies tightest-wins with the others that match', async () => {
    const { m, ref } = await setup();
    const plain = await m.publish(
      m.policy(ref, { mode: 'deny' }, { type: 'role', id: 'everyone' })
    );
    const answer = m.data(await m.decide(ref, { arguments: { amount: 20 } }));
    expect(answer).toMatchObject({ decision: 'deny', policy: { id: plain } });
  });

  it('the defects: rules_ignored decides by mode; missing_fact_falls_to_mode skips the rule it cannot evaluate', async () => {
    const ignored = await setup(['rules_ignored']);
    expect(
      ignored.m.data(await ignored.m.decide(ignored.ref, { arguments: { amount: 6000 } })).decision
    ).toBe('step_up');
    const falls = await make({ breaks: new Set<Break>(['missing_fact_falls_to_mode']) });
    const { ref } = await falls.tool();
    await falls.publish(
      falls.policy(ref, {
        mode: 'always_allow',
        rules: [{ when: [{ fact: 'amount', op: 'gt', value: 100 }], then: 'ask' }],
      })
    );
    expect(falls.data(await falls.decide(ref, { arg_digest: 'c'.repeat(64) })).decision).toBe(
      'allow'
    );
  });
});

describe('the mock, rev 16: requirements', () => {
  /** A tool and two ask policies for the organisation, by different subjects, each with its own approvers. */
  const twoRequirements = async (breaks: Break[] = []) => {
    const m = await make({ breaks: new Set(breaks) });
    const finance = await m.userWith('user_finance', ['finance']);
    const lead = await m.userWith('user_lead', ['team_lead']);
    const { ref } = await m.tool();
    const one = await m.publish(m.policy(ref, { mode: 'ask', approvers: [{ role: 'finance' }] }));
    const two = await m.publish(
      m.policy(
        ref,
        { mode: 'ask', approvers: [{ role: 'team_lead' }] },
        {
          type: 'role',
          id: 'everyone',
        }
      )
    );
    return { m, finance, lead, ref, one, two };
  };

  it('opens one approval with a requirement per policy; a partial approve leaves it pending and updated', async () => {
    const { m, finance, lead, ref, one, two } = await twoRequirements();
    const approval = await m.open(ref, { amount: 300 });
    const opened = await m.read(m.tokens.creator_user, approval.id);
    expect(opened.requirements).toEqual([
      {
        id: 'r1',
        policies: [{ id: one, version: expect.any(Number) as unknown }],
        approvers: [{ role: 'finance' }],
        exclude: [],
        needed: 1,
        met: false,
        approvals: [],
      },
      {
        id: 'r2',
        policies: [{ id: two, version: expect.any(Number) as unknown }],
        approvers: [{ role: 'team_lead' }],
        exclude: [],
        needed: 1,
        met: false,
        approvals: [],
      },
    ]);
    const updates: string[] = [];
    m.mock.state.listeners.add((o) => updates.push(o.state));
    const partial = await m.approve(finance, approval);
    expect(partial.status).toBe(200);
    const after = m.data(partial);
    expect(after.state).toBe('pending');
    expect(after).not.toHaveProperty('resolution');
    expect(updates).toEqual(['pending']);
    const [r1, r2] = after.requirements as Json[];
    expect(r1).toMatchObject({
      met: true,
      approvals: [{ by: { id: 'user_finance', kind: 'user' }, basis: 'listed' }],
    });
    expect(r2).toMatchObject({ met: false, approvals: [] });
    // The finance member has met what it may: approving again is not eligible.
    expect((await m.approve(finance, approval)).status).toBe(403);
    const done = await m.approve(lead, approval);
    expect(m.data(done)).toMatchObject({ state: 'approved', resolution: 'approved' });
  });

  it('in a batch, a repeat by an approver with no unmet requirement left is not_eligible while the approval is pending', async () => {
    const { m, finance, lead, ref } = await twoRequirements();
    const approval = await m.open(ref, { amount: 300 });
    const item = {
      approval_id: approval.id,
      resolution: 'approved',
      expected_action_digest: approval.digest,
    };
    const batch = async (token: string): Promise<Json[]> => {
      const answer = await m.call(token, 'POST', '/v1/approvals/resolve/batch', {
        items: [item, item],
      });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return answer.body.data as Json[];
    };
    const [first, repeat] = await batch(finance);
    expect(first).toMatchObject({ state: 'pending' });
    expect(repeat).toMatchObject({ status: 403 });
    expect(String(repeat?.type)).toMatch(/not_eligible$/);
    // Once every requirement is met, a repeat is the conflict of an approval no longer pending.
    const [last, again] = await batch(lead);
    expect(last).toMatchObject({ state: 'approved' });
    expect(String(again?.type)).toMatch(/already_resolved$/);
  });

  it('the defect partial_approve_resolves approves the whole approval on the first approve', async () => {
    const { m, finance, ref } = await twoRequirements(['partial_approve_resolves']);
    const approval = await m.open(ref, { amount: 300 });
    expect(m.data(await m.approve(finance, approval)).state).toBe('approved');
  });

  it('lets anyone eligible for an unmet requirement reject, and refuses one eligible for none', async () => {
    const { m, lead, ref } = await twoRequirements();
    const approval = await m.open(ref, { amount: 300 });
    const outsider = await m.approve(m.tokens.approver, approval);
    expect(outsider.status).toBe(403);
    expect(String(outsider.body.type)).toMatch(/not_eligible$/);
    const rejected = await m.call(lead, 'POST', `/v1/approvals/${approval.id}/deny`, {
      expected_action_digest: approval.digest,
    });
    expect(m.data(rejected)).toMatchObject({ state: 'rejected', resolution: 'rejected' });
  });

  it('dedupes requirements whose eligible sets and exclude are the same, listing every policy', async () => {
    const m = await make();
    const { ref } = await m.tool();
    const one = await m.publish(m.policy(ref, { mode: 'ask', approvers: [{ role: 'finance' }] }));
    const two = await m.publish(
      m.policy(
        ref,
        {
          mode: 'ask',
          approvers: [
            { role: 'finance' },
            // Not in force for this call: the set in force is the same as the first policy's.
            { user: 'user_approver', when: [{ fact: 'amount', op: 'gt', value: 1000 }] },
          ],
        },
        { type: 'role', id: 'everyone' }
      )
    );
    const approval = await m.open(ref, { amount: 300 });
    const requirements = (await m.read(m.tokens.creator_user, approval.id)).requirements as Json[];
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.policies).toEqual([
      expect.objectContaining({ id: one }),
      expect.objectContaining({ id: two }),
    ]);
    // A different exclude keeps them apart.
    const other = await m.tool();
    await m.publish(m.policy(other.ref, { mode: 'ask', approvers: [{ role: 'finance' }] }));
    await m.publish(
      m.policy(
        other.ref,
        { mode: 'ask', approvers: [{ role: 'finance' }], exclude: ['requester'] },
        {
          type: 'role',
          id: 'everyone',
        }
      )
    );
    const apart = await m.open(other.ref, { amount: 300 });
    expect((await m.read(m.tokens.creator_user, apart.id)).requirements).toHaveLength(2);
    // An entry listed twice is one: the set is the same as a policy that lists it once.
    const twice = await m.tool();
    await m.publish(
      m.policy(twice.ref, { mode: 'ask', approvers: [{ role: 'finance' }, { role: 'finance' }] })
    );
    await m.publish(
      m.policy(
        twice.ref,
        { mode: 'ask', approvers: [{ role: 'finance' }] },
        { type: 'role', id: 'everyone' }
      )
    );
    const once = await m.open(twice.ref, { amount: 300 });
    expect((await m.read(m.tokens.creator_user, once.id)).requirements).toMatchObject([
      { approvers: [{ role: 'finance' }] },
    ]);
  });

  it("uses the matching ask rule's approvers, else the policy's, and an empty set for the organisation's administrators", async () => {
    const m = await make();
    const lead = await m.userWith('user_lead', ['team_lead']);
    const { ref } = await m.tool();
    await m.publish(
      m.policy(ref, {
        mode: 'ask',
        rules: [
          {
            when: [{ fact: 'amount', op: 'lte', value: 500 }],
            then: 'ask',
            approvers: [{ role: 'team_lead' }],
          },
        ],
        approvers: [{ role: 'finance' }],
      })
    );
    const small = await m.open(ref, { amount: 300 });
    expect((await m.read(m.tokens.creator_user, small.id)).requirements).toMatchObject([
      { approvers: [{ role: 'team_lead' }] },
    ]);
    expect(m.data(await m.approve(lead, small)).state).toBe('approved');
    const large = await m.open(ref, { amount: 900 });
    expect((await m.read(m.tokens.creator_user, large.id)).requirements).toMatchObject([
      { approvers: [{ role: 'finance' }] },
    ]);
    // No approvers at all: the organisation's administrators.
    const bare = await m.tool();
    await m.publish(m.policy(bare.ref, { mode: 'ask', rules: AMOUNT_RULES }));
    const admins = await m.open(bare.ref, { amount: 300 });
    expect((await m.read(m.tokens.creator_user, admins.id)).requirements).toMatchObject([
      { approvers: [] },
    ]);
    expect((await m.approve(m.tokens.approver, admins)).status).toBe(403);
    expect(m.data(await m.approve(m.tokens.admin, admins))).toMatchObject({ state: 'approved' });
  });

  it("routes a call whose facts are missing to the stopping ask rule's approvers, else to the administrators", async () => {
    const m = await make();
    const lead = await m.userWith('user_lead', ['team_lead']);
    const cfo = await m.userWith('user_cfo', ['cfo']);
    const { ref } = await m.tool();
    await m.publish(
      m.policy(ref, {
        mode: 'ask',
        approvers: [{ role: 'team_lead' }],
        rules: [
          {
            when: [{ fact: 'amount', op: 'gt', value: 1000 }],
            then: 'ask',
            approvers: [{ role: 'cfo' }],
          },
        ],
      })
    );
    const digestOnly = await m.decide(ref, { arg_digest: 'd'.repeat(64) });
    const stopped = {
      id: String((m.data(digestOnly).approval as Json).id),
      digest: 'd'.repeat(64),
    };
    expect((await m.read(m.tokens.creator_user, stopped.id)).requirements).toMatchObject([
      { approvers: [{ role: 'cfo' }] },
    ]);
    expect((await m.approve(lead, stopped)).status).toBe(403);
    expect(m.data(await m.approve(cfo, stopped)).state).toBe('approved');
    // Stopped at a deny rule: the policy's approvers are not used, the administrators are.
    const other = await m.tool();
    await m.publish(
      m.policy(other.ref, { mode: 'ask', rules: AMOUNT_RULES, approvers: [{ role: 'team_lead' }] })
    );
    const atDeny = await m.decide(other.ref, { arg_digest: 'e'.repeat(64) });
    const admins = {
      id: String((m.data(atDeny).approval as Json).id),
      digest: 'e'.repeat(64),
    };
    expect((await m.read(m.tokens.creator_user, admins.id)).requirements).toMatchObject([
      { approvers: [] },
    ]);
    expect((await m.approve(lead, admins)).status).toBe(403);
  });

  it('routes an approval opened through POST /v1/approvals as a decision would, and a decision that joins it keeps that', async () => {
    const m = await make();
    const finance = await m.userWith('user_finance', ['finance']);
    const cfo = await m.userWith('user_cfo', ['cfo']);
    const { ref } = await m.tool();
    await m.publish(m.policy(ref, { mode: 'ask', approvers: [{ role: 'cfo' }] }));
    const created = await m.call(m.tokens.creator_user, 'POST', '/v1/approvals', {
      action: { tool_ref: ref, arguments: { amount: 300 } },
      continuation: { kind: 'langgraph', delivery: 'pull' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(m.data(created).id);
    expect((await m.read(m.tokens.creator_user, id)).requirements).toMatchObject([
      { approvers: [{ role: 'cfo' }], met: false },
    ]);
    const joined = m.data(await m.decide(ref, { arguments: { amount: 300 } }));
    const approval = { id, digest: String(joined.action_digest) };
    expect((joined.approval as Json).id).toBe(id);
    expect((await m.read(m.tokens.creator_user, id)).requirements).toHaveLength(1);
    expect((await m.approve(finance, approval)).status).toBe(403);
    expect(m.data(await m.approve(cfo, approval)).state).toBe('approved');
  });

  it('adds what a joining decision requires to a pending approval, and opens another beside an approved one', async () => {
    const m = await make();
    const finance = await m.userWith('user_finance', ['finance']);
    const { ref } = await m.tool();
    // Opened before any rule-bearing policy: no requirements.
    const created = await m.call(m.tokens.creator_user, 'POST', '/v1/approvals', {
      action: { tool_ref: ref, arguments: { amount: 300 } },
      continuation: { kind: 'langgraph', delivery: 'pull' },
    });
    const id = String(m.data(created).id);
    expect(await m.read(m.tokens.creator_user, id)).not.toHaveProperty('requirements');
    await m.publish(m.policy(ref, { mode: 'ask', approvers: [{ role: 'finance' }] }));
    const updates: string[] = [];
    m.mock.state.listeners.add((o) => updates.push(o.id));
    const joined = m.data(await m.decide(ref, { arguments: { amount: 300 } }));
    expect((joined.approval as Json).id).toBe(id);
    expect(updates).toEqual([id]);
    expect((await m.read(m.tokens.creator_user, id)).requirements).toMatchObject([
      { id: 'r1', approvers: [{ role: 'finance' }], met: false },
    ]);
    const approval = { id, digest: String(joined.action_digest) };
    expect((await m.approve(m.tokens.approver, approval)).status).toBe(403);
    expect(m.data(await m.approve(finance, approval)).state).toBe('approved');
    // Approved under that requirement, it is not joined by a call that requires another: a separate one opens.
    await m.publish(
      m.policy(ref, { mode: 'ask', approvers: [{ role: 'cfo' }] }, { type: 'role', id: 'everyone' })
    );
    const separate = m.data(await m.decide(ref, { arguments: { amount: 300 } }));
    const other = (separate.approval as Json).id;
    expect(other).not.toBe(id);
    expect((await m.read(m.tokens.creator_user, String(other))).state).toBe('pending');
    expect((await m.read(m.tokens.creator_user, id)).state).toBe('approved');
    // The same call with nothing new to require joins the approval that is open now.
    const again = m.data(await m.decide(ref, { arguments: { amount: 300 } }));
    expect((again.approval as Json).id).toBe(other);
  });

  it('keeps the requester out of a requirement that excludes it, from the approver surface and as an administrator', async () => {
    const run = async (breaks: Break[]) => {
      const m = await make({ breaks: new Set(breaks) });
      const { ref } = await m.tool();
      await m.publish(
        m.policy(ref, { mode: 'ask', approvers: [{ role: ADMIN_ROLE }], exclude: ['requester'] })
      );
      const approval = await m.open(ref, { amount: 300 });
      // The creator's own token issued to the approver surface also holds the administrator role.
      return { m, approval, answer: await m.approve(m.tokens.approver_surface_token, approval) };
    };
    const { m, approval, answer } = await run([]);
    expect(answer.status).toBe(403);
    expect(m.data(await m.approve(m.tokens.admin, approval)).state).toBe('approved');
    expect((await run(['exclude_requester_ignored'])).answer.status).toBe(200);
  });

  it('lets an administrator satisfy every requirement under break-glass, and only the listed ones with it off', async () => {
    const run = async (breaks: Break[]) => {
      const m = await make({ breaks: new Set(breaks) });
      const { ref } = await m.tool();
      await m.publish(m.policy(ref, { mode: 'ask', approvers: [{ user: 'user_approver' }] }));
      await m.publish(
        m.policy(
          ref,
          { mode: 'ask', approvers: [{ role: 'finance' }] },
          { type: 'role', id: 'everyone' }
        )
      );
      return { m, ref };
    };
    const on = await run([]);
    const glass = await on.m.open(on.ref, { amount: 1 });
    const broken = on.m.data(await on.m.approve(on.m.tokens.admin, glass));
    expect(broken.state).toBe('approved');
    expect(broken.requirements).toMatchObject([
      { met: true, approvals: [{ basis: 'break_glass' }] },
      { met: true, approvals: [{ basis: 'break_glass' }] },
    ]);
    const off = await run([]);
    await off.m.publish({
      kind: 'approval_routing',
      subjects: [{ type: 'organization' }],
      config: { org_admin_break_glass: false },
    });
    const shut = await off.m.open(off.ref, { amount: 2 });
    expect((await off.m.approve(off.m.tokens.admin, shut)).status).toBe(403);
    expect(off.m.data(await off.m.approve(off.m.tokens.approver, shut)).state).toBe('pending');
    // The most recently published setting is in force.
    await off.m.publish({
      kind: 'approval_routing',
      subjects: [{ type: 'organization' }],
      config: { org_admin_break_glass: true },
    });
    expect(off.m.data(await off.m.approve(off.m.tokens.admin, shut)).state).toBe('approved');
    const ignored = await run(['break_glass_ignores_setting']);
    await ignored.m.publish({
      kind: 'approval_routing',
      subjects: [{ type: 'organization' }],
      config: { org_admin_break_glass: false },
    });
    const leaked = await ignored.m.open(ignored.ref, { amount: 3 });
    expect((await ignored.m.approve(ignored.m.tokens.admin, leaked)).status).toBe(200);
  });

  it('tells the creator it waits on those eligible for an unmet requirement, and lists actions only to them', async () => {
    const { m, finance, lead, ref } = await twoRequirements();
    // Each is seen once, so the mock knows of it.
    await m.call(finance, 'GET', '/v1/capabilities');
    await m.call(lead, 'GET', '/v1/capabilities');
    const approval = await m.open(ref, { amount: 300 });
    const ids = async (): Promise<string[]> =>
      (
        ((await m.read(m.tokens.creator_user, approval.id)).waiting_on as Json).principals as Json[]
      ).map((p) => String(p.id));
    expect(await ids()).toEqual(expect.arrayContaining(['user_finance', 'user_lead']));
    expect(await ids()).not.toContain('user_approver');
    await m.approve(finance, approval);
    expect(await ids()).not.toContain('user_finance');
    expect(await ids()).toContain('user_lead');
    expect((await m.read(finance, approval.id)).available_actions).toBeUndefined();
    expect((await m.read(lead, approval.id)).available_actions).toBeDefined();
  });
});
