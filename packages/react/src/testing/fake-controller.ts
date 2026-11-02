/**
 * A controller with no store behind it, and builders for each state of the open detail, so the
 * component and its stories render every state without a network. Not part of the published package:
 * `tsconfig.build.json` excludes this directory.
 */
import type { components } from '@noblecloak/client';

import type {
  ApprovalDetailState,
  ApprovalDetailStatus,
  ApprovalSummary,
  ApprovalsController,
  ApprovalsError,
  JsonObject,
  ResolveOptions,
  ResolveResult,
} from '../approvals-types.js';

const DIGEST = 'a3f1c0de'.repeat(8);

/** A pending approval for a refund tool, with no `arguments` member. */
export function approvalSummary(overrides: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    id: 'apr_1',
    state: 'pending',
    tool_ref: 'ext:billing:issue_refund',
    obligation_kind: 'tool_invocation',
    action_digest: DIGEST,
    scope_id: 'scope_demo',
    side_effect_level: 'external',
    policy: { id: 'policy_default', version: 1 },
    agent: { id: 'agent_refunds', parent: null },
    run: { id: 'run_1', kind: 'external' },
    continuation_kind: 'langgraph',
    created_at: '2026-10-05T12:00:00Z',
    expires_at: '2026-10-05T13:00:00Z',
    ...overrides,
  };
}

export const DETAIL_STATUSES = [
  'loading',
  'refreshing',
  'loaded',
  'resolved',
  'not_found',
  'unavailable',
  'forbidden',
  'unauthorized',
  'error',
] as const satisfies readonly ApprovalDetailStatus[];

/** Compile-time: a status missing from `DETAIL_STATUSES` makes this fail to type-check, so a per-state test cannot skip one. */
export const ALL_DETAIL_STATUSES_LISTED: Exclude<
  ApprovalDetailStatus,
  (typeof DETAIL_STATUSES)[number]
> extends never
  ? true
  : never = true;

export type DetailStates = {
  readonly [S in ApprovalDetailStatus]: ApprovalDetailState & { readonly status: S };
};

export interface DetailStateOptions {
  /** Held by the states that can hold the arguments of a call (`refreshing`, `loaded`, `resolved`). */
  readonly arguments?: JsonObject;
  /** The approval the states that carry one show; the id is overridden by the `id` argument. */
  readonly approval?: Partial<ApprovalSummary>;
}

type PlainKind = Exclude<ApprovalsError['kind'], 'conflict' | 'precondition'>;

function problem<K extends PlainKind>(
  kind: K,
  status: number | undefined,
  title: string
): Extract<ApprovalsError, { kind: K }> {
  // A network error has no response, so it has no status.
  const held = status === undefined ? {} : { status };
  // The union member is chosen by `kind`, which the compiler cannot see through a generic.
  return { kind, code: kind, ...held, title, requestId: 'req_fake' } as Extract<
    ApprovalsError,
    { kind: K }
  >;
}

/** One `ApprovalDetailState` per status, for the approval `id`. */
export function detailStates(id: string, options: DetailStateOptions = {}): DetailStates {
  const approval = approvalSummary({ ...options.approval, id });
  const held = options.arguments === undefined ? {} : { arguments: options.arguments };
  return {
    loading: { id, status: 'loading' },
    refreshing: { id, status: 'refreshing', approval, ...held },
    loaded: { id, status: 'loaded', approval, ...held },
    resolved: {
      id,
      status: 'resolved',
      approval: { ...approval, state: 'approved', resolution: 'approved' },
      ...held,
    },
    not_found: { id, status: 'not_found' },
    unavailable: {
      id,
      status: 'unavailable',
      error: problem('unavailable', 503, 'Temporarily unavailable'),
      retryingInMs: 2000,
    },
    forbidden: { id, status: 'forbidden', error: problem('forbidden', 403, 'No access') },
    unauthorized: {
      id,
      status: 'unauthorized',
      error: problem('unauthorized', 401, 'Session expired'),
    },
    error: { id, status: 'error', error: problem('network', undefined, 'Network error') },
  };
}

export interface FakeCall {
  readonly method: 'refresh' | 'openDetail' | 'closeDetail' | 'retryDetail' | 'approve' | 'deny';
  readonly args: readonly unknown[];
}

export type FakeController = ApprovalsController & { readonly calls: readonly FakeCall[] };

type Resolution = Exclude<components['schemas']['ResolveResolution'], 'escalated'>;

/**
 * A ready, live, empty controller. Any member can be overridden; the actions record their calls in
 * `calls` and `approve`/`deny` follow the store's gate: they resolve the open detail when it is `loaded` and
 * pending, and answer `precondition/detail_not_read` otherwise. A test replaces an action to stage any
 * other failure (an override is not recorded).
 */
export function fakeController(overrides: Partial<ApprovalsController> = {}): FakeController {
  const calls: FakeCall[] = [];
  const record = (method: FakeCall['method'], args: readonly unknown[]): void => {
    calls.push({ method, args });
  };
  const resolveRow = (
    method: 'approve' | 'deny',
    state: Resolution,
    id: string,
    options: ResolveOptions | undefined
  ): Promise<ResolveResult> => {
    record(method, options === undefined ? [id] : [id, options]);
    // The store's gate: a queue row alone is never enough, only the open detail, read and pending,
    // can be resolved. `self.detail` is read at call time, so an override of `detail` is honoured.
    const detail = self.detail;
    if (detail?.id !== id || detail.status !== 'loaded' || detail.approval.state !== 'pending') {
      return Promise.resolve({
        ok: false,
        error: {
          kind: 'precondition',
          code: 'detail_not_read',
          local: true,
          title: 'Open and read the approval before resolving it',
        },
      });
    }
    return Promise.resolve({
      ok: true,
      approval: { ...detail.approval, state, resolution: state },
    });
  };
  const self: FakeController = {
    approvals: [],
    status: 'ready',
    connection: 'live',
    truncated: false,
    resolving: new Set<string>(),
    calls,
    refresh: () => {
      record('refresh', []);
      return Promise.resolve();
    },
    openDetail: (id) => {
      record('openDetail', [id]);
    },
    closeDetail: () => {
      record('closeDetail', []);
    },
    retryDetail: () => {
      record('retryDetail', []);
    },
    approve: (id, options) => resolveRow('approve', 'approved', id, options),
    deny: (id, options) => resolveRow('deny', 'rejected', id, options),
    ...overrides,
  };
  return self;
}
