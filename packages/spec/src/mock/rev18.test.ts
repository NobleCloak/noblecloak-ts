/**
 * The mock's rev 18 behaviour: `role` rows and the entitlement they need (read from the opener's token, and again at
 * approval from the approving token's claim or else the set recorded at open), proposals without an agent, tool
 * grants (refused, previewed, recorded in the mock's state and rolled back with the rest), the `ineffective` preview,
 * and the `proposals` advertisement with the refusals of a deployment that does not serve a row kind or a member.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { createMock } from './app.js';
import type { Mock } from './app.js';
import { MockIssuer } from './auth.js';
import { namesEveryone, ruleRefusal } from './proposal.js';
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
const entry = (role: string, subject: Json, tool: string, mode: string, config?: Json): Json => ({
  role,
  rationale: 'Because.',
  assessment,
  policy: {
    kind: 'tool_invocation',
    subjects: [subject],
    targets: { tools: [tool] },
    config: config ?? { mode },
  },
});
const baseline = (tool: string, mode: string): Json =>
  entry('baseline', { type: 'role', id: 'everyone' }, tool, mode);
const roleRow = (key: string, tool: string, mode: string): Json =>
  entry('role', { type: 'role', id: key }, tool, mode);
const tightening = (agent: string, tool: string, mode: string): Json =>
  entry('tightening', { type: 'agent', id: agent }, tool, mode);
const registration = (ref: string): Json => ({
  tool_ref: ref,
  transport: 'external',
  input_schema: { type: 'object' },
  side_effect_level: 'external',
  owner_kind: 'org',
});

describe('the mock, rev 18', () => {
  let mock: Mock;
  let tokens: Awaited<ReturnType<Mock['tokens']>>;
  let n = 0;
  beforeAll(async () => {
    mock = await createMock({ control: true, spec });
    tokens = await mock.tokens();
  });

  const call = (
    token: string,
    method: string,
    path: string,
    body?: unknown,
    target: Mock = mock
  ): Promise<Response> =>
    Promise.resolve(
      target.app.request(path, {
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
  const unique = (): string => `r${String((n += 1))}`;
  const agent = async (): Promise<string> =>
    String((await data(await call(tokens.creator, 'POST', '/v1/agents', { name: unique() }))).id);
  const open = (token: string, args: Json, target: Mock = mock): Promise<Response> =>
    call(
      token,
      'POST',
      '/v1/approvals',
      {
        action: { tool_ref: PROPOSE, arguments: args },
        continuation: { kind: 'mcp_held', delivery: 'held' },
      },
      target
    );
  const read = async (id: string, token = tokens.admin): Promise<Json> =>
    data(await call(token, 'GET', `/v1/approvals/${id}`));
  const approve = async (id: string, token = tokens.admin): Promise<Json> =>
    data(
      await call(token, 'POST', `/v1/approvals/${id}/approve`, {
        expected_action_digest: (await read(id)).action_digest,
      })
    );
  const policiesFor = async (tool: string): Promise<Json[]> =>
    (await json(await call(tokens.admin, 'GET', `/v1/policies?tool=${tool}&limit=200`)))
      .data as Json[];
  const refusal = async (token: string, args: Json): Promise<Json> => {
    const answer = await open(token, args);
    expect(answer.status).toBe(422);
    const body = await json(answer);
    expect(String(body.type)).toMatch(/proposal_refused$/);
    return body;
  };
  const register = async (ref: string): Promise<void> => {
    expect((await call(tokens.admin, 'POST', '/v1/tools', registration(ref))).status).toBe(201);
  };
  /** An administrator's token whose `entitlements` claim is `entitlements`, which the approval reads as current. */
  const adminWith = (entitlements: string[]): Promise<string> =>
    mock.issuer.mint({
      sub: 'user_admin',
      org: 'org_mock',
      aud: mock.config.audience,
      exp: Math.floor(Date.now() / 1000) + 60,
      principal_kind: 'user',
      scope: 'approvals:resolve role:policy_admin',
      entitlements,
    });

  it('applies a set without an agent of a baseline and a role row, opened by an entitled person, as the approver', async () => {
    const tool = `ext:r:${unique()}`;
    const handle = await data(
      await open(tokens.entitled, {
        tools: [registration(tool)],
        policies: [baseline(tool, 'ask'), roleRow('member', tool, 'deny')],
      })
    );
    const pending = await read(String(handle.id));
    expect(pending.agent).toBeUndefined();
    const preview = pending.preview as Json;
    // Without an agent the simulation is as the baseline every caller holds: the role row does not reach it.
    expect(
      (preview.simulations as Json[]).map((s) => [s.tool_ref, (s.result as Json).decision])
    ).toEqual([[tool, 'step_up']]);
    expect(preview.ineffective).toEqual([]);
    expect(preview).not.toHaveProperty('grants');
    // The administrator's token carries no entitlements claim, so the set recorded at open stands.
    expect(await approve(String(handle.id))).toMatchObject({
      state: 'consumed',
      resolution: 'approved',
    });
    const rows = await policiesFor(tool);
    expect(
      rows
        .map((row) => (row.subjects as Json[])[0] ?? {})
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    ).toEqual([
      { type: 'role', id: 'everyone' },
      { type: 'role', id: 'member' },
    ]);
    for (const row of rows) expect(row).toMatchObject({ state: 'published', source: 'authored' });
  });

  it('simulates a set without an agent as everyone, not as the person who opened it', async () => {
    const tool = `ext:r:${unique()}`;
    await register(tool);
    const own = await data(
      await call(tokens.admin, 'POST', '/v1/policies', {
        kind: 'tool_invocation',
        subjects: [{ type: 'user', id: 'user_entitled' }],
        targets: { tools: [tool] },
        config: { mode: 'deny' },
      })
    );
    await call(tokens.admin, 'POST', `/v1/policies/${String(own.id)}/publish`);
    const handle = await data(await open(tokens.entitled, { policies: [baseline(tool, 'ask')] }));
    // The opener's own deny does not reach the baseline every caller holds.
    const result = (((await read(String(handle.id))).preview as Json).simulations as Json[])[0]
      ?.result as Json;
    expect(result.decision).toBe('step_up');
    await call(tokens.admin, 'POST', `/v1/policies/${String(own.id)}/retire`);
  });

  it('refuses the same set opened by a person whose token holds no policies.role_subjects, naming the first role row and the key', async () => {
    const tool = `ext:r:${unique()}`;
    const args = {
      tools: [registration(tool)],
      policies: [
        baseline(tool, 'ask'),
        roleRow('member', tool, 'deny'),
        roleRow('auditor', tool, 'deny'),
      ],
    };
    const body = await refusal(tokens.creator_user, args);
    expect(body).toMatchObject({ code: 'not_entitled', member: 'action.arguments.policies[1]' });
    expect(String(body.detail)).toContain('policies.role_subjects');
    // A set without a role row needs no entitlement.
    expect(
      (await open(tokens.creator_user, { ...args, policies: [baseline(tool, 'ask')] })).status
    ).toBe(201);
  });

  it('refuses at approval when the approving token says the organisation no longer holds the entitlement, and applies nothing', async () => {
    const tool = `ext:r:${unique()}`;
    const handle = await data(
      await open(tokens.entitled, {
        tools: [registration(tool)],
        policies: [baseline(tool, 'ask'), roleRow('member', tool, 'deny')],
      })
    );
    const refused = await approve(String(handle.id), await adminWith(['records.verify']));
    expect(refused.state).toBe('rejected');
    expect(refused.resolution_history).toEqual([
      expect.objectContaining({
        resolution: 'rejected',
        reason: 'proposal_refused:not_entitled',
      }) as unknown,
    ]);
    expect(await policiesFor(tool)).toEqual([]);
    const listed = (await json(await call(tokens.admin, 'GET', '/v1/tools?limit=200')))
      .data as Json[];
    expect(listed.map((row) => row.tool_ref)).not.toContain(tool);
  });

  it('applies at approval when the approving token still carries the entitlement', async () => {
    const tool = `ext:r:${unique()}`;
    const handle = await data(
      await open(tokens.entitled, {
        tools: [registration(tool)],
        policies: [roleRow('member', tool, 'deny')],
      })
    );
    expect(
      await approve(String(handle.id), await adminWith(['policies.role_subjects']))
    ).toMatchObject({ state: 'consumed' });
    expect(await policiesFor(tool)).toHaveLength(1);
  });

  it('refuses a tightening and tool grants on a proposal without an agent, and tool grants without a principal, with shape', async () => {
    const tool = `ext:r:${unique()}`;
    await register(tool);
    expect(
      await refusal(tokens.creator_user, { policies: [tightening('agent_x', tool, 'deny')] })
    ).toMatchObject({ code: 'shape', member: 'action.arguments.policies[0].role' });
    expect(
      await refusal(tokens.creator_user, {
        policies: [baseline(`ext:r:${unique()}`, 'ask')],
        tool_grants: [tool],
      })
    ).toMatchObject({ code: 'shape', member: 'action.arguments.tool_grants' });
    const id = await agent();
    expect(
      await refusal(tokens.creator_user, {
        agent: { id },
        policies: [tightening(id, tool, 'deny')],
        tool_grants: [tool],
      })
    ).toMatchObject({ code: 'shape', member: 'action.arguments.tool_grants' });
  });

  it('refuses a grant of a tool the organisation does not hold, a withdrawn one, one of the proposal and a deployment-applied reference', async () => {
    const id = await agent();
    const held = `ext:r:${unique()}`;
    const own = `ext:r:${unique()}`;
    await register(held);
    const withdrawn = `ext:r:${unique()}`;
    await register(withdrawn);
    const row = [...mock.state.tools.values()].find((t) => t.tool_ref === withdrawn);
    if (row === undefined) throw new Error('the registered tool is not in the state');
    row.status = 'withdrawn';
    const args = (grants: string[]): Json => ({
      agent: { id, principal_id: 'svc_other' },
      tools: [registration(own)],
      policies: [tightening(id, held, 'deny')],
      tool_grants: grants,
    });
    expect(await refusal(tokens.creator_user, args([held, 'ext:r:nowhere']))).toMatchObject({
      code: 'target_unknown',
      member: 'action.arguments.tool_grants[1]',
    });
    expect(await refusal(tokens.creator_user, args([withdrawn]))).toMatchObject({
      code: 'target_unknown',
      member: 'action.arguments.tool_grants[0]',
    });
    expect(await refusal(tokens.creator_user, args([held, own]))).toMatchObject({
      code: 'shape',
      member: 'action.arguments.tool_grants[1]',
    });
    expect(await refusal(tokens.creator_user, args([PROPOSE]))).toMatchObject({
      code: 'shape',
      member: 'action.arguments.tool_grants[0]',
    });
  });

  it('previews the grants, records them for the bound principal on approval beside the ones it holds, and keeps an existing one as it is', async () => {
    const id = await agent();
    const first = `ext:r:${unique()}`;
    const second = `ext:r:${unique()}`;
    await register(first);
    await register(second);
    const propose = async (grants: string[], mode: string): Promise<string> => {
      const handle = await data(
        await open(tokens.creator_user, {
          agent: { id, principal_id: 'svc_no_scope' },
          policies: [tightening(id, first, mode)],
          tool_grants: grants,
        })
      );
      return String(handle.id);
    };
    const approval = await propose([first], 'deny');
    expect((await read(approval)).preview).toMatchObject({ grants: [{ tool_ref: first }] });
    expect(await approve(approval)).toMatchObject({ state: 'consumed' });
    expect([...(mock.state.toolGrants.get('org_mock|svc_no_scope') ?? [])]).toEqual([first]);
    // The binding and the tightening went with them; the visibility of the tools is unchanged.
    expect((await data(await call(tokens.creator, 'GET', `/v1/agents/${id}`))).principal_id).toBe(
      'svc_no_scope'
    );
    for (const row of await policiesFor(first))
      await call(tokens.admin, 'POST', `/v1/policies/${String(row.id)}/retire`);
    const again = await propose([second], 'ask');
    expect(await approve(again)).toMatchObject({ state: 'consumed' });
    expect([...(mock.state.toolGrants.get('org_mock|svc_no_scope') ?? [])]).toEqual([
      first,
      second,
    ]);
    for (const row of await policiesFor(first))
      await call(tokens.admin, 'POST', `/v1/policies/${String(row.id)}/retire`);
    await call(tokens.admin, 'DELETE', `/v1/agents/${id}/principal`);
    mock.state.toolGrants.delete('org_mock|svc_no_scope');
  });

  it('rolls the grants back with the rest when a policy cannot be published', async () => {
    const id = await agent();
    const tool = `ext:r:${unique()}`;
    await register(tool);
    const handle = await data(
      await open(tokens.creator_user, {
        agent: { id, principal_id: 'svc_other' },
        policies: [tightening(id, tool, 'ask')],
        tool_grants: [tool],
      })
    );
    const blocker = await data(
      await call(tokens.admin, 'POST', '/v1/policies', {
        kind: 'tool_invocation',
        subjects: [{ type: 'agent', id }],
        targets: { tools: [tool] },
        config: { mode: 'ask' },
      })
    );
    await call(tokens.admin, 'POST', `/v1/policies/${String(blocker.id)}/publish`);
    mock.state.toolGrants.set('org_mock|svc_other', new Set(['ext:r:before']));
    const refused = await approve(String(handle.id));
    expect(refused.resolution_history).toEqual([
      expect.objectContaining({ reason: 'proposal_refused:policy_conflict' }) as unknown,
    ]);
    expect([...(mock.state.toolGrants.get('org_mock|svc_other') ?? [])]).toEqual(['ext:r:before']);
    mock.state.toolGrants.delete('org_mock|svc_other');
    await call(tokens.admin, 'POST', `/v1/policies/${String(blocker.id)}/retire`);
  });

  it('lists in ineffective a role row a tighter policy of everyone shadows, from this set or published, and not one at least as tight', async () => {
    const tool = `ext:r:${unique()}`;
    const handle = await data(
      await open(tokens.entitled, {
        tools: [registration(tool)],
        policies: [
          baseline(tool, 'deny'),
          roleRow('member', tool, 'always_allow'),
          roleRow('auditor', tool, 'deny'),
        ],
      })
    );
    expect(((await read(String(handle.id))).preview as Json).ineffective).toEqual([
      { tool_ref: tool, subject: { type: 'role', id: 'member' } },
    ]);
    const published = `ext:r:${unique()}`;
    await register(published);
    const everyone = await data(
      await call(tokens.admin, 'POST', '/v1/policies', {
        kind: 'tool_invocation',
        subjects: [{ type: 'role', id: 'everyone' }],
        targets: { tools: [published] },
        config: { mode: 'ask' },
      })
    );
    await call(tokens.admin, 'POST', `/v1/policies/${String(everyone.id)}/publish`);
    const shadowed = await data(
      await open(tokens.entitled, {
        policies: [
          roleRow('member', published, 'always_allow'),
          roleRow('auditor', published, 'ask'),
        ],
      })
    );
    expect(((await read(String(shadowed.id))).preview as Json).ineffective).toEqual([
      { tool_ref: published, subject: { type: 'role', id: 'member' } },
    ]);
    await call(tokens.admin, 'POST', `/v1/policies/${String(everyone.id)}/retire`);
  });

  it('refuses a role row on everyone in any form, and holds a role row to mode as a baseline is', async () => {
    const tool = `ext:r:${unique()}`;
    await register(tool);
    for (const key of ['everyone', 'Everyone', 'role:everyone', 'org/everyone'])
      expect(
        await refusal(tokens.entitled, { policies: [roleRow(key, tool, 'ask')] }),
        key
      ).toMatchObject({ code: 'shape', member: 'action.arguments.policies[0].policy.subjects[0]' });
    expect(
      await refusal(tokens.entitled, {
        policies: [entry('role', { type: 'agent', id: 'agent_x' }, tool, 'ask')],
      })
    ).toMatchObject({ member: 'action.arguments.policies[0].policy.subjects[0]' });
    expect(
      await refusal(tokens.entitled, {
        policies: [
          entry('role', { type: 'role', id: 'member' }, tool, 'ask', {
            mode: 'ask',
            approver_groups: ['g'],
          }),
        ],
      })
    ).toMatchObject({ member: 'action.arguments.policies[0].policy.config.approver_groups' });
  });

  it('advertises proposals where it applies them, and refuses a row kind or a member it is started without', async () => {
    const capabilities = async (target: Mock): Promise<Json> => {
      const own = await target.tokens();
      return data(await call(own.creator, 'GET', '/v1/capabilities', undefined, target));
    };
    expect((await capabilities(mock)).proposals).toEqual({
      row_kinds: ['baseline', 'tightening', 'role'],
      members: ['tool_grants'],
    });
    const edge = await createMock({ control: true, spec, deployment: 'edge' });
    expect(await capabilities(edge)).not.toHaveProperty('proposals');
    const prior = await createMock({
      control: true,
      spec,
      proposals: { row_kinds: ['baseline', 'tightening'], members: [] },
    });
    expect((await capabilities(prior)).proposals).toEqual({
      row_kinds: ['baseline', 'tightening'],
      members: [],
    });
    const priorTokens = await prior.tokens();
    const tool = `ext:r:${unique()}`;
    const role = await open(
      priorTokens.entitled,
      {
        tools: [registration(tool)],
        policies: [baseline(tool, 'ask'), roleRow('member', tool, 'deny')],
      },
      prior
    );
    expect(role.status).toBe(422);
    expect(await json(role)).toMatchObject({
      code: 'shape',
      member: 'action.arguments.policies[1].role',
    });
    const grants = await open(
      priorTokens.creator_user,
      {
        agent: { id: 'agent_x', principal_id: 'svc_other' },
        tools: [registration(tool)],
        policies: [baseline(tool, 'ask')],
        tool_grants: ['ext:r:any'],
      },
      prior
    );
    expect(await json(grants)).toMatchObject({
      code: 'shape',
      member: 'action.arguments.tool_grants',
    });
  });

  it('gives the entitled token policies.role_subjects, and lists it in the capabilities that token reads', async () => {
    const read = await data(await call(tokens.entitled, 'GET', '/v1/capabilities'));
    expect(read.entitlements).toContain('policies.role_subjects');
    expect(
      (await data(await call(tokens.creator_user, 'GET', '/v1/capabilities'))).entitlements
    ).toEqual([]);
  });
});

describe('the entitlements claim', () => {
  it('says whether the token carried the claim at all, an empty one included', async () => {
    const issuer = await MockIssuer.create();
    const claims = {
      sub: 'u',
      org: 'o',
      aud: 'https://api.test',
      exp: Math.floor(Date.now() / 1000) + 60,
      principal_kind: 'user' as const,
    };
    const verified = async (extra: Json): Promise<unknown> =>
      issuer.verify(await issuer.mint({ ...claims, ...extra }), 'https://api.test', new Date());
    expect(await verified({})).toMatchObject({ entitlements: [], entitlementsClaimed: false });
    expect(await verified({ entitlements: [] })).toMatchObject({
      entitlements: [],
      entitlementsClaimed: true,
    });
  });
});

describe('the rules of a proposal, rev 18', () => {
  const proposal = (patch: Partial<Proposal> = {}): Proposal => ({
    tools: [],
    policies: [{ role: 'role', policy: roleRow('member', 'ext:t', 'ask').policy as Json }],
    tool_grants: [],
    ...patch,
  });

  it('accepts a role row on a bare key without an agent', () => {
    expect(ruleRefusal(proposal())).toBeUndefined();
  });

  it('refuses a row kind or a member the deployment does not serve before anything else', () => {
    const served = { row_kinds: ['baseline', 'tightening'], members: [] };
    expect(ruleRefusal(proposal(), { served })).toMatchObject({
      code: 'shape',
      member: 'action.arguments.policies[0].role',
    });
    expect(
      ruleRefusal(
        proposal({
          agent: { id: 'a', principal_id: 'sp' },
          policies: [{ role: 'baseline', policy: baseline('ext:t', 'ask').policy as Json }],
          tool_grants: ['ext:u'],
        }),
        { served }
      )
    ).toMatchObject({ member: 'action.arguments.tool_grants' });
  });

  it('holds a role row to mode even under the break that lets a baseline config through', () => {
    const wide = proposal({
      policies: [
        {
          role: 'role',
          policy: entry('role', { type: 'role', id: 'member' }, 'ext:t', 'ask', {
            mode: 'ask',
            approver_groups: ['g'],
          }).policy as Json,
        },
      ],
    });
    expect(ruleRefusal(wide, { baselineModeOnly: false })).toMatchObject({
      member: 'action.arguments.policies[0].policy.config.approver_groups',
    });
    expect(ruleRefusal(wide, { modeOnly: false })).toBeUndefined();
  });

  it('lets grants through without a principal only under the break, and never without an agent', () => {
    const withAgent = proposal({ agent: { id: 'a' }, tool_grants: ['ext:u'] });
    expect(ruleRefusal(withAgent)).toMatchObject({ member: 'action.arguments.tool_grants' });
    expect(ruleRefusal(withAgent, { grantsNeedPrincipal: false })).toBeUndefined();
    expect(
      ruleRefusal(proposal({ tool_grants: ['ext:u'] }), { grantsNeedPrincipal: false })
    ).toMatchObject({ member: 'action.arguments.tool_grants' });
  });

  it('knows everyone by its bare key in any case and by a form that ends in it', () => {
    for (const key of ['everyone', 'EVERYONE', 'role:everyone', 'a/b/everyone'])
      expect(namesEveryone(key), key).toBe(true);
    for (const key of ['member', 'everyones', 'everyone:member', 'not_everyone'])
      expect(namesEveryone(key), key).toBe(false);
  });
});
