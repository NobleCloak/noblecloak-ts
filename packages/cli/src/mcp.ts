import { interrupted, interruptedError, requestSignal } from './abortable.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';

/** The header that names the external run a service principal's gated call belongs to. */
export const EXTERNAL_RUN_HEADER = 'x-noblecloak-external-run-id';

export interface ToolCall {
  /** The gateway's MCP endpoint, `<MCP origin>/v1/mcp`. */
  readonly url: string;
  /** The service principal's access token for the gateway audience. Sent in `Authorization` only. */
  readonly token: string;
  readonly runId: string;
  /** The MCP tool name, e.g. `int_sandbox_create_note`. */
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * What the gateway answered. `result`: the call ran (`isError` is the tool's own failure, `text` its text
 * content). `refused`: a JSON-RPC error or a non-2xx answer, with the HTTP status and the code the gateway
 * gave: `error.data.code`, else the JSON-RPC `error.code`, else (a non-JSON-RPC answer) its string `error`.
 * A non-JSON-RPC answer with no string `error` has code `''` and the first 200 characters of its body as
 * `message`.
 */
export type ToolOutcome =
  | { readonly kind: 'result'; readonly isError: boolean; readonly text: string }
  | {
      readonly kind: 'refused';
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const MAY_BE_SPENT =
  'The write may or may not have been made; its approval may be spent, so do not send it again with the same approval.';

/**
 * One JSON-RPC `tools/call` to the gateway, sessionless (the gateway serves such a POST on its own and
 * answers JSON). It sends once and never retries: a call the gateway admitted spends its approval. A
 * request that fails before an answer arrives, a body that cannot be read, and a 2xx without a `result`
 * therefore all say the write may have happened. A non-2xx answer that is not JSON-RPC carries the start of
 * its body as the `message`.
 */
export async function callTool(io: Io, call: ToolCall): Promise<ToolOutcome> {
  let response: Response;
  const signal = requestSignal(io);
  try {
    response = await io.fetch(call.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${call.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [EXTERNAL_RUN_HEADER]: call.runId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: call.name, arguments: call.arguments },
      }),
      signal,
    });
  } catch {
    if (interrupted(io)) {
      throw interruptedError(MAY_BE_SPENT);
    }
    throw new CliError(EXIT.failed, `The MCP gateway did not answer. ${MAY_BE_SPENT}`);
  }
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    // The gateway answered, so it may have admitted the call: the body is what says whether it ran.
    if (interrupted(io)) throw interruptedError(MAY_BE_SPENT);
    throw new CliError(
      EXIT.failed,
      `The MCP gateway answered ${String(response.status)} but its answer could not be read. ${MAY_BE_SPENT}`
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  const envelope = isRecord(body) ? body : {};
  const error = envelope.error;
  if (isRecord(error)) {
    const data = isRecord(error.data) ? error.data : {};
    const code = text(data.code) || (typeof error.code === 'number' ? String(error.code) : '');
    return { kind: 'refused', status: response.status, code, message: text(error.message) };
  }
  if (!response.ok) {
    // Not a JSON-RPC answer: the gateway's own auth layer (a 401) or a proxy. Its body is the only reason
    // there is, so a short piece of it goes into the message when it names no `error`.
    const code = text(envelope.error);
    return {
      kind: 'refused',
      status: response.status,
      code,
      message: code === '' ? raw.trim().slice(0, 200) : '',
    };
  }
  const result = envelope.result;
  if (!isRecord(result)) {
    throw new CliError(
      EXIT.failed,
      `The MCP gateway answered ${String(response.status)} without a result. ${MAY_BE_SPENT}`
    );
  }
  const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const parts = content.flatMap((part) =>
    isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  );
  return { kind: 'result', isError: result.isError === true, text: parts.join('\n') };
}
