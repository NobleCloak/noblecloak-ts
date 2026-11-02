import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';

import { DigestError, MAX_NESTING_DEPTH, argDigest, jcs, sha256Hex } from './digest.js';
import type { JsonValue } from './digest.js';

interface Corpus {
  readonly pairs: readonly { id: string; arguments_json: string; arg_digest: string }[];
}

const corpus = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../spec/corpus/arg-digest-pairs.json'), 'utf8')
) as Corpus;

/** RFC 8785 Appendix B: IEEE 754 bits (hex) and the canonical text of that double. */
const APPENDIX_B: readonly (readonly [string, string])[] = [
  ['0000000000000000', '0'],
  ['8000000000000000', '0'],
  ['0000000000000001', '5e-324'],
  ['8000000000000001', '-5e-324'],
  ['7fefffffffffffff', '1.7976931348623157e+308'],
  ['ffefffffffffffff', '-1.7976931348623157e+308'],
  ['4340000000000000', '9007199254740992'],
  ['c340000000000000', '-9007199254740992'],
  ['4430000000000000', '295147905179352830000'],
  ['44b52d02c7e14af5', '9.999999999999997e+22'],
  ['44b52d02c7e14af6', '1e+23'],
  ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ['444b1ae4d6e2ef4e', '999999999999999700000'],
  ['444b1ae4d6e2ef4f', '999999999999999900000'],
  ['444b1ae4d6e2ef50', '1e+21'],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ['3eb0c6f7a0b5ed8d', '0.000001'],
  ['41b3de4355555553', '333333333.3333332'],
  ['41b3de4355555554', '333333333.33333325'],
  ['41b3de4355555555', '333333333.3333333'],
  ['41b3de4355555556', '333333333.3333334'],
  ['41b3de4355555557', '333333333.33333343'],
  ['becbf647612f3696', '-0.0000033333333333333333'],
  ['43143ff3c1cb0959', '1424953923781206.2'],
];

describe('the vendored corpus', () => {
  it.each(corpus.pairs.map((pair) => [pair.id, pair] as const))(
    'pair %s: arguments digest to the pinned arg_digest',
    async (_id, pair) => {
      expect(await argDigest(JSON.parse(pair.arguments_json) as JsonValue)).toBe(pair.arg_digest);
    }
  );

  it('has enough entries to mean something', () => {
    expect(corpus.pairs.length).toBeGreaterThanOrEqual(15);
  });
});

describe('RFC 8785, from the RFC', () => {
  // The vectors test the canonicalisation underneath `jcs`. `jcs` itself additionally refuses an
  // integer outside ±(2^53 - 1), which several Appendix B entries are, as the platform does.
  const doubleOf = (hex: string): number => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(`0x${hex}`));
    return view.getFloat64(0);
  };

  it.each(APPENDIX_B)('Appendix B: %s serialises as %s', (hex, canonical) => {
    const value = doubleOf(hex);
    expect(canonicalize(value)).toBe(canonical);
    if (!Number.isInteger(value) || Number.isSafeInteger(value)) expect(jcs(value)).toBe(canonical);
    else expect(() => jcs(value)).toThrow(DigestError);
  });

  it('3.2.2: the sample is serialised as the RFC shows', () => {
    const input: JsonValue = {
      numbers: [333333333.3333333, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      // The RFC writes the first number as 333333333.33333329 (the same double). It writes this value as "€$\u000F\u000aA'B"\\\\"\/".
      string: '€$\u000F\u000aA\'B"\\\\"/',
      literals: [null, true, false],
    };
    expect(canonicalize(input)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`
    );
  });

  it('3.2.3: properties are sorted by UTF-16 code units', () => {
    // Built as an object, so no JSON.parse reorders the integer-like key "1" ahead of "\r".
    const input: JsonValue = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    expect(jcs(input)).toBe(
      String.raw`{"\r":"Carriage Return","1":"One","` +
        '\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign","\u{1F600}":"Emoji: Grinning Face",' +
        '"דּ":"Hebrew Letter Dalet With Dagesh"}'
    );
  });
});

describe('argDigest', () => {
  it('is independent of key order and whitespace, and sensitive to values', async () => {
    expect(await argDigest({ b: 1, a: 2 })).toBe(await argDigest({ a: 2, b: 1 }));
    expect(await argDigest({ a: 1 })).not.toBe(await argDigest({ a: 2 }));
  });

  it('keeps null distinct from absent', async () => {
    expect(await argDigest({ cursor: null })).not.toBe(await argDigest({}));
  });
});

describe('sha256Hex', () => {
  it('hashes a string as UTF-8 and bytes as given', async () => {
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(await sha256Hex('')).toBe(empty);
    expect(await sha256Hex(new Uint8Array())).toBe(empty);
    expect(await sha256Hex('é')).toBe(await sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });
});

describe('jcs', () => {
  const refused = (value: unknown): DigestError => {
    try {
      jcs(value as JsonValue);
    } catch (error) {
      if (error instanceof DigestError) return error;
      throw error;
    }
    throw new Error('expected jcs to refuse the value');
  };
  const nested = (levels: number): JsonValue => {
    let value: JsonValue = 1;
    for (let i = 1; i < levels; i++) value = [value];
    return { a: value };
  };

  it('throws a TypeError on a value with no JSON representation', () => {
    expect(() => jcs(undefined as unknown as JsonValue)).toThrow(TypeError);
    expect(refused(undefined).code).toBe('unsupported_type');
  });

  it('refuses what JSON.stringify would silently rewrite', () => {
    expect(refused(Number.NaN).code).toBe('non_finite_number');
    expect(refused({ a: Number.POSITIVE_INFINITY }).code).toBe('non_finite_number');
    expect(refused({ a: undefined }).code).toBe('unsupported_type');
    expect(refused({ a: () => 1 }).code).toBe('unsupported_type');
    expect(refused({ a: 10n }).code).toBe('unsupported_type');
    expect(refused({ a: new Map() }).code).toBe('unsupported_type');
    expect(refused({ a: new Date(0) }).code).toBe('unsupported_type');
    expect(refused({ toJSON: () => 1 }).code).toBe('unsupported_type');
    // eslint-disable-next-line no-sparse-arrays
    expect(refused([1, , 3]).code).toBe('unsupported_type');
  });

  it('accepts a plain data key named toJSON, and refuses it only when it is a function', () => {
    expect(jcs({ toJSON: 'x' })).toBe('{"toJSON":"x"}');
    expect(jcs({ a: { toJSON: 1 } })).toBe('{"a":{"toJSON":1}}');
    expect(refused({ toJSON: () => 1 }).code).toBe('unsupported_type');
  });

  it('refuses an integer outside the exact range of a double, and accepts the edge', () => {
    expect(refused({ a: 2 ** 53 }).code).toBe('integer_out_of_range');
    expect(jcs({ a: Number.MAX_SAFE_INTEGER })).toBe('{"a":9007199254740991}');
  });

  it('refuses a lone surrogate in a value or a key, and accepts a pair', () => {
    expect(refused({ a: '\ud800' }).code).toBe('invalid_string');
    expect(refused({ '\udc00': 1 }).code).toBe('invalid_string');
    expect(jcs({ a: '\ud83d\ude00' })).toBe('{"a":"\u{1F600}"}');
  });

  it('refuses a cycle', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(refused(loop).code).toBe('unsupported_type');
  });

  it('allows nesting up to the maximum depth and refuses one level more', () => {
    expect(() => jcs(nested(MAX_NESTING_DEPTH))).not.toThrow();
    expect(refused(nested(MAX_NESTING_DEPTH + 1)).code).toBe('nesting_too_deep');
  });
});
