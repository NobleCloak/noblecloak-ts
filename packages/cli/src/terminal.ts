import type { Io } from './io.js';

/**
 * C0 controls except tab and newline, DEL, and the C1 controls. A principal's name, an error message or any
 * other string the server returns can carry them, and a terminal acts on them: an escape sequence in a name
 * could redraw the revoke prompt to show a different principal than the one being revoked.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Characters that move or reorder text without being controls: the line and paragraph separators and the
 * bidirectional formatting marks. A right-to-left override in a name could show its characters reversed.
 */
const REORDERING = /[\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `text` with every character a terminal would act on removed. Tabs and newlines are kept. */
export function forTerminal(text: string): string {
  return text.replace(CONTROL, '').replace(REORDERING, '');
}

/**
 * A server-supplied value for a single line (a table cell, the revoke prompt, an error message): tabs and
 * newlines become spaces, so a name cannot start a line of its own that looks like the command's output.
 * The stream-level `forTerminal` still runs afterwards.
 */
export function oneLine(text: string): string {
  return text.replace(/[\t\n]/g, ' ');
}

/**
 * `value` as JSON with DEL, the C1 controls and the reordering characters written as `\u` escapes.
 * `JSON.stringify` escapes the C0 controls but leaves these raw, so `forTerminal` would otherwise strip them
 * and change the value.
 */
export function jsonForTerminal(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/**
 * `io` with everything written to the terminal passed through `forTerminal`: stdout, stderr and the
 * prompt. `--json` output goes through `jsonForTerminal` first, so it has no controls left to strip.
 */
export function terminalSafe(io: Io): Io {
  return {
    ...io,
    stdout: (text) => {
      io.stdout(forTerminal(text));
    },
    stderr: (text) => {
      io.stderr(forTerminal(text));
    },
    readLine: (prompt) => io.readLine(forTerminal(prompt)),
  };
}
