/**
 * The headless store for one approval read on its own: no queue, no stream, no polling of a loaded request
 * (an `unavailable` read retries itself with backoff). It is the detail reader (`approvals-detail.ts`)
 * behind the same request layer as the queue store. Constructing it does nothing; the read starts on the
 * first `subscribe` and stops on the last unsubscribe.
 */
import { createDetailReader } from './approvals-detail.js';
import { createExec } from './approvals-exec.js';
import type {
  ApprovalDetailState,
  ApprovalRequestStore,
  UseApprovalRequestOptions,
} from './approvals-types.js';
import { reportFault as reportUnhandled } from './fault.js';

export function createApprovalRequestStore(
  id: string,
  options: UseApprovalRequestOptions
): ApprovalRequestStore {
  const enabled = options.enabled !== false;
  const loading: ApprovalDetailState = Object.freeze({ id, status: 'loading' });
  const listeners = new Set<() => void>();
  let life: AbortController | undefined;
  let disposed = false;
  let expiredFired = false;

  const reportFault = (fault: unknown): void => {
    if (options.onFault === undefined) reportUnhandled(fault);
    else {
      try {
        options.onFault(fault);
      } catch {
        // A fault handler that throws has nowhere further to report to.
      }
    }
  };

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (fault) {
        reportFault(fault);
      }
    }
  };

  const reader = createDetailReader({
    exec: createExec(options, reportFault),
    signal: () => life?.signal,
    active: () => life !== undefined && !disposed && enabled,
    commit: notify,
    reportFault,
    // No queue to reconcile; a successful read re-arms the once-per-session host callback.
    onRead: () => {
      expiredFired = false;
    },
    onGone: () => undefined,
    onUnauthorized: () => {
      if (expiredFired) return;
      expiredFired = true;
      try {
        options.onSessionExpired?.();
      } catch (fault) {
        reportFault(fault);
      }
    },
  });

  const snapshot = (): ApprovalDetailState => reader.state() ?? loading;

  function start(): void {
    life = new AbortController();
    expiredFired = false;
    reader.set(undefined);
    if (enabled) reader.open(id);
  }

  function stop(): void {
    reader.invalidate();
    life?.abort();
    life = undefined;
    reader.set(undefined);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && life === undefined && !disposed) start();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: snapshot,
    getServerSnapshot: () => loading,
    retry() {
      reader.retry();
    },
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      listeners.clear();
    },
  };
}
