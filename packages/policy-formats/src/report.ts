/**
 * The export report and the comment block that carries it at the top of an exported file. The block is a
 * function of the exported content and options only, so re-exporting an imported file this package wrote
 * reproduces it.
 */
import { compareCodeUnits } from './canonical.js';
import { quote } from './pointer.js';
import { PolicyFormatError } from './errors.js';
import type { ReportEntry } from './types.js';

/**
 * What must never reach a comment line raw: every control character (CR, LF, VT, FF and NEL end a line or a
 * YAML comment), DEL and the C1 controls, the Unicode line and paragraph separators, every bidirectional
 * control (U+202A–202E, U+2066–2069, U+200E/200F, U+061C: a line that reads one way and is another) and every
 * other default-ignorable code point (zero-width characters, the byte-order mark, variation selectors, tags),
 * the interlinear annotation marks U+FFF9–FFFB, the noncharacters YAML excludes, and an unpaired surrogate
 * (no valid UTF-8 holds one). With the `u` flag a paired surrogate is one code point and never matches.
 */
const UNSAFE_IN_COMMENT =
  /[\p{Cc}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}\u2028\u2029\ufff9-\ufffb\ufffe\uffff]|\p{Cs}/gu;
const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/;

/**
 * A comment line with every unsafe code point written as a visible escape (`\uXXXX`, or `\u{XXXXX}` above the
 * Basic Multilingual Plane), so input can neither end the comment nor make it read other than it is.
 */
export function commentSafe(line: string): string {
  return line.replace(UNSAFE_IN_COMMENT, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** The first words of every comment block this package writes; an import recognises its own block by them. */
export const HEADER_MARK = 'NobleCloak tool_invocation policies';

/**
 * How every line of the comment block after the first begins (without the comment marker): the format line,
 * the notes the exporters write, and the report lines. An import treats a leading run of such lines as
 * the block this package wrote, and any other comment as one written by hand.
 */
export const HEADER_LINE_STARTS = [
  'Format: ',
  'A call no policy ',
  'Role and group subjects ',
  'The manifest binds ',
  'Tool names ',
  'AGT 5.0 evaluates ',
  'AGT passes one ',
  'Lossy: ',
  'Not exported: ',
] as const;

/** `/3/config/mode` with policy key `p` reads `policy "p" /config/mode`: the index of the input array is dropped. */
function describe(entry: ReportEntry): string {
  const below = entry.path.replace(/^\/[^/]*/, '');
  const subject =
    entry.policy === undefined
      ? entry.path
      : `policy ${quote(entry.policy)}${below === '' ? '' : ` ${below}`}`;
  return commentSafe(`${subject}: ${entry.reason}`);
}

function sorted(entries: readonly ReportEntry[]): string[] {
  return entries.map(describe).sort(compareCodeUnits);
}

/** The lines of the comment block, without the comment marker. */
export function headerLines(
  format: string,
  notes: readonly string[],
  lossy: readonly ReportEntry[],
  unsupported: readonly ReportEntry[]
): string[] {
  return [
    `${HEADER_MARK}, written by @noblecloak/policy-formats.`,
    `Format: ${format}.`,
    ...notes,
    ...sorted(lossy).map((line) => `Lossy: ${line}`),
    ...sorted(unsupported).map((line) => `Not exported: ${line}`),
  ];
}

/**
 * Each line behind `marker` and a space, then a blank line. Every line goes through {@link commentSafe}:
 * paths carry input keys verbatim (a JSON pointer only escapes `~` and `/`), so nothing else keeps them
 * on one line.
 */
export function commentBlock(marker: '//' | '#', lines: readonly string[]): string {
  const safe = lines.map(commentSafe);
  // Defence in depth: commentSafe escapes every break, so this never throws; if it ever did, the
  // export would refuse rather than write a line that ends the comment early.
  for (const line of safe)
    /* v8 ignore next 2 -- unreachable while commentSafe escapes every break (see above) */
    if (LINE_BREAK.test(line))
      throw new PolicyFormatError('invalid_input', 'a comment line would hold a line break');
  return `${safe.map((line) => `${marker} ${line}`).join('\n')}\n\n`;
}
