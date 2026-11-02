/**
 * The detail reader: the read of one approval from the single route, its state machine
 * (`ApprovalDetailState`), argument handling, retry with backoff and the coalesced re-read. The queue store
 * and the single-request store both build on it; each supplies a `DetailHost` for what differs (how a request
 * is sent, what a result means for a queue, what a dead session means). No React.
 */
import { asUnavailable, internalError, isRetryable, malformed } from './approvals-errors.js';
import { approvalOf } from './approvals-parse.js';
import type { Exec, Reply } from './approvals-exec.js';
import { jsonOf } from './approvals-exec.js';
import { after, cancel, clearAll, createBackoff } from './approvals-timing.js';
import type { Timer } from './approvals-timing.js';
import type {
  Approval,
  ApprovalDetailState,
  ApprovalSummary,
  JsonObject,
} from './approvals-types.js';
import { sliceJsonMember, sliceJsonMembers } from './json-source.js';

/** The least time between two reads of the open approval. */
const REREAD_FLOOR_MS = 1000;

/**
 * The approval without `arguments`: the only form the queue, a result or an error ever holds. `waiting_on` is
 * left out too (the single read's alone, contract rev 6): a list row or a stream event never carries it on.
 */
export function toSummary(approval: Approval): ApprovalSummary {
  const copy: Approval = { ...toSingleRead(approval) };
  delete copy.waiting_on;
  return copy as ApprovalSummary;
}

/** As `toSummary`, with the `waiting_on` the single read carried: what the open detail shows. */
export function toSingleRead(approval: Approval): ApprovalSummary {
  const copy: Approval = { ...approval };
  delete copy.arguments;
  delete copy.continuation;
  return copy as ApprovalSummary;
}

/** The arguments of a single read, when they are a JSON object. */
function argumentsOf(approval: Approval): JsonObject | undefined {
  const value: unknown = approval.arguments;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** The arguments an open detail holds, with their source text, to carry into the next state of the same read. */
function heldArguments(from: {
  readonly arguments?: JsonObject;
  readonly argumentsSource?: string;
}): { readonly arguments?: JsonObject; readonly argumentsSource?: string } {
  return {
    ...(from.arguments === undefined ? {} : { arguments: from.arguments }),
    ...(from.argumentsSource === undefined ? {} : { argumentsSource: from.argumentsSource }),
  };
}

/**
 * The source text of every `arguments` member in the body of a single read (inside `data` for an envelope),
 * or `undefined` when the scanner cannot read the body. More than one is a body that names it twice.
 */
function argumentsSpans(text: string, enveloped: boolean): string[] | undefined {
  const scope = enveloped ? sliceJsonMember(text, 'data') : text;
  return scope === undefined ? undefined : sliceJsonMembers(scope, 'arguments');
}

/** A function, so the check after an `await` is not narrowed away by the one before it. */
const isAborted = (signal: AbortSignal): boolean => signal.aborted;

/** What a reader asks of the store that owns it. */
export interface DetailHost {
  readonly exec: Exec;
  /** The signal of the store's life; `undefined` or aborted while the store is not running. */
  readonly signal: () => AbortSignal | undefined;
  /** Whether the store is running (started, not disposed, enabled). */
  readonly active: () => boolean;
  /** Publishes the reader's state to the store's subscribers. */
  readonly commit: () => void;
  readonly reportFault: (fault: unknown) => void;
  /** A read returned this approval (before the detail takes it): the queue reconciles its row. */
  readonly onRead: (summary: ApprovalSummary) => void;
  /** A read said the approval is gone (before the detail takes it): the queue tombstones it. */
  readonly onGone: (id: string) => void;
  /** A read said the session is over (after the detail took it and was published). */
  readonly onUnauthorized: (
    error: Extract<ApprovalDetailState, { status: 'unauthorized' }>['error']
  ) => void;
}

export interface DetailReader {
  /** The open detail, if any. */
  state(): ApprovalDetailState | undefined;
  /** Replaces the state without publishing it: the caller commits. */
  set(next: ApprovalDetailState | undefined): void;
  /** Drops every read in flight and every timer of the reader. */
  invalidate(): void;
  open(id: string): void;
  close(): void;
  retry(): void;
  /** The open approval changed elsewhere: one coalesced re-read. */
  noteChange(): void;
  /** One read of the single route; resolves with the approval, or `undefined` when it failed or was superseded. */
  read(id: string): Promise<Approval | undefined>;
  /** A detail the expired session left `unauthorized` is read again from the start. */
  reopenUnauthorized(): void;
  /** True when the open detail is this id and not resolved. */
  isOpenAndUnresolved(id: string): boolean;
  /** True when the row differs from what the open detail shows. */
  differsFrom(row: Approval): boolean;
}

export function createDetailReader(host: DetailHost): DetailReader {
  let detail: ApprovalDetailState | undefined;
  const timers = new Set<Timer>();
  let epoch = 0;
  let readSeq = 0;
  let latestRead = 0;
  let appliedRead = 0;
  let reading = false;
  let queued = false;
  let lastRead = 0;
  let backoff = createBackoff();
  let retryTimer: Timer | undefined;
  let rereadTimer: Timer | undefined;

  function invalidate(): void {
    epoch += 1;
    reading = false;
    queued = false;
    clearAll(timers);
    retryTimer = undefined;
    rereadTimer = undefined;
  }

  const isOpenAndUnresolved = (id: string): boolean =>
    detail?.id === id && detail.status !== 'resolved';

  const differsFrom = (row: Approval): boolean => {
    if (detail === undefined || !('approval' in detail)) return false;
    const shown = detail.approval;
    return (
      row.state !== shown.state ||
      row.action_digest !== shown.action_digest ||
      (row.expires_at ?? null) !== (shown.expires_at ?? null) ||
      (row.resolution_history?.length ?? 0) !== (shown.resolution_history?.length ?? 0)
    );
  };

  /**
   * A change to the open approval: one re-read, coalesced, at most one per second, never a loop. The
   * detail goes `refreshing` at once, so no action runs on a digest from before the change; only the
   * request waits for the floor.
   */
  function noteChange(): void {
    const current = detail;
    if (current === undefined || !host.active()) return;
    if (reading) {
      queued = true;
      return;
    }
    if (current.status === 'loaded') {
      detail = {
        id: current.id,
        status: 'refreshing',
        approval: current.approval,
        ...heldArguments(current),
      };
      host.commit();
    } else if (current.status !== 'refreshing') {
      return;
    }
    const wait = lastRead + REREAD_FLOOR_MS - Date.now();
    if (wait > 0) {
      queued = true;
      rereadTimer ??= after(timers, wait, () => {
        rereadTimer = undefined;
        noteChange();
      });
      return;
    }
    queued = false;
    void read(current.id);
  }

  /**
   * One read of the single route for the open id: the detail goes `refreshing` when it was loaded and
   * keeps its content, then takes the read's result. Resolves with the approval the read returned, for a
   * caller that needs it (the 409 of a resolve), or `undefined` when the read failed or was superseded.
   */
  function read(id: string): Promise<Approval | undefined> {
    return readOnce(id).catch((fault: unknown) => {
      // A bug in the read: reported, and an open detail for this id says so instead of waiting for ever.
      host.reportFault(fault);
      reading = false;
      if (detail?.id === id) {
        detail = { id, status: 'error', error: internalError(fault) };
        host.commit();
      }
      return undefined;
    });
  }

  async function readOnce(id: string): Promise<Approval | undefined> {
    const signal = host.signal();
    if (signal === undefined || signal.aborted) return undefined;
    const startedIn = epoch;
    readSeq += 1;
    const seq = readSeq;
    latestRead = seq;
    reading = true;
    lastRead = Date.now();
    cancel(timers, retryTimer);
    retryTimer = undefined;
    if (detail?.status === 'loaded') {
      detail = {
        id,
        status: 'refreshing',
        approval: detail.approval,
        ...heldArguments(detail),
      };
      host.commit();
    }
    const reply = await host.exec(signal, (c) =>
      c.GET('/v1/approvals/{id}', { params: { path: { id } }, parseAs: 'text', signal })
    );
    if (startedIn !== epoch || reply.kind === 'aborted' || isAborted(signal)) return undefined;
    if (seq === latestRead) reading = false;
    if (seq < appliedRead) return undefined;
    appliedRead = seq;
    const approval = applyReply(id, reply);
    if (seq === latestRead && queued && detail?.status === 'refreshing') noteChange();
    return approval;
  }

  function applyReply(
    id: string,
    reply: Exclude<Reply, { kind: 'aborted' }>
  ): Approval | undefined {
    if (reply.kind === 'ok') {
      const body = jsonOf(reply);
      const approval = approvalOf(body);
      // A reply for another approval is never applied: the detail would show one call under another's id.
      if (approval?.id !== id) {
        detail = { id, status: 'error', error: malformed(200, 'an approval') };
        host.commit();
        return undefined;
      }
      const shown = argumentsOf(approval);
      const spans =
        shown === undefined || typeof reply.data !== 'string'
          ? undefined
          : argumentsSpans(reply.data, approval !== body);
      // A body that names `arguments` twice shows one call and may mean another.
      if (spans !== undefined && spans.length > 1) {
        detail = { id, status: 'error', error: malformed(200, 'an approval') };
        host.commit();
        return undefined;
      }
      const source = spans?.at(-1);
      const summary = toSummary(approval);
      backoff.reset();
      host.onRead(summary);
      detail = {
        id,
        // A change noted during this read leaves a re-read owed: the content shows, the actions stay off.
        status: summary.state === 'pending' ? (queued ? 'refreshing' : 'loaded') : 'resolved',
        approval: toSingleRead(approval),
        ...(shown === undefined ? {} : { arguments: shown }),
        ...(shown === undefined || source === undefined ? {} : { argumentsSource: source }),
      };
      host.commit();
      return approval;
    }
    const failure = reply.error;
    if (failure.kind === 'not_found') {
      host.onGone(id);
      detail = { id, status: 'not_found' };
    } else if (failure.kind === 'unauthorized') {
      detail = { id, status: 'unauthorized', error: failure };
      host.commit();
      host.onUnauthorized(failure);
      return undefined;
    } else if (failure.kind === 'forbidden') {
      detail = { id, status: 'forbidden', error: failure };
    } else if (isRetryable(failure)) {
      const delay = backoff.next();
      detail = {
        id,
        status: 'unavailable',
        error: asUnavailable(failure),
        retryingInMs: delay,
      };
      retryTimer = after(timers, delay, () => {
        retryTimer = undefined;
        void read(id);
      });
    } else {
      detail = { id, status: 'error', error: failure };
    }
    host.commit();
    return undefined;
  }

  function open(id: string): void {
    if (!host.active()) return;
    invalidate();
    backoff = createBackoff();
    detail = { id, status: 'loading' };
    host.commit();
    void read(id);
  }

  function close(): void {
    if (detail === undefined) return;
    invalidate();
    detail = undefined;
    host.commit();
  }

  function retry(): void {
    const current = detail;
    if (current === undefined || !host.active()) return;
    if (
      current.status !== 'unavailable' &&
      current.status !== 'error' &&
      current.status !== 'forbidden' &&
      current.status !== 'unauthorized'
    ) {
      return;
    }
    cancel(timers, retryTimer);
    retryTimer = undefined;
    void read(current.id);
  }

  function reopenUnauthorized(): void {
    if (detail?.status !== 'unauthorized') return;
    const id = detail.id;
    invalidate();
    backoff = createBackoff();
    detail = { id, status: 'loading' };
    host.commit();
    void read(id);
  }

  return {
    state: () => detail,
    set(next) {
      detail = next;
    },
    invalidate,
    open,
    close,
    retry,
    noteChange,
    read,
    reopenUnauthorized,
    isOpenAndUnresolved,
    differsFrom,
  };
}
