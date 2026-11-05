/** The mock's in-memory state and the small helpers every route uses. */
import type { Break } from './breaks.js';
import type { Principal } from './auth.js';
import type { Proposal } from './proposal.js';
import type { ApproverRef, FactBindings } from './rules.js';

/** A JSON object whose members are checked where they are read. */
export type Obj = Record<string, unknown>;

export type ApprovalState =
  'pending' | 'approved' | 'rejected' | 'consumed' | 'expired' | 'withdrawn';

export interface Continuation {
  kind: string;
  delivery: string;
  correlation?: Obj;
  callback_url?: string;
  expires_at?: string;
}

export interface HistoryEntry {
  resolution: string;
  by: { id: string; kind: string };
  at: string;
  reason?: string;
}

/**
 * Rev 16: one requirement of an approval (`ApprovalRequirement`), as the mock keeps it: the approvals that count
 * toward it name their approver by id and kind, and are named when they are read.
 */
export interface Requirement {
  id: string;
  policies: { id: string; version: number }[];
  approvers: ApproverRef[];
  exclude: string[];
  needed: number;
  met: boolean;
  approvals: { by: { id: string; kind: string }; at: string; basis: 'listed' | 'break_glass' }[];
}

/** An obligation: what a step-up decision or `POST /v1/approvals` opens. */
export interface Obligation {
  id: string;
  org: string;
  creatorSub: string;
  /** The kind of the creating principal: `service` or `user`. */
  creatorKind: string;
  scopeKey: string;
  scopeId: string;
  runId: string | undefined;
  runKind: 'external' | 'governed' | undefined;
  agentId: string | undefined;
  toolRef: string;
  kind: 'tool_invocation';
  argDigest: string;
  arguments: Obj | undefined;
  state: ApprovalState;
  resolution: string | undefined;
  continuation: Continuation;
  /** Who runs the approved call: the caller (an external tool) or the platform (a proxied one). */
  executor: 'caller' | 'proxy';
  resumeToken: string | undefined;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | undefined;
  consumedAt: Date | undefined;
  approver: { id: string; kind: string } | undefined;
  history: HistoryEntry[];
  sideEffect: string;
  /** Absent when no explicit policy matched and the default applied: nothing is synthesised for it. */
  policy: { id: string; version: number } | undefined;
  /**
   * `on_deny` of the policy the approval names, as it stood when the approval was created and only where the
   * policy's mode allows it (`ask`, `escalate`): a later edit of the policy does not change it.
   */
  onDeny: 'resume' | 'halt' | undefined;
  /**
   * Rev 10: set when the approval was opened for an identity a resolver had rejected, because the
   * organisation's duplicate-requests policy says `ask_again`. Shown to every reader of the approval.
   */
  priorRejections: { count: number; last_at: string } | undefined;
  /** The key the open-obligation map files this approval under (see `identityOf`). */
  identityKey: string;
  outcomeRecordId: string | undefined;
  /** The signed Resumption, minted at resolution. */
  resumption: Obj | undefined;
  /**
   * Rev 14: the proposal a `tool:noblecloak:propose-policy-set` approval applies when it is approved, and what
   * approving it would change, computed when it was opened. Neither is on the wire except `preview`, which a
   * reader who may approve is shown only while the approval is pending (see `view`).
   */
  proposal: Proposal | undefined;
  preview: Obj | undefined;
  /**
   * Rev 14: true while an approval of `proposal` is being applied. Applying awaits, so a second resolution or a
   * withdrawal that arrives meanwhile is answered 409 `already_resolved` instead of passing the `pending` check.
   */
  applying: boolean;
  /**
   * Rev 16: the requirements of an approval a decision of rule-bearing policies opened (see `decide` in `app.ts`);
   * undefined on every other approval, which has one requirement, satisfied as before rev 16.
   */
  requirements?: Requirement[];
}

/** A resolver's rejection of an identity (rev 10): the rejected approval and when it was resolved. */
export interface Rejection {
  readonly id: string;
  readonly at: Date;
}

/**
 * One version of a stored policy (rev 10). A version with `published_at: null` is a draft: the policy's
 * first, never published, or the pending one written after the last publish.
 */
export interface PolicyVersion {
  version: number;
  kind: string;
  name: string;
  description?: string;
  subjects: Obj[];
  targets: { tools: 'all' | string[] };
  config: Obj;
  published_at: string | null;
  updated_at: string;
  updated_by: { id: string; kind: string };
  /** Rev 11: where this version was imported from, as its write stated it. */
  origin?: Obj;
  /** Rev 11: when the policy was retired; set on every version of a retired policy. */
  retired_at?: string;
}

export interface ToolRow {
  /** The organisation the tool belongs to: a tool is visible to its own organisation only. */
  org: string;
  id: string;
  tool_ref: string;
  connection_id: string | null;
  description: string;
  transport: 'mcp' | 'a2a' | 'external';
  input_schema: Obj;
  side_effect_level: string;
  data_routing: string;
  owner: { kind: string; id: string };
  /** Mock-only: the fixture lookup that stands in for a policy. */
  mode: 'always_allow' | 'ask' | 'deny';
  /** Mock-only: no explicit policy matches this tool, so its decision carries no `policy`. */
  default_policy?: true;
  /** Mock-only: the stored policy that matches this tool; `pol_default` when unset. */
  policy_id?: string;
  /** Whether approvers of this tool see the call's arguments (`show_arguments_to_approvers`). */
  show_arguments_to_approvers: boolean;
  /** Rev 16: the facts a call carries, read from its arguments (`Tool.facts`). */
  facts?: FactBindings;
  /**
   * Mock-only: the deployment already dispatches a tool under this reference through another identity, so
   * `POST /v1/tools` for it is 422 `tool_ref_in_use`.
   */
  dispatched_under_other_identity?: true;
  /** Rev 11: `withdrawn` once its server no longer offers it or its connection was deleted; absent is `active`. */
  status?: 'active' | 'withdrawn';
  /** Mock-only (rev 11): the server identity a tool registered from a connection belongs to (see `serverKeyOf`). */
  server_key?: string;
}

export interface RecordRow {
  id: string;
  org: string;
  ts: string;
  /** Id and kind only; the `names_leak_into_records` defect adds a name. */
  actor: { id: string; kind: string; display_name?: string };
  tool_ref: string;
  /** Absent when no policy matched explicitly and the default applied. */
  policy?: { id: string; version: number } | null;
  decision: string;
  approval_id?: string;
  outcome?: Obj;
  prompt_id?: string;
  context?: Obj;
  enforced?: boolean;
  /** Present when the caller applied a fallback because it had no decision. */
  degraded?: Obj;
  attestation: 'observed' | 'asserted';
}

export interface RunRow {
  id: string;
  org: string;
  ownerSub: string;
  kind: 'external' | 'governed';
  scope_id: string;
  agent_id: string | null;
  created_at: string;
}

/**
 * One principal's credential link to a `per_user` registration (rev 11). `token` is the stored credential, never
 * shown; `authorized` says an OAuth link completed the mock's consent page.
 */
export interface LinkRow {
  status: 'linked' | 'pending_authorization' | 'degraded';
  consent: 'given' | 'revoked';
  linked_at?: string;
  token?: string;
}

/** An authorization the mock's consent page completes (rev 11): single use, until `expiresAt`. */
export interface PendingAuthorization {
  readonly connectionId: string;
  readonly org: string;
  /** The principal whose link it completes; undefined for an `org_shared` registration's credential. */
  readonly sub: string | undefined;
  readonly returnTo: string;
  readonly expiresAt: Date;
}

/**
 * A webhook delivery the mock would send (rev 12). The mock makes no network call: it keeps the delivery,
 * and the control step `deliveries` reads it. One event, one signature, shared by every subscriber.
 */
export interface OutboxEntry {
  /** The subscription it is for: the value of the `NobleCloak-Webhook-Id` header a real delivery carries. */
  readonly webhookId: string;
  readonly event: Obj;
  readonly signature: Promise<string>;
}

/** Everything the mock remembers. */
export class MockState {
  clockOffsetMs = 0;
  readonly obligations = new Map<string, Obligation>();
  readonly open = new Map<string, string>();
  readonly tools = new Map<string, ToolRow>();
  readonly records: RecordRow[] = [];
  readonly runs = new Map<string, RunRow>();
  readonly agents = new Map<string, Obj>();
  readonly connections = new Map<string, Obj>();
  /** Rev 11: each principal's link to a registration, keyed `connection|org|sub` (see `linkKey`). */
  readonly links = new Map<string, LinkRow>();
  /** Rev 11: the authorizations the consent page has yet to complete, by their state. */
  readonly authorizations = new Map<string, PendingAuthorization>();
  /**
   * Each policy as `GET /v1/policies/{id}` reads it: its published version, or its draft when it was never
   * published, with the organisation that owns it. Rewritten from `policyVersions` on every write.
   */
  readonly policies = new Map<string, Obj>();
  /** Every version of each policy, oldest first, the pending draft last (rev 10). */
  readonly policyVersions = new Map<string, PolicyVersion[]>();
  /** A resolver's rejections of each identity, oldest first (rev 10). */
  readonly rejections = new Map<string, Rejection[]>();
  /** When each identity's last approval was consumed: a consumed approval resets the rejection count (rev 10). */
  readonly lastConsumed = new Map<string, Date>();
  readonly webhooks = new Map<string, Obj>();
  /** Rev 12: the deliveries the mock owes the webhooks, oldest first. */
  readonly outbox: OutboxEntry[] = [];
  readonly origins = new Map<string, string[]>();
  readonly principals = new Map<string, Obj>();
  readonly idempotency = new Map<string, { hash: string; status: number; body: string }>();
  readonly mismatches: { id: string; expected: string }[] = [];
  readonly listeners = new Set<(o: Obligation) => void>();
  readonly waiters = new Map<string, Set<() => void>>();

  now(): Date {
    return new Date(Date.now() + this.clockOffsetMs);
  }
}

export interface Env {
  Variables: { principal: Principal };
}

export const PROBLEM_BASE = 'https://docs.noblecloak.com/problems';

export interface MockConfig {
  readonly deployment: 'hosted' | 'edge';
  readonly breaks: ReadonlySet<Break>;
  readonly audience: string;
  readonly expireAfterMs: number;
  /** The `client_id` of the approvals module: the approver surface (see `MockOptions.approverSurfaceClient`). */
  readonly approverSurfaceClient: string;
}

/** The key of a principal's link to a registration in `MockState.links` (rev 11). */
export const linkKey = (connectionId: string, org: string, sub: string): string =>
  `${connectionId}|${org}|${sub}`;

/** The key of a tool in `MockState.tools`: tool refs are unique per organisation, not globally. */
export const toolKey = (org: string, toolRef: string): string => `${org}|${toolRef}`;

/** A copy of `object` without the named members. */
export function without(object: Obj, ...keys: string[]): Obj {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}
