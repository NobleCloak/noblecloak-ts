/**
 * The mock's rev 13 behaviour that the conformance scenarios do not read: a binding that is replaced, an
 * unbound caller of an agent's policy, a simulation that stores nothing, and the `member` beside the `detail`
 * prefix of an `unsupported_policy_form`.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { createMock } from './app.js';
import type { Mock } from './app.js';

const spec = loadCommittedDocument();
type Json = Record<string, unknown>;

describe('the mock, rev 13', () => {
  let mock: Mock;
  let tokens: Awaited<ReturnType<Mock['tokens']>>;
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
  const agent = async (name: string): Promise<string> =>
    String(
      ((await json(await call(tokens.creator, 'POST', '/v1/agents', { name }))).data as Json).id
    );
  const bind = (id: string, principal: string): Promise<Response> =>
    call(tokens.admin, 'PUT', `/v1/agents/${id}/principal`, { principal_id: principal });
  const principalOf = async (id: string): Promise<unknown> =>
    ((await json(await call(tokens.creator, 'GET', `/v1/agents/${id}`))).data as Json).principal_id;

  it('rebinding an agent replaces its binding, frees the old principal, and binding the same one again is a no-op', async () => {
    const first = await agent('replaced');
    const second = await agent('takes the freed principal');
    expect((await bind(first, 'svc_adapter')).status).toBe(200);
    expect((await bind(first, 'svc_adapter')).status).toBe(200);
    expect((await bind(first, 'svc_other')).status).toBe(200);
    expect(await principalOf(first)).toBe('svc_other');
    expect((await bind(second, 'svc_adapter')).status).toBe(200);
    const taken = await bind(second, 'svc_other');
    expect(taken.status).toBe(409);
    expect(await json(taken)).toMatchObject({ agent_id: first });
    for (const id of [first, second])
      expect((await call(tokens.admin, 'DELETE', `/v1/agents/${id}/principal`)).status).toBe(204);
    expect(await principalOf(first)).toBeNull();
  });

  it('refuses a user, an unknown id and a foreign organisation, and checks the administrator first', async () => {
    const id = await agent('refusals');
    // The member has called, so the mock knows it as a user principal of the organisation.
    expect((await call(tokens.member, 'GET', `/v1/agents/${id}`)).status).toBe(200);
    expect((await bind(id, 'user_member')).status).toBe(404);
    expect((await bind(id, 'nobody')).status).toBe(404);
    expect((await bind('agent_missing', 'svc_adapter')).status).toBe(404);
    const foreign = await call(tokens.other_org, 'PUT', `/v1/agents/${id}/principal`, {
      principal_id: 'svc_adapter',
    });
    expect(foreign.status).toBe(403);
    expect((await call(tokens.admin, 'PUT', `/v1/agents/${id}/principal`, {})).status).toBe(400);
    expect((await call(tokens.admin, 'DELETE', '/v1/agents/agent_missing/principal')).status).toBe(
      404
    );
  });

  it('a simulation of a set stores nothing, and names the member of a body it refuses beside the detail prefix', async () => {
    const policies = async (): Promise<number> =>
      ((await json(await call(tokens.admin, 'GET', '/v1/policies?limit=200'))).data as unknown[])
        .length;
    const before = await policies();
    const answer = await call(tokens.creator, 'POST', '/v1/policies/simulate', {
      policies: [
        {
          kind: 'tool_invocation',
          subjects: [{ type: 'role', id: 'everyone' }],
          config: { mode: 'always_allow' },
        },
      ],
      action: { tool_ref: 'mcp:tracker:add_comment', arguments: {} },
    });
    expect(answer.status).toBe(200);
    expect(await policies()).toBe(before);
    const refused = await call(tokens.creator, 'POST', '/v1/policies/simulate', {
      policies: [
        {
          kind: 'tool_invocation',
          subjects: [{ type: 'organization' }],
          config: { mode: 'always_allow' },
        },
        {
          kind: 'duplicate_requests',
          subjects: [{ type: 'role', id: 'everyone' }],
          config: { after_rejection: 'deny' },
        },
      ],
      action: { tool_ref: 'mcp:tracker:add_comment', arguments: {} },
    });
    expect(refused.status).toBe(422);
    const body = await json(refused);
    expect(body.member).toBe('policies[1].subjects[0].type');
    expect(String(body.detail)).toMatch(/^policies\[1\]\.subjects: /);
  });

  it('a user who is bound to no agent never holds an agent policy, and holds everyone', async () => {
    const id = await agent('held by nobody');
    const tool = await call(tokens.admin, 'POST', '/v1/tools', {
      tool_ref: 'ext:rev13:held',
      transport: 'external',
      input_schema: { type: 'object' },
      side_effect_level: 'write',
      owner_kind: 'org',
    });
    expect(tool.status).toBe(201);
    const made = async (subject: Json): Promise<string> => {
      const row = await json(
        await call(tokens.admin, 'POST', '/v1/policies', {
          kind: 'tool_invocation',
          subjects: [subject],
          targets: { tools: ['ext:rev13:held'] },
          config: { mode: 'deny' },
        })
      );
      const policy = String((row.data as Json).id);
      expect((await call(tokens.admin, 'POST', `/v1/policies/${policy}/publish`)).status).toBe(200);
      return policy;
    };
    const forAgent = await made({ type: 'agent', id });
    const forEveryone = await made({ type: 'role', id: 'everyone' });
    const considered = async (): Promise<Json[]> =>
      (
        (
          (
            await json(
              await call(tokens.member, 'POST', `/v1/policies/${forAgent}/simulate`, {
                actor: { agent_id: id },
                action: { tool_ref: 'ext:rev13:held', arguments: {} },
              })
            )
          ).data as Json
        ).considered as { policies: Json[] }
      ).policies;
    const entries = await considered();
    expect(entries.map((e) => e.id)).not.toContain(forAgent);
    expect(entries.map((e) => e.id)).toContain(forEveryone);
  });
  const duplicate = (config: Json, extra: Json = {}): Json => ({
    kind: 'duplicate_requests',
    subjects: [{ type: 'organization' }],
    config,
    ...extra,
  });
  const create = (kind: string, tool: string): Json => ({
    action: { tool_ref: tool, arguments: { title: kind } },
    continuation: { kind: 'langgraph', delivery: 'pull' },
  });

  it('a proposed duplicate_requests body stands beside the setting in force, and the tightest of them applies', async () => {
    const tool = 'mcp:tracker:create_issue';
    const decided = await json(
      await call(tokens.creator_user, 'POST', '/v1/decisions', create('beside', tool))
    );
    const first = decided.data as Json;
    expect(first.decision).toBe('step_up');
    const denied = await call(
      tokens.approver,
      'POST',
      `/v1/approvals/${String((first.approval as Json).id)}/deny`,
      { expected_action_digest: first.action_digest }
    );
    expect(denied.status).toBe(200);
    // The default (deny) is in force; the proposed body asks again. The deny is not replaced.
    const answer = await call(tokens.creator_user, 'POST', '/v1/policies/simulate', {
      policies: [duplicate({ after_rejection: 'ask_again' })],
      action: { tool_ref: tool, arguments: { title: 'beside' } },
    });
    expect(answer.status).toBe(200);
    const data = (await json(answer)).data as Json;
    expect(data).toMatchObject({ decision: 'deny', reason: 'rejected_duplicate' });
    const entries = ((data.considered as Json).policies as Json[]).filter(
      (e) => e.kind === 'duplicate_requests'
    );
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual(
      expect.objectContaining({ source: 'default', result: 'deny', contributed: true })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        id: null,
        proposed_index: 0,
        result: 'ask_again',
        contributed: false,
      })
    );
    for (const entry of entries) expect('source' in entry && 'proposed_index' in entry).toBe(false);
  });

  it('refuses a second proposed duplicate_requests body, naming its index', async () => {
    const refused = await call(tokens.creator, 'POST', '/v1/policies/simulate', {
      policies: [
        {
          kind: 'tool_invocation',
          subjects: [{ type: 'organization' }],
          config: { mode: 'always_allow' },
        },
        duplicate({ after_rejection: 'deny' }),
        duplicate({ after_rejection: 'ask_again' }),
      ],
      action: { tool_ref: 'mcp:tracker:add_comment', arguments: {} },
    });
    expect(refused.status).toBe(422);
    expect((await json(refused)).member).toBe('policies[2].kind');
  });

  it('checks the administrator before the body when a subject is named, so a malformed body is 403 for a member and 400 for an administrator', async () => {
    const malformed = { subject: { type: 'role', id: 'everyone' }, policies: [] };
    expect((await call(tokens.member, 'POST', '/v1/policies/simulate', malformed)).status).toBe(
      403
    );
    expect((await call(tokens.admin, 'POST', '/v1/policies/simulate', malformed)).status).toBe(400);
    // With no subject the body is validated for anyone.
    expect(
      (await call(tokens.member, 'POST', '/v1/policies/simulate', { policies: [] })).status
    ).toBe(400);
  });

  it('names the member of each refusal on a create and, prefixed with its index, on a set simulation', async () => {
    const forms: [string, Json][] = [
      [
        'config.mode',
        {
          kind: 'tool_invocation',
          subjects: [{ type: 'organization' }],
          config: { mode: 'not_granted' },
        },
      ],
      ['targets.tools', duplicate({ after_rejection: 'deny' }, { targets: { tools: ['t'] } })],
      [
        'kind',
        { kind: 'tool_quota', subjects: [{ type: 'organization' }], config: { mode: 'ask' } },
      ],
    ];
    for (const [member, body] of forms) {
      const created = await call(tokens.admin, 'POST', '/v1/policies', body);
      expect(created.status, member).toBe(422);
      expect((await json(created)).member, member).toBe(member);
      const set = await call(tokens.admin, 'POST', '/v1/policies/simulate', {
        policies: [body],
        action: { tool_ref: 'mcp:tracker:add_comment', arguments: {} },
      });
      expect(set.status, member).toBe(422);
      expect((await json(set)).member, member).toBe(`policies[0].${member}`);
    }
  });
});
