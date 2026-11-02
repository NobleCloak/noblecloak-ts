/**
 * Records one approval's exchange with a service, as an `ApprovalFixture`: it creates a fresh approval as the
 * service principal that is its creator, then reads the list, the single read and the stream frames for it and, when it
 * is given an approver's token, takes the approval through approval and consumption and reads the outcome record.
 * Ids, tokens and names are scrubbed to stable placeholders. The base URL and the tokens come from the caller;
 * nothing here names a host. Test support, run by `tools/capture-hosted-fixtures.ts`.
 */
import { FIXTURE_FORMAT } from './approval-fixture.js';
import type {
  ApprovalFixture,
  FixtureEvent,
  FixtureReply,
  FixtureSource,
  FixtureStep,
} from './approval-fixture.js';

export class CaptureError extends Error {}

export interface CaptureOptions {
  readonly baseUrl: string;
  /** The creator's access token: read once, when the capture starts, and used for every request, the stream included. */
  readonly creatorToken: () => string | Promise<string>;
  /** An eligible approver's token: with it the capture takes the approval on to `consumed`. */
  readonly approverToken?: string;
  readonly toolRef: string;
  /**
   * An external run the creator owns, sent as `actor.run_id`. Without it the capture creates one (`POST /v1/runs`,
   * `kind: external`, no agent), because a service emits `run` on an approval only when the decision named a run.
   */
  readonly runId?: string;
  /**
   * The agent the approval names, sent as `actor.agent_id`. Required: a service emits `agent` on an approval only
   * when the decision named one, and the parity test reads it on every approval. The decision's `agent_id` is a
   * free-form hint and is not checked against `/v1/agents`.
   */
  readonly agentId: string;
  /**
   * Capture the pending step only. Without it, a capture that has no `approverToken` is refused: the consumed
   * step is what covers the outcome record, so leaving it out is a choice the caller makes.
   */
  readonly pendingOnly?: boolean;
  readonly source: FixtureSource;
  /** The deployed service's version as the operator gave it; `unknown` when not given. */
  readonly serviceVersion?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** How long to wait for the stream to deliver a frame for the approval; default 5000. */
  readonly streamWaitMs?: number;
  /** Strings that must not survive in the output (tokens). */
  readonly secrets?: readonly string[];
  /** The tool's path, written to the header. */
  readonly script: string;
  /**
   * Patterns for hosts the fixture must not carry (a deployment's internal domain). The capture is refused when its
   * text matches one, so the operator learns it at capture time. Default none: the helper names no host itself.
   */
  readonly internalHosts?: readonly RegExp[];
}

export interface Captured {
  readonly fixture: ApprovalFixture;
  /** Things the operator should know: a step not reached, a stream that failed, a frame that was not read. */
  readonly warnings: readonly string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The events in the `text/event-stream` frames in `text`; a comment line and a frame with no data are skipped. */
export function parseSse(text: string): {
  complete: FixtureEvent[];
  rest: string;
  /** Frames that carried data which was not a JSON object. */
  skipped: number;
} {
  const complete: FixtureEvent[] = [];
  let skipped = 0;
  const frames = text.replaceAll('\r\n', '\n').split('\n\n');
  const rest = frames.pop() ?? '';
  for (const frame of frames) {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(data.join('\n'));
      if (isObject(parsed)) complete.push({ event, data: parsed });
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { complete, rest, skipped };
}

// ---------------------------------------------------------------------------------------------------- scrub

const KIND_BY_PARENT: Readonly<Record<string, string>> = {
  requester: 'principal',
  approver: 'principal',
  by: 'principal',
  principals: 'principal',
  agent: 'agent',
  run: 'run',
  policy: 'policy',
};

const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;

/**
 * Replaces ids, names, digests, the capture's nonce and tokens with placeholders that depend only on the order the
 * values first appear in, so the same exchange always scrubs to the same text. `ids` seeds placeholders
 * for values the capture knows by kind.
 */
export function scrub(
  value: unknown,
  secrets: readonly string[],
  seeded: readonly (readonly [kind: string, id: string])[] = []
): unknown {
  const placeholders = new Map<string, string>();
  const counters = new Map<string, number>();
  const issue = (kind: string, raw: string): string => {
    const known = placeholders.get(raw);
    if (known !== undefined) return known;
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    const made =
      kind === 'digest'
        ? `sha256:${next.toString(16).padStart(64, '0')}`
        : `${kind}_FIXTURE_${String(next)}`;
    placeholders.set(raw, made);
    return made;
  };
  for (const [kind, id] of seeded) issue(kind, id);

  const isSecret = (text: string): boolean =>
    JWT.test(text) || secrets.some((s) => s !== '' && text.includes(s));

  const walk = (node: unknown, key: string, parent: string): unknown => {
    if (Array.isArray(node)) return node.map((item: unknown) => walk(item, key, key));
    if (isObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, k, key === '' ? parent : key);
      return out;
    }
    if (typeof node !== 'string') return node;
    if (isSecret(node)) return '<token>';
    if (key === 'capture') return '<nonce>';
    if (key === 'display_name' || (key === 'name' && parent === 'agent'))
      return issue('name', node);
    if (key === 'email') return '<email>';
    if (key === 'action_digest') return issue('digest', node);
    // The deployment's signing key ids (`kids` in the capabilities, `kid` in a key): they name its keys.
    if (key === 'kid' || key === 'kids') return issue('kid', node);
    if (key === 'id') return issue(KIND_BY_PARENT[parent] ?? 'obj', node);
    if (key.endsWith('_id') && node !== '')
      return issue(key.slice(0, -3).replace(/^outcome_/, ''), node);
    return node;
  };
  const first = walk(value, '', '');
  // An id inside longer text (a link, a message) is replaced too.
  const known = [...placeholders.entries()].filter(([raw]) => raw.length >= 6);
  const sweep = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sweep);
    if (isObject(node)) {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, sweep(v)]));
    }
    if (typeof node !== 'string') return node;
    let text = node;
    for (const [raw, placeholder] of known) text = text.split(raw).join(placeholder);
    return text;
  };
  return sweep(first);
}

/** `value` with every occurrence of `from` in its strings replaced by `to`. */
function replaceText(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => replaceText(item, from, to));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceText(v, from, to)]));
  }
  return typeof value === 'string' ? value.split(from).join(to) : value;
}

/**
 * The shapes a tracked fixture may not carry: an account id and the gateway header prefix. A capture that holds one
 * is refused here, so the operator learns it at capture time and not in CI. Hosts are the caller's to name
 * (`CaptureOptions.internalHosts`).
 */
const POLICY_SHAPES: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: 'a 12-digit account id', pattern: /\b\d{12}\b/ },
  { what: 'the gateway header prefix', pattern: new RegExp(['\\bx-act', 'or-'].join(''), 'i') },
];

/** What the captured origin is written as inside a body (a URL the service advertises). */
export const ORIGIN_PLACEHOLDER = '<origin>';

// --------------------------------------------------------------------------------------------------- capture

async function reply(response: Response): Promise<FixtureReply> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    // Not JSON: kept as text.
  }
  return { status: response.status, body };
}

/** `list` with only the row of `approvalId`: the creator's other approvals are neither the subject nor ours to keep. */
function onlyRow(list: FixtureReply, approvalId: string): FixtureReply {
  if (!isObject(list.body) || !Array.isArray(list.body.data)) return list;
  const rows = (list.body.data as unknown[]).filter(
    (row) => isObject(row) && row.id === approvalId
  );
  return { ...list, body: { ...list.body, data: rows } };
}

const dataOf = (r: FixtureReply): Record<string, unknown> | undefined =>
  isObject(r.body) && isObject(r.body.data) ? r.body.data : undefined;

export async function captureFixture(options: CaptureOptions): Promise<Captured> {
  const send = options.fetch ?? globalThis.fetch;
  const now = options.now ?? ((): Date => new Date());
  const streamWaitMs = options.streamWaitMs ?? 5000;
  const base = options.baseUrl.replace(/\/+$/, '');
  const warnings: string[] = [];
  if (options.approverToken === undefined && options.pendingOnly !== true) {
    throw new CaptureError(
      "no approver token: the consumed step cannot be captured. Give an eligible approver's token, or ask for the pending step only"
    );
  }

  if (options.agentId === '') {
    throw new CaptureError(
      'no agent id: a service states an agent on an approval only when the decision names one. Give --agent-id'
    );
  }

  async function call(
    method: string,
    path: string,
    token: string,
    body?: unknown
  ): Promise<FixtureReply> {
    const response = await send(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return reply(response);
  }
  async function need(
    method: string,
    path: string,
    token: string,
    body?: unknown
  ): Promise<FixtureReply> {
    const r = await call(method, path, token, body);
    if (r.status < 200 || r.status >= 300) {
      throw new CaptureError(
        `${method} ${path.replace(/[?].*$/, '')} answered ${String(r.status)}`
      );
    }
    return r;
  }

  const creator = await options.creatorToken();
  const capabilities = await need('GET', '/v1/capabilities', creator);

  // The stream opens first, so the frames for the approval are not missed.
  const events: FixtureEvent[] = [];
  const abort = new AbortController();
  const streamResponse = await send(`${base}/v1/approvals/stream?created_by=me`, {
    headers: { authorization: `Bearer ${creator}`, accept: 'text/event-stream' },
    signal: abort.signal,
  });
  if (streamResponse.status !== 200 || streamResponse.body === null) {
    abort.abort();
    throw new CaptureError(`GET /v1/approvals/stream answered ${String(streamResponse.status)}`);
  }
  const reader = streamResponse.body.getReader();
  const pump = (async (): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (!abort.signal.aborted) {
          warnings.push(
            `the stream failed: ${error instanceof Error ? error.message : 'read error'}`
          );
        }
        return;
      }
      if (chunk.done) return;
      const parsed = parseSse(buffer + decoder.decode(chunk.value, { stream: true }));
      buffer = parsed.rest;
      events.push(...parsed.complete);
      if (parsed.skipped > 0) {
        warnings.push(
          `${String(parsed.skipped)} stream frame(s) carried data that is not an object`
        );
      }
    }
  })();

  let created: string | undefined;
  try {
    const nonce = crypto.randomUUID();
    let runId = options.runId;
    if (runId === undefined) {
      const run = dataOf(await need('POST', '/v1/runs', creator, { kind: 'external' }));
      if (typeof run?.id !== 'string') throw new CaptureError('the run created has no id');
      runId = run.id;
    }
    const decision = await need('POST', '/v1/decisions', creator, {
      action: { tool_ref: options.toolRef, arguments: { capture: nonce } },
      continuation: { kind: 'adk', delivery: 'pull' },
      actor: { run_id: runId, agent_id: options.agentId },
    });
    const decided = dataOf(decision);
    const approval = isObject(decided?.approval) ? decided.approval : undefined;
    const approvalId = approval?.id;
    if (typeof approvalId === 'string') created = approvalId;
    const digest = decided?.action_digest;
    if (typeof approvalId !== 'string' || typeof digest !== 'string') {
      throw new CaptureError(
        `the decision for ${options.toolRef} opened no approval: the tool may not need one`
      );
    }

    const forApproval = (from: number): FixtureEvent[] =>
      events.slice(from).filter((e) => e.data.id === approvalId);
    async function awaitEvent(
      from: number,
      wanted: (e: FixtureEvent) => boolean
    ): Promise<boolean> {
      const deadline = Date.now() + streamWaitMs;
      while (Date.now() < deadline) {
        if (forApproval(from).some(wanted)) return true;
        await sleep(25);
      }
      return false;
    }

    const steps: FixtureStep[] = [];
    // The contract requires neither an event when an approval opens nor its absence: hosted sends an
    // `approval.updated` on creation and the mock does not. So the pending step holds whatever arrived by now and is
    // not waited for.
    const listQuery = '/v1/approvals?created_by=me&state=pending&limit=50';
    steps.push({
      name: 'pending',
      list: onlyRow(await need('GET', listQuery, creator), approvalId),
      detail: await need('GET', `/v1/approvals/${approvalId}`, creator),
      stream: forApproval(0),
    });
    const afterPending = events.length;

    let recordId: string | undefined;
    if (options.approverToken !== undefined) {
      await need('POST', `/v1/approvals/${approvalId}/approve`, options.approverToken, {
        expected_action_digest: digest,
      });
      const resumption = dataOf(
        await need('GET', `/v1/approvals/${approvalId}/resumption`, creator)
      );
      const token = resumption?.resume_token;
      if (typeof token !== 'string') throw new CaptureError('the resumption holds no resume_token');
      await need('POST', `/v1/approvals/${approvalId}/consume`, creator, {
        resume_token: token,
        action: { tool_ref: options.toolRef, arguments: { capture: nonce } },
      });
      const record = dataOf(
        await need('POST', '/v1/records', creator, {
          tool_ref: options.toolRef,
          decision: 'allow',
          approval_id: approvalId,
          outcome: { status: 'succeeded' },
        })
      );
      recordId = typeof record?.id === 'string' ? record.id : undefined;
      if (recordId === undefined) throw new CaptureError('the record has no id');
      const linked = await awaitEvent(afterPending, (e) => e.data.outcome_record_id === recordId);
      if (!linked) warnings.push('the stream delivered no frame that links the outcome record');
      steps.push({
        name: 'consumed',
        list: onlyRow(
          await need('GET', '/v1/approvals?created_by=me&limit=50', creator),
          approvalId
        ),
        detail: await need('GET', `/v1/approvals/${approvalId}`, creator),
        record: await need('GET', `/v1/records/${recordId}`, creator),
        stream: forApproval(afterPending),
      });
    }

    const secrets = [
      creator,
      ...(options.approverToken === undefined ? [] : [options.approverToken]),
      ...(options.secrets ?? []),
    ];
    const seeded: (readonly [string, string])[] = [['apr', approvalId]];
    if (recordId !== undefined) seeded.push(['rec', recordId]);
    const scrubbed = scrub({ capabilities, steps }, secrets, seeded) as {
      capabilities: FixtureReply;
      steps: FixtureStep[];
    };
    const origin = new URL(base).origin;
    const placed = replaceText(scrubbed, origin, ORIGIN_PLACEHOLDER) as typeof scrubbed;
    const fixture: ApprovalFixture = {
      header: {
        format: FIXTURE_FORMAT,
        capturedAt: now().toISOString(),
        source: options.source,
        origin: options.source === 'mock' ? origin.replace(/:\d+$/, ':<port>') : ORIGIN_PLACEHOLDER,
        serviceVersion: options.serviceVersion ?? 'unknown',
        ...(options.source === 'mock'
          ? {
              provisional: true as const,
              note: 'Captured from the local mock, not from the hosted service: replace it with a capture from beta before the PR merges.',
            }
          : {}),
        script: options.script,
      },
      ids: {
        approval: 'apr_FIXTURE_1',
        ...(recordId === undefined ? {} : { record: 'rec_FIXTURE_1' }),
      },
      capabilities: placed.capabilities,
      steps: placed.steps,
    };
    const text = JSON.stringify(fixture);
    const shape = [
      ...POLICY_SHAPES,
      ...(options.internalHosts ?? []).map((pattern) => ({
        what: 'a host under the internal domain',
        pattern,
      })),
    ].find((p) => p.pattern.test(text));
    if (shape !== undefined) {
      throw new CaptureError(
        `the capture carries ${shape.what}, which the repo policy refuses in a tracked file: the fixture was not written`
      );
    }
    const leaked = secrets.find((s) => s !== '' && text.includes(s));
    if (leaked !== undefined || /eyJ[\w-]+\.[\w-]+\./.test(text)) {
      throw new CaptureError('a token survived the scrub: the fixture was not written');
    }
    return { fixture, warnings };
  } catch (error) {
    // The approval is open on the service; the operator needs its id to find and expire it.
    if (created === undefined || !(error instanceof Error)) throw error;
    throw new CaptureError(`${error.message} (approval ${created} was left open on the service)`);
  } finally {
    abort.abort();
    await pump;
  }
}
