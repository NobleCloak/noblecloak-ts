import { describe, expect, it } from 'vitest';

import { createClient } from './client.js';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
}

function stub(body: unknown = { data: {}, meta: { request_id: 'r1', deployment: 'hosted' } }): {
  fetch: typeof globalThis.fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: (input) => {
      const request = input as Request;
      seen.push({ method: request.method, url: request.url, headers: request.headers });
      return Promise.resolve(Response.json(body));
    },
  };
}

describe('createClient', () => {
  it('sends the token as a bearer credential and returns the {data, meta} envelope', async () => {
    const { fetch, seen } = stub({
      data: { deployment: 'hosted' },
      meta: { request_id: 'r1', deployment: 'hosted' },
    });
    const client = createClient({ baseUrl: 'https://govern.test', getToken: () => 'tok-1', fetch });
    const { data } = await client.GET('/v1/capabilities');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer tok-1');
    expect(seen[0]?.url).toBe('https://govern.test/v1/capabilities');
    expect(data?.meta.request_id).toBe('r1');
  });

  it('asks for the token on every request, so a refresh takes effect', async () => {
    const { fetch, seen } = stub();
    let n = 0;
    const client = createClient({
      baseUrl: 'https://govern.test',
      getToken: () => `tok-${String(++n)}`,
      fetch,
    });
    await client.GET('/v1/capabilities');
    await client.GET('/v1/capabilities');
    expect(seen.map((s) => s.headers.get('authorization'))).toEqual([
      'Bearer tok-1',
      'Bearer tok-2',
    ]);
  });

  it('with a DPoP hook, uses the DPoP scheme and a proof for the URL without its query', async () => {
    const { fetch, seen } = stub();
    const asked: unknown[] = [];
    const client = createClient({
      baseUrl: 'https://govern.test',
      getToken: () => Promise.resolve('tok'),
      dpopProof: (request) => {
        asked.push(request);
        return 'proof-jwt';
      },
      fetch,
    });
    await client.GET('/v1/approvals', { params: { query: { limit: 5 } } });
    expect(seen[0]?.headers.get('authorization')).toBe('DPoP tok');
    expect(seen[0]?.headers.get('dpop')).toBe('proof-jwt');
    expect(asked).toEqual([
      { method: 'GET', url: 'https://govern.test/v1/approvals', accessToken: 'tok' },
    ]);
  });

  it('posts a body through the typed route', async () => {
    const { fetch, seen } = stub();
    const client = createClient({ baseUrl: 'https://govern.test', getToken: () => 't', fetch });
    await client.POST('/v1/decisions', { body: { action: { tool_ref: 'x', arguments: {} } } });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('https://govern.test/v1/decisions');
  });

  it('puts a 401 problem+json in `error` and does not throw', async () => {
    const problem = { type: 'invalid_token', title: 'Token invalid or expired', status: 401 };
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(problem), {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        })
      );
    const client = createClient({ baseUrl: 'https://govern.test', getToken: () => 't', fetch });
    const result = await client.GET('/v1/capabilities');
    expect(result.data).toBeUndefined();
    expect(result.response.status).toBe(401);
    expect(result.error).toMatchObject({ type: 'invalid_token', status: 401 });
  });

  it('a getToken that rejects propagates and nothing is sent', async () => {
    const { fetch, seen } = stub();
    const client = createClient({
      baseUrl: 'https://govern.test',
      getToken: () => Promise.reject(new Error('refresh failed')),
      fetch,
    });
    await expect(client.GET('/v1/capabilities')).rejects.toThrow('refresh failed');
    expect(seen).toEqual([]);
  });

  it('a dpopProof that throws propagates and nothing is sent', async () => {
    const { fetch, seen } = stub();
    const client = createClient({
      baseUrl: 'https://govern.test',
      getToken: () => 'tok',
      dpopProof: () => {
        throw new Error('no key');
      },
      fetch,
    });
    await expect(client.GET('/v1/capabilities')).rejects.toThrow('no key');
    expect(seen).toEqual([]);
  });

  it('overrides an Authorization header the caller supplied', async () => {
    const { fetch, seen } = stub();
    const client = createClient({ baseUrl: 'https://govern.test', getToken: () => 'real', fetch });
    await client.GET('/v1/capabilities', { headers: { Authorization: 'Bearer forged' } });
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer real');
  });
});
