import { describe, expect, it } from 'vitest';

import config from './next.config.js';

describe('next.config', () => {
  it('the callback routes are never cached and their address is not sent as a referrer (A8)', async () => {
    const rules = (await config.headers?.()) ?? [];
    const headers = [
      { key: 'Cache-Control', value: 'no-store' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
    ];
    expect(rules).toEqual([
      { source: '/approvals/callback', headers },
      { source: '/permissions/callback', headers },
      { source: '/connections/callback', headers },
    ]);
  });
});
