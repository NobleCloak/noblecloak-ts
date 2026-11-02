import { findDuplicateKey } from '../json-source.js';

/** A number that is shown as the text it was sent as. */
class SentNumber {
  constructor(readonly source: string) {}
}

/** Reads the `context.source` that a JSON.parse reviver gets, where the runtime has it (Chrome 114, Safari 18.4, Firefox 135, Node 21, Bun). */
const detectSourceNumbers = (): boolean => {
  try {
    let seen: string | undefined;
    JSON.parse('1.0', (_key: string, value: unknown, context?: { source?: string }) => {
      seen = context?.source;
      return value;
    });
    return seen === '1.0';
  } catch {
    return false;
  }
};

/** True when this runtime lets a reviver read the text of a number, so numbers can be shown exactly as sent. */
export const SOURCE_NUMBERS: boolean = detectSourceNumbers();

/** Options for `formatJson`. */
export interface FormatJsonOptions {
  /** The text is cut after this many UTF-16 code units; `Infinity` cuts nothing. */
  readonly maxChars: number;
  /** A container nested deeper than this shows as a count (the outermost container is depth 1); `Infinity` shows all. */
  readonly maxDepth: number;
  /** The text of a container shown as a count, so the host can translate it. */
  readonly summary: {
    readonly items: (count: number) => string;
    readonly members: (count: number) => string;
  };
  /** Test seam: read numbers from the source text (`true`) or judge parsed numbers (`false`). Default: what the runtime supports. */
  readonly sourceNumbers?: boolean;
}

/** Output longer than this is not built at all (2 MiB of UTF-16 code units, indentation included). */
export const MAX_JSON_CHARS = 2 * 1024 * 1024;

export interface FormattedJson {
  /** The pretty-printed text, at most `maxChars` code units long; empty when `tooLarge`. */
  readonly text: string;
  /** How many code units were cut off the end; 0 when the text is whole. */
  readonly omitted: number;
  /** How many containers deeper than `maxDepth` are shown as a count instead of their content. */
  readonly summarised: number;
  /** True when the output would be longer than `MAX_JSON_CHARS` (or the value is too deeply nested to walk): nothing is printed. */
  readonly tooLarge: boolean;
  /** How many numbers this browser cannot show exactly as sent (too large, `-0`, or beyond a double). */
  readonly inexact: number;
  /** A key that an object names twice, when there is one: the text shows only the last. */
  readonly duplicateKey?: string;
}

/** True when everything the value holds is in `text`, exactly: nothing cut, summarised, inexact or repeated, and not too large. */
export const isWhole = (shown: FormattedJson): boolean =>
  shown.omitted === 0 &&
  shown.summarised === 0 &&
  shown.inexact === 0 &&
  shown.duplicateKey === undefined &&
  !shown.tooLarge;

// Characters that would let a value reorder or hide what the approver reads are shown as escapes: every
// Unicode Default_Ignorable_Code_Point (zero-width characters, the soft hyphen, the combining grapheme joiner,
// variation selectors, Hangul and Khmer fillers, the tag block) and every Bidi_Control, plus what that data
// leaves out: the interlinear annotation marks U+FFF9-FFFB, and the line and paragraph separators U+2028
// and U+2029, which break lines.
// What the runtime's Unicode data classes as neither renders as received.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\u2028\u2029\uFFF9-\uFFFB]/gu;

/**
 * Shows the invisible and bidirectional-control characters of a server-controlled string as escapes. Anything that is not a string is shown as its text (nothing for null or undefined).
 *
 * @internal
 */
export function escapeInvisible(text: unknown): string {
  // A malformed field can be any value; its String() form is what is shown.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const shown = typeof text === 'string' ? text : String(text ?? '');
  return shown.replace(INVISIBLE, (char) => {
    const hex = (char.codePointAt(0) ?? 0).toString(16).toUpperCase();
    // Four digits below U+10000 (`\u202E`); braces above it (`\u{E0041}`).
    return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
  });
}

/** A JSON string literal; JSON escaping makes control characters visible, then the invisible ones are escaped. */
function quote(text: string): string {
  return escapeInvisible(JSON.stringify(text));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Tally {
  summarised: number;
  inexact: number;
  /** Characters written so far, with their indentation; the walk stops past `MAX_JSON_CHARS`. */
  written: number;
}

/** Thrown by the walk when the output would pass `MAX_JSON_CHARS`. */
class OutputTooLarge extends Error {}

function count(tally: Tally, indent: string, text: string): void {
  tally.written += indent.length + text.length + 2;
  if (tally.written > MAX_JSON_CHARS) throw new OutputTooLarge();
}

/** A parsed number that its text may not have been: past a safe integer, `-0`, or not finite. Finite fractions cannot be judged. */
const isDoubtful = (n: number): boolean =>
  !Number.isFinite(n) || Object.is(n, -0) || (Number.isInteger(n) && !Number.isSafeInteger(n));

function write(
  value: unknown,
  depth: number,
  options: FormatJsonOptions,
  indent: string,
  tally: Tally
): string {
  const { maxDepth, summary } = options;
  if (value instanceof SentNumber) {
    count(tally, indent, value.source);
    return value.source;
  }
  if (typeof value === 'string') {
    const text = quote(value);
    count(tally, indent, text);
    return text;
  }
  if (typeof value === 'number') {
    if (isDoubtful(value)) tally.inexact += 1;
    const text = Object.is(value, -0) ? '-0' : String(value);
    count(tally, indent, text);
    return text;
  }
  if (typeof value === 'boolean') {
    count(tally, indent, 'false');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth > maxDepth) {
      tally.summarised += 1;
      return summary.items(value.length);
    }
    count(tally, indent, '[');
    const inner = `${indent}  `;
    const items = (value as readonly unknown[]).map(
      (item) => `${inner}${write(item, depth + 1, options, inner, tally)}`
    );
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    if (depth > maxDepth) {
      tally.summarised += 1;
      return summary.members(entries.length);
    }
    count(tally, indent, '{');
    const inner = `${indent}  `;
    const members = entries.map(([key, member]) => {
      const name = quote(key);
      count(tally, inner, name);
      return `${inner}${name}: ${write(member, depth + 1, options, inner, tally)}`;
    });
    return `{\n${members.join(',\n')}\n${indent}}`;
  }
  // null, and anything that is not JSON (undefined, a function, a symbol, a bigint).
  return 'null';
}

/** The value of `source` with every number replaced by the text it was sent as; `undefined` when `source` is not JSON. */
function parseWithSentNumbers(source: string): { readonly value: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(
      source,
      (_key: string, member: unknown, context?: { source?: string }) =>
        typeof member === 'number' && typeof context?.source === 'string'
          ? new SentNumber(context.source)
          : member
    );
    return { value };
  } catch {
    return undefined;
  }
}

/**
 * Pretty-prints an untrusted JSON value as plain text: two-space indent, members in the object's own order.
 * JavaScript orders integer-like keys ("1", "2") before the others, so a parsed object can show members in a
 * different order from the text it came from; this function receives the object and cannot recover that.
 * The caller puts the result in one text node; nothing in it is interpreted.
 *
 * With `source` (the text `value` was parsed from) numbers are shown as sent (`12345678901234567890`, `1.0`,
 * `-0`, `1e400`) where the runtime lets a reviver read them, and a key named twice is reported in
 * `duplicateKey`. Without `source`, or where the runtime cannot, a number that a double may not hold exactly
 * (past a safe integer, `-0`, not finite) is counted in `inexact`; a finite fraction cannot be judged and shows
 * as `String(n)`.
 * The walk stops once the output passes `MAX_JSON_CHARS`: nothing is printed then (`tooLarge`).
 */
export function formatJson(
  value: unknown,
  options: FormatJsonOptions,
  source?: string
): FormattedJson {
  const duplicateKey = source === undefined ? undefined : findDuplicateKey(source);
  const tooLarge: FormattedJson = {
    text: '',
    omitted: 0,
    summarised: 0,
    tooLarge: true,
    inexact: 0,
    ...(duplicateKey === undefined ? {} : { duplicateKey }),
  };
  const tally: Tally = { summarised: 0, inexact: 0, written: 0 };
  let tree = value;
  if (source !== undefined && (options.sourceNumbers ?? SOURCE_NUMBERS)) {
    tree = parseWithSentNumbers(source)?.value ?? value;
  }
  let full: string;
  try {
    full = write(tree, 1, options, '', tally);
  } catch {
    // Output past the ceiling, or nesting deep enough to overflow the stack: too large to show.
    return tooLarge;
  }
  const common = {
    summarised: tally.summarised,
    tooLarge: false,
    inexact: tally.inexact,
    ...(duplicateKey === undefined ? {} : { duplicateKey }),
  };
  if (full.length <= options.maxChars) return { text: full, omitted: 0, ...common };
  let end = options.maxChars;
  // Do not cut between the two halves of a surrogate pair.
  const last = full.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: full.slice(0, end), omitted: full.length - end, ...common };
}
