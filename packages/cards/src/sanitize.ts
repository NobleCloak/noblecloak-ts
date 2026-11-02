import { CALL_MAX_DEPTH, CALL_MAX_STRING } from './limits.js';
import { CARD_TEXT, fill } from './text.js';

/**
 * The characters that would let a value reorder, hide or add to what the approver reads: every Unicode
 * Default_Ignorable_Code_Point and Bidi_Control, the interlinear annotation marks U+FFF9-FFFB, the line and
 * paragraph separators U+2028 and U+2029, every control character (C0, DEL and C1, so CR and LF too), and a lone
 * UTF-16 surrogate (which a strict JSON decoder refuses). A server string can then not start a line of its own
 * on a card.
 */
const INVISIBLE_ONE =
  /^[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Cc}\p{Cs}\u2028\u2029\ufff9-\ufffb]$/u;

/** One invisible or control character as an escape: `\u202E` below U+10000, `\u{E0041}` above it. */
function invisibleEscape(char: string): string {
  const hex = (char.codePointAt(0) ?? 0).toString(16).toUpperCase();
  return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
}

/** Shows the invisible, bidirectional-control and control characters (line breaks too) of a server string as escapes. */
export function escapeInvisible(text: string): string {
  let out = '';
  for (const char of text) out += INVISIBLE_ONE.test(char) ? invisibleEscape(char) : char;
  return out;
}

/**
 * Escapes one string for a platform and cuts it to `limit` characters, ending in "…" when it was cut. Invisible
 * and control characters, line breaks included, become escapes first, so the result has no line break at all;
 * `escapeChar` then maps every other character (it returns the character itself when it needs no escape). The cut falls between characters, never inside an escape or a surrogate pair,
 * so the result is never longer than `limit`.
 */
export function renderText(
  raw: string,
  limit: number,
  escapeChar: (char: string) => string
): string {
  const room = Math.max(limit - CARD_TEXT.more.length, 0);
  let out = '';
  let cutAt: number | undefined;
  for (const char of raw) {
    const piece = INVISIBLE_ONE.test(char) ? invisibleEscape(char) : escapeChar(char);
    if (cutAt === undefined && out.length + piece.length > room) cutAt = out.length;
    if (out.length + piece.length > limit) {
      return out.slice(0, cutAt ?? room) + CARD_TEXT.more;
    }
    out += piece;
  }
  return out;
}

/** The length of a string in bytes when encoded as UTF-16, which is how Teams counts a message (two bytes per code unit). */
export function utf16Length(text: string): number {
  return text.length * 2;
}

/** The UTF-8 length of a string in bytes, without TextEncoder or Buffer (this package names no runtime global). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Cuts a string to `max` code points of the original, ending in "…". Used inside the call text, before escaping. */
function cutString(text: string, max: number): { readonly text: string; readonly cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end) + CARD_TEXT.more, cut: true };
}

/** The call, printed. `text` is raw (a renderer escapes it); `tooLarge` and `unreadable` each mean nothing usable was built. */
export interface FormattedCall {
  readonly text: string;
  /** True when a string was cut or a deep container was shown as a count. */
  readonly shortened: boolean;
  /** True when the output grew past the build cap: no text is returned. */
  readonly tooLarge: boolean;
  /** True when reading the value threw (a getter or proxy that throws): no text is returned. */
  readonly unreadable: boolean;
}

/** The text is not built past this many characters; the renderers' own budgets are far lower. */
const BUILD_CAP = 20_000;

class Overflow extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Prints the call's arguments as indented JSON for a card. A string is cut at `CALL_MAX_STRING` characters,
 * a container nested deeper than `CALL_MAX_DEPTH` is shown as a count, and the build stops at `BUILD_CAP`
 * characters (the value is then `tooLarge`). It reads the value to a bounded depth, so a value nested 10 000
 * deep costs no more than one nested 8 deep. It never throws: an overflow gives `tooLarge`, any other error
 * while reading the value gives `unreadable`.
 */
export function formatCall(value: Readonly<Record<string, unknown>>): FormattedCall {
  let shortened = false;
  let used = 0;
  const spend = (text: string): string => {
    used += text.length;
    if (used > BUILD_CAP) throw new Overflow();
    return text;
  };
  const scalar = (item: unknown): string => {
    if (item === null) return 'null';
    switch (typeof item) {
      case 'string': {
        const cut = cutString(item, CALL_MAX_STRING);
        if (cut.cut) shortened = true;
        return JSON.stringify(cut.text);
      }
      case 'number':
        return JSON.stringify(item);
      case 'boolean':
        return item ? 'true' : 'false';
      case 'bigint':
        return item.toString();
      default:
        return '"[unsupported value]"';
    }
  };
  const key = (name: string): string => {
    const cut = cutString(name, CALL_MAX_STRING);
    if (cut.cut) shortened = true;
    return JSON.stringify(cut.text);
  };
  const write = (item: unknown, depth: number): string => {
    if (Array.isArray(item)) {
      if (depth > CALL_MAX_DEPTH) {
        shortened = true;
        return spend(`[${fill(CARD_TEXT.summaryItems, { count: String(item.length) })}]`);
      }
      if (item.length === 0) return spend('[]');
      const pad = '  '.repeat(depth);
      const parts: string[] = [];
      for (const entry of item as unknown[]) parts.push(spend(pad) + write(entry, depth + 1));
      return `[\n${parts.join(spend(',\n'))}\n${'  '.repeat(depth - 1)}]`;
    }
    if (isPlainObject(item)) {
      const names = Object.keys(item);
      if (depth > CALL_MAX_DEPTH) {
        shortened = true;
        return spend(`{${fill(CARD_TEXT.summaryMembers, { count: String(names.length) })}}`);
      }
      if (names.length === 0) return spend('{}');
      const pad = '  '.repeat(depth);
      const parts: string[] = [];
      for (const name of names) {
        parts.push(spend(`${pad}${key(name)}: `) + write(item[name], depth + 1));
      }
      return `{\n${parts.join(spend(',\n'))}\n${'  '.repeat(depth - 1)}}`;
    }
    return spend(scalar(item));
  };
  try {
    return { text: write(value, 1), shortened, tooLarge: false, unreadable: false };
  } catch (error) {
    const tooLarge = error instanceof Overflow;
    return { text: '', shortened: false, tooLarge, unreadable: !tooLarge };
  }
}
