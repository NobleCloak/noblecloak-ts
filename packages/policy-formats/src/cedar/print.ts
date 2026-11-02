/**
 * The deterministic Cedar printer. Its output is a function of the statements alone and does not follow
 * Cedar's formatter (`cedar format`, `formatPolicies`), whose bytes change with its version: annotations
 * in the order given, the scope one element per line, two-space indentation, LF line ends, one blank line
 * between statements and a trailing newline.
 */
import type { EntityRef, Scope, Statement } from './ast.js';

/**
 * Code points written as `\u{...}`: the C0 and C1 controls and DEL (Cedar strings may hold them raw,
 * a YAML block scalar may not), the Unicode line and paragraph separators, the two noncharacters YAML
 * excludes, and every code point that would make a statement read other than it is (Trojan Source): the
 * bidirectional controls, every other default-ignorable code point (zero-width characters, the byte-order
 * mark, variation selectors, tags) and the interlinear annotation marks. Printable text is written as itself.
 */
/* eslint-disable no-control-regex -- the control characters are what this class matches */
const ESCAPED =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufff9-\ufffb\ufffe\uffff\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu;
/* eslint-enable no-control-regex */

/** A Cedar string literal: Cedar's escapes for `"`, `\`, LF, CR and tab, `\u{hex}` for the code points above. */
export function cedarString(value: string): string {
  const body = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
    .replace(ESCAPED, (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`);
  return `"${body}"`;
}

export function entity(ref: EntityRef): string {
  return `${ref.type}::${cedarString(ref.id)}`;
}

function scope(variable: 'principal' | 'action' | 'resource', value: Scope): string {
  return value.op === 'All' ? variable : `${variable} ${value.op} ${entity(value.entity)}`;
}

export function printStatement(statement: Statement): string {
  const lines = statement.annotations.map(([key, value]) => `@${key}(${cedarString(value)})`);
  lines.push(
    `${statement.effect} (`,
    `  ${scope('principal', statement.principal)},`,
    `  ${scope('action', statement.action)},`,
    `  ${scope('resource', statement.resource)}`
  );
  if (statement.resourceIn === undefined) {
    lines.push(');');
  } else {
    lines.push(
      ')',
      'when {',
      '  [',
      statement.resourceIn.map((ref) => `    ${entity(ref)}`).join(',\n'),
      '  ].contains(resource)',
      '};'
    );
  }
  return lines.join('\n');
}

/** Statements separated by a blank line, with a trailing newline; an empty list prints as the empty string. */
export function printStatements(statements: readonly Statement[]): string {
  return statements.length === 0 ? '' : `${statements.map(printStatement).join('\n\n')}\n`;
}
