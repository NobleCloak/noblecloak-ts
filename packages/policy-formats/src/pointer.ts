/** One JSON pointer reference token (RFC 6901): `~` becomes `~0` and `/` becomes `~1`. */
export function token(segment: string | number): string {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}

/** A JSON pointer from its unescaped segments. */
export function pointer(...segments: readonly (string | number)[]): string {
  return segments.map((segment) => `/${token(segment)}`).join('');
}

/**
 * Code points JSON leaves raw that a YAML scalar or comment must not hold raw: DEL and the C1 controls, the
 * Unicode line and paragraph separators, the noncharacters U+FFFE and U+FFFF, and every code point that would
 * make the text read other than it is: the bidirectional controls, every other default-ignorable code point
 * (zero-width characters, the byte-order mark, variation selectors, tags) and the interlinear annotation marks.
 */
const NOT_YAML_PRINTABLE =
  /[\u007f-\u009f\u2028\u2029\ufff9-\ufffb\ufffe\uffff\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu;

/** `\uXXXX`, or YAML's `\UXXXXXXXX` above the Basic Multilingual Plane. */
function escapeNotPrintable(json: string): string {
  return json.replace(NOT_YAML_PRINTABLE, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code > 0xffff
      ? `\\U${code.toString(16).padStart(8, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/**
 * A string as a JSON string literal, with the code points above also escaped (`\uXXXX`). The result is
 * one line of printable text, valid as a YAML double-quoted scalar and safe in a Cedar or YAML comment.
 */
export function quote(value: string): string {
  return escapeNotPrintable(JSON.stringify(value));
}

/** `JSON.stringify` as it behaves: undefined for undefined, a function or a symbol. */
const stringify: (value: unknown) => string | undefined = JSON.stringify;

/** Any input value for a reason, on one printable line: as JSON, or its name for a value JSON cannot hold. */
export function show(value: unknown): string {
  let json: string | undefined;
  try {
    json = stringify(value);
  } catch {
    return 'a value with no JSON form';
  }
  return json === undefined ? String(value) : escapeNotPrintable(json);
}
