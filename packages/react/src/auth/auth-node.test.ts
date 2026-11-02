import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { newStub } from '../testing/auth-harness.js';
import { createBrowserAuth, memoryRefreshStore, sessionStorageRefreshStore } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(HERE)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: readFileSync(join(HERE, name), 'utf8') }));

describe('the auth sources', () => {
  it('there are sources to scan', () => {
    expect(sources.map((source) => source.name)).toEqual(
      expect.arrayContaining(['browser-auth.ts', 'pkce.ts', 'stores.ts', 'use-auth-state.ts'])
    );
  });

  it('T20-A1: no client secret and no implicit flow appear in any source', () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/client_secret|clientSecret/);
      expect(text, name).not.toMatch(/response_type=token|response_type['"]\s*,\s*['"]token/);
      expect(text, name).not.toMatch(/id_token\s+token|implicit/i);
    }
  });

  it('T20-A16: nothing signs in by itself: no effect hook, and signIn is called by nobody in the module', () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/useEffect|useLayoutEffect/);
      const calls = text.split('\n').filter((line) => /\bsignIn\(/.test(line));
      for (const line of calls) {
        expect(line, name).toMatch(
          /async signIn\(|signIn\(returnTo\?|\* .*signIn\(|\/\/.*signIn\(/
        );
      }
    }
  });

  it('A6: the only storage the module touches is sessionStorage; no localStorage, cookie or IndexedDB', () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/localStorage|document\.cookie|indexedDB/);
    }
  });
});

describe('importing and building the auth entry in a server with no browser', () => {
  it('T20-A-purity: importing the entry reads no browser global (it was imported above in node)', async () => {
    const entry = await import('../auth.js');
    expect(Object.keys(entry).sort()).toEqual([
      'AuthError',
      'createBrowserAuth',
      'memoryRefreshStore',
      'sessionStorageRefreshStore',
      'useAuthState',
    ]);
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
  });

  it('builds without a page origin, and a browser-only call ends in an error state', async () => {
    const stub = newStub();
    const auth = createBrowserAuth({
      issuer: stub.issuer,
      clientId: stub.clientId,
      redirectUri: stub.redirectUri,
      resource: stub.resource,
      fetch: stub.fetch,
    });
    await auth.completeSignIn();
    const state = auth.getSnapshot();
    expect(state.status).toBe('error');
    await auth.signIn();
    expect(auth.getSnapshot().status).toBe('error');
    await expect(auth.getToken()).rejects.toMatchObject({ code: 'signed_out' });
  });

  it('the default store keeps the token in memory where there is no sessionStorage', () => {
    const store = sessionStorageRefreshStore('node');
    store.set('t');
    expect(store.get()).toBe('t');
    expect(memoryRefreshStore().get()).toBeNull();
  });
});
