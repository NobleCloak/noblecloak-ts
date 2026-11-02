import { describe, expect, it } from 'vitest';

import { MAX_JSON_CHARS, SOURCE_NUMBERS, formatJson, isWhole } from './format-json.js';

const SUMMARY = {
  items: (count: number) => `[… ${String(count)} items]`,
  members: (count: number) => `{… ${String(count)} members}`,
};
const LIMITS = { maxChars: 4000, maxDepth: 8, summary: SUMMARY };

describe('formatJson', () => {
  it('pretty-prints with a two-space indent and non-numeric keys in object order', () => {
    const { text, omitted } = formatJson({ b: 1, a: [true, null, 'x'], c: {} }, LIMITS);
    expect(text).toBe('{\n  "b": 1,\n  "a": [\n    true,\n    null,\n    "x"\n  ],\n  "c": {}\n}');
    expect(omitted).toBe(0);
  });

  it("lists integer-like keys first, as JavaScript orders them (the object's own order, not the sent text's)", () => {
    const parsed: unknown = JSON.parse('{"to":"acct","2":"b","1":"a"}');
    expect(formatJson(parsed, LIMITS).text).toBe('{\n  "1": "a",\n  "2": "b",\n  "to": "acct"\n}');
  });

  it('shows strings with JSON escaping, so control characters are visible', () => {
    expect(formatJson({ s: 'a\nb\u0000c"d' }, LIMITS).text).toContain('"a\\nb\\u0000c\\"d"');
  });

  it('shows bidirectional controls and zero-width characters as escapes, in values and in keys', () => {
    const hidden = '\u202E\u2066\u2069\u200B\u200C\u200D\u2060\uFEFF\u200E';
    const { text } = formatJson({ [`k${hidden}`]: `v${hidden}` }, LIMITS);
    for (const char of hidden) expect(text).not.toContain(char);
    expect(text).toContain('\\u202E');
    expect(text).toContain('\\u2066');
    expect(text).toContain('\\u200B');
    expect(text).toContain('\\uFEFF');
    expect(text.match(/\\u202E/g)).toHaveLength(2);
  });

  it.each([
    ['U+061C Arabic letter mark', '\u061C', '\\u061C'],
    ['U+00AD soft hyphen', '\u00AD', '\\u00AD'],
    ['U+034F combining grapheme joiner', '\u034F', '\\u034F'],
    ['U+180E Mongolian vowel separator', '\u180E', '\\u180E'],
    ['U+2028 line separator', '\u2028', '\\u2028'],
    ['U+FFF9 interlinear annotation anchor', '\uFFF9', '\\uFFF9'],
    ['U+E0041 tag letter', '\u{E0041}', '\\u{E0041}'],
    ['U+E007F cancel tag', '\u{E007F}', '\\u{E007F}'],
    ['U+FE0F variation selector-16', '\uFE0F', '\\uFE0F'],
    ['U+E0101 variation selector-18', '\u{E0101}', '\\u{E0101}'],
    ['U+3164 Hangul filler', '\u3164', '\\u3164'],
    ['U+115F Hangul choseong filler', '\u115F', '\\u115F'],
    ['U+17B4 Khmer inherent vowel', '\u17B4', '\\u17B4'],
    ['U+FFA0 halfwidth Hangul filler', '\uFFA0', '\\uFFA0'],
  ])('escapes %s, in values and in keys', (_name, char, escape) => {
    const { text } = formatJson({ [`k${char}`]: `v${char}` }, LIMITS);
    expect(text).not.toContain(char);
    expect(text.split(escape)).toHaveLength(3);
  });

  it('leaves a visible astral character and an ordinary hyphen alone', () => {
    expect(formatJson('a-b\u{1F600}', LIMITS).text).toBe('"a-b\u{1F600}"');
  });

  it('summarises a container nested deeper than maxDepth by its size', () => {
    let nested: unknown = { leaf: 1, other: 2 };
    for (let level = 0; level < 12; level += 1) nested = { next: nested };
    const { text } = formatJson(nested, LIMITS);
    expect(text).toContain('{… 1 members}');
    expect(text).not.toContain('leaf');
    expect(formatJson([[[[[[[[[1, 2, 3]]]]]]]]], LIMITS).text).toContain('[… 3 items]');
    expect(
      formatJson({ a: { b: 1 } }, { maxChars: 100, maxDepth: 1, summary: SUMMARY }).text
    ).toContain('{… 1 members}');
  });

  it('takes the wording of a count summary from the caller', () => {
    const summary = { items: (n: number) => `<${String(n)} elementos>`, members: () => '<m>' };
    expect(formatJson([[1, 2]], { maxChars: 100, maxDepth: 1, summary }).text).toContain(
      '<2 elementos>'
    );
    expect(formatJson({ a: { b: 1 } }, { maxChars: 100, maxDepth: 1, summary }).text).toContain(
      '<m>'
    );
  });

  it('cuts at maxChars and reports how many characters were cut', () => {
    const { text, omitted } = formatJson({ s: 'x'.repeat(10_000) }, LIMITS);
    expect(text).toHaveLength(4000);
    expect(omitted).toBe(
      formatJson({ s: 'x'.repeat(10_000) }, { ...LIMITS, maxChars: 1e6 }).text.length - 4000
    );
    expect(omitted).toBeGreaterThan(6000);
  });

  it('does not cut between the halves of a surrogate pair', () => {
    const { text } = formatJson('\u{1F600}\u{1F600}', {
      maxChars: 4,
      maxDepth: 8,
      summary: SUMMARY,
    });
    // The literal is `"😀😀"`: a quote, then a pair; cutting at 4 would split the second half.
    expect(text).toBe('"\u{1F600}');
  });

  it('shows numbers, booleans and null as JSON, and anything else as null', () => {
    expect(formatJson([1.5, -2, false, null], LIMITS).text).toBe(
      '[\n  1.5,\n  -2,\n  false,\n  null\n]'
    );
    expect(formatJson({ a: undefined, b: () => 1, c: null }, LIMITS).text).toBe(
      '{\n  "a": null,\n  "b": null,\n  "c": null\n}'
    );
  });
});

describe('c1-3 what formatJson reports as not shown', () => {
  it('counts the containers summarised by depth, and is whole only when none is', () => {
    const shown = formatJson({ a: { b: { c: 1 } }, d: [[1]] }, { ...LIMITS, maxDepth: 2 });
    expect(shown.summarised).toBe(2);
    expect(isWhole(shown)).toBe(false);
    const all = formatJson({ a: { b: { c: 1 } }, d: [[1]] }, { ...LIMITS, maxDepth: Infinity });
    expect(all.summarised).toBe(0);
    expect(isWhole(all)).toBe(true);
  });

  it('an unlimited maxChars cuts nothing', () => {
    const shown = formatJson({ s: 'x'.repeat(200_000) }, { ...LIMITS, maxChars: Infinity });
    expect(shown.omitted).toBe(0);
    expect(shown.text.length).toBeGreaterThan(200_000);
  });

  it('prints nothing for a value over the ceiling', () => {
    const shown = formatJson({ s: 'x'.repeat(MAX_JSON_CHARS) }, { ...LIMITS, maxChars: Infinity });
    expect(shown).toMatchObject({ text: '', tooLarge: true });
    expect(isWhole(shown)).toBe(false);
  });

  it('treats nesting deep enough to overflow the stack as too large', () => {
    let nested: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) nested = [nested];
    expect(formatJson(nested, { ...LIMITS, maxDepth: Infinity }).tooLarge).toBe(true);
  });
});

describe('c2-3 numbers are shown exactly as sent, or flagged', () => {
  const SENT = '{"big":12345678901234567890,"one":1.0,"neg":-0,"huge":1e400,"small":1.5e-7}';

  it.runIf(SOURCE_NUMBERS)('renders every number literal from its source text', () => {
    const shown = formatJson(JSON.parse(SENT) as unknown, LIMITS, SENT);
    expect(shown.text).toBe(
      '{\n  "big": 12345678901234567890,\n  "one": 1.0,\n  "neg": -0,\n  "huge": 1e400,\n  "small": 1.5e-7\n}'
    );
    expect(shown.inexact).toBe(0);
    expect(isWhole(shown)).toBe(true);
  });

  it('where the runtime cannot read the source, flags a number a double may not hold', () => {
    const shown = formatJson(
      JSON.parse(SENT) as unknown,
      { ...LIMITS, sourceNumbers: false },
      SENT
    );
    // big, neg and huge; a finite fraction and 1.0 (equal to 1) cannot be told from what was sent.
    expect(shown.inexact).toBe(3);
    expect(isWhole(shown)).toBe(false);
  });

  it('does not flag safe integers and fractions', () => {
    const shown = formatJson([0, 1, -7, 9007199254740991, 0.5, 1e21 / 1e20], {
      ...LIMITS,
      sourceNumbers: false,
    });
    expect(shown.inexact).toBe(0);
    expect(isWhole(shown)).toBe(true);
  });

  it('reports a key named twice and is then not whole', () => {
    const text = '{"to":"a","nested":{"x":1,"x":2}}';
    const shown = formatJson(JSON.parse(text) as unknown, LIMITS, text);
    expect(shown.duplicateKey).toBe('x');
    expect(isWhole(shown)).toBe(false);
  });
});

describe('c2-6 output past the ceiling is too large, however small the compact form is', () => {
  it('a 1000-deep value of under 1 MB compact whose pretty text passes 2 MiB prints nothing', () => {
    // 40 members per level: about 250 KB compact, over 40 MB pretty (the indent grows with the depth).
    let value: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 1000; level += 1) {
      const next: Record<string, unknown> = {};
      for (let m = 0; m < 40; m += 1) next[`k${String(m)}`] = 1;
      next.child = value;
      value = next;
    }
    expect(JSON.stringify(value).length).toBeLessThan(1024 * 1024);
    const shown = formatJson(value, { ...LIMITS, maxChars: Infinity, maxDepth: Infinity });
    expect(shown).toMatchObject({ text: '', tooLarge: true });
    expect(isWhole(shown)).toBe(false);
  });
});
