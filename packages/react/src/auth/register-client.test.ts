import { describe, expect, it } from 'vitest';

import { StubAuthorizationServer, urlOf } from '../testing/auth-stub.js';
import { DEFAULT_CLIENT_NAME, main, registerClient } from '../../tools/register-client.js';

const REDIRECT = 'http://localhost:3000/approvals/callback';

function run(argv: string[], stub = new StubAuthorizationServer(), fetchOverride?: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    fetch: fetchOverride ?? stub.fetch,
    stdout: (line) => out.push(line),
    stderr: (text) => err.push(text),
  });
  return { stub, out, err, code };
}

describe('tools/register-client (against the in-test stub; never a real issuer)', () => {
  it('registers once with exactly the RFC 7591 metadata and prints one JSON line', async () => {
    const { stub, out, err, code } = run([
      '--issuer',
      'https://auth.example.test',
      '--redirect-uri',
      REDIRECT,
    ]);
    expect(await code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const line = JSON.parse(out[0] ?? '') as Record<string, unknown>;
    expect(Object.keys(line)).toEqual(['issuer', 'client_id']);
    expect(line.issuer).toBe('https://auth.example.test');
    expect(line.client_id).toMatch(/^bnoauth_stub_/);
    const posted = stub.requests.filter((request) => request.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe('https://auth.example.test/register');
    expect(stub.requests[0]?.url).toBe(
      'https://auth.example.test/.well-known/oauth-authorization-server'
    );
  });

  it('sends exactly the five registration fields, with the default or the given client name', async () => {
    const registeredBody = async (argv: string[]): Promise<unknown> => {
      const seen: unknown[] = [];
      const stub = new StubAuthorizationServer();
      const recording: typeof fetch = (input, init) => {
        if (urlOf(input).endsWith('/register') && typeof init?.body === 'string') {
          seen.push(JSON.parse(init.body));
        }
        return stub.fetch(input, init);
      };
      await run(argv, stub, recording).code;
      return seen[0];
    };
    expect(
      await registeredBody(['--issuer', 'https://auth.example.test', '--redirect-uri', REDIRECT])
    ).toEqual({
      client_name: DEFAULT_CLIENT_NAME,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(
      await registeredBody([
        '--issuer',
        'https://auth.example.test',
        '--redirect-uri',
        REDIRECT,
        '--client-name',
        'Mine',
      ])
    ).toMatchObject({ client_name: 'Mine' });
  });

  it('exits 1 and prints the server problem body to stderr when registration is refused', async () => {
    const stub = new StubAuthorizationServer();
    const refusing: typeof fetch = (input, init) =>
      urlOf(input).endsWith('/register')
        ? Promise.resolve(new Response('{"error":"invalid_redirect_uri"}', { status: 400 }))
        : stub.fetch(input, init);
    const { out, err, code } = run(
      ['--issuer', 'https://auth.example.test', '--redirect-uri', REDIRECT],
      stub,
      refusing
    );
    expect(await code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).toContain('{"error":"invalid_redirect_uri"}');
  });

  it('fails with exit 1 and nothing on stdout for each way the exchange can break', async () => {
    const stub = new StubAuthorizationServer();
    const argv = ['--issuer', 'https://auth.example.test', '--redirect-uri', REDIRECT];
    const cases: Record<string, typeof fetch> = {
      unreachable: () => Promise.reject(new TypeError('Failed to fetch')),
      'metadata 500': () => Promise.resolve(new Response('down', { status: 500 })),
      'no registration endpoint': () => Promise.resolve(Response.json({ issuer: 'x' })),
      'registration unreachable': (input, init) =>
        urlOf(input).endsWith('/register')
          ? Promise.reject(new TypeError('socket hang up'))
          : stub.fetch(input, init),
      'no client id': (input, init) =>
        urlOf(input).endsWith('/register')
          ? Promise.resolve(Response.json({ client_name: 'x' }, { status: 201 }))
          : stub.fetch(input, init),
    };
    for (const [name, send] of Object.entries(cases)) {
      const { out, err, code } = run(argv, stub, send);
      expect(await code, name).toBe(1);
      expect(out, name).toEqual([]);
      expect(err.join(''), name).not.toBe('');
    }
  });

  it('rejects missing, unknown and malformed arguments before any request', async () => {
    for (const argv of [
      [],
      ['--issuer', 'https://auth.example.test'],
      ['--redirect-uri', REDIRECT],
      ['--issuer', 'not a url', '--redirect-uri', REDIRECT],
      ['--issuer', 'https://auth.example.test', '--redirect-uri', REDIRECT, '--bogus', 'x'],
    ]) {
      const { stub, out, err, code } = run(argv);
      expect(await code, argv.join(' ')).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('')).toContain('usage');
      expect(stub.requests).toEqual([]);
    }
  });

  it('keeps an issuer path in the metadata address', async () => {
    const calls: string[] = [];
    const recording: typeof fetch = (input) => {
      calls.push(urlOf(input));
      return Promise.resolve(new Response('no', { status: 404 }));
    };
    await expect(
      registerClient(
        { issuer: 'https://auth.example.test/tenant/', redirectUri: REDIRECT, clientName: 'x' },
        recording
      )
    ).rejects.toThrow('404');
    expect(calls).toEqual([
      'https://auth.example.test/.well-known/oauth-authorization-server/tenant',
    ]);
  });

  it('c1-6 refuses an issuer or a redirect URI that is not https (http://localhost allowed), with no request', async () => {
    for (const [issuer, redirect] of [
      ['http://auth.example.test', REDIRECT],
      ['https://auth.example.test', 'http://app.example.test/callback'],
      ['https://auth.example.test', 'not-a-url'],
    ] as const) {
      const stub = new StubAuthorizationServer();
      const { err, code } = run(['--issuer', issuer, '--redirect-uri', redirect], stub);
      expect(await code).toBe(1);
      expect(err.join('')).not.toBe('');
      expect(stub.requests).toEqual([]);
    }
    const local = run(['--issuer', 'http://localhost:9000', '--redirect-uri', REDIRECT]);
    expect(await local.code).toBe(1);
    // It was not refused as insecure: the request went out, and the stub does not serve that issuer.
    expect(local.err.join('')).not.toMatch(/must be an absolute https/);
  });

  it('c1-6 refuses metadata that names another issuer, and registers nothing', async () => {
    const stub = new StubAuthorizationServer();
    const lying: typeof fetch = async (input, init) => {
      const response = await stub.fetch(input, init);
      if (!urlOf(input).includes('/.well-known/')) return response;
      const document = (await response.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...document, issuer: 'https://evil.example.test' }), {
        status: 200,
      });
    };
    const { err, code } = run(
      ['--issuer', 'https://auth.example.test', '--redirect-uri', REDIRECT],
      stub,
      lying
    );
    expect(await code).toBe(1);
    expect(err.join('')).toMatch(/different issuer/);
    expect(stub.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('c1-6 refuses a registration_endpoint that is not https, and registers nothing', async () => {
    const stub = new StubAuthorizationServer();
    const downgrading: typeof fetch = async (input, init) => {
      const response = await stub.fetch(input, init);
      if (!urlOf(input).includes('/.well-known/')) return response;
      const document = (await response.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ...document, registration_endpoint: 'http://auth.example.test/register' }),
        { status: 200 }
      );
    };
    const { err, code } = run(
      ['--issuer', 'https://auth.example.test', '--redirect-uri', REDIRECT],
      stub,
      downgrading
    );
    expect(await code).toBe(1);
    expect(err.join('')).toMatch(/registration_endpoint that is not https/);
    expect(stub.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });
});
