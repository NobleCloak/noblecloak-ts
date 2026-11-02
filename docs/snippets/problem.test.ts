import { describe, expect, it } from 'vitest';

import { problemCode, unwrap } from './problem.js';

const response = (status: number) => new Response(null, { status });

describe('problemCode', () => {
  it('is the last path segment of the type', () => {
    expect(problemCode({ type: 'https://docs.example.test/problems/not_eligible' })).toBe(
      'not_eligible'
    );
  });

  it('is unknown without a type', () => {
    expect(problemCode({})).toBe('unknown');
  });
});

describe('unwrap', () => {
  it('returns the body of a successful call', () => {
    expect(unwrap({ data: { ok: true }, response: response(200) })).toEqual({ ok: true });
  });

  it('throws the status and the code of a problem', () => {
    const error = { type: 'https://docs.example.test/problems/already_resolved' };
    expect(() => unwrap({ error, response: response(409) })).toThrow('409 already_resolved');
  });

  it('throws when there is neither a body nor a problem', () => {
    expect(() => unwrap({ response: response(204) })).toThrow('204 no body');
  });
});
