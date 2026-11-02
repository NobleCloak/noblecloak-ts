/**
 * The approvals module's own stream parser and response-shape checks. Everything here is pure: no
 * timers, no network, no storage. The parser follows the server-sent-events line rules (CRLF, LF and a
 * lone CR end a line, a chunk may split anywhere, `:` lines are comments, several `data:` lines join
 * with a newline); it never throws on what the server sends.
 */
import type { Approval } from './approvals-types.js';

/** One item the parser emits: a comment line, or a dispatched event. */
export type SseItem =
  | { readonly type: 'comment'; readonly text: string }
  | { readonly type: 'event'; readonly event: string; readonly data: string };

/**
 * A single line, or one event's `data` and `event` fields taken together, longer than this (UTF-16 code
 * units) is not an approvals stream: the parser stops and says so.
 */
export const MAX_SSE_LINE = 1024 * 1024;

export interface SseParser {
  /** Feeds decoded text and returns the items completed by it, in order. */
  push(chunk: string): SseItem[];
  /** True once a line, or one event's fields together, passed `MAX_SSE_LINE`; the parser then buffers and emits nothing more. */
  readonly overflowed: () => boolean;
}

export function createSseParser(): SseParser {
  let buffer = '';
  // A line that ended in CR may be followed by the LF of a CRLF in the next chunk.
  let skipLeadingLf = false;
  let event = '';
  let data: string[] = [];
  // The size of the fields the current event has gathered so far; lines that each fit would otherwise add up without bound.
  let eventSize = 0;
  let overflow = false;

  // `line` sets the flag; reading it through a function keeps the compiler from narrowing it to false.
  const overflowed = (): boolean => overflow;

  const line = (text: string, out: SseItem[]): void => {
    if (text === '') {
      if (data.length > 0) {
        out.push({ type: 'event', event: event === '' ? 'message' : event, data: data.join('\n') });
      }
      event = '';
      data = [];
      eventSize = 0;
      return;
    }
    if (text.startsWith(':')) {
      out.push({ type: 'comment', text: text.slice(1).replace(/^ /, '') });
      return;
    }
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? '' : text.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') {
      event = value;
      eventSize += value.length;
    } else if (field === 'data') {
      data.push(value);
      eventSize += value.length + 1;
    }
    if (eventSize > MAX_SSE_LINE) overflow = true;
    // `id` and `retry` carry nothing this module uses; unknown fields are ignored.
  };

  return {
    overflowed,
    push(chunk) {
      const out: SseItem[] = [];
      if (overflow) return out;
      let text = buffer + chunk;
      buffer = '';
      if (skipLeadingLf) {
        // An empty chunk consumes nothing, so the pending LF of a split CRLF is still owed.
        if (text === '') return out;
        skipLeadingLf = false;
        if (text.startsWith('\n')) text = text.slice(1);
      }
      let start = 0;
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch !== '\n' && ch !== '\r') continue;
        if (i - start > MAX_SSE_LINE) {
          overflow = true;
          buffer = '';
          return out;
        }
        line(text.slice(start, i), out);
        if (overflowed()) {
          buffer = '';
          return out;
        }
        if (ch === '\r') {
          if (text[i + 1] === '\n') i += 1;
          else if (i + 1 === text.length) skipLeadingLf = true;
        }
        start = i + 1;
      }
      if (text.length - start > MAX_SSE_LINE) {
        overflow = true;
        buffer = '';
        return out;
      }
      buffer = text.slice(start);
      return out;
    },
  };
}

const APPROVAL_STATES: ReadonlySet<string> = new Set([
  'pending',
  'approved',
  'rejected',
  'consumed',
  'expired',
  'withdrawn',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';
/** A string, or absent. */
const isOptString = (value: unknown): boolean => value === undefined || isString(value);
/** A string, null, or absent. */
const isOptNullString = (value: unknown): boolean =>
  value === undefined || value === null || isString(value);
/** A record that has a string `id`, or absent. */
const isOptIdRecord = (value: unknown): boolean =>
  value === undefined || (isRecord(value) && isString(value.id));
/** A non-negative integer, or absent. */
const isOptCount = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);

/**
 * A principal reference (rev 6): an `id`, a `kind` and, optionally, the name the service knows it by. A name
 * that is present is a string; `null` and an empty string are not names (the contract says never null).
 */
const isPrincipalRef = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.id) &&
  // The contract requires `kind`; this module reads only the id and the name, so it does not insist.
  isOptString(value.kind) &&
  (value.display_name === undefined || (isString(value.display_name) && value.display_name !== ''));

/** A principal reference, or absent. */
const isOptPrincipalRef = (value: unknown): boolean => value === undefined || isPrincipalRef(value);

/** `waiting_on` (rev 6, the creator's alone): a count and up to five principals. The approvals queue ignores it (action-status reads it, in `pendingOnOf`), and a malformed one is not an approval. */
const isOptWaitingOn = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) &&
    typeof value.count === 'number' &&
    isOptCount(value.count) &&
    (value.principals === undefined ||
      (Array.isArray(value.principals) &&
        value.principals.length <= 5 &&
        (value.principals as unknown[]).every(isPrincipalRef))));

function isHistoryEntry(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    isString(entry.resolution) &&
    isString(entry.at) &&
    isPrincipalRef(entry.by) &&
    isOptString(entry.reason)
  );
}

/**
 * An approval has what the module reads from every one: an id, a state, the digest, and every field the
 * page renders as text, each of the type the contract gives it. A row that fails any of these is not an
 * approval, so a malformed reply is reported as one instead of reaching a renderer.
 */
export function isApproval(value: unknown): value is Approval {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.state === 'string' &&
    APPROVAL_STATES.has(value.state) &&
    isString(value.action_digest) &&
    isString(value.tool_ref) &&
    isString(value.scope_id) &&
    isString(value.created_at) &&
    isString(value.side_effect_level) &&
    isString(value.obligation_kind) &&
    isOptString(value.resolution) &&
    isOptString(value.continuation_kind) &&
    isOptNullString(value.expires_at) &&
    isOptNullString(value.resolved_at) &&
    (value.agent === undefined ||
      (isRecord(value.agent) &&
        isString(value.agent.id) &&
        isOptNullString(value.agent.parent) &&
        isOptString(value.agent.name))) &&
    (value.run === undefined ||
      (isRecord(value.run) && isString(value.run.id) && isString(value.run.kind))) &&
    isOptIdRecord(value.policy) &&
    isOptPrincipalRef(value.approver) &&
    isOptPrincipalRef(value.requester) &&
    // A state this version does not know is kept: the component then claims no reason for the missing call.
    isOptString(value.arguments_state) &&
    isOptWaitingOn(value.waiting_on) &&
    (value.resolution_history === undefined ||
      (Array.isArray(value.resolution_history) &&
        (value.resolution_history as unknown[]).every(isHistoryEntry)))
  );
}

/** Parses JSON text; `undefined` when it is not JSON. */
export function parseJson(text: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/** An `{data: Approval}` envelope or a bare approval, as one approval; `undefined` when it is neither. */
export function approvalOf(value: unknown): Approval | undefined {
  if (isApproval(value)) return value;
  if (isRecord(value) && isApproval(value.data)) return value.data;
  return undefined;
}

export interface ApprovalPage {
  readonly approvals: readonly Approval[];
  /** True when `meta.next` names another page. */
  readonly more: boolean;
  /** The `meta.next` cursor, when there is one. */
  readonly next?: string;
}

/** An `ApprovalListEnvelope`, or `undefined` when any row is not an approval. */
export function approvalPageOf(value: unknown): ApprovalPage | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const rows: unknown[] = value.data;
  if (!rows.every(isApproval)) return undefined;
  const next = isRecord(value.meta) ? value.meta.next : undefined;
  const more = typeof next === 'string' && next !== '';
  return { approvals: rows, more, ...(more ? { next } : {}) };
}

/** The part of `Capabilities` the module reads. */
export interface CapabilityFacts {
  readonly resolutions: readonly string[];
  readonly dpop: string | undefined;
}

export function capabilitiesOf(value: unknown): CapabilityFacts | undefined {
  const body = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(body) || !Array.isArray(body.resolutions)) return undefined;
  const resolutions = (body.resolutions as unknown[]).filter(
    (r): r is string => typeof r === 'string'
  );
  return { resolutions, dpop: typeof body.dpop === 'string' ? body.dpop : undefined };
}

/** What the stream reader reports to the store. */
export type StreamFrame =
  | { readonly type: 'keepalive' }
  | { readonly type: 'connected' }
  | { readonly type: 'approval'; readonly approval: Approval };

export interface FrameReader {
  push(chunk: string): StreamFrame[];
  /** Frames that were events of the module's kind but not JSON, or JSON that is not an approval. */
  readonly invalid: () => number;
  /** True once the stream sent a line longer than `MAX_SSE_LINE`: it is not an approvals stream. */
  readonly overflowed: () => boolean;
}

/**
 * Reads the approvals stream: `approval.updated` events become approvals, a comment other than the
 * opening `: connected` is a keepalive, every other event is ignored, and a frame that cannot be read is
 * counted and dropped.
 */
export function createFrameReader(): FrameReader {
  const parser = createSseParser();
  let invalid = 0;
  return {
    push(chunk) {
      const frames: StreamFrame[] = [];
      for (const item of parser.push(chunk)) {
        if (item.type === 'comment') {
          frames.push({ type: item.text.trim() === 'connected' ? 'connected' : 'keepalive' });
          continue;
        }
        if (item.event !== 'approval.updated') continue;
        const parsed = parseJson(item.data);
        const approval = parsed === undefined ? undefined : approvalOf(parsed.value);
        if (approval === undefined) invalid += 1;
        else frames.push({ type: 'approval', approval });
      }
      return frames;
    },
    invalid: () => invalid,
    overflowed: parser.overflowed,
  };
}
