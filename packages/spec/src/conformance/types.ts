/** The scenario file format and the run report. */
import type { Family, Feature } from '../spec/families.js';
import type { OperationInfo, SpecIndex } from '../spec/validate.js';

/** How a deployment treats DPoP proofs, as `GET /v1/capabilities` advertises it. */
export type DpopMode = 'off' | 'optional' | 'required';

export const DPOP_MODES: readonly DpopMode[] = ['off', 'optional', 'required'];

/** The members of `Capabilities.limits`. */
export const LIMIT_NAMES = [
  'decisions_batch_max_items',
  'records_batch_max_items',
  'resolutions_batch_max_items',
] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];

/** The members of `Capabilities` a deployment may add to say what it restricts. Absent: the rev 5 behaviour. */
export const CAPABILITY_MEMBERS = [
  'approval_arguments_max_bytes',
  'continuation_deliveries',
  'tool_registration',
  'user_resolve_scope',
  // Rev 11: the policy forms the deployment enforces, who registers a connection and the transports served.
  'policy_forms',
  'connection_registration',
  'connection_transports',
  // Rev 14: the deployment-applied references the deployment applies on approval.
  'deployment_applied',
] as const;
export type CapabilityMember = (typeof CAPABILITY_MEMBERS)[number];

/** Who may register tools, as `Capabilities.tool_registration` says. */
export type ToolRegistration = 'any' | 'administrators';

/** The continuation deliveries of the contract. */
export type Delivery = 'push' | 'pull' | 'held';

/**
 * What a deployment advertised beyond its families: the three optional restrictions, and the
 * resolutions it can produce. A member the deployment did not advertise is undefined (and the
 * registration is `any`).
 */
export interface AdvertisedRestrictions {
  readonly approval_arguments_max_bytes?: number;
  readonly continuation_deliveries?: readonly Delivery[];
  readonly tool_registration: ToolRegistration;
  readonly resolutions: readonly string[];
  /** `Capabilities.self_approval_from_approver_surface`; `false` when the member is absent. */
  readonly self_approval_from_approver_surface?: boolean;
  /** `Capabilities.user_resolve_scope`: the scope a user's token must carry to resolve; undefined when the member is absent. */
  readonly user_resolve_scope?: string;
  /** `Capabilities.policy_forms` (rev 11): the policy forms the deployment enforces; undefined when the member is absent. */
  readonly policy_forms?: PolicyForms;
  /** `Capabilities.connection_registration` (rev 11); undefined when the member is absent (unrestricted). */
  readonly connection_registration?: ConnectionRegistration;
  /** `Capabilities.connection_transports` (rev 11); undefined when the member is absent (both). */
  readonly connection_transports?: readonly ConnectionTransport[];
  /** `Capabilities.deployment_applied` (rev 14): the references the deployment applies; undefined when the member is absent. */
  readonly deployment_applied?: readonly DeploymentApplied[];
}

/** An entry of `Capabilities.deployment_applied` (rev 14). */
export interface DeploymentApplied {
  readonly tool_ref: string;
  readonly arguments_schema_ref: string;
}

/** A connection transport of the contract (rev 11). */
export type ConnectionTransport = 'mcp' | 'a2a';
/** An owner kind of a connection (rev 11). */
export type ConnectionOwnerKind = 'principal' | 'org';

/** `Capabilities.connection_registration` (rev 11): who may register a connection. */
export interface ConnectionRegistration {
  readonly owner_kinds: readonly ConnectionOwnerKind[];
  readonly who: 'any' | 'administrators';
}

/** `Capabilities.policy_forms` (rev 11): the forms a deployment enforces, by policy kind. */
export interface PolicyForms {
  readonly tool_invocation?: {
    readonly modes: readonly string[];
    readonly subject_types: readonly string[];
    readonly targets_all: boolean;
    readonly config_members: readonly string[];
  };
}

/** The limits a deployment advertised, by name. */
export type AdvertisedLimits = Readonly<Partial<Record<LimitName, number>>>;

export type Alias =
  | 'creator'
  | 'creator_user'
  | 'admin'
  | 'member'
  | 'approver'
  | 'approver_surface_token'
  | 'approver_token_without_resolve_scope'
  | 'other_org'
  | 'other_service'
  | 'entitled'
  | 'wrong_audience'
  | 'forged'
  | 'expired'
  | 'dpop_bound'
  | 'no_org'
  | 'no_scope'
  | 'none';

/** One predicate over the JSON body of a response. `path` is dotted: `data.approval.id`, `data.items.0`. */
export interface Predicate {
  readonly path: string;
  readonly equals?: unknown;
  readonly not_equals?: unknown;
  /** The value at `path` is the same JSON value as this one: equal canonical forms (RFC 8785), so member order does not matter. */
  readonly equals_canonical?: unknown;
  readonly exists?: boolean;
  readonly matches?: string;
  readonly in?: readonly unknown[];
  readonly length?: number;
  readonly contains?: unknown;
  /** The array at `path` has an element whose member `key` equals `equals`. */
  readonly contains_where?: { readonly key: string; readonly equals: unknown };
  /**
   * The array at `path` has an element that has each of these members, each the same JSON value (equal
   * canonical forms, so member order does not matter). For an entry that must carry several members at once.
   */
  readonly contains_members?: Readonly<Record<string, unknown>>;
  /**
   * Rev 11: the array at `path` has no element that has each of these members, each the same JSON value. For an
   * entry that must not carry a value (an allow that did not contribute), whether it carries the member or not.
   */
  readonly lacks_members?: Readonly<Record<string, unknown>>;
  /** No element of the array at `path` has a member `key` equal to `equals`. */
  readonly lacks_where?: { readonly key: string; readonly equals: unknown };
  /**
   * Rev 13: no element of the array at `path` has a string member `key` that matches the regular expression
   * `matches` (case-insensitively with `ignore_case`). For a name that may come in more than one form.
   */
  readonly lacks_where_matches?: {
    readonly key: string;
    readonly matches: string;
    readonly ignore_case?: boolean;
  };
  /** The array at `path` has no element equal to this value. */
  readonly lacks?: unknown;
  /**
   * The value at `path` is absent, or differs from the value at this other path of the same body. For a
   * member that is optional but, when present, may not repeat another (a name that is never the id).
   */
  readonly differs_from?: string;
  /**
   * Rev 12: the value at `path` holds no object member with this name at any depth. For a thin event, which
   * never carries `arguments`.
   */
  readonly lacks_key?: string;
  /**
   * Rev 12: the value at `path` is an object whose own member names are exactly these, in any order. For a
   * thin event, whose `data` holds its listed members and nothing more.
   */
  readonly keys_exactly?: readonly string[];
}

export interface HeaderExpectation {
  readonly name: string;
  /** Default `true`. */
  readonly exists?: boolean;
  /** A regular expression the header's value matches. */
  readonly matches?: string;
}

export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly content_type?: string;
}

export interface HttpStep {
  readonly name?: string;
  readonly as?: Alias;
  /** The authorization scheme the token is sent under. Default `Bearer`. */
  readonly scheme?: 'Bearer' | 'DPoP';
  readonly request: HttpRequest;
  /**
   * Gates the rest of the scenario on what this step answered: when the step passes with another status than
   * `status`, the steps after it do not run and the scenario is a capability skip with `reason` (a deployment that
   * conformantly refuses an optional form, say). The step itself is still checked.
   */
  readonly gate?: {
    readonly status: number;
    readonly reason: string;
    /**
     * The one other answer that skips: its status, its problem code and, optionally, a pattern its `detail` matches.
     * Any other status, problem or detail fails the step (a refusal for another reason is never read as the gate's).
     */
    readonly otherwise: {
      readonly status: number;
      readonly problem: string;
      readonly detail_matches?: string;
      /**
       * Rev 13: the `member` the problem names. A deployment that sends `member` must send this one; a rev 12
       * deployment sends none, and is then read by `detail_matches` (a gate with `member` and no
       * `detail_matches` has no rev 12 reading, so a problem without `member` fails).
       */
      readonly member?: string;
    };
  };
  readonly expect: {
    readonly status: number | readonly number[];
    /** A problem code: the body is a problem document whose `type` ends with `/<code>`. */
    readonly problem?: string;
    readonly body?: readonly Predicate[];
    /** Response headers: each named header exists (the default) or is absent, and matches a pattern when one is given. */
    readonly headers?: readonly HeaderExpectation[];
    /** Skip the response schema check (for a route whose response is a stream). */
    readonly stream?: boolean;
    /** The request is not an operation of the document (a probe): the route check is skipped. */
    readonly undocumented?: boolean;
    /**
     * Rev 13: after a page that passes, request the next one (`cursor` set to `meta.next`) and check it the same
     * way, until `meta.next` is null. For a predicate over a whole listing (an entry that no page carries). Stops
     * at 50 pages, and that is a failure.
     */
    readonly follow_pages?: true;
  };
  /** Variables to save from the body: name -> dotted path, or `$` for the whole body. */
  readonly save?: Readonly<Record<string, string>>;
}

export interface ClockStep {
  readonly advance_seconds: number;
}

/**
 * Verifies a signed object against a key set (rev 12). `kind` says which: a `resumption` is also checked against
 * `expect` (the tool and digest the runtime is about to run); a `webhook_delivery` is checked for its signature
 * alone. The signed payload of a `valid` object must be the object it travels with, without `signature`.
 */
export interface VerifySpec {
  readonly kind: 'resumption' | 'webhook_delivery';
  readonly object: unknown;
  readonly jwks: unknown;
  /** Required for a `resumption`. */
  readonly expect?: { readonly tool_ref: string; readonly arg_digest: string };
  /** Changes a member of the signed payload before verifying: a resumption's two, or a delivery's `data`. */
  readonly tamper?: 'action_digest' | 'tool_ref' | 'data';
  /** `valid`, or the code the verification must reject with. */
  readonly result: string;
}

/** The rev 11 form of the verify step, kept so a scenario that uses it still runs: a `resumption` verify. */
export interface VerifyResumptionStep {
  readonly verify_resumption: {
    readonly resumption: unknown;
    readonly jwks: unknown;
    readonly expect: { readonly tool_ref: string; readonly arg_digest: string };
    readonly tamper?: 'action_digest' | 'tool_ref';
    readonly result: string;
  };
}

export interface VerifyStep {
  readonly verify: VerifySpec;
}

export interface AuthzenStep {
  readonly authzen: {
    readonly as?: Alias;
    readonly request: unknown;
    readonly expect: {
      readonly decision: boolean;
      readonly noblecloak_decision?: string;
      /** `context.noblecloak` has no `policy` member (absent, not null). */
      readonly noblecloak_policy_absent?: boolean;
    };
  };
}

/**
 * Opens a server-sent event stream, runs `during` while it is open, then checks which `approval.updated`
 * events were delivered. Every event's data is validated against the `Approval` schema.
 */
export interface StreamStep {
  readonly stream_events: {
    readonly name?: string;
    readonly as?: Alias;
    readonly path: string;
    /** Requests sent while the stream is open, in order. */
    readonly during: readonly HttpStep[];
    /** How long to keep reading after the last request, in milliseconds. Default 300. */
    readonly settle_ms?: number;
    readonly expect: {
      /** Approval ids the stream delivered, each optionally with predicates over the event's data. */
      readonly delivers?: readonly (
        | string
        | {
            readonly id: string;
            readonly body: readonly Predicate[];
            /**
             * Apply `body` to every event delivered for the id, not only the last. What must be absent from an
             * approval has to be absent from each event that carries it, a creation event included.
             */
            readonly every_event?: true;
          }
      )[];
      /** Approval ids the stream must not have delivered. */
      readonly lacks?: readonly string[];
      /**
       * States that the stream is expected to open and nothing more (the engine fails a step whose stream
       * does not answer 200 `text/event-stream`). It is what lets a step carry `lacks` without a `delivers`:
       * a stream that delivers nothing satisfies `lacks` on its own.
       */
      readonly open?: true;
    };
  };
}

/**
 * Switches a behaviour of a mock that offers control (`Target.mockControl`): `limits` sets the batch
 * limits it advertises and enforces, `fail` makes the next request to an operation answer a server error
 * once, `consent` completes an OAuth authorization. The control is reset after every scenario that used it.
 */
export interface ControlStep {
  readonly control: {
    readonly limits?: {
      readonly decisions_batch_max_items?: number;
      readonly records_batch_max_items?: number;
      readonly resolutions_batch_max_items?: number;
    };
    /** The most bytes of request body the mock accepts; a larger one is 413 `payload_too_large`. */
    readonly max_body_bytes?: number;
    readonly fail?: {
      readonly operation: string;
      readonly status: 500 | 503;
      readonly retry_after?: number;
      /** The `reason` a 503 carries, such as `eligibility_lookup`. */
      readonly reason?: string;
    };
    /**
     * Completes the OAuth authorization at `authorization_url` (an `authorize` answer) as a user who follows it and
     * consents (`deny`: refuses). Only the mock offers it: a scenario that uses it is skipped elsewhere.
     */
    readonly consent?: { readonly authorization_url: string; readonly deny?: boolean };
    /** Rev 12: marks a webhook `disabled`, as 72 hours of failed deliveries would. */
    readonly disable_webhook?: string;
    /**
     * Rev 12: answers the deliveries the mock has queued for a webhook, oldest first, each signed. The engine checks
     * each against `WebhookDelivery`. The mock never sends them anywhere. `url` is the URL the deployment returned as
     * `data.url` when the webhook was registered: a run given `Target.webhookSink` reads that sink path instead of
     * asking mock control; the mock ignores it.
     */
    readonly deliveries?: { readonly webhook_id: string; readonly url?: string };
  };
  /** Variables to save from the control answer's body: name -> dotted path, or `$` for the whole body. */
  readonly save?: Readonly<Record<string, string>>;
  /** Predicates over the control answer's body. */
  readonly expect_body?: readonly Predicate[];
}

export type Step =
  HttpStep | ClockStep | VerifyStep | VerifyResumptionStep | AuthzenStep | StreamStep | ControlStep;

export interface Scenario {
  readonly id: string;
  readonly title: string;
  /** `both`, `hosted`, `negative`, `needs-mock-control`. */
  readonly tags: readonly string[];
  /** Run only against this deployment. */
  readonly only?: 'hosted' | 'edge';
  /**
   * The route family (or families) the scenario needs. A scenario whose family the deployment does not
   * advertise on `GET /v1/capabilities` is skipped with `skipKind: 'capability'`. Absent: the scenario
   * is part of the floor and always runs.
   */
  readonly requires?: Family | readonly Family[];
  /**
   * The inverse: run only when the deployment advertises none of these families. A scenario about what
   * a deployment without a family must do (a step-up with a continuation, with no approvals) selects
   * itself this way; on a deployment that advertises the family it is skipped with `skipKind: 'capability'`.
   */
  readonly unless?: Family | readonly Family[];
  /**
   * Features (not families) the scenario needs, each a name of `Capabilities.features`: a scenario whose
   * feature the deployment does not advertise is skipped with `skipKind: 'capability'`, as for a family.
   */
  readonly features?: readonly Feature[];
  /**
   * Run only when the deployment's DPoP mode (the `dpop` member of `GET /v1/capabilities`, `off` when
   * absent) is this one; otherwise skipped with `skipKind: 'capability'`. Absent: runs in every mode.
   */
  readonly dpop?: DpopMode;
  /**
   * Batch limits the scenario reads from `data.limits` of `GET /v1/capabilities`, each bound as a
   * variable of the same name (`${decisions_batch_max_items}`; `${name+1}` is the limit plus one).
   * Skipped with `skipKind: 'capability'` when the deployment does not advertise one of them, or
   * advertises 100: nothing above 100 is `batch_too_large`, it is a schema violation.
   */
  readonly limits?: readonly LimitName[];
  /**
   * The contrary of `limits`: run only when each named limit is not advertised, or is advertised as 100,
   * the contract's ceiling (an absent limit means 100). A deployment that advertises a lower one skips the
   * scenario with `skipKind: 'capability'`. For a scenario that sends the largest batch the contract allows.
   */
  readonly unreduced_limits?: readonly LimitName[];
  /**
   * Optional `Capabilities` members the deployment must advertise: a scenario about a restriction runs only
   * where the deployment says it has one, and is skipped with `skipKind: 'capability'` (not served) where it
   * does not. `approval_arguments_max_bytes` is bound as a variable of the same name.
   */
  readonly advertises?: readonly CapabilityMember[];
  /**
   * Rev 14: the most bytes of `action.arguments` the scenario sends. Run only where the deployment advertises no
   * `approval_arguments_max_bytes` or one at least this big; else a capability skip (a bound below the size of
   * the proposal would refuse it, which is the bound's rule and not what the scenario tests).
   */
  readonly arguments_bytes?: number;
  /** Run only when the deployment's `tool_registration` is this (`any` when the member is absent); else a capability skip. */
  readonly tool_registration?: ToolRegistration;
  /** Run only when the deployment advertises `continuation_deliveries` and the list lacks this delivery. */
  readonly unserved_delivery?: Delivery;
  /** Run only when the deployment advertises approvals and cannot produce this resolution (`escalated` where it has no escalation). */
  readonly unserved_resolution?: string;
  /**
   * The converse of `unserved_delivery`: a scenario whose success needs the deployment to serve this delivery
   * is skipped (a capability skip, not a failure) where `continuation_deliveries` is advertised and lacks it.
   */
  readonly serves_delivery?: Delivery;
  /** The converse of `unserved_resolution`: skipped where the deployment advertises approvals and cannot produce this resolution. */
  readonly serves_resolution?: string;
  /**
   * Run only when the deployment's `self_approval_from_approver_surface` (`false` when the member is
   * absent) is this value; otherwise skipped with `skipKind: 'capability'`.
   */
  readonly self_approval_from_approver_surface?: boolean;
  /** Run only on a deployment that implements `on_deny` on its policies (`Target.noOnDeny` unset); else a capability skip. */
  readonly serves_on_deny?: true;
  /**
   * Rev 11: run only when the deployment advertises `connection_registration` and its `owner_kinds` lack this one
   * (the `unserved_delivery` precedent); else a capability skip.
   */
  readonly unserved_connection_owner_kind?: ConnectionOwnerKind;
  /** Rev 11: the converse: skipped where `connection_registration` is advertised and its `owner_kinds` lack this one. */
  readonly serves_connection_owner_kind?: ConnectionOwnerKind;
  /**
   * Rev 11: run only when `connection_registration.who` is this (`any` when the member is absent); else a
   * capability skip (the `tool_registration` precedent).
   */
  readonly connection_registration_who?: 'any' | 'administrators';
  /** Rev 11: run only when the deployment advertises `connection_transports` and the list lacks this one. */
  readonly unserved_connection_transport?: ConnectionTransport;
  /** Rev 11: the converse: skipped where `connection_transports` is advertised and lacks this one. */
  readonly serves_connection_transport?: ConnectionTransport;
  /**
   * Rev 11: a capability skip where `policy_forms` is advertised and its `tool_invocation.subject_types` lack this
   * subject type, or one of these (a deployment may refuse a form it does not advertise with 422), or where
   * `policy_forms` is advertised with no `tool_invocation` entry at all. Absent `policy_forms`, it runs.
   */
  readonly serves_policy_subject_type?: string | readonly string[];
  /** Aliases that must have a token (`tokenFor`), else the scenario is skipped. */
  readonly needs?: readonly Alias[];
  /** Fixtures the run must be given (`Target.fixtures`), else the scenario is skipped as unconfigured. */
  readonly fixtures?: readonly OptionalFixture[];
  /** Run the steps once per vector of the vendored corpus, with `item` bound to it. */
  readonly foreach?: 'corpus';
  readonly steps: readonly Step[];
  /**
   * Rev 13: requests that always run after `steps`, whether they passed, failed or were gated off, so a scenario
   * that changes shared state (a binding) leaves it as it found it. A cleanup step that fails is reported
   * but never hides the scenario's own failure, and the rest of the cleanup still runs. A variable a step never
   * saved fails the cleanup step that names it, not the scenario's own result.
   */
  readonly cleanup?: readonly HttpStep[];
}

/** Fixtures a run may leave unset: the scenarios that use them are skipped as unconfigured. */
export const OPTIONAL_FIXTURES = [
  'reserved_tool_ref',
  'system_tool_ref',
  'tool_ref_in_use',
  'on_deny_tool_ref',
  'on_deny_silent_tool_ref',
  'admin_role',
  'connection_server_url',
  'oauth_return_to',
] as const;
export type OptionalFixture = (typeof OPTIONAL_FIXTURES)[number];

export interface Target {
  readonly baseUrl: string;
  readonly deployment: 'hosted' | 'edge';
  /**
   * The token of each alias. `admin` is optional and, absent, is the `creator` token (`tokenFor`): a step
   * that says `as: admin` registers or changes a tool as an administrator where the deployment restricts
   * that, and as the creator where it does not.
   */
  readonly tokens: Readonly<Partial<Record<Alias, string>>>;
  /** Names of fixture tools the server under test exposes. */
  readonly fixtures: {
    readonly proxied_tool: string;
    readonly allow_tool: string;
    readonly deny_tool: string;
    /** A tool no explicit policy matches: the default applies, so its decision carries no `policy`. */
    readonly default_tool: string;
    /** A tool reference in a namespace the deployment reserves: `POST /v1/tools` refuses it (`reserved_tool_ref`). */
    readonly reserved_tool_ref?: string;
    /** The reference of a system tool the deployment owns: `POST /v1/tools` refuses it (`system_tool_ref`). */
    readonly system_tool_ref?: string;
    /**
     * A tool reference already in use in the caller's organisation for a tool registered another way, so a
     * call under it would be ambiguous: `POST /v1/tools` refuses it (`tool_ref_in_use`).
     */
    readonly tool_ref_in_use?: string;
    /**
     * A tool whose matching policy is `ask` (or `escalate`) and states `on_deny`, so an approval for it carries
     * `on_deny` for its creator (rev 9). The approver token must be eligible to resolve this tool's approvals (the
     * scenario approves them), which an `escalate` policy that routes to another approver group may not allow.
     * A deployment that implements no `on_deny` on its policies leaves it unset and declares `noOnDeny`.
     */
    readonly on_deny_tool_ref?: string;
    /**
     * A tool whose matching policy is `ask` and states no `on_deny`, so an approval for it carries none (rev 9).
     * Every deployment with an `ask` tool supplies it, whether or not it implements `on_deny`: the rule that it
     * never reads as `resume` or `halt` by default binds a deployment that implements none too.
     */
    readonly on_deny_silent_tool_ref?: string;
    /**
     * The bare key of a role the `admin` token holds (rev 11, `nc-conform --admin-role`), for the scenarios that
     * author a role-subject policy the administrator matches (tightest-wins) or simulate as that role. Bound as
     * `${admin_role}`; without it those scenarios are skipped as unconfigured.
     */
    readonly admin_role?: string;
    /**
     * The URL of a tool server the deployment can reach and enumerate (rev 11, `nc-conform
     * --connection-server-url`), for the scenarios that refresh or discover a registration. Each registers it and
     * deletes the registration at its end; without it those scenarios are skipped as unconfigured.
     */
    readonly connection_server_url?: string;
    /**
     * A `return_to` the deployment admits for an OAuth authorization (rev 11, `nc-conform --oauth-return-to`): a URL
     * on an origin it admits for browser modules. Without it the authorize scenarios are skipped as unconfigured.
     */
    readonly oauth_return_to?: string;
  };
  /**
   * The deployment implements no `on_deny` on its policies (`nc-conform --no-on-deny`). The scenario that expects
   * `on_deny` for a creator is then a capability skip, which does not affect the exit code, and needs no fixture.
   */
  readonly noOnDeny?: true;
  /**
   * Fail a response that carries a field its schema does not declare: the document is the contract, so a
   * member it does not name is a defect (`nc-conform` sets it unless `--allow-undeclared`).
   */
  readonly rejectUndeclared?: boolean;
  /** A URL that advances the server's clock, for servers that offer one. */
  readonly clockControl?: string;
  /** A URL that takes `ControlStep` bodies, for a server that offers control (the mock does). */
  readonly mockControl?: string;
  /**
   * A public HTTPS receiver the deployment under test can deliver webhooks to (`nc-conform --webhook-sink`). Scenarios
   * register webhooks under `${callback_base_url}` (this `baseUrl`, else `https://hooks.example.com`), and a
   * `deliveries` control step reads the deliveries from the sink with `token` instead of asking mock control.
   */
  readonly webhookSink?: WebhookSink;
  readonly fetch?: typeof globalThis.fetch;
}

/** A webhook receiver the run reads deliveries back from. */
export interface WebhookSink {
  /** `https://` base, no trailing slash. The token is sent only to URLs under it. */
  readonly baseUrl: string;
  /** Bearer token for reading the sink. */
  readonly token: string;
  /** How long a `deliveries` step keeps polling for its expectations to hold (default 60). */
  readonly waitSeconds: number;
  /** How long it waits after they first hold before the read that decides the step (default 10). */
  readonly settleSeconds: number;
}

export type Outcome = 'passed' | 'failed' | 'skipped';

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly outcome: Outcome;
  readonly failures: readonly string[];
  readonly skipReason?: string;
  /**
   * Why a skipped scenario did not run. `inapplicable` is by design (a scenario for the other
   * deployment); `unconfigured` means the run was not given what the scenario needs
   * (a token, clock control), so the behaviour it checks was NOT verified. `capability` means the
   * deployment does not advertise the route family the scenario needs: that is the deployment's
   * declared scope, so it does not affect the exit code.
   */
  readonly skipKind?: 'inapplicable' | 'unconfigured' | 'capability';
}

export interface Report {
  readonly deployment: 'hosted' | 'edge';
  readonly results: readonly ScenarioResult[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** Operations a successful response was validated for. */
  readonly exercised: readonly string[];
}

/** Context handed to built-in (generated) scenarios. */
export interface BuiltinContext {
  readonly index: SpecIndex;
  readonly target: Target;
  readonly exercised: ReadonlySet<string>;
  readonly operations: readonly OperationInfo[];
}
