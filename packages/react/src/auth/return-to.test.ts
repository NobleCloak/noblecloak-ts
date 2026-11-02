import { describe, expect, it } from 'vitest';

import { sanitizeReturnTo } from './return-to.js';

const ORIGIN = 'http://localhost:3000';

describe('sanitizeReturnTo', () => {
  it.each([
    '//evil.test',
    'https://evil.test',
    'javascript:alert(1)',
    '/\\evil',
    '/a\tb',
    '/a\u007fb',
    '',
    'x',
  ])('T20-A9: %j is /', (value) => {
    expect(sanitizeReturnTo(value, ORIGIN)).toBe('/');
  });

  it('T20-A9: keeps a same-origin path with its query and fragment, and defaults to /', () => {
    expect(sanitizeReturnTo('/approvals?tab=open#top', ORIGIN)).toBe('/approvals?tab=open#top');
    expect(sanitizeReturnTo(undefined, ORIGIN)).toBe('/');
  });

  it('is / when the app origin is not a valid base', () => {
    expect(sanitizeReturnTo('/x', 'not an origin')).toBe('/');
  });
});
