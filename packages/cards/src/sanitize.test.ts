import { describe, expect, it } from 'vitest';

import { escapeInvisible, formatCall, renderText, utf8Length } from './sanitize.js';

const same = (char: string): string => char;

describe('escapeInvisible', () => {
  it('shows bidi controls, zero-width and tag characters as escapes', () => {
    expect(escapeInvisible('a\u202eb')).toBe('a\\u202Eb');
    expect(escapeInvisible('a\u200bb')).toBe('a\\u200Bb');
    expect(escapeInvisible('x\u{E0041}y')).toBe('x\\u{E0041}y');
    expect(escapeInvisible('l\u2028m\u2029n')).toBe('l\\u2028m\\u2029n');
    expect(escapeInvisible('plain')).toBe('plain');
  });

  it('shows a lone surrogate as an escape and leaves a surrogate pair', () => {
    expect(escapeInvisible(`a${String.fromCharCode(0xd800)}b`)).toBe('a\\uD800b');
    expect(escapeInvisible(`a${String.fromCharCode(0xdc00)}b`)).toBe('a\\uDC00b');
    expect(escapeInvisible('x\u{1F600}y')).toBe('x\u{1F600}y');
  });
});

describe('renderText', () => {
  it('leaves a string that fits', () => {
    expect(renderText('abcdef', 6, same)).toBe('abcdef');
  });

  it('cuts to the limit, ending in an ellipsis', () => {
    const cut = renderText('abcdefgh', 6, same);
    expect(cut).toBe('abcde…');
    expect(cut.length).toBe(6);
  });

  it('never cuts inside an escape or a surrogate pair', () => {
    expect(renderText('ab\u202Ecd', 7, same)).toBe('ab\u2026');
    expect(renderText('ab\u202Ecd', 10, same)).toBe('ab\\u202Ecd');
    expect(renderText('ab\u{1F600}\u{1F600}', 4, same)).toBe('ab…');
    expect(renderText('&&&&', 7, (c) => (c === '&' ? '&amp;' : c))).toBe('&amp;…');
  });

  it('never exceeds the limit, whatever the escapes expand to', () => {
    for (const limit of [1, 2, 5, 17, 100]) {
      const out = renderText('<&>'.repeat(300), limit, (c) => `\\${c}\\${c}`);
      expect(out.length).toBeLessThanOrEqual(limit);
    }
  });
});

describe('utf8Length', () => {
  it('counts bytes of one to four', () => {
    expect(utf8Length('a')).toBe(1);
    expect(utf8Length('\u00e9')).toBe(2);
    expect(utf8Length('\u20ac')).toBe(3);
    expect(utf8Length('\u{1F600}')).toBe(4);
    expect(utf8Length('a\u00e9')).toBe(3);
  });
});

describe('formatCall', () => {
  it('prints indented JSON', () => {
    expect(formatCall({ a: 1, b: ['x', true, null], c: {}, d: [] })).toEqual({
      text: '{\n  "a": 1,\n  "b": [\n    "x",\n    true,\n    null\n  ],\n  "c": {},\n  "d": []\n}',
      shortened: false,
      tooLarge: false,
      unreadable: false,
    });
  });

  it('cuts a long string and says so', () => {
    const out = formatCall({ s: 'x'.repeat(5000) });
    expect(out.shortened).toBe(true);
    expect(out.text.length).toBeLessThan(600);
    expect(out.text).toContain('…');
  });

  it('shows a container deeper than eight as a count', () => {
    let value: unknown = 'leaf';
    for (let i = 0; i < 64; i += 1) value = { n: value, list: [1, 2] };
    const out = formatCall(value as Record<string, unknown>);
    expect(out.shortened).toBe(true);
    expect(out.tooLarge).toBe(false);
    expect(out.text).toContain('{2 member(s)}');
    expect(out.text.split('\n').length).toBeLessThan(60);
    const arrays = formatCall({ a: [[[[[[[[[1, 2, 3]]]]]]]]] });
    expect(arrays.text).toContain('[1 item(s)]');
  });

  it('survives a value nested far deeper than the digest allows', () => {
    let value: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) value = { n: value };
    expect(formatCall(value as Record<string, unknown>).tooLarge).toBe(false);
  });

  it('refuses output past the build cap', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 1000; i += 1) wide[`key${String(i)}`] = 'v'.repeat(100);
    expect(formatCall(wide)).toEqual({
      text: '',
      shortened: false,
      tooLarge: true,
      unreadable: false,
    });
  });

  it('prints values JSON does not have, without throwing', () => {
    const out = formatCall({ big: 10n, f: () => 1, u: undefined, n: Number.NaN });
    expect(out.tooLarge).toBe(false);
    expect(out.text).toContain('"big": 10');
    expect(out.text).toContain('[unsupported value]');
    expect(out.text).toContain('"n": null');
  });

  it('is unreadable, not too large and not thrown, when a getter throws', () => {
    const hostile = {
      get boom(): string {
        throw new Error('no');
      },
    };
    expect(formatCall(hostile)).toEqual({
      text: '',
      shortened: false,
      tooLarge: false,
      unreadable: true,
    });
  });

  it('cuts a long key', () => {
    const out = formatCall({ ['k'.repeat(900)]: 1 });
    expect(out.shortened).toBe(true);
  });
});
