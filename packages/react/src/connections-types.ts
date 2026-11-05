/**
 * The public types of the connections module: what the headless store and its hooks return. This file holds types
 * only. A change here is a change to the module's public surface.
 *
 * The module reads registrations as the wire states them. Open values (a registration's state, its credential tier, a
 * link's state and consent, a tool's status) are kept as sent; a value the module does not know is treated the way
 * the contract says a client treats it (not connected, a tier it cannot use, a link it cannot use, consent not given,
 * a tool that cannot be called). No credential is ever held: a token the caller types goes to the service in one
 * request and is not kept.
 */

import type { ToolFacts } from './connections-facts.js';

/** Who owns a registration: the organisation, or one principal (by id; never a name). */
export interface ConnectionOwner {
  /** `org` or `principal`; another value is kept as sent. */
  readonly kind: string;
  readonly id: string;
}

/** The caller's own credential link to a `per_user` registration, as the caller reads it. Never a credential. */
export interface ConnectionLinkInfo {
  /** `linked`, `pending_authorization`, `degraded` or `none`; another value is kept as sent (a link it cannot use). */
  readonly status: string;
  /** `given`, `revoked` or `none`; another value is kept as sent (consent not given). */
  readonly consent: string;
  readonly linkedAt?: string;
}

/** One registration of a tool server. */
export interface ConnectionInfo {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** `mcp` or `a2a`, as sent. */
  readonly transport: string;
  readonly owner: ConnectionOwner;
  readonly createdAt: string;
  /**
   * The registration's state: `connected`, `pending_authorization` or `degraded`; another value is kept as sent and
   * read as not connected. Absent when the service did not state it (a server of an earlier revision).
   */
  readonly state?: string;
  /** Why it is `degraded`: a code from the contract's closed list, as sent. */
  readonly stateDetail?: string;
  /** When the service last checked it; `null` when it never has; absent when the service did not say. */
  readonly lastVerifiedAt?: string | null;
  /** `none`, `bearer` or `oauth`: how the server authenticates callers. Absent when the service did not say. */
  readonly authKind?: string;
  /** `org_shared` or `per_user`; another value is kept as sent. Absent when the service did not say. */
  readonly credentialTier?: string;
  /** The caller's own link, when the registration takes links. Never another user's. */
  readonly myLink?: ConnectionLinkInfo;
}

/** A tool a registration brought in (`GET /v1/tools?connection=`), or one its server offers now (discover). */
export interface ConnectionToolInfo {
  readonly id: string;
  /** Opaque: compared for equality, never parsed. */
  readonly toolRef: string;
  readonly connectionId: string | null;
  readonly description?: string;
  readonly transport: string;
  readonly sideEffectLevel: string;
  /** `active` or `withdrawn`; absent on the wire means `active`; another value is kept (a tool that cannot be called). */
  readonly status: string;
  /** Rev 16: the facts the tool declares, by name. Absent: the tool declares none, or the service did not send any. */
  readonly facts?: ToolFacts;
  /** True when the tool carries a `facts` member this module cannot read; it is then never edited, since a write would replace it. */
  readonly factsUnreadable?: true;
}

/** The members of `GET /v1/capabilities` this module reads. Never the deployment: only what is advertised. */
export interface ConnectionsCapabilityFacts {
  /** The `connections` family is served. */
  readonly served: boolean;
  /** `connections.oauth`: the OAuth round trip (`authorize`) is offered. */
  readonly oauth: boolean;
  /** `connections.user_links`: each user links a credential of their own. */
  readonly userLinks: boolean;
  /**
   * `connection_registration`: the owner kinds a registration may have and who may register. Absent: unrestricted
   * (both owner kinds, any principal).
   */
  readonly registration?: { readonly ownerKinds: readonly string[]; readonly who: string };
  /** `connection_transports`: the transports served (absent on the wire means both). */
  readonly transports: readonly string[];
  /** `tools.facts` (rev 16): the service accepts fact bindings on a tool. Absent: it does not say so. */
  readonly toolFacts?: true;
}

/** The codes of a refusal the store gives without a request. */
export type ConnectionsPreconditionCode =
  /**
   * An administrator's act by a caller known not to be one (the host said so, or the service refused it with 403):
   * changing the organisation's registration or credential, or registering where only administrators register.
   */
  | 'read_only'
  /** The service does not register connections of this owner kind (`connection_registration`). */
  | 'owner_kind_not_offered'
  /** The service does not advertise the OAuth round trip. */
  | 'oauth_not_offered'
  /** The service does not advertise per-user links. */
  | 'links_not_offered'
  /** The registration takes no link: it is not `per_user`, or its server takes no authentication. */
  | 'nothing_to_link'
  /** A link is sent only with the caller's explicit consent. */
  | 'consent_required'
  /** The registration is not in the list the store holds. */
  | 'not_loaded'
  /** A change to the same registration is already being sent. */
  | 'write_in_flight'
  /** There is no page to return to or no way to leave it (no browser and no `onNavigate`). */
  | 'cannot_navigate'
  /** The service does not advertise `tools.facts`, or the tool's facts could not be read, so they are not replaced. */
  | 'facts_not_offered';

/**
 * What went wrong, derived from the status and the problem code and never from prose. API problems are returned, never
 * thrown. The kinds are the approvals module's, with `conflict` carrying the existing registration of a 409
 * `connection_exists` when the service named it.
 */
export type ConnectionsError = {
  /** The HTTP status when the error came from a response; absent for a local error. */
  readonly status?: number;
  readonly title: string;
  /** The `request_id` of the problem document, when there was one. */
  readonly requestId?: string;
  /** The problem document's `type` URI, verbatim; absent for an error raised locally. */
  readonly type?: string;
  /** The problem's `detail`, verbatim: for a 400 it names the member that was refused. */
  readonly detail?: string;
  /** The problem's `member` (rev 13), verbatim: a path into the request body, for example `facts.amount.path`. */
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
      /** On `connection_exists`: the existing registration, when the caller may read it. */
      readonly connectionId?: string;
    }
  | {
      /** A refusal the store gave without a request. */
      readonly kind: 'precondition';
      readonly code: ConnectionsPreconditionCode;
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

export type ConnectionsErrorKind = ConnectionsError['kind'];

export interface UseConnectionsOptions {
  readonly baseUrl: string;
  /** Called per request; `forceRefresh` asks for a new token after a 401. */
  readonly getToken: (x?: { forceRefresh?: boolean }) => string | Promise<string>;
  /** When false nothing is read and the status stays `idle`. Default true. */
  readonly enabled?: boolean;
  readonly fetch?: typeof fetch;
  readonly onSessionExpired?: () => void;
  /** As `UseApprovalsOptions.onFault`. */
  readonly onFault?: (fault: unknown) => void;
  /**
   * True says the user is not an administrator of the organisation, for a host that knows it: the store then offers
   * what a 403 would leave (no change to the organisation's registrations or credentials, and no registering where
   * only administrators register); a principal still registers and changes its own where the service lets it.
   */
  readonly readOnly?: boolean | undefined;
  /**
   * Where the browser returns after an OAuth consent: a page on an origin the service admits for browser modules.
   * Default: the current page, without the `nc_*` parameters.
   */
  readonly returnTo?: string | undefined;
  /** Sends the browser to the authorization URL. Default: `window.location.assign`. */
  readonly onNavigate?: ((url: string) => void) | undefined;
}

/**
 * `idle`: not started (or `enabled` is false). `loading`: reading. `ready`: the registrations are read. `unavailable`:
 * the service does not advertise the connections family (a neutral state, not an error). `error`: a read failed; no
 * list is shown, never an empty one in its place.
 */
export type ConnectionsStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

/** The `nc_error` codes of the contract's closed list. */
export type ConnectionReturnError =
  'consent_denied' | 'expired' | 'exchange_failed' | 'upstream_error';

/**
 * What the page was given back after an OAuth consent this browser started (`nc_*` parameters), read once and taken
 * out of the address. Parameters the store did not ask for (no authorization of this browser is waiting, its nonce or
 * its registration differs, or the registration is not in the list) give none: a crafted link shows nothing. Nothing
 * here is text from the address: the result is one of two values, and an error code outside the contract's closed
 * list is left out.
 */
export interface ConnectionReturn {
  readonly connectionId: string;
  readonly result: 'connected' | 'error';
  /** On an error: the code, when it is one of the contract's closed list. */
  readonly error?: ConnectionReturnError;
}

/** Whether the store offers registering and changing registrations, and why not. */
export interface ConnectionsAdministration {
  readonly readOnly: boolean;
  /** `host`: `readOnly` was passed. `forbidden`: the service refused this caller a registration or a change with 403. */
  readonly reason?: 'host' | 'forbidden';
}

/** What the store holds, without the actions. */
export interface ConnectionsSnapshot {
  readonly status: ConnectionsStatus;
  /**
   * With `error`: why. With `ready`: the list could not be read again after a change; the list shown is the one read
   * before, and the next successful read clears this.
   */
  readonly error?: ConnectionsError;
  readonly facts?: ConnectionsCapabilityFacts;
  readonly connections: readonly ConnectionInfo[];
  /** The ids of the registrations with a change in flight (`new` while a registration is being created). */
  readonly pending: ReadonlySet<string>;
  readonly administration: ConnectionsAdministration;
  /** The result of the last OAuth round trip, when the page was opened with one. */
  readonly lastReturn?: ConnectionReturn;
}

/** A new registration. No credential but the organisation credential of an `org_shared` bearer registration. */
export interface ConnectionCreateInput {
  readonly name: string;
  readonly url: string;
  /** `mcp` or `a2a`. */
  readonly transport: string;
  /** `org` or `principal`: the organisation's registration, or the caller's own. */
  readonly ownerKind: string;
  /** `none`, `bearer` or `oauth`. Absent: `none`. */
  readonly authKind?: string;
  /** For `oauth`: the scopes to ask for, the authorization server and the deployment's client there. */
  readonly oauth?: {
    readonly scopes?: readonly string[];
    readonly issuer?: string;
    readonly clientId?: string;
  };
  /** `org_shared` or `per_user` (administrators only). Absent: the service's default. */
  readonly credentialTier?: string;
  /** The organisation credential of an `org_shared` bearer registration (administrators only). Sent once, never kept. */
  readonly orgCredential?: string;
}

/** The outcome of a change to a registration. */
export type ConnectionWriteResult =
  | { readonly ok: true; readonly connection: ConnectionInfo }
  | { readonly ok: false; readonly error: ConnectionsError };

/** The outcome of a change that answers no registration (delete, unlink, revoking consent). */
export type ConnectionActionResult =
  { readonly ok: true } | { readonly ok: false; readonly error: ConnectionsError };

/** The outcome of replacing a tool's facts: the tool as the service now holds it. */
export type ToolFactsWriteResult =
  | { readonly ok: true; readonly tool: ConnectionToolInfo }
  | { readonly ok: false; readonly error: ConnectionsError };

/** What a refresh registered. */
export interface ConnectionRefreshCounts {
  readonly toolCount: number;
  readonly added: number;
  readonly removed: number;
  readonly reactivated: number;
  /** The server offered no tool at all, and the service kept the registered ones rather than withdraw them. */
  readonly emptyUpstreamSuppressed: boolean;
}

export type ConnectionRefreshResult =
  | { readonly ok: true; readonly counts: ConnectionRefreshCounts }
  | { readonly ok: false; readonly error: ConnectionsError };

/** The outcome of starting an OAuth round trip: the browser was sent to `url`, or nothing happened. */
export type ConnectionAuthorizeResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: ConnectionsError };

/** The caller's link: consent, always, and for a `bearer` server the credential (required on the first link). */
export interface ConnectionLinkInput {
  /** The caller's explicit consent to the use of its own link for its own calls. Only `true` is sent. */
  readonly consent: true;
  /** For a `bearer` server: the credential. Sent once, never kept. */
  readonly token?: string;
}

/** A tool the server offers now, a tool registered from it, or both, as one row of the comparison. */
export interface ConnectionToolRow {
  readonly toolRef: string;
  /** The registered tool, when there is one. */
  readonly registered?: ConnectionToolInfo;
  /** The tool as the server offers it now, when the last discover listed it. */
  readonly offered?: ConnectionToolInfo;
  /**
   * `registered`: registered and offered (or not compared yet). `offered`: offered and not registered (a refresh would
   * register it). `withdrawn`: registered, and no longer offered or `withdrawn`. `unknown_status`: registered with a
   * status this module does not know (kept as sent on `registered.status`), so not callable.
   */
  readonly standing: 'registered' | 'offered' | 'withdrawn' | 'unknown_status';
}

/** One registration's tools, as `useConnection` returns them. */
export interface ConnectionDetailSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly error?: ConnectionsError;
  /** The tools registered from it (`GET /v1/tools?connection=`). */
  readonly tools: readonly ConnectionToolInfo[];
  /** The last live enumeration (`discover`): `idle` until it is asked for. */
  readonly discovery: {
    readonly status: 'idle' | 'loading' | 'ready' | 'error';
    readonly tools: readonly ConnectionToolInfo[];
    readonly error?: ConnectionsError;
  };
  /** The registered and offered tools side by side; offered tools appear once `discover` has run. */
  readonly rows: readonly ConnectionToolRow[];
}

/** The headless view of one registration's tools. Reading starts on the first `subscribe`. */
export interface ConnectionDetailStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ConnectionDetailSnapshot;
  /** Reads the registered tools again. */
  reload(): Promise<void>;
  /** Asks the server what it offers now; registers nothing. */
  discover(): Promise<void>;
}

/** The store behind `useConnections`. Reading starts on the first `subscribe`; changes need no subscriber. */
export interface ConnectionsStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ConnectionsSnapshot;
  /** The constant snapshot for a server render: `idle`, nothing read. */
  getServerSnapshot(): ConnectionsSnapshot;
  /** Reads the capabilities and the registrations again. */
  reload(): Promise<void>;
  create(input: ConnectionCreateInput): Promise<ConnectionWriteResult>;
  rename(id: string, name: string): Promise<ConnectionWriteResult>;
  /** Deletes the registration: its tools become withdrawn and every user's link goes with it. */
  remove(id: string): Promise<ConnectionActionResult>;
  /** Registers what the server offers now (tools no longer offered become withdrawn). */
  refresh(id: string): Promise<ConnectionRefreshResult>;
  /**
   * Replaces the whole map of facts of a registered tool (`PATCH /v1/tools/{id}` with `{ facts }` alone); `null`
   * removes every fact. Refused without a request unless the service advertises `tools.facts`, the tool is in a list
   * the store holds and its facts were read, and the caller may change its registration. A refused fact comes back
   * as a `ConnectionsError` with its `member`.
   */
  updateToolFacts(toolId: string, facts: ToolFacts | null): Promise<ToolFactsWriteResult>;
  /** Rotates the organisation credential of an `org_shared` bearer registration. */
  rotateOrgCredential(id: string, token: string): Promise<ConnectionWriteResult>;
  /** Links the caller's own credential, with consent. */
  link(id: string, input: ConnectionLinkInput): Promise<ConnectionWriteResult>;
  /** Removes the caller's own link and its credential. */
  unlink(id: string): Promise<ConnectionActionResult>;
  /** Revokes the caller's consent to its own link, keeping the credential. */
  revokeConsent(id: string): Promise<ConnectionActionResult>;
  /**
   * Starts the OAuth round trip of the caller's own link (`per_user`) or of the organisation credential
   * (`org_shared`), and sends the browser to the authorization URL. It comes back to `returnTo`.
   */
  authorize(id: string): Promise<ConnectionAuthorizeResult>;
  /** The tools of `id`, one view per id for the life of the store. */
  detail(id: string): ConnectionDetailStore;
  /** Forgets the result of the last OAuth round trip (`lastReturn`). */
  dismissReturn(): void;
  /** Builds the snapshot again after an option it reads when it acts (`readOnly`) changed. */
  noteOptions(): void;
  dispose(): void;
}

/** What `useConnections` returns. */
export interface ConnectionsController extends ConnectionsSnapshot {
  reload(): Promise<void>;
  create: ConnectionsStore['create'];
  rename: ConnectionsStore['rename'];
  remove: ConnectionsStore['remove'];
  refresh: ConnectionsStore['refresh'];
  updateToolFacts: ConnectionsStore['updateToolFacts'];
  rotateOrgCredential: ConnectionsStore['rotateOrgCredential'];
  link: ConnectionsStore['link'];
  unlink: ConnectionsStore['unlink'];
  revokeConsent: ConnectionsStore['revokeConsent'];
  authorize: ConnectionsStore['authorize'];
  detail: ConnectionsStore['detail'];
  dismissReturn(): void;
}

/** What `useConnection` returns: one registration from the list, and its tools. */
export interface ConnectionController extends ConnectionDetailSnapshot {
  /** The registration, when the list holds it. */
  readonly connection?: ConnectionInfo;
  reload(): Promise<void>;
  discover(): Promise<void>;
}
