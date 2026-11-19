/**
 * The governance API (`/v1`) and MCP gateway routes `noblecloak starter` talks to, installed on the
 * stub of stub.test-support.ts. Bodies are shaped as bianoble-coo bdaafbdc serves them: the `{ data, meta }`
 * envelope, an RFC 9457 problem with the type URI as `type`, and for MCP a JSON-RPC envelope whose
 * refusals carry the HTTP status as `error.code` and the stable code in `error.data.code`
 * (apps/mcp/src/mcp-transport.ts legacyHttpStatus).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jcs, type JsonValue } from '@noblecloak/client';
import { generateKey } from './keys.js';
import { ACCESS_TOKEN, SP, type Recorded, type Stub } from './stub.test-support.js';

export const GATEWAY_AUDIENCE = 'https://mcp-agents.example.com';
export const RUN_ID = '4f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
export const AGENT_ID = 'agent_9d1e';
export const SETUP_APPROVAL = 'ap_setup_1';
export const WRITE_APPROVAL = 'ap_write_1';
/** The setup approval coo opened when the principal was created in the browser. */
export const BROWSER_APPROVAL = 'ap_browser_1';

export interface Problem {
  readonly status: number;
  readonly type: string;
  readonly detail?: string;
  /** The body's `code` member: on `proposal_refused`, why. */
  readonly code?: string;
  /** The body's `rejected_approval_id` member, on `rejected_duplicate`. */
  readonly rejected_approval_id?: string;
}

/**
 * The setup proposal as bianoble-coo 01405581 builds it (apps/api/src/internal-setup-proposal-routes.ts
 * `setupProposalArguments`), written out separately from `proposalFor` in starter.ts: the two have to agree
 * for coo to match a re-open to the browser's proposal.
 */
export function cooSetupArguments(agentId: string, principalId: string): Record<string, unknown> {
  return {
    agent: { id: agentId, principal_id: principalId },
    policies: [
      {
        role: 'tightening',
        rationale: 'The starter agent asks before every sandbox write.',
        assessment: {
          side_effect_level: 'write',
          blast_radius: 'one_record',
          reversible: false,
          external_party: false,
          financial: false,
        },
        policy: {
          kind: 'tool_invocation',
          subjects: [{ type: 'agent', id: agentId }],
          targets: { tools: ['tool:sandbox:create-note'] },
          config: { mode: 'ask' },
        },
      },
    ],
    tool_grants: ['tool:sandbox:create-note'],
  };
}

/** The continuation coo stores on the approval it opens for a browser-created principal (default-policy-open.ts `open()`). */
export const cooSetupContinuation = (principalId: string): Record<string, unknown> => ({
  kind: 'mcp_held',
  delivery: 'held',
  correlation: { source: 'internal_setup_proposal', principal_id: principalId },
});

export interface McpCall {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown>;
}

export interface World {
  /** What a poll of each approval answers once `pendingPolls` polls have answered `pending`. */
  decisions: { setup: string; write: string };
  pendingPolls: number;
  /** A refusal to answer an open (or the agent / run create) with, instead of its success. */
  refuse: { agent?: Problem; run?: Problem; setupOpen?: Problem; writeOpen?: Problem };
  /** The reason on the last history entry of a rejected approval. */
  rejectionReason: string | undefined;
  /** Destroys the connection of the next `POST /v1/agents`, as a network failure would. */
  dropAgent: boolean;
  /** How many of the next approval waits answer 502 (an ALB with nothing behind it) before the real answer. */
  failWaits: number;
  /** A refusal every approval wait answers with (a 401 once the person's token is out, say). */
  refuseWaits: Problem | undefined;
  /**
   * The gateway's answer to an admitted call. `raw` is sent as is instead of `body`; `drop` destroys the
   * connection before an answer; `truncate` sends a 200 and a part of its body, then destroys the connection.
   */
  mcp: { status: number; body?: unknown; raw?: string } | 'drop' | 'truncate' | undefined;
  /**
   * What coo did when the principal was created in the browser (`POST /internal/orgs/{org}/setup-proposals`,
   * bianoble-coo 01405581 apps/api/src/internal-setup-proposal-routes.ts), for the agent id coo derives
   * (`setupAgentId`). Unset: no such agent is modelled (every other test).
   *  - `agent`: `absent` (not declared: `GET` is 404, an open naming it is 422 `unknown_agent`), `declared`
   *    (unbound), or `bound` (its setup is applied: `GET` shows `principal_id`, a second setup is 422
   *    `proposal_refused` `policy_conflict`). `bindingHidden`: `GET` omits `principal_id`, as a
   *    deployment before contract rev 13 does.
   *  - `browser`: the proposal coo opened, as `proposer` (`user` is the person this test signs in as, `other`
   *    another admin), under the continuation `default-policy-open.ts` stores for it. An open answers it
   *    (200, `created: false`, `BROWSER_APPROVAL`) only for the same proposer, the same JCS digest of the
   *    arguments and the same JCS continuation; the same proposer and digest under another continuation is
   *    409 `continuation_conflict` (obligations continuation.ts `compareContinuation`); any other opens a
   *    new approval (201).
   *  - `rejectedDuplicate`: the approval id an administrator rejected; with the rule on, an identical open is
   *    409 `rejected_duplicate` naming it (module-api approvals.ts).
   *  - `holder`: an agent that already holds the principal; an open naming any other agent is 422
   *    `principal_bound` (apps/api/src/policy-set-checks.ts: `holder !== agent.id`).
   */
  coo:
    | {
        agentId: string;
        agent: 'absent' | 'declared' | 'bound';
        bindingHidden?: boolean;
        browser?: { proposer: 'user' | 'other' };
        rejectedDuplicate?: string;
        holder?: string;
      }
    | undefined;
  readonly agents: string[];
  readonly opened: { id: string; by: 'user' | 'sp'; body: Record<string, unknown> }[];
  readonly polls: string[];
  readonly mcpCalls: McpCall[];
  runs: number;
}

const META = { request_id: 'req_1' };

function json(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type });
  res.end(JSON.stringify(body));
}

function problem(res: ServerResponse, p: Problem): void {
  json(
    res,
    p.status,
    {
      type: `https://govern.noblecloak.com/problems/${p.type}`,
      title: p.type,
      status: p.status,
      request_id: 'req_1',
      ...(p.detail === undefined ? {} : { detail: p.detail }),
      ...(p.code === undefined ? {} : { code: p.code }),
      ...(p.rejected_approval_id === undefined
        ? {}
        : { rejected_approval_id: p.rejected_approval_id }),
    },
    'application/problem+json'
  );
}

const governToken = (stub: Stub): string => `Bearer sp-access|${stub.url}`;
const gatewayToken = `Bearer sp-access|${GATEWAY_AUDIENCE}`;

const isUser = (authorization: string | undefined): boolean =>
  authorization === `Bearer ${ACCESS_TOKEN}` || authorization === 'Bearer file-token';

function approvalBody(id: string, state: string, world: World): Record<string, unknown> {
  const row = world.opened.find((o) => o.id === id);
  const action = row?.body.action as { tool_ref?: string } | undefined;
  return {
    id,
    state,
    tool_ref: action?.tool_ref ?? 'tool:unknown',
    obligation_kind: 'tool_invocation',
    action_digest: 'a'.repeat(64),
    scope_id: RUN_ID,
    side_effect_level: 'write',
    created_at: '2026-11-17T10:00:00Z',
    resolution_history:
      state === 'rejected' && world.rejectionReason !== undefined
        ? [
            {
              resolution: 'rejected',
              by: { id: 'admin', kind: 'user' },
              at: '2026-11-17T10:01:00Z',
              reason: world.rejectionReason,
            },
          ]
        : [],
  };
}

/** Installs the routes on `stub` and returns the state a test scripts and inspects. */
export function installStarterRoutes(stub: Stub): World {
  const polled = new Map<string, number>();
  let consumed = false;
  stub.spAudiences = [stub.url, GATEWAY_AUDIENCE];
  stub.scopesSupported = ['module_api'];
  const world: World = {
    decisions: { setup: 'consumed', write: 'approved' },
    pendingPolls: 1,
    refuse: {},
    failWaits: 0,
    refuseWaits: undefined,
    rejectionReason: undefined,
    dropAgent: false,
    mcp: undefined,
    coo: undefined,
    agents: [],
    opened: [],
    polls: [],
    mcpCalls: [],
    runs: 0,
  };

  stub.custom = (req: IncomingMessage, res: ServerResponse, request: Recorded) => {
    const { path, method, authorization } = request;
    if (path.startsWith('/v1/mcp')) {
      const body = request.json ?? {};
      world.mcpCalls.push({ headers: req.headers, body });
      if (world.mcp === 'drop') {
        req.socket.destroy();
        return true;
      }
      if (authorization !== gatewayToken) {
        json(res, 401, { error: 'invalid_token' });
        return true;
      }
      if (world.mcp === 'truncate') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
        res.write('{"jsonrpc":"2.0",');
        setTimeout(() => req.socket.destroy(), 20);
        return true;
      }
      if (world.mcp !== undefined) {
        if (world.mcp.raw === undefined) {
          json(res, world.mcp.status, world.mcp.body);
        } else {
          res.writeHead(world.mcp.status, { 'content-type': 'text/plain' });
          res.end(world.mcp.raw);
        }
        return true;
      }
      const params = body.params as { name?: string; arguments?: unknown } | undefined;
      const written = world.opened.find((o) => o.id === WRITE_APPROVAL)?.body.action as
        { arguments?: unknown } | undefined;
      if (
        req.headers['x-noblecloak-external-run-id'] !== RUN_ID ||
        params?.name !== 'int_sandbox_create_note' ||
        JSON.stringify(params.arguments) !== JSON.stringify(written?.arguments)
      ) {
        json(res, 403, {
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: 403,
            message: 'No matching approval',
            data: { code: 'no_matching_obligation' },
          },
        });
        return true;
      }
      if (consumed) {
        json(res, 409, {
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: 409,
            message: 'Approval already used',
            data: { code: 'obligation_already_consumed' },
          },
        });
        return true;
      }
      consumed = true;
      json(res, 200, {
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: 'Created note n_1' }] },
      });
      return true;
    }
    if (!path.startsWith('/v1/')) return false;

    const user = isUser(authorization);
    const sp = authorization === governToken(stub);
    if (!user && !sp) {
      problem(res, { status: 401, type: 'unauthorized' });
      return true;
    }
    if (method === 'POST' && path === '/v1/agents') {
      if (world.dropAgent) {
        req.socket.destroy();
        return true;
      }
      if (world.refuse.agent !== undefined) {
        problem(res, world.refuse.agent);
        return true;
      }
      world.agents.push(String((request.json as { name?: unknown }).name));
      json(res, 201, {
        data: {
          id: AGENT_ID,
          name: 'NobleCloak starter',
          parent_id: null,
          created_at: '2026-11-17T10:00:00Z',
        },
        meta: META,
      });
      return true;
    }
    const agentRead = /^\/v1\/agents\/([^/]+)$/.exec(path);
    if (method === 'GET' && agentRead?.[1] !== undefined) {
      const coo = world.coo;
      if (coo?.agentId !== agentRead[1] || coo.agent === 'absent') {
        problem(res, { status: 404, type: 'not_found', detail: 'Agent not found' });
        return true;
      }
      json(res, 200, {
        data: {
          id: coo.agentId,
          name: 'starter-sp',
          parent_id: null,
          created_at: '2026-11-17T10:00:00Z',
          ...(coo.bindingHidden === true
            ? {}
            : { principal_id: coo.agent === 'bound' ? SP : null }),
        },
        meta: META,
      });
      return true;
    }
    if (method === 'POST' && path === '/v1/runs') {
      if (world.refuse.run !== undefined) {
        problem(res, world.refuse.run);
        return true;
      }
      world.runs += 1;
      json(res, 201, {
        data: {
          id: RUN_ID,
          kind: 'external',
          scope_id: RUN_ID,
          created_at: '2026-11-17T10:00:00Z',
        },
        meta: META,
      });
      return true;
    }
    if (method === 'POST' && path === '/v1/approvals') {
      const refusal = user ? world.refuse.setupOpen : world.refuse.writeOpen;
      if (refusal !== undefined) {
        problem(res, refusal);
        return true;
      }
      const id = user ? SETUP_APPROVAL : WRITE_APPROVAL;
      if (user && world.coo !== undefined) {
        const coo = world.coo;
        const sent = request.json as {
          action?: { arguments?: { agent?: { id?: unknown } } };
          continuation?: unknown;
        };
        const named = sent.action?.arguments?.agent?.id;
        if (named === coo.agentId) {
          if (coo.agent === 'absent') {
            problem(res, { status: 422, type: 'proposal_refused', code: 'unknown_agent' });
            return true;
          }
          if (coo.holder !== undefined && coo.holder !== named) {
            problem(res, { status: 422, type: 'proposal_refused', code: 'principal_bound' });
            return true;
          }
          if (coo.agent === 'bound') {
            problem(res, { status: 422, type: 'proposal_refused', code: 'policy_conflict' });
            return true;
          }
          const same =
            jcs(sent.action?.arguments as JsonValue) ===
              jcs(cooSetupArguments(named, SP) as JsonValue) && coo.browser?.proposer === 'user';
          if (same) {
            if (
              jcs(sent.continuation as JsonValue) !== jcs(cooSetupContinuation(SP) as JsonValue)
            ) {
              problem(res, { status: 409, type: 'continuation_conflict' });
              return true;
            }
            json(res, 200, {
              data: {
                id: BROWSER_APPROVAL,
                state: 'pending',
                created: false,
                created_at: '2026-11-17T10:00:00Z',
                resume_token_will_issue: false,
              },
              meta: META,
            });
            return true;
          }
          if (coo.rejectedDuplicate !== undefined && coo.browser === undefined) {
            problem(res, {
              status: 409,
              type: 'rejected_duplicate',
              rejected_approval_id: coo.rejectedDuplicate,
            });
            return true;
          }
        } else if (coo.holder !== undefined && coo.holder !== named) {
          problem(res, { status: 422, type: 'proposal_refused', code: 'principal_bound' });
          return true;
        } else if (named !== AGENT_ID) {
          problem(res, { status: 422, type: 'proposal_refused', code: 'unknown_agent' });
          return true;
        }
      }
      world.opened.push({ id, by: user ? 'user' : 'sp', body: request.json ?? {} });
      json(res, 201, {
        data: {
          id,
          state: 'pending',
          created: true,
          created_at: '2026-11-17T10:00:00Z',
          resume_token_will_issue: false,
        },
        meta: META,
      });
      return true;
    }
    const wait = /^\/v1\/approvals\/([^/]+)\/wait$/.exec(path);
    if (method === 'GET' && wait?.[1] !== undefined) {
      const id = wait[1];
      if (world.refuseWaits !== undefined) {
        problem(res, world.refuseWaits);
        return true;
      }
      if (world.failWaits > 0) {
        world.failWaits -= 1;
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('bad gateway');
        return true;
      }
      world.polls.push(id);
      const count = (polled.get(id) ?? 0) + 1;
      polled.set(id, count);
      const decided = id === WRITE_APPROVAL ? world.decisions.write : world.decisions.setup;
      json(res, 200, {
        data: approvalBody(id, count <= world.pendingPolls ? 'pending' : decided, world),
        meta: META,
      });
      return true;
    }
    problem(res, { status: 404, type: 'not_found' });
    return true;
  };
  return world;
}

/** A service principal registered with the stub, and the credential file the CLI would have written for it. */
export async function writeCredential(
  stub: Stub,
  dir: string,
  options: {
    audiences?: string[] | null;
    register?: boolean;
    name?: string;
    /** The `org_id` `sp create` writes into the file. */
    orgId?: string;
    /** Write the principal's UUID in the `client_id` upper-cased (the credential parser accepts either case). */
    upperCaseClientId?: boolean;
  } = {}
): Promise<string> {
  const key = await generateKey();
  if (options.register !== false) stub.registered.push(key.publicJwk);
  const audiences =
    options.audiences === undefined ? [stub.url, GATEWAY_AUDIENCE] : options.audiences;
  const path = join(dir, options.name ?? 'sp-credential.json');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      client_id: `sp_${options.upperCaseClientId === true ? SP.toUpperCase() : SP}`,
      token_endpoint: `${stub.url}/auth/oauth/token`,
      assertion_audience: stub.url,
      private_jwk: key.privateJwk,
      ...(audiences === null ? {} : { audiences }),
      ...(options.orgId === undefined ? {} : { org_id: options.orgId }),
    }),
    { mode: 0o600 }
  );
  return path;
}
