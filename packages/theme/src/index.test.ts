import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME, VERSION } from './index.js';

describe('@noblecloak/theme', () => {
  it('exports its published name and the fixed version marker', () => {
    expect(PACKAGE_NAME).toBe('@noblecloak/theme');
    expect(VERSION).toBe('0.0.0');
  });
});
