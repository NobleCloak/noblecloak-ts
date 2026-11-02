/**
 * The headless store behind `useActionStatus`: the status of one approval as its creator sees it. It is the
 * approvals store in its `creator` audience (the same capabilities read, SSE stream with long-poll fallback, lists
 * and single detail read; the stream and the lists are narrowed with `created_by=me`) with the approval opened as
 * its detail, and a view over that detail. `waiting_on` is the single read's alone, so a stream event for this
 * approval makes the store read the detail again, and only while the approval is pending. Once the approval is
 * consumed it reads the outcome record `outcome_record_id` names (`GET /v1/records/{id}`), and exposes only that
 * record's id, outcome and time. When nothing further can change (a refused, expired or withdrawn approval, or a
 * consumed one whose outcome is read or cannot be; a gone approval, a deployment that does not serve this reader,
 * or an approval reply this version cannot read) it stops the stream and the polls, and `retry()` starts them again.
 * Constructing it does nothing; the work starts on the first `subscribe` and stops on the last unsubscribe.
 */
import type {
  ActionOutcome,
  ActionOutcomeResult,
  ActionState,
  ActionStatusState,
  ActionStatusStore,
  OnDeny,
  OutcomeUnavailableReason,
  PendingOn,
  UseActionStatusOptions,
} from './action-status-types.js';
import { createApprovalsStoreFor } from './approvals-store.js';
import { malformed } from './approvals-errors.js';
import { createExec, jsonOf } from './approvals-exec.js';
import type {
  Approval,
  ApprovalDetailState,
  ApprovalsConnection,
  ApprovalsError,
  ApprovalsStore,
} from './approvals-types.js';
import { reportFault as reportUnhandled } from './fault.js';

const loadingOf = (approvalId: string): ActionStatusState =>
  Object.freeze({ approvalId, status: 'loading' as const });

/** States after which the approval changes no more. `approved` is not one: it waits to be consumed. */
const FINAL_STATES: ReadonlySet<ActionState> = new Set([
  'rejected',
  'consumed',
  'expired',
  'withdrawn',
]);

/** A function, so the check after an `await` is not narrowed away by the one before it. */
const isAborted = (signal: AbortSignal): boolean => signal.aborted;

const RESULTS: ReadonlySet<string> = new Set(['succeeded', 'failed', 'unknown']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the service said a denial does; anything but the two words it defines is not a statement. */
export function onDenyOf(approval: Pick<Approval, 'on_deny'>): OnDeny {
  const value: unknown = approval.on_deny;
  return value === 'resume' || value === 'halt' ? value : 'not_stated';
}

/** Who a pending approval waits on, from the single read's `waiting_on`; absent is unknown, never nobody. */
export function pendingOnOf(approval: Pick<Approval, 'waiting_on'>): PendingOn {
  const waiting = approval.waiting_on;
  if (waiting === undefined) return { kind: 'unknown' };
  const principals = waiting.principals;
  if (principals !== undefined && principals.length > 0) {
    return { kind: 'principals', count: waiting.count, principals };
  }
  return { kind: 'count', count: waiting.count };
}

/** The part of a record this module reads: `undefined` when the value is not a record for `recordId`. */
function recordedOf(
  value: unknown,
  recordId: string,
  approvalId: string
): Extract<ActionOutcome, { status: 'recorded' | 'unavailable' }> | undefined {
  const body = isObject(value) && isObject(value.data) ? value.data : value;
  if (!isObject(body) || body.id !== recordId || typeof body.ts !== 'string') return undefined;
  // A record that names another approval is not this approval's outcome.
  if (body.approval_id !== undefined && body.approval_id !== approvalId) return undefined;
  // A record with no `outcome` (optional on a Record) states nothing: not an `unknown` result, which is a stated one.
  if (body.outcome === undefined) return { status: 'unavailable', reason: 'no_outcome', recordId };
  if (!isObject(body.outcome)) return undefined;
  const status = body.outcome.status;
  if (typeof status !== 'string' || !RESULTS.has(status)) return undefined;
  return {
    status: 'recorded',
    recordId,
    result: status as ActionOutcomeResult,
    recordedAt: body.ts,
  };
}

type ReadyView = Extract<ActionStatusState, { status: 'ready' }>;

interface RecordRead {
  readonly recordId: string;
  readonly outcome: ActionOutcome;
}

export function createActionStatusStore(
  approvalId: string,
  options: UseActionStatusOptions
): ActionStatusStore {
  const enabled = options.enabled !== false;
  const loading = loadingOf(approvalId);
  const listeners = new Set<() => void>();
  let snapshot: ActionStatusState = loading;
  let running = false;
  let attached = false;
  /** The open detail as the approvals store last held it; kept after the store is stopped, because the view is derived from it. */
  let lastDetail: ApprovalDetailState | undefined;
  /** The error the approvals store's run ended in, as it last held it; cleared when the run starts again. */
  let lastRunError: ApprovalsError | undefined;
  /** The approvals store's connection, and whether it holds a failure (a list or capabilities read it is retrying), as it last held them. */
  let lastConnection: ApprovalsConnection = 'connecting';
  let lastFailing = false;
  /** Whether that error ended the approvals store's run (it is `error` and `offline`): nothing retries it until `refresh()`. */
  let lastRunEnded = false;
  let disposed = false;
  let detachQueued = false;
  let life: AbortController | undefined;
  let record: RecordRead | undefined;
  let recordSeq = 0;

  const reportFault = (fault: unknown): void => {
    if (options.onFault === undefined) reportUnhandled(fault);
    else {
      try {
        options.onFault(fault);
      } catch {
        // A fault handler that throws must not lose the fault: report it as the default would.
        reportUnhandled(fault);
      }
    }
  };

  const inner: ApprovalsStore = createApprovalsStoreFor('creator', {
    baseUrl: options.baseUrl,
    getToken: options.getToken,
    enabled,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.reconcileMs === undefined ? {} : { reconcileMs: options.reconcileMs }),
    ...(options.onSessionExpired === undefined
      ? {}
      : { onSessionExpired: options.onSessionExpired }),
    onFault: reportFault,
  });
  const exec = createExec(options, reportFault);
  let innerUnsubscribe: (() => void) | undefined;

  /** The error a ready view's outcome carries, which may hold anything (a host's thrown value as its `cause`). */
  const outcomeErrorOf = (view: ReadyView): ApprovalsError | undefined =>
    view.outcome?.status === 'unavailable' ? view.outcome.error : undefined;

  /** A ready view without its outcome's error: what is left came from parsed JSON and the store's own values. */
  const withoutOutcomeError = (view: ReadyView): unknown =>
    view.outcome?.status === 'unavailable' && view.outcome.error !== undefined
      ? { ...view, outcome: { ...view.outcome, error: undefined } }
      : view;

  /**
   * Whether `a` and `b` show the same thing. It never throws: an error, which may hold anything, is compared by
   * identity and never serialized, and a view that cannot be compared counts as changed.
   */
  const sameView = (a: ActionStatusState, b: ActionStatusState): boolean => {
    if (a.status === 'ready' && b.status === 'ready') {
      if (outcomeErrorOf(a) !== outcomeErrorOf(b)) return false;
      try {
        return JSON.stringify(withoutOutcomeError(a)) === JSON.stringify(withoutOutcomeError(b));
      } catch {
        return false;
      }
    }
    return (
      a.status === b.status &&
      a.status !== 'ready' &&
      a.approvalId === b.approvalId &&
      (a as { error?: unknown }).error === (b as { error?: unknown }).error
    );
  };

  function outcomeOf(approval: Approval): ActionOutcome {
    const recordId = approval.outcome_record_id;
    if (typeof recordId !== 'string' || recordId === '') {
      return { status: 'unavailable', reason: 'no_record' };
    }
    return record?.recordId === recordId ? record.outcome : { status: 'loading', recordId };
  }

  function viewOf(detail: ApprovalDetailState | undefined): ActionStatusState {
    if (detail?.id !== approvalId) return loading;
    switch (detail.status) {
      case 'loading':
        return loading;
      case 'not_found':
        return { approvalId, status: 'not_found' };
      case 'forbidden':
      case 'unauthorized':
      case 'unavailable':
      case 'error':
        return { approvalId, status: detail.status, error: detail.error };
      case 'loaded':
      case 'refreshing':
      case 'resolved': {
        const approval = detail.approval;
        const state = approval.state;
        const outcome = state === 'consumed' ? outcomeOf(approval) : undefined;
        const settled =
          FINAL_STATES.has(state) && (outcome === undefined || outcomeSettled(outcome));
        // A settled status stops its updates, so it says offline. An unsettled one is out of date while its run has
        // ended (offline) or the reads that would see a change are failing; `connecting` is not, or every mount would
        // say so before its stream is up.
        const connection: ApprovalsConnection = settled ? 'offline' : lastConnection;
        const stale = !settled && (connection === 'offline' || lastFailing);
        return {
          approvalId,
          status: 'ready',
          state,
          since: approval.created_at,
          ...(state === 'pending' ? { pendingOn: pendingOnOf(approval) } : {}),
          onDeny: onDenyOf(approval),
          ...(outcome === undefined ? {} : { outcome }),
          refreshing: detail.status === 'refreshing',
          settled,
          connection,
          stale,
        };
      }
    }
  }

  /** An outcome nothing will change by listening: read, or refused. A missing record may still be linked; a failed read is retried by hand. */
  const outcomeSettled = (outcome: ActionOutcome): boolean =>
    outcome.status === 'recorded' ||
    (outcome.status === 'unavailable' && outcome.reason !== 'no_record');

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (fault) {
        reportFault(fault);
      }
    }
  }

  /** Derives the view from the open detail, starts the outcome read it calls for, and publishes a changed view. */
  function recompute(): void {
    if (!running) return;
    if (attached) {
      const held = inner.getSnapshot();
      lastDetail = held.detail;
      lastRunError = held.status === 'error' ? held.error : undefined;
      lastConnection = held.connection;
      lastFailing = held.error !== undefined;
      // A list that fails keeps the run and its connection; only the end of a run takes the connection offline.
      lastRunEnded = held.status === 'error' && held.connection === 'offline';
    }
    const detail = lastDetail;
    let next = detail === undefined ? snapshot : viewOf(detail);
    if (
      detail !== undefined &&
      (detail.status === 'loaded' || detail.status === 'refreshing' || detail.status === 'resolved')
    ) {
      const recordId = detail.approval.outcome_record_id;
      if (
        detail.approval.state === 'consumed' &&
        typeof recordId === 'string' &&
        recordId !== '' &&
        record?.recordId !== recordId
      ) {
        startRecordRead(recordId);
        next = viewOf(detail);
      }
    }
    next = withRunError(next);
    publish(next);
    if (attached && isFinal(next)) queueDetach();
  }

  /**
   * A view that no stream event or list can change: a settled one, a gone approval (`not_found`), a deployment that
   * does not serve this reader (`unsupported`), or a detail read whose reply this version cannot read
   * (`malformed_response`, not a run that ended). Its stream and polls stop; `retry()` starts them again.
   */
  function isFinal(view: ActionStatusState): boolean {
    if (view.status === 'ready') return view.settled;
    if (view.status === 'not_found') return true;
    if (view.status !== 'error') return false;
    const kind = view.error?.kind;
    return kind === 'unsupported' || (kind === 'malformed_response' && !lastRunEnded);
  }

  /**
   * The run's own end outranks a detail that was read before it. A deployment that does not serve approvals to
   * this reader (`unsupported`: DPoP required, no resolutions, or no approvals family) is `error`, and nothing
   * retries it. A session that ended on the stream or a list (`unauthorized`) leaves the detail as it was, but the
   * live updates have stopped, so it is `unauthorized` until `retry()` starts them again. Any other end of the run
   * (a fault in the run itself, `internal_error`) stops the live updates the same way, so it is `error` with that
   * cause until `retry()` starts the run again. A settled view is final and stays. A list that fails without
   * ending the run leaves the view `ready` and `stale`.
   */
  function withRunError(view: ActionStatusState): ActionStatusState {
    const cause = lastRunError;
    if (cause === undefined) return view;
    if (cause.kind === 'unsupported') return { approvalId, status: 'error', error: cause };
    if (view.status === 'ready' && view.settled) return view;
    if (cause.kind === 'unauthorized') return { approvalId, status: 'unauthorized', error: cause };
    if (lastRunEnded) return { approvalId, status: 'error', error: cause };
    return view;
  }

  function publish(next: ActionStatusState): void {
    if (sameView(snapshot, next)) return;
    snapshot = next;
    notify();
  }

  // The approvals store is told to stop from outside its own notification, so it never stops inside a commit.
  function queueDetach(): void {
    if (detachQueued) return;
    detachQueued = true;
    queueMicrotask(() => {
      detachQueued = false;
      if (running && isFinal(snapshot)) detach();
    });
  }

  function attach(): void {
    if (attached || !enabled) return;
    // Set first: the approvals store notifies while `subscribe` runs.
    attached = true;
    innerUnsubscribe = inner.subscribe(recompute);
    inner.openDetail(approvalId);
  }

  function detach(): void {
    const unsubscribe = innerUnsubscribe;
    innerUnsubscribe = undefined;
    attached = false;
    unsubscribe?.();
  }

  function setRecord(recordId: string, outcome: ActionOutcome): void {
    record = { recordId, outcome };
  }

  function startRecordRead(recordId: string): void {
    readRecord(recordId).catch(reportFault);
  }

  async function readRecord(recordId: string): Promise<void> {
    const signal = life?.signal;
    if (signal === undefined || signal.aborted) return;
    recordSeq += 1;
    const seq = recordSeq;
    setRecord(recordId, { status: 'loading', recordId });
    const reply = await exec(signal, (c) =>
      c.GET('/v1/records/{id}', { params: { path: { id: recordId } }, parseAs: 'text', signal })
    );
    if (reply.kind === 'aborted' || seq !== recordSeq || isAborted(signal)) return;
    let outcome: ActionOutcome;
    if (reply.kind === 'ok') {
      const body = jsonOf(reply);
      const recorded = body === undefined ? undefined : recordedOf(body, recordId, approvalId);
      if (body === undefined) {
        // A 200 that is not JSON (a proxy's page, a cut-off body) is not the record's answer: it may read on retry.
        outcome = {
          status: 'unavailable',
          reason: 'unavailable',
          recordId,
          error: malformed(200, 'an outcome record'),
        };
      } else if (recorded === undefined) {
        // A body that parsed but is not this approval's record: a record is never changed, so it gives this again.
        const error = malformed(200, 'an outcome record');
        reportFault(error);
        outcome = { status: 'unavailable', reason: 'malformed', recordId, error };
      } else outcome = recorded;
    } else {
      outcome = {
        status: 'unavailable',
        reason: reasonOf(reply.error),
        recordId,
        error: reply.error,
      };
      if (reply.error.kind === 'unauthorized') {
        try {
          options.onSessionExpired?.();
        } catch (fault) {
          reportFault(fault);
        }
      }
    }
    setRecord(recordId, outcome);
    recompute();
  }

  /**
   * The reason a failed record read gives. Only a parsed 200 that is not this approval's record is `malformed`; a
   * failure status is not the record's answer, so anything but a refusal, a gone record or an ended session (a
   * 403 or 404 whose body is not a problem document included) is `unavailable`, which `retry()` reads again.
   */
  function reasonOf(error: ApprovalsError): OutcomeUnavailableReason {
    const kind = error.kind;
    if (kind === 'forbidden' || kind === 'not_found' || kind === 'unauthorized') return kind;
    if (kind === 'malformed_response' && error.status === 403) return 'forbidden';
    if (kind === 'malformed_response' && error.status === 404) return 'not_found';
    return 'unavailable';
  }

  function start(): void {
    running = true;
    life = new AbortController();
    record = undefined;
    lastDetail = undefined;
    lastRunError = undefined;
    lastConnection = 'connecting';
    lastFailing = false;
    lastRunEnded = false;
    snapshot = loading;
    attach();
  }

  /** Starts the reads of a view that stopped them, from a fresh open of the approval. */
  function restart(): void {
    recordSeq += 1;
    record = undefined;
    lastDetail = undefined;
    lastRunError = undefined;
    lastRunEnded = false;
    publish(loading);
    attach();
  }

  function stop(): void {
    running = false;
    detach();
    life?.abort();
    life = undefined;
    recordSeq += 1;
    record = undefined;
    lastDetail = undefined;
    lastRunError = undefined;
    snapshot = loading;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && !running && !disposed) start();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => loading,
    retry() {
      if (!running) return;
      const current = snapshot;
      if (current.status === 'ready') {
        // Live updates that are down or failing: start them again now rather than on the store's backoff.
        if (current.stale) {
          void inner.refresh();
          return;
        }
        const outcome = current.outcome;
        // A record is never changed: re-reading one that states no outcome, or that this version cannot read, cannot change it.
        if (
          outcome?.status === 'unavailable' &&
          outcome.recordId !== undefined &&
          outcome.reason !== 'no_outcome' &&
          outcome.reason !== 'malformed'
        ) {
          startRecordRead(outcome.recordId);
          // The read is under way: show it, so the Try again control does not look dead.
          recompute();
        }
        return;
      }
      // A view that stops its reads (gone, unsupported, unreadable), stopped or about to: read it afresh. The
      // detach it queued then finds a view that is loading, and leaves it.
      if (!attached || isFinal(current)) {
        detach();
        restart();
        return;
      }
      // A run that ended (a lost session, or a fault in the run) or a list that is failing: start the run again.
      // `refresh()` also re-reads a detail the lost session left `unauthorized`.
      const runOver =
        current.status === 'unauthorized' ||
        (lastRunError !== undefined && lastRunError.kind !== 'unsupported');
      if (runOver) void inner.refresh();
      const detail = lastDetail?.status;
      if (detail === 'unavailable' || detail === 'error' || detail === 'forbidden') {
        inner.retryDetail();
      }
    },
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      listeners.clear();
      inner.dispose();
    },
  };
}
