import { describe, expect, it, vi } from 'vitest';

import { parseConfig, readConfig } from './config.js';

const OIDC = {
  NEXT_PUBLIC_NC_API_URL: 'https://govern.example.test',
  NEXT_PUBLIC_NC_ISSUER: 'https://auth.example.test',
  NEXT_PUBLIC_NC_CLIENT_ID: 'bnoauth_REPLACE_ME',
  NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI: 'http://localhost:3000/permissions/callback',
};

describe('parseConfig', () => {
  it('mock mode needs only the API origin', () => {
    expect(
      parseConfig({ NEXT_PUBLIC_NC_MODE: 'mock', NEXT_PUBLIC_NC_API_URL: 'http://127.0.0.1:8787' })
    ).toEqual({
      ok: true,
      config: { mode: 'mock', apiUrl: 'http://127.0.0.1:8787', roles: [] },
    });
  });

  it('sign-in mode takes the four variables, and unset mode means sign-in', () => {
    expect(parseConfig(OIDC)).toEqual({
      ok: true,
      config: {
        mode: 'oidc',
        apiUrl: 'https://govern.example.test',
        issuer: 'https://auth.example.test',
        clientId: 'bnoauth_REPLACE_ME',
        redirectUri: 'http://localhost:3000/permissions/callback',
        roles: [],
      },
    });
    expect(parseConfig({ ...OIDC, NEXT_PUBLIC_NC_MODE: 'oidc' }).ok).toBe(true);
  });

  it('names every missing variable', () => {
    expect(parseConfig({})).toEqual({
      ok: false,
      problems: [
        'NEXT_PUBLIC_NC_API_URL is not set',
        'NEXT_PUBLIC_NC_ISSUER is not set',
        'NEXT_PUBLIC_NC_CLIENT_ID is not set',
        'NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI is not set',
      ],
    });
    expect(parseConfig({ NEXT_PUBLIC_NC_MODE: 'mock' })).toEqual({
      ok: false,
      problems: ['NEXT_PUBLIC_NC_API_URL is not set'],
    });
  });

  it('refuses a mode that is neither, an API URL that is not an origin, and URLs that are not URLs', () => {
    const result = parseConfig({
      NEXT_PUBLIC_NC_MODE: 'staging',
      NEXT_PUBLIC_NC_API_URL: 'https://govern.example.test/',
      NEXT_PUBLIC_NC_ISSUER: 'not a url',
      NEXT_PUBLIC_NC_CLIENT_ID: 'x',
      NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI: '/permissions/callback',
    });
    expect(result).toEqual({
      ok: false,
      problems: [
        'NEXT_PUBLIC_NC_MODE is mock or oidc (or unset, which means oidc)',
        'NEXT_PUBLIC_NC_API_URL is an origin with no path or trailing slash',
        'NEXT_PUBLIC_NC_ISSUER is an absolute URL',
        'NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI is an absolute URL',
      ],
    });
    expect(
      parseConfig({ NEXT_PUBLIC_NC_MODE: 'mock', NEXT_PUBLIC_NC_API_URL: 'localhost:8787' }).ok
    ).toBe(false);
  });

  it.each([
    [
      'an http API origin that is not localhost',
      { NEXT_PUBLIC_NC_API_URL: 'http://127.0.0.1:8787' },
      'NEXT_PUBLIC_NC_API_URL uses https (or http://localhost) for sign-in',
    ],
    [
      'an http issuer that is not localhost',
      { NEXT_PUBLIC_NC_ISSUER: 'http://auth.example.test' },
      'NEXT_PUBLIC_NC_ISSUER uses https (or http://localhost)',
    ],
    [
      'a non-http(s) issuer',
      { NEXT_PUBLIC_NC_ISSUER: 'ftp://auth.example.test' },
      'NEXT_PUBLIC_NC_ISSUER uses https (or http://localhost)',
    ],
    [
      'an http redirect URI that is not localhost',
      { NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI: 'http://app.example.test/cb' },
      'NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI uses https (or http://localhost)',
    ],
    [
      'a redirect URI with a query',
      { NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI: 'https://app.example.test/cb?x=1' },
      'NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI is exact: no query, fragment or wildcard',
    ],
    [
      'a redirect URI with a fragment',
      { NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI: 'https://app.example.test/cb#x' },
      'NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI is exact: no query, fragment or wildcard',
    ],
    [
      'a redirect URI with a wildcard',
      { NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI: 'https://app.example.test/*' },
      'NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI is exact: no query, fragment or wildcard',
    ],
  ])('sign-in mode refuses %s as a problem, not a throw', (_name, override, problem) => {
    expect(parseConfig({ ...OIDC, ...override })).toEqual({ ok: false, problems: [problem] });
  });

  it('accepts http://localhost on any port for the API, the issuer and the redirect URI', () => {
    expect(
      parseConfig({
        ...OIDC,
        NEXT_PUBLIC_NC_API_URL: 'http://localhost:9',
        NEXT_PUBLIC_NC_ISSUER: 'http://localhost:8788',
        NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI: 'http://localhost:3000/permissions/callback',
      }).ok
    ).toBe(true);
  });

  it('readConfig reads the variables of the environment by name', () => {
    vi.stubEnv('NEXT_PUBLIC_NC_MODE', 'mock');
    vi.stubEnv('NEXT_PUBLIC_NC_API_URL', 'http://127.0.0.1:8787');
    expect(readConfig()).toEqual({
      ok: true,
      config: { mode: 'mock', apiUrl: 'http://127.0.0.1:8787', roles: [] },
    });
    vi.unstubAllEnvs();
  });

  it('reads the roles to show as columns, and names a malformed list', () => {
    const mock = { NEXT_PUBLIC_NC_MODE: 'mock', NEXT_PUBLIC_NC_API_URL: 'http://127.0.0.1:8787' };
    expect(parseConfig({ ...mock, NEXT_PUBLIC_NC_ROLES: 'member, reviewer' })).toEqual({
      ok: true,
      config: { mode: 'mock', apiUrl: 'http://127.0.0.1:8787', roles: ['member', 'reviewer'] },
    });
    for (const bad of ['member,,reviewer', 'a role'])
      expect(parseConfig({ ...mock, NEXT_PUBLIC_NC_ROLES: bad })).toEqual({
        ok: false,
        problems: ['NEXT_PUBLIC_NC_ROLES is a comma-separated list of role keys'],
      });
  });

  it("reads its own redirect variable, never the approvals page's", () => {
    const result = parseConfig({
      NEXT_PUBLIC_NC_API_URL: 'https://govern.example.test',
      NEXT_PUBLIC_NC_ISSUER: 'https://auth.example.test',
      NEXT_PUBLIC_NC_CLIENT_ID: 'c',
      NEXT_PUBLIC_NC_REDIRECT_URI: 'http://localhost:3000/approvals/callback',
    });
    expect(result).toEqual({
      ok: false,
      problems: ['NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI is not set'],
    });
  });
});
