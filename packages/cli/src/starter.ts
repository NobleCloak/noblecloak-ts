import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  GovernanceApi,
  ModuleApiError,
  type Answer,
  type Approval,
  type ApprovalHandle,
  type PolicySetProposal,
  type Problem,
} from '@noblecloak/client/governance-api';
import {
  CREDENTIAL_ENV,
  ServicePrincipalError,
  loadServicePrincipalCredential,
  servicePrincipalTokenSource,
  type ServicePrincipalCredential,
  type ServicePrincipalTokenSource,
} from '@noblecloak/client/service-principal';
import { interrupted, interruptedError, REQUEST_TIMEOUT_MS } from './abortable.js';
import { boolFlag, stringFlag, type ParsedFlags } from './args.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import { callTool, type ToolOutcome } from './mcp.js';
import {
  deploymentOfCredential,
  resolveStarterHosts,
  type StarterHosts,
} from './starter-config.js';
import { setupAgentId, setupContinuation } from './setup-agent-id.js';
import { oneLine, jsonForTerminal } from './terminal.js';
import { withTargetSession } from './session.js';

/**
 * The sandbox's write tool, as bianoble-coo bdaafbdc registers it
 * (packages/integrations/sandbox/src/tools.ts:137-143): `toolScope` is the reference an approval names
 * and a grant grants, `name` is the MCP tool name the gateway lists. A native system row: `GET /v1/tools`
 * does not list it, so the reference is fixed here. Arguments: `title` 1 to 120 characters and `body` 1 to
 * 1000, no other member.
 */
export const SANDBOX_TOOL_REF = 'tool:sandbox:create-note';
export const SANDBOX_MCP_TOOL = 'int_sandbox_create_note';

/** The reference of the setup proposal (module API capabilities.ts:12 in bianoble-coo bdaafbdc). */
const PROPOSE_POLICY_SET_REF = 'tool:noblecloak:propose-policy-set';

const AGENT_NAME = 'NobleCloak starter';
const NOTE = {
  title: 'Hello from the NobleCloak starter',
  body: 'One governed write: a person decided it in Approvals before it ran.',
} as const;

/**
 * The setup proposal's continuation: `mcp_held`/`held`, the one this repo's docs give a `propose-policy-set`
 * (docs/how-to/propose-a-policy-set.md, "because nothing resumes after the change is made"; also bianoble-coo
 * packages/services/obligations/src/continuation.ts:13, `DEFAULT_CONTINUATION`).
 */
const SETUP_CONTINUATION = { kind: 'mcp_held', delivery: 'held' } as const;

/**
 * The write approval's continuation: `langgraph`/`pull`, the value bianoble-coo's own test of a service
 * principal's first sandbox write uses for `tool:sandbox:create-note` (origin/main 8188a21a
 * apps/api/src/__tests__/integration/module-api-sandbox-e2e.test.ts:60, used at 204 and 342). That test sends it
 * to `POST /v1/decisions`; this command sends it to `POST /v1/approvals`. This command
 * does not pull a resumption: it reads the approval's state itself and makes the gateway call. The gateway's
 * admission (packages/services/mcp-server/src, same ref) does not read `delivery`.
 */
const WRITE_CONTINUATION = { kind: 'langgraph', delivery: 'pull' } as const;

/**
 * The start of the `detail` coo gives a 422 `approval_unroutable` whose reason is `route_mismatch`
 * (bianoble-coo e62bb0c7 packages/services/module-api/src/approvals.ts UNROUTABLE_DETAIL; opened by
 * apps/api/src/obligations-port.ts:876-893 for a principal the gateway does not route the tool to).
 */
const ROUTE_MISMATCH_DETAIL = 'the gateway routes this tool_ref for this principal';

/** What a `proposal_refused:principal_bound` means to the person running the command. */
const ALREADY_SET_UP = 'This service principal is already set up; run again with --skip-setup.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_WAIT_SECONDS = 600;

/**
 * How long the person's access token is used for the setup wait: an access token lasts 900 seconds
 * (bianoble-core a3b1ad0 packages/auth-server/src/token-endpoint.ts:85, `ACCESS_TOKEN_TTL_SECONDS`) and this
 * command keeps no refresh path, so a longer wait would end in a 401 while the approval is still valid. The
 * margin covers the time between the token's issue and this command's clock.
 */
export const SETUP_TOKEN_WINDOW_SECONDS = 840;

/** The setup wait: `requested`, cut to what is left of the token's window after `elapsedMs` of use. */
export function setupWaitSeconds(requested: number, elapsedMs: number): number {
  const left = SETUP_TOKEN_WINDOW_SECONDS - Math.floor(elapsedMs / 1000);
  return Math.max(1, Math.min(requested, left));
}
/** The server holds a poll at most 55 seconds (`GET /v1/approvals/{id}/wait`). */
const LONG_POLL_SECONDS = 55;

const TERMINAL: ReadonlySet<string> = new Set(['consumed', 'rejected', 'expired', 'withdrawn']);

/** The `sp create` command that makes a principal this command can use. */
const spCreateHint = (hosts: StarterHosts): string =>
  `noblecloak sp create --org <uuid> --name <name> --audience ${hosts.governUrl} --audience ${hosts.gatewayAudience} --out <path>`;

const note = (io: Io, line: string): void => {
  io.stderr(`${line}\n`);
};

/** "1 second", "2 seconds". */
const secondsText = (n: number): string => `${String(n)} ${n === 1 ? 'second' : 'seconds'}`;

/**
 * What the terminal says once an approval is open, in three lines: where to decide it (the Approvals URL
 * when `hosts` names the deployment's app, else the line as it was), what the request is called there (the
 * Approvals list titles a row by its tool reference), and that this command waits, for how long, and how to
 * stop. `opened` is the first line without its closing period.
 */
export function nextStepLines(
  hosts: StarterHosts,
  step: { opened: string; toolRef: string; decide: string; seconds: number }
): string[] {
  const where = hosts.appUrl === undefined ? '.' : `: ${hosts.appUrl}/approvals`;
  return [
    `${step.opened}${where}`,
    `In Approvals it is the request for ${step.toolRef}.`,
    `This command waits up to ${secondsText(step.seconds)} for you to ${step.decide}. Press Ctrl-C to stop; the request stays open.`,
  ];
}

function waitSeconds(flags: ParsedFlags): number {
  const raw = stringFlag(flags, 'wait');
  if (raw === undefined) return DEFAULT_WAIT_SECONDS;
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || seconds < 1 || seconds > 3600) {
    throw new CliError(EXIT.usage, '--wait must be a whole number of seconds from 1 to 3600.');
  }
  return seconds;
}

function agentFlag(flags: ParsedFlags): string | undefined {
  if (flags.agent === undefined) return undefined;
  const value = stringFlag(flags, 'agent')?.trim();
  if (value === undefined || value === '' || value.length > 200) {
    throw new CliError(EXIT.usage, '--agent must be an agent id of 1 to 200 characters.');
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------
// The service principal's credential and tokens
// ---------------------------------------------------------------------------------------------------

/** The `audiences` the CLI wrote into the credential file, when the file has them; undefined otherwise. */
async function declaredAudiences(source: string): Promise<string[] | undefined> {
  try {
    const raw = source.trim().startsWith('{') ? source : await readFile(resolve(source), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const audiences = (parsed as { audiences?: unknown }).audiences;
    return Array.isArray(audiences) && audiences.every((a) => typeof a === 'string')
      ? audiences
      : undefined;
  } catch {
    return undefined;
  }
}

const bare = (url: string): string => url.replace(/\/+$/, '');

function audienceMissing(hosts: StarterHosts, names: string[]): CliError {
  return new CliError(
    EXIT.audienceMissing,
    `The service principal may not ask for a token for ${names.join(' or ')}. Create one with both audiences:\n  ${spCreateHint(hosts)}`
  );
}

/**
 * A credential that belongs to the other deployment (by its declared audiences, or by the origin of its
 * token endpoint), as the exit that says which `--deployment` to pass. Needs no request.
 */
function wrongDeployment(
  hosts: StarterHosts,
  credential: ServicePrincipalCredential,
  declared: string[] | undefined
): CliError | undefined {
  const other = deploymentOfCredential(hosts, {
    tokenEndpoint: credential.token_endpoint,
    audiences: declared,
  });
  return other === undefined
    ? undefined
    : new CliError(
        EXIT.audienceMissing,
        `This credential is for the ${other} deployment, not the one these hosts name: run with --deployment ${other}.`
      );
}

/**
 * Reads the credential and, when the file lists its audiences, checks before any sign-in or approval that
 * they cover both. A file that does not list them is checked by {@link checkedTokens} instead.
 */
async function loadCredential(
  flags: ParsedFlags,
  io: Io,
  hosts: StarterHosts
): Promise<ServicePrincipalCredential> {
  const source = stringFlag(flags, 'credentials') ?? io.env[CREDENTIAL_ENV];
  if (source === undefined || source.trim() === '') {
    throw new CliError(
      EXIT.noCredentials,
      `No service-principal credential: pass --credentials <path> or set ${CREDENTIAL_ENV}. Create one with:\n  ${spCreateHint(hosts)}`
    );
  }
  let credential: ServicePrincipalCredential;
  try {
    credential = await loadServicePrincipalCredential(source, { env: io.env });
  } catch (error) {
    if (error instanceof ServicePrincipalError) {
      // The loader's message names a field or where the credential came from, never a value.
      throw new CliError(EXIT.usage, error.message);
    }
    throw error;
  }
  const declared = await declaredAudiences(source);
  const wrong = wrongDeployment(hosts, credential, declared);
  if (wrong !== undefined) throw wrong;
  if (declared !== undefined) {
    const held = new Set(declared.map(bare));
    const missing = [hosts.governUrl, hosts.gatewayAudience].filter((a) => !held.has(a));
    if (missing.length > 0) throw audienceMissing(hosts, missing);
  }
  return credential;
}

interface SpTokens {
  readonly govern: ServicePrincipalTokenSource;
  readonly gateway: ServicePrincipalTokenSource;
}

/** A token-source failure as the exit the starter reports. `resource` names the audience being asked for. */
function spTokenError(
  error: ServicePrincipalError,
  hosts: StarterHosts,
  resource: string
): CliError {
  if (error.code === 'invalid_client') {
    return new CliError(
      EXIT.unauthenticated,
      'Not signed in: the token endpoint rejected the service principal (revoked, expired, an unregistered key, or a clock more than 60 seconds off).'
    );
  }
  if (error.code === 'token_request_rejected' && error.oauthError === 'invalid_target') {
    return audienceMissing(hosts, [resource]);
  }
  return new CliError(EXIT.failed, `Cannot get a service-principal token: ${error.message}`);
}

/**
 * Mints both of the principal's tokens before anything is opened, so a principal that lacks an audience, a
 * key or a working clock fails here and not while a person waits on an approval.
 */
async function checkedTokens(
  credential: ServicePrincipalCredential,
  io: Io,
  hosts: StarterHosts
): Promise<SpTokens> {
  const tokens: SpTokens = {
    govern: servicePrincipalTokenSource(credential, { audience: hosts.governUrl, fetch: io.fetch }),
    gateway: servicePrincipalTokenSource(credential, {
      audience: hosts.gatewayAudience,
      fetch: io.fetch,
    }),
  };
  for (const [source, resource] of [
    [tokens.govern, hosts.governUrl],
    [tokens.gateway, hosts.gatewayAudience],
  ] as const) {
    try {
      await source.getToken();
    } catch (error) {
      if (error instanceof ServicePrincipalError) throw spTokenError(error, hosts, resource);
      throw error;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------------
// The governance API, as a person and as the principal
// ---------------------------------------------------------------------------------------------------

/** Every request carries the interrupt and a timeout. A long poll gets the server's hold plus a margin. */
function fetchWithin(io: Io, timeoutMs: number): typeof fetch {
  return (input, init) =>
    io.fetch(input, {
      ...init,
      signal: AbortSignal.any([io.signal, AbortSignal.timeout(timeoutMs)]),
    });
}

interface Apis {
  readonly api: GovernanceApi;
  /** For `waitApproval`: its timeout covers a full long poll. */
  readonly pollApi: GovernanceApi;
}

function apisFor(io: Io, governUrl: string, getToken: () => string | Promise<string>): Apis {
  const make = (timeoutMs: number): GovernanceApi =>
    new GovernanceApi({
      baseUrl: governUrl,
      getToken,
      fetch: fetchWithin(io, timeoutMs),
      isPassThrough: (error) => error instanceof ServicePrincipalError,
    });
  return {
    api: make(io.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
    pollApi: make((io.requestTimeoutMs ?? REQUEST_TIMEOUT_MS) + LONG_POLL_SECONDS * 1000),
  };
}

type ProblemMap = (problem: Problem) => CliError | undefined;

/**
 * Runs one governance call and returns its data, or throws the CliError that says what happened: an
 * interrupt (3), a refusal the caller maps itself, 401 (3), 403 (4), or anything else (1).
 */
async function governed<T>(
  io: Io,
  hosts: StarterHosts,
  what: string,
  operation: () => Promise<Answer<T>>,
  mapProblem: ProblemMap = () => undefined
): Promise<T> {
  let answer: Answer<T>;
  try {
    answer = await operation();
  } catch (error) {
    if (interrupted(io)) throw interruptedError(`${what} was not completed.`);
    if (error instanceof ServicePrincipalError) throw spTokenError(error, hosts, hosts.governUrl);
    if (error instanceof ModuleApiError) {
      // The message says which: `/v1 could not be reached: <cause>`, `/v1 answered 503`, or no data member.
      throw new CliError(EXIT.failed, `Cannot ${what}: ${oneLine(error.message)}.`);
    }
    throw error;
  }
  if (answer.ok) return answer.data;
  const { problem } = answer;
  const mapped = mapProblem(problem);
  if (mapped !== undefined) throw mapped;
  const reason = `${String(problem.status)} ${problem.code}${problem.detail === undefined ? '' : `: ${oneLine(problem.detail)}`}`;
  if (problem.status === 401) {
    throw new CliError(
      EXIT.unauthenticated,
      `Not signed in: the governance API refused to ${what} (${reason}).`
    );
  }
  if (problem.status === 403) {
    throw new CliError(EXIT.forbidden, `Not allowed to ${what} (${reason}).`);
  }
  throw new CliError(EXIT.failed, `Could not ${what} (${reason}).`);
}

const sleep = (io: Io, ms: number): Promise<void> =>
  new Promise((done) => {
    const timer = setTimeout(done, ms);
    io.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true }
    );
  });

/**
 * Long-polls an approval until `settled` accepts its state, or the deadline passes (exit 15). A poll that
 * comes back pending sooner than `io.pollFloorMs` is followed by a pause, so a server that answers at once
 * is polled once a second, not in a loop.
 */
async function awaitApproval(
  io: Io,
  hosts: StarterHosts,
  apis: Apis,
  id: string,
  what: string,
  seconds: number,
  settled: (approval: Approval) => boolean,
  again: string
): Promise<Approval> {
  const deadline = Date.now() + seconds * 1000;
  const shown = oneLine(id);
  const floor = io.pollFloorMs ?? 1000;
  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) {
      throw new CliError(
        EXIT.timeout,
        `Nobody decided ${what} (approval ${shown}) within ${secondsText(seconds)}. It stays open: decide it in Approvals, then ${again}.`
      );
    }
    const started = Date.now();
    let approval: Approval;
    const cut = { read: false };
    try {
      approval = await governed(io, hosts, `wait for ${what}`, async () => {
        try {
          return await apis.pollApi.waitApproval(id, Math.min(LONG_POLL_SECONDS, remaining));
        } catch (error) {
          cut.read = error instanceof ModuleApiError;
          throw error;
        }
      });
    } catch (error) {
      // A poll is a read: one the network or a 5xx cut is repeated until the deadline. Once the deadline is
      // near, the exit 1 says the approval is still open.
      if (!cut.read || !(error instanceof CliError) || interrupted(io)) throw error;
      if (Date.now() + floor >= deadline) {
        throw new CliError(
          EXIT.failed,
          `${error.message} The approval for ${what} (approval ${shown}) is still open: decide it in Approvals, then ${again}.`
        );
      }
      await sleep(io, floor);
      continue;
    }
    if (approval.state === 'expired') {
      throw new CliError(EXIT.timeout, `The approval for ${what} expired (approval ${shown}).`);
    }
    if (settled(approval)) return approval;
    const spent = Date.now() - started;
    if (spent < floor) await sleep(io, floor - spent);
    if (interrupted(io)) throw interruptedError(`${what} is still open (approval ${shown}).`);
  }
}

/** The last reason the history gives, e.g. `proposal_refused:policy_conflict`, for a message. */
function lastReason(approval: Approval): string {
  const reason = approval.resolution_history?.at(-1)?.reason;
  return reason === undefined || reason === '' ? '' : ` (${oneLine(reason)})`;
}

// ---------------------------------------------------------------------------------------------------
// The two steps
// ---------------------------------------------------------------------------------------------------

/** The setup: the agent, bound to the principal and granted the sandbox tool, as one proposal. */
function proposalFor(agentId: string, principalId: string): PolicySetProposal {
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
          targets: { tools: [SANDBOX_TOOL_REF] },
          config: { mode: 'ask' },
        },
      },
    ],
    tool_grants: [SANDBOX_TOOL_REF],
  };
}

interface Setup {
  readonly agentId: string;
  readonly approvalId: string;
}

/** The deployment has no agent under the id it was asked to set up (`proposal_refused:unknown_agent`). */
class SetupAgentAbsent extends CliError {
  constructor() {
    super(
      EXIT.proposalRejected,
      'The setup agent is not declared (proposal_refused:unknown_agent).'
    );
    this.name = 'SetupAgentAbsent';
  }
}

/**
 * The CliError for a refusal of the open of the setup proposal. `derived`: the agent is the one coo declares
 * for the principal ({@link setupAgentId}). There an `unknown_agent` refusal is the {@link SetupAgentAbsent}
 * the caller recovers from, not an exit, and a `policy_conflict` is a setup already applied (the holder is
 * that agent, so coo's `principal_bound` check, apps/api/src/policy-set-checks.ts, never fires for it).
 */
function mapOpenProblem(problem: Problem, derived: boolean): CliError | undefined {
  const refused = problem.status === 422 && problem.code === 'proposal_refused';
  if (refused && problem.refusalCode === 'unknown_agent' && derived) {
    return new SetupAgentAbsent();
  }
  if (refused && problem.refusalCode === 'policy_conflict' && derived) {
    return new CliError(EXIT.proposalRejected, ALREADY_SET_UP);
  }
  if (problem.status === 409 && problem.code === 'rejected_duplicate') {
    // coo's rejected-duplicate rule (module-api approvals.ts answers it with `rejected_approval_id`): an
    // administrator rejected this exact proposal, so an identical open is refused. Opening it under another
    // agent would get around that rejection, so this is an exit, not a fallback.
    const which =
      problem.rejectedApprovalId === undefined
        ? 'an earlier approval'
        : `approval ${oneLine(problem.rejectedApprovalId)}`;
    return new CliError(
      EXIT.proposalRejected,
      `An administrator already rejected this setup (${which}), and the deployment does not open it again. Create new credentials to propose it afresh (rejected_duplicate).`
    );
  }
  if (problem.status === 409 && problem.code === 'continuation_conflict') {
    return new CliError(
      EXIT.proposalRejected,
      'The deployment already has an open setup proposal for this agent, opened with a different continuation, so this one was not opened (continuation_conflict). Withdraw or decide that proposal in Approvals, then run again.'
    );
  }
  if (refused && problem.refusalCode === 'target_unknown') {
    // The proposal names only SANDBOX_TOOL_REF (a policy target and a grant), so coo's
    // target_unknown (policy-set-checks.ts:256-290, bianoble-coo e62bb0c7) means the row is absent.
    return new CliError(
      EXIT.sandboxUnavailable,
      `The sandbox is not available here: the deployment has no ${SANDBOX_TOOL_REF} to grant (proposal_refused:target_unknown).`
    );
  }
  if (refused && problem.refusalCode === 'principal_bound') {
    return new CliError(EXIT.proposalRejected, ALREADY_SET_UP);
  }
  if (problem.status === 422) {
    return new CliError(
      EXIT.proposalRejected,
      `The deployment refused the setup proposal (${problem.code}${problem.refusalCode === undefined ? '' : `:${oneLine(problem.refusalCode)}`}${problem.detail === undefined ? '' : `: ${oneLine(problem.detail)}`}).`
    );
  }
  return undefined;
}

/**
 * As the person: open the setup proposal and wait for an administrator to approve it in Approvals. The
 * agent is the one `--agent` names; else, when the credential has an `org_id` that is a UUID, the agent coo
 * declares for a principal created in the browser (`setupAgentId`), read first with `GET /v1/agents/{id}`:
 *  - absent: the agent this command declares, as for a credential without an `org_id`;
 *  - bound to this principal (its setup is applied): exit 13, `ALREADY_SET_UP`, nothing opened;
 *  - else: the proposal is opened with the continuation coo stores on the one it opened for that browser
 *    create ({@link setupContinuation}). coo answers `created: false` with that approval only for the same
 *    proposer (the admin who created the principal in the browser), the same arguments and the same
 *    continuation. Another admin gets a second proposal, and whichever is approved second fails
 *    `policy_conflict`. `noblecloak sp create` has no such proposal: coo opens none for it.
 * The person's token is used here and nowhere else.
 */
async function setUp(
  io: Io,
  hosts: StarterHosts,
  flags: ParsedFlags,
  principalId: string,
  orgId: string | undefined,
  seconds: number
): Promise<Setup> {
  const options = {
    userTokenFile: stringFlag(flags, 'user-token-file'),
    open: !boolFlag(flags, 'no-open'),
  };
  const target = { resource: hosts.governUrl, scope: undefined, requiredScope: undefined };
  return withTargetSession(io, hosts, target, options, async (token) => {
    const startedAt = Date.now();
    const apis = apisFor(io, hosts.governUrl, () => token);
    const openSetup = (agent: string, derived: boolean): Promise<ApprovalHandle> =>
      governed(
        io,
        hosts,
        'open the setup proposal',
        () =>
          apis.api.createApproval(
            {
              action: {
                tool_ref: PROPOSE_POLICY_SET_REF,
                arguments: proposalFor(agent, principalId),
              },
              continuation: derived ? setupContinuation(principalId) : SETUP_CONTINUATION,
            },
            randomUUID()
          ),
        (problem) => mapOpenProblem(problem, derived)
      );
    const named = agentFlag(flags);
    let opened: { agentId: string; handle: ApprovalHandle; derived: boolean } | undefined;
    if (named === undefined && orgId !== undefined && UUID.test(orgId)) {
      const derivedId = setupAgentId(orgId, principalId);
      try {
        // Read the agent first: an open is no probe (a re-run after the browser setup was approved would
        // open a redundant proposal that fails policy_conflict when approved).
        const agent = await governed(
          io,
          hosts,
          'read the setup agent',
          () => apis.api.getAgent(derivedId),
          (problem) => (problem.status === 404 ? new SetupAgentAbsent() : undefined)
        );
        if (agent.principal_id?.toLowerCase() === principalId) {
          throw new CliError(EXIT.proposalRejected, ALREADY_SET_UP);
        }
        opened = { agentId: derivedId, handle: await openSetup(derivedId, true), derived: true };
      } catch (error) {
        if (!(error instanceof SetupAgentAbsent)) throw error;
      }
    }
    if (opened === undefined) {
      let agentId: string;
      if (named === undefined) {
        const agent = await governed(io, hosts, 'create the agent', () =>
          apis.api.createAgent(AGENT_NAME, randomUUID())
        );
        agentId = agent.id;
        note(
          io,
          `Agent ${oneLine(agentId)} created. If its setup is not applied, retry the setup with --agent ${oneLine(agentId)}; once it is applied, make another write with --skip-setup.`
        );
      } else {
        agentId = named;
        note(
          io,
          `Using agent ${oneLine(agentId)}. A setup already applied for it is refused with proposal_refused:policy_conflict; use --skip-setup for another write.`
        );
      }
      opened = { agentId, handle: await openSetup(agentId, false), derived: false };
    }
    const { agentId, handle, derived } = opened;
    const waitFor = setupWaitSeconds(seconds, Date.now() - startedAt);
    for (const line of nextStepLines(hosts, {
      opened: handle.created
        ? `Setup proposed (approval ${oneLine(handle.id)}). Approve it in Approvals`
        : `Setup already open (approval ${oneLine(handle.id)}); not opening another. Approve it in Approvals`,
      toolRef: PROPOSE_POLICY_SET_REF,
      decide: 'approve it',
      seconds: waitFor,
    })) {
      note(io, line);
    }
    if (waitFor < seconds) {
      note(
        io,
        `Waiting ${secondsText(waitFor)} for the setup, not ${String(seconds)}: your access token lasts 15 minutes. If it is approved later, run again with --skip-setup.`
      );
    }
    const approval = await awaitApproval(
      io,
      hosts,
      apis,
      handle.id,
      'the setup',
      waitFor,
      (a) => TERMINAL.has(a.state),
      'make the write with --skip-setup'
    );
    if (approval.state !== 'consumed') {
      const reason = lastReason(approval);
      if (
        reason.includes('proposal_refused:principal_bound') ||
        (derived && reason.includes('proposal_refused:policy_conflict'))
      ) {
        throw new CliError(EXIT.proposalRejected, ALREADY_SET_UP);
      }
      throw new CliError(
        EXIT.proposalRejected,
        `The setup was not applied: the approval is ${approval.state}${lastReason(approval)}. Nothing changed; fix what refused it and run again.`
      );
    }
    note(io, 'Setup approved.');
    return { agentId, approvalId: handle.id };
  });
}

interface Written {
  readonly runId: string;
  readonly approvalId: string;
  readonly text: string;
}

/**
 * As the service principal: an external run, the approval for the exact note, and, only if a person
 * approved it, the one gateway call that carries it out.
 */
async function writeNote(
  io: Io,
  hosts: StarterHosts,
  tokens: SpTokens,
  seconds: number
): Promise<Written> {
  const apis = apisFor(io, hosts.governUrl, tokens.govern.getToken);
  const run = await governed(io, hosts, 'create the run', () => apis.api.createRun(randomUUID()));
  const handle = await governed(
    io,
    hosts,
    'open the write approval',
    () =>
      apis.api.createApproval(
        {
          action: { tool_ref: SANDBOX_TOOL_REF, arguments: { ...NOTE } },
          continuation: WRITE_CONTINUATION,
          run_id: run.id,
        },
        randomUUID()
      ),
    (problem) =>
      problem.status === 409 && problem.code === 'rejected_duplicate'
        ? new CliError(
            EXIT.writeDenied,
            'The same write was refused a short while ago, so the deployment will not open it again yet. Nothing was written; wait for its duplicate-request window to pass, then run again.'
          )
        : problem.status === 422 &&
            problem.code === 'approval_unroutable' &&
            problem.detail?.startsWith(ROUTE_MISMATCH_DETAIL) === true
          ? new CliError(
              EXIT.proposalRejected,
              `The principal is not granted ${SANDBOX_TOOL_REF}, so the deployment cannot route its approval. Nothing was written. If you used --skip-setup, run without it so the setup grants the tool.`
            )
          : problem.status === 422 && problem.code === 'approval_unroutable'
            ? new CliError(
                EXIT.sandboxUnavailable,
                `The sandbox is not available here: the deployment cannot route an approval for ${SANDBOX_TOOL_REF}${problem.detail === undefined ? '' : ` (${oneLine(problem.detail)})`}.`
              )
            : undefined
  );
  for (const line of nextStepLines(hosts, {
    opened: `Write requested (approval ${oneLine(handle.id)}). Approve or deny it in Approvals`,
    toolRef: SANDBOX_TOOL_REF,
    decide: 'decide it',
    seconds,
  })) {
    note(io, line);
  }
  const approval = await awaitApproval(
    io,
    hosts,
    apis,
    handle.id,
    'the write',
    seconds,
    (a) => a.state === 'approved' || TERMINAL.has(a.state),
    'run again'
  );
  if (approval.state === 'consumed') {
    throw new CliError(
      EXIT.replay,
      `The approval for the write was already used (approval ${oneLine(handle.id)}). Run again to ask for a new one.`
    );
  }
  if (approval.state !== 'approved') {
    throw new CliError(
      EXIT.writeDenied,
      `The write was not approved: the approval is ${approval.state}${lastReason(approval)}. Nothing was written.`
    );
  }
  const outcome = await callTool(io, {
    url: `${hosts.mcpUrl}/v1/mcp`,
    token: await tokens.gateway.getToken().catch((error: unknown) => {
      if (error instanceof ServicePrincipalError) {
        throw spTokenError(error, hosts, hosts.gatewayAudience);
      }
      throw error;
    }),
    runId: run.id,
    name: SANDBOX_MCP_TOOL,
    arguments: { ...NOTE },
  });
  return { runId: run.id, approvalId: handle.id, text: resultText(outcome) };
}

/** The text of a call that ran, or the CliError for one the gateway refused or the tool failed. */
function resultText(outcome: ToolOutcome): string {
  if (outcome.kind === 'result') {
    if (outcome.isError) {
      throw new CliError(
        EXIT.failed,
        `The sandbox tool reported an error${outcome.text === '' ? '' : `: ${oneLine(outcome.text).slice(0, 200)}`}.`
      );
    }
    return oneLine(outcome.text).slice(0, 200);
  }
  const reason = `${String(outcome.status)}${outcome.code === '' ? '' : ` ${outcome.code}`}${outcome.message === '' ? '' : `: ${oneLine(outcome.message)}`}`;
  if (outcome.code === 'obligation_already_consumed') {
    throw new CliError(
      EXIT.replay,
      `The approval was already used by an earlier call (${reason}). Run again to ask for a new one.`
    );
  }
  if (outcome.status === 401) {
    throw new CliError(
      EXIT.unauthenticated,
      `Not signed in: the MCP gateway refused the token (${reason}).`
    );
  }
  if (outcome.status === 404) {
    // coo's route check does not always refuse an ungranted principal's approval at open, so the write is
    // approved and then the gateway answers 404 for a tool it does not route to this principal.
    throw new CliError(
      EXIT.proposalRejected,
      `The gateway does not route ${SANDBOX_MCP_TOOL} to this principal (${reason}); nothing was written. The principal may not be granted ${SANDBOX_TOOL_REF}: if you used --skip-setup, run without it so the setup grants the tool.`
    );
  }
  if (outcome.status === 403 || outcome.status === 409) {
    throw new CliError(
      EXIT.writeDenied,
      `The gateway refused the write; nothing was written (${reason}).`
    );
  }
  throw new CliError(EXIT.failed, `The MCP gateway answered ${reason}.`);
}

// ---------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------

/**
 * `noblecloak starter`: as the person who signs in, it proposes the setup of an agent for the service
 * principal (a person approves it in Approvals); then, as the principal, it makes one governed write to
 * the sandbox (a person decides it in Approvals). No model, no key but the principal's.
 */
export async function starterCommand(flags: ParsedFlags, io: Io): Promise<void> {
  const skipSetup = boolFlag(flags, 'skip-setup');
  if (skipSetup && (flags.agent !== undefined || flags['user-token-file'] !== undefined)) {
    throw new CliError(
      EXIT.usage,
      '--skip-setup runs the write only: it takes neither --agent nor --user-token-file.'
    );
  }
  const seconds = waitSeconds(flags);
  agentFlag(flags);
  const hosts = resolveStarterHosts(flags, io);
  const credential = await loadCredential(flags, io, hosts);
  const tokens = await checkedTokens(credential, io, hosts);
  note(io, 'Credential checked.');

  const setup = skipSetup
    ? undefined
    : await setUp(
        io,
        hosts,
        flags,
        // Lower-cased once: coo lower-cases the principal id in the agent id and in the proposal's digest.
        credential.client_id.slice('sp_'.length).toLowerCase(),
        credential.org_id,
        seconds
      );
  const written = await writeNote(io, hosts, tokens, seconds);

  if (boolFlag(flags, 'json')) {
    io.stdout(
      `${jsonForTerminal({
        agent_id: setup?.agentId ?? null,
        setup_approval_id: setup?.approvalId ?? null,
        run_id: written.runId,
        write_approval_id: written.approvalId,
        outcome: 'written',
        result: written.text,
      })}\n`
    );
    return;
  }
  io.stdout(
    `Wrote one note to the sandbox (approval ${oneLine(written.approvalId)}).${written.text === '' ? '' : ` ${written.text}`}\n`
  );
}
