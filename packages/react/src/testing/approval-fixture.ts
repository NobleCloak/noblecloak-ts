/**
 * The recorded exchange of one approval, and a `fetch` that replays it. The capture tool
 * (`tools/capture-hosted-fixtures.ts`) writes the file; the parity test reads it. Test support, not part of the
 * published package.
 *
 * A fixture holds what a service answered for one approval a service principal created: the capabilities, and for
 * each step (`pending`, then `consumed` when the capture could reach it) the list, the single read, the
 * outcome record and the stream frames for that approval. Ids and tokens are scrubbed to stable placeholders.
 */
import { handStream, jsonResponse, problemResponse } from './approvals-harness.js';

export const FIXTURE_FORMAT = 1;

/** Who answered: the hosted service, or the local mock (a provisional fixture). */
export type FixtureSource = 'hosted' | 'mock';

export interface FixtureHeader {
  readonly format: typeof FIXTURE_FORMAT;
  /** When the capture ran (ISO 8601). */
  readonly capturedAt: string;
  readonly source: FixtureSource;
  /** The origin that was captured. A loopback port is written as `<port>`. */
  readonly origin: string;
  /** The deployed service's version as the operator gave it, or `unknown`: the service reports none. */
  readonly serviceVersion: string;
  /** True for a fixture that stands in until a capture from the hosted service replaces it. */
  readonly provisional?: true;
  readonly note?: string;
  /** The tool that wrote the file. */
  readonly script: string;
}

export interface FixtureReply {
  readonly status: number;
  readonly body: unknown;
}

export interface FixtureEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export type StepName = 'pending' | 'consumed';

export interface FixtureStep {
  readonly name: StepName;
  readonly list: FixtureReply;
  readonly detail: FixtureReply;
  /** The outcome record, once the approval is consumed and the capture linked one. */
  readonly record?: FixtureReply;
  /** The stream events for this approval during the step, in the order they arrived. */
  readonly stream: readonly FixtureEvent[];
}

export interface ApprovalFixture {
  readonly header: FixtureHeader;
  readonly ids: { readonly approval: string; readonly record?: string };
  readonly capabilities: FixtureReply;
  readonly steps: readonly FixtureStep[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(path: string, expected: string): never {
  throw new Error(`the fixture is not readable: ${path} must be ${expected}`);
}

function stringAt(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value === '') fail(`${path}.${key}`, 'a non-empty string');
  return value;
}

function replyAt(value: unknown, path: string): FixtureReply {
  if (!isObject(value)) return fail(path, 'an object');
  if (typeof value.status !== 'number') fail(`${path}.status`, 'a number');
  if (!('body' in value)) fail(`${path}.body`, 'present');
  return { status: value.status, body: value.body };
}

/** Reads a fixture file's JSON; throws, naming the path, when it is not one this version can replay. */
export function parseFixture(value: unknown): ApprovalFixture {
  if (!isObject(value)) return fail('$', 'an object');
  const header = value.header;
  if (!isObject(header)) return fail('$.header', 'an object');
  if (header.format !== FIXTURE_FORMAT) fail('$.header.format', String(FIXTURE_FORMAT));
  const source = header.source;
  if (source !== 'hosted' && source !== 'mock') fail('$.header.source', 'hosted or mock');
  stringAt(header, 'capturedAt', '$.header');
  stringAt(header, 'origin', '$.header');
  stringAt(header, 'serviceVersion', '$.header');
  stringAt(header, 'script', '$.header');
  if (header.provisional !== undefined && header.provisional !== true) {
    fail('$.header.provisional', 'true or absent');
  }
  if (header.provisional === true) stringAt(header, 'note', '$.header');
  const ids = value.ids;
  if (!isObject(ids)) return fail('$.ids', 'an object');
  stringAt(ids, 'approval', '$.ids');
  const steps = value.steps;
  if (!Array.isArray(steps) || steps.length === 0) return fail('$.steps', 'a non-empty array');
  steps.forEach((raw: unknown, index) => {
    const at = `$.steps[${String(index)}]`;
    if (!isObject(raw)) return fail(at, 'an object');
    if (raw.name !== 'pending' && raw.name !== 'consumed')
      fail(`${at}.name`, 'pending or consumed');
    replyAt(raw.list, `${at}.list`);
    replyAt(raw.detail, `${at}.detail`);
    if (raw.record !== undefined) replyAt(raw.record, `${at}.record`);
    if (!Array.isArray(raw.stream)) fail(`${at}.stream`, 'an array');
    for (const event of raw.stream as unknown[]) {
      if (!isObject(event) || typeof event.event !== 'string' || !isObject(event.data)) {
        fail(`${at}.stream[]`, '{event, data}');
      }
    }
  });
  replyAt(value.capabilities, '$.capabilities');
  return value as unknown as ApprovalFixture;
}

/** The step called `name`; throws when the capture did not reach it. */
export function stepOf(fixture: ApprovalFixture, name: StepName): FixtureStep {
  const step = fixture.steps.find((s) => s.name === name);
  if (step === undefined) throw new Error(`the fixture has no ${name} step`);
  return step;
}

export interface Replay {
  readonly fetch: typeof fetch;
  /** `METHOD path` of every request, in order. */
  readonly calls: string[];
  /** Requests the fixture has no answer for; each was answered 404. */
  readonly unexpected: string[];
}

const toResponse = (reply: FixtureReply): Response =>
  typeof reply.body === 'string' && reply.status >= 400
    ? new Response(reply.body, { status: reply.status })
    : jsonResponse(reply.body, reply.status);

/**
 * A `fetch` that answers as the recorded service did at `step`: the capabilities, the list, the single read, the
 * record, and a stream that delivers the step's frames and stays open. Anything else is a 404 and is listed in
 * `unexpected`, so a test can fail on a request the recording does not cover.
 *
 * With `transition`, the reads answer as at `step` until the stream delivers the frames of `transition` (which it
 * does once the single read has been served and the stream is open); from then on the reads and the record answer
 * as at `transition`. The hook treats a frame as a hint to read again, so nothing but a frame it recognises can take
 * it from `step` to `transition`.
 */
export function replayFetch(
  fixture: ApprovalFixture,
  step: FixtureStep,
  options: { readonly transition?: FixtureStep } = {}
): Replay {
  const calls: string[] = [];
  const unexpected: string[] = [];
  const approvalPath = `/v1/approvals/${fixture.ids.approval}`;
  const recordPath =
    fixture.ids.record === undefined ? undefined : `/v1/records/${fixture.ids.record}`;
  const transition = options.transition;
  const frames = transition === undefined ? step.stream : transition.stream;
  let stream: ReturnType<typeof handStream> | undefined;
  let detailServed = transition === undefined;
  let moved = transition === undefined;
  const at = (): FixtureStep => (moved ? (transition ?? step) : step);
  const release = (): void => {
    if (stream === undefined || !detailServed) return;
    for (const frame of frames) {
      stream.push(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
    }
    stream = undefined;
    moved = true;
  };
  const replayed: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (request.method === 'GET') {
      if (path === '/v1/capabilities') return Promise.resolve(toResponse(fixture.capabilities));
      if (path === '/v1/approvals/stream') {
        const opened = handStream();
        opened.push(': connected\n\n');
        stream = opened;
        release();
        return Promise.resolve(opened.response());
      }
      if (path === '/v1/approvals') return Promise.resolve(toResponse(at().list));
      if (path === approvalPath) {
        const served = toResponse(at().detail);
        detailServed = true;
        release();
        return Promise.resolve(served);
      }
      const record = at().record;
      if (path === recordPath && record !== undefined) return Promise.resolve(toResponse(record));
    }
    unexpected.push(`${request.method} ${path}`);
    return Promise.resolve(problemResponse(404, 'not_found'));
  };
  return { fetch: replayed, calls, unexpected };
}
