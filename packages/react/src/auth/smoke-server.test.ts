import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { decodeClaims } from '../../tools/smoke/claims.js';
import {
  buildConfig,
  CALLBACK_PATH,
  createSmokeServer,
  ORIGIN,
  parseEnv,
  renderPage,
} from '../../tools/smoke/server.js';

const ENV = [
  '# comment',
  '',
  'SMOKE_RESOURCE="https://govern.example.test"',
  "SMOKE_CLIENT_ID='bnoauth_REPLACE_ME'",
  'IGNORED',
].join('\n');

describe('tools/smoke/server (loopback only; never run against an issuer)', () => {
  it('reads KEY=value pairs, skipping comments and removing one pair of quotes', () => {
    expect(parseEnv(ENV)).toEqual({
      SMOKE_RESOURCE: 'https://govern.example.test',
      SMOKE_CLIENT_ID: 'bnoauth_REPLACE_ME',
    });
  });

  it('takes the issuer from the flag and the rest from the env file, and says what is missing', () => {
    expect(buildConfig('https://auth.example.test', ENV)).toEqual({
      issuer: 'https://auth.example.test',
      clientId: 'bnoauth_REPLACE_ME',
      resource: 'https://govern.example.test',
      redirectUri: `${ORIGIN}${CALLBACK_PATH}`,
    });
    expect(() => buildConfig(undefined, '')).toThrow(
      '--issuer, SMOKE_CLIENT_ID in .env.smoke.local, SMOKE_RESOURCE in .env.smoke.local'
    );
    expect(() => buildConfig('https://auth.example.test', 'SMOKE_CLIENT_ID=x')).toThrow(
      'SMOKE_RESOURCE'
    );
  });

  it('puts the configuration in a JSON block that cannot close its script element', () => {
    const page = renderPage({
      issuer: 'https://auth.example.test',
      clientId: '</script><b>',
      resource: 'https://govern.example.test',
      redirectUri: `${ORIGIN}${CALLBACK_PATH}`,
    });
    expect(page).not.toContain('</script><b>');
    expect(page).toContain('\\u003c/script\\u003e');
    for (const id of ['sign-in', 'refresh', 'reload', 'sign-out', 'state', 'claims']) {
      expect(page).toContain(`id="${id}"`);
    }
  });

  it('serves the page at / and the callback, the bundle at /smoke.js, and 404 elsewhere', async () => {
    const bundled: string[] = [];
    const server = await createSmokeServer(
      buildConfig('https://auth.example.test', ENV),
      (entry) => {
        bundled.push(entry);
        return Promise.resolve('export {};');
      }
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      for (const path of ['/', '/approvals', CALLBACK_PATH]) {
        const response = await fetch(base + path);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(await response.text()).toContain('smoke-config');
      }
      const script = await fetch(`${base}/smoke.js`);
      expect(script.headers.get('content-type')).toContain('text/javascript');
      expect(await script.text()).toBe('export {};');
      expect((await fetch(`${base}/other`)).status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(bundled).toHaveLength(1);
    expect(bundled[0]).toMatch(/tools[\\/]smoke[\\/]page\.ts$/);
  });

  it('decodes a token payload locally, and says null for a token that is not a JWT', () => {
    const payload = Buffer.from(JSON.stringify({ aud: 'x', exp: 1 })).toString('base64url');
    expect(decodeClaims(`h.${payload}.s`)).toEqual({ aud: 'x', exp: 1 });
    expect(decodeClaims('opaque')).toBeNull();
    expect(decodeClaims('h.!!!.s')).toBeNull();
    expect(decodeClaims(`h.${Buffer.from('7').toString('base64url')}.s`)).toBeNull();
  });
});
