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
import { generateKey } from './keys.js';
import { ACCESS_TOKEN, SP, type Recorded, type Stub } from './stub.test-support.js';

export const GATEWAY_AUDIENCE = 'https://mcp-agents.example.com';
export const RUN_ID = '4f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
export const AGENT_ID = 'agent_9d1e';
export const SETUP_APPROVAL = 'ap_setup_1';
export const WRITE_APPROVAL = 'ap_write_1';

export interface Problem {
  readonly status: number;
  readonly type: string;
  readonly detail?: string;
  /** The body's `code` member: on `proposal_refused`, why. */
  readonly code?: string;
}

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
      const decided = id === SETUP_APPROVAL ? world.decisions.setup : world.decisions.write;
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
  options: { audiences?: string[] | null; register?: boolean; name?: string } = {}
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
      client_id: `sp_${SP}`,
      token_endpoint: `${stub.url}/auth/oauth/token`,
      assertion_audience: stub.url,
      private_jwk: key.privateJwk,
      ...(audiences === null ? {} : { audiences }),
    }),
    { mode: 0o600 }
  );
  return path;
}
