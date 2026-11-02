/**
 * Test support for the action-status store and hook: opening an approval as the service principal that creates
 * them, taking it through the lifecycle on the mock, and waiting for a status. Not part of the published package.
 */
import { createActionStatusStore } from '../action-status-store.js';
import type {
  ActionStatusState,
  ActionStatusStore,
  UseActionStatusOptions,
} from '../action-status-types.js';
import { call } from './approvals-harness.js';
import type { Harness } from './approvals-harness.js';

/** An external tool the seeded `pol_default` policy matches: its approvals carry `on_deny: resume` for the creator. */
export const TOOL_WITH_ON_DENY = 'ext:local:send_email';
/** An MCP tool the seeded `pol_silent` policy matches: that policy states no `on_deny`. */
export const TOOL_WITHOUT_ON_DENY = 'mcp:tracker:add_comment';

export interface Action {
  readonly id: string;
  readonly digest: string;
  readonly action: { readonly tool_ref: string; readonly arguments: Record<string, unknown> };
}

let counter = 0;

/** Opens an approval of `toolRef` as the service principal `creator`, with a continuation so it can be consumed. */
export async function openAction(h: Harness, toolRef: string = TOOL_WITH_ON_DENY): Promise<Action> {
  counter += 1;
  const action = { tool_ref: toolRef, arguments: { n: counter, k: crypto.randomUUID() } };
  const response = await call(h.baseUrl, h.tokens.creator, 'POST', '/v1/decisions', {
    action,
    continuation: { kind: 'adk', delivery: 'pull' },
  });
  if (response.status !== 200)
    throw new Error(`could not open an approval: ${String(response.status)}`);
  const body = (await response.json()) as {
    data: { approval: { id: string }; action_digest: string };
  };
  return { id: body.data.approval.id, digest: body.data.action_digest, action };
}

/** `approve` or `deny` as the approver. */
export async function decide(
  h: Harness,
  opened: Action,
  verb: 'approve' | 'deny' = 'approve'
): Promise<void> {
  const response = await call(
    h.baseUrl,
    h.tokens.approver,
    'POST',
    `/v1/approvals/${opened.id}/${verb}`,
    { expected_action_digest: opened.digest }
  );
  if (response.status !== 200) throw new Error(`${verb} answered ${String(response.status)}`);
}

/** Approves, reads the Resumption and consumes it, as the creator. */
export async function consume(h: Harness, opened: Action): Promise<void> {
  await decide(h, opened);
  const resumption = await call(
    h.baseUrl,
    h.tokens.creator,
    'GET',
    `/v1/approvals/${opened.id}/resumption`
  );
  const token = ((await resumption.json()) as { data: { resume_token: string } }).data.resume_token;
  const response = await call(
    h.baseUrl,
    h.tokens.creator,
    'POST',
    `/v1/approvals/${opened.id}/consume`,
    { resume_token: token, action: opened.action }
  );
  if (response.status !== 200) throw new Error(`consume answered ${String(response.status)}`);
}

/** Appends the outcome record of a consumed approval, as the creator; returns the record's id. */
export async function recordOutcome(
  h: Harness,
  opened: Action,
  status: 'succeeded' | 'failed' | 'unknown' = 'succeeded'
): Promise<string> {
  const response = await call(h.baseUrl, h.tokens.creator, 'POST', '/v1/records', {
    tool_ref: opened.action.tool_ref,
    decision: 'allow',
    approval_id: opened.id,
    outcome: { status },
  });
  if (response.status !== 201) throw new Error(`the record answered ${String(response.status)}`);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

export interface Watched {
  readonly store: ActionStatusStore;
  close(): void;
}

/** A subscribed store, and `close()` to unsubscribe and dispose it. */
export function watch(
  id: string,
  options: UseActionStatusOptions & { readonly reconcileMs?: number }
): Watched {
  const store = createActionStatusStore(id, { reconcileMs: 600_000, ...options });
  const unsubscribe = store.subscribe(() => undefined);
  return {
    store,
    close: () => {
      unsubscribe();
      store.dispose();
    },
  };
}

/** Resolves with the first status that satisfies `predicate`; rejects with the last one on timeout. */
export function untilStatus(
  store: ActionStatusStore,
  predicate: (s: ActionStatusState) => boolean,
  timeoutMs = 5000
): Promise<ActionStatusState> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      const status = store.getSnapshot();
      if (!predicate(status)) return false;
      unsubscribe();
      clearTimeout(timer);
      resolve(status);
      return true;
    };
    const unsubscribe = store.subscribe(() => {
      check();
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for the status: ${JSON.stringify(store.getSnapshot())}`));
    }, timeoutMs);
    check();
  });
}
