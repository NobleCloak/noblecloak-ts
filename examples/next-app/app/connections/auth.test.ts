// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { sharedAuth } from './auth.js';
import type { ExampleConfig } from './config.js';

const CONFIG: Extract<ExampleConfig, { mode: 'oidc' }> = {
  mode: 'oidc',
  apiUrl: 'https://govern.example.test',
  issuer: 'https://auth.example.test',
  clientId: 'bnoauth_REPLACE_ME',
  redirectUri: 'http://localhost:3000/connections/callback',
};

describe('sharedAuth', () => {
  it('is one object for one configuration, so both routes share one owner of the refresh token', () => {
    expect(sharedAuth(CONFIG)).toBe(sharedAuth({ ...CONFIG }));
  });

  it('is a new object for another configuration, and starts signed out', () => {
    const first = sharedAuth(CONFIG);
    const second = sharedAuth({ ...CONFIG, clientId: 'bnoauth_OTHER' });
    expect(second).not.toBe(first);
    expect(second.getSnapshot()).toEqual({ status: 'signed_out' });
  });
});
