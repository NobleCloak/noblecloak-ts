import { describe, expect, it } from 'vitest';

import { findDuplicateKey, sliceJsonMember, sliceJsonMembers } from './json-source.js';

describe('c2-3 sliceJsonMember', () => {
  it('returns the exact source of the member, numbers and spacing as sent', () => {
    const text =
      '{ "id": "a", "arguments" :  {"n": 12345678901234567890, "x": 1.0, "z": -0},"state":"pending"}';
    expect(sliceJsonMember(text, 'arguments')).toBe(
      '{"n": 12345678901234567890, "x": 1.0, "z": -0}'
    );
  });

  it('is not fooled by braces, brackets or the key name inside strings', () => {
    const text = '{"note":"}{ \\"arguments\\": 1","arguments":{"s":"}","t":"\\\\"},"after":2}';
    expect(sliceJsonMember(text, 'arguments')).toBe('{"s":"}","t":"\\\\"}');
  });

  it('matches an escaped spelling of the key and handles nested arrays and objects', () => {
    const text = '{"\\u0061rguments":[1,[2,{"a":[3]}],"x"],"b":null}';
    expect(sliceJsonMember(text, 'arguments')).toBe('[1,[2,{"a":[3]}],"x"]');
  });

  it('returns scalars and an absent member', () => {
    expect(sliceJsonMember('{"arguments":null}', 'arguments')).toBe('null');
    expect(sliceJsonMember('{"arguments":1e400}', 'arguments')).toBe('1e400');
    expect(sliceJsonMember('{"a":1}', 'arguments')).toBeUndefined();
    expect(sliceJsonMember('{}', 'arguments')).toBeUndefined();
  });

  it('reports a repeated top-level key, the last being the one JSON.parse keeps', () => {
    expect(sliceJsonMembers('{"arguments":{"a":1},"arguments":{"a":2}}', 'arguments')).toEqual([
      '{"a":1}',
      '{"a":2}',
    ]);
    expect(sliceJsonMember('{"arguments":{"a":1},"arguments":{"a":2}}', 'arguments')).toBe(
      '{"a":2}'
    );
  });

  it.each(['', '[1]', '{', '{"a"', '{"a":}', '{"a":1', '{"a":"x}', '{"a":1 "b":2}', '"x"'])(
    'gives undefined for %j',
    (text) => {
      expect(sliceJsonMember(text, 'arguments')).toBeUndefined();
    }
  );
});

describe('c2-3 findDuplicateKey', () => {
  it('finds a repeated key at the top and nested, also through escapes', () => {
    expect(findDuplicateKey('{"a":1,"a":2}')).toBe('a');
    expect(findDuplicateKey('{"x":[{"k":1,"k":2}]}')).toBe('k');
    expect(findDuplicateKey('{"a":1,"\\u0061":2}')).toBe('a');
  });

  it('accepts the same key in different objects, values equal to a key, and deep nesting', () => {
    expect(findDuplicateKey('{"a":1,"b":{"a":1},"c":[{"a":1},{"a":2}]}')).toBeUndefined();
    expect(findDuplicateKey('{"a":"a","b":"a"}')).toBeUndefined();
    expect(findDuplicateKey('['.repeat(5000) + ']'.repeat(5000))).toBeUndefined();
  });
});
