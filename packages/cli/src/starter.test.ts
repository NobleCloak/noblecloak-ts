import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USAGE } from './cli.js';
import { setupAgentId } from './setup-agent-id.js';
import { DEPLOYMENTS } from './starter-config.js';
import { SETUP_TOKEN_WINDOW_SECONDS, nextStepLines, setupWaitSeconds } from './starter.js';
import { run, type HarnessOptions } from './harness.test-support.js';
import {
  AGENT_ID,
  GATEWAY_AUDIENCE,
  RUN_ID,
  BROWSER_APPROVAL,
  SETUP_APPROVAL,
  WRITE_APPROVAL,
  installStarterRoutes,
  writeCredential,
  type World,
} from './starter.test-support.js';
import { ACCESS_TOKEN, REFRESH_TOKEN, SP, startStub, type Stub } from './stub.test-support.js';

let stub: Stub;
let world: World;
let dir: string;
let credential: string;

beforeEach(async () => {
  stub = await startStub();
  world = installStarterRoutes(stub);
  dir = await mkdtemp(join(tmpdir(), 'nc-starter-'));
  credential = await writeCredential(stub, dir);
});

afterEach(async () => {
  await stub.close();
  await rm(dir, { recursive: true, force: true });
});

const hostFlags = (): string[] => [
  '--auth-url',
  stub.url,
  '--govern-url',
  stub.url,
  '--mcp-url',
  stub.url,
  '--gateway-audience',
  GATEWAY_AUDIENCE,
];

const starter = (extra: string[] = [], options: HarnessOptions = {}, cred = credential) =>
  run(stub, ['starter', '--credentials', cred, ...hostFlags(), ...extra], options);

const revokedTokens = (): (string | null | undefined)[] =>
  stub.requests.filter((r) => r.path === '/auth/oauth/revoke').map((r) => r.form?.get('token'));

const apiRequests = (): string[] =>
  stub.requests.filter((r) => r.path.startsWith('/v1/')).map((r) => `${r.method} ${r.path}`);

describe('starter: the whole flow', () => {
  it('signs in as the person for the setup, then acts as the service principal for the one write', async () => {
    const result = await starter();
    expect(result.code, result.stderr).toBe(0);

    // The sign-in: the govern audience, no scope, and a deployment that offers no admin scope is fine.
    const authorize = result.opened[0];
    expect(authorize?.pathname).toBe('/auth/oauth/authorize');
    expect(authorize?.searchParams.get('resource')).toBe(stub.url);
    expect(authorize?.searchParams.has('scope')).toBe(false);
    expect(authorize?.searchParams.get('client_id')).toBe('noblecloak-cli');
    expect(authorize?.searchParams.get('code_challenge_method')).toBe('S256');

    // Two approvals, in order, each opened by the right principal and never by the other's token.
    expect(world.opened.map((o) => [o.id, o.by])).toEqual([
      [SETUP_APPROVAL, 'user'],
      [WRITE_APPROVAL, 'sp'],
    ]);
    const bearer = (path: string, method: string): string | undefined =>
      stub.requests.find((r) => r.path === path && r.method === method)?.authorization;
    expect(bearer('/v1/agents', 'POST')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(bearer('/v1/runs', 'POST')).toBe(`Bearer sp-access|${stub.url}`);
    expect(
      stub.requests
        .filter((r) => r.path === '/v1/approvals' && r.method === 'POST')
        .map((r) => r.authorization)
    ).toEqual([`Bearer ${ACCESS_TOKEN}`, `Bearer sp-access|${stub.url}`]);

    // The order: the person's setup is decided before the principal opens anything.
    expect(apiRequests()).toEqual([
      'POST /v1/agents',
      'POST /v1/approvals',
      `GET /v1/approvals/${SETUP_APPROVAL}/wait`,
      `GET /v1/approvals/${SETUP_APPROVAL}/wait`,
      'POST /v1/runs',
      'POST /v1/approvals',
      `GET /v1/approvals/${WRITE_APPROVAL}/wait`,
      `GET /v1/approvals/${WRITE_APPROVAL}/wait`,
      'POST /v1/mcp',
    ]);

    // The setup proposal: the agent bound to this principal, the sandbox tool granted, an `ask` tightening.
    const [setup, write] = world.opened;
    expect(setup?.body).toEqual({
      action: {
        tool_ref: 'tool:noblecloak:propose-policy-set',
        arguments: {
          agent: { id: AGENT_ID, principal_id: SP },
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
                subjects: [{ type: 'agent', id: AGENT_ID }],
                targets: { tools: ['tool:sandbox:create-note'] },
                config: { mode: 'ask' },
              },
            },
          ],
          tool_grants: ['tool:sandbox:create-note'],
        },
      },
      continuation: { kind: 'mcp_held', delivery: 'held' },
    });

    // The write: the exact note, inside the run, and the MCP call carries the same arguments once.
    const note = (write?.body.action as { arguments: unknown }).arguments;
    expect(write?.body).toEqual({
      action: { tool_ref: 'tool:sandbox:create-note', arguments: note },
      continuation: { kind: 'langgraph', delivery: 'pull' },
      run_id: RUN_ID,
    });
    expect(world.mcpCalls).toHaveLength(1);
    const call = world.mcpCalls[0];
    expect(call?.headers.authorization).toBe(`Bearer sp-access|${GATEWAY_AUDIENCE}`);
    expect(call?.headers['x-noblecloak-external-run-id']).toBe(RUN_ID);
    expect(call?.headers.accept).toBe('application/json, text/event-stream');
    expect(call?.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'int_sandbox_create_note', arguments: note },
    });

    expect(result.stdout).toBe(
      `Wrote one note to the sandbox (approval ${WRITE_APPROVAL}). Created note n_1\n`
    );
    expect(result.stderr).toContain(`Agent ${AGENT_ID} created.`);
    // A re-run is a --skip-setup write; --agent is for a setup that was not applied.
    expect(result.stderr).toContain(`retry the setup with --agent ${AGENT_ID}`);
    expect(result.stderr).toContain('another write with --skip-setup');
    expect(result.stderr).toContain(
      `Setup proposed (approval ${SETUP_APPROVAL}). Approve it in Approvals.`
    );
    expect(result.stderr).toContain('Approve or deny it in Approvals.');
    // The person's refresh token is revoked when the setup is done.
    const revoked = stub.requests
      .filter((r) => r.path === '/auth/oauth/revoke')
      .map((r) => r.form?.get('token'));
    expect(revoked).toEqual([REFRESH_TOKEN]);
  });

  it('prints neither a token, a key nor the code, and no URL carries one', async () => {
    const result = await starter();
    expect(result.code, result.stderr).toBe(0);
    const everything = `${result.stdout}${result.stderr}`;
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, 'sp-access', 'file-token']) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(/"d"/);
    for (const r of stub.requests.filter((q) => q.path.startsWith('/v1/'))) {
      expect(r.path).not.toMatch(/token|access/i);
    }
    // The sign-in URL (printed for the person to open) holds the PKCE challenge only, never a verifier.
    expect(result.stderr).not.toContain(stub.verifier ?? 'no verifier yet');
  });

  it('--json prints one object on stdout and keeps the progress on stderr', async () => {
    const result = await starter(['--json']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      agent_id: AGENT_ID,
      setup_approval_id: SETUP_APPROVAL,
      run_id: RUN_ID,
      write_approval_id: WRITE_APPROVAL,
      outcome: 'written',
      result: 'Created note n_1',
    });
  });

  it('--agent reuses the agent and creates none', async () => {
    const result = await starter(['--agent', 'agent_existing']);
    expect(result.code, result.stderr).toBe(0);
    expect(world.agents).toEqual([]);
    const args = world.opened[0]?.body.action as { arguments: { agent: { id: string } } };
    expect(args.arguments.agent.id).toBe('agent_existing');
    expect(result.stderr).toContain('Using agent agent_existing.');
    expect(result.stderr).toContain('proposal_refused:policy_conflict');
    expect(result.stderr).toContain('--skip-setup');
  });

  it('--user-token-file signs nobody in and uses the token for the setup only', async () => {
    const file = join(dir, 'user-token');
    await writeFile(file, 'file-token\n', { mode: 0o600 });
    await chmod(file, 0o600);
    const result = await starter(['--user-token-file', file]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.opened).toEqual([]);
    expect(stub.requests.some((r) => r.path === '/.well-known/oauth-authorization-server')).toBe(
      false
    );
    expect(stub.requests.find((r) => r.path === '/v1/agents')?.authorization).toBe(
      'Bearer file-token'
    );
  });

  it('--skip-setup makes the write only: no sign-in, no agent, no proposal', async () => {
    const result = await starter(['--skip-setup']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.opened).toEqual([]);
    expect(world.agents).toEqual([]);
    expect(world.opened.map((o) => o.id)).toEqual([WRITE_APPROVAL]);
  });

  it('--skip-setup --json reports no agent and no setup approval', async () => {
    expect(JSON.parse((await starter(['--skip-setup', '--json'])).stdout)).toMatchObject({
      agent_id: null,
      setup_approval_id: null,
    });
  });

  it('waits for the floor between polls of a pending approval', async () => {
    const started = Date.now();
    const result = await starter(['--skip-setup'], { pollFloorMs: 150 });
    expect(result.code, result.stderr).toBe(0);
    // One pending poll on the write approval, then the decision.
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
  });
});

describe('starter: before anything is opened', () => {
  it('no credential: exit 10, naming the flag, the variable and the sp create command, with no request made', async () => {
    const result = await run(stub, ['starter', ...hostFlags()]);
    expect(result.code).toBe(10);
    expect(result.stderr).toContain('--credentials');
    expect(result.stderr).toContain('NOBLECLOAK_SP_CREDENTIALS');
    expect(result.stderr).toContain(
      `noblecloak sp create --org <uuid> --name <name> --audience ${stub.url} --audience ${GATEWAY_AUDIENCE} --out <path>`
    );
    expect(stub.requests).toEqual([]);
  });

  it('a credential file that is not there: exit 2, naming the resolved path and why, with no request made', async () => {
    const missing = join(dirname(credential), 'noblecloak-sp-typo.json');
    const result = await run(stub, ['starter', '--credentials', missing, ...hostFlags()]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `error: Cannot read the service-principal credential file ${missing} (named by the path argument): no such file.\n`
    );
    expect(stub.requests).toEqual([]);
  });

  it('a credential path from NOBLECLOAK_SP_CREDENTIALS that is not there: names the variable, not the argument', async () => {
    const missing = join(dirname(credential), 'noblecloak-sp-typo.json');
    const result = await run(stub, ['starter', ...hostFlags()], {
      env: { NOBLECLOAK_SP_CREDENTIALS: missing },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `error: Cannot read the service-principal credential file ${missing} (named by the path in NOBLECLOAK_SP_CREDENTIALS): no such file.\n`
    );
  });

  it('a credential argument that is a secret and not a path is not printed', async () => {
    const secret = 'ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6';
    const result = await run(stub, ['starter', '--credentials', secret, ...hostFlags()]);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).toContain('Cannot read the service-principal credential file');
  });

  it('reads the credential from NOBLECLOAK_SP_CREDENTIALS', async () => {
    const result = await run(stub, ['starter', ...hostFlags()], {
      env: { NOBLECLOAK_SP_CREDENTIALS: credential },
    });
    expect(result.code, result.stderr).toBe(0);
  });

  it('a credential that cannot be read or is not one: exit 2', async () => {
    expect((await starter([], {}, join(dir, 'missing.json'))).code).toBe(2);
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{"client_id":"nope"}');
    const result = await starter([], {}, bad);
    expect(result.code).toBe(2);
    expect(stub.requests).toEqual([]);
  });

  it('a credential file that lists audiences without the gateway: exit 11 naming both audiences, nothing contacted', async () => {
    const cred = await writeCredential(stub, dir, {
      audiences: [`${stub.url}/`],
      name: 'one.json',
    });
    const result = await starter([], {}, cred);
    expect(result.code).toBe(11);
    expect(result.stderr).toContain(GATEWAY_AUDIENCE);
    expect(result.stderr).not.toContain(`for ${stub.url} or`);
    expect(result.stderr).toContain(
      `noblecloak sp create --org <uuid> --name <name> --audience ${stub.url} --audience ${GATEWAY_AUDIENCE} --out <path>`
    );
    expect(stub.requests).toEqual([]);
  });

  it('a credential that lists neither audience names both', async () => {
    const cred = await writeCredential(stub, dir, {
      audiences: ['https://other.example.com'],
      name: 'none.json',
    });
    const result = await starter([], {}, cred);
    expect(result.code).toBe(11);
    expect(result.stderr).toContain(`${stub.url} or ${GATEWAY_AUDIENCE}`);
  });

  it('a credential with no audiences listed is asked: the token endpoint refusing the gateway audience is exit 11, before sign-in', async () => {
    const cred = await writeCredential(stub, dir, { audiences: null, name: 'bare.json' });
    stub.spAudiences = [stub.url];
    const result = await starter([], {}, cred);
    expect(result.code).toBe(11);
    expect(result.stderr).toContain(GATEWAY_AUDIENCE);
    expect(result.opened).toEqual([]);
    expect(world.opened).toEqual([]);
  });

  it('a principal whose key the token endpoint does not know: exit 3, before sign-in', async () => {
    const cred = await writeCredential(stub, dir, { register: false, name: 'unregistered.json' });
    const result = await starter([], {}, cred);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('rejected the service principal');
    expect(result.opened).toEqual([]);
    expect(world.opened).toEqual([]);
  });

  it('inline JSON in NOBLECLOAK_SP_CREDENTIALS is read and its audiences checked', async () => {
    const cred = await writeCredential(stub, dir, { audiences: [stub.url], name: 'inline.json' });
    const { readFile } = await import('node:fs/promises');
    const inline = await readFile(cred, 'utf8');
    const result = await run(stub, ['starter', ...hostFlags()], {
      env: { NOBLECLOAK_SP_CREDENTIALS: inline },
    });
    expect(result.code).toBe(11);
  });

  it.each([
    [['--wait', '0'], '--wait'],
    [['--wait', 'abc'], '--wait'],
    [['--wait', '3601'], '--wait'],
    [['--agent', ''], '--agent'],
    [['--skip-setup', '--agent', 'a'], '--skip-setup'],
    [['--skip-setup', '--user-token-file', '/x'], '--skip-setup'],
    [['--deployment', 'moon'], 'Unknown deployment'],
    [['--govern-url', 'http://example.com'], 'govern URL'],
    [['--mcp-url', 'https://mcp.example.com/v1/mcp'], 'origin'],
    [['--gateway-audience', 'not a url'], 'gateway audience'],
    [['--auth-url', 'http://example.com'], 'authorization server'],
    [['--nope'], 'nope'],
  ])('refuses %j with exit 2 and contacts nobody', async (extra, mention) => {
    const result = await run(stub, ['starter', '--credentials', credential, ...extra]);
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain(mention);
    expect(stub.requests).toEqual([]);
  });

  it('a credential declared for beta, run as production: exit 11 says --deployment beta, not to create a new principal', async () => {
    const cred = await writeCredential(stub, dir, {
      audiences: [DEPLOYMENTS.beta.governUrl, DEPLOYMENTS.beta.gatewayAudience],
      name: 'beta.json',
    });
    const result = await run(stub, [
      'starter',
      '--credentials',
      cred,
      '--deployment',
      'production',
    ]);
    expect(result.code).toBe(11);
    expect(result.stderr).toContain('--deployment beta');
    expect(result.stderr).not.toContain('sp create');
    expect(stub.requests).toEqual([]);
  });

  it('a credential with no audiences listed whose token endpoint is another deployment names it', async () => {
    const cred = await writeCredential(stub, dir, { audiences: null, name: 'bare-beta.json' });
    const { readFile, writeFile: write } = await import('node:fs/promises');
    const body = JSON.parse(await readFile(cred, 'utf8')) as Record<string, unknown>;
    body.token_endpoint = `${DEPLOYMENTS.beta.authUrl}/auth/oauth/token`;
    await write(cred, JSON.stringify(body), { mode: 0o600 });
    const result = await run(stub, [
      'starter',
      '--credentials',
      cred,
      '--deployment',
      'production',
    ]);
    expect(result.code).toBe(11);
    expect(result.stderr).toContain('--deployment beta');
    expect(stub.requests).toEqual([]);
  });

  it('starter --help prints the usage, which describes the command', async () => {
    const result = await run(stub, ['starter', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(USAGE);
    expect(USAGE).toContain('noblecloak starter');
    expect(USAGE).toContain('10 no credentials');
  });
});

describe('starter: what to do while it waits', () => {
  const production = { ...DEPLOYMENTS.production };
  const { authUrl, governUrl, mcpUrl, gatewayAudience } = production;
  const withoutApp = { authUrl, governUrl, mcpUrl, gatewayAudience };

  it('setup: names the Approvals URL, the request, the wait and how to stop', () => {
    expect(
      nextStepLines(production, {
        opened: `Setup proposed (approval a1). Approve it in Approvals`,
        toolRef: 'tool:noblecloak:propose-policy-set',
        decide: 'approve it',
        seconds: 600,
      })
    ).toEqual([
      'Setup proposed (approval a1). Approve it in Approvals: https://app.noblecloak.com/approvals',
      'In Approvals it is the request for tool:noblecloak:propose-policy-set.',
      'This command waits up to 600 seconds for you to approve it. Press Ctrl-C to stop; the request stays open.',
    ]);
  });

  it('a deployment given by explicit URLs has no app URL: the line keeps its old wording', () => {
    const lines = nextStepLines(withoutApp, {
      opened: 'Write requested (approval w1). Approve or deny it in Approvals',
      toolRef: 'tool:sandbox:create-note',
      decide: 'decide it',
      seconds: 30,
    });
    expect(lines[0]).toBe('Write requested (approval w1). Approve or deny it in Approvals.');
    expect(lines.join('\n')).not.toContain('http');
  });

  it('a newline in a server-returned approval id cannot start a line of its own', async () => {
    const forged = 'In Approvals it is the request for tool:forged.';
    world.idTail = `\n${forged}`;
    // The stub's gateway does not know the odd id, so the run ends at the write: the lines are what counts.
    const result = await starter();
    const lines = result.stderr.split('\n');
    expect(lines.filter((l) => l.startsWith('In Approvals it is the request for'))).toHaveLength(2);
    expect(lines.some((l) => l.startsWith('In Approvals it is the request for tool:forged'))).toBe(
      false
    );
    expect(result.stderr).toContain(`ap_setup_1 ${forged}`);
    expect(result.stderr).toContain(`ap_write_1 ${forged}`);
  });

  it('says "1 second", not "1 seconds"', async () => {
    const result = await starter(['--wait', '1']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('waits up to 1 second for you to approve it');
    expect(result.stderr).toContain('waits up to 1 second for you to decide it');
    expect(result.stderr).not.toContain('1 seconds');
  });

  it('the flow prints the request name and the wait for both approvals, and no link for stub URLs', async () => {
    const result = await starter();
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'In Approvals it is the request for tool:noblecloak:propose-policy-set.'
    );
    expect(result.stderr).toContain('In Approvals it is the request for tool:sandbox:create-note');
    expect(result.stderr).toContain('This command waits up to 600 seconds for you to approve it.');
    expect(result.stderr).toContain('This command waits up to 600 seconds for you to decide it.');
    expect(result.stderr).toContain('Press Ctrl-C to stop; the request stays open.');
    expect(result.stderr).not.toContain('/approvals');
  });
});

describe('starter: the setup wait and the access token', () => {
  it('cuts the setup wait to what is left of the 15-minute access token', () => {
    expect(SETUP_TOKEN_WINDOW_SECONDS).toBe(840);
    expect(setupWaitSeconds(600, 0)).toBe(600);
    expect(setupWaitSeconds(3600, 0)).toBe(840);
    expect(setupWaitSeconds(3600, 30_000)).toBe(810);
    expect(setupWaitSeconds(600, 300_000)).toBe(540);
    expect(setupWaitSeconds(600, 839_000)).toBe(1);
    expect(setupWaitSeconds(600, 2_000_000)).toBe(1);
  });

  it('--wait 3600 waits 840 seconds for the setup and says why', async () => {
    const result = await starter(['--wait', '3600']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('Waiting 840 seconds for the setup, not 3600');
    expect(result.stderr).toContain('15 minutes');
  });

  it('the deadline of the setup wait is the cut one: 841 seconds on, an undecided setup has timed out', async () => {
    world.pendingPolls = 1_000;
    const real = Date.now.bind(Date);
    const spy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => real() + (world.polls.length > 0 ? 841_000 : 0));
    try {
      const result = await starter(['--wait', '3600'], { pollFloorMs: 50 });
      expect(result.code).toBe(15);
      expect(result.stderr).toContain('within 840 seconds');
    } finally {
      spy.mockRestore();
    }
  });

  it('a wait inside the token window is not cut and says nothing about it', async () => {
    const result = await starter(['--wait', '600']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('Waiting ');
  });
});

describe('starter: the setup', () => {
  it('a setup nobody applies stops there: exit 13, with the reason, and the principal opens nothing', async () => {
    world.decisions.setup = 'rejected';
    world.rejectionReason = 'proposal_refused:policy_conflict';
    const result = await starter();
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('rejected');
    expect(result.stderr).toContain('proposal_refused:policy_conflict');
    expect(revokedTokens()).toEqual([REFRESH_TOKEN]);
    expect(world.runs).toBe(0);
    expect(world.mcpCalls).toEqual([]);
  });

  it('a withdrawn setup is exit 13 too', async () => {
    world.decisions.setup = 'withdrawn';
    expect((await starter()).code).toBe(13);
  });

  it('an expired setup is exit 15', async () => {
    world.decisions.setup = 'expired';
    const result = await starter();
    expect(result.code).toBe(15);
    expect(result.stderr).toContain('expired');
  });

  it('a proposal the deployment refuses at open is exit 13 with its code', async () => {
    world.refuse.setupOpen = {
      status: 422,
      type: 'proposal_refused',
      detail: 'agent.principal_id is bound to another agent',
    };
    const result = await starter();
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('proposal_refused');
    expect(result.stderr).toContain('bound to another agent');
    expect(world.runs).toBe(0);
  });

  it('a deployment without the sandbox answers the setup with target_unknown: exit 12, not 13', async () => {
    world.refuse.setupOpen = {
      status: 422,
      type: 'proposal_refused',
      code: 'target_unknown',
      detail: 'A policy targets a tool that is neither registered nor in this proposal',
    };
    const result = await starter();
    expect(result.code).toBe(12);
    expect(result.stderr).toContain('sandbox is not available');
    expect(result.stderr).toContain('tool:sandbox:create-note');
    expect(world.runs).toBe(0);
  });

  it("a proposal refusal names the body's reason even when it has no detail", async () => {
    world.refuse.setupOpen = { status: 422, type: 'proposal_refused', code: 'policy_conflict' };
    const result = await starter();
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('proposal_refused:policy_conflict');
  });

  it('a principal that is already bound is told to run with --skip-setup: at open', async () => {
    world.refuse.setupOpen = { status: 422, type: 'proposal_refused', code: 'principal_bound' };
    const result = await starter();
    expect(result.code).toBe(13);
    expect(result.stderr).toContain(
      'This service principal is already set up; run again with --skip-setup.'
    );
    expect(world.runs).toBe(0);
  });

  it('a principal that is already bound is told the same when the approval is refused after open', async () => {
    world.rejectionReason = 'proposal_refused:principal_bound';
    world.decisions.setup = 'rejected';
    const result = await starter();
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('is already set up; run again with --skip-setup');
    expect(world.runs).toBe(0);
  });

  it('a setup nobody decides within --wait is exit 15, naming the approval', async () => {
    world.pendingPolls = 1_000;
    const result = await starter(['--wait', '1'], { pollFloorMs: 200 });
    expect(result.code).toBe(15);
    expect(result.stderr).toContain(SETUP_APPROVAL);
    expect(result.stderr).toContain('within 1 second');
    expect(result.stderr).toContain('then make the write with --skip-setup');
    expect(world.runs).toBe(0);
  });

  it('a newline in the id cannot start a line of its own in the timeout message either', async () => {
    const forged = 'Setup proposed. Approve it in Approvals: https://evil.example/approvals';
    world.idTail = `\n${forged}`;
    world.pendingPolls = 1_000;
    const result = await starter(['--wait', '1'], { pollFloorMs: 200 });
    expect(result.code).toBe(15);
    const lines = result.stderr.split('\n');
    expect(
      lines.some((l) => l.startsWith('Setup proposed. Approve it in Approvals: https://evil'))
    ).toBe(false);
    expect(
      lines.some((l) => l.includes('Nobody decided the setup (approval ap_setup_1 Setup proposed.'))
    ).toBe(true);
  });

  it('403 on creating the agent is exit 4, 401 is exit 3, and a 5xx is exit 1', async () => {
    world.refuse.agent = { status: 403, type: 'forbidden' };
    const forbidden = await starter();
    expect(forbidden.code).toBe(4);
    world.refuse.agent = { status: 401, type: 'unauthorized' };
    expect((await starter()).code).toBe(3);
    world.refuse.agent = { status: 503, type: 'service_unavailable' };
    const down = await starter();
    expect(down.code).toBe(1);
    expect(down.stderr).toContain('Cannot create the agent: /v1 answered 503');
    expect(down.stderr).not.toContain('reach');
  });

  it('a request that gets no answer is exit 1 and says it could not be reached', async () => {
    world.dropAgent = true;
    const result = await starter();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Cannot create the agent: /v1 could not be reached');
  });

  it('a refusal that is none of those is exit 1 with its status, code and detail', async () => {
    world.refuse.agent = { status: 400, type: 'invalid_request', detail: 'name is too long' };
    const result = await starter();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('400 invalid_request: name is too long');
  });
});

describe('starter: a poll the network or a 5xx cuts', () => {
  it('is repeated: one 502 on the setup wait does not end the command', async () => {
    world.failWaits = 1;
    const result = await starter([], { pollFloorMs: 10 });
    expect(result.code, result.stderr).toBe(0);
    expect(world.polls).toContain(SETUP_APPROVAL);
  });

  it('until the deadline, then exit 1 says the approval is still open and how to continue', async () => {
    world.failWaits = 1_000;
    const result = await starter(['--wait', '1'], { pollFloorMs: 300 });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('/v1 answered 502');
    expect(result.stderr).toContain(`approval ${SETUP_APPROVAL}) is still open`);
    expect(result.stderr).toContain('then make the write with --skip-setup');
    expect(world.mcpCalls).toEqual([]);
  });

  it('a refusal is not repeated: a 401 on the wait is exit 3 after one poll', async () => {
    world.refuseWaits = { status: 401, type: 'unauthorized' };
    const result = await starter([], { pollFloorMs: 10 });
    expect(result.code).toBe(3);
    expect(result.stderr).not.toContain('still open');
    expect(stub.requests.filter((r) => r.path.endsWith('/wait'))).toHaveLength(1);
  });

  it('a write wait is repeated too, and still opens nothing twice', async () => {
    world.decisions.setup = 'consumed';
    world.failWaits = 2;
    const result = await starter(['--skip-setup'], { pollFloorMs: 10 });
    expect(result.code, result.stderr).toBe(0);
    expect(world.opened.filter((o) => o.by === 'sp')).toHaveLength(1);
    expect(world.mcpCalls).toHaveLength(1);
  });
});

describe('starter: the write', () => {
  it('a deployment with no sandbox route is exit 12 and no call is made', async () => {
    world.refuse.writeOpen = {
      status: 422,
      type: 'approval_unroutable',
      detail: 'the tool is unknown',
    };
    const result = await starter();
    expect(result.code).toBe(12);
    expect(result.stderr).toContain('tool:sandbox:create-note');
    expect(result.stderr).toContain('the tool is unknown');
    expect(world.mcpCalls).toEqual([]);
  });

  it('a principal that was never granted the tool (--skip-setup) is told to run the setup, not that the sandbox is missing', async () => {
    world.refuse.writeOpen = {
      status: 422,
      type: 'approval_unroutable',
      detail: 'the gateway routes this tool_ref for this principal to a different tool',
    };
    const result = await starter(['--skip-setup']);
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('is not granted tool:sandbox:create-note');
    expect(result.stderr).toContain('run without it');
    expect(result.stderr).not.toContain('sandbox is not available');
    expect(world.mcpCalls).toEqual([]);
  });

  it('a write the deployment refused a moment ago is exit 14 and says to wait, not exit 1', async () => {
    world.refuse.writeOpen = { status: 409, type: 'rejected_duplicate' };
    const result = await starter();
    expect(result.code).toBe(14);
    expect(result.stderr).toContain('refused a short while ago');
    expect(result.stderr).toContain('Nothing was written');
    expect(world.mcpCalls).toEqual([]);
  });

  it('another 422 on the write approval is exit 1, not the sandbox message', async () => {
    world.refuse.writeOpen = { status: 422, type: 'proposal_refused' };
    const result = await starter();
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain('sandbox is not available');
  });

  it('a denied write is exit 14 and the gateway is never called', async () => {
    world.decisions.write = 'rejected';
    world.rejectionReason = 'not today';
    const result = await starter();
    expect(result.code).toBe(14);
    expect(result.stderr).toContain('not today');
    expect(result.stderr).toContain('Nothing was written');
    expect(world.mcpCalls).toEqual([]);
  });

  it('an expired write approval is exit 15', async () => {
    world.decisions.write = 'expired';
    expect((await starter()).code).toBe(15);
    expect(world.mcpCalls).toEqual([]);
  });

  it('a write nobody decides within --wait is exit 15', async () => {
    world.pendingPolls = 1_000;
    world.decisions.setup = 'consumed';
    const result = await starter(['--skip-setup', '--wait', '1'], { pollFloorMs: 200 });
    expect(result.code).toBe(15);
    expect(result.stderr).toContain(WRITE_APPROVAL);
    expect(result.stderr).toContain('then run again.');
    expect(world.mcpCalls).toEqual([]);
  });

  it('an approval already consumed is exit 16 and the gateway is never called', async () => {
    world.decisions.write = 'consumed';
    const result = await starter();
    expect(result.code).toBe(16);
    expect(world.mcpCalls).toEqual([]);
  });

  it('the gateway answering 409 obligation_already_consumed is exit 16', async () => {
    world.mcp = {
      status: 409,
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: 409,
          message: 'Approval already used',
          data: { code: 'obligation_already_consumed' },
        },
      },
    };
    const result = await starter();
    expect(result.code).toBe(16);
    expect(result.stderr).toContain('obligation_already_consumed');
    expect(world.mcpCalls).toHaveLength(1);
  });

  it('a gateway 404 for the tool after approval is exit 13 with the run-the-setup hint', async () => {
    world.mcp = {
      status: 404,
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: 404, message: 'Unknown tool', data: { code: 'tool_not_found' } },
      },
    };
    const result = await starter(['--skip-setup']);
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('404 tool_not_found');
    expect(result.stderr).toContain('run without it so the setup grants the tool');
    expect(result.stderr).toContain('nothing was written');
  });

  it('a gateway refusal (403 no_matching_obligation) is exit 14: nothing was written', async () => {
    world.mcp = {
      status: 403,
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: 403,
          message: 'No approved obligation',
          data: { code: 'no_matching_obligation' },
        },
      },
    };
    const result = await starter();
    expect(result.code).toBe(14);
    expect(result.stderr).toContain('no_matching_obligation');
    expect(result.stderr).toContain('nothing was written');
  });

  it('any other 409 from the gateway is a refusal too: exit 14, not the replay exit', async () => {
    world.mcp = {
      status: 409,
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: 409, message: 'Run is closed', data: { code: 'run_closed' } },
      },
    };
    const result = await starter();
    expect(result.code).toBe(14);
    expect(result.stderr).toContain('409 run_closed');
  });

  it('a JSON-RPC error without a stable code falls back to its numeric code', async () => {
    world.mcp = {
      status: 500,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } },
    };
    const result = await starter();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('500 -32603: Internal error');
  });

  it('the gateway refusing the token is exit 3', async () => {
    world.mcp = { status: 401, body: { error: 'invalid_token' } };
    const result = await starter();
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('401 invalid_token');
  });

  it('an answer that is not JSON-RPC and not a success is exit 1', async () => {
    world.mcp = { status: 502, raw: '<html>upstream connect error</html>' };
    const result = await starter();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'The MCP gateway answered 502: <html>upstream connect error</html>.'
    );
  });

  it('an answer with a status and no body says only the status, without a stray space', async () => {
    world.mcp = { status: 503, raw: '' };
    const result = await starter();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('The MCP gateway answered 503.');
  });

  it('a 200 whose body is not JSON says the write may have been made', async () => {
    world.mcp = { status: 200, raw: 'event: message\ndata: {"jsonrpc":"2.0"}\n\n' };
    const result = await starter();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('without a result');
    expect(result.stderr).toContain('may or may not have been made');
    expect(world.mcpCalls).toHaveLength(1);
  });

  it('a 200 whose body is cut off says the write may have been made, and is sent once', async () => {
    world.mcp = 'truncate';
    const result = await starter();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('could not be read');
    expect(result.stderr).toContain('may or may not have been made');
    expect(world.mcpCalls).toHaveLength(1);
  });

  it('a tool that reports its own error is exit 1', async () => {
    world.mcp = {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: { isError: true, content: [{ type: 'text', text: 'title too long' }] },
      },
    };
    const result = await starter();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('title too long');
  });

  it('a tool error with no text is still exit 1', async () => {
    world.mcp = { status: 200, body: { jsonrpc: '2.0', id: 1, result: { isError: true } } };
    expect((await starter()).code).toBe(1);
  });

  it('a success with no text prints the line without a result', async () => {
    world.mcp = { status: 200, body: { jsonrpc: '2.0', id: 1, result: { content: [] } } };
    const result = await starter();
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Wrote one note to the sandbox (approval ${WRITE_APPROVAL}).\n`);
  });

  it('a 200 with no result is exit 1', async () => {
    world.mcp = { status: 200, body: { jsonrpc: '2.0', id: 1 } };
    const result = await starter();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('without a result');
    expect(result.stderr).toContain('may or may not have been made');
  });

  it('a call that gets no answer says the write may have been made, and is sent once', async () => {
    world.mcp = 'drop';
    const result = await starter();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('may or may not have been made');
    expect(world.mcpCalls).toHaveLength(1);
  });

  it('long result text is cut to 200 characters and control characters never reach the terminal', async () => {
    world.mcp = {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: `\u001b[31m${'x'.repeat(500)}` }] },
      },
    };
    const result = await starter();
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
    expect(result.stdout.length).toBeLessThan(300);
  });
});

describe('starter: interruption', () => {
  it('an interrupt while waiting for the setup is exit 3', async () => {
    world.pendingPolls = 1_000;
    const abort = new AbortController();
    setTimeout(() => {
      abort.abort();
    }, 300);
    const result = await starter([], { signal: abort.signal, pollFloorMs: 100 });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('Interrupted');
    expect(revokedTokens()).toEqual([REFRESH_TOKEN]);
    expect(world.runs).toBe(0);
  });

  it('an interrupt before the gateway call leaves it unmade', async () => {
    world.pendingPolls = 1_000;
    const abort = new AbortController();
    setTimeout(() => {
      abort.abort();
    }, 300);
    const result = await starter(['--skip-setup'], { signal: abort.signal, pollFloorMs: 100 });
    expect(result.code).toBe(3);
    expect(world.mcpCalls).toEqual([]);
  });
});

describe('starter: a setup coo already opened for the principal', () => {
  const ORG = '11111111-2222-4333-8444-555555555555';
  const COO_AGENT = setupAgentId(ORG, SP);
  let withOrg: string;

  // The stub holds the keys of the principal it knows: this file's key replaces the default one's.
  beforeEach(async () => {
    stub.registered.length = 0;
    withOrg = await writeCredential(stub, dir, { orgId: ORG, name: 'sp-credential-org.json' });
  });

  const setupOpens = (): { continuation?: unknown }[] =>
    stub.requests
      .filter((r) => r.path === '/v1/approvals' && r.method === 'POST')
      .slice(0, -1)
      .map((r) => r.json as { continuation?: unknown });

  it('reuses the proposal coo opened for this admin: no agent is declared, no second proposal is opened, and it waits on that one', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'declared', browser: { proposer: 'user' } };
    const result = await starter(['--json'], {}, withOrg);
    expect(result.code, result.stderr).toBe(0);
    // The agent is read, then one POST /v1/approvals for the setup (answered `created: false`) and one for the write.
    expect(apiRequests()).toEqual([
      `GET /v1/agents/${COO_AGENT}`,
      'POST /v1/approvals',
      `GET /v1/approvals/${BROWSER_APPROVAL}/wait`,
      `GET /v1/approvals/${BROWSER_APPROVAL}/wait`,
      'POST /v1/runs',
      'POST /v1/approvals',
      `GET /v1/approvals/${WRITE_APPROVAL}/wait`,
      `GET /v1/approvals/${WRITE_APPROVAL}/wait`,
      'POST /v1/mcp',
    ]);
    expect(world.agents).toEqual([]);
    expect(world.opened.map((o) => o.id)).toEqual([WRITE_APPROVAL]);
    // coo's continuation, member for member: the correlation is what makes the re-open the same approval.
    expect(setupOpens()).toEqual([
      {
        action: expect.anything() as unknown,
        continuation: {
          kind: 'mcp_held',
          delivery: 'held',
          correlation: { source: 'internal_setup_proposal', principal_id: SP },
        },
      },
    ]);
    expect(result.stderr).toContain(`Setup already open (approval ${BROWSER_APPROVAL})`);
    expect(result.stderr).not.toContain('Setup proposed');
    expect(JSON.parse(result.stdout)).toMatchObject({
      agent_id: COO_AGENT,
      setup_approval_id: BROWSER_APPROVAL,
    });
  });

  it('sends the principal id lower-cased in the proposal and the continuation when the credential has it upper-cased', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'declared', browser: { proposer: 'user' } };
    const upper = await writeCredential(stub, dir, {
      orgId: ORG.toUpperCase(),
      upperCaseClientId: true,
      name: 'sp-credential-upper.json',
    });
    const result = await starter([], {}, upper);
    expect(result.code, result.stderr).toBe(0);
    expect(world.opened.map((o) => o.id)).toEqual([WRITE_APPROVAL]);
    expect(apiRequests()[0]).toBe(`GET /v1/agents/${COO_AGENT}`);
    expect(result.stderr).toContain(`Setup already open (approval ${BROWSER_APPROVAL})`);
  });

  it('opens one proposal for coo’s agent when it is declared and none is open', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'declared' };
    const result = await starter([], {}, withOrg);
    expect(result.code, result.stderr).toBe(0);
    expect(world.agents).toEqual([]);
    const [setup] = world.opened;
    expect(setup?.id).toBe(SETUP_APPROVAL);
    expect((setup?.body.action as { arguments: { agent: unknown } }).arguments.agent).toEqual({
      id: COO_AGENT,
      principal_id: SP,
    });
    expect(result.stderr).toContain(`Setup proposed (approval ${SETUP_APPROVAL})`);
  });

  it('another admin’s proposal does not match: a second one opens, and when that one is refused policy_conflict the message is already-set-up, not principal_bound', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'declared', browser: { proposer: 'other' } };
    world.rejectionReason = 'proposal_refused:policy_conflict';
    world.decisions.setup = 'rejected';
    const result = await starter([], {}, withOrg);
    expect(result.code).toBe(13);
    expect(world.opened.map((o) => o.id)).toEqual([SETUP_APPROVAL]);
    expect(result.stderr).toContain('is already set up; run again with --skip-setup');
    expect(result.stderr).not.toContain('principal_bound');
    expect(world.runs).toBe(0);
  });

  it('declares its own agent and opens one proposal when coo has no such agent, without opening a probe', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'absent' };
    const result = await starter([], {}, withOrg);
    expect(result.code, result.stderr).toBe(0);
    expect(world.agents).toEqual(['NobleCloak starter']);
    expect(apiRequests().slice(0, 4)).toEqual([
      `GET /v1/agents/${COO_AGENT}`, // 404
      'POST /v1/agents',
      'POST /v1/approvals',
      `GET /v1/approvals/${SETUP_APPROVAL}/wait`,
    ]);
    expect(world.opened.filter((o) => o.by === 'user')).toHaveLength(1);
    expect(
      (world.opened[0]?.body.action as { arguments: { agent: { id: string } } }).arguments.agent.id
    ).toBe(AGENT_ID);
    // The own agent's proposal keeps the plain continuation: it is nobody else's approval to match.
    expect(setupOpens()).toEqual([
      {
        action: expect.anything() as unknown,
        continuation: { kind: 'mcp_held', delivery: 'held' },
      },
    ]);
  });

  it('a setup already applied (the agent is bound to this principal) is exit 13 with nothing opened', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'bound' };
    const result = await starter([], {}, withOrg);
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('is already set up; run again with --skip-setup');
    expect(apiRequests()).toEqual([`GET /v1/agents/${COO_AGENT}`]);
    expect(world.agents).toEqual([]);
    expect(world.opened).toEqual([]);
    expect(world.runs).toBe(0);
  });

  it('a deployment whose agent read omits the binding opens, and the policy_conflict refusal is the same exit 13', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'bound', bindingHidden: true };
    const result = await starter([], {}, withOrg);
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('is already set up; run again with --skip-setup');
    expect(apiRequests()).toEqual([`GET /v1/agents/${COO_AGENT}`, 'POST /v1/approvals']);
    expect(world.agents).toEqual([]);
  });

  it('a principal held by another agent is the same exit 13', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'declared', holder: AGENT_ID };
    const result = await starter([], {}, withOrg);
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('is already set up; run again with --skip-setup');
    expect(world.agents).toEqual([]);
  });

  it('an administrator’s rejection of the browser proposal is exit 13 naming it, with no fallback agent', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'declared', rejectedDuplicate: 'ap_rejected_9' };
    const result = await starter([], {}, withOrg);
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('ap_rejected_9');
    expect(result.stderr).toContain('Create new credentials');
    expect(world.agents).toEqual([]);
    expect(apiRequests()).toEqual([`GET /v1/agents/${COO_AGENT}`, 'POST /v1/approvals']);
    expect(world.opened).toEqual([]);
    expect(world.runs).toBe(0);
  });

  it('a rejected_duplicate that names no approval still says to create new credentials', async () => {
    world.refuse.setupOpen = { status: 409, type: 'rejected_duplicate' };
    const result = await starter([], {}, withOrg);
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('an earlier approval');
    expect(result.stderr).toContain('Create new credentials');
  });

  it('a continuation_conflict says an open proposal has another continuation, and exits 13', async () => {
    world.refuse.setupOpen = { status: 409, type: 'continuation_conflict' };
    const result = await starter([], {}, withOrg);
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('different continuation');
    expect(result.stderr).toContain('continuation_conflict');
  });

  it('a credential whose org_id is not a UUID takes the fallback and never derives an agent', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'bound' };
    const bad = await writeCredential(stub, dir, { orgId: 'not-a-uuid', name: 'sp-bad-org.json' });
    const result = await starter([], {}, bad);
    expect(result.code, result.stderr).toBe(0);
    expect(apiRequests().slice(0, 2)).toEqual(['POST /v1/agents', 'POST /v1/approvals']);
    expect(world.agents).toEqual(['NobleCloak starter']);
  });

  it('a credential without org_id declares its agent first, as before', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'declared', browser: { proposer: 'user' } };
    const noOrg = await writeCredential(stub, dir, { name: 'sp-credential-no-org.json' });
    const result = await starter([], {}, noOrg);
    expect(result.code, result.stderr).toBe(0);
    expect(apiRequests().slice(0, 2)).toEqual(['POST /v1/agents', 'POST /v1/approvals']);
    expect(world.opened.map((o) => o.id)).toEqual([SETUP_APPROVAL, WRITE_APPROVAL]);
  });

  it('--agent skips the lookup and proposes for that agent', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'declared', browser: { proposer: 'user' } };
    const result = await starter(['--agent', AGENT_ID], {}, withOrg);
    expect(result.code, result.stderr).toBe(0);
    expect(world.agents).toEqual([]);
    expect(apiRequests()[0]).toBe('POST /v1/approvals');
    expect(
      (world.opened[0]?.body.action as { arguments: { agent: { id: string } } }).arguments.agent.id
    ).toBe(AGENT_ID);
  });

  it('a reused proposal that coo refuses policy_conflict when approved (the setup was applied meanwhile) is the already-set-up message', async () => {
    world.coo = { agentId: COO_AGENT, agent: 'declared', browser: { proposer: 'user' } };
    world.rejectionReason = 'proposal_refused:policy_conflict';
    world.decisions.setup = 'rejected';
    const result = await starter([], {}, withOrg);
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('is already set up; run again with --skip-setup');
    expect(world.runs).toBe(0);
  });

  it('an own agent’s policy_conflict is not called already-set-up: it names the refusal', async () => {
    world.refuse.setupOpen = { status: 422, type: 'proposal_refused', code: 'policy_conflict' };
    const result = await starter([], {}, withOrg);
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('proposal_refused:policy_conflict');
  });
});
