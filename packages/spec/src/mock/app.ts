/**
 * The mock server: Hono over in-memory state seeded with fixtures. It serves the document so modules
 * and adapters can build before the facade exists. It is NOT a reference
 * implementation of policy: its `decide` is a fixture lookup, `mode` on a tool row, except for a call that a
 * published policy carrying rev 16 members (`rules`, `approvers`, `exclude`) matches, which it decides by composing
 * the matching policies (see `ruledDecision`).
 *
 * Request bodies are validated against the document's own schemas, so a client that drifts from the
 * contract fails here the way it would against the real thing.
 */
import { argDigest, jcs } from '@noblecloak/client';
import type { JsonValue } from '@noblecloak/client';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';

import { MockIssuer } from './auth.js';
import type { Principal } from './auth.js';
import type { Break } from './breaks.js';
import {
  isExactRegisteredOrigin,
  markOriginRefused,
  mockCors,
  parseAllowedOrigins,
} from './cors.js';
import { callbackProblem } from './guard.js';
import { generateSigningKey, jwksOf, signJws } from './jws.js';
import type { SigningKey } from './jws.js';
import {
  ARGUMENTS_AT,
  DEPLOYMENT_APPLIED_PREFIX,
  PROPOSAL_MEMBERS,
  PROPOSAL_SCHEMA,
  PROPOSE_POLICY_SET,
  ROLE_SUBJECTS_ENTITLEMENT,
  ROW_KINDS,
  isDeploymentApplied,
  ruleRefusal,
  schemaRefusal,
  targetOf,
  tightnessOfDecision,
  tightnessOfMode,
} from './proposal.js';
import type { Proposal, ProposalsServed, Refusal, RowKind } from './proposal.js';
import { approversInForce, pathSegments, readFacts, refusedCondition, walkRules } from './rules.js';
import type {
  Approver,
  ApproverRef,
  Condition,
  FactBindings,
  FactType,
  RuleConfig,
  WalkResult,
} from './rules.js';
import { MockState, PROBLEM_BASE, linkKey, toolKey, without } from './store.js';
import type {
  Continuation,
  Env,
  LinkRow,
  MockConfig,
  Obj,
  Obligation,
  PolicyVersion,
  RecordRow,
  Requirement,
  ToolRow,
} from './store.js';
import { loadDocument } from '../spec/default.js';
import { FAMILIES, FLOOR_NAMES, isFamily } from '../spec/families.js';
import type { Family } from '../spec/families.js';
import {
  GATEWAY_HEADER_PREFIX,
  ORGANIZATION_HEADER,
  PERMISSIONS_HEADER,
  REJECTED_IDENTITY_HEADERS,
  SCOPES_HEADER,
  gatewayHeader,
  isRejectedIdentityHeader,
} from '../spec/gateway-header.js';
import type { JsonObject } from '../spec/load.js';
import { SpecIndex, describeErrors } from '../spec/validate.js';
import type { OperationInfo } from '../spec/validate.js';

export interface MockOptions {
  readonly deployment?: 'hosted' | 'edge';
  readonly breaks?: ReadonlySet<Break>;
  /** The token audience: the API's own URI. */
  readonly audience?: string;
  /** How long an approval stays open before it expires. */
  readonly expireAfterMs?: number;
  /** Serve `/__mock/*` (clock control and tokens). Off for anything but a local mock. */
  readonly control?: boolean;
  /** The document the mock implements. Defaults to the published one (`dist/openapi.public.yaml`). */
  readonly spec?: JsonObject;
  /**
   * The route families to serve and advertise on `GET /v1/capabilities`, with the floor (`decisions`,
   * `records`, ...) always served; naming a floor member changes nothing. Absent: every family the
   * deployment serves. A route of a family not named is answered 404 `not_found` after authentication.
   */
  readonly advertise?: readonly string[];
  /**
   * The batch limits the mock advertises and enforces from the start, and returns to on a control
   * reset. Absent: none, so only a control request sets one.
   */
  readonly limits?: {
    readonly decisions?: number;
    readonly records?: number;
    readonly resolutions?: number;
  };
  /**
   * The most bytes of arguments the mock keeps for an approval of a tool that shows its arguments to
   * approvers. Advertised as `limits.approval_arguments_max_bytes` and enforced with 400
   * `invalid_request`. Absent: no bound.
   */
  readonly approvalArgumentsMaxBytes?: number;
  /**
   * Rev 18: what the mock accepts in a policy-set proposal, advertised as `proposals`. A row kind or an optional
   * member it does not list is refused `proposal_refused` with `code` `shape`. Absent: every row kind and member of
   * the contract (`baseline`, `tightening`, `role`; `tool_grants`).
   */
  readonly proposals?: ProposalsServed;
  /**
   * The continuation deliveries the mock serves, advertised as `continuation_deliveries`. A continuation
   * whose delivery is not listed is 400 `invalid_continuation`. Absent: all three, and nothing advertised.
   */
  readonly deliveries?: readonly ('push' | 'pull' | 'held')[];
  /**
   * Only organisation administrators (`user_admin` and the adapter's service principal) register or
   * change tools; any other principal is 403 `forbidden`. Advertised as `tool_registration:
   * administrators`.
   */
  readonly restrictToolRegistration?: boolean;
  /**
   * Advertise `targets_all: false` in `policy_forms` and refuse, as 422 `unsupported_policy_form` naming
   * `targets`, a `tool_invocation` policy that targets every tool (no `targets`, or `tools: 'all'`), as the
   * hosted COO does. A policy that names its tools passes.
   */
  readonly restrictPolicyTargets?: boolean;
  /** The most bytes of request body the mock accepts; a larger one is 413 `payload_too_large`. Absent: no bound. */
  readonly maxBodyBytes?: number;
  /**
   * The resolutions the mock can produce, advertised as `resolutions`. One it does not list is 400
   * `invalid_request`. Defaults to `approved`, `rejected` and `escalated`.
   */
  readonly resolutions?: readonly string[];
  /**
   * The `client_id` of the deployment's approver surface (the approvals module's own client). A token issued
   * to it resolves an obligation its own user opened, and may not open one through `POST /v1/approvals`.
   * `MockTokens.approver_surface_token` is a token of the creator user with this `client_id`. Advertised as
   * `self_approval_from_approver_surface: true`. Defaults to `APPROVER_SURFACE_CLIENT`.
   */
  readonly approverSurfaceClient?: string;
  /**
   * A variant, not a defect: the mock returns every continuation it echoes with the members of each
   * object in the reverse of the order they were sent, as a store that normalises JSON does. The
   * contract says a continuation is the same JSON value, not the same bytes, so a suite must pass
   * against it; a scenario that compares member order would fail.
   */
  readonly reorderContinuation?: boolean;
  /**
   * A deployment that extends the document adds its members here: called with every approval handle the mock
   * builds from the document (and the obligation it describes), it returns the handle to serve. Absent: the
   * handle is served as the document declares it.
   */
  readonly extendHandle?: (handle: JsonObject, obligation: Obligation) => JsonObject;
  /**
   * Origins a browser may call the mock from, each exact (`http://localhost:3000`): never `*`, never a
   * pattern, and `createMock` throws for one that is not. The answer mirrors the hosted API's (see
   * `cors.ts`), on every path including `/__mock/*`, and runs before authentication so a preflight, which
   * carries no token, is answered. Empty by default: no CORS header at all.
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * Rev 11: who may register a connection, advertised as `connection_registration`. A refused owner kind or caller
   * is 403 `forbidden`. It governs registration only: an `org`-owned connection is changed, refreshed and deleted
   * by administrators in every profile. Absent: unrestricted, and nothing advertised.
   */
  readonly connectionRegistration?: {
    readonly owner_kinds: readonly ('principal' | 'org')[];
    readonly who: 'any' | 'administrators';
  };
  /**
   * Rev 11: the connection transports served, advertised as `connection_transports`; another is 400
   * `invalid_request`. Absent: both, advertised as both.
   */
  readonly connectionTransports?: readonly ('mcp' | 'a2a')[];
}

export interface Mock {
  readonly app: Hono<Env>;
  readonly config: MockConfig;
  readonly state: MockState;
  readonly issuer: MockIssuer;
  readonly index: SpecIndex;
  /** The key set that verifies Resumptions. */
  jwks(): { keys: SigningKey['publicJwk'][] };
  /** Mints the tokens a conformance run needs. */
  tokens(): Promise<MockTokens>;
}

export interface MockTokens {
  readonly audience: string;
  readonly creator: string;
  /** A user-kind principal that creates obligations: it is refused on identity alone, not on kind. */
  readonly creator_user: string;
  readonly approver: string;
  /** A user of a different organisation: it may see none of the organisation the others belong to. */
  readonly other_org: string;
  readonly entitled: string;
  readonly wrong_audience: string;
  /** Well-formed and unexpired, but signed by a key that is not the issuer's. */
  readonly forged: string;
  /** Signed by the issuer, and expired. */
  readonly expired: string;
  /** A valid user token bound to a proof key (`cnf.jkt`): this deployment verifies no DPoP proofs. */
  readonly dpop_bound: string;
  /** A valid user token with no organisation claim. */
  readonly no_org: string;
  /** A valid service-principal token without the `module_api` scope. */
  readonly no_scope: string;
  /** A second service principal of the same organisation as `creator`: it sees none of what `creator` made. */
  readonly other_service: string;
  /** A user of the organisation that is neither the creator nor eligible to approve: it resolves nothing and never reads an approval's arguments. */
  readonly member: string;
  /** An administrator of the organisation: it registers tools where registration is restricted and reads every tool. */
  readonly admin: string;
  /** The creator user's token issued to the approver surface (its `client_id` is the mock's approver-surface client). */
  readonly approver_surface_token: string;
  /** The `approver`'s own user (same `sub`), with a token minted without the `approvals:resolve` scope. */
  readonly approver_token_without_resolve_scope: string;
}

/** The default `client_id` of the mock's approver surface. */
export const APPROVER_SURFACE_CLIENT = 'noblecloak-approvals-module';

/** The reference of a tool the mock dispatches under another identity: `POST /v1/tools` for it is `tool_ref_in_use`. */
export const TOOL_REF_IN_USE = 'mcp:gateway:aliased_tool';

/** The one user principal of the organisation that is never eligible to approve (see `isEligible`). */
const MEMBER_SUB = 'user_member';

/**
 * The organisation's administrators: `user_admin`, and the adapter's service principal, which is what the
 * `admin` alias falls back to when a run has no administrator token (see `tokenFor`).
 */
const ADMIN_SUBS: readonly string[] = ['user_admin', 'svc_adapter'];

/** A name for a mock principal that is never its id: `user_approver` is `Approver`. */
const nameOfSub = (sub: string): string =>
  sub
    .replace(/^(svc|user)_/, '')
    .split('_')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || 'Principal';

const SEED_TOOLS: Pick<
  ToolRow,
  | 'tool_ref'
  | 'transport'
  | 'side_effect_level'
  | 'mode'
  | 'description'
  | 'default_policy'
  | 'policy_id'
  | 'dispatched_under_other_identity'
>[] = [
  {
    tool_ref: 'mcp:tracker:search',
    transport: 'mcp',
    side_effect_level: 'read',
    mode: 'always_allow',
    description: 'Search issues.',
  },
  {
    // No explicit policy matches this tool: the default applies and its decision names no policy.
    tool_ref: 'mcp:tracker:list_labels',
    transport: 'mcp',
    side_effect_level: 'read',
    mode: 'always_allow',
    default_policy: true,
    description: 'List the labels of a project.',
  },
  {
    tool_ref: 'mcp:tracker:create_issue',
    transport: 'mcp',
    side_effect_level: 'write',
    mode: 'ask',
    description: 'Create an issue.',
  },
  {
    // Its matching stored policy (`pol_silent`) is `ask` and states no `on_deny`.
    tool_ref: 'mcp:tracker:add_comment',
    transport: 'mcp',
    side_effect_level: 'write',
    mode: 'ask',
    policy_id: 'pol_silent',
    description: 'Comment on an issue.',
  },
  {
    tool_ref: 'ext:local:send_email',
    transport: 'external',
    side_effect_level: 'external',
    mode: 'ask',
    description: 'Send an email from the caller.',
  },
  {
    tool_ref: 'mcp:crm:delete_account',
    transport: 'mcp',
    side_effect_level: 'delete',
    mode: 'deny',
    description: 'Delete an account.',
  },
  {
    // The mock dispatches a tool under this reference through another identity: registering an
    // `external` tool with it would shadow that one, which is 422 `tool_ref_in_use`.
    tool_ref: TOOL_REF_IN_USE,
    transport: 'mcp',
    side_effect_level: 'read',
    mode: 'always_allow',
    dispatched_under_other_identity: true,
    description: 'A tool the deployment dispatches under another identity.',
  },
];

/** The scope a service principal's token must carry. */
const MODULE_API_SCOPE = 'module_api';

/**
 * The scope by which a caller holds the role `key` in the mock: `role:<key>`, the form a role subject's bare
 * key (`{ type: role, id: <key> }`) maps to (rev 10). A deployment maps role keys to its own form.
 */
const roleScope = (key: string): string => `role:${key}`;

/**
 * The reserved role every caller holds (rev 13, D7): the organisation's baseline. It is held implicitly, so
 * no token carries `role:everyone`, and the mock never lists it as a directory role.
 */
const EVERYONE_ROLE = 'everyone';

/** The service principals of the mock's own organisation that a binding accepts before they have called it. */
const MOCK_SERVICE_SUBS: readonly string[] = ['svc_adapter', 'svc_other', 'svc_no_scope'];

/**
 * The mock's own role for an administrator who authors policies (rev 10). Who is an administrator is each
 * deployment's own rule; the mock models it with this role, which no deployment is expected to share.
 */
const POLICY_ADMIN_ROLE = 'policy_admin';

/**
 * The scope a user's token must carry to resolve an approval (`Capabilities.user_resolve_scope`). The mock
 * mints it on every user token by default; `MockTokens.approver_token_without_resolve_scope` is the one that lacks it.
 */
export const USER_RESOLVE_SCOPE = 'approvals:resolve';

const DEFAULT_POLICY = { id: 'pol_default', version: 3 };
/** A stored `ask` policy that states no `on_deny`: the approvals it opens carry none. */
const POLICY_SILENT = { id: 'pol_silent', version: 3 };
const policyRefOf = (tool: Pick<ToolRow, 'policy_id'>): { id: string; version: number } =>
  tool.policy_id === POLICY_SILENT.id ? POLICY_SILENT : DEFAULT_POLICY;

/**
 * The `policy` member of a decision for `tool`, spread into the answer: an explicit policy names
 * itself, and when the default applied there is no member at all. The `null_policy_on_default` defect
 * emits `null` there instead.
 */
const policyMember = (
  tool: Pick<ToolRow, 'side_effect_level' | 'default_policy' | 'policy_id'> | undefined,
  nullIt: boolean
): Obj => {
  if (tool?.default_policy === true) return nullIt ? { policy: null } : {};
  return {
    policy: {
      ...(tool === undefined ? DEFAULT_POLICY : policyRefOf(tool)),
      side_effect_level: tool?.side_effect_level ?? 'read',
    },
  };
};
/** The policy an obligation records: the one the decision named, and none when the default applied. */
const policyOfTool = (tool: Pick<ToolRow, 'default_policy' | 'policy_id'>): Obligation['policy'] =>
  tool.default_policy === true ? undefined : policyRefOf(tool);
/** `value` with the members of every object in reverse order: the same JSON value, other bytes. */
const reverseMembers = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseMembers);
  if (isObj(value))
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, member]) => [key, reverseMembers(member)])
    );
  return value;
};
/** A namespace the mock reserves: a caller may not register a tool under it. */
export const RESERVED_TOOL_PREFIX = 'reserved:';
/** The references of the mock's system tools: a caller may not register one. */
export const SYSTEM_TOOL_REFS: readonly string[] = ['system:whoami'];
/**
 * The rank of each side-effect level: `read` < `write` = `external` < `delete` < `admin`. `write` and
 * `external` share a tier, so a move between them is neither a rise nor a fall.
 */
const LEVEL_RANK: Readonly<Record<string, number>> = {
  read: 0,
  write: 1,
  external: 1,
  delete: 2,
  admin: 3,
};
/** Whether moving a tool from level `from` to level `to` lowers its rank. */
const fallsFrom = (from: string, to: string): boolean =>
  (LEVEL_RANK[to] ?? Number.POSITIVE_INFINITY) < (LEVEL_RANK[from] ?? Number.NEGATIVE_INFINITY);
/**
 * A short, stable hex hash of `text` (FNV-1a, 32 bits): the server part of the `tool_ref` of a tool registered
 * from a connection, so that registering the same server again yields the same references (rev 11).
 */
const stableHash = (text: string): string => {
  let hash = 0x811c9dc5;
  for (const ch of text) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * The server identity of a connection's URL (rev 11): scheme and host in lower case, no default port and no
 * trailing slash, so URLs that differ only in form are the same server. A URL that does not parse is itself.
 */
const serverKeyOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return url;
  }
};

/** The two tools every server the mock connects to offers (rev 11): what refresh registers and discover lists. */
const CANNED_TOOLS: readonly {
  name: string;
  side_effect_level: string;
  mode: ToolRow['mode'];
  description: string;
}[] = [
  {
    name: 'lookup',
    side_effect_level: 'read',
    mode: 'always_allow',
    description: 'Look a record up.',
  },
  { name: 'update', side_effect_level: 'write', mode: 'ask', description: 'Change a record.' },
];

/**
 * The origin of a browser module the mock admits as a `return_to` of an authorization (rev 11), besides the
 * organisation's registered origins and the origins the mock lets call it.
 */
export const MOCK_MODULE_ORIGIN = 'https://module.mock.test';

/** The member the `undeclared_handle_member` defect adds to every approval handle: no schema declares it. */
export const UNDECLARED_HANDLE_MEMBER = 'mock_undeclared_member';

/** The resolutions an `approval.resolved` delivery may report: `WebhookResolution`'s known values (a test holds them equal). */
export const DELIVERABLE_RESOLUTIONS: readonly string[] = ['approved', 'rejected', 'escalated'];
/** Whether a resolution may be delivered: one outside `DELIVERABLE_RESOLUTIONS` never is. */
export const isDeliverableResolution = (resolution: string): boolean =>
  DELIVERABLE_RESOLUTIONS.includes(resolution);

/** How long an authorization URL the mock answers stays good (rev 11). */
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

const ORG = 'org_mock';
const OTHER_ORG = 'org_elsewhere';
/** How many queued webhook deliveries the mock keeps (rev 12). */
const OUTBOX_LIMIT = 1000;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The hosted-only features that come with a family, advertised next to its name. */
const HOSTED_FEATURES: Readonly<Partial<Record<Family, readonly string[]>>> = {
  policies: ['policies.author', 'policies.publish', 'policies.import_export', 'policies.retire'],
  'records.checkpoints': ['records.verify'],
  evidence: ['evidence.export'],
  // Rev 11: the OAuth authorize step and each user's own credential link.
  connections: ['connections.oauth', 'connections.user_links'],
};

/** The feature that says a deployment applies the rejected-duplicate rule (rev 10). */
const REJECTED_DUPLICATE_FEATURE = 'approvals.rejected_duplicate';

/** The feature that says a deployment sets `Approval.available_actions` on the single read of a pending approval (rev 15). */
const AVAILABLE_ACTIONS_FEATURE = 'approvals.available_actions';

/** The resolutions the mock offers as actions, with the wording of each (rev 15). */
const AVAILABLE_ACTIONS = [
  { resolution: 'approved', label: 'Approve' },
  { resolution: 'rejected', label: 'Deny' },
] as const;

/** The feature that says a deployment composes `tool_invocation` policies tightest-wins (rev 11, D-A89). */
const TIGHTEST_WINS_FEATURE = 'policies.tightest_wins';

/** Rev 16: the feature that says a deployment reads the facts of a call through `Tool.facts`. */
const TOOLS_FACTS_FEATURE = 'tools.facts';
/** Rev 16: the feature that says a deployment evaluates `ToolInvocationConfig.rules`. */
const POLICY_RULES_FEATURE = 'policies.rules';
/** Rev 16: the feature that says a deployment enforces approvers, serves `approval_routing` and sets requirements. */
const APPROVAL_REQUIREMENTS_FEATURE = 'approvals.requirements';

/**
 * The `tool_invocation` forms the mock enforces (rev 11, `Capabilities.policy_forms`): every mode but the
 * provisional `not_granted`, which it refuses with 422 (see `policyWriteRefused`), every subject type, a target
 * of every tool, and the config members: rev 11's three, `rules` (rev 16) and, where it serves approvals, `approvers`
 * and `exclude` (rev 16) with the `approval_routing` kind (see `policyForms`).
 */
const POLICY_FORMS = {
  tool_invocation: {
    modes: ['always_allow', 'ask', 'escalate', 'deny'],
    subject_types: ['user', 'agent', 'service', 'group', 'role', 'organization'],
    targets_all: true,
    config_members: [
      'on_deny',
      'expires_after',
      'approver_groups',
      'rules',
      'approvers',
      'exclude',
    ],
  },
  approval_routing: { config_members: ['org_admin_break_glass'] },
} as const;

/** Rev 16: the members of `ToolInvocationConfig` served only under `approvals.requirements`. */
const REQUIREMENT_MEMBERS: readonly string[] = ['approvers', 'exclude'];

/** The families that only a hosted deployment serves. */
const HOSTED_ONLY_FAMILIES: readonly Family[] = ['records.checkpoints', 'evidence'];

/** The families a mock serves: the ones named, or every family the deployment has. */
function servedFamilies(
  deployment: 'hosted' | 'edge',
  advertise: readonly string[] | undefined
): ReadonlySet<Family> {
  if (advertise === undefined)
    return new Set(
      FAMILIES.filter((f) => deployment === 'hosted' || !HOSTED_ONLY_FAMILIES.includes(f))
    );
  const unknown = advertise.filter(
    (name) => !isFamily(name) && !(FLOOR_NAMES as readonly string[]).includes(name)
  );
  if (unknown.length > 0)
    throw new Error(
      `unknown family ${unknown.join(', ')}. Known: ${[...FAMILIES, ...FLOOR_NAMES].join(', ')}`
    );
  const hostedOnly = advertise.filter(
    (name) => isFamily(name) && deployment === 'edge' && HOSTED_ONLY_FAMILIES.includes(name)
  );
  if (hostedOnly.length > 0)
    throw new Error(
      `an edge deployment does not serve ${hostedOnly.join(', ')}; advertising it would be advertise_unserved`
    );
  return new Set(advertise.filter(isFamily));
}

/** Builds a mock. Async because it generates its keys. */
export async function createMock(options: MockOptions = {}): Promise<Mock> {
  const config: MockConfig = {
    deployment: options.deployment ?? 'hosted',
    breaks: options.breaks ?? new Set<Break>(),
    audience: options.audience ?? 'https://govern.mock.test',
    expireAfterMs: options.expireAfterMs ?? 60 * 60 * 1000,
    approverSurfaceClient: options.approverSurfaceClient ?? APPROVER_SURFACE_CLIENT,
  };
  const broken = (flag: Break): boolean => config.breaks.has(flag);
  const served = servedFamilies(config.deployment, options.advertise);
  /** Rev 16: `policies.rules` is served (and advertised) where the mock authors policies: hosted, serving `policies`. */
  const rulesServed = (): boolean => config.deployment === 'hosted' && served.has('policies');
  /** Rev 16: `approvals.requirements` is served where rules are and the mock serves approvals too. */
  const requirementsServed = (): boolean => rulesServed() && served.has('approvals');
  /** Rev 16: the policy forms the mock advertises: without approvals, no requirement members and no routing kind. */
  const policyForms = (): Obj => {
    const toolInvocation = {
      ...POLICY_FORMS.tool_invocation,
      config_members: POLICY_FORMS.tool_invocation.config_members.filter(
        (member) => requirementsServed() || !REQUIREMENT_MEMBERS.includes(member)
      ),
      ...(options.restrictPolicyTargets === true ? { targets_all: false } : {}),
    };
    return {
      tool_invocation: toolInvocation,
      ...(requirementsServed() ? { approval_routing: POLICY_FORMS.approval_routing } : {}),
    };
  };
  const spec = options.spec ?? loadDocument();
  const index = new SpecIndex(spec);
  /**
   * Rev 17: the continuation kinds the mock accepts are the `Continuation.kind` enum of the document it implements
   * (schema validation refuses any other), so a document that predates rev 17 stands in for a deployment that has
   * not adopted `claude_agent_sdk` and advertises the seven kinds of rev 16.
   */
  const continuationKinds = (): string[] => {
    const schemas = ((spec.components as JsonObject | undefined)?.schemas ?? {}) as Record<
      string,
      JsonObject
    >;
    const kind = (schemas.Continuation?.properties as Record<string, JsonObject> | undefined)?.kind;
    return Array.isArray(kind?.enum) ? kind.enum.filter((k) => typeof k === 'string') : [];
  };
  const state = new MockState();
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins ?? []);
  /** The deployment's own origins: the configured list and the mock's module origin. Every organisation admits them. */
  const ownOrigins: ReadonlySet<string> = new Set([...allowedOrigins, MOCK_MODULE_ORIGIN]);
  const issuer = await MockIssuer.create();
  const signingKey = await generateSigningKey('mock-resumption-1');
  const unlistedKey = await generateSigningKey('mock-resumption-unlisted');
  const problemTitles = ((spec.info as JsonObject)['x-noblecloak-problem-types'] ?? {}) as Record<
    string,
    JsonObject
  >;

  for (const seed of SEED_TOOLS) {
    const id = `tool_${seed.tool_ref.replace(/[^a-z0-9]+/gi, '_')}`;
    state.tools.set(toolKey(ORG, seed.tool_ref), {
      org: ORG,
      id,
      connection_id: null,
      input_schema: { type: 'object' },
      data_routing: 'org_only',
      owner: { kind: 'org', id: ORG },
      show_arguments_to_approvers: false,
      ...seed,
    });
  }
  // The stored policies. `pol_default` is the policy the seeded tools name, `pol_silent` the one
  // `mcp:tracker:add_comment` names. The mock's decision is still the tool's own `mode` (see `decide`), unless a
  // published policy with rev 16 members matches the call (see `ruledDecision`): a policy is read for `on_deny`, for
  // simulate and by the policy routes.
  const seededAt = state.now().toISOString();
  const seedBy = { id: 'user_admin', kind: 'user' };
  state.policyVersions.set('pol_default', [
    {
      version: 3,
      kind: 'tool_invocation',
      name: 'Ask the members before a call',
      subjects: [{ type: 'role', id: 'member' }],
      targets: {
        tools: SEED_TOOLS.filter((t) => t.default_policy !== true && t.policy_id === undefined).map(
          (t) => t.tool_ref
        ),
      },
      config: { mode: 'ask', on_deny: 'resume', expires_after: 'PT1H' },
      published_at: seededAt,
      updated_at: seededAt,
      updated_by: seedBy,
    },
  ]);
  state.policyVersions.set('pol_silent', [
    {
      version: 3,
      kind: 'tool_invocation',
      name: 'Ask before a comment',
      subjects: [{ type: 'role', id: 'member' }],
      targets: { tools: ['mcp:tracker:add_comment'] },
      config: { mode: 'ask', expires_after: 'PT1H' },
      published_at: seededAt,
      updated_at: seededAt,
      updated_by: seedBy,
    },
  ]);

  /** Whether a version is a draft (`published_at: null`) or published. */
  const stateOf = (v: PolicyVersion): 'draft' | 'published' =>
    v.published_at === null ? 'draft' : 'published';
  /** The version a read returns: the latest published one, else the draft of a policy never published. */
  const readVersion = (versions: readonly PolicyVersion[]): PolicyVersion | undefined =>
    [...versions].reverse().find((v) => v.published_at !== null) ?? versions.at(-1);
  /** Whether policy `id` was retired (rev 11): every version of it carries `retired_at`. */
  const isRetired = (id: string): boolean =>
    (state.policyVersions.get(id) ?? []).some((v) => v.retired_at !== undefined);
  /** A tool whose named policy was retired is decided as if no policy named it (rev 11): the default applies. */
  const asNamed = <T extends Pick<ToolRow, 'default_policy' | 'policy_id'>>(tool: T): T =>
    tool.default_policy !== true && isRetired(policyRefOf(tool).id)
      ? { ...tool, default_policy: true }
      : tool;
  /**
   * The version in force: the latest published one; a policy never published enforces nothing, and nor does a
   * retired one.
   */
  const inForce = (id: string): PolicyVersion | undefined =>
    isRetired(id)
      ? undefined
      : [...(state.policyVersions.get(id) ?? [])].reverse().find((v) => v.published_at !== null);
  /** Rewrites the read view of policy `id` (`state.policies`) from its versions. */
  const syncPolicy = (org: string, id: string, source: string): Obj => {
    const current = readVersion(state.policyVersions.get(id) ?? []);
    if (current === undefined) throw new Error(`policy ${id} has no version`);
    const row: Obj = { org, id, source, ...current, state: stateOf(current) };
    state.policies.set(id, row);
    return row;
  };
  syncPolicy(ORG, 'pol_default', 'authored');
  syncPolicy(ORG, 'pol_silent', 'authored');

  /**
   * The `on_deny` a new approval snapshots from the stored policy it names: the policy's own, and only when
   * its mode is `ask` or `escalate` (the legality matrix of `ToolInvocationConfig`). None when no named
   * policy matched.
   */
  const onDenyOf = (policy: Obligation['policy']): Obligation['onDeny'] => {
    if (policy === undefined) return undefined;
    // The version in force: the latest published one, so neither a draft written since nor the draft of a
    // policy never published is read.
    const config = inForce(policy.id)?.config;
    if (config === undefined || (config.mode !== 'ask' && config.mode !== 'escalate'))
      return undefined;
    if (config.on_deny === 'resume' || config.on_deny === 'halt') return config.on_deny;
    // The defect: a policy that states none is read as `resume`.
    return broken('on_deny_defaults_to_resume') ? 'resume' : undefined;
  };

  const app = new Hono<Env>();
  type Ctx = Context<Env, string, object>;
  // First, so a preflight (which carries no token) is answered before authentication.
  // Rev 12: it also answers a preflight for any organisation's registered origin.
  app.use(
    '*',
    mockCors([...ownOrigins], {
      all: () => [...state.origins.values()].flat(),
      ignoreForPreflight: () => broken('registered_origin_preflight_refused'),
    })
  );

  // ---- responses -----------------------------------------------------------------------------
  const requestId = (): string => `req_${crypto.randomUUID()}`;
  const meta = (extra: Obj = {}): Obj => ({
    request_id: requestId(),
    deployment: config.deployment,
    ...extra,
  });

  const problem = (
    c: Ctx,
    status: number,
    code: string,
    detail?: string,
    extra: Obj = {},
    headers: Record<string, string> = {}
  ): Response => {
    const title = (problemTitles[code]?.title as string | undefined) ?? code;
    return new Response(
      JSON.stringify({
        type: `${PROBLEM_BASE}/${code}`,
        title,
        status,
        ...(detail === undefined ? {} : { detail }),
        instance: c.req.path,
        // The defect: a problem with no request id.
        ...(broken('problem_without_request_id') ? {} : { request_id: requestId() }),
        ...extra,
      }),
      { status, headers: { 'content-type': 'application/problem+json', ...headers } }
    );
  };

  /**
   * A server failure: 500 `internal_error` or 503 `service_unavailable`. The defect answers `about:blank`
   * with no typed code, and `retry_after_missing` drops the header of a 503.
   */
  const serverProblem = (
    c: Ctx,
    status: 500 | 503,
    retryAfter?: number,
    reason?: string
  ): Response => {
    const code = status === 500 ? 'internal_error' : 'service_unavailable';
    const hinted = status === 503 && retryAfter !== undefined && !broken('retry_after_missing');
    const headers: Record<string, string> = hinted ? { 'retry-after': String(retryAfter) } : {};
    if (!broken('server_error_untyped')) {
      // The hint is in the body as well, because a browser cannot read the header cross-origin.
      const extra: Obj = {
        ...(hinted && !broken('retry_after_body_missing')
          ? { retry_after_seconds: retryAfter }
          : {}),
        ...(status === 503 && reason !== undefined && !broken('eligibility_reason_missing')
          ? { reason }
          : {}),
      };
      return problem(c, status, code, 'The deployment could not answer.', extra, headers);
    }
    return new Response(
      JSON.stringify({
        type: 'about:blank',
        title: status === 500 ? 'Internal Server Error' : 'Service Unavailable',
        status,
        request_id: requestId(),
      }),
      { status, headers: { 'content-type': 'application/problem+json', ...headers } }
    );
  };

  // An error a handler did not expect is a 500 `internal_error`, as a deployment would answer; the mock says
  // what it was, so that a defect in the mock is not mistaken for the behaviour of a deployment.
  app.onError((error, c) => {
    console.error('[mock] unhandled error:', error);
    return serverProblem(c as Ctx, 500);
  });
  const ok = (c: Ctx, data: unknown, status = 200, extra: Obj = {}): Response => {
    let shaped = data;
    // The defects: a required member is missing from a tool (response_schema_violation) or from the
    // capabilities the run reads first (capabilities_schema_violation).
    if (broken('response_schema_violation') && c.req.path.startsWith('/v1/tools/') && isObj(data)) {
      shaped = without(data, 'tool_ref');
    }
    if (
      broken('capabilities_schema_violation') &&
      c.req.path === '/v1/capabilities' &&
      isObj(data)
    ) {
      shaped = without(data, 'jwks_uri');
    }
    return c.json({ data: shaped, meta: meta(extra) } as never, status as 200);
  };

  // ---- helpers -------------------------------------------------------------------------------
  const readBody = async (c: Ctx): Promise<{ body: unknown } | { response: Response }> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return { response: problem(c, 400, 'invalid_request', 'The body is not JSON.') };
    }
    return { body };
  };

  /** Reads and validates a JSON body against the operation's schema. */
  const validatedBody = async (
    c: Ctx,
    pre?: (body: Obj) => Response | undefined
  ): Promise<{ body: Obj } | { response: Response }> => {
    const read = await readBody(c);
    if ('response' in read) return read;
    if (isObj(read.body) && pre !== undefined) {
      const early = pre(read.body);
      if (early !== undefined) return { response: early };
    }
    const info = index.match(c.req.method, c.req.path);
    const validate = info === undefined ? undefined : index.requestBody(info, 'application/json');
    if (validate !== undefined && !broken('skip_request_validation') && !validate(read.body)) {
      return { response: problem(c, 400, 'invalid_request', describeErrors(validate)) };
    }
    return { body: (read.body ?? {}) as Obj };
  };

  const ANONYMOUS: Principal = {
    sub: 'anonymous',
    org: ORG,
    hasOrg: true,
    kind: 'user',
    scopes: [],
    dpopBound: false,
    entitlements: [],
  };
  const principalOf = (c: Ctx): Principal => c.get('principal');

  /** Whether a row of organisation `org` is the caller's to see. The break drops the scoping. */
  const visible = (c: Ctx, org: string): boolean =>
    broken('ignore_org_scope') || org === principalOf(c).org;
  /** `row` when the caller's organisation owns it, else undefined: another organisation's row is a 404. */
  const rowIn = (c: Ctx, row: Obj | undefined): Obj | undefined =>
    row !== undefined && visible(c, String(row.org)) ? row : undefined;
  /** What a client sees of a stored row: the organisation that scopes it is not part of the contract. */
  const shown = (row: Obj): Obj => without(row, 'org');

  /**
   * The scopes of each principal's latest token, by `org|sub`: the mock's view of a user's roles when an
   * administrator simulates as that user (rev 11). A user the mock has never seen holds none.
   */
  const scopesSeen = new Map<string, readonly string[]>();
  const trackPrincipal = (p: Principal): void => {
    const key = `${p.org}|${p.sub}`;
    scopesSeen.set(key, p.scopes);
    if (!state.principals.has(key)) {
      state.principals.set(key, {
        org: p.org,
        id: p.sub,
        kind: p.kind,
        display_name: nameOfSub(p.sub),
      });
    }
  };

  /**
   * The agent a service principal is bound to (rev 13, D1): the row of `state.agents` of `org` whose
   * `principal_id` is `sub`, else undefined. It is the only way an agent's policies reach a caller.
   */
  const agentBoundTo = (org: string, sub: string): Obj | undefined =>
    [...state.agents.values()].find((a) => a.org === org && a.principal_id === sub);
  /** The agent id the caller's binding names, when the caller is a service principal bound to an agent. */
  const boundAgentOf = (p: Principal): string | undefined =>
    p.kind === 'service' ? (agentBoundTo(p.org, p.sub)?.id as string | undefined) : undefined;

  // ---- authentication and deployment gating -------------------------------------------------
  app.use('*', async (c: Ctx, next: Next) => {
    // HEAD is answered by the GET handler, so it is matched as GET: a request is never exempt from
    // authentication for failing to match an operation. Only a route the document marks
    // `security: []`, or a mock control route, runs without a token.
    const method =
      c.req.method === 'HEAD' && !broken('unmatched_routes_open') ? 'GET' : c.req.method;
    const info = index.match(method, c.req.path);
    if (info === undefined) {
      if (c.req.path.startsWith('/__mock/')) return next();
      if (broken('unmatched_routes_open')) {
        // The defect: a request that matches no operation (HEAD) skips authentication and reaches the
        // GET handler. Handlers read a principal, so it runs as the anonymous one instead of crashing.
        c.set('principal', ANONYMOUS);
        return next();
      }
      return problem(c, 404, 'not_found', 'No such route.');
    }
    if (!info.authenticated) return next();
    // The defect: a route of a family the deployment does not serve answers anyone, before authentication.
    if (broken('unadvertised_routes_open') && info.family !== undefined && !served.has(info.family))
      return c.json({ data: { open: true } }, 200);
    // Identity comes from the verified token alone: any gateway identity header is refused before the
    // token is read. Each break exempts the headers one defective server would trust instead.
    const exempt = (name: string): boolean =>
      (name.startsWith(GATEWAY_HEADER_PREFIX) &&
        (broken('accept_actor_headers') || broken('actor_headers_override_token'))) ||
      (name === ORGANIZATION_HEADER && broken('org_header_overrides_token')) ||
      ((name === PERMISSIONS_HEADER || name === SCOPES_HEADER) &&
        broken('permissions_header_overrides_token'));
    // The defect: only the five listed names are refused, not every name under the prefix.
    const isRejected = broken('accept_unlisted_prefixed_headers')
      ? (name: string): boolean => REJECTED_IDENTITY_HEADERS.includes(name.toLowerCase())
      : isRejectedIdentityHeader;
    const identityHeaders = [...c.req.raw.headers.keys()].filter(isRejected);
    const hasActorHeader = identityHeaders.some((name) => name.startsWith(GATEWAY_HEADER_PREFIX));
    if (identityHeaders.some((name) => !exempt(name))) {
      return problem(
        c,
        401,
        'header_identity_rejected',
        'Gateway identity headers are not accepted.'
      );
    }
    const authorization = c.req.header('authorization');
    const bearer = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1];
    const dpop = /^DPoP (.+)$/i.exec(authorization ?? '')?.[1];
    // The mock does not verify DPoP proofs, so the document wins: bearer tokens only. The defect treats
    // the DPoP scheme, and a token bound to a proof key, as a bearer.
    if (dpop !== undefined && !broken('accept_dpop_as_bearer')) {
      return problem(
        c,
        401,
        'dpop_unsupported',
        'This deployment does not verify DPoP proofs: send the token as a bearer.'
      );
    }
    const token = bearer ?? dpop;
    if (token === undefined && broken('accept_missing_token')) {
      c.set('principal', ANONYMOUS);
      return next();
    }
    if (token === undefined) {
      if (hasActorHeader && broken('accept_actor_headers')) {
        c.set('principal', {
          sub: c.req.header(gatewayHeader('id')) ?? 'actor',
          org: ORG,
          hasOrg: true,
          kind: 'user',
          scopes: [],
          dpopBound: false,
          entitlements: [],
        });
        return next();
      }
      return problem(c, 401, 'unauthorized', 'A bearer token is required.');
    }
    const result = await issuer.verify(
      token,
      config.audience,
      state.now(),
      !broken('ignore_audience'),
      { signature: broken('accept_forged_signature'), expiry: broken('accept_expired_token') }
    );
    if (typeof result === 'string')
      return problem(c, 401, result, `The token was refused: ${result}.`);
    if (result.dpopBound && !broken('accept_dpop_as_bearer')) {
      return problem(
        c,
        401,
        'dpop_unsupported',
        'The token is bound to a proof key (cnf.jkt) and this deployment does not verify DPoP proofs.'
      );
    }
    // A verified token with no organisation claim has nothing to scope an organisation-scoped route
    // by, and every authenticated route is organisation-scoped.
    if (!result.hasOrg && !broken('accept_missing_org')) {
      return problem(
        c,
        403,
        'organization_context_required',
        'The token carries no organisation and this route is organisation-scoped.'
      );
    }
    if (
      result.kind === 'service' &&
      !result.scopes.includes(MODULE_API_SCOPE) &&
      !broken('accept_missing_scope')
    ) {
      return problem(
        c,
        403,
        'insufficient_scope',
        `A service principal's token must carry the ${MODULE_API_SCOPE} scope.`
      );
    }
    // The defects: a gateway identity header outranks the verified token.
    const header = (name: string): string | undefined => c.req.header(name);
    const kindHeader = header(gatewayHeader('type'));
    const permissions = header(PERMISSIONS_HEADER) ?? header(SCOPES_HEADER);
    const principal: Principal = {
      ...result,
      ...(broken('actor_headers_override_token')
        ? {
            sub: header(gatewayHeader('id')) ?? result.sub,
            kind:
              kindHeader === 'user' || kindHeader === 'service' || kindHeader === 'agent'
                ? kindHeader
                : result.kind,
          }
        : {}),
      ...(broken('org_header_overrides_token')
        ? { org: header(ORGANIZATION_HEADER) ?? result.org }
        : {}),
      ...(broken('permissions_header_overrides_token') && permissions !== undefined
        ? { entitlements: permissions.split(/[\s,]+/).filter((v) => v !== '') }
        : {}),
    };
    c.set('principal', principal);
    trackPrincipal(principal);
    if (
      config.deployment === 'edge' &&
      info.deployment === 'hosted' &&
      !broken('hosted_routes_on_edge')
    ) {
      return problem(
        c,
        404,
        'not_available_on_deployment',
        `${info.operationId} is served by the hosted deployment only.`
      );
    }
    if (info.family !== undefined && !served.has(info.family)) {
      return problem(c, 404, 'not_found', `${info.operationId} is not served by this deployment.`);
    }
    if (
      info.entitlement !== undefined &&
      info.deployment === 'hosted' &&
      !result.entitlements.includes(info.entitlement)
    ) {
      return problem(
        c,
        403,
        'entitlement_required',
        `The organisation is not entitled to ${info.entitlement}.`
      );
    }
    return next();
  });

  // ---- browser origins on an actual request (rev 12) ------------------------------------------
  // The request carries the token, so its `Origin` is checked against the caller organisation's registered
  // origins plus the deployment's own: any other is 403 `forbidden` with no `Access-Control-Allow-Origin`.
  // A request without `Origin`, and a route that needs no token, are not affected. The defect checks the
  // origins of every organisation instead.
  app.use('*', async (c: Ctx, next: Next) => {
    const origin = c.req.header('origin');
    const principal = c.get('principal') as Principal | undefined;
    if (origin === undefined || principal === undefined) return next();
    const admitted =
      ownOrigins.has(origin) ||
      (broken('origin_check_ignores_org')
        ? [...state.origins.values()].some((list) => list.includes(origin))
        : (state.origins.get(principal.org) ?? []).includes(origin));
    if (admitted) return next();
    markOriginRefused(c.req.raw);
    return problem(
      c,
      403,
      'forbidden',
      "The Origin of this request is not one the deployment or the caller's organisation admits."
    );
  });

  // ---- mock control: failures and limits (see `/__mock/control`) --------------------------------
  /** The next request to this operation answers a server error, once. */
  let armedFailure:
    | {
        operation: string;
        status: 500 | 503;
        retryAfter: number | undefined;
        reason: string | undefined;
      }
    | undefined;
  /**
   * Whether the eligibility lookup is down (set by mock control, cleared by a reset): the deployment cannot
   * say who is eligible to resolve an approval, so `waiting_on` is not computed.
   */
  let eligibilityLookupDown = false;
  /** The batch limits the mock advertises and enforces, when set below 100. */
  const initialLimits = options.limits ?? {};
  const limits: { decisions?: number; records?: number; resolutions?: number } = {
    ...initialLimits,
  };
  /** The largest request body accepted; a larger one is 413. Set at start, and by mock control. */
  let maxBodyBytes: number | undefined = options.maxBodyBytes;
  const resolutionsServed = options.resolutions ?? ['approved', 'rejected', 'escalated'];

  // A body larger than the deployment accepts is 413 on every route that takes one, after authentication.
  app.use('*', async (c: Ctx, next: Next) => {
    if (
      maxBodyBytes === undefined ||
      broken('oversized_body_accepted') ||
      !['POST', 'PUT', 'PATCH'].includes(c.req.method) ||
      c.req.path.startsWith('/__mock/')
    )
      return next();
    const size = new TextEncoder().encode(await c.req.raw.clone().text()).length;
    if (size <= maxBodyBytes) return next();
    return problem(
      c,
      413,
      'payload_too_large',
      `The body is ${String(size)} bytes; this deployment accepts at most ${String(maxBodyBytes)}.`,
      { max_bytes: maxBodyBytes }
    );
  });

  app.use('*', async (c: Ctx, next: Next) => {
    const info = index.match(c.req.method, c.req.path);
    if (armedFailure !== undefined && info?.operationId === armedFailure.operation) {
      const { status, retryAfter, reason } = armedFailure;
      armedFailure = undefined;
      return serverProblem(c, status, retryAfter, reason);
    }
    return next();
  });

  // ---- idempotency ---------------------------------------------------------------------------
  const IDEMPOTENT = new Set([
    'createApproval',
    'appendRecord',
    'appendRecords',
    'createAgent',
    'createRun',
    'createWebhook',
  ]);
  app.use('*', async (c: Ctx, next: Next) => {
    const info = index.match(c.req.method, c.req.path);
    const key = c.req.header('idempotency-key');
    if (
      info === undefined ||
      !IDEMPOTENT.has(info.operationId) ||
      key === undefined ||
      broken('idempotency_ignored')
    ) {
      return next();
    }
    const principal = principalOf(c);
    const slot = `${principal.org}|${principal.sub}|${info.operationId}|${key}`;
    const hash = await argDigest({ body: await c.req.raw.clone().text() });
    const seen = state.idempotency.get(slot);
    if (seen !== undefined) {
      if (seen.hash !== hash)
        return problem(
          c,
          422,
          'idempotency_key_reuse',
          'This Idempotency-Key was used with a different request.'
        );
      return new Response(seen.body, {
        status: seen.status,
        headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' },
      });
    }
    await next();
    if (c.res.status < 300) {
      state.idempotency.set(slot, { hash, status: c.res.status, body: await c.res.clone().text() });
    }
    return undefined;
  });

  // ---- tools, scope and decisions ------------------------------------------------------------
  /**
   * Who may register or change tools where registration is restricted: the organisation's administrators
   * and the adapter's service principal (unchanged by the visibility rule below).
   */
  const mayRegisterTools = (p: Principal): boolean => ADMIN_SUBS.includes(p.sub);
  /**
   * Whether a principal is an administrator for visibility: a user the deployment recognises as one. A
   * service principal never is. The defects: no administrator sees another principal's tools, and the
   * service principal that may register is an administrator for visibility too.
   */
  const isAdministratorUser = (p: Principal): boolean =>
    broken('admin_cannot_see_private_tools')
      ? false
      : ADMIN_SUBS.includes(p.sub) &&
        (p.kind === 'user' || broken('service_principal_sees_private_tools'));
  /**
   * Whether the caller sees a tool of its organisation: a tool owned by the organisation, or by a principal
   * who is the caller, or whoever the caller is when it is an administrator user. The defect shows a
   * principal's tool to every colleague.
   */
  const canSeeTool = (c: Ctx, t: ToolRow): boolean =>
    visible(c, t.org) &&
    (t.owner.kind !== 'principal' ||
      t.owner.id === principalOf(c).sub ||
      isAdministratorUser(principalOf(c)) ||
      broken('tool_visible_to_colleague'));
  const toolOf = (c: Ctx, toolRef: string): ToolRow | undefined =>
    [...state.tools.values()].find((t) => t.tool_ref === toolRef && canSeeTool(c, t));
  /**
   * A tool a call is decided for: one the caller sees and that is not `withdrawn` (rev 11); a withdrawn tool is
   * answered as one with no catalog row. The defect decides a withdrawn tool as if it were active.
   */
  const callableToolOf = (c: Ctx, toolRef: string): ToolRow | undefined => {
    const tool = toolOf(c, toolRef);
    return tool?.status === 'withdrawn' && !broken('withdrawn_tool_allowed') ? undefined : tool;
  };
  /**
   * The `per_user` registration a call to `tool` by `who` waits on (rev 11): the tool's connection takes links and
   * `who` has no usable link to it. Undefined when nothing blocks the call.
   */
  const blockingConnection = (
    tool: Pick<ToolRow, 'connection_id' | 'org'>,
    who: Pick<Principal, 'org' | 'sub'>
  ): string | undefined => {
    const row = tool.connection_id === null ? undefined : state.connections.get(tool.connection_id);
    if (row?.org !== tool.org || !takesLinks(row)) return undefined;
    return usable(linkOf(row, who)) ? undefined : String(row.id);
  };
  /** What an approval waits on (rev 11): the creator's link to the registration of its tool, when it is not usable. */
  const blockedOn = (o: Obligation): Obj | undefined => {
    const tool = state.tools.get(toolKey(o.org, o.toolRef));
    const connectionId =
      tool === undefined ? undefined : blockingConnection(tool, { org: o.org, sub: o.creatorSub });
    return connectionId === undefined
      ? undefined
      : { reason: 'credential_link_required', connection_id: connectionId };
  };
  const isOpenState = (o: Obligation): boolean => o.state === 'pending' || o.state === 'approved';
  /**
   * The time an approval is created or resolved at: strictly later than the last such time, so that two
   * approvals made in the same millisecond are still ordered, as the queue's "newest first" needs.
   */
  let lastStamp = 0;
  const stamp = (): Date => {
    lastStamp = Math.max(state.now().getTime(), lastStamp + 1);
    return new Date(lastStamp);
  };
  /** The arguments an approval holds are cleared when it reaches a final state. The defect keeps them. */
  const clearArguments = (o: Obligation): void => {
    if (!broken('arguments_kept_when_final')) o.arguments = undefined;
  };
  const MEMBER = MEMBER_SUB;
  /**
   * The token was issued to the approver surface (rev 7): the one client a person resolves their own agent's
   * obligation from. The defect refuses that, so the creator is never eligible whatever its token's client.
   */
  const fromApproverSurface = (reader: Principal): boolean =>
    reader.clientId === config.approverSurfaceClient && !broken('surface_self_approval_refused');
  /**
   * Rev 16: whether the organisation's `approval_routing` setting lets an administrator satisfy every requirement
   * (`org_admin_break_glass`): its most recently published `approval_routing` policy with the organisation subject,
   * and on when it has none.
   */
  const breakGlassOn = (org: string): boolean => {
    let best: PolicyVersion | undefined;
    for (const row of state.policies.values()) {
      if (row.org !== org) continue;
      const version = inForce(String(row.id));
      if (
        version?.kind !== 'approval_routing' ||
        !version.subjects.some((s) => s.type === 'organization')
      )
        continue;
      if (best === undefined || String(version.published_at) > String(best.published_at))
        best = version;
    }
    return best?.config.org_admin_break_glass !== false;
  };
  /**
   * Rev 16: how `reader` may satisfy requirement `r` of `o`, or undefined when it may not: `listed` when it holds a
   * role or is the user `r` lists (with none listed, when it is an administrator of the organisation), `break_glass`
   * when it is an administrator and the organisation's setting is on. `exclude: [requester]` keeps the creator out
   * of either. The defects: the setting is ignored (break-glass always on), and `exclude` is ignored.
   */
  const eligibleFor = (
    reader: Principal,
    o: Obligation,
    r: Requirement
  ): 'listed' | 'break_glass' | undefined => {
    if (
      r.exclude.includes('requester') &&
      reader.org === o.org &&
      reader.sub === o.creatorSub &&
      !broken('exclude_requester_ignored')
    )
      return undefined;
    const listed =
      r.approvers.length === 0
        ? isOrganisationAdmin(reader)
        : r.approvers.some((a) =>
            'role' in a ? reader.scopes.includes(roleScope(a.role)) : a.user === reader.sub
          );
    if (listed) return 'listed';
    if (
      isOrganisationAdmin(reader) &&
      (breakGlassOn(o.org) || broken('break_glass_ignores_setting'))
    )
      return 'break_glass';
    return undefined;
  };
  /**
   * Whether `reader` is a principal the mock would accept as an approver of `o` while it is pending: a
   * user, not its creator unless the token was issued to the approver surface, and not the organisation's
   * `member`. With `withBreaks` the two defects that let a service principal or the creator resolve apply,
   * as they do for the resolve routes. Rev 16: on an approval with requirements, also eligible for one of them (met
   * or not, so eligibility does not depend on the state); `mayResolveNow` asks for an unmet one.
   */
  const isEligible = (reader: Principal, o: Obligation, withBreaks = false): boolean =>
    baseEligible(reader, o, withBreaks) &&
    (o.requirements === undefined ||
      o.requirements.some((r) => eligibleFor(reader, o, r) !== undefined));
  /**
   * Rev 16: whether `reader` may approve or reject `o` now: eligible as `isEligible` says and, on an approval with
   * requirements, for at least one that is unmet.
   */
  const mayResolveNow = (reader: Principal, o: Obligation, withBreaks = false): boolean =>
    baseEligible(reader, o, withBreaks) &&
    (o.requirements === undefined ||
      o.requirements.some((r) => !r.met && eligibleFor(reader, o, r) !== undefined));
  /** The rules of eligibility before rev 16's requirements (see `isEligible`). */
  const baseEligible = (reader: Principal, o: Obligation, withBreaks = false): boolean =>
    (reader.kind !== 'service' || (withBreaks && broken('allow_service_resolve'))) &&
    (o.creatorSub !== reader.sub ||
      fromApproverSurface(reader) ||
      (withBreaks && broken('allow_creator_self_resolve'))) &&
    reader.sub !== MEMBER &&
    // Rev 14: a deployment-applied approval changes the organisation's policies, so only an administrator
    // approves it. The defect lets any user who is eligible for an ordinary approval approve it.
    (!isDeploymentApplied(o.toolRef) ||
      isOrganisationAdmin(reader) ||
      broken('proposal_approved_by_non_admin'));
  /** Rev 14: the approvers of a deployment-applied approval, an administrator user of the organisation. */
  const isOrganisationAdmin = (p: Principal): boolean =>
    p.kind === 'user' && p.scopes.includes(roleScope(POLICY_ADMIN_ROLE));
  /**
   * The tool an approval is for, read now. A deployment-applied reference is no row of the catalog: the mock
   * answers a fixed one, whose arguments its approvers always see (rev 14).
   */
  const toolOfApproval = (o: Obligation): ToolRow | undefined =>
    isDeploymentApplied(o.toolRef)
      ? appliedTool(o.org)
      : state.tools.get(toolKey(o.org, o.toolRef));
  const appliedTool = (org: string): ToolRow => ({
    org,
    id: 'tool_noblecloak_propose_policy_set',
    tool_ref: PROPOSE_POLICY_SET,
    connection_id: null,
    description: 'Propose the tools, the binding and the policies of an agent.',
    // The deployment applies the change itself: no caller runs anything, so no resume token is ever issued.
    transport: 'mcp',
    input_schema: { type: 'object' },
    side_effect_level: 'admin',
    data_routing: 'org_only',
    owner: { kind: 'org', id: org },
    // Its policy is a fixed `ask` that no policy changes, and no stored policy names it.
    mode: 'ask',
    default_policy: true,
    show_arguments_to_approvers: true,
  });
  const identityOf = (
    org: string,
    scopeKey: string,
    toolRef: string,
    digest: string,
    door: string
  ): string =>
    `${org}|${scopeKey}|tool_invocation|${toolRef}|${digest}${broken('dedupe_split_doors') ? `|${door}` : ''}`;

  const notify = (o: Obligation): void => {
    for (const listener of state.listeners) listener(o);
    for (const wake of state.waiters.get(o.id) ?? []) wake();
  };

  const expireIfDue = (o: Obligation): void => {
    if (isOpenState(o) && state.now().getTime() >= o.expiresAt.getTime()) {
      o.state = 'expired';
      clearArguments(o);
      notify(o);
    }
  };

  const findOpen = (identity: string): Obligation | undefined => {
    const id = state.open.get(identity);
    const found = id === undefined ? undefined : state.obligations.get(id);
    if (found === undefined) return undefined;
    expireIfDue(found);
    if (isOpenState(found) || broken('terminal_not_freed')) return found;
    return undefined;
  };

  const digestOf = async (action: Obj): Promise<string> => {
    if (typeof action.arg_digest === 'string') return action.arg_digest;
    const args = (action.arguments ?? {}) as JsonValue;
    if (broken('digest_not_jcs')) {
      const { createHash } = await import('node:crypto');
      return createHash('sha256').update(JSON.stringify(args)).digest('hex');
    }
    return argDigest(args);
  };

  const resolveScope = (
    c: Ctx,
    runId: unknown
  ): { key: string; id: string; run: Obj | undefined } | Response => {
    const p = principalOf(c);
    // A deployment that does not serve runs has no run to name.
    if (typeof runId === 'string' && !served.has('runs') && !broken('run_id_without_runs_accepted'))
      return problem(c, 404, 'not_found', 'This deployment does not serve runs.');
    if (typeof runId === 'string') {
      const run = state.runs.get(runId);
      if (!(run?.kind === 'external' && run.org === p.org && run.ownerSub === p.sub)) {
        return problem(c, 403, 'forbidden', 'run_id must name an external run the caller owns.');
      }
      return { key: `run:${run.scope_id}`, id: run.scope_id, run: run as unknown as Obj };
    }
    return { key: `principal:${p.org}:${p.sub}`, id: `principal:${p.sub}`, run: undefined };
  };

  const continuationOf = (body: Obj): Continuation | undefined =>
    isObj(body.continuation) ? (body.continuation as unknown as Continuation) : undefined;

  const guardContinuation = (
    c: Ctx,
    continuation: Continuation | undefined,
    /** A continuation is refused if its delivery is not served; a webhook is not a continuation. */
    checkDelivery = true
  ): Response | undefined => {
    if (continuation === undefined) return undefined;
    if (!broken('callback_unguarded')) {
      if (continuation.delivery === 'push' && continuation.callback_url !== undefined) {
        const why = callbackProblem(continuation.callback_url);
        if (why !== undefined) return problem(c, 400, 'callback_unroutable', why);
      }
    }
    // A delivery the deployment does not serve is refused, after the callback check.
    if (
      checkDelivery &&
      options.deliveries !== undefined &&
      !(options.deliveries as readonly string[]).includes(continuation.delivery) &&
      !broken('undeclared_delivery_accepted')
    )
      return problem(
        c,
        400,
        'invalid_continuation',
        `This deployment does not serve the ${continuation.delivery} delivery.`
      );
    return undefined;
  };

  const handleOf = (o: Obligation, created: boolean): Obj => {
    const handle: JsonObject = {
      id: o.id,
      state: o.state,
      created,
      created_at: o.createdAt.toISOString(),
      expires_at: o.expiresAt.toISOString(),
      resume_token_will_issue: o.executor === 'caller',
      // The defect: a member the document does not declare, on every handle.
      ...(broken('undeclared_handle_member') ? { [UNDECLARED_HANDLE_MEMBER]: true } : {}),
    };
    return options.extendHandle === undefined ? handle : options.extendHandle(handle, o);
  };

  /**
   * 400 `invalid_request` for arguments larger than the bound this deployment advertises, for a tool that
   * keeps them for its approvers. The defect keeps them whatever their size.
   */
  const argumentsTooLarge = (
    c: Ctx,
    tool: ToolRow,
    args: Obj | undefined
  ): Response | undefined => {
    const bound = options.approvalArgumentsMaxBytes;
    if (bound === undefined || args === undefined || broken('arguments_bound_not_enforced'))
      return undefined;
    if (!tool.show_arguments_to_approvers) return undefined;
    const bytes = new TextEncoder().encode(jcs(args as unknown as JsonValue)).length;
    if (bytes <= bound) return undefined;
    return problem(
      c,
      400,
      'invalid_request',
      `The arguments are ${String(bytes)} bytes in canonical form; this deployment keeps at most ${String(bound)} for an approval.`
    );
  };

  // ---- the rejected-duplicate rule (rev 10) ---------------------------------------------------
  /** The organisation's duplicate-requests setting when it has published none: deny, for 24 hours. */
  const DUPLICATE_DEFAULT: Obj = { after_rejection: 'deny', window_seconds: 86_400 };

  /**
   * The organisation's duplicate-requests setting: the version in force of its most recently published
   * `duplicate_requests` policy with the organisation subject, or the default (`id` undefined).
   */
  const duplicateSetting = (org: string): { id?: string; version?: number; config: Obj } => {
    let best: { id: string; version: PolicyVersion } | undefined;
    for (const row of state.policies.values()) {
      if (row.org !== org) continue;
      const version = inForce(String(row.id));
      if (
        version?.kind !== 'duplicate_requests' ||
        !version.subjects.some((s) => s.type === 'organization')
      )
        continue;
      if (best === undefined || String(version.published_at) > String(best.version.published_at))
        best = { id: String(row.id), version };
    }
    return best === undefined
      ? { config: DUPLICATE_DEFAULT }
      : { id: best.id, version: best.version.version, config: best.version.config };
  };

  /**
   * What the duplicate-requests setting `config` says of a call with identity `identity`: nothing (no
   * rejection counts), `deny` (naming the latest rejection) or `ask_again` (with the count). The count is of
   * the resolver's rejections of the identity whose `resolved_at` lies within the window and that came
   * after its last consumed approval. The defects: `rejected_duplicate_reopened` applies no rule (the rev 9
   * behaviour); `rejection_never_frees` ignores the window and the `ask_again` setting.
   */
  const duplicateVerdict = (
    config: Obj,
    identity: string
  ):
    | undefined
    | { kind: 'deny'; approvalId: string }
    | { kind: 'ask_again'; count: number; lastAt: Date } => {
    if (broken('rejected_duplicate_reopened')) return undefined;
    const since = state.lastConsumed.get(identity);
    const windowMs =
      (typeof config.window_seconds === 'number' ? config.window_seconds : 86_400) * 1000;
    const now = state.now().getTime();
    const counted = (state.rejections.get(identity) ?? []).filter(
      (r) =>
        (since === undefined || r.at.getTime() > since.getTime()) &&
        (broken('rejection_never_frees') || now - r.at.getTime() <= windowMs)
    );
    const latest = counted.at(-1);
    if (latest === undefined) return undefined;
    const maxReasks = typeof config.max_reasks === 'number' ? config.max_reasks : undefined;
    if (
      config.after_rejection !== 'ask_again' ||
      broken('rejection_never_frees') ||
      (maxReasks !== undefined && counted.length > maxReasks)
    )
      return { kind: 'deny', approvalId: latest.id };
    return { kind: 'ask_again', count: counted.length, lastAt: latest.at };
  };

  /**
   * Whether a call is subject to the rule: its identity is scoped to a run or to a user principal. A service
   * principal's calls that name no run share one identity across every end user behind it, so they are not.
   */
  const subjectToDuplicateRule = (p: Principal, scope: { run: Obj | undefined }): boolean =>
    p.kind === 'user' || scope.run !== undefined;

  /**
   * The approver surface resolves; it does not open (D-A78), through either door: `POST /v1/approvals` and a
   * step_up on `POST /v1/decisions` (single, batch, AuthZEN evaluate). Allow and deny are still answered. The
   * defect lets it open.
   */
  const surfaceMayNotOpen = (c: Ctx): Response | undefined =>
    principalOf(c).clientId === config.approverSurfaceClient && !broken('surface_token_may_open')
      ? problem(
          c,
          403,
          'forbidden',
          'A token issued to the approver surface resolves approvals; it does not open them.'
        )
      : undefined;

  /** Rev 16: what makes two requirements one: their approver entries in force and their `exclude`, in any order. */
  const requirementKey = (r: Pick<Requirement, 'approvers' | 'exclude'>): string =>
    jcs({
      approvers: r.approvers.map((a) => jcs(a as unknown as JsonValue)).sort(),
      exclude: [...r.exclude].sort(),
    });
  /**
   * Rev 16: the requirements of `wanted` (what a call sets) that `o` carries none like (by `requirementKey`), each
   * once. None when the call sets none.
   */
  const lackingRequirements = (
    o: Obligation,
    wanted: readonly Requirement[] | undefined
  ): Requirement[] => {
    const held = new Set((o.requirements ?? []).map(requirementKey));
    return (wanted ?? []).filter((r) => !held.has(requirementKey(r)));
  };

  /**
   * Opens an obligation, or returns the open one. A Response is a refusal; `rejectedDuplicate` is the
   * rejected-duplicate rule's refusal, which a decision answers `deny` and `POST /v1/approvals` 409.
   * `split` is the `batch_duplicates_split` defect: an identical open obligation is not joined. Rev 16: an open
   * obligation that lacks a requirement of `requirements` gains it while pending (see `lackingRequirements`);
   * an approved one is joined as it is.
   */
  const openObligation = (
    c: Ctx,
    args: {
      tool: ToolRow;
      digest: string;
      scope: { key: string; id: string; run: Obj | undefined };
      continuation: Continuation | undefined;
      agentId: string | undefined;
      arguments: Obj | undefined;
      door: string;
      split?: boolean;
      /** Rev 16: the policy a composition of rule-bearing policies decided by (see `ruledDecision`). */
      policy?: { id: string; version: number };
      /** Rev 16: the requirements that composition gave. */
      requirements?: Requirement[];
    }
  ):
    | { obligation: Obligation; created: boolean }
    | { rejectedDuplicate: { approvalId: string } }
    | Response => {
    const p = principalOf(c);
    const surface = surfaceMayNotOpen(c);
    if (surface !== undefined) return surface;
    const tooLarge = argumentsTooLarge(c, args.tool, args.arguments);
    if (tooLarge !== undefined) return tooLarge;
    const identity = identityOf(p.org, args.scope.key, args.tool.tool_ref, args.digest, args.door);
    const existing = args.split === true ? undefined : findOpen(identity);
    // Rev 16: a pending approval that lacks requirements this call sets gains them, unmet. An approved one is
    // joined as it is: it keeps the requirements it was approved under.
    if (existing?.state === 'pending') {
      const lacking = lackingRequirements(existing, args.requirements);
      if (lacking.length > 0) {
        const held = existing.requirements ?? [];
        existing.requirements = [
          ...held,
          ...lacking.map((r, i) => ({ ...r, id: `r${String(held.length + i + 1)}` })),
        ];
        notify(existing);
      }
    }
    if (existing !== undefined) {
      const had = existing.continuation;
      if (args.continuation !== undefined) {
        const explicit = (existing as Obligation & { explicit?: boolean }).explicit === true;
        if (
          explicit &&
          jcs(had as unknown as JsonValue) !== jcs(args.continuation as unknown as JsonValue) &&
          !broken('continuation_multiplicity_ignored')
        ) {
          return problem(
            c,
            409,
            'continuation_conflict',
            'The open obligation already has a different continuation.'
          );
        }
        if (!explicit) {
          existing.continuation = args.continuation;
          (existing as Obligation & { explicit?: boolean }).explicit = true;
        }
      }
      return { obligation: existing, created: false };
    }
    // Nothing open: an identical call a resolver rejected within the window is refused, or reopened
    // carrying the count, as the organisation's duplicate-requests setting says.
    const verdict = subjectToDuplicateRule(p, args.scope)
      ? duplicateVerdict(duplicateSetting(p.org).config, identity)
      : undefined;
    if (verdict?.kind === 'deny') return { rejectedDuplicate: { approvalId: verdict.approvalId } };
    const now = stamp();
    const o: Obligation & { explicit?: boolean } = {
      id: crypto.randomUUID(),
      org: p.org,
      creatorSub: p.sub,
      creatorKind: p.kind,
      scopeKey: args.scope.key,
      scopeId: args.scope.id,
      runId: args.scope.run === undefined ? undefined : String(args.scope.run.id),
      runKind: args.scope.run === undefined ? undefined : 'external',
      agentId: args.agentId,
      toolRef: args.tool.tool_ref,
      kind: 'tool_invocation',
      argDigest: args.digest,
      // Kept only for a tool whose approvers are shown the call, and only from this opening request.
      arguments:
        args.tool.show_arguments_to_approvers || broken('arguments_without_opt_in')
          ? args.arguments
          : undefined,
      state: 'pending',
      resolution: undefined,
      continuation: args.continuation ?? { kind: 'mcp_held', delivery: 'held' },
      executor: args.tool.transport === 'external' ? 'caller' : 'proxy',
      resumeToken: undefined,
      createdAt: now,
      expiresAt: new Date(now.getTime() + config.expireAfterMs),
      resolvedAt: undefined,
      consumedAt: undefined,
      approver: undefined,
      history: [],
      sideEffect: args.tool.side_effect_level,
      policy: args.policy ?? policyOfTool(asNamed(args.tool)),
      onDeny: onDenyOf(args.policy ?? policyOfTool(asNamed(args.tool))),
      priorRejections:
        verdict?.kind === 'ask_again'
          ? { count: verdict.count, last_at: verdict.lastAt.toISOString() }
          : undefined,
      identityKey: identity,
      outcomeRecordId: undefined,
      resumption: undefined,
      proposal: undefined,
      preview: undefined,
      applying: false,
      explicit: args.continuation !== undefined,
      ...(args.requirements === undefined ? {} : { requirements: args.requirements }),
    };
    state.obligations.set(o.id, o);
    state.open.set(identity, o.id);
    // The defect: the creation event is sent too, with on_deny on it for every subscriber.
    if (broken('on_deny_on_creation_event_to_all')) notify(o);
    return { obligation: o, created: true };
  };

  /**
   * The fixture decision for one request. A Response is a refusal. `split` is the `batch_duplicates_split`
   * defect, which a batch passes for every element after the first.
   */
  const decide = async (c: Ctx, body: Obj, split = false): Promise<Obj | Response> => {
    const action = (body.action ?? {}) as Obj;
    const actor = isObj(body.actor) ? body.actor : {};
    const digest = await digestOf(action);
    const base = { action_digest: digest, enforced: true };
    const tool = callableToolOf(c, String(action.tool_ref));
    if (tool === undefined) {
      return {
        decision: 'deny',
        reason: 'unknown_tool',
        ...base,
      };
    }
    // Rev 16: a call a rule-bearing policy matches is decided by composing the policies that match it.
    const ruled = ruledDecision(c, body, tool);
    const policy =
      ruled === undefined
        ? policyMember(asNamed(tool), broken('null_policy_on_default'))
        : { policy: { ...ruled.policy, side_effect_level: tool.side_effect_level } };
    const mode: string = ruled?.mode ?? tool.mode;
    // Rev 16: a step-up names the facts whose absence made a contributing policy ask.
    const missing =
      ruled?.missing_facts === undefined ? {} : { missing_facts: ruled.missing_facts };
    if (mode === 'deny' || mode === 'not_granted')
      return { decision: 'deny', reason: mode, ...policy, ...base };
    // Rev 11: a call that opens no approval and needs a link the caller cannot use is refused for it.
    if (mode === 'always_allow' && blockingConnection(tool, principalOf(c)) !== undefined)
      return { decision: 'deny', reason: 'credential_link_required', ...policy, ...base };
    if (mode === 'always_allow') return { decision: 'allow', ...policy, ...base };
    // The defect: a policy `ask` is denied on the two channels with no one at the keyboard.
    const channel = isObj(body.context) ? body.context.invocation_channel : undefined;
    if (broken('headless_ask_denied') && (channel === 'headless' || channel === 'workflow'))
      return { decision: 'deny', reason: 'not_granted', ...policy, ...base };
    // A deployment that does not serve approvals opens no obligation: the step-up carries no handle,
    // and a continuation (which has nowhere to be kept) is refused. The defect accepts and ignores it.
    if (!served.has('approvals')) {
      if (continuationOf(body) !== undefined && !broken('accept_continuation_without_approvals')) {
        return problem(
          c,
          422,
          'continuation_unsupported',
          'This deployment does not serve approvals, so it cannot store a continuation.'
        );
      }
      return { decision: 'step_up', reason: 'approval_required', ...policy, ...missing, ...base };
    }
    const scope = resolveScope(c, actor.run_id);
    if (scope instanceof Response) return scope;
    const continuation = continuationOf(body);
    const refused = guardContinuation(c, continuation);
    if (refused !== undefined) return refused;
    const opened = openObligation(c, {
      tool,
      digest,
      scope,
      continuation,
      // Rev 13: display follows identity. A bound service principal's approval names its bound agent and the
      // hint is ignored; an unbound caller's hint is shown as before. The defect shows the hint first.
      agentId: broken('approval_names_hinted_agent')
        ? ((typeof actor.agent_id === 'string' ? actor.agent_id : undefined) ??
          boundAgentOf(principalOf(c)))
        : (boundAgentOf(principalOf(c)) ??
          (typeof actor.agent_id === 'string' ? actor.agent_id : undefined)),
      arguments: isObj(action.arguments) ? action.arguments : undefined,
      door: 'decisions',
      split,
      ...(ruled === undefined
        ? {}
        : {
            policy: ruled.policy,
            ...(ruled.requirements === undefined ? {} : { requirements: ruled.requirements }),
          }),
    });
    if (opened instanceof Response) return opened;
    // The rejected-duplicate rule: a deny that names the rejection and opens nothing. The defect answers a
    // plain deny that names neither the reason nor the rejection.
    if ('rejectedDuplicate' in opened)
      return broken('rejected_duplicate_reason_missing')
        ? { decision: 'deny', reason: 'deny', ...policy, ...base }
        : {
            decision: 'deny',
            reason: 'rejected_duplicate',
            ...policy,
            rejected_approval_id: opened.rejectedDuplicate.approvalId,
            ...base,
          };
    const { obligation, created } = opened;
    if (typeof body.expect_approval_id === 'string' && body.expect_approval_id !== obligation.id) {
      state.mismatches.push({ id: obligation.id, expected: body.expect_approval_id });
    }
    if (obligation.state === 'approved') {
      // The gateway admits a proxied call only for an obligation created under run scope; a principal-scoped
      // one can never be admitted, so the decision stays a step-up (rev 7). The defect answers allow anyway.
      if (
        obligation.executor === 'proxy' &&
        (obligation.runId !== undefined || broken('principal_scoped_proxy_allowed')) &&
        // Rev 11: nothing is executed while the creator's link blocks the call.
        blockedOn(obligation) === undefined
      ) {
        return { decision: 'allow', ...policy, approval: handleOf(obligation, false), ...base };
      }
      if (broken('decide_consumes') && obligation.executor !== 'proxy') {
        obligation.state = 'consumed';
        clearArguments(obligation);
        obligation.consumedAt = state.now();
        state.lastConsumed.set(obligation.identityKey, obligation.consumedAt);
      }
    }
    return {
      decision: 'step_up',
      reason: 'approval_required',
      ...policy,
      ...missing,
      approval: handleOf(obligation, created),
      ...base,
    };
  };

  app.post('/v1/decisions', async (c) => {
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const decision = await decide(c, parsed.body);
    return decision instanceof Response ? decision : ok(c, decision);
  });

  /**
   * `batch_too_large` when `count` is above the limit this deployment advertises. Only a batch the
   * schema accepts (at most 100) gets here. The defect advertises the limit and does not enforce it.
   */
  const batchTooLarge = (
    c: Ctx,
    count: number,
    limit: number | undefined
  ): Response | undefined => {
    if (limit === undefined || count <= limit || broken('batch_limit_not_enforced'))
      return undefined;
    return problem(
      c,
      400,
      'batch_too_large',
      `This deployment accepts at most ${String(limit)} items in a batch.`,
      { max_items: limit }
    );
  };

  app.post('/v1/decisions/batch', async (c) => {
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const refusal = batchTooLarge(c, (parsed.body.requests as Obj[]).length, limits.decisions);
    if (refusal !== undefined) return refusal;
    // In order, so identical elements are one obligation: the first opens or joins it, the rest join it
    // (or are denied with it under the rejected-duplicate rule). The defect opens one per element.
    const decisions: Obj[] = [];
    for (const [i, item] of (parsed.body.requests as Obj[]).entries()) {
      const decision = await decide(c, item, i > 0 && broken('batch_duplicates_split'));
      if (decision instanceof Response) return decision;
      decisions.push(decision);
    }
    return ok(c, { decisions });
  });

  // ---- AuthZEN -------------------------------------------------------------------------------
  app.get('/.well-known/authzen-configuration', (c) => {
    const origin = new URL(c.req.url).origin;
    if (broken('authzen_discovery_broken')) {
      return c.json({
        policy_decision_point: origin,
        access_evaluation_endpoint: '/not/the/endpoint',
      } as never);
    }
    return c.json({
      policy_decision_point: origin,
      access_evaluation_endpoint: `${origin}/access/v1/evaluation`,
    } as never);
  });

  app.post('/access/v1/evaluation', async (c) => {
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const resource = parsed.body.resource as Obj;
    const context = isObj(parsed.body.context) ? parsed.body.context : {};
    const action: Obj = { tool_ref: resource.id };
    if (
      typeof (parsed.body.action as Obj).name === 'string' &&
      (parsed.body.action as Obj).name !== 'invoke'
    ) {
      action.method = (parsed.body.action as Obj).name;
    }
    if (typeof context.arg_digest === 'string') action.arg_digest = context.arg_digest;
    else if (context.arguments !== undefined) action.arguments = context.arguments;
    const decision = await decide(c, { action });
    if (decision instanceof Response) return decision;
    return c.json({
      decision: decision.decision === 'allow',
      context: { noblecloak: decision },
    } as never);
  });

  // ---- approvals -----------------------------------------------------------------------------
  /** The `name` of the obligation's agent, read only from an agent of the obligation's organisation. */
  const agentNameOf = (o: Obligation): Obj => {
    const agent = o.agentId === undefined ? undefined : state.agents.get(o.agentId);
    if (agent?.org !== o.org || typeof agent.name !== 'string') return {};
    // The defect gives the id where the name should be.
    return { name: broken('agent_name_is_the_id') ? agent.id : agent.name };
  };

  /** The parent of the obligation's agent, read only from an agent of the obligation's organisation. */
  const parentOf = (o: Obligation): string | null => {
    const agent = o.agentId === undefined ? undefined : state.agents.get(o.agentId);
    return agent?.org === o.org ? ((agent.parent_id as string | null | undefined) ?? null) : null;
  };

  /**
   * The continuation an approval echoes: the one it was opened with, with its members reversed when the
   * mock is built to reorder them. The defect returns the continuation of another approval of the same
   * creator whose continuation differs, as a store that mixes up its rows would.
   */
  const echoedContinuation = (o: Obligation): unknown => {
    const other = broken('continuation_cross_wired')
      ? [...state.obligations.values()].find(
          (x) =>
            x.id !== o.id &&
            x.org === o.org &&
            x.creatorSub === o.creatorSub &&
            (x as Obligation & { explicit?: boolean }).explicit === true &&
            jcs(x.continuation as unknown as JsonValue) !==
              jcs(o.continuation as unknown as JsonValue)
        )
      : undefined;
    const sent = other?.continuation ?? o.continuation;
    return options.reorderContinuation === true ? reverseMembers(sent) : sent;
  };

  /** The policy an approval names. The defect names the default for an approval the default decided. */
  const policyOfApproval = (o: Obligation): Obligation['policy'] =>
    o.policy ?? (broken('policy_synthesised_on_default_approval') ? DEFAULT_POLICY : undefined);

  /**
   * Whether `reader` is shown the arguments of `o`: only on the single read, only while the tool shows its
   * arguments to approvers (read now), and only to the approval's creator or a principal eligible to
   * approve it. Each defect drops one of the conditions.
   */
  const mayShowArguments = (o: Obligation, reader: Principal, singleRead: boolean): boolean => {
    const tool = toolOfApproval(o);
    const optedIn =
      tool?.show_arguments_to_approvers === true ||
      broken('arguments_without_opt_in') ||
      broken('arguments_kept_when_setting_off');
    const creator = o.org === reader.org && o.creatorSub === reader.sub;
    return (
      (singleRead || broken('arguments_beyond_the_single_read')) &&
      optedIn &&
      (creator || isEligible(reader, o) || broken('arguments_to_ineligible_reader'))
    );
  };

  /**
   * A reference to a principal, with the name the mock knows it by. The defect names a principal by its id.
   * (The mock names every principal, so the best-effort case, a name it cannot give, does not arise.)
   */
  const refOf = (id: string, kind: string): Obj => ({
    id,
    kind,
    display_name: broken('display_name_is_the_id') ? id : nameOfSub(id),
  });

  const FINAL_STATES: readonly string[] = ['consumed', 'rejected', 'expired', 'withdrawn'];

  /**
   * Why a read shows the arguments or not (`Approval.arguments_state`). A final approval is `final` to every
   * reader. A reader who is neither the creator nor eligible to approve is otherwise `withheld`, and learns
   * nothing of the tool's setting. The creator and an eligible approver get the first of setting off, nothing
   * held, shown. The defect `arguments_state_wrong` always says `shown`; `ineligible_reader_learns_tool_setting`
   * tells every reader the setting before it withholds.
   */
  const argumentsStateOf = (o: Obligation, reader: Principal): string => {
    if (broken('arguments_state_wrong')) return 'shown';
    if (FINAL_STATES.includes(o.state)) {
      // The defect tells a reader who may not decide a final approval `withheld`, where `final` is the answer to every reader.
      const creator = o.org === reader.org && o.creatorSub === reader.sub;
      if (broken('final_state_withheld_from_ineligible') && !(creator || isEligible(reader, o)))
        return 'withheld';
      return 'final';
    }
    const tool = toolOfApproval(o);
    const setOn = tool?.show_arguments_to_approvers === true;
    if (broken('ineligible_reader_learns_tool_setting') && !setOn) return 'not_enabled';
    const creator = o.org === reader.org && o.creatorSub === reader.sub;
    if (!(creator || isEligible(reader, o) || broken('arguments_to_ineligible_reader')))
      return 'withheld';
    if (!setOn) return 'not_enabled';
    return o.arguments === undefined ? 'not_sent' : 'shown';
  };

  /**
   * `waiting_on` of a pending approval, to its creator only, and on the single read only (never a list row,
   * a stream event or another response): how many principals may resolve it and, when
   * the creator is a user, up to five of them. The count is of the principals this mock has seen call it
   * (`state.principals`), not of every member of the organisation: that is what the mock knows, and what
   * the specification says the count means is the owner's to settle. Each candidate is judged from its own
   * stored record, never from the reader's attributes. Rev 16: on an approval with requirements, the candidates are
   * those eligible for an unmet one (`mayResolveNow`). The defects: it gives it to every reader, and (the
   * second) wrong content: no one waited on; it puts it on list rows and stream events too.
   */
  const waitingOnOf = (o: Obligation, reader: Principal, singleRead: boolean): Obj | undefined => {
    const creator = o.org === reader.org && o.creatorSub === reader.sub;
    if (!singleRead && !broken('waiting_on_on_list_rows')) return undefined;
    if (o.state !== 'pending' || !(creator || broken('waiting_on_visible_to_all')))
      return undefined;
    // Best effort: with the eligibility lookup down the creator's read still succeeds, without the member.
    if (eligibilityLookupDown) return undefined;
    if (broken('waiting_on_content_wrong'))
      return o.creatorKind === 'service' ? { count: 0 } : { count: 0, principals: [] };
    const eligible = [...state.principals.values()].filter(
      (x) =>
        x.org === o.org &&
        x.kind === 'user' &&
        mayResolveNow(
          {
            sub: String(x.id),
            org: x.org,
            hasOrg: true,
            kind: 'user',
            // The roles of its latest token here: whether it is an administrator is read from them.
            scopes: scopesSeen.get(`${x.org}|${String(x.id)}`) ?? [],
            dpopBound: false,
            entitlements: [],
          },
          o
        )
    );
    const listed = eligible.slice(0, 5).map((x) => refOf(String(x.id), 'user'));
    // The defect names someone who may not decide: the creator, ahead of the eligible.
    if (broken('waiting_on_lists_ineligible') && o.creatorKind !== 'service')
      listed.unshift(refOf(o.creatorSub, 'user'));
    return {
      count: eligible.length + (broken('waiting_on_lists_ineligible') ? 1 : 0),
      ...(o.creatorKind === 'service' ? {} : { principals: listed.slice(0, 5) }),
    };
  };

  /**
   * Rev 15: one `resolve` action for each of approve and reject that the mock serves (`escalated` has no action
   * here), each with the optional note, which `POST /v1/approvals/{id}/resolve` takes as `reason`.
   */
  const availableActions = (): Obj[] =>
    AVAILABLE_ACTIONS.filter((action) => resolutionsServed.includes(action.resolution)).map(
      (action) => ({
        id: action.resolution,
        kind: 'resolve',
        label: action.label,
        resolution: action.resolution,
        inputs: [{ name: 'reason', type: 'text', label: 'Note (optional)', required: false }],
      })
    );

  /**
   * What `reader` sees of an approval. The full `continuation` is the creating principal's alone, in
   * every state; everyone else sees `continuation_kind`. The defect shows it to every reader.
   */
  const view = (
    o: Obligation,
    reader: Principal,
    singleRead = false,
    withState = singleRead
  ): Obj => {
    const out: Obj = {
      id: o.id,
      state: o.state,
      tool_ref: o.toolRef,
      obligation_kind: o.kind,
      action_digest: o.argDigest,
      scope_id: o.scopeId,
      side_effect_level: o.sideEffect,
      continuation_kind: o.continuation.kind,
      created_at: o.createdAt.toISOString(),
      expires_at: o.expiresAt.toISOString(),
      resolved_at: o.resolvedAt?.toISOString() ?? null,
      outcome_record_id: o.outcomeRecordId ?? null,
      resolution_history: o.history.map((entry) => ({
        ...entry,
        by: refOf(entry.by.id, entry.by.kind),
      })),
    };
    if (!broken('requester_missing')) out.requester = refOf(o.creatorSub, o.creatorKind);
    if (withState) out.arguments_state = argumentsStateOf(o, reader);
    const waiting = waitingOnOf(o, reader, singleRead);
    if (waiting !== undefined) out.waiting_on = waiting;
    if (o.resolution !== undefined) out.resolution = o.resolution;
    const policy = policyOfApproval(o);
    if (policy !== undefined) out.policy = policy;
    // The creator's alone, on every representation it reads; the defect gives it to every reader.
    if (
      o.onDeny !== undefined &&
      ((o.org === reader.org && o.creatorSub === reader.sub) || broken('on_deny_visible_to_all'))
    )
      out.on_deny = o.onDeny;
    // Every reader who sees the approval, on every representation.
    if (o.priorRejections !== undefined) out.prior_rejections = o.priorRejections;
    // Rev 11: the creator's alone (the defect shows it to every reader); a stream event drops it.
    const blocked = blockedOn(o);
    if (
      blocked !== undefined &&
      ((o.org === reader.org && o.creatorSub === reader.sub) ||
        broken('blocked_on_shown_to_others'))
    )
      out.blocked_on = blocked;
    if (o.arguments !== undefined && mayShowArguments(o, reader, singleRead))
      out.arguments = o.arguments;
    // Rev 14: what approving would change, on the single read of a pending approval, to a reader who may approve
    // it. The defect shows it to every reader who sees the approval.
    if (
      o.preview !== undefined &&
      singleRead &&
      o.state === 'pending' &&
      (isEligible(reader, o) || broken('preview_shown_to_all'))
    )
      out.preview = o.preview;
    // Rev 15: what the reader may do on this approval, on the single read of a pending approval, to a reader who may
    // resolve it: an eligible user whose token carries the resolve scope, as resolving asks. The defect shows it
    // to every reader who sees the approval. When the mock serves no resolution that has an action, the member is
    // omitted rather than sent empty.
    // The defects: `available_actions_shown_when_resolved` drops the pending gate,
    // `available_actions_shown_without_resolve_scope` the scope gate, `available_actions_shown_to_members` the
    // eligibility gate for a member who is not eligible (and not the creator), and `available_actions_shown_to_all`
    // the eligibility and scope gates together.
    if (singleRead && (o.state === 'pending' || broken('available_actions_shown_when_resolved'))) {
      const actions = availableActions();
      if (
        actions.length > 0 &&
        ((mayResolveNow(reader, o) &&
          (reader.scopes.includes(USER_RESOLVE_SCOPE) ||
            broken('available_actions_shown_without_resolve_scope'))) ||
          (reader.sub === MEMBER && broken('available_actions_shown_to_members')) ||
          broken('available_actions_shown_to_all'))
      )
        out.available_actions = actions;
    }
    // Rev 16: the requirements, on every representation to every reader who sees the approval, with each approval
    // that counts toward one naming its approver.
    if (o.requirements !== undefined && requirementsServed())
      out.requirements = o.requirements.map((r) => ({
        ...r,
        policies: r.policies.map((policy) => ({ ...policy })),
        approvals: r.approvals.map((a) => ({ ...a, by: refOf(a.by.id, a.by.kind) })),
      }));
    if (o.agentId !== undefined)
      out.agent = {
        id: o.agentId,
        ...agentNameOf(o),
        parent: parentOf(o),
      };
    if (o.runId !== undefined && o.runKind !== undefined)
      out.run = { id: o.runId, kind: o.runKind };
    if (o.approver !== undefined) out.approver = refOf(o.approver.id, o.approver.kind);
    // Echoed as it was sent: an approval opened without a continuation has none to echo, though its
    // continuation_kind reads mcp_held.
    if (
      (o as Obligation & { explicit?: boolean }).explicit === true &&
      ((o.org === reader.org && o.creatorSub === reader.sub) ||
        broken('continuation_visible_to_all'))
    )
      out.continuation = echoedContinuation(o);
    return out;
  };

  /**
   * Whether `reader` may see the approval at all. A user principal sees its organisation's; a service
   * principal sees only what it created. The defect gives a service principal the organisation's view.
   */
  const seesApproval = (reader: Principal, o: Obligation): boolean =>
    (broken('ignore_org_scope') || o.org === reader.org) &&
    (reader.kind !== 'service' ||
      o.creatorSub === reader.sub ||
      broken('service_principal_sees_org_approvals'));

  /**
   * The `created_by` query parameter: `me` or nothing. Any other value is 400. The defect ignores the
   * parameter altogether, its value included.
   */
  const createdByMe = (c: Ctx): boolean | Response => {
    const value = c.req.query('created_by');
    if (value === undefined || broken('created_by_filter_ignored')) return false;
    if (value !== 'me')
      return problem(c, 400, 'invalid_request', 'created_by takes the single value me.');
    return true;
  };

  const APPROVAL_STATES: readonly string[] = [
    'pending',
    'approved',
    'rejected',
    'consumed',
    'expired',
    'withdrawn',
  ];

  /**
   * The `state` query parameter of the list and the stream: one state or a comma-separated set. Any value
   * that is not a state is 400. The defect reads the whole value as one state, so a set matches nothing.
   */
  const stateSet = (c: Ctx): readonly string[] | undefined | Response => {
    const raw = c.req.query('state');
    if (raw === undefined) return undefined;
    if (broken('state_set_ignored')) return [raw];
    const states = raw.split(',');
    const bad = states.find((x) => !APPROVAL_STATES.includes(x));
    if (bad !== undefined)
      return problem(c, 400, 'invalid_request', `state takes approval states, not ${bad}.`);
    return states;
  };

  /** The `approver` query parameter: `me` or nothing. Any other value is 400. */
  const approverMe = (c: Ctx): boolean | Response => {
    const value = c.req.query('approver');
    if (value === undefined) return false;
    if (value !== 'me')
      return problem(c, 400, 'invalid_request', 'approver takes the single value me.');
    return true;
  };

  /** The approval a write names: its organisation's, whoever the caller is. */
  const find = (c: Ctx, id: string = c.req.param('id') ?? ''): Obligation | undefined => {
    const o = state.obligations.get(id);
    if (o === undefined) return undefined;
    if (!visible(c, o.org)) return undefined;
    expireIfDue(o);
    return o;
  };

  /** The approval a read names: what the caller may see of it, else undefined (a 404). */
  const findRead = (c: Ctx): Obligation | undefined => {
    const o = find(c);
    return o !== undefined && seesApproval(principalOf(c), o) ? o : undefined;
  };

  app.post('/v1/approvals', async (c) => {
    const parsed = await validatedBody(c, (body) =>
      'approval_id' in body && !broken('accept_approval_id_on_create')
        ? problem(
            c,
            400,
            'identity_not_accepted',
            'An approval id is an identity assertion and is not accepted from a body.'
          )
        : undefined
    );
    if ('response' in parsed) return parsed.response;
    const body = parsed.body;
    const action = body.action as Obj;
    // Rev 14: a reference in the reserved namespace is no tool. The deployment checks the proposal it carries.
    const proposed = isDeploymentApplied(String(action.tool_ref))
      ? await vetProposal(c, action)
      : undefined;
    if (proposed instanceof Response) return proposed;
    const tool = proposed?.tool ?? callableToolOf(c, String(action.tool_ref));
    if (tool === undefined) {
      const detail = `Unknown or withdrawn tool ${String(action.tool_ref)}: register it with POST /v1/tools.`;
      // The defect: the refusal is the generic 400 a caller cannot tell from a malformed request.
      return broken('approval_unroutable_generic')
        ? problem(c, 400, 'invalid_request', detail)
        : problem(c, 422, 'approval_unroutable', detail);
    }
    const continuation = continuationOf(body);
    const refused = guardContinuation(c, continuation);
    if (refused !== undefined) return refused;
    const scope = resolveScope(c, body.run_id);
    if (scope instanceof Response) return scope;
    // Rev 16: the requirements a step-up of the same call would carry, from the policies that match it, so that an
    // approval opened here is routed as one a decision opens. A proposal is no tool a policy governs.
    const ruled = proposed === undefined ? ruledDecision(c, body, tool) : undefined;
    const opened = openObligation(c, {
      tool,
      digest: await digestOf(action),
      scope,
      continuation,
      // A proposal names its agent for the approvers; any other approval opened here names none.
      agentId: proposed?.proposal.agent?.id,
      arguments: isObj(action.arguments) ? action.arguments : undefined,
      door: 'approvals',
      ...(ruled?.requirements === undefined
        ? {}
        : { policy: ruled.policy, requirements: ruled.requirements }),
    });
    if (opened instanceof Response) return opened;
    if ('rejectedDuplicate' in opened)
      return problem(
        c,
        409,
        'rejected_duplicate',
        'An identical call was rejected within the window of the duplicate-requests policy.',
        broken('rejected_duplicate_reason_missing')
          ? {}
          : { rejected_approval_id: opened.rejectedDuplicate.approvalId }
      );
    if (proposed !== undefined && opened.created) {
      opened.obligation.proposal = proposed.proposal;
      opened.obligation.preview = proposed.preview;
      opened.obligation.entitlementsAtOpen = proposed.entitlements;
    }
    return ok(c, handleOf(opened.obligation, opened.created), opened.created ? 201 : 200);
  });

  app.get('/v1/approvals/stream', (c) => {
    const p = principalOf(c);
    const mine = createdByMe(c);
    if (mine instanceof Response) return mine;
    // The defect: the parameter is ignored altogether, its value included, and the organisation's events
    // are delivered regardless.
    const asApprover = broken('stream_approver_filter_ignored') ? false : approverMe(c);
    if (asApprover instanceof Response) return asApprover;
    const states = stateSet(c);
    if (states instanceof Response) return states;
    // The filter is eligibility, which does not depend on the state: the event that resolves an approval
    // the caller may resolve still arrives.
    const wants = (o: Obligation): boolean =>
      (!asApprover || isEligible(p, o)) && (states === undefined || states.includes(o.state));
    const encoder = new TextEncoder();
    let cleanup = (): void => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': connected\n\n'));
        const listener = (o: Obligation): void => {
          if (!seesApproval(p, o) || (mine && o.creatorSub !== p.sub) || !wants(o)) return;
          // The defect: a stream event gives on_deny to every subscriber (the reads still keep it to the creator).
          // Rev 11: blocked_on is never on a stream event.
          const seen = without(view(o, p), 'blocked_on');
          const event =
            (broken('on_deny_on_stream_to_all') ||
              (broken('on_deny_on_creation_event_to_all') && o.state === 'pending')) &&
            o.onDeny !== undefined
              ? { ...seen, on_deny: o.onDeny }
              : seen;
          controller.enqueue(
            encoder.encode(`event: approval.updated\ndata: ${JSON.stringify(event)}\n\n`)
          );
        };
        state.listeners.add(listener);
        cleanup = () => state.listeners.delete(listener);
      },
      cancel: () => {
        cleanup();
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  });

  app.get('/v1/approvals', (c) => {
    const p = principalOf(c);
    const q = c.req.query();
    const mine = createdByMe(c);
    if (mine instanceof Response) return mine;
    const states = stateSet(c);
    if (states instanceof Response) return states;
    const order = c.req.query('order') ?? 'created_at';
    if (order !== 'created_at' && order !== 'resolved_at')
      return problem(c, 400, 'invalid_request', 'order is created_at or resolved_at.');
    let rows = [...state.obligations.values()].filter((o) => seesApproval(p, o));
    rows.forEach(expireIfDue);
    if (mine) rows = rows.filter((o) => o.creatorSub === p.sub);
    if (states !== undefined) rows = rows.filter((o) => states.includes(o.state));
    if (q.scope !== undefined) rows = rows.filter((o) => o.scopeId === q.scope);
    // Eligibility to resolve does not depend on the state (the document says so), so a resolved approval stays listed.
    const asApprover = approverMe(c);
    if (asApprover instanceof Response) return asApprover;
    if (asApprover) rows = rows.filter((o) => isEligible(p, o));
    if (q.outcome === 'missing')
      rows = rows.filter((o) => o.state === 'consumed' && o.outcomeRecordId === undefined);
    // `resolved_at` returns only what has been resolved, newest resolution first. The defect orders by creation.
    if (order === 'resolved_at' && !broken('order_ignored')) {
      rows = rows.filter((o) => o.resolvedAt !== undefined);
      rows.sort((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0));
    } else rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return paged(
      c,
      rows.map((o) => view(o, p, false, !broken('list_arguments_state_missing')))
    );
  });

  const paged = (c: Ctx, rows: Obj[]): Response => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const start = Number(c.req.query('cursor') ?? 0) || 0;
    const slice = rows.slice(start, start + limit);
    const next = start + limit < rows.length ? String(start + limit) : null;
    return ok(c, slice, 200, { cursor: c.req.query('cursor') ?? null, next });
  };

  app.get('/v1/approvals/:id/wait', async (c) => {
    const o = findRead(c);
    if (o === undefined) return problem(c, 404, 'not_found');
    const seconds = Math.min(Number(c.req.query('timeout') ?? 30) || 0, 55);
    if (o.state === 'pending' && seconds > 0) {
      await new Promise<void>((resolve) => {
        const set = state.waiters.get(o.id) ?? new Set<() => void>();
        state.waiters.set(o.id, set);
        const timer = setTimeout(done, seconds * 1000);
        function done(): void {
          clearTimeout(timer);
          set.delete(done);
          resolve();
        }
        set.add(done);
      });
    }
    expireIfDue(o);
    return ok(c, view(o, principalOf(c)));
  });

  app.get('/v1/approvals/:id/resumption', async (c) => {
    const o = findRead(c);
    if (o === undefined) return problem(c, 404, 'not_found');
    const p = principalOf(c);
    if (o.creatorSub !== p.sub && !broken('resumption_open_to_approver')) {
      return problem(
        c,
        403,
        'not_owner',
        'Only the principal that created the obligation may read its Resumption.'
      );
    }
    if (o.state === 'consumed') return problem(c, 409, 'already_resumed');
    if (o.state === 'expired') return problem(c, 409, 'obligation_expired');
    if (o.state === 'withdrawn' && !broken('resumption_after_withdraw'))
      return problem(c, 409, 'obligation_withdrawn');
    if (o.resumption === undefined)
      return problem(c, 404, 'not_found', 'The approval has not been resolved yet.');
    // Rev 11: no Resumption while the call waits on its creator's credential link.
    if (blockedOn(o) !== undefined)
      return problem(
        c,
        404,
        'not_found',
        "The call waits on its creator's credential link (blocked_on); there is no Resumption yet."
      );
    // Rev 11: an approval approved while blocked on its creator's link gets its resume token once the link is usable.
    if (
      o.state === 'approved' &&
      o.executor === 'caller' &&
      o.resumeToken === undefined &&
      blockedOn(o) === undefined
    ) {
      o.resumeToken = `rt_${crypto.randomUUID()}`;
      o.resumption = await mintResumption(o);
    }
    const continuationExpiry = o.continuation.expires_at;
    if (
      continuationExpiry !== undefined &&
      Date.parse(continuationExpiry) <= state.now().getTime()
    ) {
      return problem(c, 409, 'continuation_expired');
    }
    return ok(c, o.resumption);
  });

  app.get('/v1/approvals/:id', (c) => {
    const o = findRead(c);
    // The defect turns the best-effort `waiting_on` into a failure of the creator's own read.
    if (
      o !== undefined &&
      eligibilityLookupDown &&
      broken('waiting_on_fails_the_read') &&
      o.state === 'pending' &&
      o.creatorSub === principalOf(c).sub
    )
      return serverProblem(c, 503, undefined, 'eligibility_lookup');
    return o === undefined ? problem(c, 404, 'not_found') : ok(c, view(o, principalOf(c), true));
  });

  /**
   * Rev 12: queues one signed delivery of an event for each `active` webhook of the organisation that
   * subscribes to `type`. One signature serves them all, and the body names no subscriber. The mock never
   * calls the webhook's URL. The defects: a delivery is unsigned, a webhook receives another organisation's events, the signature does not cover `data`, `data`
   * carries `arguments`, and a `disabled` webhook still receives.
   */
  const emitEvent = (org: string, type: string, subject: string, data: Obj): void => {
    const subscribers = [...state.webhooks.values()].filter(
      (hook) =>
        (hook.org === org || broken('webhook_delivery_ignores_org')) &&
        (hook.events as string[]).includes(type) &&
        (hook.state !== 'disabled' || broken('disabled_webhook_delivered'))
    );
    if (subscribers.length === 0) return;
    const event: Obj = {
      specversion: '1.0',
      id: `evt_${crypto.randomUUID()}`,
      type,
      source: config.audience,
      subject,
      time: state.now().toISOString(),
      datacontenttype: 'application/json',
      data: broken('delivery_carries_arguments')
        ? { ...data, arguments: {} }
        : broken('webhook_data_extra_member')
          ? { ...data, config: {} }
          : data,
    };
    const covered = broken('delivery_signature_skips_data') ? { ...event, data: {} } : event;
    const signature = broken('delivery_unsigned')
      ? Promise.resolve('unsigned')
      : signJws(covered as JsonValue, signingKey);
    // The signature is awaited only when a control step reads the outbox; this keeps a failed signing from
    // surfacing as an unhandled rejection before then (the read still rejects).
    signature.catch(() => undefined);
    for (const hook of subscribers)
      state.outbox.push({ webhookId: String(hook.id), event, signature });
    // Bounded: the oldest entries go first, as the mock never sends them anywhere.
    if (state.outbox.length > OUTBOX_LIMIT)
      state.outbox.splice(0, state.outbox.length - OUTBOX_LIMIT);
  };

  const mintResumption = async (o: Obligation): Promise<Obj> => {
    const payload: Obj = {
      approval_id: o.id,
      action_id: `act_${o.argDigest.slice(0, 12)}`,
      tool_ref: o.toolRef,
      obligation_kind: o.kind,
      resolution: o.resolution ?? 'approved',
      action_digest: o.argDigest,
      // The Resumption names its approver by id and kind only. The defect adds the name.
      approver: broken('names_leak_into_records')
        ? refOf(o.approver?.id ?? 'unknown', o.approver?.kind ?? 'user')
        : (o.approver ?? { id: 'unknown', kind: 'user' }),
      resolved_at: (o.resolvedAt ?? state.now()).toISOString(),
      expires_at: o.expiresAt.toISOString(),
      ...(policyOfApproval(o) === undefined ? {} : { policy: policyOfApproval(o) }),
      continuation: echoedContinuation(o),
    };
    const wantsToken = broken('external_tool_no_resume_token')
      ? false
      : broken('proxy_tool_resume_token')
        ? true
        : o.executor === 'caller';
    if (wantsToken && o.resumeToken !== undefined) payload.resume_token = o.resumeToken;
    const signed = broken('unbound_resumption_signature')
      ? { ...payload, tool_ref: 'other:tool', action_digest: '0'.repeat(64) }
      : payload;
    const key = broken('sign_unlisted_key') ? unlistedKey : signingKey;
    return { ...payload, signature: await signJws(signed as JsonValue, key) };
  };

  /**
   * The resolve scope: a user's or an agent's token without it is 403 `insufficient_scope`, before the body, the
   * approval or eligibility is looked at. Only a service principal is not asked (it never resolves;
   * eligibility refuses it). The break `resolve_without_scope_allowed` skips the check.
   */
  const missingResolveScope = (c: Ctx): Response | undefined => {
    const p = principalOf(c);
    if (p.kind === 'service' || p.scopes.includes(USER_RESOLVE_SCOPE)) return undefined;
    if (broken('resolve_without_scope_allowed')) return undefined;
    return problem(
      c,
      403,
      'insufficient_scope',
      `A user's token must carry the ${USER_RESOLVE_SCOPE} scope to resolve an approval.`
    );
  };

  const resolveWith = async (
    c: Ctx,
    o: Obligation,
    resolution: string,
    reason: string | undefined,
    digest: string,
    skipEligibility = false
  ): Promise<Response> => {
    const p = principalOf(c);
    // A resolution the deployment does not serve is refused (`Capabilities.resolutions` says which it can produce).
    // (A value outside the contract's three reaches here only with request validation off, and is left to the caller.)
    if (
      ['approved', 'rejected', 'escalated'].includes(resolution) &&
      !resolutionsServed.includes(resolution) &&
      !broken('unserved_resolution_accepted')
    )
      return problem(
        c,
        400,
        'invalid_request',
        `This deployment does not serve the ${resolution} resolution.`
      );
    // Two separate rules, each with its own break: a service principal never resolves, and the
    // principal that created an obligation never resolves its own. Rev 16: while the approval is pending, the
    // caller must be eligible for an unmet requirement; once it is not, for any, so that a repeat is the conflict
    // below rather than 403.
    const eligible = o.state === 'pending' ? mayResolveNow(p, o, true) : isEligible(p, o, true);
    if (!skipEligibility && !eligible)
      return problem(
        c,
        403,
        'not_eligible',
        'The principal that created an obligation, a service principal and a user who may not approve cannot resolve it.'
      );
    if (digest !== o.argDigest && !broken('ignore_stale_digest')) {
      return problem(
        c,
        409,
        'approval_conflict',
        'expected_action_digest does not match the approval.'
      );
    }
    if (o.state === 'expired') return problem(c, 409, 'obligation_expired');
    // An approval being applied is already resolved for every other request: applying awaits, and nothing else
    // may pass the check above until its state is written.
    if (o.state !== 'pending' || o.applying) return problem(c, 409, 'already_resolved');
    const at = stamp();
    // Rev 16: an approve satisfies every unmet requirement the approver is eligible for; while one is still unmet the
    // approval stays pending, and the change is an `approval.updated` of the stream. A reject rejects it outright.
    // The defect approves the whole approval on the first approve.
    if (o.requirements !== undefined && resolution === 'approved') {
      for (const r of o.requirements) {
        const basis = r.met ? undefined : eligibleFor(p, o, r);
        if (basis === undefined) continue;
        r.approvals.push({ by: { id: p.sub, kind: p.kind }, at: at.toISOString(), basis });
        r.met = r.approvals.length >= r.needed;
      }
      if (o.requirements.some((r) => !r.met) && !broken('partial_approve_resolves')) {
        notify(o);
        return ok(c, view(o, p));
      }
    }
    // Rev 14: approving a deployment-applied approval applies its change, all or nothing. When the deployment
    // refuses to apply it, the approval is rejected, by the administrator whose approval it refused, with the
    // reason in the history entry. The defect applies the change on a denial too.
    let resolved = resolution;
    let why = reason;
    let applied = false;
    let refusedToApply = false;
    if (
      o.proposal !== undefined &&
      (resolution === 'approved' || (resolution === 'rejected' && broken('proposal_deny_applies')))
    ) {
      o.applying = true;
      let refusal: Refusal | undefined;
      try {
        refusal = await applyProposal(c, o, o.proposal);
      } finally {
        o.applying = false;
      }
      applied = refusal === undefined;
      if (refusal !== undefined && resolution === 'approved') {
        refusedToApply = true;
        resolved = 'rejected';
        why = broken('proposal_refusal_reason_missing')
          ? undefined
          : `proposal_refused:${refusal.code}`;
      }
    }
    o.history.push({
      resolution: resolved,
      by: { id: p.sub, kind: p.kind },
      at: at.toISOString(),
      ...(why === undefined ? {} : { reason: why }),
    });
    o.resolution = resolved;
    if (resolved === 'escalated') {
      notify(o);
      return ok(c, view(o, p));
    }
    o.state = resolved === 'approved' ? 'approved' : 'rejected';
    if (o.state === 'rejected') {
      clearArguments(o);
      // A resolver's rejection, which the rejected-duplicate rule counts. A refusal to apply is the
      // deployment's, not a resolver's: the same proposal may be opened again once what refused it is fixed.
      if (!refusedToApply) {
        const list = state.rejections.get(o.identityKey) ?? [];
        list.push({ id: o.id, at });
        state.rejections.set(o.identityKey, list);
      }
    }
    o.approver = { id: p.sub, kind: p.kind };
    o.resolvedAt = at;
    // Rev 11: no resume token while the call waits on its creator's link; the Resumption read issues it later.
    if (
      o.state === 'approved' &&
      (o.executor === 'caller' || broken('proxy_tool_resume_token')) &&
      blockedOn(o) === undefined
    )
      o.resumeToken = `rt_${crypto.randomUUID()}`;
    o.resumption = await mintResumption(o);
    // A resolution outside `DELIVERABLE_RESOLUTIONS` is never delivered (the mock produces none today).
    if (isDeliverableResolution(resolved))
      emitEvent(o.org, 'approval.resolved', o.id, {
        approval_id: o.id,
        state: o.state,
        resolution: resolved,
        resolved_at: at.toISOString(),
        tool_ref: o.toolRef,
      });
    if (o.proposal !== undefined) {
      // Nothing resumes after a deployment-applied change: it is consumed at once. The defect leaves it approved.
      if (applied && o.state === 'approved' && !broken('proposal_not_consumed')) {
        o.state = 'consumed';
        o.consumedAt = state.now();
        state.lastConsumed.set(o.identityKey, o.consumedAt);
        clearArguments(o);
      }
    }
    notify(o);
    return ok(c, view(o, p));
  };

  app.post('/v1/approvals/:id/resolve', async (c) => {
    const refused = missingResolveScope(c);
    if (refused !== undefined) return refused;
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const o = find(c);
    if (o === undefined) return problem(c, 404, 'not_found');
    const b = parsed.body;
    return resolveWith(
      c,
      o,
      String(b.resolution),
      b.reason as string | undefined,
      String(b.expected_action_digest)
    );
  });
  for (const [route, resolution] of [
    ['approve', 'approved'],
    ['deny', 'rejected'],
  ] as const) {
    app.post(`/v1/approvals/:id/${route}`, async (c) => {
      const refused = missingResolveScope(c);
      if (refused !== undefined) return refused;
      const parsed = await validatedBody(c);
      if ('response' in parsed) return parsed.response;
      const o = find(c);
      if (o === undefined) return problem(c, 404, 'not_found');
      return resolveWith(
        c,
        o,
        resolution,
        parsed.body.reason as string | undefined,
        String(parsed.body.expected_action_digest)
      );
    });
  }

  app.post('/v1/approvals/resolve/batch', async (c) => {
    const refused = missingResolveScope(c);
    if (refused !== undefined) return refused;
    // The defect applies what it can: the body is not validated as a whole, so an element that is not a
    // resolution is answered on its own while the others are applied, and an empty batch is served.
    const partial = broken('resolve_batch_applies_partial_body');
    const parsed = partial
      ? { body: (await c.req.json().catch(() => ({}))) as Obj }
      : await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const items = (parsed.body.items ?? []) as Obj[];
    // The limit is the deployment's own; the defect advertises it and does not enforce it.
    if (
      limits.resolutions !== undefined &&
      items.length > limits.resolutions &&
      !broken('resolve_batch_over_limit_accepted')
    )
      return problem(
        c,
        400,
        'batch_too_large',
        `This deployment accepts at most ${String(limits.resolutions)} items in a batch.`,
        { max_items: limits.resolutions }
      );
    // A service principal never resolves: the call is refused whole, whoever created the approvals.
    if (principalOf(c).kind === 'service' && !broken('allow_service_resolve'))
      return problem(c, 403, 'not_eligible', 'A service principal cannot resolve an approval.');
    const results: Obj[] = [];
    const answeredFor = new Map<string, Obj>();
    for (const item of items) {
      // The defect answers a repeat of an id with the first answer again, as if it were applied once more.
      const earlier = answeredFor.get(String(item.approval_id));
      if (earlier !== undefined && broken('resolve_batch_repeat_answered_as_applied')) {
        results.push(earlier);
        continue;
      }
      // The defect reads the store directly, so another organisation's approval is reachable.
      const o = broken('resolve_batch_reaches_other_orgs')
        ? state.obligations.get(String(item.approval_id))
        : find(c, String(item.approval_id));
      const response =
        partial && typeof item.resolution !== 'string'
          ? problem(c, 400, 'invalid_request')
          : o === undefined
            ? problem(c, 404, 'not_found')
            : await resolveWith(
                c,
                o,
                String(item.resolution),
                item.reason as string | undefined,
                String(item.expected_action_digest),
                broken('resolve_batch_skips_eligibility')
              );
      const body = (await response.json()) as Obj;
      if (response.status === 200) {
        results.push(body.data as Obj);
        answeredFor.set(String(item.approval_id), body.data as Obj);
      } else if (broken('resolve_batch_aborts_on_first_error')) {
        // The defect: the first element that cannot be resolved fails the call and drops the rest.
        return new Response(JSON.stringify(body), {
          status: response.status,
          headers: { 'content-type': 'application/problem+json' },
        });
      } else results.push(body);
    }
    return ok(c, results);
  });

  app.post('/v1/approvals/:id/withdraw', (c) => {
    const o = findRead(c);
    if (o === undefined) return problem(c, 404, 'not_found');
    if (o.creatorSub !== principalOf(c).sub && !broken('withdraw_by_anyone'))
      return problem(c, 403, 'forbidden', 'Only the requester may withdraw.');
    if (o.state === 'consumed') return problem(c, 409, 'obligation_consumed');
    if (o.state === 'expired') return problem(c, 409, 'obligation_expired');
    if ((o.state !== 'pending' && o.state !== 'approved') || o.applying)
      return problem(c, 409, 'already_resolved');
    o.state = 'withdrawn';
    clearArguments(o);
    notify(o);
    return ok(c, view(o, principalOf(c)));
  });

  app.post('/v1/approvals/:id/consume', async (c) => {
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    // Consumption is atomic and once: every await happens before the state is read, so no second
    // request can interleave between the check below and the write that consumes.
    const presented = await digestOf(parsed.body.action as Obj);
    const o = findRead(c);
    if (o === undefined) return problem(c, 404, 'not_found');
    if (o.creatorSub !== principalOf(c).sub)
      return problem(
        c,
        403,
        'forbidden',
        'Only the principal that created the obligation consumes it.'
      );
    // The consume side of D-A78: the approver surface's token shares the creator's sub, so the client is
    // the only discriminator. One surface token must not approve an obligation and also spend it.
    if (
      principalOf(c).clientId === config.approverSurfaceClient &&
      !broken('surface_token_may_consume')
    )
      return problem(
        c,
        403,
        'forbidden',
        'A token issued to the approver surface resolves approvals; it does not consume them.'
      );
    if (o.state === 'consumed' && !broken('allow_token_replay'))
      return problem(c, 409, 'obligation_consumed');
    if (o.state === 'expired') return problem(c, 409, 'obligation_expired');
    if (o.state !== 'approved' && !(o.state === 'consumed' && broken('allow_token_replay'))) {
      return problem(c, 409, 'approval_conflict', `The obligation is ${o.state}, not approved.`);
    }
    const body = parsed.body;
    if (o.resumeToken === undefined || body.resume_token !== o.resumeToken) {
      return problem(
        c,
        409,
        'approval_conflict',
        'The resume_token does not bind this obligation.'
      );
    }
    const action = body.action as Obj;
    if (
      !broken('consume_ignores_action') &&
      (action.tool_ref !== o.toolRef || presented !== o.argDigest)
    ) {
      return problem(c, 409, 'approval_conflict', 'The action is not the one that was approved.');
    }
    o.state = 'consumed';
    clearArguments(o);
    o.consumedAt = state.now();
    // A consumed approval resets the identity's rejection count (rev 10).
    state.lastConsumed.set(o.identityKey, o.consumedAt);
    notify(o);
    return ok(c, {
      approval_id: o.id,
      state: 'consumed',
      consumed_at: o.consumedAt.toISOString(),
      tool_ref: o.toolRef,
      action_digest: o.argDigest,
    });
  });

  app.post('/v1/continuations/test', async (c) => {
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const continuation = parsed.body.continuation as Continuation;
    const refused = guardContinuation(c, continuation);
    if (refused !== undefined) return refused;
    return ok(c, {
      valid: true,
      reachable: continuation.delivery === 'push' ? true : null,
      problems: [],
    });
  });

  // ---- records -------------------------------------------------------------------------------
  const AGT_DECISIONS: Record<string, string> = {
    allow: 'allow',
    deny: 'deny',
    requires_approval: 'step_up',
    rate_limit: 'deny',
  };

  /**
   * The refusal of a record before anything is written: an `approval_id` the caller may not see is
   * answered like one that does not exist.
   */
  const refuseRecord = (c: Ctx, input: Obj): Response | undefined => {
    const p = principalOf(c);
    if (typeof input.approval_id === 'string') {
      const linked = state.obligations.get(input.approval_id);
      if (linked === undefined || !seesApproval(p, linked))
        return problem(c, 404, 'not_found', 'approval_id names no approval of this organisation.');
    }
    return undefined;
  };

  /**
   * What linking a record to the approval it names came to (`Record.approval_link`): linked only when the
   * caller created the approval, the approval is consumed and has no outcome record yet; otherwise the record
   * stays an ordinary record and `reason` says why. The defects: the member is left out, or always says linked
   * (and, with `outcome_not_linked`, links nothing at all).
   */
  const linkRecord = (
    approvalId: string,
    row: RecordRow,
    creator: Principal
  ): { linked: boolean; reason?: 'not_consumed' | 'already_linked' | 'not_found' } => {
    const approval = state.obligations.get(approvalId);
    let outcome: ReturnType<typeof linkRecord>;
    if (approval?.creatorSub !== creator.sub || approval.org !== creator.org)
      outcome = { linked: false, reason: 'not_found' };
    else if (approval.state !== 'consumed') outcome = { linked: false, reason: 'not_consumed' };
    else if (approval.outcomeRecordId !== undefined)
      outcome = { linked: false, reason: 'already_linked' };
    else {
      if (!broken('outcome_not_linked')) approval.outcomeRecordId = row.id;
      outcome = { linked: true };
    }
    return broken('approval_link_always_linked') ? { linked: true } : outcome;
  };

  const appendRecord = (c: Ctx, input: Obj): { row: RecordRow; approval_link?: Obj } | Response => {
    const p = principalOf(c);
    const refused = refuseRecord(c, input);
    if (refused !== undefined) return refused;
    const row: RecordRow = {
      id: `rec_${crypto.randomUUID()}`,
      org: p.org,
      ts: state.now().toISOString(),
      // A record names its actor by id and kind only. The defect adds the name.
      actor: broken('names_leak_into_records')
        ? { id: p.sub, kind: p.kind, display_name: nameOfSub(p.sub) }
        : { id: p.sub, kind: p.kind },
      tool_ref: String(input.tool_ref),
      // Absent stays absent. The defect writes `null` for a record appended without a policy.
      ...(isObj(input.policy)
        ? { policy: input.policy as NonNullable<RecordRow['policy']> }
        : broken('null_policy_on_default')
          ? { policy: null }
          : {}),
      decision: String(input.decision),
      // Every record appended through /v1 is asserted. The break reads a caller-supplied value instead.
      attestation: broken('accept_attestation')
        ? ((input.attestation as 'observed' | 'asserted' | undefined) ?? 'asserted')
        : 'asserted',
      ...(typeof input.approval_id === 'string' ? { approval_id: input.approval_id } : {}),
      ...(isObj(input.outcome) ? { outcome: input.outcome } : {}),
      ...(typeof input.prompt_id === 'string' ? { prompt_id: input.prompt_id } : {}),
      ...(isObj(input.context) ? { context: input.context } : {}),
      ...(typeof input.enforced === 'boolean' ? { enforced: input.enforced } : {}),
      ...(isObj(input.degraded) ? { degraded: input.degraded } : {}),
    };
    state.records.push(row);
    emitEvent(row.org, 'record.appended', row.id, {
      record_id: row.id,
      tool_ref: row.tool_ref,
      decision: row.decision,
      ts: row.ts,
    });
    if (typeof input.approval_id !== 'string') return { row };
    const approval_link = linkRecord(input.approval_id, row, p);
    return broken('approval_link_missing') ? { row } : { row, approval_link };
  };

  const recordView = (row: RecordRow): Obj => {
    // The defect: a degraded record reads back as a normal one.
    return broken('degraded_dropped_on_read')
      ? without(row as unknown as Obj, 'org', 'degraded')
      : without(row as unknown as Obj, 'org');
  };

  /** The 201 view of an appended record: the record, and `approval_link` when the request named an approval. */
  const appendedView = (appended: { row: RecordRow; approval_link?: Obj }): Obj => ({
    ...recordView(appended.row),
    ...(appended.approval_link === undefined ? {} : { approval_link: appended.approval_link }),
  });

  const attestationGuard =
    (c: Ctx) =>
    (body: Obj): Response | undefined =>
      'attestation' in body && !broken('accept_attestation')
        ? problem(c, 400, 'attestation_not_accepted', 'attestation is derived by the server.')
        : undefined;

  app.post('/v1/records', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.startsWith('application/vnd.microsoft.agt.event+json')) {
      const read = await readBody(c);
      if ('response' in read) return read.response;
      const event = read.body as Obj;
      const info = index.match('POST', c.req.path);
      const validate =
        info === undefined
          ? undefined
          : index.requestBody(info, 'application/vnd.microsoft.agt.event+json');
      if (validate !== undefined && !validate(event))
        return problem(c, 400, 'invalid_request', describeErrors(validate));
      const appended = appendRecord(c, {
        tool_ref: event.tool_name,
        decision: AGT_DECISIONS[String(event.decision)] ?? 'allow',
        outcome: { status: event.result === 'error' ? 'failed' : 'succeeded' },
      });
      return appended instanceof Response ? appended : ok(c, appendedView(appended), 201);
    }
    const parsed = await validatedBody(c, attestationGuard(c));
    if ('response' in parsed) return parsed.response;
    const appended = appendRecord(c, parsed.body);
    return appended instanceof Response ? appended : ok(c, appendedView(appended), 201);
  });

  app.post('/v1/records/batch', async (c) => {
    const parsed = await validatedBody(c, (body) => {
      for (const item of (Array.isArray(body.records) ? body.records : []) as unknown[]) {
        if (isObj(item)) {
          const early = attestationGuard(c)(item);
          if (early !== undefined) return early;
        }
      }
      return undefined;
    });
    if ('response' in parsed) return parsed.response;
    const refusal = batchTooLarge(c, (parsed.body.records as Obj[]).length, limits.records);
    if (refusal !== undefined) return refusal;
    const items = parsed.body.records as Obj[];
    // All or none: every element is checked, the visibility of its `approval_id` included, before any is
    // written. The defect writes as it goes, so a refusal in the middle leaves the earlier elements behind.
    if (!broken('records_batch_partial_write')) {
      for (const item of items) {
        const refused = refuseRecord(c, item);
        if (refused !== undefined) return refused;
      }
    }
    const rows: Obj[] = [];
    for (const item of items) {
      const appended = appendRecord(c, item);
      if (appended instanceof Response) return appended;
      rows.push(appendedView(appended));
    }
    return ok(c, rows, 201);
  });

  app.get('/v1/records/:id/chain', (c) => {
    const row = state.records.find((r) => r.id === c.req.param('id') && visible(c, r.org));
    if (row === undefined) return problem(c, 404, 'not_found');
    const link = (id: string | null | undefined, reason: string): Obj => ({
      id: id ?? null,
      reason: id === null || id === undefined ? reason : null,
    });
    return ok(c, {
      prompt: link(row.prompt_id, 'no_prompt'),
      action: link(row.id, ''),
      decision: link(row.id, ''),
      approval: link(row.approval_id, 'no_approval'),
      outcome: link(row.outcome === undefined ? null : row.id, 'no_outcome'),
    });
  });

  app.get('/v1/records/verify', (c) =>
    ok(c, { verified: true, checked_at: state.now().toISOString() })
  );
  app.post('/v1/records/checkpoints', (c) =>
    ok(
      c,
      {
        id: `chk_${crypto.randomUUID()}`,
        created_at: state.now().toISOString(),
        record_count: state.records.filter((r) => visible(c, r.org)).length,
      },
      201
    )
  );
  app.post('/v1/evidence/exports', (c) =>
    ok(
      c,
      { id: `exp_${crypto.randomUUID()}`, state: 'pending', created_at: state.now().toISOString() },
      202
    )
  );

  app.get('/v1/records/:id', (c) => {
    const row = state.records.find((r) => r.id === c.req.param('id') && visible(c, r.org));
    return row === undefined ? problem(c, 404, 'not_found') : ok(c, recordView(row));
  });

  app.get('/v1/records', (c) => {
    const q = c.req.query();
    // The defect: the parameter is ignored altogether, its value included.
    const degraded = broken('degraded_filter_ignored') ? undefined : q.degraded;
    if (degraded !== undefined && degraded !== 'true' && degraded !== 'false')
      return problem(c, 400, 'invalid_request', 'degraded takes true or false.');
    let rows = state.records.filter((r) => visible(c, r.org));
    if (degraded !== undefined)
      rows = rows.filter((r) => (r.degraded !== undefined) === (degraded === 'true'));
    if (q.actor !== undefined) rows = rows.filter((r) => r.actor.id === q.actor);
    if (q.tool !== undefined) rows = rows.filter((r) => r.tool_ref === q.tool);
    if (q.decision !== undefined) rows = rows.filter((r) => r.decision === q.decision);
    if (q.approval_id !== undefined) rows = rows.filter((r) => r.approval_id === q.approval_id);
    if (q.from !== undefined) rows = rows.filter((r) => r.ts >= String(q.from));
    if (q.to !== undefined) rows = rows.filter((r) => r.ts <= String(q.to));
    return paged(c, [...rows].reverse().map(recordView));
  });

  // ---- policies ------------------------------------------------------------------------------
  /**
   * Who authors policies (rev 10): a user holding the mock's `policy_admin` role. A service principal never does,
   * whatever it holds. This is separate from `mayRegisterTools` and `isAdministratorUser`, which the tool
   * routes use. The defect lets anyone author.
   */
  const mayAuthorPolicies = (p: Principal): boolean =>
    broken('policy_authoring_unguarded') ||
    (p.kind === 'user' && p.scopes.includes(roleScope(POLICY_ADMIN_ROLE)));

  /**
   * Who administers the organisation's settings that are not a policy (rev 12): browser origins and webhooks.
   * The rule is the one for authoring a policy, so a user holding `policy_admin`; a service principal never
   * does. The defect lets anyone.
   */
  const mayAdministerOrganisation = (p: Principal): boolean =>
    broken('organisation_settings_unguarded') ||
    (p.kind === 'user' && p.scopes.includes(roleScope(POLICY_ADMIN_ROLE)));
  const notAnAdministrator = (c: Ctx, what: string): Response | undefined =>
    mayAdministerOrganisation(principalOf(c))
      ? undefined
      : problem(c, 403, 'forbidden', `Only an administrator of the organisation ${what}.`);

  /** The `tool_ref`s a policy's targets name; none for `all`. */
  const targetRefs = (targets: unknown): string[] =>
    isObj(targets) && Array.isArray(targets.tools) ? targets.tools.map(String) : [];
  /** Whether a policy's targets cover `toolRef`. */
  const targetsCover = (targets: unknown, toolRef: string): boolean =>
    !isObj(targets) || targets.tools === 'all' || targetRefs(targets).includes(toolRef);
  /**
   * Whether the caller cannot see a tool one of the policy's versions targets: a tool another principal
   * owns. Such a policy is left out of lists and is a 404, as the tool is.
   */
  const hidesTool = (c: Ctx, row: Obj): boolean =>
    (state.policyVersions.get(String(row.id)) ?? []).some((v) =>
      targetRefs(v.targets).some((ref) =>
        [...state.tools.values()].some(
          (t) => t.org === row.org && t.tool_ref === ref && !canSeeTool(c, t)
        )
      )
    );
  /**
   * The policy `id` when the caller may see it, else undefined (a 404). A retired policy is a 404 too, except
   * to the versions route, which keeps its history (rev 11).
   */
  const policyFor = (c: Ctx, id: string, includeRetired = false): Obj | undefined => {
    const row = rowIn(c, state.policies.get(id));
    return row === undefined || hidesTool(c, row) || (!includeRetired && isRetired(id))
      ? undefined
      : row;
  };
  /** The `tool_ref`s of `targets` no tool of the organisation answers to: the policy enforces nothing there. */
  const unenforced = (org: unknown, targets: unknown): Obj => {
    // A withdrawn tool (rev 11) is enforced on no more than a removed one.
    const missing = targetRefs(targets).filter(
      (ref) =>
        ![...state.tools.values()].some(
          (t) => t.org === org && t.tool_ref === ref && t.status !== 'withdrawn'
        )
    );
    return missing.length === 0 ? {} : { unenforced_targets: missing };
  };
  /**
   * The version of the pending draft of a published policy (rev 11): absent when it has none, and on a policy
   * never published, whose read is the draft.
   */
  const draftVersionOf = (id: string): Obj => {
    const versions = state.policyVersions.get(id) ?? [];
    const last = versions.at(-1);
    return last?.published_at === null && versions.some((v) => v.published_at !== null)
      ? { draft_version: last.version }
      : {};
  };
  /** What a client sees of a policy's read view. */
  const policyView = (row: Obj): Obj => ({
    ...shown(row),
    ...unenforced(row.org, row.targets),
    ...draftVersionOf(String(row.id)),
  });
  /** What a client sees of one version of a policy. */
  const versionView = (row: Obj, v: PolicyVersion): Obj => ({
    id: row.id,
    source: row.source,
    ...v,
    state: stateOf(v),
    ...unenforced(row.org, v.targets),
  });

  /** The configuration schema of each kind the mock implements. */
  const CONFIG_OF_KIND: Readonly<Record<string, string>> = {
    tool_invocation: 'ToolInvocationConfig',
    spending: 'SpendingConfig',
    duplicate_requests: 'DuplicateRequestsConfig',
    // Rev 16, served only under `approvals.requirements` (see `policyWriteRefused`).
    approval_routing: 'ApprovalRoutingConfig',
  };
  /**
   * A 422 `unsupported_policy_form` that names the offending member (rev 13): `member` is a path into the
   * request body as sent, and `detail` keeps the rev 12 prefix (`lead`, by default the member itself: the name
   * without an index or a leaf) so a rev 12 client that reads `detail` still finds it. The defect leaves `member`
   * out.
   */
  const unsupportedForm = (c: Ctx, member: string, why: string, lead = member): Response =>
    problem(
      c,
      422,
      'unsupported_policy_form',
      `${lead}: ${why}`,
      broken('unsupported_form_member_missing') ? {} : { member }
    );
  /** Rev 16: the declared type of each fact of a tool, by name. */
  const factTypesOf = (tool: ToolRow): Record<string, FactType> =>
    Object.fromEntries(Object.entries(tool.facts ?? {}).map(([name, b]) => [name, b.type]));
  /**
   * Rev 16: the refusal of the rule-bearing members of a `tool_invocation` config. `rules` where `policies.rules` is
   * not served, and `approvers`, `exclude` and a rule's `approvers` where `approvals.requirements` is not, are 422
   * `unsupported_policy_form` naming the member. When every target names a tool the organisation has registered, a
   * condition (of a rule, of a policy approver or of a rule's approver) whose fact one of them does not declare, or
   * that compares a fact one of them declares as neither `number` nor `count`, is 400 `invalid_request` naming the
   * condition's `fact` in `member`.
   */
  const ruleMembersRefused = (c: Ctx, body: Obj, config: Obj, at: string): Response | undefined => {
    const rules = Array.isArray(config.rules) ? (config.rules as Obj[]) : [];
    if (config.rules !== undefined && !rulesServed())
      return unsupportedForm(c, `${at}config.rules`, 'this deployment does not evaluate rules.');
    if (!requirementsServed()) {
      for (const member of REQUIREMENT_MEMBERS)
        if (config[member] !== undefined)
          return unsupportedForm(
            c,
            `${at}config.${member}`,
            'this deployment does not keep the requirements of an approval.'
          );
      const ruleWithApprovers = rules.findIndex((rule) => rule.approvers !== undefined);
      if (ruleWithApprovers >= 0)
        return unsupportedForm(
          c,
          `${at}config.rules[${String(ruleWithApprovers)}].approvers`,
          'this deployment does not keep the requirements of an approval.',
          `${at}config.rules`
        );
    }
    const refs = targetRefs(body.targets);
    const org = principalOf(c).org;
    const tools = refs.map((ref) =>
      [...state.tools.values()].find((t) => t.org === org && t.tool_ref === ref)
    );
    if (refs.length === 0 || tools.some((t) => t === undefined)) return undefined;
    const declared = (tools as ToolRow[]).map(factTypesOf);
    const conditionsAt: [string, unknown][] = [];
    const approversAt = (path: string, approvers: unknown): void => {
      if (Array.isArray(approvers))
        (approvers as Obj[]).forEach((approver, k) =>
          conditionsAt.push([`${path}[${String(k)}].when`, approver.when])
        );
    };
    rules.forEach((rule, i) => {
      conditionsAt.push([`${at}config.rules[${String(i)}].when`, rule.when]);
      approversAt(`${at}config.rules[${String(i)}].approvers`, rule.approvers);
    });
    approversAt(`${at}config.approvers`, config.approvers);
    for (const [path, when] of conditionsAt) {
      if (!Array.isArray(when)) continue;
      for (const [j, condition] of (when as Condition[]).entries()) {
        const why = refusedCondition(condition, declared);
        if (why !== undefined)
          return problem(c, 400, 'invalid_request', `${path}[${String(j)}]: ${why}`, {
            member: `${path}[${String(j)}].fact`,
          });
      }
    }
    return undefined;
  };
  /**
   * The checks a policy write passes after the schema: the kind is one the mock implements (else 422), the
   * `config` fits the kind (else 400; the defect skips this), and the form is one the mock enforces (422):
   * a `duplicate_requests` or (rev 16) `approval_routing` policy takes the organisation subject only and targets
   * every tool, `not_granted`, which is provisional, is implemented by no deployment yet, and rev 16's members are
   * checked by `ruleMembersRefused`.
   */
  const policyWriteRefused = (c: Ctx, body: Obj, at = ''): Response | undefined => {
    // Rev 14: a deployment-applied reference has a fixed policy; no policy names it as a target. The defect accepts one.
    if (
      targetRefs(body.targets).some(isDeploymentApplied) &&
      !broken('policy_on_deployment_applied_accepted')
    )
      return problem(
        c,
        422,
        'policy_immutable',
        `A policy cannot target a reference in the ${DEPLOYMENT_APPLIED_PREFIX} namespace: its policy is fixed.`
      );
    const kind = String(body.kind);
    const schema = CONFIG_OF_KIND[kind];
    if (schema === undefined || (kind === 'approval_routing' && !requirementsServed()))
      return unsupportedForm(
        c,
        `${at}kind`,
        `this deployment does not implement policies of kind ${kind}.`
      );
    const fits = index.schema(schema);
    if (!broken('policy_config_kind_unbound') && !fits(body.config))
      return problem(
        c,
        400,
        'invalid_request',
        `config does not fit a policy of kind ${kind}: ${describeErrors(fits)}`
      );
    const config = (body.config ?? {}) as Obj;
    if (kind === 'duplicate_requests' || kind === 'approval_routing') {
      const stray = (body.subjects as Obj[]).findIndex(
        (subject) => subject.type !== 'organization'
      );
      if (stray >= 0)
        return unsupportedForm(
          c,
          `${at}subjects[${String(stray)}].type`,
          `a ${kind} policy takes the organization subject only.`,
          `${at}subjects`
        );
      if (body.targets !== undefined && (body.targets as Obj).tools !== 'all')
        return unsupportedForm(
          c,
          `${at}targets.tools`,
          `a ${kind} policy targets every tool.`,
          `${at}targets`
        );
    }
    // A deployment that advertises targets_all: false refuses a tool_invocation policy that targets every tool.
    if (
      options.restrictPolicyTargets === true &&
      kind === 'tool_invocation' &&
      (!isObj(body.targets) || body.targets.tools === 'all')
    )
      return unsupportedForm(
        c,
        `${at}targets`,
        'this deployment does not apply a tool_invocation policy to every tool; name the tools.'
      );
    // The defect refuses a subject type it advertises in policy_forms (a user subject).
    const refusedUser = (body.subjects as Obj[]).findIndex((subject) => subject.type === 'user');
    if (broken('advertised_policy_form_refused') && kind === 'tool_invocation' && refusedUser >= 0)
      return unsupportedForm(
        c,
        `${at}subjects[${String(refusedUser)}].type`,
        'user subjects are refused.',
        `${at}subjects`
      );
    if (kind === 'tool_invocation' && config.mode === 'not_granted')
      return unsupportedForm(
        c,
        `${at}config.mode`,
        'not_granted is provisional, and this deployment does not implement it.'
      );
    return kind === 'tool_invocation' ? ruleMembersRefused(c, body, config, at) : undefined;
  };
  /** The members of a version a write sets. */
  const writtenVersion = (c: Ctx, body: Obj, version: number, name: string): PolicyVersion => {
    const p = principalOf(c);
    return {
      version,
      kind: String(body.kind),
      name: typeof body.name === 'string' ? body.name : name,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      subjects: body.subjects as Obj[],
      // Absent means every tool, and a read always says so.
      targets: (isObj(body.targets) ? body.targets : { tools: 'all' }) as PolicyVersion['targets'],
      config: body.config as Obj,
      published_at: null,
      updated_at: state.now().toISOString(),
      updated_by: { id: p.sub, kind: p.kind },
      // Rev 11: origin describes the version it is written with.
      ...(isObj(body.origin) ? { origin: body.origin } : {}),
    };
  };
  /** Whether two subjects are the same: the same type and, for a principal, the same id. */
  const sameSubject = (a: Obj, b: Obj): boolean => a.type === b.type && a.id === b.id;
  /**
   * The published `tool_invocation` policy that already governs a (tool, subject) pair of `draft`, if any:
   * publishing `draft` would be 409 `policy_conflict`. A `duplicate_requests` policy never conflicts.
   */
  const conflictOf = (row: Obj, draft: PolicyVersion): string | undefined => {
    if (draft.kind !== 'tool_invocation') return undefined;
    for (const other of state.policies.values()) {
      if (other.org !== row.org || other.id === row.id) continue;
      const theirs = inForce(String(other.id));
      if (theirs?.kind !== 'tool_invocation') continue;
      const toolsMeet =
        draft.targets.tools === 'all' ||
        theirs.targets.tools === 'all' ||
        targetRefs(draft.targets).some((ref) => targetRefs(theirs.targets).includes(ref));
      const subjectsMeet = draft.subjects.some((s) =>
        theirs.subjects.some((t) => sameSubject(s, t))
      );
      if (toolsMeet && subjectsMeet) return String(other.id);
    }
    return undefined;
  };

  app.get('/v1/policies', (c) => {
    if (c.req.query('source') === 'suggested') {
      if (config.deployment === 'edge' && !broken('suggested_on_edge'))
        return problem(
          c,
          404,
          'not_available_on_deployment',
          'Suggested policies are served by the hosted deployment only.'
        );
      if (!principalOf(c).entitlements.includes('policies.suggested'))
        return problem(c, 403, 'entitlement_required');
      return paged(c, []);
    }
    const q = c.req.query();
    const rows = [...state.policies.values()].filter(
      (row) =>
        visible(c, String(row.org)) &&
        !hidesTool(c, row) &&
        !isRetired(String(row.id)) &&
        (q.source === undefined || row.source === q.source) &&
        (q.kind === undefined || row.kind === q.kind) &&
        (q.state === undefined || row.state === q.state) &&
        (q.tool === undefined || targetsCover(row.targets, q.tool)) &&
        (q.subject_type === undefined ||
          (row.subjects as Obj[]).some((subject) => subject.type === q.subject_type))
    );
    return paged(c, rows.map(policyView));
  });
  // The mock parses no policy format, so it reads the text for the one rule it can state: a policy that names a
  // deployment-applied reference is never imported (rev 14). Whatever else is sent is unsupported.
  app.post('/v1/policies/import', async (c) => {
    if ((await c.req.text()).includes(DEPLOYMENT_APPLIED_PREFIX)) {
      // The defect reports the policy as imported, which nothing may do.
      if (broken('import_reserved_accepted'))
        return ok(c, {
          applied: [{ id: `pol_${crypto.randomUUID().slice(0, 8)}`, version: 1 }],
          unsupported: [],
        });
      return ok(c, {
        applied: [],
        unsupported: [
          {
            path: '$',
            reason: `policy_immutable: no policy changes a deployment-applied reference (${DEPLOYMENT_APPLIED_PREFIX}).`,
          },
        ],
      });
    }
    return ok(c, {
      applied: [],
      unsupported: [{ path: '$', reason: 'The mock does not import policies.' }],
    });
  });
  app.post('/v1/policies', async (c) => {
    if (!mayAuthorPolicies(principalOf(c)))
      return problem(
        c,
        403,
        'forbidden',
        'Only an administrator of the organisation authors policies.'
      );
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const refused = policyWriteRefused(c, parsed.body);
    if (refused !== undefined) return refused;
    const id = `pol_${crypto.randomUUID().slice(0, 8)}`;
    // The mock derives a name from the kind and the id.
    state.policyVersions.set(id, [
      writtenVersion(c, parsed.body, 1, `${String(parsed.body.kind)} ${id}`),
    ]);
    // Rev 11: a create that says where it was imported from is imported; source never changes after this.
    const source = isObj(parsed.body.origin) ? 'imported' : 'authored';
    return ok(c, policyView(syncPolicy(principalOf(c).org, id, source)), 201);
  });
  app.get('/v1/policies/:id/versions', (c) => {
    const row = policyFor(c, c.req.param('id'), true);
    if (row === undefined) return problem(c, 404, 'not_found');
    const versions = state.policyVersions.get(String(row.id)) ?? [];
    return paged(
      c,
      [...versions].reverse().map((v) => versionView(row, v))
    );
  });
  app.get('/v1/policies/:id/export', (c) => {
    const row = policyFor(c, c.req.param('id'));
    return row === undefined
      ? problem(c, 404, 'not_found')
      : c.text(JSON.stringify(policyView(row)));
  });
  /**
   * The checks a simulation as a subject passes (rev 11): an administrator's, and only for the subject types
   * the mock evaluates. The defect lets anyone.
   */
  const subjectForbidden = (c: Ctx, subject: unknown): Response | undefined =>
    isObj(subject) && !mayAuthorPolicies(principalOf(c)) && !broken('simulate_subject_unguarded')
      ? problem(
          c,
          403,
          'forbidden',
          'Only an administrator of the organisation simulates as a subject.'
        )
      : undefined;
  const subjectRefused = (c: Ctx, subject: unknown): Response | undefined => {
    if (!isObj(subject)) return undefined;
    const forbidden = subjectForbidden(c, subject);
    if (forbidden !== undefined) return forbidden;
    if (!SIMULATED_SUBJECT_TYPES.includes(String(subject.type)))
      return unsupportedForm(
        c,
        'subject',
        `this deployment cannot simulate a ${String(subject.type)} subject.`
      );
    return undefined;
  };
  // Rev 13: a simulation against proposed bodies, with nothing stored. It validates each body as a create
  // does, and writes nothing.
  app.post('/v1/policies/simulate', async (c) => {
    // L4: the administrator check for a `subject` runs before the body is validated, so a caller who may not
    // simulate as a subject learns nothing of the body's shape (403, never 400 or 422).
    const parsed = await validatedBody(c, (body) => subjectForbidden(c, body.subject));
    if ('response' in parsed) return parsed.response;
    const bodies = parsed.body.policies as Obj[];
    for (const [at, proposal] of bodies.entries()) {
      const refused = policyWriteRefused(c, proposal, `policies[${String(at)}].`);
      if (refused !== undefined) return refused;
    }
    // A proposed duplicate_requests body stands beside the in-force setting, so only one is meaningful.
    const duplicates = bodies.flatMap((proposal, at) =>
      proposal.kind === 'duplicate_requests' ? [at] : []
    );
    if (duplicates.length > 1)
      return unsupportedForm(
        c,
        `policies[${String(duplicates[1])}].kind`,
        'at most one duplicate_requests body is simulated at a time.',
        'policies'
      );
    const subjectProblem = subjectRefused(c, parsed.body.subject);
    if (subjectProblem !== undefined) return subjectProblem;
    const proposed = bodies.map((proposal, at) =>
      writtenVersion(c, proposal, 0, `proposed ${String(at)}`)
    );
    // No stored policy stands in for a proposed one: there is no id to replace.
    const answer = await simulate(c, parsed.body, '', undefined, proposed);
    return answer instanceof Response ? answer : ok(c, answer);
  });
  app.post('/v1/policies/:id/simulate', async (c) => {
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const row = policyFor(c, c.req.param('id'));
    if (row === undefined) return problem(c, 404, 'not_found');
    // Rev 11: simulating as a subject is an administrator's, after the visibility rule.
    const subjectProblem = subjectRefused(c, parsed.body.subject);
    if (subjectProblem !== undefined) return subjectProblem;
    const versions = state.policyVersions.get(String(row.id)) ?? [];
    const asked = parsed.body.draft_version;
    // The version simulated stands in for the stored one: the one named, else the newest (the draft).
    const simulated =
      typeof asked === 'number' ? versions.find((v) => v.version === asked) : versions.at(-1);
    if (simulated === undefined)
      return problem(c, 404, 'not_found', `The policy has no version ${String(asked)}.`);
    const answer = await simulate(c, parsed.body, String(row.id), simulated);
    return answer instanceof Response ? answer : ok(c, answer);
  });
  app.post('/v1/policies/:id/publish', (c) => {
    const row = policyFor(c, c.req.param('id'));
    // A policy the caller cannot see is a 404 before the administrator check.
    if (row === undefined) return problem(c, 404, 'not_found');
    if (!mayAuthorPolicies(principalOf(c)))
      return problem(
        c,
        403,
        'forbidden',
        'Only an administrator of the organisation publishes policies.'
      );
    const draft = (state.policyVersions.get(String(row.id)) ?? []).at(-1);
    // Publishing a policy whose newest version is already published records nothing new.
    if (draft?.published_at === null) {
      const governing = conflictOf(row, draft);
      if (governing !== undefined)
        return problem(
          c,
          409,
          'policy_conflict',
          "Another published policy already governs one of this policy's (tool, subject) pairs.",
          { policy_id: governing }
        );
      // `stamp` is strictly increasing, so "the most recently published" is never a tie.
      draft.published_at = stamp().toISOString();
      emitEvent(String(row.org), 'policy.published', String(row.id), {
        policy_id: String(row.id),
        kind: draft.kind,
        version: draft.version,
        published_at: draft.published_at,
      });
    }
    return ok(c, policyView(syncPolicy(String(row.org), String(row.id), String(row.source))));
  });
  /** Who retires a policy and discards a draft (rev 11): the authors. The defect lets anyone. */
  const mayRetire = (p: Principal): boolean => broken('retire_unguarded') || mayAuthorPolicies(p);
  app.post('/v1/policies/:id/retire', (c) => {
    const row = policyFor(c, c.req.param('id'));
    // A policy the caller cannot see, or already retired, is a 404 before the administrator check.
    if (row === undefined) return problem(c, 404, 'not_found');
    if (!mayRetire(principalOf(c)))
      return problem(
        c,
        403,
        'forbidden',
        'Only an administrator of the organisation retires policies.'
      );
    const id = String(row.id);
    const versions = state.policyVersions.get(id) ?? [];
    if (inForce(id) === undefined)
      return problem(
        c,
        400,
        'invalid_request',
        'The policy was never published: discard it with DELETE /v1/policies/{id}/draft.'
      );
    // The pending draft goes with it; every version that stays says when the policy was retired.
    if (versions.at(-1)?.published_at === null) versions.pop();
    const at = stamp().toISOString();
    for (const version of versions) version.retired_at = at;
    return ok(c, policyView(syncPolicy(String(row.org), id, String(row.source))));
  });
  app.delete('/v1/policies/:id/draft', (c) => {
    const row = policyFor(c, c.req.param('id'));
    if (row === undefined) return problem(c, 404, 'not_found');
    if (!mayRetire(principalOf(c)))
      return problem(
        c,
        403,
        'forbidden',
        'Only an administrator of the organisation discards drafts.'
      );
    const id = String(row.id);
    const versions = state.policyVersions.get(id) ?? [];
    // The defect answers 204 and keeps the draft.
    if (broken('discard_draft_ignored')) return c.body(null, 204);
    // A policy never published is deleted outright.
    if (!versions.some((v) => v.published_at !== null)) {
      state.policies.delete(id);
      state.policyVersions.delete(id);
      return c.body(null, 204);
    }
    if (versions.at(-1)?.published_at !== null)
      return problem(c, 404, 'not_found', 'The policy has no pending draft.');
    versions.pop();
    syncPolicy(String(row.org), id, String(row.source));
    return c.body(null, 204);
  });
  app.get('/v1/policies/:id', (c) => {
    const row = policyFor(c, c.req.param('id'));
    return row === undefined ? problem(c, 404, 'not_found') : ok(c, policyView(row));
  });
  app.put('/v1/policies/:id', async (c) => {
    const row = policyFor(c, c.req.param('id'));
    // A policy the caller cannot see is a 404 before the administrator check.
    if (row === undefined) return problem(c, 404, 'not_found');
    if (!mayAuthorPolicies(principalOf(c)))
      return problem(
        c,
        403,
        'forbidden',
        'Only an administrator of the organisation authors policies.'
      );
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const refused = policyWriteRefused(c, parsed.body);
    if (refused !== undefined) return refused;
    const versions = state.policyVersions.get(String(row.id)) ?? [];
    const last = versions.at(-1);
    if (last === undefined) throw new Error(`policy ${String(row.id)} has no version`);
    // A draft is replaced; after a publish the write is a draft of the next version, and the read keeps
    // the published one until that draft is published.
    const written = writtenVersion(
      c,
      parsed.body,
      last.published_at === null ? last.version : last.version + 1,
      last.name
    );
    if (last.published_at === null) versions[versions.length - 1] = written;
    else versions.push(written);
    syncPolicy(String(row.org), String(row.id), String(row.source));
    return ok(c, versionView(row, written));
  });

  // ---- simulate (rev 10; composed tightest-wins since rev 11) ----------------------------------
  /**
   * How tight a `tool_invocation` mode is under tightest-wins (rev 11, D-A89): `deny` and `not_granted` (which
   * composes as `deny`), then needing approval (`ask`, `escalate`), then `always_allow`. The lowest wins, across
   * every entry that matched, whoever its subject is.
   */
  const tightnessOf = tightnessOfMode;
  /** Who a simulation is for: the policy subjects that holder matches. */
  type Holder = (subject: Obj) => boolean;
  /**
   * The caller: itself by kind and id, the agent its service principal is bound to (rev 13, D1: never the agent
   * the request names), a role it holds and the reserved role `everyone` (rev 13), the organisation (the mock
   * knows no groups). Neither `actor.agent_id` nor the `agent_id` of the run `actor.run_id` names selects an
   * agent. The defects: the hint selects the agent (on every route, or with `readsHint` on the set route only);
   * the run's agent selects it; an unbound caller holds every agent's policies; a service principal does not
   * hold `everyone`.
   */
  const callerHolder =
    (p: Principal, actor: Obj, readsHint: boolean): Holder =>
    (subject) => {
      const hint = actor.agent_id;
      const runAgent =
        typeof actor.run_id === 'string' ? state.runs.get(actor.run_id)?.agent_id : undefined;
      switch (subject.type) {
        case 'organization':
          return true;
        case 'role':
          if (subject.id === EVERYONE_ROLE)
            return !(broken('everyone_not_held_by_service') && p.kind === 'service');
          return p.scopes.includes(roleScope(String(subject.id)));
        case 'agent': {
          if ((broken('hint_selects_agent_policy') || readsHint) && typeof hint === 'string')
            return subject.id === hint;
          if (broken('run_agent_selects_agent_policy') && typeof runAgent === 'string')
            return subject.id === runAgent;
          const bound = boundAgentOf(p);
          if (broken('unbound_caller_holds_agent_policy') && bound === undefined) return true;
          return bound !== undefined && subject.id === bound;
        }
        case 'user':
        case 'service':
          return subject.type === p.kind && subject.id === p.sub;
        default:
          return false;
      }
    };
  /**
   * A hypothetical holder of exactly `subject` (rev 11): a role is that role and the organisation; a user is the
   * mock's view of that user, its own id with the roles of its latest token here and the organisation (a user the
   * mock has never seen holds no role); an agent is that agent and the organisation, never a user or another
   * role; the organisation is the organisation subject alone. Rev 13: every holder of a subject but the
   * organisation also holds the reserved role `everyone`. Rev 18: a service principal is its own `service` policies,
   * the policies of the agent `state.agents` binds it to (none when unbound) and the organisation, never a user or
   * another role, as `callerHolder` would hold for that principal without the roles of its token.
   */
  const subjectHolder = (org: string, subject: Obj): Holder => {
    const roles =
      subject.type === 'user' ? (scopesSeen.get(`${org}|${String(subject.id)}`) ?? []) : [];
    // The defect leaves the bound agent's policies out of a simulation as its service principal.
    const boundAgent =
      subject.type === 'service' && !broken('simulate_service_ignores_binding')
        ? (agentBoundTo(org, String(subject.id))?.id as string | undefined)
        : undefined;
    return (candidate) => {
      if (candidate.type === 'organization') return true;
      // The defect takes `everyone` from an agent.
      if (
        subject.type !== 'organization' &&
        candidate.type === 'role' &&
        candidate.id === EVERYONE_ROLE &&
        !(broken('agent_subject_loses_everyone') && subject.type === 'agent')
      )
        return true;
      if (subject.type === 'role') return candidate.type === 'role' && candidate.id === subject.id;
      if (subject.type === 'user')
        return (
          (candidate.type === 'user' && candidate.id === subject.id) ||
          (candidate.type === 'role' && roles.includes(roleScope(String(candidate.id))))
        );
      // An agent: its own policies, `everyone` and the organisation's, never a user's or another role's. The
      // defect adds every role.
      if (subject.type === 'agent')
        return (
          (candidate.type === 'agent' && candidate.id === subject.id) ||
          (broken('simulate_agent_holds_roles') && candidate.type === 'role')
        );
      // A service principal. The defects leave out its own `service` policies, or add every role.
      if (subject.type === 'service')
        return (
          (!broken('simulate_service_ignores_own_rows') &&
            candidate.type === 'service' &&
            candidate.id === subject.id) ||
          (boundAgent !== undefined && candidate.type === 'agent' && candidate.id === boundAgent) ||
          (broken('simulate_service_holds_roles') && candidate.type === 'role')
        );
      return false;
    };
  };
  /** The subject types the mock simulates as (rev 11; `service` since rev 18). */
  const SIMULATED_SUBJECT_TYPES: readonly string[] = [
    'role',
    'user',
    'agent',
    'service',
    'organization',
  ];
  /** The decision a `tool_invocation` mode gives, with the reason `decide` would give it. */
  const decisionOfMode = (mode: string): { decision: string; reason?: string } =>
    mode === 'always_allow'
      ? { decision: 'allow' }
      : mode === 'ask' || mode === 'escalate'
        ? { decision: 'step_up', reason: 'approval_required' }
        : mode === 'not_granted'
          ? { decision: 'deny', reason: 'not_granted' }
          : { decision: 'deny', reason: 'deny' };

  interface Considered {
    kind: string;
    id: string | null;
    version: number | null;
    result: string;
    subject?: Obj;
    source?: string;
    /** Rev 13: the index of the proposed body this entry comes from (`POST /v1/policies/simulate`). */
    proposed_index?: number;
    contributed?: boolean;
    /** Rev 16: the rule that gave `result`, when one matched. */
    rule?: { index: number; then: string };
    /** Rev 16: the facts the rule that stopped the walk had no value for. */
    missing_facts?: string[];
  }

  /**
   * Rev 16: what one `tool_invocation` policy's `config` gives for a call with `facts`: its rule walk where rules are
   * served, else its mode. The defects: `rules_ignored` answers the mode whatever the rules say;
   * `missing_fact_falls_to_mode` skips a rule it cannot evaluate, as if it were false, instead of asking.
   */
  const evaluatePolicy = (config: Obj, facts: ReadonlyMap<string, unknown>): WalkResult => {
    const mode = String(config.mode);
    if (!rulesServed() || broken('rules_ignored')) return { result: mode };
    const ruleConfig = config as unknown as RuleConfig;
    const known = facts as ReadonlyMap<string, string | number | boolean | null>;
    if (!broken('missing_fact_falls_to_mode')) return walkRules(ruleConfig, known);
    for (const [index, rule] of (ruleConfig.rules ?? []).entries()) {
      const one = walkRules({ mode, rules: [rule] }, known);
      if (one.rule !== undefined) return { ...one, rule: { index, then: one.rule.then } };
    }
    return { result: mode };
  };
  /** Rev 16: a considered entry's `rule` and `missing_facts`, from what its policy gave. */
  const walkMembers = (walk: WalkResult): Pick<Considered, 'rule' | 'missing_facts'> => ({
    ...(walk.rule === undefined ? {} : { rule: { ...walk.rule } }),
    ...(walk.missing_facts === undefined ? {} : { missing_facts: [...walk.missing_facts] }),
  });
  /** Rev 16: the members of a `tool_invocation` config that make its policy rule-bearing. */
  const RULE_BEARING: readonly string[] = ['rules', 'approvers', 'exclude'];

  /**
   * Rev 16: the requirements of an approval opened by `contributing` (the policies whose result asked, each once):
   * one per policy, its approver entries in force (those its walk names, see `WalkResult.approvers`, else the
   * policy's, keeping those whose `when` holds) and its `exclude`. Two with the same entries and `exclude` are one
   * requirement listing both policies.
   */
  const requirementsOf = (
    contributing: readonly { id: string; version: PolicyVersion; walk: WalkResult }[],
    facts: ReadonlyMap<string, string | number | boolean | null>
  ): Requirement[] => {
    const out: Requirement[] = [];
    const byKey = new Map<string, Requirement>();
    for (const entry of contributing) {
      const config = entry.version.config;
      const approvers: ApproverRef[] = approversInForce(
        (entry.walk.approvers ?? config.approvers) as readonly Approver[] | undefined,
        facts
      );
      const exclude = Array.isArray(config.exclude) ? config.exclude.map(String).sort() : [];
      const key = requirementKey({ approvers, exclude });
      const ref = { id: entry.id, version: entry.version.version };
      const same = byKey.get(key);
      if (same !== undefined) {
        same.policies.push(ref);
        continue;
      }
      const requirement: Requirement = {
        id: `r${String(out.length + 1)}`,
        policies: [ref],
        approvers,
        exclude,
        needed: 1,
        met: false,
        approvals: [],
      };
      byKey.set(key, requirement);
      out.push(requirement);
    }
    return out;
  };

  /**
   * Rev 16: the decision of a call that a published `tool_invocation` policy carrying `rules`, `approvers` or
   * `exclude` matches (by target and by a subject the caller holds), or undefined when none does and the fixture
   * decides. Every matching policy is evaluated over the facts of the call (its arguments, read through the tool's
   * bindings; none for a digest) and the results compose tightest-wins: the first policy of the tightest result
   * names the decision. A composed ask (`ask`, `escalate`) carries a requirement per policy that asked, where
   * `approvals.requirements` is served, and the facts that stopped the walk of a policy that asked
   * (`Decision.missing_facts`), when any did.
   */
  const ruledDecision = (
    c: Ctx,
    body: Obj,
    tool: ToolRow
  ):
    | {
        mode: string;
        policy: { id: string; version: number };
        requirements?: Requirement[];
        missing_facts?: string[];
      }
    | undefined => {
    if (!rulesServed()) return undefined;
    const p = principalOf(c);
    const action = isObj(body.action) ? body.action : {};
    const holder = callerHolder(p, isObj(body.actor) ? body.actor : {}, false);
    const matched: { id: string; version: PolicyVersion }[] = [];
    for (const row of state.policies.values()) {
      if (row.org !== p.org) continue;
      const version = inForce(String(row.id));
      if (version?.kind !== 'tool_invocation' || !targetsCover(version.targets, tool.tool_ref))
        continue;
      if (version.subjects.some((subject) => holder(subject)))
        matched.push({ id: String(row.id), version });
    }
    if (!matched.some((m) => RULE_BEARING.some((member) => m.version.config[member] !== undefined)))
      return undefined;
    const facts = readFacts(isObj(action.arguments) ? action.arguments : undefined, tool.facts);
    const evaluated = matched.map((m) => ({ ...m, walk: evaluatePolicy(m.version.config, facts) }));
    const tightest = Math.min(...evaluated.map((e) => tightnessOf(e.walk.result)));
    const contributing = evaluated.filter((e) => tightnessOf(e.walk.result) === tightest);
    const deciding = contributing[0];
    if (deciding === undefined) return undefined;
    const mode = deciding.walk.result;
    const asks = mode === 'ask' || mode === 'escalate';
    // A stopped walk asks, so only a composed ask can have contributing walks that missed a fact.
    const missing = [...new Set(contributing.flatMap((e) => e.walk.missing_facts ?? []))];
    return {
      mode,
      policy: { id: deciding.id, version: deciding.version.version },
      ...(missing.length > 0 ? { missing_facts: missing } : {}),
      ...(asks && requirementsServed()
        ? { requirements: requirementsOf(contributing, facts) }
        : {}),
    };
  };

  /**
   * A dry run of the decision for `body`, with `simulated` standing in for the stored version of policy
   * `policyId`. It lists every `tool_invocation` policy in force whose targets cover the tool and one of
   * whose subjects matches the holder (an entry per matching subject): the caller, or with `subject` a
   * hypothetical holder of it (rev 11). It composes them tightest-wins (rev 11, D-A89): the tightest mode of
   * every entry decides, and each entry of that mode `contributed`. The tool's own mode is the default entry,
   * a fallback listed only when nothing matched, so the decision always follows from what is listed. The
   * mock's `decide` is unchanged: its decision is the tool's `mode`. The organisation's duplicate-requests
   * setting is listed when the decision is a step-up or the simulated policy is itself a
   * `duplicate_requests` policy, and a step-up for an identity a resolver rejected within its window is
   * answered as decide would answer it; as a subject no rejection applies. Rev 13: `proposed` are unsaved bodies
   * (`POST /v1/policies/simulate`, with no `simulated` and an empty `policyId`) that stand beside the policies in
   * force, listed with a null `id` and `version` and their `proposed_index`. The defects leave out
   * `considered`, or `contributed`, or let a proposed body replace a stored policy.
   */
  const simulate = async (
    c: Ctx,
    body: Obj,
    policyId: string,
    simulated: PolicyVersion | undefined,
    proposed: readonly PolicyVersion[] = [],
    pendingTools: readonly ToolRow[] = []
  ): Promise<Obj | Response> => {
    const p = principalOf(c);
    const action = (body.action ?? {}) as Obj;
    const actor = isObj(body.actor) ? body.actor : {};
    const asSubject = isObj(body.subject);
    const holder = isObj(body.subject)
      ? subjectHolder(p.org, body.subject)
      : callerHolder(p, actor, broken('set_simulation_reads_hint') && policyId === '');
    const digest = await digestOf(action);
    // Rev 14: a tool a proposal would register stands beside the registered ones.
    const tool =
      callableToolOf(c, String(action.tool_ref)) ??
      pendingTools.find((t) => t.tool_ref === action.tool_ref);
    const entries: Considered[] = [];
    // Rev 16: the facts of the call, read through the tool's bindings; a digest supplies none.
    const facts = readFacts(isObj(action.arguments) ? action.arguments : undefined, tool?.facts);
    if (tool !== undefined) {
      for (const row of state.policies.values()) {
        if (row.org !== p.org) continue;
        const version = row.id === policyId ? simulated : inForce(String(row.id));
        if (version?.kind !== 'tool_invocation' || !targetsCover(version.targets, tool.tool_ref))
          continue;
        const walk = evaluatePolicy(version.config, facts);
        for (const subject of version.subjects) {
          if (!holder(subject)) continue;
          entries.push({
            kind: 'tool_invocation',
            id: String(row.id),
            version: version.version,
            result: walk.result,
            subject,
            ...walkMembers(walk),
          });
        }
      }
      // Rev 13: proposed bodies stand beside what is in force. The defect lets a body replace the stored
      // entries of the same subject instead.
      proposed.forEach((version, proposedIndex) => {
        if (version.kind !== 'tool_invocation' || !targetsCover(version.targets, tool.tool_ref))
          return;
        const walk = evaluatePolicy(version.config, facts);
        for (const subject of version.subjects) {
          if (!holder(subject)) continue;
          if (broken('simulate_set_replaces_stored')) {
            for (let at = entries.length - 1; at >= 0; at -= 1)
              if (entries[at]?.id !== null && sameSubject(entries[at]?.subject ?? {}, subject))
                entries.splice(at, 1);
          }
          entries.push({
            kind: 'tool_invocation',
            id: null,
            version: null,
            result: walk.result,
            subject,
            ...walkMembers(walk),
            proposed_index: proposedIndex,
            // The defect marks a proposed entry as a default of the deployment too.
            ...(broken('proposed_entry_has_source') ? { source: 'default' } : {}),
          });
        }
      });
    }
    const tightest = Math.min(...entries.map((e) => tightnessOf(e.result)));
    const contributing = entries.filter((e) => tightnessOf(e.result) === tightest);
    // The decision's policy is one of the contributing entries, the deployment's choice: the mock names the
    // simulated policy when it contributed, else the first contributing entry it listed.
    const deciding =
      contributing.find((e) => e.id !== null && e.id === policyId) ?? contributing[0];
    const missingFacts = [...new Set(contributing.flatMap((e) => e.missing_facts ?? []))];
    const contributedMember = (yes: boolean): Obj =>
      broken('considered_contributed_missing') ? {} : { contributed: yes };
    const listed: Considered[] = entries.map((entry) => ({
      ...entry,
      // The defect marks every entry as contributing, the allow a deny overruled included.
      ...contributedMember(contributing.includes(entry) || broken('every_entry_contributed')),
    }));
    if (tool !== undefined && deciding === undefined)
      listed.push({
        kind: 'tool_invocation',
        id: null,
        version: null,
        result: tool.mode,
        source: 'default',
        ...contributedMember(true),
      });
    let outcome: { decision: string; reason?: string } =
      tool === undefined
        ? { decision: 'deny', reason: 'unknown_tool' }
        : decisionOfMode(deciding?.result ?? tool.mode);
    let rejectedApprovalId: string | undefined;
    const proposedDuplicate = proposed.findIndex((v) => v.kind === 'duplicate_requests');
    if (
      tool !== undefined &&
      (outcome.decision === 'step_up' ||
        simulated?.kind === 'duplicate_requests' ||
        proposedDuplicate >= 0)
    ) {
      // Rev 13: a proposed duplicate_requests body stands beside the setting in force (the stored policy, else the
      // default); it never replaces it. A simulated stored policy stands in for itself. The defect lets the proposed
      // body replace the setting in force.
      interface DuplicateSetting {
        id?: string;
        version?: number;
        proposedIndex?: number;
        config: Obj;
      }
      const settings: DuplicateSetting[] =
        simulated?.kind === 'duplicate_requests'
          ? [{ id: policyId, version: simulated.version, config: simulated.config }]
          : [
              ...(proposedDuplicate >= 0 && broken('simulate_set_duplicate_replaces_in_force')
                ? []
                : [duplicateSetting(p.org)]),
              ...(proposedDuplicate >= 0
                ? [
                    {
                      proposedIndex: proposedDuplicate,
                      config: proposed[proposedDuplicate]?.config ?? {},
                    },
                  ]
                : []),
            ];
      const results = new Map<DuplicateSetting, string>();
      for (const setting of settings) results.set(setting, 'none');
      // A hypothetical holder has no rejections: as a subject the rule does not apply.
      if (outcome.decision === 'step_up' && !asSubject) {
        const scope = resolveScope(c, actor.run_id);
        if (scope instanceof Response) return scope;
        const identity = identityOf(p.org, scope.key, tool.tool_ref, digest, 'decisions');
        // As decide does: an identical open approval is joined, and the rule applies only when none is.
        const applies = subjectToDuplicateRule(p, scope) && findOpen(identity) === undefined;
        for (const setting of settings) {
          const verdict = applies ? duplicateVerdict(setting.config, identity) : undefined;
          if (verdict !== undefined) results.set(setting, verdict.kind);
          // The tightest wins: one setting that denies denies, whichever the others say.
          if (verdict?.kind === 'deny' && rejectedApprovalId === undefined) {
            outcome = { decision: 'deny', reason: 'rejected_duplicate' };
            rejectedApprovalId = verdict.approvalId;
          }
        }
      }
      for (const setting of settings) {
        const result = results.get(setting) ?? 'none';
        // It contributed only when it turned the step-up into a deny.
        const contributed = contributedMember(result === 'deny');
        listed.push(
          setting.proposedIndex !== undefined
            ? {
                kind: 'duplicate_requests',
                id: null,
                version: null,
                result,
                subject: { type: 'organization' },
                proposed_index: setting.proposedIndex,
                ...contributed,
              }
            : setting.id === undefined
              ? {
                  kind: 'duplicate_requests',
                  id: null,
                  version: null,
                  result,
                  source: 'default',
                  ...contributed,
                }
              : {
                  kind: 'duplicate_requests',
                  id: setting.id,
                  version: setting.version ?? null,
                  result,
                  subject: { type: 'organization' },
                  ...contributed,
                }
        );
      }
    }
    const policy =
      deciding === undefined || deciding.id === null || deciding.version === null
        ? broken('null_policy_on_default') &&
          tool !== undefined &&
          deciding?.proposed_index === undefined
          ? { policy: null }
          : {}
        : {
            policy: {
              id: deciding.id,
              version: deciding.version,
              side_effect_level: tool?.side_effect_level ?? 'read',
            },
          };
    return {
      decision: outcome.decision,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...policy,
      action_digest: digest,
      enforced: false,
      would_be: outcome.decision,
      ...(rejectedApprovalId === undefined ? {} : { rejected_approval_id: rejectedApprovalId }),
      // Rev 16: as `Decision.missing_facts`, from the contributing entries whose walk a missing fact stopped.
      ...(outcome.decision === 'step_up' && missingFacts.length > 0
        ? { missing_facts: missingFacts }
        : {}),
      ...(broken('simulate_considered_missing')
        ? {}
        : {
            considered: {
              policies: listed,
              composed: {
                decision: outcome.decision,
                ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
              },
            },
          }),
    };
  };

  // ---- deployment-applied proposals (rev 14) -----------------------------------------------------
  /**
   * Whether the mock applies `tool:noblecloak:propose-policy-set`: a deployment that authors and publishes
   * policies of its own (hosted) and serves the agents and approvals the change touches. Advertised as
   * `deployment_applied`; one that does not advertise it answers `approval_unroutable`.
   */
  const deploymentApplies = (): boolean =>
    config.deployment === 'hosted' &&
    served.has('approvals') &&
    served.has('policies') &&
    served.has('agents');

  /** The members of a proposal that fits `PolicySetProposal`, in the shape the checks read. */
  const proposalOf = (args: Obj): Proposal => ({
    ...(args.agent === undefined ? {} : { agent: args.agent as NonNullable<Proposal['agent']> }),
    tools: (args.tools as Obj[] | undefined) ?? [],
    policies: (args.policies as Obj[]).map((entry) => ({
      role: entry.role as RowKind,
      policy: entry.policy as Obj,
    })),
    tool_grants: (args.tool_grants as string[] | undefined) ?? [],
  });
  /** Rev 18: what the mock accepts in a proposal, as `Capabilities.proposals` advertises it. */
  const proposalsServed = (): ProposalsServed =>
    options.proposals ?? { row_kinds: ROW_KINDS, members: PROPOSAL_MEMBERS };
  /**
   * Rev 18: the refusal of a proposal whose `role` row the organisation is not entitled to, from `entitlements`, the
   * mock's stand-in for the organisation's (see `vetProposal` and `applyProposal`). It names the first such row.
   * The defect accepts it.
   */
  const entitlementRefusal = (
    proposal: Proposal,
    entitlements: readonly string[]
  ): Refusal | undefined => {
    const first = proposal.policies.findIndex((entry) => entry.role === 'role');
    if (
      first < 0 ||
      entitlements.includes(ROLE_SUBJECTS_ENTITLEMENT) ||
      broken('proposal_role_unentitled_accepted')
    )
      return undefined;
    return {
      code: 'not_entitled',
      member: proposalMember(`policies[${String(first)}]`),
      detail: `The organisation is not entitled to policies with a role subject (${ROLE_SUBJECTS_ENTITLEMENT}).`,
    };
  };
  /** The rows the proposal's `tools` would register, for the simulations and the checks that read them. */
  const pendingToolsOf = (org: string, proposal: Proposal): ToolRow[] =>
    proposal.tools.map((tool) => registeredTool(org, tool, { kind: 'org', id: org }));
  const proposalMember = (path: string): string => `${ARGUMENTS_AT}.${path}`;

  /**
   * The refusals of a proposal's policies that a create would make: a `config` that does not fit
   * `ToolInvocationConfig`, and `not_granted`, which no deployment implements yet. They are `shape`.
   */
  const policyFormRefusal = (proposal: Proposal): Refusal | undefined => {
    const fits = index.schema('ToolInvocationConfig');
    for (const [i, { policy }] of proposal.policies.entries()) {
      const where = `policies[${String(i)}].policy.config`;
      if (!fits(policy.config))
        return {
          code: 'shape',
          member: proposalMember(where),
          detail: `config does not fit a tool_invocation policy: ${describeErrors(fits)}`,
        };
      if ((policy.config as Obj).mode === 'not_granted')
        return {
          code: 'shape',
          member: proposalMember(`${where}.mode`),
          detail: 'not_granted is provisional, and this deployment does not implement it.',
        };
    }
    return undefined;
  };

  /** Whether a published policy of the role `everyone` already governs `toolRef` (by name or by `all`). */
  const everyoneGoverns = (org: string, toolRef: string): boolean =>
    [...state.policies.values()].some((row) => {
      const version = row.org === org ? inForce(String(row.id)) : undefined;
      return (
        version?.kind === 'tool_invocation' &&
        targetsCover(version.targets, toolRef) &&
        version.subjects.some((subject) => subject.type === 'role' && subject.id === EVERYONE_ROLE)
      );
    });

  /** Rev 18: the modes of the published `tool_invocation` policies of the role `everyone` that govern `toolRef`. */
  const everyoneModes = (org: string, toolRef: string): string[] =>
    [...state.policies.values()].flatMap((row) => {
      const version = row.org === org ? inForce(String(row.id)) : undefined;
      return version?.kind === 'tool_invocation' &&
        targetsCover(version.targets, toolRef) &&
        version.subjects.some((subject) => subject.type === 'role' && subject.id === EVERYONE_ROLE)
        ? [String(version.config.mode)]
        : [];
    });

  /**
   * Rev 18: the modes of the published `tool_invocation` policies that govern `toolRef` and whose subject a holder of
   * `subject` holds (for a role: the role itself, `everyone` and the organisation).
   */
  const heldModes = (org: string, toolRef: string, subject: Obj): string[] => {
    const holds = subjectHolder(org, subject);
    return [...state.policies.values()].flatMap((row) => {
      const version = row.org === org ? inForce(String(row.id)) : undefined;
      return version?.kind === 'tool_invocation' &&
        targetsCover(version.targets, toolRef) &&
        version.subjects.some(holds)
        ? [String(version.config.mode)]
        : [];
    });
  };

  /** The mode tightest-wins composes from `modes`, or `fallback` (the tool's default) when there are none. */
  const composedMode = (modes: readonly string[], fallback: string): string =>
    modes.reduce<string | undefined>(
      (tightest, mode) =>
        tightest === undefined || tightnessOfMode(mode) < tightnessOfMode(tightest)
          ? mode
          : tightest,
      undefined
    ) ?? fallback;

  /**
   * The checks of a proposal against the state now (opening runs them, and so does approving): the agent, the
   * principal, the tools, the targets, the baselines and the tightenings. The first that fails is the refusal.
   * The defects skip the baseline check, or the tightening check.
   */
  const stateRefusal = async (c: Ctx, proposal: Proposal): Promise<Refusal | undefined> => {
    const org = principalOf(c).org;
    const agent = proposal.agent === undefined ? undefined : state.agents.get(proposal.agent.id);
    if (proposal.agent !== undefined && agent?.org !== org)
      return {
        code: 'unknown_agent',
        member: proposalMember('agent.id'),
        detail: 'agent.id is not an agent of the organisation.',
      };
    const principalId = proposal.agent?.principal_id;
    if (agent !== undefined && principalId !== undefined) {
      const holder = agentBoundTo(org, principalId);
      if (holder !== undefined && holder.id !== agent.id)
        return {
          code: 'principal_bound',
          member: proposalMember('agent.principal_id'),
          detail: 'The service principal is already bound to another agent.',
        };
      if (!isServicePrincipalOf(org, principalId))
        return {
          code: 'shape',
          member: proposalMember('agent.principal_id'),
          detail: 'principal_id names no service principal of the organisation.',
        };
    }
    for (const [i, tool] of proposal.tools.entries())
      if ([...state.tools.values()].some((t) => t.org === org && t.tool_ref === tool.tool_ref))
        return {
          code: 'tool_ref_in_use',
          member: proposalMember(`tools[${String(i)}].tool_ref`),
          detail: `${String(tool.tool_ref)} is already in use in this organisation.`,
        };
    const proposedRefs = new Set(proposal.tools.map((tool) => String(tool.tool_ref)));
    for (const [i, { policy }] of proposal.policies.entries()) {
      const ref = targetOf(policy) ?? '';
      if (
        !proposedRefs.has(ref) &&
        ![...state.tools.values()].some(
          (t) => t.org === org && t.tool_ref === ref && t.status !== 'withdrawn'
        )
      )
        return {
          code: 'target_unknown',
          member: proposalMember(`policies[${String(i)}].policy.targets.tools[0]`),
          detail: `${ref} is neither a registered tool nor in the proposal's tools.`,
        };
    }
    // Rev 18: a grant names a tool the organisation holds now, not one this proposal registers: one it owns
    // (`owner_kind` `org`), so a tool a principal owns is refused as unknown, as for its owner, and the refusal tells
    // no proposer that it exists. The defect skips it.
    for (const [i, ref] of proposal.tool_grants.entries())
      if (
        !broken('proposal_unknown_grant_accepted') &&
        ![...state.tools.values()].some(
          (t) =>
            t.org === org &&
            t.tool_ref === ref &&
            t.owner.kind === 'org' &&
            t.status !== 'withdrawn'
        )
      )
        return {
          code: 'target_unknown',
          member: proposalMember(`tool_grants[${String(i)}]`),
          detail: `${ref} is no tool the organisation owns.`,
        };
    const pending = pendingToolsOf(org, proposal);
    for (const [i, { role, policy }] of proposal.policies.entries()) {
      const ref = targetOf(policy) ?? '';
      const member = proposalMember(`policies[${String(i)}]`);
      if (role === 'baseline') {
        if (everyoneGoverns(org, ref) && !broken('baseline_over_existing'))
          return {
            code: 'baseline_exists',
            member,
            detail: `A published policy of the role everyone already governs ${ref}: propose a tightening.`,
          };
        continue;
      }
      // Rev 18: no check compares a role row with the baseline; the preview reports one it shadows.
      if (role === 'role' || proposal.agent === undefined) continue;
      if (broken('tightening_looser_accepted')) continue;
      // What the agent gets without this tightening: the policies in force and the proposal's baselines.
      const baselines = proposal.policies
        .filter((other) => other.role === 'baseline' && targetOf(other.policy) === ref)
        .map((other) => writtenVersion(c, other.policy, 0, 'proposed'));
      const composed = await simulate(
        c,
        { action: { tool_ref: ref }, subject: { type: 'agent', id: proposal.agent.id } },
        '',
        undefined,
        baselines,
        pending
      );
      if (composed instanceof Response) continue;
      const mode = String((policy.config as Obj).mode);
      if (
        tightnessOfDecision(decisionOfMode(mode).decision) >
        tightnessOfDecision(String(composed.decision))
      )
        return {
          code: 'tightening_looser',
          member,
          detail: `The tightening for ${ref} is looser than the ${String(composed.decision)} the agent gets without it.`,
        };
    }
    return undefined;
  };

  /**
   * What approving a proposal would change (`Approval.preview`): for each tool its policies govern, the decision
   * composed for the agent with every proposed body beside the policies in force; the baselines that are looser
   * than the mode the tool has by default, and (rev 18) the role rows that loosen what their role gets; the role rows
   * a policy of `everyone` shadows; and the grants. The defects leave the loosening out, or only its role rows.
   */
  const previewOf = async (c: Ctx, proposal: Proposal): Promise<Obj> => {
    const org = principalOf(c).org;
    const pending = pendingToolsOf(org, proposal);
    const bodies = proposal.policies.map((entry, at) =>
      writtenVersion(c, entry.policy, 0, `proposed ${String(at)}`)
    );
    const refs = [...new Set(proposal.policies.map((entry) => targetOf(entry.policy) ?? ''))];
    // Rev 18: a proposal without an agent is simulated as the baseline every caller holds.
    const subject =
      proposal.agent === undefined
        ? { type: 'role', id: EVERYONE_ROLE }
        : { type: 'agent', id: proposal.agent.id };
    const simulations: Obj[] = [];
    for (const ref of refs) {
      const result = await simulate(
        c,
        { action: { tool_ref: ref }, subject },
        '',
        undefined,
        bodies,
        pending
      );
      if (!(result instanceof Response)) simulations.push({ tool_ref: ref, result });
    }
    const loosening: Obj[] = [];
    for (const { role, policy } of proposal.policies) {
      if (role === 'tightening') continue;
      const ref = targetOf(policy) ?? '';
      const registered = [...state.tools.values()].find((t) => t.org === org && t.tool_ref === ref);
      // The mode the tool has by default: its own, or `ask` for one this proposal registers.
      const fallback = registered?.mode ?? 'ask';
      const to = String((policy.config as Obj).mode);
      if (role === 'baseline') {
        if (tightnessOfMode(to) > tightnessOfMode(fallback))
          loosening.push({ tool_ref: ref, from: fallback, to });
        continue;
      }
      // Rev 18: a role row against what its role gets now, composed from the published policies it holds (of the
      // role, of everyone, of the organisation) or else the default, and what it gets with the proposal's baseline
      // and this row beside them. The rules allow one row per role and tool, so each row is its own entry.
      if (broken('preview_role_loosening_missing')) continue;
      const subject = (policy.subjects as Obj[])[0] ?? {};
      const held = heldModes(org, ref, subject);
      const proposed = proposal.policies
        .filter((other) => other.role === 'baseline' && targetOf(other.policy) === ref)
        .map((other) => String((other.policy.config as Obj).mode));
      const from = composedMode(held, fallback);
      const after = composedMode([...held, ...proposed, to], fallback);
      if (tightnessOfMode(after) > tightnessOfMode(from))
        loosening.push({ tool_ref: ref, from, to: after, subject });
    }
    // Rev 18: each role row whose mode is looser than the tightest mode `everyone` has for its tool, published or
    // proposed here: tightest-wins makes it change nothing for the role. The defect leaves it out.
    const ineffective: Obj[] = [];
    for (const { role, policy } of proposal.policies) {
      if (role !== 'role') continue;
      const ref = targetOf(policy) ?? '';
      const everyone = [
        ...everyoneModes(org, ref),
        ...proposal.policies
          .filter((other) => other.role === 'baseline' && targetOf(other.policy) === ref)
          .map((other) => String((other.policy.config as Obj).mode)),
      ];
      const mode = String((policy.config as Obj).mode);
      if (everyone.some((other) => tightnessOfMode(other) < tightnessOfMode(mode)))
        ineffective.push({ tool_ref: ref, subject: (policy.subjects as Obj[])[0] ?? {} });
    }
    return {
      simulations,
      loosening: broken('preview_loosening_missing') ? [] : loosening,
      ...(broken('preview_ineffective_missing') ? {} : { ineffective }),
      // Rev 18: the grants approving records, where the proposal carries any. The defect leaves them out.
      ...(proposal.tool_grants.length === 0 || broken('preview_grants_missing')
        ? {}
        : { grants: proposal.tool_grants.map((ref) => ({ tool_ref: ref })) }),
    };
  };

  /**
   * Opens a proposal: the reference must be one this deployment applies; the caller must be a person; the body
   * must fit its schema and the rules beyond it, and pass the checks against the state. A refusal is 422
   * `proposal_refused` with `code`, and `member` where it names a part of the body. The answer is the fixed tool
   * row the approval is for, the proposal, and its preview. The defects: a service principal may propose, and the
   * refusal carries no `code`.
   */
  const vetProposal = async (
    c: Ctx,
    action: Obj
  ): Promise<
    Response | { tool: ToolRow; proposal: Proposal; preview: Obj; entitlements: readonly string[] }
  > => {
    const ref = String(action.tool_ref);
    if (ref !== PROPOSE_POLICY_SET || !deploymentApplies())
      return problem(
        c,
        422,
        'approval_unroutable',
        `${ref} is not a deployment-applied reference this deployment applies.`
      );
    const surface = surfaceMayNotOpen(c);
    if (surface !== undefined) return surface;
    const refuse = (refusal: Refusal): Response =>
      problem(
        c,
        422,
        'proposal_refused',
        refusal.detail,
        broken('proposal_refusal_code_missing')
          ? {}
          : {
              code: refusal.code,
              ...(refusal.member === undefined ? {} : { member: refusal.member }),
            }
      );
    if (principalOf(c).kind !== 'user' && !broken('service_principal_can_propose'))
      return refuse({
        code: 'not_a_user',
        detail: 'Only a person proposes; a service principal or an agent is refused.',
      });
    if (!isObj(action.arguments))
      return refuse({
        code: 'shape',
        member: ARGUMENTS_AT,
        detail: 'A proposal carries its arguments, not only a digest of them.',
      });
    const fits = index.schema(PROPOSAL_SCHEMA);
    if (!fits(action.arguments)) return refuse(schemaRefusal(fits.errors));
    const proposal = proposalOf(action.arguments);
    // Rev 18: the opener's entitlements stand in for the organisation's (the mock keeps none per organisation).
    const entitlements = principalOf(c).entitlements;
    const refused =
      ruleRefusal(proposal, {
        modeOnly: !broken('proposal_config_beyond_mode_accepted'),
        baselineModeOnly: !broken('proposal_baseline_config_beyond_mode_accepted'),
        grantsNeedPrincipal: !broken('proposal_grants_without_principal_accepted'),
        served: proposalsServed(),
      }) ??
      policyFormRefusal(proposal) ??
      entitlementRefusal(proposal, entitlements) ??
      (await stateRefusal(c, proposal));
    if (refused !== undefined) return refuse(refused);
    return {
      tool: appliedTool(principalOf(c).org),
      proposal,
      preview: await previewOf(c, proposal),
      entitlements,
    };
  };

  /**
   * Applies an approved proposal, all or nothing, as the approver: registers the tools, binds the principal, records
   * the tool grants (rev 18), then creates and publishes each policy in order. The checks run again first, against
   * the state now; the entitlement check (rev 18) reads the approving token's `entitlements` claim when it carries
   * one, and otherwise the entitlements recorded when the proposal was opened. Any
   * failure restores what was there and is the refusal (`policy_conflict` when a policy to publish meets a
   * published one of the same tool and subject); nothing is emitted until all of it is applied. The defects
   * leave what the steps before a failure did, and skip the checks.
   */
  const applyProposal = async (
    c: Ctx,
    o: Obligation,
    proposal: Proposal
  ): Promise<Refusal | undefined> => {
    const p = principalOf(c);
    const entitlements =
      p.entitlementsClaimed === true ? p.entitlements : (o.entitlementsAtOpen ?? []);
    const refused = broken('proposal_recheck_skipped')
      ? undefined
      : (entitlementRefusal(proposal, entitlements) ?? (await stateRefusal(c, proposal)));
    if (refused !== undefined) return refused;
    const agentId = proposal.agent?.id;
    const grantee =
      proposal.agent?.principal_id === undefined
        ? undefined
        : `${o.org}|${proposal.agent.principal_id}`;
    const before = {
      tools: new Map(state.tools),
      policies: new Map(state.policies),
      versions: new Map(state.policyVersions),
      principal: agentId === undefined ? undefined : state.agents.get(agentId)?.principal_id,
      grants: grantee === undefined ? undefined : state.toolGrants.get(grantee),
    };
    const restore = (): void => {
      state.tools.clear();
      for (const [key, row] of before.tools) state.tools.set(key, row);
      state.policies.clear();
      for (const [key, row] of before.policies) state.policies.set(key, row);
      state.policyVersions.clear();
      for (const [key, versions] of before.versions) state.policyVersions.set(key, versions);
      const agent = agentId === undefined ? undefined : state.agents.get(agentId);
      if (agent !== undefined) agent.principal_id = before.principal ?? null;
      if (grantee !== undefined) {
        if (before.grants === undefined) state.toolGrants.delete(grantee);
        else state.toolGrants.set(grantee, before.grants);
      }
    };
    for (const tool of proposal.tools) {
      const row = registeredTool(o.org, tool, { kind: 'org', id: o.org });
      state.tools.set(toolKey(row.org, row.tool_ref), row);
    }
    const agent = agentId === undefined ? undefined : state.agents.get(agentId);
    if (agent !== undefined && proposal.agent?.principal_id !== undefined)
      agent.principal_id = proposal.agent.principal_id;
    // Rev 18: the grants, kept beside the ones the principal already holds (a grant that exists stays as it is).
    if (grantee !== undefined && proposal.tool_grants.length > 0)
      state.toolGrants.set(grantee, new Set([...(before.grants ?? []), ...proposal.tool_grants]));
    const published: Obj[] = [];
    for (const { policy } of proposal.policies) {
      const id = `pol_${crypto.randomUUID().slice(0, 8)}`;
      const draft = writtenVersion(c, policy, 1, `${String(policy.kind)} ${id}`);
      state.policyVersions.set(id, [draft]);
      const row = syncPolicy(p.org, id, 'authored');
      const governing = conflictOf(row, draft);
      if (governing !== undefined) {
        if (!broken('proposal_effect_partial')) restore();
        return {
          code: 'policy_conflict',
          detail: `Published policy ${governing} already governs a (tool, subject) pair of the proposal.`,
        };
      }
      draft.published_at = stamp().toISOString();
      syncPolicy(p.org, id, 'authored');
      published.push({
        policy_id: id,
        kind: draft.kind,
        version: 1,
        published_at: draft.published_at,
      });
    }
    for (const data of published)
      emitEvent(p.org, 'policy.published', String(data.policy_id), data);
    return undefined;
  };

  // ---- connections and tools -----------------------------------------------------------------
  const owner = (c: Ctx, kind: unknown): Obj => {
    const p = principalOf(c);
    return kind === 'org' ? { kind: 'org', id: p.org } : { kind: 'principal', id: p.sub };
  };
  /** Rev 11: an administrator of the organisation for connections: a user it recognises as one, never a service principal. */
  const isConnectionAdmin = (p: Principal): boolean =>
    p.kind === 'user' && ADMIN_SUBS.includes(p.sub);
  /** Rev 11: whether the mock serves per-user credential links (`connections.user_links`): hosted, with the family. */
  const userLinksServed = (): boolean =>
    config.deployment === 'hosted' && served.has('connections');
  /** A registration's kind of authentication (rev 11). */
  const authKindOf = (row: Obj): string => (isObj(row.auth) ? String(row.auth.kind) : 'none');
  /** Whether a registration takes per-user links (rev 11): `per_user`, with an authentication to link, where links are served. */
  const takesLinks = (row: Obj): boolean =>
    userLinksServed() && row.credential_tier === 'per_user' && authKindOf(row) !== 'none';
  /** A principal's link to a registration (rev 11). */
  const linkOf = (row: Obj, p: Pick<Principal, 'org' | 'sub'>): LinkRow | undefined =>
    state.links.get(linkKey(String(row.id), p.org, p.sub));
  /** Whether a link may be used: it holds a credential and its holder consents (rev 11). */
  const usable = (link: LinkRow | undefined): boolean =>
    link?.status === 'linked' && link.consent === 'given';
  /**
   * `my_link` for `reader` (rev 11): its own link and nobody else's, without the credential. The defects show
   * another user's link, and echo the stored credential.
   */
  const myLinkOf = (row: Obj, reader: Principal): Obj => {
    const own = linkOf(row, reader);
    const someone = broken('link_visible_to_other_user')
      ? [...state.links.entries()].find(([key]) => key.startsWith(`${String(row.id)}|`))?.[1]
      : undefined;
    const link = someone ?? own;
    if (link === undefined) return { status: 'none', consent: 'none' };
    return {
      status: link.status,
      consent: link.consent,
      ...(link.linked_at === undefined ? {} : { linked_at: link.linked_at }),
      ...(broken('connection_token_echoed') && link.token !== undefined
        ? { token: link.token }
        : {}),
    };
  };
  /**
   * Whether the caller sees a connection (rev 11, `Owner`): one of its organisation owned by the organisation, or
   * by a principal who is the caller, or any when the caller is an administrator. The defect shows a principal's
   * connection to every colleague.
   */
  const canSeeConnection = (c: Ctx, row: Obj): boolean => {
    if (!visible(c, String(row.org))) return false;
    const holder = row.owner as { kind: string; id: string };
    const p = principalOf(c);
    return (
      holder.kind !== 'principal' ||
      holder.id === p.sub ||
      isConnectionAdmin(p) ||
      broken('connection_owner_visible')
    );
  };
  const connectionFor = (c: Ctx, id: string): Obj | undefined => {
    const row = state.connections.get(id);
    return row !== undefined && canSeeConnection(c, row) ? row : undefined;
  };
  /**
   * Who changes, refreshes and deletes a connection (rev 11), in every profile: the authority that owns it. An
   * organisation's registration is changed by its administrators only; a principal's by that principal and by
   * administrators. The defect lets any member who sees an organisation's registration change it.
   */
  const changeRefused = (c: Ctx, row: Obj): Response | undefined => {
    const p = principalOf(c);
    const holder = row.owner as { kind: string; id: string };
    const mayChange = isConnectionAdmin(p) || (holder.kind === 'principal' && holder.id === p.sub);
    return mayChange || broken('org_connection_change_unguarded')
      ? undefined
      : problem(
          c,
          403,
          'forbidden',
          "Only administrators of the organisation change the organisation's connections."
        );
  };
  /**
   * What a client sees of a registration: never the organisation credential, the `auth` it was registered with
   * (only its kind), or the mock's server identity. The defect echoes the organisation credential.
   */
  const connectionView = (row: Obj, reader: Principal): Obj => {
    const auth: Obj = isObj(row.auth) ? row.auth : { kind: 'none' };
    return {
      ...without(row, 'org', 'auth', 'orgCredential', 'serverKey'),
      auth_kind: auth.kind,
      // Rev 11: the reader's own link, on every read of a registration that takes links.
      ...(takesLinks(row) ? { my_link: myLinkOf(row, reader) } : {}),
      ...(broken('org_credential_echoed') && typeof row.orgCredential === 'string'
        ? { org_credential: { token: row.orgCredential } }
        : {}),
    };
  };
  /** The tier a create gets (rev 11): the one asked for, else per_user where links are served, else org_shared. */
  const tierOf = (body: Obj): string =>
    typeof body.credential_tier === 'string'
      ? body.credential_tier
      : userLinksServed()
        ? 'per_user'
        : 'org_shared';
  /**
   * The credential rules of a create (rev 11): an administrator alone sets the tier or the organisation
   * credential; per_user needs per-user links; the organisation credential goes with org_shared and bearer, which
   * needs it; and an org_shared tier asked for with no authentication has nothing to hold a credential for.
   */
  const credentialRefused = (c: Ctx, body: Obj): Response | undefined => {
    const kind = isObj(body.auth) ? String(body.auth.kind) : 'none';
    if (
      (body.credential_tier !== undefined || body.org_credential !== undefined) &&
      !isConnectionAdmin(principalOf(c))
    )
      return problem(
        c,
        403,
        'forbidden',
        'Only an administrator sets the credential tier or the organisation credential.'
      );
    const tier = tierOf(body);
    if (tier === 'per_user' && !userLinksServed())
      return problem(
        c,
        400,
        'invalid_request',
        'credential_tier: this deployment does not serve per-user links.'
      );
    if (body.org_credential !== undefined && !(tier === 'org_shared' && kind === 'bearer'))
      return problem(
        c,
        400,
        'invalid_request',
        'org_credential: legal only with credential_tier org_shared and auth.kind bearer.'
      );
    if (tier === 'org_shared' && kind === 'bearer' && body.org_credential === undefined)
      return problem(
        c,
        400,
        'invalid_request',
        'org_credential: an org_shared registration with bearer authentication needs one.'
      );
    if (body.credential_tier === 'org_shared' && kind === 'none')
      return problem(
        c,
        400,
        'invalid_request',
        'credential_tier: an organisation credential needs a kind of authentication.'
      );
    return undefined;
  };
  /** The rows of the tools a server offers, as refresh would register them (rev 11). */
  const offeredTools = (row: Obj): ToolRow[] =>
    CANNED_TOOLS.map((tool) => {
      const ref = `${String(row.transport)}:${stableHash(String(row.serverKey))}:${tool.name}`;
      return {
        org: String(row.org),
        id: `tool_${ref.replace(/[^a-z0-9]+/gi, '_')}`,
        tool_ref: ref,
        connection_id: String(row.id),
        description: tool.description,
        transport: row.transport as ToolRow['transport'],
        input_schema: { type: 'object' },
        side_effect_level: tool.side_effect_level,
        data_routing: 'org_only',
        owner: row.owner as ToolRow['owner'],
        mode: tool.mode,
        default_policy: true,
        show_arguments_to_approvers: false,
        status: 'active',
        server_key: String(row.serverKey),
      };
    });
  app.get('/v1/connections', (c) =>
    paged(
      c,
      [...state.connections.values()]
        .filter((r) => canSeeConnection(c, r))
        .map((r) => connectionView(r, principalOf(c)))
    )
  );
  app.post('/v1/connections', async (c) => {
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const p = principalOf(c);
    const body = parsed.body;
    const ownerKind = body.owner_kind === 'org' ? 'org' : 'principal';
    const registration = options.connectionRegistration;
    if (registration !== undefined && !broken('connection_registration_not_enforced')) {
      if (!registration.owner_kinds.includes(ownerKind))
        return problem(
          c,
          403,
          'forbidden',
          `This deployment does not register ${ownerKind}-owned connections.`
        );
      if (registration.who === 'administrators' && !isConnectionAdmin(p))
        return problem(
          c,
          403,
          'forbidden',
          'Only administrators of the organisation register connections.'
        );
    }
    if (
      options.connectionTransports !== undefined &&
      !(options.connectionTransports as readonly string[]).includes(String(body.transport)) &&
      !broken('undeclared_transport_accepted')
    )
      return problem(
        c,
        400,
        'invalid_request',
        `This deployment does not serve the ${String(body.transport)} transport.`
      );
    // Rev 11: a URL is no place for a credential, and it is shown to every member who sees the registration.
    try {
      const parsedUrl = new URL(String(body.url));
      if (parsedUrl.username !== '' || parsedUrl.password !== '')
        return problem(
          c,
          400,
          'invalid_request',
          'url: a connection URL carries no userinfo; send a credential as org_credential or a link.'
        );
    } catch {
      // The schema's uri format refused anything that does not parse.
    }
    const refused = credentialRefused(c, body);
    if (refused !== undefined) return refused;
    // One registration per server per organisation; the existing one is named only to a caller who sees it.
    const serverKey = serverKeyOf(String(body.url));
    const existing = [...state.connections.values()].find(
      (r) => r.org === p.org && r.serverKey === serverKey
    );
    if (existing !== undefined && !broken('duplicate_server_accepted'))
      return problem(
        c,
        409,
        'connection_exists',
        'The organisation already has a registration of this server.',
        canSeeConnection(c, existing) ? { connection_id: existing.id } : {}
      );
    const auth = isObj(body.auth) ? body.auth : { kind: 'none' };
    const tier = tierOf(body);
    const pending = tier === 'org_shared' && auth.kind === 'oauth';
    const now = state.now().toISOString();
    const row: Obj = {
      org: p.org,
      id: `conn_${crypto.randomUUID().slice(0, 8)}`,
      name: body.name,
      url: body.url,
      transport: body.transport,
      owner: owner(c, ownerKind),
      created_at: now,
      status: pending ? 'pending_authorization' : 'connected',
      last_verified_at: pending ? null : now,
      credential_tier: tier,
      auth,
      serverKey,
      ...(isObj(body.org_credential) ? { orgCredential: String(body.org_credential.token) } : {}),
    };
    state.connections.set(String(row.id), row);
    // Registering a server again re-binds the tools its last registration left withdrawn.
    for (const tool of state.tools.values())
      if (tool.org === p.org && tool.server_key === serverKey && tool.status === 'withdrawn') {
        tool.status = 'active';
        tool.connection_id = String(row.id);
        tool.owner = row.owner as ToolRow['owner'];
      }
    return ok(c, connectionView(row, p), 201);
  });
  app.post('/v1/connections/:id/discover', (c) => {
    const row = connectionFor(c, c.req.param('id'));
    // A live dry run: what the server offers, registered or not, and nothing is written.
    return row === undefined
      ? problem(c, 404, 'not_found')
      : ok(c, offeredTools(row).map(toolView));
  });
  app.post('/v1/connections/:id/refresh', (c) => {
    const row = connectionFor(c, c.req.param('id'));
    if (row === undefined) return problem(c, 404, 'not_found');
    const refusedChange = changeRefused(c, row);
    if (refusedChange !== undefined) return refusedChange;
    const offered = offeredTools(row);
    let added = 0;
    let removed = 0;
    let reactivated = 0;
    if (broken('refresh_does_not_register')) added = offered.length;
    else {
      for (const tool of offered) {
        const held = state.tools.get(toolKey(tool.org, tool.tool_ref));
        if (held === undefined) {
          state.tools.set(toolKey(tool.org, tool.tool_ref), tool);
          added += 1;
          continue;
        }
        // A reference another way registered (POST /v1/tools, another server) is not this server's to take.
        if (held.server_key !== row.serverKey) continue;
        if (held.status === 'withdrawn') reactivated += 1;
        held.status = 'active';
        held.connection_id = String(row.id);
      }
      // A tool of this server that is no longer offered is withdrawn (the canned list never shrinks, so none is).
      for (const tool of state.tools.values())
        if (
          tool.org === row.org &&
          tool.server_key === row.serverKey &&
          tool.status !== 'withdrawn' &&
          !offered.some((o) => o.tool_ref === tool.tool_ref)
        ) {
          tool.status = 'withdrawn';
          removed += 1;
        }
    }
    row.last_verified_at = state.now().toISOString();
    return ok(c, { tool_count: offered.length, added, removed, reactivated });
  });
  /** An authorization in flight goes with the link or the consent it was for (rev 11). */
  const dropAuthorizations = (connectionId: string, p: Pick<Principal, 'org' | 'sub'>): void => {
    for (const [key, pending] of [...state.authorizations.entries()])
      if (pending.connectionId === connectionId && pending.org === p.org && pending.sub === p.sub)
        state.authorizations.delete(key);
  };
  app.post('/v1/connections/:id/link', async (c) => {
    // The defect reads a link without consent as one with it.
    const parsed = await validatedBody(c, (body) => {
      if (broken('link_without_consent_accepted') && body.consent !== true) body.consent = true;
      return undefined;
    });
    if ('response' in parsed) return parsed.response;
    const row = connectionFor(c, c.req.param('id'));
    if (row === undefined) return problem(c, 404, 'not_found');
    const p = principalOf(c);
    if (row.credential_tier !== 'per_user' || authKindOf(row) === 'none')
      return problem(
        c,
        400,
        'invalid_request',
        'Nothing to link: the registration is not per_user, or its server takes no authentication.'
      );
    const token = typeof parsed.body.token === 'string' ? parsed.body.token : undefined;
    const held = linkOf(row, p);
    if (authKindOf(row) === 'oauth' && token !== undefined)
      return problem(
        c,
        400,
        'invalid_request',
        'token: an OAuth link is authorized, not given a token (POST /v1/connections/{id}/authorize).'
      );
    if (authKindOf(row) === 'bearer' && token === undefined && held?.token === undefined)
      return problem(
        c,
        400,
        'invalid_request',
        'token: the first link to a bearer server needs one.'
      );
    const now = state.now().toISOString();
    const next: LinkRow =
      authKindOf(row) === 'bearer'
        ? {
            status: 'linked',
            consent: 'given',
            linked_at: token === undefined ? (held?.linked_at ?? now) : now,
            // Checked above: a first bearer link carries a token, and a later one keeps the stored one.
            token: token ?? held?.token ?? '',
          }
        : // OAuth: consent is given again, and a link that was authorized stays linked.
          held === undefined
          ? { status: 'pending_authorization', consent: 'given' }
          : { ...held, consent: 'given' };
    state.links.set(linkKey(String(row.id), p.org, p.sub), next);
    return ok(c, connectionView(row, p));
  });
  app.delete('/v1/connections/:id/link/consent', (c) => {
    const row = connectionFor(c, c.req.param('id'));
    if (row === undefined) return problem(c, 404, 'not_found');
    const held = linkOf(row, principalOf(c));
    if (held === undefined)
      return problem(c, 404, 'not_found', 'The caller has no link to revoke.');
    // The credential is kept; only consent goes. The defect answers 204 and changes nothing.
    if (!broken('consent_revoke_ignored')) {
      held.consent = 'revoked';
      dropAuthorizations(String(row.id), principalOf(c));
    }
    return c.body(null, 204);
  });
  app.delete('/v1/connections/:id/link', (c) => {
    const row = connectionFor(c, c.req.param('id'));
    if (row === undefined) return problem(c, 404, 'not_found');
    const p = principalOf(c);
    state.links.delete(linkKey(String(row.id), p.org, p.sub));
    dropAuthorizations(String(row.id), p);
    return c.body(null, 204);
  });
  /** The origins an authorization may return to (rev 11): the mock's module origin, the registered ones, the CORS ones. */
  const admitsReturn = (org: string, returnTo: string): boolean => {
    let origin: string;
    try {
      origin = new URL(returnTo).origin;
    } catch {
      return false;
    }
    return ownOrigins.has(origin) || (state.origins.get(org) ?? []).includes(origin);
  };
  app.post('/v1/connections/:id/authorize', async (c) => {
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const row = connectionFor(c, c.req.param('id'));
    if (row === undefined) return problem(c, 404, 'not_found');
    const p = principalOf(c);
    if (authKindOf(row) !== 'oauth')
      return problem(
        c,
        400,
        'invalid_request',
        'The registration does not authenticate with OAuth.'
      );
    let sub: string | undefined;
    if (row.credential_tier === 'org_shared') {
      if (!isConnectionAdmin(p))
        return problem(
          c,
          403,
          'forbidden',
          "Only an administrator authorizes the organisation's credential."
        );
      // Rev 11: a `connected` registration is authorized again (a new credential, or consent again).
      if (
        row.status !== 'pending_authorization' &&
        row.status !== 'degraded' &&
        row.status !== 'connected'
      )
        return problem(c, 400, 'invalid_request', 'The registration cannot be authorized now.');
    } else {
      // A link in any of its states (`pending_authorization`, `degraded`, or `linked`, authorized again) with consent.
      const held = linkOf(row, p);
      if (held?.consent !== 'given')
        return problem(
          c,
          400,
          'invalid_request',
          'Link first: POST /v1/connections/{id}/link with consent, then authorize the link.'
        );
      sub = p.sub;
    }
    const returnTo = String(parsed.body.return_to);
    if (!admitsReturn(p.org, returnTo) && !broken('authorize_return_unchecked'))
      return problem(
        c,
        400,
        'invalid_request',
        'return_to: not an origin this deployment admits for browser modules.'
      );
    // A re-authorization keeps the credential in use until its round trip completes. The defect drops it at once.
    if (broken('reauthorize_drops_credential')) {
      if (sub === undefined) {
        if (row.status === 'connected') row.status = 'pending_authorization';
      } else {
        const held = linkOf(row, p);
        if (held?.status === 'linked') held.status = 'pending_authorization';
      }
    }
    const authorization = crypto.randomUUID();
    const expiresAt = new Date(state.now().getTime() + AUTHORIZATION_TTL_MS);
    state.authorizations.set(authorization, {
      connectionId: String(row.id),
      org: p.org,
      sub,
      returnTo,
      expiresAt,
    });
    return ok(c, {
      authorization_url: `${new URL(c.req.url).origin}/__mock/consent/${authorization}`,
      expires_at: expiresAt.toISOString(),
    });
  });
  app.get('/v1/connections/:id', (c) => {
    const row = connectionFor(c, c.req.param('id'));
    return row === undefined
      ? problem(c, 404, 'not_found')
      : ok(c, connectionView(row, principalOf(c)));
  });
  app.patch('/v1/connections/:id', async (c) => {
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const row = connectionFor(c, c.req.param('id'));
    if (row === undefined) return problem(c, 404, 'not_found');
    const refusedChange = changeRefused(c, row);
    if (refusedChange !== undefined) return refusedChange;
    const body = parsed.body;
    // A connection's URL is its tools' identity (rev 11). The defect moves it.
    if (body.url !== undefined && !broken('patch_url_accepted'))
      return problem(
        c,
        400,
        'invalid_request',
        "url: a connection's URL is the identity of its tools; register the new URL instead."
      );
    if (isObj(body.org_credential)) {
      if (!isConnectionAdmin(principalOf(c)))
        return problem(
          c,
          403,
          'forbidden',
          'Only an administrator rotates the organisation credential.'
        );
      const kind = isObj(row.auth) ? row.auth.kind : 'none';
      if (row.credential_tier !== 'org_shared' || kind !== 'bearer')
        return problem(
          c,
          400,
          'invalid_request',
          'org_credential: only an org_shared registration with bearer authentication has one.'
        );
      row.orgCredential = String(body.org_credential.token);
    }
    if (typeof body.name === 'string') row.name = body.name;
    if (typeof body.url === 'string') {
      row.url = body.url;
      row.serverKey = serverKeyOf(body.url);
    }
    return ok(c, connectionView(row, principalOf(c)));
  });
  app.delete('/v1/connections/:id', (c) => {
    const row = connectionFor(c, c.req.param('id'));
    if (row === undefined) return problem(c, 404, 'not_found');
    const refusedChange = changeRefused(c, row);
    if (refusedChange !== undefined) return refusedChange;
    // Its tools stay, withdrawn, with the connection they were last registered from.
    for (const tool of state.tools.values())
      if (tool.org === row.org && tool.connection_id === row.id) tool.status = 'withdrawn';
    // Every user's link to it goes with it.
    for (const key of [...state.links.keys()])
      if (key.startsWith(`${String(row.id)}|`)) state.links.delete(key);
    for (const [key, pending] of [...state.authorizations.entries()])
      if (pending.connectionId === row.id) state.authorizations.delete(key);
    state.connections.delete(String(row.id));
    return c.body(null, 204);
  });

  const toolView = (t: ToolRow): Obj => ({
    ...without(
      t as unknown as Obj,
      'mode',
      'org',
      'default_policy',
      'policy_id',
      'dispatched_under_other_identity',
      'server_key'
    ),
    // Rev 11: every tool says whether it is active.
    status: t.status ?? 'active',
  });
  app.get('/v1/tools', (c) => {
    const connection = c.req.query('connection');
    return paged(
      c,
      [...state.tools.values()]
        .filter((t) => canSeeTool(c, t))
        .filter((t) => connection === undefined || t.connection_id === connection)
        .map(toolView)
        // Rev 14: a deployment-applied reference is never listed. The defect lists it.
        .concat(
          broken('deployment_applied_listed_as_tool') && connection === undefined
            ? [toolView(appliedTool(principalOf(c).org))]
            : []
        )
    );
  });
  /** The row a registration (`POST /v1/tools`, or the approval of a proposal's tools) makes. */
  const registeredTool = (org: string, b: Obj, ownedBy: ToolRow['owner']): ToolRow => ({
    org,
    id: `tool_${crypto.randomUUID().slice(0, 8)}`,
    tool_ref: String(b.tool_ref),
    connection_id: null,
    description: typeof b.description === 'string' ? b.description : '',
    transport: 'external',
    input_schema: b.input_schema as Obj,
    side_effect_level: String(b.side_effect_level),
    data_routing: 'caller',
    owner: ownedBy,
    mode: 'ask',
    // No explicit policy matches a tool registered through the API: the default applies to it.
    default_policy: true,
    show_arguments_to_approvers: b.show_arguments_to_approvers === true,
    // Rev 16: the facts it declares.
    ...(isObj(b.facts) ? { facts: b.facts as unknown as FactBindings } : {}),
  });
  /**
   * Rev 16: 400 `invalid_request` naming the binding in `member` for a fact binding whose path is outside the
   * deterministic subset (`[*]`, `..key`), read before the schema so the refusal names the fact. A binding the schema
   * refuses for another reason, or under a name that is no fact name, is left to the schema.
   */
  const factPathRefused = (c: Ctx, body: Obj): Response | undefined => {
    if (!isObj(body.facts)) return undefined;
    for (const [name, binding] of Object.entries(body.facts)) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(name) || !isObj(binding)) continue;
      if (typeof binding.path === 'string' && pathSegments(binding.path) === undefined)
        return problem(
          c,
          400,
          'invalid_request',
          `facts.${name}.path: ${binding.path} is not a path of members and indexes; a wildcard or a recursive descent selects a set, not one value.`,
          { member: `facts.${name}.path` }
        );
    }
    return undefined;
  };
  app.post('/v1/tools', async (c) => {
    const parsed = await validatedBody(c, (body) => factPathRefused(c, body));
    if ('response' in parsed) return parsed.response;
    const refusedRegistration = registrationRefused(c);
    if (refusedRegistration !== undefined) return refusedRegistration;
    const b = parsed.body;
    const toolRef = String(b.tool_ref);
    if (SYSTEM_TOOL_REFS.includes(toolRef) && !broken('system_tool_ref_accepted'))
      return problem(c, 422, 'system_tool_ref', `${toolRef} is a system tool.`);
    if (
      (toolRef.startsWith(RESERVED_TOOL_PREFIX) && !broken('reserved_tool_ref_accepted')) ||
      // Rev 14: the namespace of the references the deployment applies itself. The defect registers a tool under it.
      (isDeploymentApplied(toolRef) && !broken('reserved_namespace_registrable'))
    )
      return problem(
        c,
        422,
        'reserved_tool_ref',
        'The reference is in a namespace this deployment reserves.'
      );
    // A reference the mock already dispatches under another identity would be shadowed by the new tool.
    // This runs before the already-registered checks: it is a different case from them.
    const inUse = [...state.tools.values()].find(
      (t) =>
        t.dispatched_under_other_identity === true && t.tool_ref === toolRef && visible(c, t.org)
    );
    if (inUse !== undefined && !broken('tool_ref_in_use_accepted'))
      return problem(
        c,
        422,
        'tool_ref_in_use',
        `${toolRef} is already in use in this organisation for a tool registered another way.`
      );
    // A reference is unique per organisation, so one held by a tool the caller cannot see is registered already.
    const existing = state.tools.get(toolKey(principalOf(c).org, toolRef));
    // A tool the caller cannot see is answered with the one refusal, whatever level was asked for, and
    // nothing of the tool. The defect answers it as for a visible tool, so the level shows.
    if (
      existing !== undefined &&
      !canSeeTool(c, existing) &&
      !broken('hidden_tool_clash_reveals_level')
    )
      return problem(
        c,
        422,
        'tool_ref_in_use',
        `${toolRef} is already in use in this organisation.`
      );
    if (existing !== undefined) {
      if (
        fallsFrom(existing.side_effect_level, String(b.side_effect_level)) &&
        !broken('side_effect_level_downgrade_accepted')
      )
        return problem(
          c,
          409,
          'side_effect_level_downgrade',
          `${toolRef} is registered at ${existing.side_effect_level}; a level never falls.`
        );
      if (!broken('side_effect_level_downgrade_accepted'))
        return problem(c, 400, 'invalid_request', `${toolRef} is already registered.`);
      // The defect: the lower level replaces the registered one.
      existing.side_effect_level = String(b.side_effect_level);
      return ok(c, toolView(existing), 201);
    }
    const row = registeredTool(principalOf(c).org, b, owner(c, b.owner_kind) as ToolRow['owner']);
    state.tools.set(toolKey(row.org, toolRef), row);
    return ok(c, toolView(row), 201);
  });
  const toolById = (c: Ctx, id: string): ToolRow | undefined =>
    [...state.tools.values()].find((t) => t.id === id && canSeeTool(c, t));
  /** A deployment that lets only administrators register or change tools refuses any other principal. */
  const registrationRefused = (c: Ctx): Response | undefined =>
    options.restrictToolRegistration === true &&
    !mayRegisterTools(principalOf(c)) &&
    !broken('tool_registration_not_enforced')
      ? problem(
          c,
          403,
          'forbidden',
          'Only administrators of the organisation register or change tools.'
        )
      : undefined;
  app.get('/v1/tools/:id', (c) => {
    const row = toolById(c, c.req.param('id'));
    return row === undefined ? problem(c, 404, 'not_found') : ok(c, toolView(row));
  });
  app.patch('/v1/tools/:id', async (c) => {
    const parsed = await validatedBody(c, (body) => factPathRefused(c, body));
    if ('response' in parsed) return parsed.response;
    const refusedChange = registrationRefused(c);
    if (refusedChange !== undefined) return refusedChange;
    const row = toolById(c, c.req.param('id'));
    if (row === undefined) return problem(c, 404, 'not_found');
    if (
      typeof parsed.body.side_effect_level === 'string' &&
      fallsFrom(row.side_effect_level, parsed.body.side_effect_level) &&
      !broken('side_effect_level_downgrade_accepted')
    )
      return problem(
        c,
        409,
        'side_effect_level_downgrade',
        `${row.tool_ref} is registered at ${row.side_effect_level}; a level never falls.`
      );
    Object.assign(row, parsed.body);
    // Rev 16: `facts` replaces the whole map, and `null` removes every fact.
    if (parsed.body.facts === null) delete row.facts;
    // Turning the setting off clears what is held; turning it on later restores nothing.
    if (
      parsed.body.show_arguments_to_approvers === false &&
      !broken('arguments_kept_when_setting_off')
    )
      for (const o of state.obligations.values())
        if (o.org === row.org && o.toolRef === row.tool_ref) o.arguments = undefined;
    return ok(c, toolView(row));
  });

  // ---- principals, agents, runs --------------------------------------------------------------
  app.get('/v1/principals', (c) => {
    const kind = c.req.query('type');
    return paged(c, [
      ...[...state.principals.values()]
        .filter((p) => visible(c, String(p.org)))
        .filter((p) => kind === undefined || p.kind === kind)
        .map(shown),
      // Rev 13: `everyone` is reserved and never a directory role. The defects list it by its bare key, or by
      // a prefixed id under another display name.
      ...(broken('everyone_listed_as_directory_role') && (kind === undefined || kind === 'role')
        ? [{ id: EVERYONE_ROLE, kind: 'role', display_name: 'Everyone' }]
        : []),
      ...(broken('everyone_listed_by_prefixed_id') && (kind === undefined || kind === 'role')
        ? [{ id: roleScope(EVERYONE_ROLE), kind: 'role', display_name: 'All members' }]
        : []),
    ]);
  });
  app.post('/v1/agents', async (c) => {
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const row: Obj = {
      org: principalOf(c).org,
      id: `agent_${crypto.randomUUID().slice(0, 8)}`,
      name: parsed.body.name,
      parent_id: parsed.body.parent_id ?? null,
      principal_id: null,
      created_at: state.now().toISOString(),
    };
    state.agents.set(String(row.id), row);
    return ok(c, shown(row), 201);
  });
  app.get('/v1/agents/:id', (c) => {
    const row = rowIn(c, state.agents.get(c.req.param('id')));
    return row === undefined ? problem(c, 404, 'not_found') : ok(c, shown(row));
  });
  /**
   * Whether `id` names a service principal of the caller's organisation (rev 13): one the mock has seen call
   * it as a service, or one of its own service principals. A user is never bindable (the defect binds one).
   */
  const isServicePrincipalOf = (org: string, id: string): boolean =>
    state.principals.get(`${org}|${id}`)?.kind === 'service' ||
    (broken('user_principal_bindable') && state.principals.get(`${org}|${id}`)?.kind === 'user') ||
    (org === ORG && MOCK_SERVICE_SUBS.includes(id));
  // Rev 13: bind an agent to one service principal. Administrators only, checked before the 404s, as the
  // contract says. The defect lets any caller bind or unbind, a service principal included.
  app.put('/v1/agents/:id/principal', async (c) => {
    const p = principalOf(c);
    if (!mayAdministerOrganisation(p) && !broken('agent_binding_unguarded'))
      return problem(
        c,
        403,
        'forbidden',
        'Only an administrator of the organisation binds an agent to a service principal.'
      );
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const row = rowIn(c, state.agents.get(c.req.param('id')));
    const principalId = String(parsed.body.principal_id);
    if (row === undefined || !isServicePrincipalOf(p.org, principalId))
      return problem(
        c,
        404,
        'not_found',
        row === undefined
          ? 'The agent is not an agent of this organisation.'
          : 'principal_id names no service principal of this organisation.'
      );
    const holder = agentBoundTo(p.org, principalId);
    if (holder !== undefined && holder.id !== row.id && !broken('principal_bound_to_two_agents'))
      return problem(
        c,
        409,
        'principal_bound',
        'The service principal is already bound to another agent.',
        { agent_id: holder.id }
      );
    row.principal_id = principalId;
    return ok(c, shown(row));
  });
  app.delete('/v1/agents/:id/principal', (c) => {
    if (!mayAdministerOrganisation(principalOf(c)) && !broken('agent_binding_unguarded'))
      return problem(
        c,
        403,
        'forbidden',
        'Only an administrator of the organisation unbinds an agent.'
      );
    const row = rowIn(c, state.agents.get(c.req.param('id')));
    if (row === undefined) return problem(c, 404, 'not_found');
    row.principal_id = null;
    return c.body(null, 204);
  });
  const runView = (r: {
    id: string;
    kind: string;
    scope_id: string;
    agent_id: string | null;
    created_at: string;
  }): Obj => ({
    id: r.id,
    kind: r.kind,
    scope_id: r.scope_id,
    agent_id: r.agent_id,
    created_at: r.created_at,
  });
  app.post('/v1/runs', async (c) => {
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    if (parsed.body.kind === 'governed') return problem(c, 405, 'governed_run_not_creatable');
    // A run names only an agent of the caller's organisation: a foreign or unknown id is a 404. The
    // organisation check is the one `ignore_org_scope` drops.
    if (
      typeof parsed.body.agent_id === 'string' &&
      rowIn(c, state.agents.get(parsed.body.agent_id)) === undefined
    ) {
      return problem(c, 404, 'not_found', 'agent_id names no agent of this organisation.');
    }
    const p = principalOf(c);
    const row = {
      id: `run_${crypto.randomUUID().slice(0, 8)}`,
      org: p.org,
      ownerSub: p.sub,
      kind: 'external' as const,
      scope_id: `scope_${crypto.randomUUID()}`,
      agent_id: (parsed.body.agent_id as string | undefined) ?? null,
      created_at: state.now().toISOString(),
    };
    state.runs.set(row.id, row);
    return ok(c, runView(row), 201);
  });
  app.get('/v1/runs/:id', (c) => {
    const row = state.runs.get(c.req.param('id'));
    return row !== undefined && visible(c, row.org)
      ? ok(c, runView(row))
      : problem(c, 404, 'not_found');
  });

  // ---- webhooks, origins, capabilities, keys -------------------------------------------------
  app.get('/v1/webhooks', (c) => {
    const refused = notAnAdministrator(c, 'lists webhooks');
    if (refused !== undefined) return refused;
    return ok(
      c,
      [...state.webhooks.values()]
        .filter((hook) => visible(c, String(hook.org)))
        .map((hook) => without(hook, 'secret', 'org'))
    );
  });
  app.post('/v1/webhooks', async (c) => {
    const refused = notAnAdministrator(c, 'creates webhooks');
    if (refused !== undefined) return refused;
    const parsed = await validatedBody(c);
    if ('response' in parsed) return parsed.response;
    const callbackRefused = guardContinuation(
      c,
      { kind: 'webhook', delivery: 'push', callback_url: String(parsed.body.url) },
      false
    );
    if (callbackRefused !== undefined) return callbackRefused;
    const row: Obj = {
      org: principalOf(c).org,
      id: `wh_${crypto.randomUUID().slice(0, 8)}`,
      url: parsed.body.url,
      events: parsed.body.events,
      state: 'active',
      created_at: state.now().toISOString(),
    };
    state.webhooks.set(String(row.id), row);
    // Rev 12 removes the secret: a delivery is signed with the deployment's key. The defect still returns one.
    return ok(
      c,
      broken('webhook_secret_returned')
        ? { ...shown(row), secret: `whsec_${crypto.randomUUID()}` }
        : shown(row),
      201
    );
  });
  app.delete('/v1/webhooks/:id', (c) => {
    // A webhook of another organisation is 404 before the administrator check, as for a policy.
    if (rowIn(c, state.webhooks.get(c.req.param('id'))) === undefined)
      return problem(c, 404, 'not_found');
    const refused = notAnAdministrator(c, 'deletes webhooks');
    if (refused !== undefined) return refused;
    state.webhooks.delete(c.req.param('id'));
    // A deleted webhook is owed nothing more.
    for (let i = state.outbox.length - 1; i >= 0; i--)
      if (state.outbox[i]?.webhookId === c.req.param('id')) state.outbox.splice(i, 1);
    return c.body(null, 204);
  });

  app.get('/v1/origins', (c) => ok(c, { origins: state.origins.get(principalOf(c).org) ?? [] }));
  app.put('/v1/origins', async (c) => {
    const refused = notAnAdministrator(c, 'registers browser origins');
    if (refused !== undefined) return refused;
    // Rev 12: a registered origin is exact, and is refused naming it, never normalised. That is checked before the
    // schema, whose pattern says the same without saying which origin. The defect reads the body unchecked, so
    // whatever the request carries is stored.
    const looseOriginsBody = async (ctx: Ctx): Promise<{ body: Obj } | { response: Response }> => {
      const read = await readBody(ctx);
      if ('response' in read) return read;
      const listed = isObj(read.body) ? read.body.origins : undefined;
      return Array.isArray(listed) && listed.every((o) => typeof o === 'string')
        ? { body: read.body as Obj }
        : { response: problem(ctx, 400, 'invalid_request', 'origins is an array of strings.') };
    };
    const exactOrRefused = (body: Obj): Response | undefined => {
      const listed: unknown[] = Array.isArray(body.origins) ? body.origins : [];
      const inexact = listed.find((o) => typeof o === 'string' && !isExactRegisteredOrigin(o));
      return inexact === undefined
        ? undefined
        : problem(
            c,
            400,
            'invalid_request',
            `The origin ${JSON.stringify(inexact)} is not exact: use scheme://host[:port] as a browser sends it, with no path, trailing slash or wildcard, and https (http only for localhost and 127.0.0.1).`
          );
    };
    // The defect skips only the exactness rule and the schema's pattern: the body must still be { origins: string[] }.
    const parsed = broken('inexact_origin_accepted')
      ? await looseOriginsBody(c)
      : await validatedBody(c, exactOrRefused);
    if ('response' in parsed) return parsed.response;
    const origins = parsed.body.origins as string[];
    state.origins.set(principalOf(c).org, origins);
    return ok(c, { origins });
  });

  app.get('/v1/capabilities', (c) => {
    if (broken('capabilities_unreadable'))
      return problem(c, 503, 'unavailable', 'The capabilities cannot be read right now.');
    const origin = new URL(c.req.url).origin;
    // The defect: a family is advertised that the routes do not serve.
    const advertised = new Set<Family>(served);
    if (broken('advertise_unserved')) advertised.add('approvals');
    const hostedFeatures = config.deployment === 'hosted' || broken('edge_features_leak');
    const features = [
      ...FAMILIES.filter((f) => f !== 'approvals' && advertised.has(f)).flatMap((f) => [
        f,
        ...(hostedFeatures ? (HOSTED_FEATURES[f] ?? []) : []),
      ]),
      // Rev 10: the mock applies the rejected-duplicate rule wherever it serves approvals, on either
      // deployment, so it is not one of the hosted features.
      ...(advertised.has('approvals') ? [REJECTED_DUPLICATE_FEATURE] : []),
      // Rev 15: the single read of a pending approval lists what the reader may do, wherever it serves approvals.
      ...(advertised.has('approvals') ? [AVAILABLE_ACTIONS_FEATURE] : []),
      // Rev 11: its simulation composes tightest-wins wherever it serves policies, on either deployment.
      ...(advertised.has('policies') ? [TIGHTEST_WINS_FEATURE] : []),
      // Rev 16: it reads facts wherever it registers tools (the floor), evaluates rules where it authors policies,
      // and keeps requirements where it does both that and approvals.
      TOOLS_FACTS_FEATURE,
      ...(rulesServed() ? [POLICY_RULES_FEATURE] : []),
      ...(requirementsServed() ? [APPROVAL_REQUIREMENTS_FEATURE] : []),
    ];
    return ok(c, {
      deployment: config.deployment,
      entitlements: [...principalOf(c).entitlements],
      jwks_uri: `${origin}/.well-known/jwks.json`,
      kids: jwksOf([signingKey]).keys.map((k) => k.kid),
      resolutions: advertised.has('approvals') ? [...resolutionsServed] : [],
      features,
      authzen_configuration: `${origin}/.well-known/authzen-configuration`,
      // Absent means 100, the contract's own ceiling.
      ...(limits.decisions === undefined &&
      limits.records === undefined &&
      limits.resolutions === undefined &&
      options.approvalArgumentsMaxBytes === undefined
        ? {}
        : {
            limits: {
              ...(limits.decisions === undefined
                ? {}
                : { decisions_batch_max_items: limits.decisions }),
              ...(limits.records === undefined ? {} : { records_batch_max_items: limits.records }),
              ...(limits.resolutions === undefined
                ? {}
                : { resolutions_batch_max_items: limits.resolutions }),
              ...(options.approvalArgumentsMaxBytes === undefined
                ? {}
                : { approval_arguments_max_bytes: options.approvalArgumentsMaxBytes }),
            },
          }),
      // Each of these is advertised only when the mock is started restricted: absent is the rev 5 behaviour.
      ...(options.deliveries === undefined
        ? {}
        : { continuation_deliveries: [...options.deliveries] }),
      // Rev 17: the kinds its document lists, wherever it serves approvals, on either deployment.
      ...(advertised.has('approvals') ? { continuation_kinds: continuationKinds() } : {}),
      ...(options.restrictToolRegistration === true ? { tool_registration: 'administrators' } : {}),
      // Rev 11: who registers a connection, when the mock is started restricted, and the transports it serves.
      ...(options.connectionRegistration === undefined
        ? {}
        : {
            connection_registration: {
              owner_kinds: [...options.connectionRegistration.owner_kinds],
              who: options.connectionRegistration.who,
            },
          }),
      ...(advertised.has('connections')
        ? { connection_transports: [...(options.connectionTransports ?? ['mcp', 'a2a'])] }
        : {}),
      // Rev 11: the forms it enforces, where it authors policies (hosted).
      ...(hostedFeatures && advertised.has('policies') ? { policy_forms: policyForms() } : {}),
      // Rev 14: the references it applies on approval, where it authors and publishes policies of its own.
      ...(deploymentApplies()
        ? {
            deployment_applied: [
              { tool_ref: PROPOSE_POLICY_SET, arguments_schema_ref: PROPOSAL_SCHEMA },
            ],
            // Rev 18: the rows and members of a proposal it accepts.
            proposals: {
              row_kinds: [...proposalsServed().row_kinds],
              members: [...proposalsServed().members],
            },
          }
        : {}),
      // The mock has an approver surface (see `MockOptions.approverSurfaceClient`).
      self_approval_from_approver_surface: true,
      // A user's token must carry this scope to resolve (see `USER_RESOLVE_SCOPE`).
      user_resolve_scope: USER_RESOLVE_SCOPE,
      // The mock verifies no DPoP proofs.
      dpop: 'off',
    });
  });
  app.get('/.well-known/jwks.json', (c) => c.json(jwksOf([signingKey]) as never));

  // ---- edge protocol (by reference only) -----------------------------------------------------
  app.all('/v1/edge/*', (c) =>
    problem(
      c,
      404,
      'not_available_on_deployment',
      'The edge protocol is defined outside this document.'
    )
  );

  // ---- control (local mock only) -------------------------------------------------------------
  const tokens = async (): Promise<MockTokens> => {
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const mint = (
      sub: string,
      extra: {
        aud?: string;
        /** `null`: no organisation claim. */
        org?: string | null;
        entitlements?: string[];
        clientId?: string;
        kind?: 'user' | 'service';
        /** Defaults to `module_api` for a service principal. */
        scope?: string;
        jkt?: string;
        exp?: number;
        issuer?: MockIssuer;
      } = {}
    ): Promise<string> => {
      const kind = extra.kind ?? 'user';
      const scope = extra.scope ?? (kind === 'service' ? MODULE_API_SCOPE : USER_RESOLVE_SCOPE);
      return (extra.issuer ?? issuer).mint({
        sub,
        ...(extra.org === null ? {} : { org: extra.org ?? ORG }),
        aud: extra.aud ?? config.audience,
        exp: extra.exp ?? exp,
        principal_kind: kind,
        ...(scope === '' ? {} : { scope }),
        ...(extra.jkt === undefined ? {} : { cnf: { jkt: extra.jkt } }),
        ...(extra.entitlements === undefined ? {} : { entitlements: extra.entitlements }),
        ...(extra.clientId === undefined ? {} : { client_id: extra.clientId }),
      });
    };
    return {
      audience: config.audience,
      creator: await mint('svc_adapter', { kind: 'service' }),
      creator_user: await mint('user_creator'),
      approver: await mint('user_approver'),
      other_org: await mint('user_elsewhere', { org: OTHER_ORG }),
      entitled: await mint('user_entitled', {
        entitlements: [
          'records.verify',
          'evidence.export',
          'policies.suggested',
          ROLE_SUBJECTS_ENTITLEMENT,
        ],
      }),
      wrong_audience: await mint('svc_adapter', {
        aud: 'https://api.elsewhere.test',
        kind: 'service',
      }),
      forged: await mint('svc_adapter', { kind: 'service', issuer: await MockIssuer.create() }),
      expired: await mint('svc_adapter', { kind: 'service', exp: 1_000_000_000 }),
      dpop_bound: await mint('user_dpop', { jkt: 'mock-proof-key-thumbprint' }),
      no_org: await mint('user_no_org', { org: null }),
      no_scope: await mint('svc_no_scope', { kind: 'service', scope: '' }),
      other_service: await mint('svc_other', { kind: 'service' }),
      member: await mint(MEMBER_SUB),
      // An administrator of the organisation: it holds the mock's `policy_admin` role, which authors policies.
      admin: await mint('user_admin', {
        scope: `${USER_RESOLVE_SCOPE} ${roleScope(POLICY_ADMIN_ROLE)}`,
      }),
      // The creator user's token issued to the approver surface. It also holds the administrator role, as the
      // session of an administrator in the approvals module does, so that the same user who opens a
      // deployment-applied proposal with `creator_user` approves it from the surface (rev 14).
      approver_surface_token: await mint('user_creator', {
        clientId: config.approverSurfaceClient,
        scope: `${USER_RESOLVE_SCOPE} ${roleScope(POLICY_ADMIN_ROLE)}`,
      }),
      approver_token_without_resolve_scope: await mint('user_approver', { scope: '' }),
    };
  };
  if (options.control === true) {
    app.post('/__mock/advance', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return problem(
          c,
          400,
          'invalid_request',
          'The body must be JSON: { "seconds": <number> }.'
        );
      }
      const seconds = isObj(body) ? body.seconds : undefined;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        return problem(c, 400, 'invalid_request', '"seconds" must be a finite number.');
      }
      state.clockOffsetMs += seconds * 1000;
      return c.json({ now: state.now().toISOString() });
    });
    app.get('/__mock/tokens', async (c) => c.json((await tokens()) as never));
    // Rev 11: the mock's consent page. Following an authorization URL consents (`?deny=1` refuses) and returns
    // the browser to `return_to` with `nc_connection`, `nc_result` and, on an error, `nc_error`. Single use.
    /**
     * Completes an authorization as its consent page does (`deny`: the user refuses), once. `undefined` when there is
     * no such authorization or it was used; otherwise the address the browser returns to.
     */
    const completeAuthorization = (id: string, deny: boolean): URL | undefined => {
      const pending = state.authorizations.get(id);
      if (pending === undefined) return undefined;
      state.authorizations.delete(id);
      const back = new URL(pending.returnTo);
      back.searchParams.set('nc_connection', pending.connectionId);
      const fail = (code: string): URL => {
        back.searchParams.set('nc_result', 'error');
        back.searchParams.set('nc_error', code);
        return back;
      };
      if (state.now().getTime() > pending.expiresAt.getTime()) return fail('expired');
      if (deny) return fail('consent_denied');
      const row = state.connections.get(pending.connectionId);
      if (row === undefined) return fail('upstream_error');
      const now = state.now().toISOString();
      if (pending.sub === undefined) {
        row.status = 'connected';
        row.last_verified_at = now;
      } else {
        const held = state.links.get(linkKey(pending.connectionId, pending.org, pending.sub));
        if (held === undefined) return fail('exchange_failed');
        held.status = 'linked';
        held.linked_at = now;
        held.token = `oauth_${crypto.randomUUID()}`;
      }
      back.searchParams.set('nc_result', 'connected');
      return back;
    };
    app.get('/__mock/consent/:authorization', (c) => {
      const back = completeAuthorization(
        c.req.param('authorization'),
        c.req.query('deny') !== undefined
      );
      if (back === undefined) return c.text('No such authorization, or it was used.', 404);
      return c.redirect(back.toString(), 302);
    });
    // `{ reset: true }` clears everything below. `limits` sets the batch limits the mock advertises and
    // enforces; `fail` makes the next request to an operation answer a server error, once;
    // `eligibility_lookup_down` (boolean) says the deployment cannot determine who is eligible: `waiting_on`
    // is then left out of the creator's read, which still succeeds. `consent` ({ authorization_url, deny? })
    // completes an authorization as following it to the consent page does, and answers where it returns.
    app.post('/__mock/control', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return problem(c, 400, 'invalid_request', 'The body must be JSON.');
      }
      if (!isObj(body)) return problem(c, 400, 'invalid_request', 'The body must be an object.');
      if (body.reset === true) {
        armedFailure = undefined;
        eligibilityLookupDown = false;
        state.outbox.length = 0;
        delete limits.decisions;
        delete limits.records;
        delete limits.resolutions;
        Object.assign(limits, initialLimits);
        maxBodyBytes = options.maxBodyBytes;
      }
      if (isObj(body.limits)) {
        const {
          decisions_batch_max_items: decisions,
          records_batch_max_items: records,
          resolutions_batch_max_items: resolutions,
        } = body.limits;
        const valid = (v: unknown): boolean =>
          v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100);
        if (!valid(decisions) || !valid(records) || !valid(resolutions))
          return problem(
            c,
            400,
            'invalid_request',
            'limits take integers from 1 to 100, the range Capabilities.limits allows.'
          );
        if (typeof decisions === 'number') limits.decisions = decisions;
        if (typeof records === 'number') limits.records = records;
        if (typeof resolutions === 'number') limits.resolutions = resolutions;
      }
      if (body.max_body_bytes !== undefined) {
        if (
          typeof body.max_body_bytes !== 'number' ||
          !Number.isInteger(body.max_body_bytes) ||
          body.max_body_bytes < 1
        )
          return problem(c, 400, 'invalid_request', 'max_body_bytes is a positive integer.');
        maxBodyBytes = body.max_body_bytes;
      }
      if (typeof body.eligibility_lookup_down === 'boolean')
        eligibilityLookupDown = body.eligibility_lookup_down;
      if (isObj(body.fail)) {
        const { operation, status, retry_after: retryAfter, reason } = body.fail;
        if (typeof operation !== 'string' || (status !== 500 && status !== 503))
          return problem(
            c,
            400,
            'invalid_request',
            'fail takes an operation and a status of 500 or 503.'
          );
        armedFailure = {
          operation,
          status,
          retryAfter: typeof retryAfter === 'number' ? retryAfter : undefined,
          reason: typeof reason === 'string' ? reason : undefined,
        };
      }
      // Rev 12: `disable_webhook` (an id) marks a webhook `disabled`, as 72 hours of failed deliveries would.
      if (typeof body.disable_webhook === 'string') {
        const hook = state.webhooks.get(body.disable_webhook);
        if (hook === undefined)
          return problem(c, 404, 'not_found', 'disable_webhook names no webhook.');
        hook.state = 'disabled';
      }
      // Rev 12: `deliveries` ({ webhook_id }) answers the deliveries queued for that webhook, oldest first,
      // each signed. The mock never sends them anywhere.
      if (body.deliveries !== undefined) {
        const id = isObj(body.deliveries) ? body.deliveries.webhook_id : undefined;
        if (typeof id !== 'string')
          return problem(c, 400, 'invalid_request', 'deliveries takes { webhook_id }.');
        const deliveries = await Promise.all(
          state.outbox
            .filter((entry) => entry.webhookId === id)
            .map(async (entry) => ({ ...entry.event, signature: await entry.signature }))
        );
        return c.json({ ok: true, deliveries } as never);
      }
      if (body.consent !== undefined) {
        const consent = body.consent;
        const url = isObj(consent) ? consent.authorization_url : undefined;
        const id =
          typeof url === 'string' ? /\/__mock\/consent\/([^/?#]+)/.exec(url)?.[1] : undefined;
        if (!isObj(consent) || id === undefined)
          return problem(
            c,
            400,
            'invalid_request',
            "consent takes this mock's authorization_url, and deny (boolean)."
          );
        const back = completeAuthorization(decodeURIComponent(id), consent.deny === true);
        if (back === undefined)
          return problem(c, 404, 'not_found', 'No such authorization, or it was used.');
        return c.json({ ok: true, location: back.toString() });
      }
      return c.json({ ok: true });
    });
  }

  return { app, config, state, issuer, index, jwks: () => jwksOf([signingKey]), tokens };
}

export type { OperationInfo };
