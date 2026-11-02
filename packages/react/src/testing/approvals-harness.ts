/**
 * Test support for the approvals store and hook: the in-process mock, a recording `fetch` that tests can
 * intercept, a way to open approvals as a creator, and `until` to wait for a snapshot. Not part of the
 * published package.
 */
import { startMock } from '@noblecloak/spec';
import type { MockTokens, RunningMock } from '@noblecloak/spec';

import { trackInFlight } from './approvals-fake-time.js';
import { createApprovalsStore } from '../approvals-store.js';
import type {
  ApprovalSummary,
  ApprovalsSnapshot,
  ApprovalsStore,
  UseApprovalsOptions,
} from '../approvals-types.js';

/** A string no real value contains, put in arguments to find out whether anything keeps them. */
export const ARG_MARKER = 'ARG-MARKER-b81c05';

export interface Harness {
  readonly mock: RunningMock;
  readonly tokens: MockTokens;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/** Starts the mock over HTTP on loopback with its control routes on. */
export async function startHarness(
  options: Parameters<typeof startMock>[0] = {}
): Promise<Harness> {
  const mock = await startMock({ control: true, ...options });
  const tokens = await mock.tokens();
  adminTokens.set(mock.baseUrl, tokens.creator);
  return {
    mock,
    tokens,
    baseUrl: mock.baseUrl,
    stop: () => {
      adminTokens.delete(mock.baseUrl);
      for (const key of [...chosen.keys()])
        if (key.startsWith(`${mock.baseUrl}|`)) chosen.delete(key);
      return mock.stop();
    },
  };
}

/** `fetch` served by the mock's app in this process: no socket, so fake timers do not stall it. */
export function inProcessFetch(mock: RunningMock): typeof fetch {
  return (input, init) => trackInFlight(Promise.resolve(mock.app.fetch(new Request(input, init))));
}

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: unknown;
}

export type Interceptor = (
  call: Call,
  request: Request
) => Response | undefined | Promise<Response | undefined>;

export interface Recorder {
  readonly fetch: typeof fetch;
  readonly calls: Call[];
  /** Calls whose method and path match. */
  count(method: string, path: RegExp | string): number;
  /** Replaces the interceptor: it may answer a request itself. */
  intercept(next: Interceptor | undefined): void;
}

/** Wraps `base`, recording every request and letting a test answer some of them itself. */
export function recorder(base: typeof fetch = globalThis.fetch): Recorder {
  const calls: Call[] = [];
  let interceptor: Interceptor | undefined;
  const wrapped: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.clone().text();
    let body: unknown;
    try {
      body = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      body = text;
    }
    const call: Call = { method: request.method, path: url.pathname, query: url.search, body };
    calls.push(call);
    const answered = await interceptor?.(call, request);
    return answered ?? base(request);
  };
  return {
    fetch: wrapped,
    calls,
    count: (method, path) =>
      calls.filter(
        (c) =>
          c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path))
      ).length,
    intercept: (next) => {
      interceptor = next;
    },
  };
}

let counter = 0;

export interface Opened {
  readonly id: string;
  readonly digest: string;
}

/** The name of the per-tool setting (contract rev 5). Named once; every use in this module goes through it. */
export const SHOW_ARGUMENTS_FIELD = 'show_arguments_to_approvers';

/**
 * The token that registers tools, per harness, so a helper that has only a base URL can register them. The
 * mock restricts tool registration to no one, so the `creator` service principal stands in for the
 * conformance scenarios' `admin` alias (which falls back to `creator` the same way).
 */
const adminTokens = new Map<string, string>();

let toolCounter = 0;

/** Tools already chosen per mock and mode, so one test file registers each at most once per mock. */
const chosen = new Map<string, Promise<string>>();

/**
 * Registers an `external` tool with the setting `show` through the mock's API, as the registering principal,
 * and returns its `tool_ref`. It throws when the mock does not accept the setting (the response does not echo
 * it): the mock of contract rev 5 does, and a test must not silently run against a tool that ignores it.
 */
async function registerWithSetting(baseUrl: string, show: boolean): Promise<string> {
  const admin = adminTokens.get(baseUrl);
  if (admin === undefined) throw new Error(`no registering token for the mock at ${baseUrl}`);
  toolCounter += 1;
  const toolRef = `ext:args-${show ? 'shown' : 'hidden'}:${String(toolCounter)}-${Date.now().toString(36)}`;
  const response = await fetch(`${baseUrl}/v1/tools`, {
    method: 'POST',
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tool_ref: toolRef,
      transport: 'external',
      input_schema: { type: 'object' },
      side_effect_level: 'write',
      owner_kind: 'org',
      [SHOW_ARGUMENTS_FIELD]: show,
    }),
  });
  const body = (await response.json()) as { data?: Record<string, unknown> };
  if (response.status !== 201 || body.data?.[SHOW_ARGUMENTS_FIELD] !== show) {
    throw new Error(
      `the mock did not accept ${SHOW_ARGUMENTS_FIELD}=${String(show)} (${String(response.status)})`
    );
  }
  return toolRef;
}

function toolFor(baseUrl: string, show: boolean): Promise<string> {
  const key = `${baseUrl}|${String(show)}`;
  let found = chosen.get(key);
  if (found === undefined) {
    found = registerWithSetting(baseUrl, show);
    chosen.set(key, found);
  }
  return found;
}

/** A `tool_ref` whose approvals show their arguments to the creator and eligible approvers on the single read: a tool registered with the setting on. */
export const toolShowingArguments = (baseUrl: string): Promise<string> => toolFor(baseUrl, true);

/** A `tool_ref` whose approvals never show arguments: a tool registered with the setting off. */
export const toolHidingArguments = (baseUrl: string): Promise<string> => toolFor(baseUrl, false);

/** Opens a new approval (unique arguments) as the holder of `token`, through the decisions route. */
export async function openApproval(
  baseUrl: string,
  token: string,
  options: { tool?: string; arguments?: Record<string, unknown> } = {}
): Promise<Opened> {
  counter += 1;
  const response = await fetch(`${baseUrl}/v1/decisions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      action: {
        tool_ref: options.tool ?? (await toolShowingArguments(baseUrl)),
        arguments: { n: counter, marker: ARG_MARKER, ...options.arguments },
      },
    }),
  });
  const body = (await response.json()) as {
    data: { approval: { id: string }; action_digest: string };
  };
  return { id: body.data.approval.id, digest: body.data.action_digest };
}

/** An in-process variant of `openApproval`, for tests on fake timers. */
export async function openApprovalIn(
  mock: RunningMock,
  token: string,
  options: { tool?: string; arguments?: Record<string, unknown> } = {}
): Promise<Opened> {
  counter += 1;
  const response = await mock.app.fetch(
    new Request(`${mock.baseUrl}/v1/decisions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: {
          tool_ref: options.tool ?? (await toolShowingArguments(mock.baseUrl)),
          arguments: { n: counter, marker: ARG_MARKER, ...options.arguments },
        },
      }),
    })
  );
  const body = (await response.json()) as {
    data: { approval: { id: string }; action_digest: string };
  };
  return { id: body.data.approval.id, digest: body.data.action_digest };
}

/** Sends one request to the mock as `token` and returns the response. */
export async function call(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A store over `options`, with defaults for a test. */
export function newStore(
  options: Partial<UseApprovalsOptions> & Pick<UseApprovalsOptions, 'baseUrl' | 'getToken'>
): ApprovalsStore {
  return createApprovalsStore(options);
}

/** A subscribed store: `store.subscribe` already called. `close()` unsubscribes and disposes. */
export interface Live {
  readonly store: ApprovalsStore;
  snapshot(): ApprovalsSnapshot;
  close(): void;
}

export function live(
  options: Partial<UseApprovalsOptions> & Pick<UseApprovalsOptions, 'baseUrl' | 'getToken'>
): Live {
  const store = createApprovalsStore(options);
  const unsubscribe = store.subscribe(() => undefined);
  return {
    store,
    snapshot: () => store.getSnapshot(),
    close: () => {
      unsubscribe();
      store.dispose();
    },
  };
}

const describeSnapshot = (s: ApprovalsSnapshot): string =>
  JSON.stringify({
    status: s.status,
    connection: s.connection,
    error: s.error,
    rows: s.approvals.map((a) => a.id),
    detail: s.detail === undefined ? undefined : { id: s.detail.id, status: s.detail.status },
  });

/** Resolves with the first snapshot that satisfies `predicate`; rejects with the last one on timeout. */
export function until(
  store: ApprovalsStore,
  predicate: (s: ApprovalsSnapshot) => boolean,
  timeoutMs = 5000
): Promise<ApprovalsSnapshot> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      const snapshot = store.getSnapshot();
      if (!predicate(snapshot)) return false;
      unsubscribe();
      clearTimeout(timer);
      resolve(snapshot);
      return true;
    };
    const unsubscribe = store.subscribe(() => {
      check();
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(`timed out waiting for the store: ${describeSnapshot(store.getSnapshot())}`)
      );
    }, timeoutMs);
    check();
  });
}

export const ids = (rows: readonly ApprovalSummary[]): string[] => rows.map((r) => r.id);

/** A token source that returns `first`, and `renewed` after `getToken({forceRefresh: true})`. */
export function renewing(
  first: string,
  renewed: string
): { getToken: UseApprovalsOptions['getToken']; calls: { forced: number; plain: number } } {
  const calls = { forced: 0, plain: 0 };
  let current = first;
  return {
    calls,
    getToken: (x) => {
      if (x?.forceRefresh === true) {
        calls.forced += 1;
        current = renewed;
      } else calls.plain += 1;
      return current;
    },
  };
}

/** Opens the detail of `id` and waits until it is `loaded`. */
export async function openLoaded(store: ApprovalsStore, id: string): Promise<ApprovalsSnapshot> {
  store.openDetail(id);
  return until(store, (s) => s.detail?.id === id && s.detail.status === 'loaded');
}

/** Arms the mock to fail the next request to `operation` once. Needs the mock started with `control`. */
export async function failNext(
  baseUrl: string,
  token: string,
  operation: string,
  status: 500 | 503,
  retryAfter?: number
): Promise<void> {
  const response = await call(baseUrl, token, 'POST', '/__mock/control', {
    fail: { operation, status, ...(retryAfter === undefined ? {} : { retry_after: retryAfter }) },
  });
  if (!response.ok) throw new Error(`could not arm the mock: ${String(response.status)}`);
}

/** `failNext` for a test on fake timers: the control request is served by the mock's app in this process. */
export async function failNextIn(
  mock: RunningMock,
  token: string,
  operation: string,
  status: 500 | 503,
  retryAfter?: number
): Promise<void> {
  const response = await mock.app.fetch(
    new Request(`${mock.baseUrl}/__mock/control`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        fail: {
          operation,
          status,
          ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
        },
      }),
    })
  );
  if (!response.ok) throw new Error(`could not arm the mock: ${String(response.status)}`);
}

/** A stream response a test writes into by hand: `push` frames, `end` it, and see whether it was cancelled. */
export interface HandStream {
  response(): Response;
  push(text: string): void;
  end(): void;
  readonly cancelled: () => boolean;
}

export function handStream(): HandStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (text) => {
      if (!cancelled) controller?.enqueue(encoder.encode(text));
    },
    end: () => {
      if (!cancelled) controller?.close();
    },
    cancelled: () => cancelled,
  };
}

/** The wire form of one `approval.updated` event. */
export const eventFrame = (approval: Record<string, unknown>): string =>
  `event: approval.updated\ndata: ${JSON.stringify(approval)}\n\n`;

/** A pending approval as an event or a canned response carries it. */
export function cannedApproval(
  id: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    state: 'pending',
    tool_ref: 'mcp:tracker:create_issue',
    obligation_kind: 'tool_invocation',
    action_digest: `sha256:${'a'.repeat(64)}`,
    scope_id: 'scope_1',
    side_effect_level: 'write',
    created_at: '2026-10-05T00:00:00.000Z',
    ...extra,
  };
}

export const problemResponse = (status: number, code: string, title = code): Response =>
  new Response(
    JSON.stringify({ type: `https://x/problems/${code}`, title, status, request_id: 'req_t' }),
    { status, headers: { 'content-type': 'application/problem+json' } }
  );

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The item at `index`; a missing one fails the test with a clear message instead of a non-null assertion. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${String(index)}`);
  return item;
}
