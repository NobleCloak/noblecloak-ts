/**
 * The headless approvals store: all of the module's behaviour, in plain TypeScript, with no React, no
 * `window`, `document`, storage or `crypto.subtle`. `useApprovals` binds it with `useSyncExternalStore`.
 *
 * The list is the truth and the stream a hint (tombstones and suppressions keep a lagging list from
 * reviving a decided approval); `arguments` live only in the one open detail, read from the single route.
 * Constructing a store does nothing: work starts on the first `subscribe` and stops on the last
 * unsubscribe, so a StrictMode double mount and a server render are safe.
 */
import { batchBlock } from './approvals-batch.js';
import {
  detailNotRead,
  errorFromResponse,
  internalError,
  localConflict,
  makeError,
  malformed,
  networkError,
} from './approvals-errors.js';
import {
  approvalOf,
  approvalPageOf,
  capabilitiesOf,
  createFrameReader,
} from './approvals-parse.js';
import type { ApprovalPage } from './approvals-parse.js';
import { createExec, jsonOf } from './approvals-exec.js';
import { createDetailReader, toSummary } from './approvals-detail.js';
import { after, cancel, clearAll, createBackoff } from './approvals-timing.js';
import type { Backoff, Timer } from './approvals-timing.js';
import type {
  Approval,
  ApprovalSummary,
  ApprovalsConnection,
  ApprovalsError,
  ApprovalsSnapshot,
  ApprovalsStatus,
  ApprovalsStore,
  ManyItemResult,
  ManyResult,
  RecentState,
  ResolveOptions,
  ResolveResult,
  UseApprovalsOptions,
} from './approvals-types.js';
import { reportFault as reportUnhandled } from './fault.js';

const LIST_FLOOR_MS = 1000;
const DEBOUNCE_MS = 250;
const DEBOUNCE_MAX_WAIT_MS = 2000;
const HEALTHY_STREAM_MS = 10_000;
const WATCHDOG_MS = 45_000;
const BLOCKED_STREAM_MS = 30_000;
const SUPPRESS_MS = 30_000;
const TOMBSTONE_CAP = 500;
const EXPIRY_GRACE_MS = 1000;
/** The largest delay setTimeout honours (2^31-1 ms, about 24.8 days); a larger one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_POLL_MS = 5000;
const POLL_FLOOR_MS = 1000;
const DEFAULT_RECONCILE_MS = 30_000;
const RECONCILE_FLOOR_MS = 5000;
const PAGE_SIZE = 50;
/** The most the list returns at once (`limit` is at most 200): "show more" grows the page to this. */
const MAX_PAGE = 200;
/** The batch route takes at most 100 elements; hosted accepts 50, so a larger selection is sent in calls of this size. */
const BATCH_SIZE = 50;

/** The snapshot of a server render and of a store that is switched off: idle, empty, offline. */
const IDLE: ApprovalsSnapshot = Object.freeze({
  approvals: Object.freeze([] as ApprovalSummary[]),
  status: 'idle',
  connection: 'offline',
  truncated: false,
  resolving: new Set<string>(),
});

/** The one member of the caller's options that `approve` and `deny` pass on. */
const reasonOf = (o: ResolveOptions | undefined): ResolveOptions =>
  o?.reason === undefined ? {} : { reason: o.reason };

interface ListState {
  inflight: boolean;
  queued: boolean;
  lastStart: number;
  floor: Timer | undefined;
  debounce: Timer | undefined;
  debounceFirst: number;
  periodic: Timer | undefined;
  expiry: Timer | undefined;
  /** Until when a failed list's backoff holds; `requestList` starts no list before it, and the held periodic timer is the next attempt. */
  holdUntil: number;
}

/** One start of the work: capabilities, the stream and the lists. A refresh ends a run and begins another. */
interface Run {
  readonly ac: AbortController;
  readonly timers: Set<Timer>;
  readonly list: ListState;
  readonly listBackoff: Backoff;
  readonly streamBackoff: Backoff;
  /** Ids a pending event asked a re-list for: id to the stamp of the newest list at the time. */
  readonly awaiting: Map<string, number>;
  /** Ids a later list still left out beyond the first page; no new re-list until the next reconcile. */
  readonly beyondPage: Set<string>;
  readonly expiryDone: Set<string>;
  /**
   * Whether the stream is opened with `approver=me` (contract rev 6), to cut the events a person cannot act on.
   * It is a hint to the service only: an event never enters the queue by itself (the list decides). A service that
   * answers 400 to the parameter is a rev 5 one: the stream is opened without it.
   */
  streamFiltered: boolean;
  readonly done: () => void;
}

/**
 * Whose queue a store holds. `approver` (what `useApprovals` builds) lists and streams the approvals the caller may
 * resolve (`approver=me`). `creator` (what `useActionStatus` builds on) lists and streams the approvals the caller
 * created (`created_by=me`), because a creator is never an approver and `approver=me` would show it none of them. Both
 * run the same machinery (capabilities, the stream, the lists, the open detail); a creator store also reads again an
 * open approval that has left its pending list or is approved and not yet consumed (`catchUpCreator`).
 */
export type Audience = 'approver' | 'creator';

/**
 * The headless approvals store behind `useApprovals`: subscribe to it (or use the hook) to start the queue, the
 * stream and the polling, and call `openDetail`, `approve` and `deny` on it. Nothing runs until the first subscriber.
 */
export function createApprovalsStore(options: UseApprovalsOptions): ApprovalsStore {
  return createApprovalsStoreFor('approver', options);
}

const hasOutcomeRecord = (approval: Pick<Approval, 'outcome_record_id'>): boolean =>
  typeof approval.outcome_record_id === 'string' && approval.outcome_record_id !== '';

/** `createApprovalsStore` for the given audience. Not exported from any package entry. */
export function createApprovalsStoreFor(
  audience: Audience,
  options: UseApprovalsOptions
): ApprovalsStore {
  /**
   * A fault in a subscriber or in event handling goes to `onFault` when the host gave one, and otherwise is
   * reported like an uncaught exception where the runtime has `reportError`. It never ends the stream.
   */
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
  const enabled = options.enabled !== false;
  const pollMs = Math.max(
    POLL_FLOOR_MS,
    typeof options.pollMs === 'number' && Number.isFinite(options.pollMs)
      ? options.pollMs
      : DEFAULT_POLL_MS
  );
  const reconcileMs =
    options.reconcileMs === undefined ||
    !Number.isFinite(options.reconcileMs) ||
    options.reconcileMs === 0
      ? DEFAULT_RECONCILE_MS
      : Math.max(RECONCILE_FLOOR_MS, options.reconcileMs);

  const listeners = new Set<() => void>();
  let started = false;
  let disposed = false;
  let life: AbortController | undefined;
  let run: Run | undefined;
  let expiredFired = false;
  const neverAborted = new AbortController().signal;

  // What the snapshot is made of.
  let queue: readonly ApprovalSummary[] = [];
  let status: ApprovalsStatus = enabled ? 'loading' : 'idle';
  let error: ApprovalsError | undefined;
  let connection: ApprovalsConnection = enabled ? 'connecting' : 'offline';
  let truncated = false;
  const resolving = new Map<string, { resolution: string; promise: Promise<ResolveResult> }>();
  /** How many rows the list asks for: `PAGE_SIZE`, grown by `loadMore` up to `MAX_PAGE`. */
  let pageLimit = PAGE_SIZE;
  /** The recently resolved requests, once `loadRecent` has been called; and the cursor of their next page. */
  let recent: RecentState | undefined;
  let recentNext: string | undefined;
  /** Counts each fresh read of the recent list, so a reply to an older one is dropped. */
  let recentSeq = 0;

  // Reconciliation memory.
  let stamp = 0;
  const tombstones = new Map<string, number>();
  const suppressed = new Map<string, number>();

  const exec = createExec(options, reportFault);
  const reader = createDetailReader({
    exec,
    signal: () => life?.signal,
    active: () => active(),
    commit: () => {
      commit();
    },
    reportFault,
    onRead: (summary) => {
      reconcileRow(summary);
    },
    onGone: (id) => {
      tombstone(id);
    },
    onUnauthorized: (cause) => {
      expireSession(cause);
    },
  });

  let snapshot: ApprovalsSnapshot = enabled
    ? {
        approvals: queue,
        status,
        connection,
        truncated,
        resolving: new Set<string>(),
      }
    : IDLE;

  // ---------------------------------------------------------------------------------------- snapshot

  const sameKeys = (a: ReadonlySet<string>, b: ReadonlyMap<string, unknown>): boolean =>
    a.size === b.size && [...a].every((k) => b.has(k));

  function commit(): void {
    if (
      snapshot.approvals === queue &&
      snapshot.status === status &&
      snapshot.error === error &&
      snapshot.connection === connection &&
      snapshot.truncated === truncated &&
      snapshot.detail === reader.state() &&
      snapshot.recent === recent &&
      sameKeys(snapshot.resolving, resolving)
    ) {
      return;
    }
    const openDetail = reader.state();
    snapshot = {
      approvals: queue,
      status,
      ...(error === undefined ? {} : { error }),
      connection,
      truncated,
      resolving: sameKeys(snapshot.resolving, resolving)
        ? snapshot.resolving
        : new Set(resolving.keys()),
      ...(openDetail === undefined ? {} : { detail: openDetail }),
      ...(recent === undefined ? {} : { recent }),
    };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (fault) {
        reportFault(fault);
      }
    }
  }

  // ------------------------------------------------------------------------------------------- timers

  /** Resolves after `ms`, or at once when the run ends; the caller checks the run is still current. */
  function sleep(r: Run, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (r.ac.signal.aborted) {
        resolve();
        return;
      }
      after(r.timers, ms, resolve);
      r.ac.signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true }
      );
    });
  }

  // -------------------------------------------------------------------- tombstones and suppressions

  function blocked(id: string): boolean {
    if (tombstones.has(id)) return true;
    const until = suppressed.get(id);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    suppressed.delete(id);
    return false;
  }

  function removeRow(id: string): void {
    if (queue.some((row) => row.id === id)) queue = queue.filter((row) => row.id !== id);
  }

  /** Nothing returns to pending, so a tombstoned id is never revived by any list. */
  function tombstone(id: string): void {
    tombstones.delete(id);
    tombstones.set(id, stamp);
    if (tombstones.size > TOMBSTONE_CAP) {
      const oldest = tombstones.keys().next();
      if (oldest.done !== true) tombstones.delete(oldest.value);
    }
    run?.awaiting.delete(id);
    removeRow(id);
  }

  /** What an approval seen outside a list says about the queue: out and tombstoned, or the row updated. */
  function reconcileRow(approval: ApprovalSummary): void {
    if (approval.state !== 'pending') {
      tombstone(approval.id);
      return;
    }
    if (blocked(approval.id)) return;
    if (queue.some((row) => row.id === approval.id)) {
      queue = queue.map((row) => (row.id === approval.id ? approval : row));
      if (run !== undefined) scheduleExpiry(run);
    }
  }

  // ------------------------------------------------------------------------------------------ a run

  const active = (): boolean => started && !disposed && enabled && life !== undefined;

  function endRun(): void {
    const r = run;
    if (r === undefined) return;
    run = undefined;
    r.ac.abort();
    clearAll(r.timers);
    r.done();
  }

  function startRun(): Promise<void> {
    let done: () => void = () => undefined;
    const first = new Promise<void>((resolve) => {
      done = resolve;
    });
    const r: Run = {
      ac: new AbortController(),
      timers: new Set(),
      list: {
        inflight: false,
        queued: false,
        lastStart: 0,
        floor: undefined,
        debounce: undefined,
        debounceFirst: 0,
        periodic: undefined,
        expiry: undefined,
        holdUntil: 0,
      },
      listBackoff: createBackoff(),
      streamBackoff: createBackoff(),
      awaiting: new Map(),
      beyondPage: new Set(),
      expiryDone: new Set(),
      streamFiltered: true,
      done,
    };
    run = r;
    void bootstrap(r).catch((fault: unknown) => {
      failRun(r, fault);
    });
    return first;
  }

  /** The session is over: stop the stream and the polls, say so once, and wait for `refresh()`. */
  function expireSession(cause: Extract<ApprovalsError, { kind: 'unauthorized' }>): void {
    if (expiredFired) return;
    expiredFired = true;
    endRun();
    // The detail's retry and re-read timers would keep asking with a dead session.
    reader.invalidate();
    // A read that was in flight, or an `unavailable` one waiting on its retry timer (now cleared), is dropped with
    // the session, so its detail would wait for ever: it becomes `unauthorized` (the arguments of a `refreshing`
    // detail go with it) and `refresh()` or `retryDetail()` re-reads it.
    const open = reader.state();
    if (
      open?.status === 'loading' ||
      open?.status === 'refreshing' ||
      open?.status === 'unavailable'
    ) {
      reader.set({ id: open.id, status: 'unauthorized', error: cause });
    }
    status = 'error';
    error = cause;
    connection = 'offline';
    commit();
    // A host callback that throws is reported, not rethrown into the caller: every path here is
    // fire-and-forget or promises never to throw.
    try {
      options.onSessionExpired?.();
    } catch (fault) {
      reportFault(fault);
    }
  }

  /** A bug in one of a run's async entry points: reported, and the run ends in `error` so the queue says so. `refresh()` starts again. */
  function failRun(r: Run, fault: unknown): void {
    reportFault(fault);
    if (run !== r) return;
    stopRunWith('error', internalError(fault));
    r.done();
  }

  function stopRunWith(newStatus: ApprovalsStatus, cause: ApprovalsError): void {
    endRun();
    status = newStatus;
    error = cause;
    connection = 'offline';
    commit();
  }

  // Rule 1: capabilities first, with the list's backoff.
  async function bootstrap(r: Run): Promise<void> {
    for (;;) {
      const reply = await exec(r.ac.signal, (c) =>
        c.GET('/v1/capabilities', { parseAs: 'text', signal: r.ac.signal })
      );
      if (run !== r) return;
      let failure: ApprovalsError | undefined;
      if (reply.kind === 'ok') {
        const body = jsonOf(reply);
        const facts = capabilitiesOf(body);
        if (facts === undefined) failure = malformed(200, 'capabilities');
        else {
          // Every audience: with DPoP required a bearer request is refused (401), and an empty `resolutions` means the
          // approvals family is not served, so a creator's reads cannot work either.
          if (facts.resolutions.length === 0 || facts.dpop === 'required') {
            stopRunWith(
              'error',
              makeError(
                'unsupported',
                'unsupported',
                'This deployment does not serve approvals to a browser.'
              )
            );
            return;
          }
          break;
        }
      } else if (reply.kind === 'error') {
        if (reply.error.kind === 'unauthorized') {
          expireSession(reply.error);
          return;
        }
        if (reply.error.kind === 'not_found') {
          stopRunWith(
            'error',
            makeError(
              'unsupported',
              reply.error.code,
              'This deployment does not serve approvals.',
              {
                ...(reply.error.status === undefined ? {} : { status: reply.error.status }),
                ...(reply.error.requestId === undefined
                  ? {}
                  : { requestId: reply.error.requestId }),
              }
            )
          );
          return;
        }
        failure = reply.error;
      } else {
        return;
      }
      // Still loading: the store keeps the failure and retries on the list's backoff.
      error = failure;
      commit();
      // The first outcome settles `refresh()`; the retries go on behind it.
      r.done();
      await sleep(r, r.listBackoff.next());
      if (run !== r) return;
    }
    error = undefined;
    connection = 'connecting';
    commit();
    // Rule 2: open the stream, then list.
    void streamLoop(r).catch((fault: unknown) => {
      failRun(r, fault);
    });
    requestList(r);
  }

  // ------------------------------------------------------------------------------------------- lists

  /** Rule 5: one list in flight, a 1 s floor between starts; a request that cannot run now is coalesced. */
  function requestList(r: Run): void {
    if (run !== r) return;
    const l = r.list;
    // A failed list's backoff holds against every trigger (stream events, connects, expiry, not_eligible):
    // the held periodic timer is the next attempt.
    if (Date.now() < l.holdUntil) return;
    if (l.inflight) {
      l.queued = true;
      return;
    }
    const wait = l.lastStart + LIST_FLOOR_MS - Date.now();
    if (wait > 0) {
      l.floor ??= after(r.timers, wait, () => {
        l.floor = undefined;
        requestList(r);
      });
      return;
    }
    void runList(r).catch((fault: unknown) => {
      failRun(r, fault);
    });
  }

  /** Rule 4: a trailing debounce of 250 ms with a 2 s maximum wait, so a steady stream cannot starve it. */
  function requestListSoon(r: Run): void {
    const l = r.list;
    const now = Date.now();
    if (l.debounce === undefined) l.debounceFirst = now;
    else cancel(r.timers, l.debounce);
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, l.debounceFirst + DEBOUNCE_MAX_WAIT_MS - now));
    l.debounce = after(r.timers, delay, () => {
      l.debounce = undefined;
      requestList(r);
    });
  }

  function armPeriodic(r: Run, delay: number): void {
    cancel(r.timers, r.list.periodic);
    // While a failed list's backoff holds, the backoff is the delay: the poll interval neither shortens
    // it (the stream loop re-arms on a change of connection) nor stretches it.
    const remaining = r.list.holdUntil - Date.now();
    const held = remaining > 0 ? remaining : delay;
    r.list.periodic = after(r.timers, held, () => {
      r.list.periodic = undefined;
      // A scheduled reconcile forgets which ids were left beyond the first page.
      r.beyondPage.clear();
      requestList(r);
    });
  }

  const periodicDelay = (): number => (connection === 'live' ? reconcileMs : pollMs);

  function listQuery(): {
    state: 'pending';
    approver?: 'me';
    created_by?: 'me';
    limit: number;
    scope?: string;
  } {
    return {
      state: 'pending',
      ...(audience === 'creator' ? { created_by: 'me' as const } : { approver: 'me' as const }),
      limit: pageLimit,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    };
  }

  async function runList(r: Run): Promise<void> {
    const l = r.list;
    l.inflight = true;
    l.lastStart = Date.now();
    stamp += 1;
    const mine = stamp;
    try {
      const reply = await exec(r.ac.signal, (c) =>
        c.GET('/v1/approvals', {
          params: { query: listQuery() },
          parseAs: 'text',
          signal: r.ac.signal,
        })
      );
      if (run !== r || reply.kind === 'aborted') return;
      if (reply.kind === 'error') {
        listFailed(r, reply.error);
        return;
      }
      const body = jsonOf(reply);
      const page = approvalPageOf(body);
      if (page === undefined) {
        listFailed(r, malformed(200, 'a list'));
        return;
      }
      applyPage(r, page, mine);
    } finally {
      l.inflight = false;
      if (run === r && l.queued) {
        l.queued = false;
        // After a failed list the held periodic timer is the next attempt.
        if (l.holdUntil <= Date.now()) requestList(r);
      }
    }
  }

  function listFailed(r: Run, failure: ApprovalsError): void {
    if (failure.kind === 'unauthorized') {
      expireSession(failure);
      return;
    }
    // Rows are kept: a failed list is never an empty queue. Retry on the backoff.
    status = 'error';
    error = failure;
    commit();
    const wait = r.listBackoff.next();
    r.list.holdUntil = Date.now() + wait;
    armPeriodic(r, wait);
    r.done();
  }

  function applyPage(r: Run, page: ApprovalPage, listStamp: number): void {
    const ids = new Set(page.approvals.map((a) => a.id));
    // Rule 3 clears a tombstone when a later list lacks the id. Only a complete list can show that: on a
    // truncated page (`more`) the id may sit beyond it, so tombstones stay (bounded by TOMBSTONE_CAP).
    if (!page.more) {
      for (const [id, at] of tombstones) {
        if (listStamp > at && !ids.has(id)) tombstones.delete(id);
      }
    }
    queue = page.approvals.filter((a) => !blocked(a.id)).map(toSummary);
    truncated = page.more;
    status = 'ready';
    error = undefined;
    r.listBackoff.reset();
    r.list.holdUntil = 0;
    for (const [id, at] of [...r.awaiting]) {
      if (ids.has(id)) r.awaiting.delete(id);
      else if (listStamp > at) {
        r.awaiting.delete(id);
        if (page.more) r.beyondPage.add(id);
      }
    }
    const open = reader.state()?.id;
    if (open !== undefined) {
      const row = page.approvals.find((a) => a.id === open);
      if (row !== undefined && reader.differsFrom(row)) reader.noteChange();
      else catchUpCreator(row === undefined);
    }
    scheduleExpiry(r);
    armPeriodic(r, periodicDelay());
    commit();
    r.done();
  }

  /**
   * What a creator's list read says about its open approval. `absent`: the approval is not in the pending list.
   * Pending in the detail, it was decided or expired meanwhile, possibly while the stream was down: one coalesced
   * re-read. On a complete list that is a conclusion; on a partial one (a next page) it is only a reason to
   * verify, since the row may sit beyond the page, and a creator with more pending approvals than a page holds
   * would otherwise never see a decision the stream missed. The re-read happens once per list. An approved
   * approval is waiting to be consumed and a pending list never shows it, so it is read again on every list;
   * consumed with no outcome record yet is read again the same way, because appending the record sends no event.
   * Another audience has no such read: an approver's open detail is a tombstoned row, not a status being followed.
   */
  function catchUpCreator(absent: boolean): void {
    if (audience !== 'creator') return;
    const open = reader.state();
    if (open === undefined || !('approval' in open)) return;
    if (open.status !== 'resolved') {
      if (absent) reader.noteChange();
    } else if (
      open.approval.state === 'approved' ||
      (open.approval.state === 'consumed' && !hasOutcomeRecord(open.approval))
    ) {
      void reader.read(open.id);
    }
  }

  /** Rule 5, expiry: one re-list at the nearest future `expires_at` (+1 s), once per (id, `expires_at`). */
  function scheduleExpiry(r: Run): void {
    cancel(r.timers, r.list.expiry);
    r.list.expiry = undefined;
    let best: { at: number; key: string } | undefined;
    for (const row of queue) {
      if (typeof row.expires_at !== 'string') continue;
      const at = Date.parse(row.expires_at);
      const key = `${row.id}|${row.expires_at}`;
      if (Number.isNaN(at) || at <= r.list.lastStart || r.expiryDone.has(key)) continue;
      if (best === undefined || at < best.at) best = { at, key };
    }
    if (best === undefined) return;
    const target = best;
    const delay = Math.max(0, target.at - Date.now()) + EXPIRY_GRACE_MS;
    // A delay past the timer range would fire at once and spend this key's one re-list. Skip it: every
    // list re-runs this scheduling, so the timer is armed once the expiry is within range.
    if (delay > MAX_TIMER_MS) return;
    r.list.expiry = after(r.timers, delay, () => {
      r.list.expiry = undefined;
      r.expiryDone.add(target.key);
      requestList(r);
    });
  }

  // ------------------------------------------------------------------------------------------ stream

  function setConnection(r: Run, next: ApprovalsConnection): void {
    if (run !== r) return;
    const changed = connection !== next;
    connection = next;
    commit();
    // The interval depends on whether the stream is up. Only a change of interval re-arms: a failed
    // reconnect leaves the pending timer alone, or a backoff shorter than pollMs would push it back for good.
    if (changed && r.list.periodic !== undefined) armPeriodic(r, periodicDelay());
  }

  /** Arms the periodic timer when none is pending; a pending one keeps its place. */
  function ensurePeriodic(r: Run): void {
    if (r.list.periodic === undefined) armPeriodic(r, periodicDelay());
  }

  async function streamLoop(r: Run): Promise<void> {
    for (;;) {
      if (run !== r) return;
      // The attempt ends with the run or on its own (the watchdog). Linked by hand: `AbortSignal.any`
      // is missing from browsers before Chrome 116 and Safari 17.4.
      const attempt = new AbortController();
      const endWithRun = (): void => {
        attempt.abort();
      };
      if (r.ac.signal.aborted) endWithRun();
      else r.ac.signal.addEventListener('abort', endWithRun, { once: true });
      const signal = attempt.signal;
      let delay: number;
      try {
        const reply = await exec(signal, (c) =>
          c.GET('/v1/approvals/stream', {
            ...(r.streamFiltered
              ? {
                  params: {
                    query:
                      audience === 'creator'
                        ? { created_by: 'me' as const }
                        : { approver: 'me' as const },
                  },
                }
              : {}),
            parseAs: 'stream',
            headers: { Accept: 'text/event-stream' },
            signal,
          })
        );
        if (run !== r) return;
        const body: unknown = reply.kind === 'ok' ? reply.data : undefined;
        if (reply.kind === 'ok' && body instanceof ReadableStream) {
          const openedAt = Date.now();
          setConnection(r, 'live');
          // Every (re)connect re-lists, and arms the live reconcile.
          ensurePeriodic(r);
          requestList(r);
          await readStream(r, body as ReadableStream<Uint8Array>, signal, attempt);
          if (run !== r) return;
          setConnection(r, 'polling');
          ensurePeriodic(r);
          if (Date.now() - openedAt >= HEALTHY_STREAM_MS) r.streamBackoff.reset();
          delay = r.streamBackoff.next();
        } else if (reply.kind === 'error' && reply.error.kind === 'unauthorized') {
          expireSession(reply.error);
          return;
        } else if (
          r.streamFiltered &&
          reply.kind === 'error' &&
          reply.error.kind === 'invalid_request' &&
          reply.error.status === 400
        ) {
          // A rev 5 service does not take `approver`: open the stream without it, at once, and let the list confirm.
          r.streamFiltered = false;
          continue;
        } else {
          setConnection(r, 'polling');
          ensurePeriodic(r);
          const refused =
            reply.kind === 'error' &&
            (reply.error.kind === 'forbidden' || reply.error.kind === 'not_found');
          // A stream that answers 403 or 404 stays down: poll, and try again no sooner than 30 s.
          delay = refused
            ? Math.max(BLOCKED_STREAM_MS, r.streamBackoff.next())
            : r.streamBackoff.next();
        }
      } finally {
        r.ac.signal.removeEventListener('abort', endWithRun);
      }
      await sleep(r, delay);
    }
  }

  /** Reads one connection until it ends. The watchdog (rule 6) arms on the first keepalive comment. */
  async function readStream(
    r: Run,
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    attempt: AbortController
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const frames = createFrameReader();
    let armed = false;
    let watchdog: Timer | undefined;
    const rearm = (): void => {
      cancel(r.timers, watchdog);
      watchdog = after(r.timers, WATCHDOG_MS, () => {
        attempt.abort();
      });
    };
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let seenInvalid = 0;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          // A cut stream is an ended stream; only the read can say so.
          break;
        }
        if (chunk.done) break;
        if (run !== r) break;
        if (armed) rearm();
        for (const frame of frames.push(decoder.decode(chunk.value, { stream: true }))) {
          if (frame.type === 'keepalive') {
            armed = true;
            rearm();
          } else if (frame.type === 'approval') {
            try {
              handleEvent(r, frame.approval);
            } catch (fault) {
              // One bad event does not cost the stream; the next list reconciles whatever it left.
              reportFault(fault);
              requestListSoon(r);
            }
          }
        }
        // A line past the bound is not an approvals stream: end this connection and reconnect on the backoff,
        // rather than buffer without limit.
        if (frames.overflowed()) {
          attempt.abort();
          break;
        }
        // Frames that are not approvals were dropped by the reader; an unreadable event may have been a
        // change, so ask for a list rather than trust the queue.
        if (frames.invalid() > seenInvalid) {
          seenInvalid = frames.invalid();
          requestListSoon(r);
        }
      }
    } finally {
      cancel(r.timers, watchdog);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Rule 4. */
  function handleEvent(r: Run, approval: Approval): void {
    if (run !== r) return;
    const summary = toSummary(approval);
    const id = summary.id;
    if (summary.state !== 'pending') {
      tombstone(id);
      if (reader.state()?.id === id) {
        reader.invalidate();
        reader.set({ id, status: 'resolved', approval: summary });
      }
      scheduleExpiry(r);
      commit();
      return;
    }
    if (queue.some((row) => row.id === id)) {
      reconcileRow(summary);
    } else if (!blocked(id) && !r.beyondPage.has(id)) {
      // The contract does not say whether a service applied the stream's `approver` filter (an older one answers
      // 200 and ignores it), so an event is a prompt, never a row: the filtered list read decides the queue.
      r.awaiting.set(id, stamp);
      requestListSoon(r);
    }
    if (reader.state()?.id === id) reader.noteChange();
    commit();
  }

  // --------------------------------------------------------------------------------------- resolve

  /** The approval as the single route shows it now, applied to the open detail when it is this one. */
  async function rereadForConflict(
    id: string,
    live: () => boolean
  ): Promise<ApprovalSummary | undefined> {
    if (reader.state()?.id === id) {
      const read = await reader.read(id);
      if (read !== undefined) return toSummary(read);
      // The read was superseded: a stream event that resolved the approval first turns the detail
      // `resolved` and drops reads in flight. The 409 still needs the approval as it is now.
      if (reader.isOpenAndUnresolved(id)) return undefined;
    }
    const signal = life?.signal ?? neverAborted;
    const reply = await exec(signal, (c) =>
      c.GET('/v1/approvals/{id}', { params: { path: { id } }, parseAs: 'text', signal })
    );
    if (reply.kind === 'ok') {
      const body = jsonOf(reply);
      const approval = approvalOf(body);
      if (approval?.id !== id) return undefined;
      const summary = toSummary(approval);
      reconcileRow(summary);
      return summary;
    }
    if (reply.kind === 'error' && reply.error.kind === 'not_found') tombstone(id);
    // The session ends only for the life that sent the decision: a store since stopped or restarted is left alone.
    if (reply.kind === 'error' && reply.error.kind === 'unauthorized' && live()) {
      expireSession(reply.error);
    }
    return undefined;
  }

  async function sendResolve(
    id: string,
    resolution: 'approved' | 'rejected',
    digest: string,
    reason: string | undefined
  ): Promise<ResolveResult> {
    const lifeAtStart = life;
    const live = (): boolean => life === lifeAtStart && active();
    const reply = await exec(neverAborted, (c) =>
      c.POST('/v1/approvals/{id}/resolve', {
        params: { path: { id } },
        body: {
          resolution,
          expected_action_digest: digest,
          ...(reason === undefined || reason === '' ? {} : { reason }),
        },
        parseAs: 'text',
      })
    );
    if (reply.kind === 'aborted') return { ok: false, error: networkError() };
    if (reply.kind === 'ok') {
      const body = jsonOf(reply);
      const approval = approvalOf(body);
      if (approval?.id !== id) {
        return { ok: false, error: malformed(200, 'a decision') };
      }
      const summary = toSummary(approval);
      if (live()) {
        // The answer is final: the id leaves the queue for good, and the detail drops its arguments.
        tombstone(id);
        if (reader.state()?.id === id) {
          reader.invalidate();
          reader.set({ id, status: 'resolved', approval: summary });
        }
        commit();
      }
      return { ok: true, approval: summary };
    }
    const failure = reply.error;
    if (failure.kind === 'unauthorized') {
      if (live()) expireSession(failure);
      return { ok: false, error: failure };
    }
    if (failure.kind === 'forbidden' && failure.code === 'not_eligible') {
      if (live()) {
        suppressed.set(id, Date.now() + SUPPRESS_MS);
        removeRow(id);
        commit();
        if (run !== undefined) requestList(run);
      }
      return { ok: false, error: failure };
    }
    if (failure.kind === 'not_found') {
      if (live()) {
        tombstone(id);
        if (reader.state()?.id === id) {
          reader.invalidate();
          reader.set({ id, status: 'not_found' });
        }
        commit();
      }
      return { ok: false, error: failure };
    }
    if (failure.kind === 'conflict') {
      const current = live() ? await rereadForConflict(id, live) : undefined;
      if (live()) commit();
      return {
        ok: false,
        error: current === undefined ? failure : { ...failure, current },
      };
    }
    // 429, 5xx and network: the row stays and the person may try again; nothing is retried here.
    return { ok: false, error: failure };
  }

  function resolve(
    id: string,
    resolveOptions: ResolveOptions & {
      readonly resolution: 'approved' | 'rejected';
      readonly expectedActionDigest?: string;
    }
  ): Promise<ResolveResult> {
    const { resolution, reason, expectedActionDigest } = resolveOptions;
    // 1. A resolve already in flight for the id.
    const running = resolving.get(id);
    if (running !== undefined) {
      return running.resolution === resolution
        ? running.promise
        : Promise.resolve({ ok: false, error: localConflict('resolve_in_flight') });
    }
    // 2. An id the store knows is no longer pending.
    // The open detail that read the id as resolved or gone says so for as long as it stays open, past the
    // tombstone a later complete list clears.
    const detail = reader.state();
    if (
      tombstones.has(id) ||
      (detail?.id === id && (detail.status === 'resolved' || detail.status === 'not_found'))
    ) {
      return Promise.resolve({ ok: false, error: localConflict('already_resolved') });
    }
    // 3. The detail gate: only the one open, loaded, pending approval can be decided.
    if (
      detail?.id !== id ||
      detail.status !== 'loaded' ||
      detail.approval.state !== 'pending' ||
      !active()
    ) {
      return Promise.resolve({ ok: false, error: detailNotRead() });
    }
    // 4. The request, with the digest of the read that enabled the action.
    const digest = expectedActionDigest ?? detail.approval.action_digest;
    const promise = sendResolve(id, resolution, digest, reason).finally(() => {
      resolving.delete(id);
      commit();
    });
    resolving.set(id, { resolution, promise });
    commit();
    return promise;
  }

  // ------------------------------------------------------------------- more of the queue, and the resolved

  /** Asks the list for the next page of the queue: the page grows by `PAGE_SIZE` to the most the service returns at once. */
  function loadMore(): Promise<void> {
    const r = run;
    if (r === undefined || !active() || !truncated || pageLimit >= MAX_PAGE)
      return Promise.resolve();
    pageLimit = Math.min(MAX_PAGE, pageLimit + PAGE_SIZE);
    requestList(r);
    return Promise.resolve();
  }

  /** The query of the recently resolved view: every state that has a resolution time, newest resolution first. */
  const recentQuery = (cursor: string | undefined) => ({
    state: 'approved,rejected,consumed',
    order: 'resolved_at' as const,
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });

  /** The recent view as it is now: read through a function, because a reply is awaited between a write and the next read. */
  const recentNow = (): RecentState | undefined => recent;

  async function readRecent(cursor: string | undefined): Promise<void> {
    if (!active()) return;
    recentSeq += 1;
    const mine = recentSeq;
    const lifeAtStart = life;
    const first = cursor === undefined;
    recent = first
      ? { status: 'loading', approvals: recent?.approvals ?? [], more: false, loadingMore: false }
      : { ...(recent ?? { status: 'ready', approvals: [], more: false }), loadingMore: true };
    commit();
    const signal = life?.signal ?? neverAborted;
    const reply = await exec(signal, (c) =>
      c.GET('/v1/approvals', { params: { query: recentQuery(cursor) }, parseAs: 'text', signal })
    );
    if (mine !== recentSeq || life !== lifeAtStart || reply.kind === 'aborted') return;
    const before = recentNow()?.approvals ?? [];
    const moreBefore = recentNow()?.more ?? false;
    if (reply.kind === 'error') {
      if (reply.error.kind === 'unauthorized') {
        expireSession(reply.error);
        return;
      }
      // A failed read is never an empty list: what was shown stays, and the error says why it is not newer.
      recent = {
        status: 'error',
        approvals: before,
        more: moreBefore,
        loadingMore: false,
        error: reply.error,
      };
      commit();
      return;
    }
    const page = approvalPageOf(jsonOf(reply));
    if (page === undefined) {
      recent = {
        status: 'error',
        approvals: before,
        more: moreBefore,
        loadingMore: false,
        error: malformed(200, 'a list'),
      };
      commit();
      return;
    }
    const incoming = page.approvals.map(toSummary);
    const seen = new Set(first ? [] : before.map((a) => a.id));
    recentNext = page.next;
    recent = {
      status: 'ready',
      approvals: first ? incoming : [...before, ...incoming.filter((a) => !seen.has(a.id))],
      more: page.more,
      loadingMore: false,
    };
    commit();
  }

  function loadRecent(): Promise<void> {
    if (recent?.status === 'loading') return Promise.resolve();
    recentNext = undefined;
    return readRecent(undefined);
  }

  function loadMoreRecent(): Promise<void> {
    const shown = recentNow();
    if (shown === undefined || shown.loadingMore || shown.status === 'loading')
      return Promise.resolve();
    if (!shown.more || recentNext === undefined) return Promise.resolve();
    return readRecent(recentNext);
  }

  // ------------------------------------------------------------------------------------- approve many

  /** One request that was not sent, with the answer the single route would have given. */
  const unsent = (id: string, error: ApprovalsError): ManyItemResult => ({ id, ok: false, error });

  /**
   * One call of the batch route for `ids`, whose rows are in the queue. The elements come back in order, each the
   * resulting approval or the problem the single route would have answered, and are applied one by one as
   * `sendResolve` applies its answer.
   */
  async function sendBatch(
    ids: readonly string[],
    digests: ReadonlyMap<string, string>,
    live: () => boolean
  ): Promise<ManyResult> {
    const reply = await exec(neverAborted, (c) =>
      c.POST('/v1/approvals/resolve/batch', {
        body: {
          items: ids.map((id) => ({
            approval_id: id,
            resolution: 'approved' as const,
            expected_action_digest: digests.get(id) ?? '',
          })),
        },
        parseAs: 'text',
      })
    );
    if (reply.kind === 'aborted') return { ok: false, error: networkError() };
    if (reply.kind === 'error') {
      if (reply.error.kind === 'unauthorized' && live()) expireSession(reply.error);
      return { ok: false, error: reply.error };
    }
    const body = jsonOf(reply);
    const elements =
      typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : undefined;
    if (elements?.length !== ids.length) {
      return { ok: false, error: malformed(200, 'a batch of decisions') };
    }
    const results: ManyItemResult[] = [];
    let conflicted = false;
    for (const [index, element] of elements.entries()) {
      const id = ids[index] ?? '';
      const approval = approvalOf(element);
      if (approval?.id === id) {
        const summary = toSummary(approval);
        if (live()) {
          tombstone(id);
          if (reader.state()?.id === id) {
            reader.invalidate();
            reader.set({ id, status: 'resolved', approval: summary });
          }
        }
        results.push({ id, ok: true, approval: summary });
        continue;
      }
      // Not an approval of this id: a problem document, whose status and `type` give the kind as for the single route.
      const problem =
        typeof element === 'object' && element !== null
          ? (element as Record<string, unknown>)
          : undefined;
      const status = typeof problem?.status === 'number' ? problem.status : 0;
      if (problem === undefined || status < 400) {
        return { ok: false, error: malformed(200, 'a batch of decisions') };
      }
      const failure = errorFromResponse(status, problem);
      if (live()) {
        if (failure.kind === 'not_found') tombstone(id);
        else if (failure.kind === 'forbidden' && failure.code === 'not_eligible') {
          suppressed.set(id, Date.now() + SUPPRESS_MS);
          removeRow(id);
        } else if (failure.kind === 'conflict') conflicted = true;
      }
      results.push(unsent(id, failure));
    }
    if (live()) {
      commit();
      // A request that changed or was decided elsewhere is read again, not guessed at.
      if (conflicted && run !== undefined) requestList(run);
    }
    return { ok: true, results };
  }

  async function approveMany(
    ids: readonly string[],
    shown: ReadonlyMap<string, string>
  ): Promise<ManyResult> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { ok: true, results: [] };
    if (!active()) return { ok: false, error: networkError() };
    const lifeAtStart = life;
    const live = (): boolean => life === lifeAtStart && active();
    // Each row must be one the queue holds, pending and with no decision already on its way: the digest sent is the row's.
    const digests = new Map<string, string>();
    const local = new Map<string, ManyItemResult>();
    for (const id of unique) {
      const row = queue.find((r) => r.id === id);
      if (resolving.has(id)) local.set(id, unsent(id, localConflict('resolve_in_flight')));
      else if (tombstones.has(id) || row?.state !== 'pending')
        local.set(id, unsent(id, localConflict('already_resolved')));
      else if (batchBlock(row) !== undefined)
        // Rule: a request whose arguments an approver could read, or that shows nothing is known about, is opened and decided alone.
        local.set(id, unsent(id, detailNotRead()));
      else if (shown.get(id) !== row.action_digest)
        // The request changed after the person confirmed: they never saw this one, so it is neither sent with the new digest nor with the old.
        local.set(
          id,
          unsent(
            id,
            makeError(
              'conflict',
              'approval_conflict',
              'This request changed while you were looking at it.',
              { local: true }
            )
          )
        );
      else digests.set(id, row.action_digest);
    }
    const sendable = unique.filter((id) => digests.has(id));
    // The ids are in flight for the whole call: the queue shows "sending" and no single decision starts for them.
    const gate = Promise.resolve({
      ok: false,
      error: localConflict('resolve_in_flight'),
    } as ResolveResult);
    for (const id of sendable) resolving.set(id, { resolution: 'approved', promise: gate });
    commit();
    const results = new Map<string, ManyItemResult>(local);
    let size = BATCH_SIZE;
    try {
      for (let at = 0; at < sendable.length;) {
        const chunk = sendable.slice(at, at + size);
        const answer = await sendBatch(chunk, digests, live);
        if (!answer.ok) {
          // A limit lower than ours: split to the size it names, once per call, and send this chunk again.
          const max =
            answer.error.kind === 'invalid_request' && answer.error.code === 'batch_too_large'
              ? size >> 1
              : 0;
          if (max >= 1 && size > 1) {
            size = max;
            continue;
          }
          // The whole call failed (a session over, an outage, a service that has no batch): nothing of this chunk or the rest was decided.
          if (at === 0) return answer;
          for (const id of sendable.slice(at)) results.set(id, unsent(id, answer.error));
          break;
        }
        for (const item of answer.results) results.set(item.id, item);
        at += chunk.length;
      }
    } finally {
      for (const id of sendable) resolving.delete(id);
      commit();
    }
    return {
      ok: true,
      results: unique.map((id) => results.get(id) ?? unsent(id, localConflict('already_resolved'))),
    };
  }

  // ----------------------------------------------------------------------------------------- lifecycle

  function start(): void {
    started = true;
    life = new AbortController();
    expiredFired = false;
    pageLimit = PAGE_SIZE;
    recent = undefined;
    recentNext = undefined;
    recentSeq += 1;
    queue = [];
    tombstones.clear();
    suppressed.clear();
    truncated = false;
    error = undefined;
    reader.set(undefined);
    if (!enabled) {
      status = 'idle';
      connection = 'offline';
      commit();
      return;
    }
    status = 'loading';
    connection = 'connecting';
    commit();
    void startRun();
  }

  function stop(): void {
    if (!started) return;
    started = false;
    endRun();
    reader.invalidate();
    life?.abort();
    life = undefined;
    reader.set(undefined);
    if (enabled) {
      status = 'loading';
      connection = 'offline';
    }
    commit();
  }

  const store: ApprovalsStore = {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && !started && !disposed) start();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => IDLE,
    refresh() {
      if (!active()) return Promise.resolve();
      endRun();
      expiredFired = false;
      status = 'loading';
      error = undefined;
      connection = 'connecting';
      commit();
      const first = startRun();
      // A detail the expired session left `unauthorized` is read again with the new one.
      reader.reopenUnauthorized();
      return first;
    },
    openDetail: (id) => {
      reader.open(id);
    },
    closeDetail: () => {
      reader.close();
    },
    retryDetail: () => {
      reader.retry();
    },
    loadMore,
    loadRecent,
    loadMoreRecent,
    approveMany,
    // Only the reason is taken from the caller: `expectedActionDigest` is for `resolve` alone.
    approve: (id, o) => resolve(id, { ...reasonOf(o), resolution: 'approved' }),
    deny: (id, o) => resolve(id, { ...reasonOf(o), resolution: 'rejected' }),
    resolve,
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      listeners.clear();
    },
  };
  return store;
}
