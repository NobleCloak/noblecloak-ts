import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME, VERSION } from './index.js';

describe('@noblecloak/openai-agents', () => {
  it('exports its published name and placeholder version', () => {
    expect(PACKAGE_NAME).toBe('@noblecloak/openai-agents');
    expect(VERSION).toBe('0.0.0');
  });
});
