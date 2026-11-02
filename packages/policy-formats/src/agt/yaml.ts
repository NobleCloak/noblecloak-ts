/**
 * The deterministic YAML printer for an AGT manifest: block style, two-space indentation, every string a
 * double-quoted scalar, object members in the order given (callers sort what is not fixed).
 */
import { PolicyFormatError } from '../errors.js';
import { quote } from '../pointer.js';
import type { JsonValue } from '../types.js';
import { hasLoneSurrogate } from '../validate.js';

/**
 * Lowercase words a YAML 1.1 or 1.2 core-schema reader resolves to something other than a string (null,
 * a boolean): written plain they would not read back as the key that was meant.
 */
const RESERVED = new Set(['null', 'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n']);

/** A plain key for a lowercase identifier that reads back as itself; any other key double-quoted. */
export function yamlKey(key: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(key) && !RESERVED.has(key) ? key : quote(key);
}

/** The deepest nesting of a value the printer writes (a cycle would otherwise never end). */
const MAX_DEPTH = 64;

function checkString(value: string): string {
  if (hasLoneSurrogate(value))
    throw new PolicyFormatError(
      'invalid_input',
      'a string in the manifest holds an unpaired UTF-16 surrogate, which YAML cannot represent'
    );
  return value;
}

function scalar(value: JsonValue): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new PolicyFormatError('invalid_input', 'a number in the manifest must be finite');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return quote(checkString(value));
  if (Array.isArray(value)) return value.length === 0 ? '[]' : undefined;
  if (typeof value === 'object') return Object.keys(value).length === 0 ? '{}' : undefined;
  throw new PolicyFormatError(
    'invalid_input',
    `a ${typeof value} has no YAML form in the manifest`
  );
}

/** The lines of a JSON value in block style at indentation zero; object members sorted by key. */
export function yamlLines(value: JsonValue, depth = 0): string[] {
  if (depth > MAX_DEPTH)
    throw new PolicyFormatError(
      'invalid_input',
      `a value in the manifest nests deeper than ${String(MAX_DEPTH)} levels (or refers to itself)`
    );
  const inline = scalar(value);
  if (inline !== undefined) return [inline];
  if (Array.isArray(value)) {
    return (value as readonly JsonValue[]).flatMap((item) => {
      const [first = '', ...rest] = yamlLines(item, depth + 1);
      return [`- ${first}`, ...rest.map((line) => `  ${line}`)];
    });
  }
  const object = value as Readonly<Record<string, JsonValue>>;
  return Object.keys(object)
    .sort()
    .flatMap((key) => member(key, object[key] as JsonValue, depth + 1));
}

/**
 * The longest key written as an implicit key (`key: value`). YAML allows at most 1024 characters
 * there; a longer one is written as an explicit key (`? key` and `: value` on the next line).
 */
const MAX_IMPLICIT_KEY = 1000;

/** `key: value` on one line, or `key:` and the value's lines indented below it. */
export function member(key: string, value: JsonValue, depth = 0): string[] {
  const written = yamlKey(checkString(key));
  const inline = scalar(value);
  const lines =
    inline === undefined ? yamlLines(value, depth).map((line) => `  ${line}`) : undefined;
  if (written.length > MAX_IMPLICIT_KEY)
    return lines === undefined
      ? [`? ${written}`, `: ${inline ?? ''}`]
      : [`? ${written}`, ':', ...lines];
  return lines === undefined ? [`${written}: ${inline ?? ''}`] : [`${written}:`, ...lines];
}

/** `key: |` and the text as a literal block scalar; the text ends with exactly one newline. */
export function literalBlock(key: string, text: string, indent: string): string[] {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return [
    `${indent}${yamlKey(key)}: |`,
    ...body.split('\n').map((line) => (line === '' ? '' : `${indent}  ${line}`)),
  ];
}
