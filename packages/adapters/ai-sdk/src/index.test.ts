import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME, VERSION } from './index.js';

describe('@noblecloak/ai-sdk', () => {
  it('exports its published name and placeholder version', () => {
    expect(PACKAGE_NAME).toBe('@noblecloak/ai-sdk');
    expect(VERSION).toBe('0.0.0');
  });
});
