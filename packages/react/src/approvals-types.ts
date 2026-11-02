/**
 * The public types of the approvals module: what the headless store and the hook return, and what the
 * component renders. This file holds types only. A change here is a change to the module's public surface.
 */
import type { components } from '@noblecloak/client';

/** The contract's `Approval`, as the API defines it (it alone may carry `arguments`). */
export type Approval = components['schemas']['Approval'];

/** The arguments of the call, a JSON object the API returns untrusted. */
export type JsonObject = NonNullable<Approval['arguments']>;

/**
 * An approval as the queue, the stream, a resolve response and an error hold it: the contract's
 * `Approval` without `arguments` and `continuation`, which only the single read of one approval returns. The only
 * approval type used outside a detail. `arguments?: never` makes the compiler reject an `Approval` that
 * still carries `arguments` (structural typing would otherwise let the wider object through), so an
 * ingest that forgets to strip them does not compile.
 */
/** A principal named inside an approval: `PrincipalRef` plus the `display_name` the service gave it. */
export type NamedPrincipalRef = components['schemas']['NamedPrincipalRef'];

export type ApprovalSummary = Omit<Approval, 'arguments' | 'continuation'> & {
  readonly arguments?: never;
  readonly continuation?: never;
};

/**
 * The codes of a 409 the module tells apart. `resolve_in_flight` is raised locally, when a resolve for the
 * same approval is already running; the API never returns it.
 */
export type ConflictCode =
  'approval_conflict' | 'already_resolved' | 'obligation_expired' | 'resolve_in_flight';

/**
 * What went wrong, derived from the status and the problem code and never from prose. API problems
 * are returned, never thrown. One member per `kind`, so `Extract<ApprovalsError, { kind: 'x' }>` finds it.
 * The fields every member has come first, written out here so that the type names nothing the package does
 * not export.
 */
export type ApprovalsError = {
  /** The HTTP status when the error came from a response; absent for a local error. */
  readonly status?: number;
  readonly title: string;
  /** The `request_id` of the problem document, when there was one. */
  readonly requestId?: string;
  /** The problem document's `type` URI, verbatim; absent for an error raised locally. */
  readonly type?: string;
  /**
   * The wait the server asked for, in milliseconds: the `Retry-After` header when the browser could read it, and
   * otherwise the problem body's `retry_after_seconds` (contract rev 6), which a browser can always read.
   */
  readonly retryAfterMs?: number;
  /**
   * The problem's `reason` token (contract rev 6), kept only on a 503 and only when it is a well-formed code.
   * `eligibility_lookup` means the service could not tell whether you may decide this request. A client treats
   * any other value as a plain 503.
   */
  readonly reason?: string;
  /** The exception behind a `network` error (code `network`, `client_error` or `token_unavailable`), for a bug report or a log; may be a host-thrown error — do not log blindly. */
  readonly cause?: unknown;
} & (
  | {
      readonly kind: 'conflict';
      /** A known `ConflictCode`, or the code of a 409 this version does not know (mapped by status). */
      readonly code: ConflictCode | (string & {});
      /** True when the store answered without a request. */
      readonly local?: true;
      /** The approval as re-read after a 409. A summary: it never carries arguments, which only a detail holds. */
      readonly current?: ApprovalSummary;
    }
  | {
      /** An action refused before any request: the open detail has not been read (see `ApprovalDetailState`). */
      readonly kind: 'precondition';
      readonly code: 'detail_not_read';
      readonly local: true;
    }
  | {
      /**
       * A response arrived but could not be read as the contract's shape: a 200 with a malformed body, or
       * an error response whose body is not JSON. A list that cannot be parsed surfaces as this error and
       * never as an empty `approvals`.
       */
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

export type ApprovalsErrorKind = ApprovalsError['kind'];

/** The reasons the single read gives for the arguments it shows or not (contract rev 6). Another value is kept as sent. */
export type ArgumentsState = NonNullable<Approval['arguments_state']> | (string & {});

/** What `approveMany` did to one request. A request that was not sent is answered locally, with no request. */
export type ManyItemResult =
  | { readonly id: string; readonly ok: true; readonly approval: ApprovalSummary }
  | { readonly id: string; readonly ok: false; readonly error: ApprovalsError };

/** What `approveMany` did: a result per request in the order asked, or the failure of the whole call. */
export type ManyResult =
  | { readonly ok: true; readonly results: readonly ManyItemResult[] }
  | { readonly ok: false; readonly error: ApprovalsError };

/** The recently resolved requests, shown beside the queue: loaded on demand, newest resolution first. */
export interface RecentState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly approvals: readonly ApprovalSummary[];
  /** True when the service has older ones than are shown. */
  readonly more: boolean;
  /** True while an older page is being read. */
  readonly loadingMore: boolean;
  readonly error?: ApprovalsError;
}

/** The one open approval, with the explicit states of its read. Actions are possible only in `loaded`. */
export type ApprovalDetailState = { readonly id: string } & (
  | { readonly status: 'loading' }
  | {
      readonly status: 'refreshing';
      readonly approval: ApprovalSummary;
      readonly arguments?: JsonObject;
      /**
       * The exact text of the response's `arguments` member, kept so a number can be shown as it was sent and a
       * repeated key can be told; absent when the arguments are.
       */
      readonly argumentsSource?: string;
    }
  | {
      readonly status: 'loaded';
      readonly approval: ApprovalSummary;
      readonly arguments?: JsonObject;
      /**
       * The exact text of the response's `arguments` member, kept so a number can be shown as it was sent and a
       * repeated key can be told; absent when the arguments are.
       */
      readonly argumentsSource?: string;
    }
  | {
      readonly status: 'resolved';
      readonly approval: ApprovalSummary;
      readonly arguments?: JsonObject;
      /**
       * The exact text of the response's `arguments` member, kept so a number can be shown as it was sent and a
       * repeated key can be told; absent when the arguments are.
       */
      readonly argumentsSource?: string;
    }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'unavailable';
      readonly error: Extract<ApprovalsError, { kind: 'unavailable' }>;
      readonly retryingInMs?: number;
    }
  | {
      readonly status: 'forbidden';
      readonly error: Extract<ApprovalsError, { kind: 'forbidden' }>;
    }
  | {
      readonly status: 'unauthorized';
      readonly error: Extract<ApprovalsError, { kind: 'unauthorized' }>;
    }
  | { readonly status: 'error'; readonly error: ApprovalsError }
);

export type ApprovalDetailStatus = ApprovalDetailState['status'];

export type ResolveResult =
  | { readonly ok: true; readonly approval: ApprovalSummary }
  | { readonly ok: false; readonly error: ApprovalsError };

export interface UseApprovalsOptions {
  readonly baseUrl: string;
  /** Called per request; `forceRefresh` asks for a new token after a 401. */
  readonly getToken: (x?: { forceRefresh?: boolean }) => string | Promise<string>;
  readonly scope?: string;
  readonly enabled?: boolean;
  readonly fetch?: typeof fetch;
  /** The list interval while the stream is down; at least 1000, default 5000. */
  readonly pollMs?: number;
  /** The list interval while the stream is live; 0 means the default, else at least 5000; default 30000. */
  readonly reconcileMs?: number;
  readonly onSessionExpired?: () => void;
  /**
   * Called with a fault in a subscriber or in event handling (a listener or `onSessionExpired` that threw, a
   * stream event that could not be applied, a bug in the store's own work, a `fetch` that threw something
   * other than a failed request). Without it the fault is reported like an uncaught exception (`reportError`)
   * where the runtime has one, and written to `console.error` as `name: message` otherwise. With it, only this
   * is called, unless it throws: then the fault is reported as it would be without it. `useApprovals` reads it at
   * the time of the fault, so adding or removing it after the first render takes effect.
   */
  readonly onFault?: (fault: unknown) => void;
}

export type ApprovalsStatus = 'idle' | 'loading' | 'ready' | 'error';
export type ApprovalsConnection = 'connecting' | 'live' | 'polling' | 'offline';

/** What a store holds and a hook returns, without the actions. */
export interface ApprovalsSnapshot {
  /** Queue rows: never carry `arguments`. */
  readonly approvals: readonly ApprovalSummary[];
  readonly status: ApprovalsStatus;
  readonly error?: ApprovalsError;
  readonly connection: ApprovalsConnection;
  /** True when the list has more than the first page. */
  readonly truncated: boolean;
  /** The ids with a resolve in flight. */
  readonly resolving: ReadonlySet<string>;
  /** The one open approval, if any. */
  readonly detail?: ApprovalDetailState;
  /** The recently resolved requests (contract rev 6); absent from a controller that predates them. */
  readonly recent?: RecentState;
}

export interface ResolveOptions {
  readonly reason?: string;
}

/** What `useApprovals` returns, and what `<Approvals controller={...}/>` takes. */
export interface ApprovalsController extends ApprovalsSnapshot {
  refresh(): Promise<void>;
  openDetail(id: string): void;
  closeDetail(): void;
  retryDetail(): void;
  approve(id: string, options?: ResolveOptions): Promise<ResolveResult>;
  deny(id: string, options?: ResolveOptions): Promise<ResolveResult>;
  /** Shows more of the queue (the next page, up to the 200 the service returns at once). Optional: older controllers have none. */
  loadMore?(): Promise<void>;
  /** Reads the first page of the recently resolved requests; a read already running is not repeated. */
  loadRecent?(): Promise<void>;
  /** Reads the next, older page of the recently resolved requests. */
  loadMoreRecent?(): Promise<void>;
  /**
   * Approves each of `ids` as the queue lists it, in one call to the batch route, with the digest each row
   * showed (a request that changed meanwhile conflicts instead of being approved). It opens no detail: use
   * it for requests the person chose from the queue, and `approve` for one they read. Only a row whose
   * `arguments_state` is `not_enabled` or `not_sent` is sent; any other answers `precondition`. `shown` is required: each
   * id's digest as the person saw it when they confirmed. A row whose digest is now another, or that has no entry,
   * answers `conflict` and is not sent.
   */
  approveMany?(ids: readonly string[], shown: ReadonlyMap<string, string>): Promise<ManyResult>;
}

/**
 * The store behind the hook. `resolve` is the lower-level call `approve` and `deny` delegate to. Each of
 * the three checks, in this order and with no request on a refusal:
 * 1. a resolve already in flight for the id: `conflict` with `resolve_in_flight` (local);
 * 2. the approval already resolved: `conflict` with `already_resolved` (local);
 * 3. the detail gate: `precondition` with `detail_not_read` (local), unless `detail.id === id` and the
 *    detail is `loaded` and pending.
 */
export interface ApprovalsStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ApprovalsSnapshot;
  /** The constant snapshot for a server render: `idle`, no approvals, `offline`. */
  getServerSnapshot(): ApprovalsSnapshot;
  refresh(): Promise<void>;
  openDetail(id: string): void;
  closeDetail(): void;
  retryDetail(): void;
  approve(id: string, options?: ResolveOptions): Promise<ResolveResult>;
  deny(id: string, options?: ResolveOptions): Promise<ResolveResult>;
  loadMore(): Promise<void>;
  loadRecent(): Promise<void>;
  loadMoreRecent(): Promise<void>;
  approveMany(ids: readonly string[], shown: ReadonlyMap<string, string>): Promise<ManyResult>;
  resolve(
    id: string,
    options: ResolveOptions & {
      readonly resolution: Exclude<components['schemas']['ResolveResolution'], 'escalated'>;
      /** A test seam: the digest sent defaults to the open detail's. `approve`, `deny` and the hook never take it. */
      readonly expectedActionDigest?: string;
    }
  ): Promise<ResolveResult>;
  dispose(): void;
}

/** What `useApprovalRequest` takes: the client and auth options of `useApprovals`, for the one request. */
export interface UseApprovalRequestOptions {
  readonly baseUrl: string;
  /** Called per request; `forceRefresh` asks for a new token after a 401. */
  readonly getToken: (x?: { forceRefresh?: boolean }) => string | Promise<string>;
  /** When false nothing is read and the state stays `loading`. Default true. */
  readonly enabled?: boolean;
  readonly fetch?: typeof fetch;
  readonly onSessionExpired?: () => void;
  /** As `UseApprovalsOptions.onFault`. */
  readonly onFault?: (fault: unknown) => void;
}

/**
 * What `useApprovalRequest` returns: the read of one approval as the same `ApprovalDetailState` the queue's
 * detail holds, plus `retry`. Read-only: the request is not decided from here (use `useApprovals`).
 */
export type ApprovalRequestController = ApprovalDetailState & {
  /** Reads the request again after `unavailable`, `error`, `forbidden` or `unauthorized`; any other state ignores it. */
  retry(): void;
};

/** The headless store behind `useApprovalRequest`. */
export interface ApprovalRequestStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ApprovalDetailState;
  /** The constant snapshot for a server render: `loading`. */
  getServerSnapshot(): ApprovalDetailState;
  retry(): void;
  dispose(): void;
}
