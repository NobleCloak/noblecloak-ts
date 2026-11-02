import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME, VERSION } from './index.js';

describe('n8n-nodes-noblecloak', () => {
  it('exports its published name and placeholder version', () => {
    expect(PACKAGE_NAME).toBe('n8n-nodes-noblecloak');
    expect(VERSION).toBe('0.0.0');
  });
});
