/**
 * The public types of the `action-status` module: what `useActionStatus` returns and what `<ActionStatus />`
 * renders. This file holds types only. A change here is a change to the module's public surface.
 */
import type { components } from '@noblecloak/client';

import type { ApprovalsConnection, ApprovalsError, NamedPrincipalRef } from './approvals-types.js';

/** The state of the approval, as the service gives it. */
export type ActionState = components['schemas']['ApprovalState'];

/** What a creator is told about who a pending approval waits on. */
export type PendingOn =
  | {
      /** The service named eligible approvers (a user creator): up to five, and `count` is the number it knows of. */
      readonly kind: 'principals';
      readonly count: number;
      readonly principals: readonly NamedPrincipalRef[];
    }
  | {
      /** Only the number of eligible approvers: what a service-principal creator is told. May be zero. */
      readonly kind: 'count';
      readonly count: number;
    }
  | {
      /** The service did not say (`waiting_on` is absent). It is shown as unknown, never as nobody. */
      readonly kind: 'unknown';
    };

/** What a denial does to the requester's run: the policy's `on_deny` as it stood at creation, or `not_stated`. */
export type OnDeny = 'resume' | 'halt' | 'not_stated';

/** Why the outcome of a consumed approval is not shown. */
export type OutcomeUnavailableReason =
  /** The approval names no outcome record (yet). */
  | 'no_record'
  /** The record read answered 403 (with a problem document or without one), for example because the caller lacks the records scope. */
  | 'forbidden'
  /** The record read answered 404 (with a problem document or without one). `retry()` reads it again. */
  | 'not_found'
  /** The record was read and states no `outcome` (the member is optional on a Record). It is not shown as a stated result. */
  | 'no_outcome'
  /** The session ended before the record could be read. */
  | 'unauthorized'
  /**
   * The record read failed in a way that may not repeat: no response, a server error, a rate limit, any other
   * failure status (a 408, a 400), or a 200 whose body is not JSON (a proxy's page). `retry()` reads it again.
   */
  | 'unavailable'
  /**
   * The record read answered 200 with JSON that is not a record for this approval that this version can read:
   * another record, one that names another approval, or an outcome status this version does not know. A record is
   * never changed, so the same read gives the same answer: no retry is offered, and it is reported through `onFault`.
   */
  | 'malformed';

/** What the outcome record said happened after the approval was consumed. */
export type ActionOutcomeResult = NonNullable<components['schemas']['Record']['outcome']>['status'];

/** The terminal outcome of a consumed approval: the record's id, what it says happened and when it was recorded. */
export type ActionOutcome =
  | { readonly status: 'loading'; readonly recordId: string }
  | {
      readonly status: 'recorded';
      readonly recordId: string;
      readonly result: ActionOutcomeResult;
      readonly recordedAt: string;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: OutcomeUnavailableReason;
      /** The record the approval names, when it names one. */
      readonly recordId?: string;
      /** Why the record read failed, with the service's request id when it sent one; absent when no read failed (`no_record`, `no_outcome`). */
      readonly error?: ApprovalsError;
    };

/** Why the status could not be read: the read's own failure, with the `kind` the approvals module uses. */
export type ActionStatusFailure =
  'not_found' | 'forbidden' | 'unauthorized' | 'unavailable' | 'error';

/** The status of one approval, as its creator sees it. */
export type ActionStatusState = { readonly approvalId: string } & (
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly state: ActionState;
      /** When the approval was created (an ISO 8601 time as the service sent it). */
      readonly since: string;
      /** Who a pending approval waits on; present only while `state` is `pending`. */
      readonly pendingOn?: PendingOn;
      readonly onDeny: OnDeny;
      /** The outcome of a consumed approval; present only when `state` is `consumed`. */
      readonly outcome?: ActionOutcome;
      /** True while the approval is being read again after a change. The last content stays. */
      readonly refreshing: boolean;
      /** True when no further change is expected and the live updates have stopped. A consumed approval whose outcome record could not be read is settled too; `retry()` reads it again. */
      readonly settled: boolean;
      /**
       * The live-update connection behind the status, in the approvals store's words (`ApprovalsConnection`):
       * `connecting`, `live` (the stream is up), `polling` (the stream is down and the list is read on `pollMs`) or
       * `offline`. A settled status is `offline`: its updates have stopped because nothing further can change.
       */
      readonly connection: ApprovalsConnection;
      /**
       * True when the status may be out of date: it is not settled, and the reads that would see a change (the
       * list, or the capabilities read before it) are failing, or the live updates have stopped (`offline`).
       * While one of those reads fails, the approvals store reads it again on the list's backoff; `retry()` starts
       * the run again at once. `connecting` is not out of date (every mount starts there), and neither is
       * `polling` while the list reads.
       */
      readonly stale: boolean;
    }
  | {
      readonly status: ActionStatusFailure;
      readonly error?: ApprovalsError;
    }
);

/** What `useActionStatus` returns: the status, and `retry`. */
export type ActionStatusController = ActionStatusState & {
  /** Reads again after a failure (or an outcome that could not be read), and starts the live updates of a `stale` status again; a status that is ready and has nothing to retry ignores it. */
  retry(): void;
};

/** What `useActionStatus` takes: the client and auth options of `useApprovals`, for the approval the caller created. */
export interface UseActionStatusOptions {
  readonly baseUrl: string;
  /** Called per request; `forceRefresh` asks for a new token after a 401. */
  readonly getToken: (x?: { forceRefresh?: boolean }) => string | Promise<string>;
  /** When false nothing is read and the status stays `loading`. Default true. */
  readonly enabled?: boolean;
  readonly fetch?: typeof fetch;
  /** The list interval while the stream is down; at least 1000, default 5000. */
  readonly pollMs?: number;
  /** The list interval while the stream is live; 0 means the default, else at least 5000; default 30000. */
  readonly reconcileMs?: number;
  readonly onSessionExpired?: () => void;
  /** As `UseApprovalsOptions.onFault`. */
  readonly onFault?: (fault: unknown) => void;
}

/** The headless store behind `useActionStatus`. */
export interface ActionStatusStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ActionStatusState;
  /** The constant snapshot for a server render: `loading`. */
  getServerSnapshot(): ActionStatusState;
  retry(): void;
  dispose(): void;
}
