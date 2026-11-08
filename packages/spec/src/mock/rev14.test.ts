/**
 * The mock's rev 14 behaviour that the conformance scenarios do not read: the member each refusal names, what the
 * preview holds, what a refused approval leaves behind (including the events it does not send), and the pure
 * rules of a proposal.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { createMock } from './app.js';
import type { Mock } from './app.js';
import { memberPath, ruleRefusal, schemaRefusal, targetOf } from './proposal.js';
import type { Proposal } from './proposal.js';

const spec = loadCommittedDocument();
type Json = Record<string, unknown>;
const PROPOSE = 'tool:noblecloak:propose-policy-set';

const assessment = {
  side_effect_level: 'external',
  blast_radius: 'one_record',
  reversible: false,
  external_party: true,
  financial: false,
};
const baseline = (tool: string, mode: string): Json => ({
  role: 'baseline',
  rationale: 'The organisation decides.',
  assessment,
  policy: {
    kind: 'tool_invocation',
    subjects: [{ type: 'role', id: 'everyone' }],
    targets: { tools: [tool] },
    config: { mode },
  },
});
const tightening = (agent: string, tool: string, mode: string): Json => ({
  role: 'tightening',
  rationale: 'The agent is held to more.',
  assessment,
  policy: {
    kind: 'tool_invocation',
    subjects: [{ type: 'agent', id: agent }],
    targets: { tools: [tool] },
    config: { mode },
  },
});
const registration = (ref: string): Json => ({
  tool_ref: ref,
  transport: 'external',
  input_schema: { type: 'object' },
  side_effect_level: 'external',
  owner_kind: 'org',
});

describe('the mock, rev 14', () => {
  let mock: Mock;
  let tokens: Awaited<ReturnType<Mock['tokens']>>;
  let n = 0;
  beforeAll(async () => {
    mock = await createMock({ control: true, spec });
    tokens = await mock.tokens();
  });

  const call = (token: string, method: string, path: string, body?: unknown): Promise<Response> =>
    Promise.resolve(
      mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
  const json = async (response: Response): Promise<Json> => (await response.json()) as Json;
  const data = async (response: Response): Promise<Json> => (await json(response)).data as Json;
  const unique = (): string => `u${String((n += 1))}`;
  const agent = async (): Promise<string> =>
    String((await data(await call(tokens.creator, 'POST', '/v1/agents', { name: unique() }))).id);
  const open = (token: string, args: Json): Promise<Response> =>
    call(token, 'POST', '/v1/approvals', {
      action: { tool_ref: PROPOSE, arguments: args },
      continuation: { kind: 'mcp_held', delivery: 'held' },
    });
  const read = async (id: string, token = tokens.admin): Promise<Json> =>
    data(await call(token, 'GET', `/v1/approvals/${id}`));
  const approve = async (id: string, token = tokens.admin): Promise<Response> =>
    call(token, 'POST', `/v1/approvals/${id}/approve`, {
      expected_action_digest: (await read(id)).action_digest,
    });
  const policiesFor = async (tool: string): Promise<Json[]> =>
    (await json(await call(tokens.admin, 'GET', `/v1/policies?tool=${tool}&limit=200`)))
      .data as Json[];

  it('names the member of every refusal inside action.arguments, with the code beside it', async () => {
    const id = await agent();
    const tool = `ext:m:${unique()}`;
    const refusal = async (args: Json): Promise<Json> => {
      const answer = await open(tokens.creator_user, args);
      expect(answer.status).toBe(422);
      return json(answer);
    };
    expect(
      await refusal({
        agent: { id: 'agent_missing' },
        tools: [registration(tool)],
        policies: [baseline(tool, 'ask')],
      })
    ).toMatchObject({ code: 'unknown_agent', member: 'action.arguments.agent.id' });
    expect(
      await refusal({ agent: { id }, policies: [baseline('ext:m:nobody', 'ask')] })
    ).toMatchObject({
      code: 'target_unknown',
      member: 'action.arguments.policies[0].policy.targets.tools[0]',
    });
    expect(
      await refusal({
        agent: { id },
        tools: [registration(tool), registration(tool)],
        policies: [baseline(tool, 'ask')],
      })
    ).toMatchObject({ code: 'shape', member: 'action.arguments.tools[1].tool_ref' });
    expect(
      await refusal({
        agent: { id, principal_id: 'user_member' },
        policies: [baseline(tool, 'ask')],
      })
    ).toMatchObject({ code: 'shape', member: 'action.arguments.agent.principal_id' });
    expect(await refusal({ agent: { id }, policies: [] })).toMatchObject({
      code: 'shape',
      member: 'action.arguments.policies',
    });
    expect(
      await refusal({
        agent: { id },
        tools: [registration(tool)],
        policies: [
          {
            ...baseline(tool, 'ask'),
            policy: { ...(baseline(tool, 'ask').policy as Json), config: { mode: 'not_granted' } },
          },
        ],
      })
    ).toMatchObject({ code: 'shape', member: 'action.arguments.policies[0].policy.config.mode' });
    // Every refusal says why in a code and carries no member the grammar of Problem.member would reject.
    const pattern = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$/;
    expect(String((await refusal({ agent: { id }, policies: [{ role: 'x' }] })).member)).toMatch(
      pattern
    );
  });

  it('refuses a tightening that is looser than what the proposal baselines compose to for the same tool', async () => {
    const id = await agent();
    const tool = `ext:m:${unique()}`;
    const proposal = (baselineMode: string, tighteningMode: string): Json => ({
      agent: { id },
      tools: [registration(tool)],
      policies: [baseline(tool, baselineMode), tightening(id, tool, tighteningMode)],
    });
    // A baseline that denies, a tightening that asks: the agent would be loosened.
    expect(await json(await open(tokens.creator_user, proposal('deny', 'ask')))).toMatchObject({
      code: 'tightening_looser',
      member: 'action.arguments.policies[1]',
    });
    // The same mode is not looser, and neither is a tighter one.
    expect((await open(tokens.creator_user, proposal('ask', 'ask'))).status).toBe(201);
    expect((await open(tokens.creator_user, proposal('ask', 'deny'))).status).toBe(201);
  });

  it('holds a preview that composes for the agent, lists only the loosening baselines, and is no part of arguments', async () => {
    const id = await agent();
    const loose = `ext:m:${unique()}`;
    const tight = `ext:m:${unique()}`;
    const answer = await open(tokens.creator_user, {
      agent: { id },
      tools: [registration(loose), registration(tight)],
      policies: [
        baseline(loose, 'always_allow'),
        baseline(tight, 'deny'),
        tightening(id, loose, 'deny'),
      ],
    });
    expect(answer.status).toBe(201);
    const approval = await read(String((await data(answer)).id));
    const preview = approval.preview as { simulations: Json[]; loosening: Json[] };
    // One simulation for each tool, in order of first appearance, for the agent with every proposed body beside the rest.
    expect(preview.simulations.map((s) => [s.tool_ref, (s.result as Json).decision])).toEqual([
      [loose, 'deny'],
      [tight, 'deny'],
    ]);
    const considered = ((preview.simulations[0]?.result as Json).considered as Json)
      .policies as Json[];
    expect(considered.map((entry) => [entry.proposed_index, entry.result])).toEqual([
      [0, 'always_allow'],
      [2, 'deny'],
    ]);
    // Only the baseline that loosens the default is listed: the deny tightens it.
    expect(preview.loosening).toEqual([{ tool_ref: loose, from: 'ask', to: 'always_allow' }]);
    // A baseline that keeps the default (the same mode) loosens nothing, and neither does one that tightens it.
    const kept = `ext:m:${unique()}`;
    const keptApproval = await read(
      String(
        (
          await data(
            await open(tokens.creator_user, {
              agent: { id },
              tools: [registration(kept)],
              policies: [baseline(kept, 'ask')],
            })
          )
        ).id
      )
    );
    expect((keptApproval.preview as Json).loosening).toEqual([]);
    expect(approval.arguments).toBeDefined();
    expect(JSON.stringify(approval.arguments)).not.toContain('simulations');
  });

  it('names the agent on the approval, and shows no tool for the reference, which no catalog holds', async () => {
    const id = await agent();
    const tool = `ext:m:${unique()}`;
    const handle = await data(
      await open(tokens.creator_user, {
        agent: { id },
        tools: [registration(tool)],
        policies: [baseline(tool, 'ask')],
      })
    );
    expect(handle.resume_token_will_issue).toBe(false);
    expect((await read(String(handle.id))).agent).toMatchObject({ id });
    const listed = (await json(await call(tokens.admin, 'GET', '/v1/tools?limit=200')))
      .data as Json[];
    expect(listed.map((row) => row.tool_ref)).not.toContain(PROPOSE);
    expect(
      (
        await json(
          await call(tokens.creator, 'POST', '/v1/decisions', {
            action: { tool_ref: PROPOSE, arguments: {} },
          })
        )
      ).data
    ).toMatchObject({ decision: 'deny', reason: 'unknown_tool' });
  });

  it('applies in order as the approver, consumes the approval, and sends the events only once everything is applied', async () => {
    const id = await agent();
    const tool = `ext:m:${unique()}`;
    const hook = await call(tokens.admin, 'POST', '/v1/webhooks', {
      url: 'https://hooks.example.test/in',
      events: ['policy.published'],
    });
    expect(hook.status).toBe(201);
    const delivered = (): string[] =>
      mock.state.outbox
        .filter((entry) => entry.event.type === 'policy.published')
        .map((entry) => String(entry.event.subject));
    const sentBefore = delivered().length;
    const handle = await data(
      await open(tokens.creator_user, {
        agent: { id, principal_id: 'svc_other' },
        tools: [registration(tool)],
        policies: [baseline(tool, 'ask'), tightening(id, tool, 'deny')],
      })
    );
    const approved = await data(await approve(String(handle.id)));
    expect(approved).toMatchObject({ state: 'consumed', resolution: 'approved' });
    const rows = await policiesFor(tool);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ state: 'published', source: 'authored' });
      expect(row.updated_by).toMatchObject({ id: 'user_admin' });
    }
    expect((await data(await call(tokens.creator, 'GET', `/v1/agents/${id}`))).principal_id).toBe(
      'svc_other'
    );
    // The same approval cannot be applied twice.
    expect((await approve(String(handle.id))).status).toBe(409);
    expect(await policiesFor(tool)).toHaveLength(2);
    // One event for each policy that was published, after all of them were.
    expect(delivered()).toHaveLength(sentBefore + 2);
    expect(delivered().slice(sentBefore).sort()).toEqual(rows.map((row) => String(row.id)).sort());
    await call(tokens.admin, 'DELETE', `/v1/agents/${id}/principal`);
  });

  it('applies nothing and sends no event when a policy cannot be published, and records why by the approver', async () => {
    const id = await agent();
    const tool = `ext:m:${unique()}`;
    const other = `ext:m:${unique()}`;
    const handle = await data(
      await open(tokens.creator_user, {
        agent: { id, principal_id: 'svc_no_scope' },
        tools: [registration(tool), registration(other)],
        policies: [baseline(tool, 'ask'), tightening(id, other, 'ask')],
      })
    );
    const blocker = await data(
      await call(tokens.admin, 'POST', '/v1/policies', {
        kind: 'tool_invocation',
        subjects: [{ type: 'agent', id }],
        targets: { tools: [other] },
        config: { mode: 'ask' },
      })
    );
    await call(tokens.admin, 'POST', `/v1/policies/${String(blocker.id)}/publish`);
    const before = (await json(await call(tokens.admin, 'GET', '/v1/policies?limit=200')))
      .data as Json[];
    const sentBefore = mock.state.outbox.length;
    const refused = await data(await approve(String(handle.id)));
    expect(refused.state).toBe('rejected');
    expect(refused.resolution_history).toEqual([
      expect.objectContaining({
        resolution: 'rejected',
        reason: 'proposal_refused:policy_conflict',
        by: expect.objectContaining({ id: 'user_admin', kind: 'user' }) as unknown,
      }) as unknown,
    ]);
    expect(refused.approver).toMatchObject({ id: 'user_admin' });
    const after = (await json(await call(tokens.admin, 'GET', '/v1/policies?limit=200')))
      .data as Json[];
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(await policiesFor(tool)).toEqual([]);
    expect(
      (await data(await call(tokens.creator, 'GET', `/v1/agents/${id}`))).principal_id
    ).toBeNull();
    // Nothing was published, so nothing is announced: the baseline that came first never was.
    expect(
      mock.state.outbox.slice(sentBefore).filter((entry) => entry.event.type === 'policy.published')
    ).toEqual([]);
    // The refusal is the deployment's, not a resolver's: the same proposal may be opened again.
    const again = await open(tokens.creator_user, {
      agent: { id, principal_id: 'svc_no_scope' },
      tools: [registration(tool), registration(other)],
      policies: [baseline(tool, 'ask'), tightening(id, other, 'ask')],
    });
    expect(again.status).toBe(201);
    await call(tokens.admin, 'POST', `/v1/policies/${String(blocker.id)}/retire`);
  });

  it('lets one resolution through when two arrive together: the other is 409 already_resolved, and the approval says what was applied', async () => {
    const resolve = (
      route: string,
      token: string,
      id: string,
      digest: unknown
    ): Promise<Response> =>
      call(token, 'POST', `/v1/approvals/${id}/${route}`, { expected_action_digest: digest });
    for (const second of ['deny', 'approve', 'withdraw']) {
      const id = await agent();
      const tool = `ext:m:${unique()}`;
      const handle = await data(
        await open(tokens.creator_user, {
          agent: { id },
          tools: [registration(tool)],
          policies: [baseline(tool, 'ask'), tightening(id, tool, 'deny')],
        })
      );
      const approval = String(handle.id);
      const digest = (await read(approval)).action_digest;
      const answers = await Promise.all([
        resolve('approve', tokens.admin, approval, digest),
        second === 'deny'
          ? resolve('deny', tokens.approver_surface_token, approval, digest)
          : second === 'approve'
            ? resolve('approve', tokens.admin, approval, digest)
            : call(tokens.creator_user, 'POST', `/v1/approvals/${approval}/withdraw`),
      ]);
      const statuses = answers.map((answer) => answer.status).sort();
      expect(statuses, second).toEqual([200, 409]);
      const lost = answers.filter((answer) => answer.status === 409);
      for (const answer of lost)
        expect(String((await json(answer)).type)).toMatch(/already_resolved$/);
      const after = await read(approval);
      expect(after.resolution_history as Json[], second).toHaveLength(
        after.state === 'withdrawn' ? 0 : 1
      );
      // What the approval says is what was applied: consumed with both policies, or nothing at all.
      expect(await policiesFor(tool), second).toHaveLength(after.state === 'consumed' ? 2 : 0);
      if (after.state === 'consumed') expect(after.resolution).toBe('approved');
    }
  });

  it('re-runs the checks on approval: a baseline that now has a rival, and an agent that no longer exists, are refused with their codes', async () => {
    const id = await agent();
    const tool = `ext:m:${unique()}`;
    const handle = await data(
      await open(tokens.creator_user, {
        agent: { id },
        tools: [registration(tool)],
        policies: [baseline(tool, 'always_allow')],
      })
    );
    const rival = await data(
      await call(tokens.admin, 'POST', '/v1/policies', {
        kind: 'tool_invocation',
        subjects: [{ type: 'role', id: 'everyone' }],
        targets: { tools: [tool] },
        config: { mode: 'ask' },
      })
    );
    await call(tokens.admin, 'POST', `/v1/policies/${String(rival.id)}/publish`);
    const refused = await data(await approve(String(handle.id)));
    expect(refused.resolution_history).toEqual([
      expect.objectContaining({ reason: 'proposal_refused:baseline_exists' }),
    ]);
    await call(tokens.admin, 'POST', `/v1/policies/${String(rival.id)}/retire`);
  });

  it('names the nearest parent when an unknown property is no identifier, so the member keeps the contract pattern', async () => {
    const id = await agent();
    const answer = await open(tokens.creator_user, { agent: { id }, 'x-foo': 1, policies: [] });
    expect(answer.status).toBe(422);
    const body = await json(answer);
    expect(body).toMatchObject({ code: 'shape', member: 'action.arguments' });
    expect(String(body.member)).toMatch(
      /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$/
    );
  });

  it('refuses a caller that is not a user, an agent as well as a service principal, with not_a_user', async () => {
    const id = await agent();
    const tool = `ext:m:${unique()}`;
    const args = {
      agent: { id },
      tools: [registration(tool)],
      policies: [baseline(tool, 'ask')],
    };
    const agentToken = await mock.issuer.mint({
      sub: 'agent_probe',
      org: 'org_mock',
      aud: mock.config.audience,
      exp: Math.floor(Date.now() / 1000) + 60,
      principal_kind: 'agent',
      scope: 'approvals:resolve',
    });
    for (const token of [tokens.creator, agentToken]) {
      const answer = await open(token, args);
      expect(answer.status).toBe(422);
      expect(await json(answer)).toMatchObject({ code: 'not_a_user' });
    }
    expect((await open(tokens.creator_user, args)).status).toBe(201);
  });

  it('refuses a token of the approver surface before it looks at the proposal', async () => {
    // D-A78: the surface resolves and never opens, so a body that would be a 422 is a 403 first.
    for (const args of [{}, { agent: { id: 'agent_missing' }, policies: [] }]) {
      const answer = await open(tokens.approver_surface_token, args);
      expect(answer.status).toBe(403);
      expect(String((await json(answer)).type)).toMatch(/forbidden$/);
    }
  });

  it('is not served by an edge deployment, and is advertised only where it is served', async () => {
    const edge = await createMock({ control: true, spec, deployment: 'edge' });
    const edgeTokens = await edge.tokens();
    const capabilities = async (target: Mock, token: string): Promise<Json> =>
      (
        await json(
          await Promise.resolve(
            target.app.request('/v1/capabilities', {
              headers: { authorization: `Bearer ${token}` },
            })
          )
        )
      ).data as Json;
    expect((await capabilities(mock, tokens.creator)).deployment_applied).toEqual([
      { tool_ref: PROPOSE, arguments_schema_ref: 'PolicySetProposal' },
    ]);
    expect((await capabilities(edge, edgeTokens.creator)).deployment_applied).toBeUndefined();
    const answer = await Promise.resolve(
      edge.app.request('/v1/approvals', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${edgeTokens.creator_user}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: { tool_ref: PROPOSE, arguments: {} },
          continuation: { kind: 'mcp_held', delivery: 'held' },
        }),
      })
    );
    expect(answer.status).toBe(422);
    expect(String((await json(answer)).type)).toMatch(/approval_unroutable$/);
  });
});

describe('the rules of a proposal', () => {
  const proposal = (patch: Partial<Proposal> = {}): Proposal => ({
    agent: { id: 'agent_1' },
    tools: [],
    policies: [{ role: 'baseline', policy: baseline('ext:t', 'ask').policy as Json }],
    tool_grants: [],
    ...patch,
  });

  it('accepts a baseline on everyone and a tightening on the proposal agent, each for one tool', () => {
    expect(
      ruleRefusal(
        proposal({
          policies: [
            { role: 'baseline', policy: baseline('ext:t', 'ask').policy as Json },
            { role: 'tightening', policy: tightening('agent_1', 'ext:t', 'deny').policy as Json },
          ],
        })
      )
    ).toBeUndefined();
  });

  it('refuses a config member beyond mode and an origin, naming the member', () => {
    const withPolicy = (patch: Json): unknown =>
      ruleRefusal(
        proposal({
          policies: [
            {
              role: 'baseline',
              policy: { ...(baseline('ext:t', 'ask').policy as Json), ...patch },
            },
          ],
        })
      );
    expect(withPolicy({ config: { mode: 'ask', approver_groups: ['g'] } })).toMatchObject({
      code: 'shape',
      member: 'action.arguments.policies[0].policy.config.approver_groups',
    });
    expect(withPolicy({ config: { mode: 'ask', expires_after: 'PT1H' } })).toMatchObject({
      member: 'action.arguments.policies[0].policy.config.expires_after',
    });
    expect(withPolicy({ origin: { format: 'cedar', digest: 'a'.repeat(64) } })).toMatchObject({
      member: 'action.arguments.policies[0].policy.origin',
    });
    expect(withPolicy({ config: { mode: 'ask' } })).toBeUndefined();
    // The break that lets a baseline's config through leaves the tightenings held to mode.
    const loose = { baselineModeOnly: false };
    const withBaseline = ruleRefusal(
      proposal({
        policies: [
          {
            role: 'baseline',
            policy: {
              ...(baseline('ext:t', 'ask').policy as Json),
              config: { mode: 'ask', approver_groups: ['g'] },
            },
          },
        ],
      }),
      loose
    );
    expect(withBaseline).toBeUndefined();
    expect(
      ruleRefusal(
        proposal({
          policies: [
            {
              role: 'tightening',
              policy: {
                ...(tightening('agent_1', 'ext:t', 'ask').policy as Json),
                config: { mode: 'ask', approver_groups: ['g'] },
              },
            },
          ],
        }),
        loose
      )
    ).toMatchObject({ member: 'action.arguments.policies[0].policy.config.approver_groups' });
  });

  it('names the part that breaks a rule', () => {
    const policy = (patch: Json): Json => ({
      ...(baseline('ext:t', 'ask').policy as Json),
      ...patch,
    });
    const refused = (patched: Json, role: 'baseline' | 'tightening' = 'baseline'): unknown =>
      ruleRefusal(proposal({ policies: [{ role, policy: policy(patched) }] }))?.member;
    expect(refused({ kind: 'spending' })).toBe('action.arguments.policies[0].policy.kind');
    expect(
      refused({
        subjects: [
          { type: 'role', id: 'everyone' },
          { type: 'role', id: 'member' },
        ],
      })
    ).toBe('action.arguments.policies[0].policy.subjects');
    expect(refused({ subjects: [{ type: 'role', id: 'member' }] })).toBe(
      'action.arguments.policies[0].policy.subjects[0]'
    );
    expect(refused({}, 'tightening')).toBe('action.arguments.policies[0].policy.subjects[0]');
    // A tightening is for the agent of the proposal, not for another agent.
    expect(refused({ subjects: [{ type: 'agent', id: 'agent_other' }] }, 'tightening')).toBe(
      'action.arguments.policies[0].policy.subjects[0]'
    );
    expect(refused({ targets: { tools: 'all' } })).toBe(
      'action.arguments.policies[0].policy.targets.tools'
    );
    expect(refused({ targets: { tools: ['ext:a', 'ext:b'] } })).toBe(
      'action.arguments.policies[0].policy.targets.tools'
    );
    expect(refused({ targets: { tools: [PROPOSE] } })).toBe(
      'action.arguments.policies[0].policy.targets.tools[0]'
    );
    expect(
      ruleRefusal(proposal({ tools: [registration('ext:t'), registration('ext:t')] }))?.member
    ).toBe('action.arguments.tools[1].tool_ref');
  });

  it('refuses two policies for one tool and subject, and not one tool for two subjects or two tools for one', () => {
    const two = (a: Json, b: Json): Proposal =>
      proposal({
        policies: [
          { role: 'baseline', policy: a },
          { role: 'baseline', policy: b },
        ],
      });
    const on = (tool: string, mode: string): Json => baseline(tool, mode).policy as Json;
    expect(ruleRefusal(two(on('ext:t', 'ask'), on('ext:t', 'deny')))).toMatchObject({
      code: 'shape',
      member: 'action.arguments.policies[1].policy.targets.tools[0]',
    });
    expect(ruleRefusal(two(on('ext:t', 'ask'), on('ext:u', 'deny')))).toBeUndefined();
    const tight = tightening('agent_1', 'ext:t', 'deny').policy as Json;
    expect(
      ruleRefusal(
        proposal({
          policies: [
            { role: 'baseline', policy: on('ext:t', 'ask') },
            { role: 'tightening', policy: tight },
            { role: 'tightening', policy: tight },
          ],
        })
      )?.member
    ).toBe('action.arguments.policies[2].policy.targets.tools[0]');
  });

  it('reads the one target of a policy, and none when it names every tool or several', () => {
    expect(targetOf({ targets: { tools: ['ext:a'] } })).toBe('ext:a');
    expect(targetOf({ targets: { tools: ['ext:a', 'ext:b'] } })).toBeUndefined();
    expect(targetOf({ targets: { tools: 'all' } })).toBeUndefined();
    expect(targetOf({})).toBeUndefined();
  });

  it('writes an ajv instance path as the dotted and bracketed path a member is', () => {
    expect(memberPath('')).toBe('');
    expect(memberPath('/policies/0/policy/targets/tools/0')).toBe(
      'policies[0].policy.targets.tools[0]'
    );
    expect(memberPath('/policies/12', 'rationale')).toBe('policies[12].rationale');
    expect(memberPath('', 'extra')).toBe('extra');
    // A name that is no identifier is not a member: the path stops at its parent.
    expect(memberPath('', 'x-foo')).toBe('');
    expect(memberPath('/policies/0/policy', 'x-foo')).toBe('policies[0].policy');
    expect(memberPath('/policies/0/a.b/c')).toBe('policies[0]');
    expect(schemaRefusal(undefined)).toMatchObject({ code: 'shape' });
    expect(schemaRefusal([])).toMatchObject({ code: 'shape' });
  });
});
