/**
 * The public types of the permissions module: what the headless store and the hooks return. This file holds
 * types only. A change here is a change to the module's public surface.
 *
 * The module reads policies as the wire states them and claims nothing the wire does not say: a policy of a kind or a
 * mode it does not know is kept and flagged, never mapped to a decision. What a holder of a role would get is only
 * what a dry run as that role answers (the effective view), and which entries set it only where the service
 * advertises how policies compose.
 */
import type { ToolFacts } from './connections-facts.js';
import type { EffectiveStore } from './permissions-effective.js';
import type { PolicyApprover, PolicyRule } from './permissions-rules.js';

/** A policy subject: a principal by kind and id, or the organisation itself (no id). Another type is kept as sent. */
export interface PolicySubject {
  /** `user`, `agent`, `service`, `group`, `role` or `organization`; a value the module does not know is kept. */
  readonly type: string;
  /** The principal's id (a role's is the bare role key); absent for the organisation. */
  readonly id?: string;
}

/** A principal by id and kind, as a policy names who wrote a version (never by name). */
export interface PolicyAuthor {
  readonly id: string;
  readonly kind: string;
}

/** One policy at one version, as read from the service. */
export interface PolicyInfo {
  readonly id: string;
  readonly version: number;
  /** `authored`, `suggested` or `imported`; another value is kept as sent. */
  readonly source: string;
  /** The policy's kind as sent. The enum is open: see `kindKnown`. */
  readonly kind: string;
  /** False for a kind the contract does not document: a policy this module cannot evaluate. */
  readonly kindKnown: boolean;
  readonly name?: string;
  readonly description?: string;
  /**
   * `published`: the version in force. `draft`: written and not published. `unknown`: the service stated neither
   * `state` nor `published_at` (a server of an earlier revision); such a policy is placed on no cell.
   */
  readonly state: 'draft' | 'published' | 'unknown';
  readonly subjects: readonly PolicySubject[];
  /** The tools it governs: `'all'`, or the `tool_ref`s. Absent when the service did not say (placed on no cell). */
  readonly targets?: 'all' | readonly string[];
  /** The `tool_ref`s of `targets` the service says it cannot enforce the policy on now. */
  readonly unenforcedTargets: readonly string[];
  /** The configuration as sent; opaque for a kind the module does not know. */
  readonly config: Readonly<Record<string, unknown>>;
  /** For a `tool_invocation` policy: `config.mode` as sent. */
  readonly mode?: string;
  /** True only when `mode` is one of the five documented modes. A mode the module does not know maps to no decision. */
  readonly modeKnown: boolean;
  readonly publishedAt?: string | null;
  readonly updatedAt?: string;
  readonly updatedBy?: PolicyAuthor;
  /** On a published policy: the version of its pending draft (rev 11 `draft_version`), when the service says. */
  readonly draftVersion?: number;
  /** Where this version was imported from (rev 11 `origin`), as sent. */
  readonly origin?: PolicyOrigin;
}

/** Where an imported policy version came from: the file's format and the SHA-256 of its bytes. */
export interface PolicyOrigin {
  readonly format: string;
  readonly digest: string;
}

/** The policy forms a service advertises it enforces (rev 11 `Capabilities.policy_forms`). */
export interface PolicyFormsFacts {
  readonly toolInvocation?: {
    readonly modes: readonly string[];
    readonly subjectTypes: readonly string[];
    readonly targetsAll: boolean;
    readonly configMembers: readonly string[];
  };
  /** `approval_routing` is listed: the organisation's break-glass setting is served (rev 16). */
  readonly approvalRouting?: true;
}

/** A tool from `GET /v1/tools`, as the matrix uses it. */
export interface ToolInfo {
  readonly id: string;
  readonly toolRef: string;
  readonly connectionId: string | null;
  readonly sideEffectLevel?: string;
  readonly description?: string;
  /**
   * `Tool.status` as sent: `active`, `withdrawn` (its connection was deleted or its server no longer offers it; a
   * decision for it is `deny`), or a value the module does not know, kept. Absent on the wire means `active`.
   */
  readonly status: string;
  /**
   * False for a status the contract does not document: kept and flagged, and, as the contract asks of a client, treated
   * as not callable (its cells are read-only, as a withdrawn tool's are).
   */
  readonly statusKnown: boolean;
  /** Rev 16: the facts the tool declares, by name. Absent: it declares none, or the service sent none. */
  readonly facts?: ToolFacts;
  /** Rev 16: true when a `facts` member was sent that this module cannot read in full, so `facts` is left out. */
  readonly factsUnreadable?: true;
}

/** The members of `GET /v1/capabilities` this module reads. Never the deployment: only what is advertised. */
export interface PolicyCapabilityFacts {
  /** The `policies` family is served. */
  readonly served: boolean;
  /** `policies.author`: drafts may be created and written. */
  readonly author: boolean;
  /** `policies.publish`: a draft may be published. */
  readonly publish: boolean;
  /** `policies.import_export`: exposed for the import/export surface; nothing in this module uses it. */
  readonly importExport: boolean;
  /** The `principals` family is served (roles and groups can be listed). */
  readonly principals: boolean;
  /** The `connections` family is served (connection names can be read). */
  readonly connections: boolean;
  /** The `runs` family is served (a simulation may name a run). */
  readonly runs: boolean;
  /** The organisation holds the `policies.suggested` entitlement. */
  readonly suggested: boolean;
  /** Approvals are served (`resolutions` is not empty). */
  readonly approvals: boolean;
  /**
   * `policies.tightest_wins`: the service states how it composes `tool_invocation` modes (deny over needing approval
   * over allow), so which entries `contributed` to a decision may be shown as what set it. Without it the module makes
   * no such claim.
   */
  readonly tightestWins: boolean;
  /** The policy forms the service enforces; absent when it does not say (a refusal is then learnt from its 422). */
  readonly policyForms?: PolicyFormsFacts;
  /** `policies.retire`: a published policy may be retired, and a draft discarded. */
  readonly retire: boolean;
}

/** The codes of a refusal the store gives without a request. */
export type PermissionsPreconditionCode =
  /** Authoring is off: not advertised, turned off by the host, or refused once with 403. */
  | 'read_only'
  /** Publishing is not advertised. */
  | 'publish_not_offered'
  /** Retiring a policy and discarding a draft are not advertised (`policies.retire`). */
  | 'retire_not_offered'
  /** The pending draft changed since it was loaded (another version or another `updated_at`), or is one not seen. */
  | 'draft_changed'
  /** The policy has no pending draft to publish. */
  | 'no_pending_draft'
  /** The editor holds changes that are not saved: publishing would publish something other than what is shown. */
  | 'unsaved_changes'
  /** Two published policies govern the pair: the cell is not editable. */
  | 'pair_conflict'
  /** The module edits `tool_invocation` policies only. */
  | 'kind_not_editable'
  /** The policy's targets were not stated by the service, and a write without them would mean every tool. */
  | 'targets_not_stated'
  /** A simulation named a run where `runs` is not advertised. */
  | 'runs_not_offered'
  /** The policy is not loaded yet. */
  | 'not_loaded'
  /** A write to the same policy is in flight. */
  | 'write_in_flight'
  /** The tool is not callable (withdrawn, or a status the module does not know): a cell on it is read-only. */
  | 'tool_not_callable'
  /** The working copy holds rules or approvers the contract refuses (`checkRules` names them): nothing is sent. */
  | 'rules_invalid'
  /** The organisation's break-glass setting is not served here (`approval_routing` is not in `policy_forms`). */
  | 'approval_routing_not_offered';

/**
 * What went wrong, derived from the status and the problem code and never from prose. API problems are returned, never
 * thrown. The kinds are the approvals module's, with `conflict` carrying the governing policy of a 409
 * `policy_conflict` and `unprocessable` for a 422 `unsupported_policy_form`.
 */
export type PermissionsError = {
  /** The HTTP status when the error came from a response; absent for a local error. */
  readonly status?: number;
  readonly title: string;
  /** The `request_id` of the problem document, when there was one. */
  readonly requestId?: string;
  /** The problem document's `type` URI, verbatim; absent for an error raised locally. */
  readonly type?: string;
  /** The problem's `detail`, verbatim: for a 400 or a 422 it names the member that was refused. */
  readonly detail?: string;
  /** The problem's `member` (rev 13), verbatim: a path into the request body, for example `config.rules[0].when[1].fact`. */
  readonly member?: string;
  /** The wait the server asked for, in milliseconds. */
  readonly retryAfterMs?: number;
  /** The problem's `reason` token, kept only on a 503. */
  readonly reason?: string;
  /** The exception behind a `network` error, for a bug report or a log; may be a host-thrown error — do not log blindly. */
  readonly cause?: unknown;
} & (
  | {
      readonly kind: 'conflict';
      readonly code: string;
      readonly local?: true;
      /** On `policy_conflict`: the published policy that already governs one of the pairs. */
      readonly policyId?: string;
    }
  | {
      /** A 422 `unsupported_policy_form`: the deployment cannot enforce the form; `detail` names the member. */
      readonly kind: 'unprocessable';
      readonly code: string;
      readonly local?: true;
    }
  | {
      /** A refusal the store gave without a request. */
      readonly kind: 'precondition';
      readonly code: PermissionsPreconditionCode;
      readonly local: true;
    }
  | {
      /** A response that could not be read as the contract's shape. A list that cannot be parsed is this, never empty. */
      readonly kind: 'malformed_response';
      readonly code: string;
      readonly local?: true;
    }
  | { readonly kind: 'unauthorized'; readonly code: string; readonly local?: true }
  | { readonly kind: 'forbidden'; readonly code: string; readonly local?: true }
  | { readonly kind: 'not_found'; readonly code: string; readonly local?: true }
  | { readonly kind: 'invalid_request'; readonly code: string; readonly local?: true }
  | { readonly kind: 'rate_limited'; readonly code: string; readonly local?: true }
  | { readonly kind: 'unavailable'; readonly code: string; readonly local?: true }
  | { readonly kind: 'network'; readonly code: string; readonly local?: true }
  | { readonly kind: 'unsupported'; readonly code: string; readonly local?: true }
);

export type PermissionsErrorKind = PermissionsError['kind'];

/** A role the host names as a column: its bare key and, optionally, the label to show. */
export interface RoleOption {
  readonly id: string;
  readonly label?: string;
}

export interface UsePoliciesOptions {
  readonly baseUrl: string;
  /** Called per request; `forceRefresh` asks for a new token after a 401. */
  readonly getToken: (x?: { forceRefresh?: boolean }) => string | Promise<string>;
  /** When false nothing is read and the status stays `idle`. Default true. */
  readonly enabled?: boolean;
  readonly fetch?: typeof fetch;
  readonly onSessionExpired?: () => void;
  /** As `UseApprovalsOptions.onFault`. */
  readonly onFault?: (fault: unknown) => void;
  /** The roles to show as matrix columns, in this order, before any role a policy or the directory names. */
  readonly roles?: readonly RoleOption[];
  /** True turns authoring off for a host that knows its user is not an administrator. */
  readonly readOnly?: boolean;
  /** True reads the suggested policies, only when the organisation holds the `policies.suggested` entitlement. */
  readonly suggested?: boolean;
}

/**
 * `idle`: not started (or `enabled` is false). `loading`: reading. `ready`: policies and tools read. `unavailable`:
 * the service does not advertise the policies family (a neutral state, not an error). `error`: a read failed; the
 * matrix is not shown, never filled with defaults.
 */
export type PoliciesStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

/** How a policy of another kind is shown: a `duplicate_requests` setting, or a policy the module cannot evaluate. */
export type OtherPolicyView =
  | { readonly kind: 'approval_routing'; readonly breakGlass: boolean }
  | {
      readonly kind: 'duplicate_requests';
      readonly afterRejection: string;
      readonly windowSeconds?: number;
      readonly maxReasks?: number;
    }
  | { readonly kind: 'opaque' };

export interface OtherPolicy {
  readonly policy: PolicyInfo;
  readonly view: OtherPolicyView;
}

/** The policies of every kind but `tool_invocation`, read-only. */
export interface OtherPoliciesState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly policies: readonly OtherPolicy[];
  readonly error?: PermissionsError;
}

/**
 * The suggested policies. `off`: not asked for, or the organisation lacks the entitlement (no request is made).
 * `hidden`: the service answered that it does not offer them (403 `entitlement_required` or 404
 * `not_available_on_deployment`).
 */
export interface SuggestedState {
  readonly status: 'off' | 'loading' | 'ready' | 'hidden' | 'error';
  readonly policies: readonly PolicyInfo[];
  readonly error?: PermissionsError;
}

/** Whether the module may author, and why not. */
export interface AuthoringState {
  readonly readOnly: boolean;
  /** `not_offered`: `policies.author` is not advertised. `host`: `readOnly` was passed. `forbidden`: a write was refused with 403. */
  readonly reason?: 'not_offered' | 'host' | 'forbidden';
  /** A draft may be published: authoring is on and `policies.publish` is advertised. */
  readonly canPublish: boolean;
  /** A published policy may be retired and a draft discarded: authoring is on and `policies.retire` is advertised. */
  readonly canRetire: boolean;
}

/** A draft the store knows of: a policy never published, or the pending draft of a published one. */
export interface DraftEntry {
  readonly policyId: string;
  readonly name?: string;
  readonly version: number;
  readonly updatedAt?: string;
  /** True for a policy that was never published. */
  readonly neverPublished: boolean;
  /** The draft itself. */
  readonly policy: PolicyInfo;
}

/** What the store holds, without the actions. */
export interface PoliciesSnapshot {
  readonly status: PoliciesStatus;
  /**
   * With `error`: why. With `ready`: the lists could not be read again after a write; the grid shows the lists read
   * before it, and the next successful read clears this.
   */
  readonly error?: PermissionsError;
  readonly facts?: PolicyCapabilityFacts;
  /** The `tool_invocation` policies the list returned (each at its published version, or its draft if never published). */
  readonly policies: readonly PolicyInfo[];
  readonly tools: readonly ToolInfo[];
  readonly others: OtherPoliciesState;
  readonly suggested: SuggestedState;
  /** Roles the principals directory lists, when the `principals` family is advertised. */
  readonly directoryRoles: readonly RoleOption[];
  /** Connection names by id, when the `connections` family is advertised and answered. */
  readonly connectionNames: Readonly<Record<string, string>>;
  /**
   * The failures of the reads that add to the grid without blocking it: the roles of the directory (a role no policy
   * names and the host did not pass has no column) and the connection names (the grid shows connection ids).
   */
  readonly sideErrors: {
    readonly roles?: PermissionsError;
    readonly connections?: PermissionsError;
  };
  /** The drafts known to the store (the Drafts tray). A pending draft of a published policy is known only once read. */
  readonly drafts: readonly DraftEntry[];
  readonly authoring: AuthoringState;
  /** The ids of the policies with a write in flight. */
  readonly busy: ReadonlySet<string>;
}

/** A matrix column: a role, or the organisation. */
export interface MatrixColumn {
  /** `role:<id>` or `organization`. */
  readonly key: string;
  readonly subject: PolicySubject;
  readonly label: string;
}

/** The policy shown in a cell: what the wire says about it, and nothing about what it composes to. */
export interface CellPolicy {
  readonly policyId: string;
  readonly name?: string;
  readonly version: number;
  readonly mode?: string;
  readonly modeKnown: boolean;
  readonly source: string;
  readonly updatedBy?: PolicyAuthor;
  /** True when the policy governs this pair alone (one subject, one target): the cell writes its next draft. */
  readonly soleCell: boolean;
}

/** A draft that would cover the pair once published. */
export interface PendingRef {
  readonly policyId: string;
  readonly name?: string;
  readonly version: number;
}

/**
 * One (tool, subject) pair. `governed`: the published `tool_invocation` policy whose subjects include the subject and
 * whose targets include the tool (the contract allows at most one). `none`: no published policy governs it, so the
 * deployment's default applies (its value is not known here). `conflict`: the list returned more than one.
 */
export type MatrixCell = {
  readonly columnKey: string;
  readonly toolRef: string;
  readonly pending: readonly PendingRef[];
} & (
  | { readonly state: 'governed'; readonly policy: CellPolicy }
  | { readonly state: 'none' }
  | { readonly state: 'conflict'; readonly policies: readonly CellPolicy[] }
);

export interface MatrixRow {
  readonly tool: ToolInfo;
  /** One cell per column, in column order. */
  readonly cells: readonly MatrixCell[];
}

/** Tools of one connection. `connectionId` null: tools registered without a connection. */
export interface MatrixGroup {
  readonly connectionId: string | null;
  /** The connection's name, when the connections family answered. */
  readonly name?: string;
  readonly rows: readonly MatrixRow[];
}

/** A policy whose subject is a user, agent, service, group or a type the module does not know. */
export interface OtherSubjectEntry {
  readonly subject: PolicySubject;
  readonly policy: PolicyInfo;
}

/**
 * A policy the matrix cannot place, or cannot place in full. `state_not_stated` and `targets_not_stated`: the service
 * did not say whether it is published or which tools it governs, so it is on no cell. `target_not_listed`: a published
 * policy or a draft names tools the tool list does not show (`toolRefs`); it is on the cells of the tools it names that
 * are listed, and these targets are shown with it here.
 */
export type UnplacedPolicy =
  | { readonly policy: PolicyInfo; readonly reason: 'targets_not_stated' | 'state_not_stated' }
  | {
      readonly policy: PolicyInfo;
      readonly reason: 'target_not_listed';
      /** The targets that name no listed tool, in the policy's order. */
      readonly toolRefs: readonly string[];
    };

/** The role × tool grid of authored policies. It states provenance for authored cells only and claims no composition. */
export interface PermissionsMatrix {
  readonly columns: readonly MatrixColumn[];
  readonly groups: readonly MatrixGroup[];
  readonly otherSubjects: readonly OtherSubjectEntry[];
  readonly unplaced: readonly UnplacedPolicy[];
}

/** The editable members of a policy, as they are written. */
export interface PolicyWorkingCopy {
  readonly kind: string;
  readonly name?: string;
  readonly description?: string;
  readonly subjects: readonly PolicySubject[];
  readonly targets: 'all' | readonly string[];
  readonly config: Readonly<Record<string, unknown>>;
}

/** What `setCell` did. `open_editor`: the policy governs several pairs, so it is edited as a whole. */
export type CellWriteResult =
  | { readonly kind: 'written'; readonly policy: PolicyInfo }
  | { readonly kind: 'open_editor'; readonly policyId: string }
  | { readonly kind: 'error'; readonly error: PermissionsError };

export type PolicyWriteResult =
  | { readonly ok: true; readonly policy: PolicyInfo }
  | { readonly ok: false; readonly error: PermissionsError };

/** The outcome of discarding a draft: `deleted` when the policy was never published, so it went with its draft. */
export type PolicyDiscardResult =
  | { readonly ok: true; readonly deleted: boolean }
  | { readonly ok: false; readonly error: PermissionsError };

/**
 * An editor note. `conditions_cleared`: a mode change removed `on_deny`, `expires_after` or `approver_groups`.
 * `targets_not_stated`: the service did not say which tools the policy governs, so there is no working copy and the
 * policy cannot be saved from here.
 */
export type EditorNote = 'conditions_cleared' | 'targets_not_stated';

/** The state of one policy's editor. */
export interface PolicyEditorSnapshot {
  readonly id: string;
  readonly status: 'loading' | 'ready' | 'not_found' | 'error';
  /** The read's failure, or the last action's. */
  readonly error?: PermissionsError;
  /** `GET /v1/policies/{id}`: the published version, or the draft of a policy never published. */
  readonly current?: PolicyInfo;
  /** Every version, newest first, the pending draft included. */
  readonly versions: readonly PolicyInfo[];
  /** The pending draft (the newest version not published), if any. */
  readonly pendingDraft?: PolicyInfo;
  /** What is edited: the pending draft if any, else the published version. */
  readonly working?: PolicyWorkingCopy;
  /** The version the working copy was loaded from. */
  readonly workingFrom?: { readonly version: number; readonly state: PolicyInfo['state'] };
  /** The working copy differs from what was loaded or last saved. */
  readonly dirty: boolean;
  readonly notes: readonly EditorNote[];
  readonly saving: boolean;
  readonly publishing: boolean;
  /**
   * The policy changed since it was loaded (a publish found another draft, or this store wrote it from a cell or the
   * Drafts tray): save and publish refuse with `draft_changed` until `reload`.
   */
  readonly stale: boolean;
  /** On a 409 `policy_conflict`: the governing policy, with its name when the list has it. */
  readonly conflict?: { readonly policyId: string; readonly name?: string };
  /**
   * The version the last publish made. It is kept when the read after the publish fails, so `status: 'error'` beside
   * it means the publish succeeded and the editor could not read the policy again.
   */
  readonly lastPublished?: PolicyInfo;
}

/** The input of a simulation. */
export interface SimulationInput {
  readonly toolRef: string;
  /** The call's arguments; default `{}`. */
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly agentId?: string;
  /** Only where `runs` is advertised. */
  readonly runId?: string;
  /** The version to simulate; default the editor's working version, else the pending draft the store knows. */
  readonly draftVersion?: number;
}

/** One entry of `considered`: a policy that matched, or a default of the deployment (null id and version). */
export interface ConsideredEntry {
  readonly kind: string;
  readonly id: string | null;
  readonly version: number | null;
  readonly result: string;
  readonly subject?: PolicySubject;
  /** On a default: which one (for example `default`). */
  readonly source?: string;
  /** The policy's name, when the list has it. */
  readonly name?: string;
  /** Whether the service used this entry to reach the decision (rev 11), as sent; absent when it did not say. */
  readonly contributed?: boolean;
  /** Rev 16: the rule of the policy that gave `result` (its index in `rules`, and its outcome); absent when `mode` did. */
  readonly rule?: { readonly index: number; readonly then: string };
  /** Rev 16: the facts the call did not supply that a rule needed; `result` is then `ask`. */
  readonly missingFacts?: readonly string[];
}

/** What a simulation answered. `considered` lists inputs and the outcome; it says nothing about precedence. */
export interface SimulationResult {
  readonly decision: string;
  readonly reason?: string;
  readonly actionDigest: string;
  /** False: nothing was enforced (a dry run). */
  readonly enforced: boolean;
  readonly wouldBe?: string;
  /** The policy the decision names; absent when the deployment's default decided. */
  readonly policy?: {
    readonly id: string;
    readonly version: number;
    readonly sideEffectLevel?: string;
  };
  readonly rejectedApprovalId?: string;
  /** Rev 16: the facts with no value that made a policy ask (`Decision.missing_facts`), when the service sent any. */
  readonly missingFacts?: readonly string[];
  /** Absent when the service did not send it (it is optional on the wire). */
  readonly considered?: {
    readonly policies: readonly ConsideredEntry[];
    readonly composed: { readonly decision: string; readonly reason?: string };
  };
  /**
   * Whether this policy applied to the caller: true when an entry of `considered` (or the deciding policy) carries its
   * id, false when `considered` is present and none does, undefined when the service sent too little to tell. A
   * simulation always answers for the caller.
   */
  readonly appliesToCaller?: boolean;
}

export interface PolicySimulationSnapshot {
  readonly id: string;
  readonly status: 'idle' | 'running' | 'done' | 'error';
  readonly result?: SimulationResult;
  readonly error?: PermissionsError;
  /** The input of the last run. */
  readonly input?: SimulationInput;
  /**
   * The `draft_version` the last run sent: the version asked for, else the editor's last loaded or saved version (not
   * its unsaved changes), else the pending draft the store knows, else the version the list shows; absent only when
   * the store knows no version of the policy and the service chose.
   */
  readonly draftVersion?: number;
}

export type SimulationOutcome =
  | { readonly ok: true; readonly result: SimulationResult }
  | { readonly ok: false; readonly error: PermissionsError };

/** The headless editor of one policy. Reading starts on the first `subscribe`. */
export interface PolicyEditorStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PolicyEditorSnapshot;
  reload(): Promise<void>;
  /** Changes members of the working copy. */
  edit(patch: Partial<Omit<PolicyWorkingCopy, 'kind' | 'config'>>): void;
  /** Sets the mode; a mode that takes no conditions clears them (with the note `conditions_cleared`). */
  setMode(mode: string): void;
  /** Sets a condition member (`on_deny`, `expires_after`, `approver_groups`); `undefined` removes it. */
  setCondition(
    field: 'on_deny' | 'expires_after' | 'approver_groups',
    value: string | readonly string[] | undefined
  ): void;
  /** Rev 16: sets the rules, in order; none (or an empty list) removes the member. A member the editor could not read is never replaced. */
  setRules(rules: readonly PolicyRule[] | undefined): void;
  /** Rev 16: sets the policy's approver entries; none (or an empty list) removes the member. */
  setApprovers(approvers: readonly PolicyApprover[] | undefined): void;
  /** Rev 16: sets `exclude`; none (or an empty list) removes the member. */
  setExclude(exclude: readonly string[] | undefined): void;
  save(): Promise<PolicyWriteResult>;
  publish(): Promise<PolicyWriteResult>;
}

/** The headless simulation of one policy. */
export interface PolicySimulationStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PolicySimulationSnapshot;
  run(input: SimulationInput): Promise<SimulationOutcome>;
}

/** The store behind `usePolicies`. Reading starts on the first `subscribe`; writes need no subscriber. */
export interface PoliciesStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PoliciesSnapshot;
  /** The constant snapshot for a server render: `idle`, nothing read. */
  getServerSnapshot(): PoliciesSnapshot;
  refresh(): Promise<void>;
  /**
   * Sets the mode of a (tool, subject) pair. No governing policy: creates a draft (or writes the one draft that covers
   * only this pair). A policy that governs only this pair: writes its next draft. One that governs several: answers
   * `open_editor` and writes nothing (the module never splits a policy). `name` names a created draft.
   */
  setCell(
    subject: PolicySubject,
    toolRef: string,
    mode: string,
    options?: { readonly name?: string }
  ): Promise<CellWriteResult>;
  /** Creates a draft policy. */
  create(write: PolicyWorkingCopy): Promise<PolicyWriteResult>;
  /**
   * Publishes the pending draft of `id` when it is `shown`, the draft the caller showed (a Drafts tray entry's
   * `policy`, or what an editor loaded). The versions are read again first; a pending draft of another version, or the
   * same version with other content or another `updated_at`, is refused with `draft_changed` and nothing is published.
   */
  publish(id: string, shown: PolicyInfo): Promise<PolicyWriteResult>;
  /**
   * Retires the published policy `id` (`policies.retire`): it leaves the lists at once, its pending draft is discarded
   * with it and its versions are kept; once the service's policy-cache interval has passed it is no longer enforced
   * and no new decision or approval names it. Answers the policy at its last published version.
   */
  retire(id: string): Promise<PolicyWriteResult>;
  /**
   * Discards the pending draft of `id` (`policies.retire`); on a policy never published, deletes the policy. The
   * published version, if any, stays in force. With `shown` (the draft the caller showed), a pending draft of another
   * version, or the same one rewritten, is refused with `draft_changed` and nothing is discarded.
   */
  discardDraft(id: string, shown?: PolicyInfo): Promise<PolicyDiscardResult>;
  /** The editor of `id`, one per id for the life of the store. */
  editor(id: string): PolicyEditorStore;
  /** The simulation of `id`, one per id for the life of the store. */
  simulation(id: string): PolicySimulationStore;
  /** The effective view (what a holder of a role or of the organisation would get), one for the life of the store. */
  effective(): EffectiveStore;
  /** The newest version of `id` (its pending draft when there is one, else the published version), read now. */
  latest(id: string): Promise<PolicyWriteResult>;
  /**
   * Saves an imported policy as a draft, recording `origin`: without `id`, created (its source becomes `imported`);
   * with `id`, written as that policy's next draft, only when its newest version is still `seen` (else `draft_changed`).
   */
  saveImported(
    write: PolicyWorkingCopy,
    options: { readonly origin: PolicyOrigin; readonly id?: string; readonly seen?: PolicyInfo }
  ): Promise<PolicyWriteResult>;
  /**
   * Sets the organisation's break-glass setting (rev 16 `approval_routing`): writes the next draft of the
   * published policy of that kind in force and publishes it, or, when none is published, creates one for the
   * organisation and publishes it. Refused without a request unless the
   * service lists the form, authoring is on and publishing is offered.
   */
  setApprovalRouting(breakGlass: boolean): Promise<PolicyWriteResult>;
  dispose(): void;
}

/** What `usePolicies` returns. */
export interface PoliciesController extends PoliciesSnapshot {
  /** The grid, when `status` is `ready`; never filled with defaults. */
  readonly matrix?: PermissionsMatrix;
  refresh(): Promise<void>;
  setCell: PoliciesStore['setCell'];
  create: PoliciesStore['create'];
  publish: PoliciesStore['publish'];
  retire: PoliciesStore['retire'];
  discardDraft: PoliciesStore['discardDraft'];
  editor: PoliciesStore['editor'];
  simulation: PoliciesStore['simulation'];
  effective: PoliciesStore['effective'];
  latest: PoliciesStore['latest'];
  saveImported: PoliciesStore['saveImported'];
  setApprovalRouting: PoliciesStore['setApprovalRouting'];
}

/** What `usePolicyEditor` returns: the editor's state and actions, and whether authoring is on. */
export interface PolicyEditorController extends PolicyEditorSnapshot {
  readonly authoring: AuthoringState;
  reload(): Promise<void>;
  edit: PolicyEditorStore['edit'];
  setMode: PolicyEditorStore['setMode'];
  setCondition: PolicyEditorStore['setCondition'];
  setRules: PolicyEditorStore['setRules'];
  setApprovers: PolicyEditorStore['setApprovers'];
  setExclude: PolicyEditorStore['setExclude'];
  save(): Promise<PolicyWriteResult>;
  publish(): Promise<PolicyWriteResult>;
}

/** What `usePolicySimulate` returns. */
export interface PolicySimulationController extends PolicySimulationSnapshot {
  /** Whether a run may name a run id (`runs` is advertised). */
  readonly runsOffered: boolean;
  run(input: SimulationInput): Promise<SimulationOutcome>;
}
