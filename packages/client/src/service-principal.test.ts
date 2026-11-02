import { describe, expect, it } from 'vitest';

import { servicePrincipalTokenSource, ServicePrincipalError } from './service-principal.js';
import {
  AUDIENCE,
  CLIENT_ID,
  ISSUER,
  TOKEN_ENDPOINT,
  credential,
  ecKey,
  rsaKey,
  stubEndpoint,
  tokenResponse,
  verifyAssertion,
} from './service-principal.test-support.js';

const NOW = 1_800_000_000_000;

function clockAt(start = NOW) {
  let now = start;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('servicePrincipalTokenSource', () => {
  it('posts a form-encoded client_credentials request with a verifiable ES256 assertion', async () => {
    const key = await ecKey();
    const stub = stubEndpoint();
    const source = servicePrincipalTokenSource(credential(key), {
      audience: AUDIENCE,
      scopes: ['module_api', 'other'],
      fetch: stub.fetch,
      clock: clockAt().clock,
    });
    expect(await source.getToken()).toBe('token-1');

    const [request] = stub.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(TOKEN_ENDPOINT);
    expect(request?.headers.get('content-type')).toContain('application/x-www-form-urlencoded');
    expect(request?.headers.get('authorization')).toBeNull();
    const form = request?.form;
    expect(form?.get('grant_type')).toBe('client_credentials');
    expect(form?.get('client_id')).toBe(CLIENT_ID);
    expect(form?.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    );
    expect(form?.get('resource')).toBe(AUDIENCE);
    expect(form?.get('scope')).toBe('module_api other');
    expect(form?.has('client_secret')).toBe(false);

    const assertion = await verifyAssertion(form?.get('client_assertion') ?? '', key);
    expect(assertion.signatureValid).toBe(true);
    expect(assertion.header.alg).toBe('ES256');
    expect(assertion.header.typ).toBe('JWT');
    expect(typeof assertion.header.kid).toBe('string');
    expect(assertion.claims.iss).toBe(CLIENT_ID);
    expect(assertion.claims.sub).toBe(CLIENT_ID);
    expect(assertion.claims.aud).toBe(ISSUER);
    expect(assertion.claims.iat).toBe(NOW / 1000);
    expect(assertion.claims.exp).toBe(NOW / 1000 + 120);
    expect(String(assertion.claims.jti).length).toBeGreaterThan(0);
    expect(String(assertion.claims.jti).length).toBeLessThanOrEqual(256);
  });

  it('omits scope when none is asked for, and strips a trailing slash from the resource', async () => {
    const stub = stubEndpoint();
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: `${AUDIENCE}/`,
      fetch: stub.fetch,
    });
    await source.getToken();
    expect(stub.requests[0]?.form.has('scope')).toBe(false);
    expect(stub.requests[0]?.form.get('resource')).toBe(AUDIENCE);
  });

  it('uses the key id from the JWK when it has one, else the RFC 7638 thumbprint', async () => {
    const key = await ecKey();
    const withKid = stubEndpoint();
    await servicePrincipalTokenSource(
      credential(key, { private_jwk: { ...key.privateJwk, kid: 'my-kid' } }),
      {
        audience: AUDIENCE,
        fetch: withKid.fetch,
      }
    ).getToken();
    const first = await verifyAssertion(
      withKid.requests[0]?.form.get('client_assertion') ?? '',
      key
    );
    expect(first.header.kid).toBe('my-kid');

    const without = stubEndpoint();
    await servicePrincipalTokenSource(credential(key), {
      audience: AUDIENCE,
      fetch: without.fetch,
    }).getToken();
    const second = await verifyAssertion(
      without.requests[0]?.form.get('client_assertion') ?? '',
      key
    );
    // RFC 7638 example shape: base64url(SHA-256) of {"crv","kty","x","y"} is 43 characters.
    const { x, y } = key.privateJwk;
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`{"crv":"P-256","kty":"EC","x":"${String(x)}","y":"${String(y)}"}`)
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(second.header.kid).toBe(expected);
  });

  it('signs RS256 for an RSA key', async () => {
    const key = await rsaKey();
    const stub = stubEndpoint();
    await servicePrincipalTokenSource(credential(key), {
      audience: AUDIENCE,
      fetch: stub.fetch,
    }).getToken();
    const assertion = await verifyAssertion(
      stub.requests[0]?.form.get('client_assertion') ?? '',
      key
    );
    expect(assertion.header.alg).toBe('RS256');
    expect(assertion.signatureValid).toBe(true);
  });

  it('uses a fresh jti for every mint', async () => {
    const clock = clockAt();
    const stub = stubEndpoint();
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stub.fetch,
      clock: clock.clock,
    });
    await source.getToken();
    source.invalidate();
    await source.getToken();
    const jtis = stub.requests.map((r) => {
      const jwt = r.form.get('client_assertion') ?? '';
      const claims = JSON.parse(
        atob(jwt.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? '')
      ) as {
        jti: string;
      };
      return claims.jti;
    });
    expect(jtis).toHaveLength(2);
    expect(new Set(jtis).size).toBe(2);
  });

  it('serves a cached token until shortly before it expires, then mints again', async () => {
    const clock = clockAt();
    const stub = stubEndpoint();
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stub.fetch,
      clock: clock.clock,
    });
    expect(await source.getToken()).toBe('token-1');
    clock.advance(500_000);
    expect(await source.getToken()).toBe('token-1');
    expect(stub.requests).toHaveLength(1);
    clock.advance(80_000); // 580 s of 600 s: inside the 30 s refresh window
    expect(await source.getToken()).toBe('token-2');
    expect(stub.requests).toHaveLength(2);
  });

  it('does not cache a token whose whole life is shorter than the refresh window', async () => {
    const clock = clockAt();
    const stub = stubEndpoint((_r, n) => tokenResponse(`t${String(n)}`, 20));
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stub.fetch,
      clock: clock.clock,
    });
    expect(await source.getToken()).toBe('t1');
    clock.advance(11_000);
    expect(await source.getToken()).toBe('t2');
  });

  it('caps the refresh skew at half the token life: a 20 s token is cached for 10 s', async () => {
    const clock = clockAt();
    const stub = stubEndpoint((_r, n) => tokenResponse(`t${String(n)}`, 20));
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stub.fetch,
      clock: clock.clock,
    });
    expect(await source.getToken()).toBe('t1');
    clock.advance(5_000);
    expect(await source.getToken()).toBe('t1');
    expect(stub.requests).toHaveLength(1);
    clock.advance(5_000);
    expect(await source.getToken()).toBe('t2');
    expect(stub.requests).toHaveLength(2);
  });

  it('shares one request between concurrent callers', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubEndpoint(async (_r, n) => {
      await gate;
      return tokenResponse(`token-${String(n)}`);
    });
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stub.fetch,
    });
    const calls = Array.from({ length: 8 }, () => source.getToken());
    await new Promise((r) => setTimeout(r, 20));
    release?.();
    const tokens = await Promise.all(calls);
    expect(new Set(tokens)).toEqual(new Set(['token-1']));
    expect(stub.requests).toHaveLength(1);
  });

  it('invalidate() during a mint: the pending token is not cached and the next call mints anew', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubEndpoint(async (_r, n) => {
      if (n === 1) await gate;
      return tokenResponse(`token-${String(n)}`);
    });
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stub.fetch,
    });
    const first = source.getToken();
    await new Promise((r) => setTimeout(r, 20));
    source.invalidate();
    expect(await source.getToken()).toBe('token-2');
    // token-1 finishes last, so it would overwrite token-2 in the cache if invalidate() did not stop it.
    release?.();
    expect(await first).toBe('token-1');
    expect(await source.getToken()).toBe('token-2');
    expect(stub.requests).toHaveLength(2);
  });

  it('invalidate() during a mint: a finished old mint does not clear the newer inflight request', async () => {
    const releases: (() => void)[] = [];
    const stub = stubEndpoint(async (_r, n) => {
      await new Promise<void>((resolve) => {
        releases[n] = resolve;
      });
      return tokenResponse(`token-${String(n)}`);
    });
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stub.fetch,
    });
    const a = source.getToken();
    await new Promise((r) => setTimeout(r, 20));
    source.invalidate();
    const b = source.getToken();
    await new Promise((r) => setTimeout(r, 20));
    releases[1]?.();
    expect(await a).toBe('token-1');
    // Mint B is still pending: a third caller must join it, not start mint C.
    const c = source.getToken();
    await new Promise((r) => setTimeout(r, 20));
    releases[2]?.();
    expect(await b).toBe('token-2');
    expect(await c).toBe('token-2');
    expect(stub.requests).toHaveLength(2);
  });

  it('does not cache a failure: the next call tries again', async () => {
    const stub = stubEndpoint((_r, n) =>
      n === 1 ? new Response('upstream', { status: 503 }) : tokenResponse('token-ok')
    );
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stub.fetch,
    });
    await expect(source.getToken()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await source.getToken()).toBe('token-ok');
  });

  it('maps invalid_client to a typed error that says to rotate or re-create', async () => {
    const stub = stubEndpoint(() =>
      Response.json(
        { error: 'invalid_client', error_description: 'unknown client' },
        { status: 400 }
      )
    );
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stub.fetch,
    });
    const error = await source.getToken().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ServicePrincipalError);
    expect((error as ServicePrincipalError).code).toBe('invalid_client');
    expect((error as ServicePrincipalError).status).toBe(400);
    expect((error as Error).message).toMatch(/rotat|re-create|revoked/i);
    // Core's invalid_client also covers clock skew beyond 60 s, so the message must say so.
    expect((error as Error).message).toMatch(/clock/i);
    expect((error as Error).message).not.toContain('client_assertion');
  });

  it('reports other OAuth errors with their code, and non-JSON failures as invalid_response', async () => {
    const key = await ecKey();
    const targetErr = servicePrincipalTokenSource(credential(key), {
      audience: AUDIENCE,
      fetch: stubEndpoint(() =>
        Response.json(
          { error: 'invalid_target', error_description: 'resource not allowed' },
          { status: 400 }
        )
      ).fetch,
    });
    await expect(targetErr.getToken()).rejects.toMatchObject({
      code: 'token_request_rejected',
      oauthError: 'invalid_target',
    });
    const html = servicePrincipalTokenSource(credential(key), {
      audience: AUDIENCE,
      fetch: stubEndpoint(() => new Response('<html>', { status: 502 })).fetch,
    });
    await expect(html.getToken()).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });

  it.each([
    ['no access_token', { token_type: 'Bearer', expires_in: 600 }],
    ['a non-bearer token_type', { access_token: 'a', token_type: 'DPoP', expires_in: 600 }],
    ['no expires_in', { access_token: 'a', token_type: 'Bearer' }],
    ['a non-positive expires_in', { access_token: 'a', token_type: 'Bearer', expires_in: 0 }],
  ])('rejects a 200 with %s', async (_name, body) => {
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stubEndpoint(() => Response.json(body)).fetch,
    });
    await expect(source.getToken()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('wraps a network failure', async () => {
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: () => Promise.reject(new TypeError('connect ECONNREFUSED')),
    });
    await expect(source.getToken()).rejects.toMatchObject({ code: 'network_error' });
  });

  it('makes the token request with redirect: error', async () => {
    const inits: (RequestInit | undefined)[] = [];
    const endpoint = stubEndpoint();
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: (input, init) => {
        inits.push(init);
        return endpoint.fetch(input, init);
      },
    });
    await source.getToken();
    expect(inits).toHaveLength(1);
    expect(inits[0]?.redirect).toBe('error');
  });

  it('fails closed on a redirect: no second request carries the assertion', async () => {
    const elsewhere: string[] = [];
    // Behaves like a real fetch: unless told to error on a redirect, it re-sends the body to Location.
    const redirecting: typeof globalThis.fetch = async (input, init) => {
      const body =
        new Request(input, init).body === null ? '' : await new Request(input, init).text();
      if (init?.redirect !== 'error') {
        elsewhere.push(body);
        return tokenResponse('stolen');
      }
      throw new TypeError('fetch failed: unexpected redirect');
    };
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: redirecting,
    });
    const failure: unknown = await source.getToken().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ServicePrincipalError);
    expect(failure).toMatchObject({ code: 'network_error' });
    expect((failure as ServicePrincipalError).message).not.toContain('redirect');
    expect(elsewhere).toEqual([]);
  });

  it('refuses a bad audience or a malformed credential up front', async () => {
    const key = await ecKey();
    expect(() => servicePrincipalTokenSource(credential(key), { audience: 'govern' })).toThrow(
      /audience/
    );
    expect(() =>
      servicePrincipalTokenSource(credential(key), { audience: 'https://govern.example.test/path' })
    ).toThrow(/origin/);
    expect(() =>
      servicePrincipalTokenSource(
        { ...credential(key), client_id: 'x' },
        {
          audience: AUDIENCE,
        }
      )
    ).toThrow(ServicePrincipalError);
  });

  it('signs a 120 s assertion from the injected clock, so a skewed clock shows in iat and exp', async () => {
    const key = await ecKey();
    for (const skewMs of [0, -90_000, 90_000]) {
      const stub = stubEndpoint();
      const source = servicePrincipalTokenSource(credential(key), {
        audience: AUDIENCE,
        fetch: stub.fetch,
        clock: () => NOW + skewMs,
      });
      await source.getToken();
      const { claims } = await verifyAssertion(
        stub.requests[0]?.form.get('client_assertion') ?? '',
        key
      );
      const iat = (NOW + skewMs) / 1000;
      expect(claims.iat).toBe(iat);
      expect(claims.exp).toBe(iat + 120);
      expect(claims.aud).toBe(ISSUER);
    }
  });

  it('aborts a token request that gets no answer within timeoutMs', async () => {
    const hanging: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: hanging,
      timeoutMs: 30,
    });
    await expect(source.getToken()).rejects.toMatchObject({ code: 'network_error' });
  });

  it('reports a body that stalls past timeoutMs as network_error, not as a bad response', async () => {
    const stalled: typeof globalThis.fetch = (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(init.signal?.reason);
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stalled,
      timeoutMs: 30,
    });
    await expect(source.getToken()).rejects.toMatchObject({ code: 'network_error' });
  });

  it('still reports a 200 whose body is not JSON as invalid_response', async () => {
    const stub = stubEndpoint(() => new Response('<html>', { status: 200 }));
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stub.fetch,
    });
    await expect(source.getToken()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('accepts an origin written with a default port, an upper-case host or a trailing slash', async () => {
    const key = await ecKey();
    for (const audience of [
      'https://govern.example.test:443',
      'https://GOVERN.example.test',
      'https://govern.example.test/',
    ]) {
      const stub = stubEndpoint();
      const source = servicePrincipalTokenSource(credential(key), { audience, fetch: stub.fetch });
      await source.getToken();
      expect(stub.requests[0]?.form.get('resource')).toBe('https://govern.example.test');
    }
    for (const audience of [
      'https://govern.example.test?x=1',
      'https://govern.example.test/#frag',
    ]) {
      expect(() => servicePrincipalTokenSource(credential(key), { audience })).toThrow(/origin/);
    }
  });

  it('feeds createClient: the token source is the getToken seam', async () => {
    const { createClient } = await import('./index.js');
    const stub = stubEndpoint();
    const source = servicePrincipalTokenSource(credential(await ecKey()), {
      audience: AUDIENCE,
      fetch: stub.fetch,
    });
    let seen: string | null = null;
    const api = createClient({
      baseUrl: AUDIENCE,
      getToken: source.getToken,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        seen = new Request(input, init).headers.get('authorization');
        return Promise.resolve(Response.json({}));
      },
    });
    await api.GET('/v1/capabilities');
    expect(seen).toBe('Bearer token-1');
  });
});
