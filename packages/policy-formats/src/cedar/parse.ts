/**
 * Cedar text → classified statements, through cedar-wasm (loaded lazily: this module is reached only from
 * the `@noblecloak/policy-formats/import` entry).
 */
import { PolicyFormatError } from '../errors.js';
import { pointer, quote } from '../pointer.js';
import { HEADER_LINE_STARTS, HEADER_MARK } from '../report.js';
import type { CedarParser, ImportOptions, ReportEntry } from '../types.js';
import type { Dialect } from './ast.js';
import { decodeStatement } from './decode.js';
import type { ToolResolver } from './decode.js';

export async function loadCedar(option: ImportOptions['cedar']): Promise<CedarParser> {
  if (option !== undefined && typeof option !== 'function') return option;
  try {
    return option === undefined ? await import('@cedar-policy/cedar-wasm') : await option();
  } catch (error) {
    throw new PolicyFormatError(
      'cedar_unavailable',
      '@cedar-policy/cedar-wasm 4.14.0 (an optional peer dependency) could not be loaded: install it, or pass opts.cedar; the cause says why it failed',
      [],
      { cause: error }
    );
  }
}

/** The deepest bracket nesting a statement may hold. cedar-wasm 4.14.0 runs out of memory near 110. */
export const MAX_NESTING = 64;
/**
 * The most tokens one statement may hold. cedar-wasm 4.14.0 overflows its stack on a chain of about
 * 3,000 binary operators (about 6,000 tokens) of any kind; a statement this package writes for a policy
 * with 100 tools holds under 1,000.
 */
export const MAX_TOKENS = 2048;

/** Cedar's two-character tokens; every other token is one character, an identifier, a number or a string. */
const TWO_CHAR = new Set(['::', '==', '!=', '<=', '>=', '&&', '||']);
/** Cedar's one-character tokens (`grammar.lalrpop`, the `match` block). */
const ONE_CHAR = new Set([
  '@',
  '.',
  ',',
  ';',
  ':',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '=',
]);
/** The whitespace this check accepts: ASCII only. Cedar's `\s` accepts more; such input is refused. */
const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const IDENT_START = /[_a-zA-Z]/;
const IDENT_PART = /[_a-zA-Z0-9]/;

/**
 * Refuses text with a statement nested deeper than {@link MAX_NESTING} brackets or longer than
 * {@link MAX_TOKENS} tokens, before the parser sees it. cedar-wasm's recursive descent exhausts its memory
 * or stack on such input and is left unusable for every later call in the same process, so the check
 * cannot wait for its error.
 *
 * It tokenises as Cedar's lexer does (cedar-policy-core `src/parser/grammar.lalrpop`): a line comment runs
 * from `//` to the next `\n` or `\r`; a string is `"` then escapes (`\` and any character but a line
 * break) or characters other than `"` and `\`, then `"`; an identifier is `[_a-zA-Z][_a-zA-Z0-9]*`, a
 * slot `?` and one; a number `[0-9]+`; then the two- and one-character tokens. Every token counts, so no
 * operator chain gets past the limit. It fails closed: a character outside these rules, an unterminated
 * string or a non-ASCII space is refused here rather than left to a lexer this check might disagree with.
 */
export function checkComplexity(text: string): void {
  let depth = 0;
  let tokens = 0;
  const refuse = (what: string): never => {
    throw new PolicyFormatError(
      'parse_error',
      `${what}; it is refused before parsing, since the Cedar parser exhausts its memory on deep or long statements`
    );
  };
  let index = 0;
  while (index < text.length) {
    const ch = text[index] ?? '';
    if (WHITESPACE.has(ch)) {
      index += 1;
      continue;
    }
    if (ch === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
      continue;
    }
    tokens += 1;
    if (ch === '"') {
      index += 1;
      for (;;) {
        const inner = text[index];
        if (inner === undefined) refuse('a string is not terminated');
        if (inner === '"') break;
        if (inner === '\\') {
          const escaped = text[index + 1];
          if (escaped === undefined || escaped === '\n' || escaped === '\r')
            refuse('a string escapes a line break or ends in an escape');
          index += 2;
        } else {
          index += 1;
        }
      }
      index += 1;
    } else if (IDENT_START.test(ch) || (ch === '?' && IDENT_START.test(text[index + 1] ?? ''))) {
      index += 1;
      while (index < text.length && IDENT_PART.test(text[index] ?? '')) index += 1;
    } else if (/[0-9]/.test(ch)) {
      while (index < text.length && /[0-9]/.test(text[index] ?? '')) index += 1;
    } else if (TWO_CHAR.has(text.slice(index, index + 2))) {
      index += 2;
    } else if (ONE_CHAR.has(ch)) {
      if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
        if (depth > MAX_NESTING)
          refuse(`a statement nests deeper than ${String(MAX_NESTING)} brackets`);
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth = Math.max(0, depth - 1);
      } else if (ch === ';' && depth === 0) {
        tokens = 0;
      }
      index += 1;
    } else {
      refuse(
        `the character ${quote(ch)} at offset ${String(index)} is not one Cedar's lexer reads outside a string`
      );
    }
    if (tokens > MAX_TOKENS) refuse(`a statement holds more than ${String(MAX_TOKENS)} tokens`);
  }
}

/** A parser call, with anything it throws turned into `parse_error`. */
function guarded<T>(call: () => T, what: string): T {
  try {
    return call();
  } catch (error) {
    throw new PolicyFormatError(
      'parse_error',
      `the Cedar parser failed on ${what}: ${error instanceof Error ? error.message : String(error)}`,
      [],
      { cause: error }
    );
  }
}

/** Statements of a Cedar policy set, decoded in file order; templates are reported, never imported. */
export function parsePolicySet(
  cedar: CedarParser,
  text: string,
  base: string,
  dialect: Dialect,
  resolveTool: ToolResolver
): {
  statements: { path: string; decoded: ReturnType<typeof decodeStatement> }[];
  templates: ReportEntry[];
} {
  checkComplexity(text);
  const parts = guarded(() => cedar.policySetTextToParts(text), 'the policy set');
  if (parts.type === 'failure')
    throw new PolicyFormatError(
      'parse_error',
      `not a Cedar policy set: ${parts.errors.map((error) => error.message).join('; ')}`,
      parts.errors.map((error) => error.message)
    );
  const templates = parts.policy_templates.map((_, index) => ({
    path: `${base}${pointer('templates', index)}`,
    reason: 'a template (a policy with slots) has no NobleCloak form',
  }));
  const statements = parts.policies.map((policy, index) => {
    const path = `${base}${pointer('policies', index)}`;
    const json = guarded(() => cedar.policyToJson(policy), `statement ${String(index)}`);
    if (json.type === 'failure')
      throw new PolicyFormatError(
        'parse_error',
        `statement ${String(index)} does not convert to Cedar's JSON format: ${json.errors.map((error) => error.message).join('; ')}`,
        json.errors.map((error) => error.message)
      );
    return { path, decoded: decodeStatement(json.json, path, dialect, resolveTool) };
  });
  return { statements, templates };
}

/**
 * Text without the comment block this package writes at its top: the first line `<marker> NobleCloak
 * tool_invocation policies...` and the lines after it that begin as the exporters' lines do
 * (`HEADER_LINE_STARTS`). A comment written by hand below the block is kept, and so is noticed.
 */
export function withoutOwnHeader(text: string, marker: '//' | '#'): string {
  if (!text.startsWith(`${marker} ${HEADER_MARK}`)) return text;
  const lines = text.split('\n');
  let index = 1;
  while (
    index < lines.length &&
    HEADER_LINE_STARTS.some((start) => (lines[index] ?? '').startsWith(`${marker} ${start}`))
  )
    index += 1;
  return lines.slice(index).join('\n');
}

/**
 * Whether Cedar text holds a `//` comment other than the comment block this package writes at its top.
 * String literals are skipped, so `"//"` inside an entity id is no comment. (Cedar has line comments only.)
 */
export function hasForeignCedarComments(text: string): boolean {
  const rest = withoutOwnHeader(text, '//');
  for (let index = 0; index < rest.length; index += 1) {
    const ch = rest[index];
    if (ch === '"') {
      index += 1;
      while (index < rest.length && rest[index] !== '"') index += rest[index] === '\\' ? 2 : 1;
    } else if (ch === '/' && rest[index + 1] === '/') {
      return true;
    }
  }
  return false;
}

export const EMPTY_NOTE = 'The policy set holds no statement, so there is nothing to import.';

export const COMMENTS_NOTE =
  'Comments and formatting are not kept: an export writes its own layout and comment block.';
