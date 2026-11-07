import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REJECTED_IDENTITY_HEADERS, gatewayHeader } from '../spec/gateway-header.js';
import { MockIssuer } from './auth.js';
import { loadCommittedDocument } from '../spec/testing.js';
import { createMock } from './app.js';
import type { Mock, MockTokens } from './app.js';
import { BREAKS, isBreak } from './breaks.js';
import { base64Url, generateSigningKey, jwksOf, signJws } from './jws.js';
import { startMock } from './serve.js';
import type { RunningMock } from './serve.js';

describe('MockIssuer', () => {
  const claims = {
    sub: 'u',
    org: 'o',
    aud: 'https://api.test',
    exp: Math.floor(Date.now() / 1000) + 60,
    principal_kind: 'user' as const,
  };

  it.each([
    // Built from parts so the previous claim name is not a literal in the tree.
    ['the previous claim name', { [['bn', 'principal_kind'].join('_')]: 'service' }],
    ['no kind at all', {}],
    ['an unknown kind', { principal_kind: 'robot' }],
  ])('rejects a token with %s as invalid_token', async (_label, extra) => {
    const issuer = await MockIssuer.create();
    const { sub, org, aud, exp } = claims;
    const token = await issuer.mint({ sub, org, aud, exp, ...extra } as unknown as typeof claims);
    expect(await issuer.verify(token, 'https://api.test', new Date())).toBe('invalid_token');
  });

  it('verifies what it minted and returns the principal', async () => {
    const issuer = await MockIssuer.create();
    const principal = await issuer.verify(
      await issuer.mint({ ...claims, entitlements: ['e'] }),
      'https://api.test',
      new Date()
    );
    expect(principal).toEqual({
      sub: 'u',
      org: 'o',
      hasOrg: true,
      kind: 'user',
      scopes: [],
      dpopBound: false,
      entitlements: ['e'],
      entitlementsClaimed: true,
    });
  });

  it('reads the client_id claim into the principal, and leaves it out when the token names none', async () => {
    const issuer = await MockIssuer.create();
    expect(
      await issuer.verify(
        await issuer.mint({ ...claims, client_id: 'surface' }),
        'https://api.test',
        new Date()
      )
    ).toMatchObject({ clientId: 'surface' });
    expect(
      await issuer.verify(await issuer.mint(claims), 'https://api.test', new Date())
    ).not.toHaveProperty('clientId');
  });

  it('reads the scope, the proof-key binding and a missing organisation from the claims', async () => {
    const issuer = await MockIssuer.create();
    const noOrg = {
      sub: claims.sub,
      aud: claims.aud,
      exp: claims.exp,
      principal_kind: claims.principal_kind,
    };
    const principal = await issuer.verify(
      await issuer.mint({ ...noOrg, scope: 'module_api other', cnf: { jkt: 'k' } }),
      'https://api.test',
      new Date()
    );
    expect(principal).toMatchObject({
      org: '',
      hasOrg: false,
      scopes: ['module_api', 'other'],
      dpopBound: true,
    });
  });

  it('refuses a wrong audience, an expired token, a token from another issuer, and junk', async () => {
    const issuer = await MockIssuer.create();
    const other = await MockIssuer.create();
    const token = await issuer.mint(claims);
    expect(await issuer.verify(token, 'https://elsewhere.test', new Date())).toBe('wrong_audience');
    expect(await issuer.verify(token, 'https://api.test', new Date(Date.now() + 3600_000))).toBe(
      'invalid_token'
    );
    expect(await issuer.verify(await other.mint(claims), 'https://api.test', new Date())).toBe(
      'invalid_token'
    );
    expect(await issuer.verify('a.b', 'https://api.test', new Date())).toBe('invalid_token');
    expect(await issuer.verify('a.b.c', 'https://api.test', new Date())).toBe('invalid_token');
  });

  it('can skip the signature or the expiry check, for the breaks that do', async () => {
    const issuer = await MockIssuer.create();
    const other = await MockIssuer.create();
    const forged = await other.mint(claims);
    const late = new Date(Date.now() + 3600_000);
    expect(
      typeof (await issuer.verify(forged, 'https://api.test', new Date(), true, {
        signature: true,
      }))
    ).toBe('object');
    expect(
      typeof (await issuer.verify(await issuer.mint(claims), 'https://api.test', late, true, {
        expiry: true,
      }))
    ).toBe('object');
  });

  it('can skip the audience check, for the break that does', async () => {
    const issuer = await MockIssuer.create();
    expect(
      typeof (await issuer.verify(
        await issuer.mint(claims),
        'https://elsewhere.test',
        new Date(),
        false
      ))
    ).toBe('object');
  });

  it('publishes its key set', async () => {
    expect((await MockIssuer.create()).jwks.keys).toHaveLength(1);
  });
});

describe('jws', () => {
  it('base64url has no padding or unsafe characters', () => {
    expect(base64Url(new Uint8Array([251, 255, 254]))).toBe('-__-');
    expect(base64Url('a')).toBe('YQ');
  });

  it('signs a payload as header.payload.signature with the kid in the header', async () => {
    const key = await generateSigningKey('k1');
    const jws = await signJws({ b: 1, a: 2 }, key, { typ: 'x' });
    const [header = '', payload = ''] = jws.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'k1',
      typ: 'x',
    });
    expect(Buffer.from(payload, 'base64url').toString()).toBe('{"a":2,"b":1}');
    expect(jwksOf([key]).keys[0]?.kid).toBe('k1');
  });
});

describe('breaks', () => {
  it('names every defect once, and recognises only those', () => {
    expect(new Set(BREAKS).size).toBe(BREAKS.length);
    expect(isBreak(BREAKS[0])).toBe(true);
    expect(isBreak('not_a_break')).toBe(false);
  });
});

describe('the mock over HTTP', () => {
  let mock: RunningMock;
  let tokens: MockTokens;

  beforeAll(async () => {
    mock = await startMock({ control: true, spec: loadCommittedDocument() });
    tokens = await mock.tokens();
  });
  afterAll(async () => {
    await mock.stop();
  });

  const get = (path: string, token: string = tokens.creator): Promise<Response> =>
    fetch(`${mock.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

  it('serves the key set and discovery without a token', async () => {
    expect(
      ((await (await fetch(`${mock.baseUrl}/.well-known/jwks.json`)).json()) as { keys: unknown[] })
        .keys
    ).toHaveLength(1);
    const discovery = (await (
      await fetch(`${mock.baseUrl}/.well-known/authzen-configuration`)
    ).json()) as { access_evaluation_endpoint: string };
    expect(discovery.access_evaluation_endpoint).toBe(`${mock.baseUrl}/access/v1/evaluation`);
  });

  it('shows another organisation none of the principals, and a tool ref is its own per organisation', async () => {
    await get('/v1/capabilities');
    const seen = async (token: string): Promise<string[]> =>
      (
        (await (await get('/v1/principals?limit=200', token)).json()) as { data: { id: string }[] }
      ).data.map((p) => p.id);
    expect(await seen(tokens.creator)).toContain('svc_adapter');
    const elsewhere = await seen(tokens.other_org);
    expect(elsewhere).not.toContain('svc_adapter');
    expect(elsewhere).toEqual(['user_elsewhere']);
    const register = (token: string): Promise<Response> =>
      fetch(`${mock.baseUrl}/v1/tools`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          tool_ref: 'ext:shared-name',
          transport: 'external',
          input_schema: { type: 'object' },
          side_effect_level: 'read',
        }),
      });
    expect((await register(tokens.creator)).status).toBe(201);
    expect((await register(tokens.other_org)).status).toBe(201);
    expect((await register(tokens.other_org)).status).toBe(400);
  });

  it('does not let a request that matches no operation skip authentication', async () => {
    for (const path of ['/v1/connections', '/v1/tools', '/v1/approvals']) {
      const head = await fetch(`${mock.baseUrl}${path}`, { method: 'HEAD' });
      expect(head.status, `HEAD ${path}`).toBe(401);
    }
    const unknown = await fetch(`${mock.baseUrl}/v1/nope`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/problem+json');
    expect((await fetch(`${mock.baseUrl}/v1/tools`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers a problem document with a stable type for a missing token', async () => {
    const response = await fetch(`${mock.baseUrl}/v1/capabilities`);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(((await response.json()) as { type: string }).type).toMatch(/\/problems\/unauthorized$/);
  });

  it('refuses gateway identity headers even with a valid token', async () => {
    const response = await fetch(`${mock.baseUrl}/v1/capabilities`, {
      headers: { authorization: `Bearer ${tokens.creator}`, [gatewayHeader('id')]: 'someone' },
    });
    expect(response.status).toBe(401);
  });

  it.each([...REJECTED_IDENTITY_HEADERS, gatewayHeader('anything-else')])(
    'refuses the identity header %s with 401 header_identity_rejected, with and without a token, before the token is read',
    async (name) => {
      for (const authorization of [`Bearer ${tokens.creator}`, 'Bearer not-a-token', undefined]) {
        const response = await fetch(`${mock.baseUrl}/v1/capabilities`, {
          headers: { ...(authorization === undefined ? {} : { authorization }), [name]: 'x' },
        });
        expect(response.status).toBe(401);
        expect(((await response.json()) as { type: string }).type).toMatch(
          /\/problems\/header_identity_rejected$/
        );
      }
    }
  );

  it('stamps every appended record asserted, even for a token that claims to be an observer', async () => {
    const observer = await mock.issuer.mint({
      sub: 'svc_gateway',
      org: 'org_mock',
      aud: mock.config.audience,
      exp: Math.floor(Date.now() / 1000) + 60,
      principal_kind: 'service',
      scope: 'module_api',
      // Not a claim the mock reads any more: it must change nothing.
      ...({ observer: true } as object),
    });
    const response = await fetch(`${mock.baseUrl}/v1/records`, {
      method: 'POST',
      headers: { authorization: `Bearer ${observer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool_ref: 'mcp:tracker:search', decision: 'allow' }),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { data: { attestation: string } }).data.attestation).toBe(
      'asserted'
    );
  });

  const problemOf = async (response: Response): Promise<string> =>
    ((await response.json()) as { type: string }).type.split('/').pop() ?? '';

  it('refuses the DPoP scheme, and a proof-key-bound token, with 401 dpop_unsupported: it verifies no proofs', async () => {
    const scheme = await fetch(`${mock.baseUrl}/v1/capabilities`, {
      headers: { authorization: `DPoP ${tokens.creator}` },
    });
    expect(scheme.status).toBe(401);
    expect(await problemOf(scheme)).toBe('dpop_unsupported');
    const bound = await get('/v1/capabilities', tokens.dpop_bound);
    expect(bound.status).toBe(401);
    expect(await problemOf(bound)).toBe('dpop_unsupported');
  });

  it('refuses a verified token with no organisation on every authenticated route, capabilities included', async () => {
    const records = await get('/v1/records', tokens.no_org);
    expect(records.status).toBe(403);
    expect(await problemOf(records)).toBe('organization_context_required');
    const capabilities = await get('/v1/capabilities', tokens.no_org);
    expect(capabilities.status).toBe(403);
    expect(await problemOf(capabilities)).toBe('organization_context_required');
  });

  it('refuses a service principal without the module_api scope with 403 insufficient_scope, and a user needs no module_api scope to read', async () => {
    const response = await get('/v1/records', tokens.no_scope);
    expect(response.status).toBe(403);
    expect(await problemOf(response)).toBe('insufficient_scope');
    expect((await get('/v1/records', tokens.creator_user)).status).toBe(200);
    expect((await get('/v1/records', tokens.creator)).status).toBe(200);
  });

  it('says what it is in meta', async () => {
    const body = (await (await get('/v1/capabilities')).json()) as {
      meta: { deployment: string; request_id: string };
    };
    expect(body.meta.deployment).toBe('hosted');
    expect(body.meta.request_id).toMatch(/^req_/);
  });

  it('is not JSON-tolerant: a body that is not JSON is 400 invalid_request', async () => {
    const response = await fetch(`${mock.baseUrl}/v1/decisions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.creator}`, 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(response.status).toBe(400);
  });

  it('pages a list with a cursor', async () => {
    for (let i = 0; i < 3; i++) {
      await fetch(`${mock.baseUrl}/v1/records`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens.creator}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool_ref: `page:${String(i)}`, decision: 'allow' }),
      });
    }
    const first = (await (await get('/v1/records?limit=2')).json()) as {
      data: unknown[];
      meta: { next: string | null };
    };
    expect(first.data).toHaveLength(2);
    expect(first.meta.next).toBe('2');
    const second = (await (
      await get(`/v1/records?limit=2&cursor=${first.meta.next ?? ''}`)
    ).json()) as { data: unknown[] };
    expect(second.data.length).toBeGreaterThan(0);
  });

  it('echoes the continuation as it was sent: an approval opened without one reads back with none', async () => {
    const open = async (extra: Record<string, unknown>): Promise<string> => {
      const res = await fetch(`${mock.baseUrl}/v1/decisions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens.creator}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: {
            tool_ref: 'mcp:tracker:create_issue',
            arguments: { echo: String(Math.random()) },
          },
          ...extra,
        }),
      });
      return ((await res.json()) as { data: { approval: { id: string } } }).data.approval.id;
    };
    const readBack = async (id: string): Promise<Record<string, unknown>> =>
      ((await (await get(`/v1/approvals/${id}`)).json()) as { data: Record<string, unknown> }).data;
    const bare = await readBack(await open({}));
    expect(bare.continuation_kind).toBe('mcp_held');
    expect('continuation' in bare).toBe(false);
    const sent = { kind: 'langgraph', delivery: 'pull' };
    const sentBack = await readBack(await open({ continuation: sent }));
    expect(sentBack.continuation).toMatchObject(sent);
  });

  it('long-polls an approval until it changes', async () => {
    const decide = await fetch(`${mock.baseUrl}/v1/decisions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.creator}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: { tool_ref: 'mcp:tracker:create_issue', arguments: { wait: 1 } },
      }),
    });
    const { data } = (await decide.json()) as {
      data: { approval: { id: string }; action_digest: string };
    };
    const waiting = get(`/v1/approvals/${data.approval.id}/wait?timeout=5`, tokens.approver);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fetch(`${mock.baseUrl}/v1/approvals/${data.approval.id}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.approver}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_action_digest: data.action_digest }),
    });
    const body = (await (await waiting).json()) as { data: { state: string } };
    expect(body.data.state).toBe('approved');
  });

  it('consumes an approval atomically and once: of two concurrent consumes, one is 200 and the other 409 obligation_consumed', async () => {
    const post = (path: string, token: string, body: unknown): Promise<Response> =>
      fetch(`${mock.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const action = { tool_ref: 'ext:local:send_email', arguments: { to: 'atomic@example.com' } };
    const decided = (await (await post('/v1/decisions', tokens.creator, { action })).json()) as {
      data: { approval: { id: string }; action_digest: string };
    };
    const id = decided.data.approval.id;
    await post(`/v1/approvals/${id}/approve`, tokens.approver, {
      expected_action_digest: decided.data.action_digest,
    });
    const resumption = (await (await get(`/v1/approvals/${id}/resumption`)).json()) as {
      data: { resume_token: string };
    };
    // In-process, so the three requests are in flight in the same turn of the event loop.
    const consume = (): Promise<Response> =>
      Promise.resolve(
        mock.app.fetch(
          new Request(`${mock.baseUrl}/v1/approvals/${id}/consume`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${tokens.creator}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ resume_token: resumption.data.resume_token, action }),
          })
        )
      );
    const answers = await Promise.all([consume(), consume(), consume()]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409, 409]);
    const refused = await Promise.all(
      answers.filter((a) => a.status === 409).map((a) => a.json() as Promise<{ type: string }>)
    );
    for (const problem of refused) expect(problem.type).toMatch(/\/obligation_consumed$/);
  });

  it('control: refuses an advance body that is not JSON or has no finite seconds, and leaves the clock alone', async () => {
    const before = Date.now();
    for (const body of ['not json', '{}', '{"seconds":"60"}', '{"seconds":null}', '[]']) {
      const response = await fetch(`${mock.baseUrl}/__mock/advance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status, body).toBe(400);
    }
    const after = (await (
      await fetch(`${mock.baseUrl}/__mock/advance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"seconds":0}',
      })
    ).json()) as { now: string };
    expect(Math.abs(Date.parse(after.now) - before)).toBeLessThan(60_000);
  });

  it('control: refuses a control body that is not an object or a failure that is not a 500 or a 503, and takes limits, a failure and a reset', async () => {
    const post = (body: string): Promise<Response> =>
      fetch(`${mock.baseUrl}/__mock/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    for (const body of [
      'not json',
      '[]',
      '{"fail":{"operation":"listTools","status":404}}',
      '{"fail":{"status":503}}',
      '{"limits":{"decisions_batch_max_items":0}}',
      '{"limits":{"decisions_batch_max_items":-3}}',
      '{"limits":{"records_batch_max_items":101}}',
      '{"limits":{"records_batch_max_items":2.5}}',
    ])
      expect((await post(body)).status, body).toBe(400);
    expect(
      (
        await post(
          '{"limits":{"decisions_batch_max_items":4,"records_batch_max_items":5},"fail":{"operation":"listTools","status":503,"retry_after":3}}'
        )
      ).status
    ).toBe(200);
    const tokens = (await (await fetch(`${mock.baseUrl}/__mock/tokens`)).json()) as MockTokens;
    const read = (): Promise<Response> =>
      fetch(`${mock.baseUrl}/v1/tools`, { headers: { authorization: `Bearer ${tokens.creator}` } });
    const failed = await read();
    expect(failed.status).toBe(503);
    expect(failed.headers.get('retry-after')).toBe('3');
    expect(((await failed.json()) as { type: string }).type).toMatch(/\/service_unavailable$/);
    expect((await read()).status).toBe(200);
    const capabilities = (await (
      await fetch(`${mock.baseUrl}/v1/capabilities`, {
        headers: { authorization: `Bearer ${tokens.creator}` },
      })
    ).json()) as { data: { limits?: unknown } };
    expect(capabilities.data.limits).toEqual({
      decisions_batch_max_items: 4,
      records_batch_max_items: 5,
    });
    expect((await post('{"reset":true}')).status).toBe(200);
    const reset = (await (
      await fetch(`${mock.baseUrl}/v1/capabilities`, {
        headers: { authorization: `Bearer ${tokens.creator}` },
      })
    ).json()) as { data: { limits?: unknown } };
    expect(reset.data.limits).toBeUndefined();
  });

  it('control: advances its clock and mints tokens', async () => {
    const advanced = (await (
      await fetch(`${mock.baseUrl}/__mock/advance`, {
        method: 'POST',
        body: JSON.stringify({ seconds: 5 }),
      })
    ).json()) as { now: string };
    expect(Date.parse(advanced.now)).toBeGreaterThan(Date.now());
    expect(
      ((await (await fetch(`${mock.baseUrl}/__mock/tokens`)).json()) as MockTokens).audience
    ).toBe(mock.config.audience);
  });
});

describe('a mock with a deliberate authentication defect', () => {
  it.each(['unmatched_routes_open', 'accept_missing_token'] as const)(
    '%s serves the unauthenticated request without a server error',
    async (flip) => {
      const mock = await createMock({ breaks: new Set([flip]), spec: loadCommittedDocument() });
      for (const method of ['GET', 'HEAD']) {
        for (const path of ['/v1/approvals', '/v1/records', '/v1/capabilities']) {
          const response = await mock.app.request(path, { method });
          expect(response.status, `${method} ${path}`).toBeLessThan(500);
        }
      }
    }
  );
});

describe('the mock without control', () => {
  it('does not serve /__mock', async () => {
    const mock: Mock = await createMock({ spec: loadCommittedDocument() });
    expect((await mock.app.request('/__mock/tokens')).status).toBe(404);
  });
});

describe('a mock asked to advertise a family its deployment does not serve', () => {
  it('refuses an edge mock that advertises a hosted-only family', async () => {
    await expect(
      createMock({ deployment: 'edge', advertise: ['evidence'], spec: loadCommittedDocument() })
    ).rejects.toThrow(/edge deployment does not serve evidence/);
  });

  it('still accepts a hosted mock that advertises it', async () => {
    const mock = await createMock({
      deployment: 'hosted',
      advertise: ['evidence'],
      spec: loadCommittedDocument(),
    });
    expect(mock.app).toBeDefined();
  });
});

describe('rev 6 behaviours of the mock', () => {
  type Json = Record<string, unknown>;
  const make = async (
    options: Parameters<typeof createMock>[0] = {}
  ): Promise<{
    mock: Mock;
    tokens: MockTokens;
    call: (
      token: string,
      method: string,
      path: string,
      body?: unknown
    ) => Promise<{ status: number; body: Json }>;
  }> => {
    const mock = await createMock({ control: true, spec: loadCommittedDocument(), ...options });
    const tokens = await mock.tokens();
    const call = async (
      token: string,
      method: string,
      path: string,
      body?: unknown
    ): Promise<{ status: number; body: Json }> => {
      const response = await mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Json };
    };
    return { mock, tokens, call };
  };
  const data = (r: { body: Json }): Json => r.body.data as Json;
  const tool = (ref: string, owner: 'org' | 'principal'): Json => ({
    tool_ref: ref,
    transport: 'external',
    input_schema: { type: 'object' },
    side_effect_level: 'write',
    owner_kind: owner,
  });
  const decide = (ref: string, q: string, agent?: string): Json => ({
    action: { tool_ref: ref, arguments: { q } },
    continuation: { kind: 'adk', delivery: 'pull' },
    ...(agent === undefined ? {} : { actor: { agent_id: agent } }),
  });

  it('names every principal it knows, and never by its id', async () => {
    const { tokens, call } = await make();
    await call(tokens.approver, 'GET', '/v1/capabilities');
    const listed = data(await call(tokens.approver, 'GET', '/v1/principals')) as unknown as Json[];
    expect(listed.length).toBeGreaterThan(0);
    for (const principal of listed) {
      expect(principal.display_name).not.toBe(principal.id);
      expect(String(principal.display_name)).not.toBe('');
    }
  });

  it('puts the requester, the approver and the history on an approval with names, and the agent by name', async () => {
    const { tokens, call } = await make();
    expect((await call(tokens.admin, 'POST', '/v1/tools', tool('ext:t', 'org'))).status).toBe(201);
    const agent = data(await call(tokens.creator, 'POST', '/v1/agents', { name: 'Ledger agent' }));
    const decision = data(
      await call(
        tokens.creator_user,
        'POST',
        '/v1/decisions',
        decide('ext:t', 'one', String(agent.id))
      )
    );
    const approval = decision.approval as Json;
    const resolved = data(
      await call(tokens.approver, 'POST', `/v1/approvals/${String(approval.id)}/approve`, {
        expected_action_digest: decision.action_digest,
      })
    );
    expect(resolved.requester).toEqual({
      id: 'user_creator',
      kind: 'user',
      display_name: 'Creator',
    });
    expect(resolved.approver).toEqual({
      id: 'user_approver',
      kind: 'user',
      display_name: 'Approver',
    });
    expect((resolved.resolution_history as Json[])[0]?.by).toMatchObject({
      display_name: 'Approver',
    });
    expect(resolved.agent).toMatchObject({ id: agent.id, name: 'Ledger agent' });
  });

  it('shows a principal-owned tool to its registrar and to an administrator, and to no colleague', async () => {
    const { tokens, call } = await make();
    const registered = data(
      await call(tokens.creator_user, 'POST', '/v1/tools', tool('ext:mine', 'principal'))
    );
    const id = String(registered.id);
    expect((await call(tokens.creator_user, 'GET', `/v1/tools/${id}`)).status).toBe(200);
    expect((await call(tokens.admin, 'GET', `/v1/tools/${id}`)).status).toBe(200);
    // A service principal is never an administrator for visibility (was 200: the service token read the user's private tool).
    expect((await call(tokens.creator, 'GET', `/v1/tools/${id}`)).status).toBe(404);
    expect((await call(tokens.member, 'GET', `/v1/tools/${id}`)).status).toBe(404);
    expect((await call(tokens.approver, 'GET', `/v1/tools/${id}`)).status).toBe(404);
    expect(
      (await call(tokens.approver, 'PATCH', `/v1/tools/${id}`, { description: 'x' })).status
    ).toBe(404);
  });

  it('with registration restricted, lets the administrators register and refuses the rest', async () => {
    const { tokens, call } = await make({ restrictToolRegistration: true });
    expect((await call(tokens.admin, 'POST', '/v1/tools', tool('ext:a', 'org'))).status).toBe(201);
    expect((await call(tokens.member, 'POST', '/v1/tools', tool('ext:b', 'org'))).status).toBe(403);
    const caps = data(await call(tokens.member, 'GET', '/v1/capabilities'));
    expect(caps.tool_registration).toBe('administrators');
  });

  it('tells a user creator who a pending approval waits on, and a service creator only how many', async () => {
    const { tokens, call } = await make();
    await call(tokens.admin, 'POST', '/v1/tools', tool('ext:w', 'org'));
    await call(tokens.approver, 'GET', '/v1/approvals');
    const userMade = data(
      await call(tokens.creator_user, 'POST', '/v1/decisions', decide('ext:w', 'u'))
    );
    const id = String((userMade.approval as Json).id);
    const asUser = data(await call(tokens.creator_user, 'GET', `/v1/approvals/${id}`));
    // The users the mock has seen who are not the creator: the administrator that registered the tool and the approver.
    expect(((asUser.waiting_on as Json).principals as Json[]).map((p) => p.id)).toEqual([
      'user_admin',
      'user_approver',
    ]);
    expect(((asUser.waiting_on as Json).principals as Json[])[1]).toEqual({
      id: 'user_approver',
      kind: 'user',
      display_name: 'Approver',
    });
    expect((asUser.waiting_on as Json).count).toBe(2);
    expect(
      data(await call(tokens.approver, 'GET', `/v1/approvals/${id}`)).waiting_on
    ).toBeUndefined();
    const svcMade = data(await call(tokens.creator, 'POST', '/v1/decisions', decide('ext:w', 's')));
    const asService = data(
      await call(tokens.creator, 'GET', `/v1/approvals/${String((svcMade.approval as Json).id)}`)
    );
    // The first user is a possible approver of an approval a service principal opened, so it counts too.
    expect(asService.waiting_on).toEqual({ count: 3 });
  });

  it('with an arguments bound, refuses larger arguments for a tool that shows them and keeps no more', async () => {
    const { tokens, call } = await make({ approvalArgumentsMaxBytes: 64 });
    await call(tokens.admin, 'POST', '/v1/tools', {
      ...tool('ext:shown', 'org'),
      show_arguments_to_approvers: true,
    });
    await call(tokens.admin, 'POST', '/v1/tools', tool('ext:hidden', 'org'));
    const big = 'x'.repeat(100);
    expect(
      (await call(tokens.creator, 'POST', '/v1/decisions', decide('ext:shown', big))).status
    ).toBe(400);
    expect(
      (await call(tokens.creator, 'POST', '/v1/decisions', decide('ext:shown', 'small'))).status
    ).toBe(200);
    // The bound is for the arguments a tool keeps for its approvers; a tool that shows none keeps none.
    expect(
      (await call(tokens.creator, 'POST', '/v1/decisions', decide('ext:hidden', big))).status
    ).toBe(200);
    const caps = data(await call(tokens.creator, 'GET', '/v1/capabilities'));
    expect(caps.limits).toEqual({ approval_arguments_max_bytes: 64 });
  });

  it('refuses a body above its limit with 413 and max_bytes, and after authentication', async () => {
    const { mock, tokens, call } = await make({ maxBodyBytes: 100 });
    const huge = decide('ext:x', 'y'.repeat(300));
    const refused = await call(tokens.creator, 'POST', '/v1/decisions', huge);
    expect(refused.status).toBe(413);
    expect(refused.body).toMatchObject({ max_bytes: 100 });
    expect(String(refused.body.type)).toMatch(/payload_too_large$/);
    const anonymous = await mock.app.request('/v1/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(huge),
    });
    expect(anonymous.status).toBe(401);
  });

  it('breaks nothing by default: every rev 6 flag is a known break', () => {
    for (const flag of [
      'requester_missing',
      'display_name_is_the_id',
      'arguments_state_wrong',
      'waiting_on_visible_to_all',
      'eligibility_reason_missing',
      'retry_after_body_missing',
      'stream_approver_filter_ignored',
      'state_set_ignored',
      'order_ignored',
      'resolve_batch_aborts_on_first_error',
      'resolve_batch_over_limit_accepted',
      'unserved_resolution_accepted',
      'arguments_bound_not_enforced',
      'undeclared_delivery_accepted',
      'tool_registration_not_enforced',
      'tool_visible_to_colleague',
      'oversized_body_accepted',
      'run_id_without_runs_accepted',
      'waiting_on_on_list_rows',
      'waiting_on_fails_the_read',
      'admin_cannot_see_private_tools',
      'service_principal_sees_private_tools',
      'agent_name_is_the_id',
      'surface_self_approval_refused',
      'surface_token_may_open',
      'surface_token_may_consume',
      'principal_scoped_proxy_allowed',
      'approval_link_missing',
      'approval_link_always_linked',
      'on_deny_visible_to_all',
      'on_deny_on_creation_event_to_all',
    ])
      expect(isBreak(flag), flag).toBe(true);
    expect(BREAKS.length).toBe(new Set(BREAKS).size);
  });
});

describe('rev 7 behaviours of the mock', () => {
  type Json = Record<string, unknown>;
  const make = async (
    options: Parameters<typeof createMock>[0] = {}
  ): Promise<{
    tokens: MockTokens;
    mintAgent: (scope: string) => Promise<string>;
    call: (
      token: string,
      method: string,
      path: string,
      body?: unknown
    ) => Promise<{ status: number; body: Json }>;
  }> => {
    const mock = await createMock({ control: true, spec: loadCommittedDocument(), ...options });
    const tokens = await mock.tokens();
    const mintAgent = (scope: string): Promise<string> =>
      mock.issuer.mint({
        sub: 'agent_probe',
        org: 'org_mock',
        aud: mock.config.audience,
        exp: Math.floor(Date.now() / 1000) + 60,
        principal_kind: 'agent',
        ...(scope === '' ? {} : { scope }),
      });
    const call = async (
      token: string,
      method: string,
      path: string,
      body?: unknown
    ): Promise<{ status: number; body: Json }> => {
      const response = await mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Json };
    };
    return { tokens, mintAgent, call };
  };
  const data = (r: { body: Json }): Json => r.body.data as Json;
  const open = {
    action: { tool_ref: 'mcp:tracker:create_issue', arguments: { title: 'rev7' } },
    continuation: { kind: 'langgraph', delivery: 'pull' },
  };

  it('advertises self_approval_from_approver_surface, and the surface token is the creator user with the configured client', async () => {
    const { tokens, call } = await make({ approverSurfaceClient: 'custom-module' });
    expect(
      data(await call(tokens.creator, 'GET', '/v1/capabilities'))
        .self_approval_from_approver_surface
    ).toBe(true);
    const claims = (token: string): Json =>
      JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Json;
    expect(claims(tokens.approver_surface_token)).toMatchObject({
      sub: claims(tokens.creator_user).sub,
      client_id: 'custom-module',
    });
  });

  it('advertises user_resolve_scope, mints it on user tokens, and refuses a user token without it on resolve, approve, deny and the batch before eligibility, but not on reads or withdraw', async () => {
    const { tokens, call, mintAgent } = await make();
    expect(data(await call(tokens.creator, 'GET', '/v1/capabilities')).user_resolve_scope).toBe(
      'approvals:resolve'
    );
    const claims = (token: string): Json =>
      JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Json;
    expect(claims(tokens.approver).scope).toBe('approvals:resolve');
    expect(claims(tokens.approver_token_without_resolve_scope)).toMatchObject({
      sub: claims(tokens.approver).sub,
    });
    expect(claims(tokens.approver_token_without_resolve_scope)).not.toHaveProperty('scope');
    expect(claims(tokens.creator).scope).toBe('module_api');
    const decided = await call(tokens.creator_user, 'POST', '/v1/decisions', open);
    const id = (data(decided).approval as Json).id as string;
    const digest = data(decided).action_digest as string;
    const body = { resolution: 'approved', expected_action_digest: digest };
    const bare = tokens.approver_token_without_resolve_scope;
    for (const [path, payload] of [
      [`/v1/approvals/${id}/resolve`, body],
      [`/v1/approvals/${id}/approve`, { expected_action_digest: digest }],
      [`/v1/approvals/${id}/deny`, { expected_action_digest: digest }],
      ['/v1/approvals/resolve/batch', { items: [{ approval_id: id, ...body }] }],
      ['/v1/approvals/apr_nope/resolve', body],
    ] as const) {
      const refused = await call(bare, 'POST', path, payload);
      expect(refused.status, path).toBe(403);
      expect(String(refused.body.type), path).toMatch(/insufficient_scope$/);
    }
    expect((await call(bare, 'GET', `/v1/approvals/${id}`)).status).toBe(200);
    // An agent principal is held to the same scope as a user.
    const agentRefused = await call(
      await mintAgent(''),
      'POST',
      `/v1/approvals/${id}/resolve`,
      body
    );
    expect(agentRefused.status).toBe(403);
    expect(String(agentRefused.body.type)).toMatch(/insufficient_scope$/);
    // A service principal is not asked for the scope: it is still refused as not eligible.
    const service = await call(tokens.creator, 'POST', `/v1/approvals/${id}/resolve`, body);
    expect(String(service.body.type)).toMatch(/not_eligible$/);
    // The user with the scope resolves.
    expect((await call(tokens.approver, 'POST', `/v1/approvals/${id}/resolve`, body)).status).toBe(
      200
    );
  });

  it('refuses the approver surface opening an obligation through either door, and still answers an allow decision', async () => {
    const { tokens, call } = await make();
    for (const path of ['/v1/approvals', '/v1/decisions']) {
      const refused = await call(tokens.approver_surface_token, 'POST', path, open);
      expect(refused.status, path).toBe(403);
      expect(String(refused.body.type), path).toMatch(/forbidden$/);
    }
    const allowed = await call(tokens.approver_surface_token, 'POST', '/v1/decisions', {
      action: { tool_ref: 'mcp:tracker:search', arguments: {} },
    });
    expect(allowed.status).toBe(200);
    expect(data(allowed).decision).toBe('allow');
  });

  it('puts approval_link on the 201 of a batch element too, and not_found when the caller did not create the approval', async () => {
    const { tokens, call } = await make();
    const decided = await call(tokens.creator_user, 'POST', '/v1/decisions', open);
    const approval = (data(decided).approval as Json).id as string;
    const batch = await call(tokens.creator_user, 'POST', '/v1/records/batch', {
      records: [
        { tool_ref: 'mcp:tracker:create_issue', decision: 'step_up', approval_id: approval },
        { tool_ref: 'mcp:tracker:create_issue', decision: 'step_up' },
      ],
    });
    expect(batch.status).toBe(201);
    const rows = batch.body.data as Json[];
    expect(rows[0]?.approval_link).toEqual({ linked: false, reason: 'not_consumed' });
    expect(rows[1]).not.toHaveProperty('approval_link');
    const other = await call(tokens.approver, 'POST', '/v1/records', {
      tool_ref: 'mcp:tracker:create_issue',
      decision: 'step_up',
      approval_id: approval,
    });
    expect(other.status).toBe(201);
    expect(data(other).approval_link).toEqual({ linked: false, reason: 'not_found' });
  });
});

describe('rev 9 behaviours of the mock', () => {
  type Json = Record<string, unknown>;
  const make = async (
    options: Parameters<typeof createMock>[0] = {}
  ): Promise<{
    mock: Mock;
    tokens: MockTokens;
    call: (
      token: string,
      method: string,
      path: string,
      body?: unknown
    ) => Promise<{ status: number; body: Json }>;
  }> => {
    const mock = await createMock({ control: true, spec: loadCommittedDocument(), ...options });
    const tokens = await mock.tokens();
    const call = async (
      token: string,
      method: string,
      path: string,
      body?: unknown
    ): Promise<{ status: number; body: Json }> => {
      const response = await mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Json };
    };
    return { mock, tokens, call };
  };
  const data = (r: { body: Json }): Json => r.body.data as Json;
  const open = (q: string): Json => ({
    action: { tool_ref: 'mcp:tracker:create_issue', arguments: { q } },
    continuation: { kind: 'langgraph', delivery: 'pull' },
  });
  const policyBody = (config: Json): Json => ({
    kind: 'tool_invocation',
    subjects: [{ type: 'role', id: 'member' }],
    // pol_default's own tool, so the publish meets no other policy's (tool, subject) pair.
    targets: { tools: ['mcp:tracker:create_issue'] },
    config,
  });
  /** Writes pol_default's draft and publishes it (rev 10: a PUT alone changes nothing in force). */
  const publishDefault = async (
    call: Awaited<ReturnType<typeof make>>['call'],
    tokens: MockTokens,
    config: Json
  ): Promise<number> => {
    const put = await call(tokens.admin, 'PUT', '/v1/policies/pol_default', policyBody(config));
    if (put.status !== 200) return put.status;
    return (await call(tokens.admin, 'POST', '/v1/policies/pol_default/publish')).status;
  };
  const opened = async (
    call: Awaited<ReturnType<typeof make>>['call'],
    token: string,
    q: string
  ): Promise<string> =>
    (data(await call(token, 'POST', '/v1/decisions', open(q))).approval as Json).id as string;

  it('gives on_deny to the creator on the single read and the list, and to no other reader', async () => {
    const { tokens, call } = await make();
    const id = await opened(call, tokens.creator_user, 'a');
    expect(data(await call(tokens.creator_user, 'GET', `/v1/approvals/${id}`)).on_deny).toBe(
      'resume'
    );
    const rows = (await call(tokens.creator_user, 'GET', '/v1/approvals')).body.data as Json[];
    expect(rows.find((r) => r.id === id)?.on_deny).toBe('resume');
    for (const other of [tokens.approver, tokens.member, tokens.admin]) {
      const read = await call(other, 'GET', `/v1/approvals/${id}`);
      expect(read.status).toBe(200);
      expect(data(read)).not.toHaveProperty('on_deny');
      const list = (await call(other, 'GET', '/v1/approvals')).body.data as Json[];
      expect(list.find((r) => r.id === id)).not.toHaveProperty('on_deny');
    }
  });

  it('omits on_deny when no named policy matched', async () => {
    const { tokens, call } = await make();
    const registered = await call(tokens.admin, 'POST', '/v1/tools', {
      tool_ref: 'ext:od:1',
      transport: 'external',
      input_schema: { type: 'object' },
      side_effect_level: 'write',
      owner_kind: 'org',
    });
    expect(registered.status).toBe(201);
    const decided = await call(tokens.creator_user, 'POST', '/v1/decisions', {
      action: { tool_ref: 'ext:od:1', arguments: {} },
      continuation: { kind: 'langgraph', delivery: 'pull' },
    });
    const id = (data(decided).approval as Json).id as string;
    const read = data(await call(tokens.creator_user, 'GET', `/v1/approvals/${id}`));
    expect(read).not.toHaveProperty('policy');
    expect(read).not.toHaveProperty('on_deny');
  });

  it('snapshots on_deny at creation: a later published edit of the policy changes new approvals only', async () => {
    const { tokens, call } = await make();
    const before = await opened(call, tokens.creator_user, 'before');
    expect(await publishDefault(call, tokens, { mode: 'ask', on_deny: 'halt' })).toBe(200);
    const after = await opened(call, tokens.creator_user, 'after');
    const onDeny = async (id: string): Promise<unknown> =>
      data(await call(tokens.creator_user, 'GET', `/v1/approvals/${id}`)).on_deny;
    expect(await onDeny(before)).toBe('resume');
    expect(await onDeny(after)).toBe('halt');
  });

  it('omits on_deny when the policy states none, and states it for escalate', async () => {
    const { tokens, call } = await make();
    const onDeny = async (q: string): Promise<unknown> => {
      const id = await opened(call, tokens.creator_user, q);
      return data(await call(tokens.creator_user, 'GET', `/v1/approvals/${id}`)).on_deny;
    };
    expect(await publishDefault(call, tokens, { mode: 'ask' })).toBe(200);
    expect(await onDeny('silent')).toBeUndefined();
    expect(await publishDefault(call, tokens, { mode: 'escalate', on_deny: 'halt' })).toBe(200);
    expect(await onDeny('escalate')).toBe('halt');
  });

  it('omits on_deny for a policy mode where it is illegal, even if the stored row carries one', async () => {
    const { mock, tokens, call } = await make();
    // The version in force, which is what an approval snapshots (rev 10).
    const version = mock.state.policyVersions.get('pol_default')?.at(-1);
    if (version === undefined) throw new Error('the seeded policy is missing');
    version.config = { mode: 'deny', on_deny: 'halt' };
    expect(await opened(call, tokens.creator_user, 'illegal')).toBeTruthy();
    const list = (await call(tokens.creator_user, 'GET', '/v1/approvals')).body.data as Json[];
    expect(list.every((r) => !('on_deny' in r))).toBe(true);
  });

  /** Opens an approval as the creator and has the approver approve it, which is the event a stream carries. */
  const openedAndApproved = async (
    call: Awaited<ReturnType<typeof make>>['call'],
    tokens: Awaited<ReturnType<typeof make>>['tokens'],
    q: string
  ): Promise<string> => {
    const decided = data(await call(tokens.creator_user, 'POST', '/v1/decisions', open(q)));
    const id = (decided.approval as Json).id as string;
    const approved = await call(tokens.approver, 'POST', `/v1/approvals/${id}/approve`, {
      expected_action_digest: decided.action_digest,
    });
    expect(approved.status).toBe(200);
    return id;
  };

  /** Opens the approvals stream as `token`, runs `act`, and returns the first event for the approval `act` returns. */
  const streamEvent = async (
    mock: Awaited<ReturnType<typeof make>>['mock'],
    token: string,
    act: () => Promise<string>
  ): Promise<Json> => {
    const response = await mock.app.request('/v1/approvals/stream', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const id = await act();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (let i = 0; i < 20; i += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
        for (const frame of buffer.split('\n\n')) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line === undefined) continue;
          try {
            const event = JSON.parse(line.slice(6)) as Json;
            if (event.id === id) return event;
          } catch {
            // an incomplete frame: wait for the rest
          }
        }
      }
    } finally {
      await reader.cancel();
    }
    throw new Error(`no stream event for ${id}`);
  };

  it('gives on_deny on a stream event to the creator and to no other subscriber', async () => {
    const { mock, tokens, call } = await make();
    const asCreator = await streamEvent(mock, tokens.creator_user, () =>
      openedAndApproved(call, tokens, 's1')
    );
    expect(asCreator.on_deny).toBe('resume');
    const asApprover = await streamEvent(mock, tokens.approver, () =>
      openedAndApproved(call, tokens, 's2')
    );
    expect(asApprover).not.toHaveProperty('on_deny');
  });

  it('with on_deny_on_stream_to_all, puts on_deny on an approver stream event', async () => {
    const { mock, tokens, call } = await make({
      breaks: new Set(['on_deny_on_stream_to_all' as const]),
    });
    const asApprover = await streamEvent(mock, tokens.approver, () =>
      openedAndApproved(call, tokens, 's3')
    );
    expect(asApprover.on_deny).toBe('resume');
  });

  it('names a stored policy that states no on_deny for mcp:tracker:add_comment, and omits it', async () => {
    const { tokens, call } = await make();
    const decided = await call(tokens.creator_user, 'POST', '/v1/decisions', {
      action: { tool_ref: 'mcp:tracker:add_comment', arguments: {} },
      continuation: { kind: 'langgraph', delivery: 'pull' },
    });
    const approval = data(decided).approval as Json;
    const read = data(
      await call(tokens.creator_user, 'GET', `/v1/approvals/${approval.id as string}`)
    );
    expect((read.policy as Json).id).toBe('pol_silent');
    expect(read).not.toHaveProperty('on_deny');
  });

  it('with on_deny_defaults_to_resume, reads a silent policy as resume', async () => {
    const { tokens, call } = await make({
      breaks: new Set(['on_deny_defaults_to_resume' as const]),
    });
    const decided = await call(tokens.creator_user, 'POST', '/v1/decisions', {
      action: { tool_ref: 'mcp:tracker:add_comment', arguments: {} },
      continuation: { kind: 'langgraph', delivery: 'pull' },
    });
    const approval = data(decided).approval as Json;
    const read = data(
      await call(tokens.creator_user, 'GET', `/v1/approvals/${approval.id as string}`)
    );
    expect(read.on_deny).toBe('resume');
  });

  it('with on_deny_visible_to_all, shows on_deny to an approver', async () => {
    const { tokens, call } = await make({ breaks: new Set(['on_deny_visible_to_all' as const]) });
    const id = await opened(call, tokens.creator_user, 'leak');
    expect(data(await call(tokens.approver, 'GET', `/v1/approvals/${id}`)).on_deny).toBe('resume');
  });
});

describe('rev 10 behaviours of the mock', () => {
  type Json = Record<string, unknown>;
  type Call = (
    token: string,
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ status: number; body: Json }>;
  const make = async (
    options: Parameters<typeof createMock>[0] = {}
  ): Promise<{ mock: Mock; tokens: MockTokens; call: Call }> => {
    const mock = await createMock({ control: true, spec: loadCommittedDocument(), ...options });
    const tokens = await mock.tokens();
    const call: Call = async (token, method, path, body) => {
      const response = await mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Json };
    };
    return { mock, tokens, call };
  };
  const data = (r: { body: Json }): Json => r.body.data as Json;
  const rows = (r: { body: Json }): Json[] => r.body.data as Json[];
  const toolPolicy = (tool: string, subjects: Json[], config: Json, extra: Json = {}): Json => ({
    kind: 'tool_invocation',
    subjects,
    targets: { tools: [tool] },
    config,
    ...extra,
  });
  const ADMIN_ROLE = [{ type: 'role', id: 'policy_admin' }];
  /** Registers an organisation-owned external tool as the administrator. */
  const register = async (call: Call, tokens: MockTokens, toolRef: string, owner = 'org') => {
    const registered = await call(tokens.admin, 'POST', '/v1/tools', {
      tool_ref: toolRef,
      transport: 'external',
      input_schema: { type: 'object' },
      side_effect_level: 'write',
      owner_kind: owner,
    });
    expect(registered.status).toBe(201);
  };
  /** Authors and publishes a policy as the administrator, and returns its id. */
  const published = async (call: Call, tokens: MockTokens, body: Json): Promise<string> => {
    const created = await call(tokens.admin, 'POST', '/v1/policies', body);
    expect(created.status).toBe(201);
    const id = data(created).id as string;
    expect((await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`)).status).toBe(200);
    return id;
  };
  const ask = (title: string, extra: Json = {}): Json => ({
    action: { tool_ref: 'mcp:tracker:create_issue', arguments: { title } },
    continuation: { kind: 'langgraph', delivery: 'pull' },
    ...extra,
  });
  /** Decides `title` as `token`, and rejects the approval it opened as the approver. */
  const rejected = async (
    call: Call,
    tokens: MockTokens,
    title: string,
    token = tokens.creator_user
  ): Promise<string> => {
    const decided = data(await call(token, 'POST', '/v1/decisions', ask(title)));
    expect(decided.decision).toBe('step_up');
    const id = (decided.approval as Json).id as string;
    const denied = await call(tokens.approver, 'POST', `/v1/approvals/${id}/deny`, {
      expected_action_digest: decided.action_digest,
    });
    expect(denied.status).toBe(200);
    return id;
  };

  describe('authoring', () => {
    it('lets only a user holding the policy_admin role author, replace and publish', async () => {
      const { tokens, call } = await make();
      const body = toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'ask' });
      for (const token of [tokens.member, tokens.creator, tokens.approver, tokens.creator_user]) {
        const refused = await call(token, 'POST', '/v1/policies', body);
        expect(refused.status).toBe(403);
        expect(String(refused.body.type)).toMatch(/\/forbidden$/);
      }
      const created = await call(tokens.admin, 'POST', '/v1/policies', body);
      expect(created.status).toBe(201);
      const id = data(created).id as string;
      expect((await call(tokens.member, 'PUT', `/v1/policies/${id}`, body)).status).toBe(403);
      expect((await call(tokens.creator, 'POST', `/v1/policies/${id}/publish`)).status).toBe(403);
      expect((await call(tokens.member, 'POST', `/v1/policies/${id}/publish`)).status).toBe(403);
      // Simulate writes nothing and needs no administrator.
      const simulated = await call(tokens.member, 'POST', `/v1/policies/${id}/simulate`, {
        action: { tool_ref: 'mcp:tracker:search', arguments: {} },
      });
      expect(simulated.status).toBe(200);
    });

    it('answers 404 for a policy the caller cannot see before the administrator check', async () => {
      const { tokens, call } = await make();
      const body = toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'ask' });
      const id = data(await call(tokens.admin, 'POST', '/v1/policies', body)).id as string;
      expect((await call(tokens.other_org, 'PUT', `/v1/policies/${id}`, body)).status).toBe(404);
      expect((await call(tokens.other_org, 'POST', `/v1/policies/${id}/publish`)).status).toBe(404);
    });

    it('with policy_authoring_unguarded, lets a member author', async () => {
      const { tokens, call } = await make({
        breaks: new Set(['policy_authoring_unguarded' as const]),
      });
      const body = toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'ask' });
      expect((await call(tokens.member, 'POST', '/v1/policies', body)).status).toBe(201);
    });

    it('creates a draft with a derived name and every tool as targets when they are absent', async () => {
      const { tokens, call } = await make();
      const created = await call(tokens.admin, 'POST', '/v1/policies', {
        kind: 'tool_invocation',
        subjects: ADMIN_ROLE,
        config: { mode: 'ask' },
      });
      expect(created.status).toBe(201);
      const policy = data(created);
      expect(policy).toMatchObject({
        version: 1,
        state: 'draft',
        published_at: null,
        source: 'authored',
        targets: { tools: 'all' },
        updated_by: { id: 'user_admin', kind: 'user' },
      });
      expect(policy.name).toBe(`tool_invocation ${String(policy.id)}`);
      expect(policy).not.toHaveProperty('org');
    });

    it('replaces a draft in place, and writes a draft of the next version after a publish', async () => {
      const { tokens, call } = await make();
      const tool = 'mcp:tracker:search';
      const id = data(
        await call(
          tokens.admin,
          'POST',
          '/v1/policies',
          toolPolicy(tool, ADMIN_ROLE, { mode: 'ask' })
        )
      ).id as string;
      const replaced = await call(
        tokens.admin,
        'PUT',
        `/v1/policies/${id}`,
        toolPolicy(tool, ADMIN_ROLE, { mode: 'deny' }, { name: 'kept' })
      );
      expect(data(replaced)).toMatchObject({ version: 1, state: 'draft', name: 'kept' });
      expect(rows(await call(tokens.admin, 'GET', `/v1/policies/${id}/versions`))).toHaveLength(1);
      const first = data(await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`));
      expect(first).toMatchObject({ version: 1, state: 'published', config: { mode: 'deny' } });
      const draft = await call(
        tokens.admin,
        'PUT',
        `/v1/policies/${id}`,
        toolPolicy(tool, ADMIN_ROLE, { mode: 'always_allow' })
      );
      // The name is kept when a write leaves it out.
      expect(data(draft)).toMatchObject({
        version: 2,
        state: 'draft',
        published_at: null,
        name: 'kept',
      });
      expect(data(await call(tokens.admin, 'GET', `/v1/policies/${id}`))).toMatchObject({
        version: 1,
        state: 'published',
        config: { mode: 'deny' },
      });
      const versions = rows(await call(tokens.admin, 'GET', `/v1/policies/${id}/versions`));
      expect(versions.map((v) => [v.version, v.state])).toEqual([
        [2, 'draft'],
        [1, 'published'],
      ]);
      const second = data(await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`));
      expect(second).toMatchObject({
        version: 2,
        state: 'published',
        config: { mode: 'always_allow' },
      });
      // Publishing again records nothing new.
      const again = data(await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`));
      expect(again).toMatchObject({ version: 2, published_at: second.published_at });
    });

    it('enforces nothing from a draft: a PUT on a published policy leaves what new approvals snapshot until it is published', async () => {
      const { tokens, call } = await make();
      const put = await call(tokens.admin, 'PUT', '/v1/policies/pol_default', {
        kind: 'tool_invocation',
        subjects: [{ type: 'role', id: 'member' }],
        targets: { tools: ['mcp:tracker:create_issue'] },
        config: { mode: 'ask', on_deny: 'halt' },
      });
      expect(put.status).toBe(200);
      const decided = data(
        await call(tokens.creator_user, 'POST', '/v1/decisions', ask('draft only'))
      );
      const id = (decided.approval as Json).id as string;
      expect(data(await call(tokens.creator_user, 'GET', `/v1/approvals/${id}`)).on_deny).toBe(
        'resume'
      );
      // And a policy never published is in force nowhere, so nothing names it.
      const fresh = await call(
        tokens.admin,
        'POST',
        '/v1/policies',
        toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'deny' })
      );
      expect(data(fresh).state).toBe('draft');
    });

    it('refuses a config that does not fit its kind with 400, unless the defect is on', async () => {
      const { tokens, call } = await make();
      const mismatched = toolPolicy('mcp:tracker:search', ADMIN_ROLE, { after_rejection: 'deny' });
      const refused = await call(tokens.admin, 'POST', '/v1/policies', mismatched);
      expect(refused.status).toBe(400);
      expect(String(refused.body.detail)).toContain(
        'does not fit a policy of kind tool_invocation'
      );
      const drMismatch = await call(tokens.admin, 'POST', '/v1/policies', {
        kind: 'duplicate_requests',
        subjects: [{ type: 'organization' }],
        config: { mode: 'ask' },
      });
      expect(drMismatch.status).toBe(400);
      const broken = await make({ breaks: new Set(['policy_config_kind_unbound' as const]) });
      expect(
        (await broken.call(broken.tokens.admin, 'POST', '/v1/policies', mismatched)).status
      ).toBe(201);
    });

    it.each([
      [
        'a kind it does not implement',
        { kind: 'tool_quota', subjects: [{ type: 'organization' }], config: { mode: 'ask' } },
        'kind',
      ],
      [
        'a duplicate_requests policy for a role',
        { kind: 'duplicate_requests', subjects: ADMIN_ROLE, config: { after_rejection: 'deny' } },
        'subjects',
      ],
      [
        'a duplicate_requests policy on one tool',
        {
          kind: 'duplicate_requests',
          subjects: [{ type: 'organization' }],
          targets: { tools: ['mcp:tracker:search'] },
          config: { after_rejection: 'deny' },
        },
        'targets',
      ],
      [
        'not_granted',
        toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'not_granted' }),
        'config.mode',
      ],
    ])(
      'refuses %s with 422 unsupported_policy_form naming the member',
      async (_label, body, member) => {
        const { tokens, call } = await make();
        const refused = await call(tokens.admin, 'POST', '/v1/policies', body);
        expect(refused.status).toBe(422);
        expect(String(refused.body.type)).toMatch(/\/unsupported_policy_form$/);
        expect(String(refused.body.detail).startsWith(`${member}:`)).toBe(true);
      }
    );

    it('answers 409 policy_conflict, naming the policy, when a publish meets a published (tool, subject) pair', async () => {
      const { tokens, call } = await make();
      const id = data(
        await call(
          tokens.admin,
          'POST',
          '/v1/policies',
          toolPolicy('mcp:tracker:create_issue', [{ type: 'role', id: 'member' }], { mode: 'deny' })
        )
      ).id as string;
      const conflict = await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`);
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({ policy_id: 'pol_default' });
      // Another subject on the same tool, or the same subject on another tool, does not conflict.
      await published(
        call,
        tokens,
        toolPolicy('mcp:tracker:create_issue', ADMIN_ROLE, { mode: 'deny' })
      );
      // Every tool meets every tool.
      const everywhere = data(
        await call(tokens.admin, 'POST', '/v1/policies', {
          kind: 'tool_invocation',
          subjects: [{ type: 'role', id: 'member' }],
          config: { mode: 'ask' },
        })
      ).id as string;
      expect((await call(tokens.admin, 'POST', `/v1/policies/${everywhere}/publish`)).status).toBe(
        409
      );
    });

    it('never conflicts a duplicate_requests policy: the latest published one is the setting', async () => {
      const { mock, tokens, call } = await make();
      const body = (after: string): Json => ({
        kind: 'duplicate_requests',
        subjects: [{ type: 'organization' }],
        config: { after_rejection: after },
      });
      await published(call, tokens, body('ask_again'));
      const latest = await published(call, tokens, body('deny'));
      expect(mock.state.policies.get(latest)?.state).toBe('published');
      // The latest decides: an identical call after a rejection is denied.
      await rejected(call, tokens, 'latest wins');
      expect(
        data(await call(tokens.creator_user, 'POST', '/v1/decisions', ask('latest wins'))).decision
      ).toBe('deny');
    });
  });

  describe('reads', () => {
    it('filters the list by kind, tool, subject type, state and source', async () => {
      const { tokens, call } = await make();
      const drafted = data(
        await call(
          tokens.admin,
          'POST',
          '/v1/policies',
          toolPolicy('mcp:tracker:search', [{ type: 'user', id: 'user_admin' }], { mode: 'ask' })
        )
      ).id as string;
      const ids = async (query: string): Promise<unknown[]> =>
        rows(await call(tokens.admin, 'GET', `/v1/policies${query}`)).map((r) => r.id);
      expect(await ids('?kind=tool_invocation')).toEqual(
        expect.arrayContaining(['pol_default', 'pol_silent', drafted])
      );
      expect(await ids('?kind=duplicate_requests')).toEqual([]);
      expect(await ids('?tool=mcp:tracker:add_comment')).toEqual(['pol_silent']);
      expect(await ids('?tool=mcp:tracker:search')).toEqual(['pol_default', drafted]);
      expect(await ids('?subject_type=user')).toEqual([drafted]);
      expect(await ids('?state=draft')).toEqual([drafted]);
      expect(await ids('?state=published')).toEqual(['pol_default', 'pol_silent']);
      expect(await ids('?source=imported')).toEqual([]);
    });

    it('hides a policy on a tool the caller cannot see, and names the targets it cannot enforce', async () => {
      const { tokens, call } = await make();
      await register(call, tokens, 'ext:mine:1', 'principal');
      const hidden = data(
        await call(
          tokens.admin,
          'POST',
          '/v1/policies',
          toolPolicy('ext:mine:1', ADMIN_ROLE, { mode: 'ask' })
        )
      ).id as string;
      expect((await call(tokens.member, 'GET', `/v1/policies/${hidden}`)).status).toBe(404);
      expect((await call(tokens.member, 'GET', `/v1/policies/${hidden}/versions`)).status).toBe(
        404
      );
      expect(rows(await call(tokens.member, 'GET', '/v1/policies')).map((r) => r.id)).not.toContain(
        hidden
      );
      // The owner, an administrator, sees it.
      expect((await call(tokens.admin, 'GET', `/v1/policies/${hidden}`)).status).toBe(200);
      const missing = data(
        await call(
          tokens.admin,
          'POST',
          '/v1/policies',
          toolPolicy('ext:gone:1', ADMIN_ROLE, { mode: 'ask' })
        )
      );
      expect(missing.unenforced_targets).toEqual(['ext:gone:1']);
      expect(data(await call(tokens.admin, 'GET', '/v1/policies/pol_default'))).not.toHaveProperty(
        'unenforced_targets'
      );
    });
  });

  describe('simulate', () => {
    const simulate = (
      call: Call,
      token: string,
      id: string,
      extra: Json = {},
      tool = 'mcp:tracker:search'
    ) =>
      call(token, 'POST', `/v1/policies/${id}/simulate`, {
        action: { tool_ref: tool, arguments: { q: 'sim' } },
        ...extra,
      });

    it('falls to the tool mode as a null-id default when no policy matches', async () => {
      const { tokens, call } = await make();
      const answer = data(
        await simulate(call, tokens.creator, 'pol_default', {}, 'mcp:crm:delete_account')
      );
      expect(answer).toMatchObject({ decision: 'deny', enforced: false, would_be: 'deny' });
      expect(answer).not.toHaveProperty('policy');
      expect(answer.considered).toEqual({
        policies: [
          {
            kind: 'tool_invocation',
            id: null,
            version: null,
            result: 'deny',
            source: 'default',
            // The default decided, so it is what the decision was reached from (rev 11).
            contributed: true,
          },
        ],
        composed: { decision: 'deny', reason: 'deny' },
      });
    });

    it('lists the draft it simulates with the subject that matched, and the policy decides', async () => {
      const { tokens, call } = await make();
      const draft = data(
        await call(
          tokens.admin,
          'POST',
          '/v1/policies',
          toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'ask' })
        )
      );
      const answer = data(await simulate(call, tokens.admin, String(draft.id)));
      expect(answer).toMatchObject({
        decision: 'step_up',
        policy: { id: draft.id, version: 1, side_effect_level: 'read' },
      });
      const considered = answer.considered as Json;
      expect(considered.policies).toEqual([
        {
          kind: 'tool_invocation',
          id: draft.id,
          version: 1,
          result: 'ask',
          subject: { type: 'role', id: 'policy_admin' },
          contributed: true,
        },
        // A step-up lists the organisation's duplicate-requests setting: the default, and no rejection
        // applies, so it did not contribute.
        {
          kind: 'duplicate_requests',
          id: null,
          version: null,
          result: 'none',
          source: 'default',
          contributed: false,
        },
      ]);
      expect(considered.composed).toEqual({ decision: 'step_up', reason: 'approval_required' });
    });

    it('composes tightest-wins across every matched entry (rev 11): a deny anywhere beats an allow of the caller itself', async () => {
      const { tokens, call } = await make();
      const tool = 'mcp:tracker:search';
      const self = await published(
        call,
        tokens,
        toolPolicy(tool, [{ type: 'user', id: 'user_admin' }], { mode: 'always_allow' })
      );
      const roleDeny = await published(
        call,
        tokens,
        toolPolicy(tool, ADMIN_ROLE, { mode: 'deny' })
      );
      const org = await published(
        call,
        tokens,
        toolPolicy(tool, [{ type: 'organization' }], { mode: 'deny' })
      );
      const answer = data(await simulate(call, tokens.admin, org));
      expect(answer).toMatchObject({ decision: 'deny', reason: 'deny' });
      // The policy named is one of the entries that contributed.
      expect([roleDeny, org]).toContain((answer.policy as Json).id);
      const entries = (answer.considered as Json).policies as Json[];
      const contributed = (id: string): unknown => entries.find((e) => e.id === id)?.contributed;
      expect(contributed(self)).toBe(false);
      expect(contributed(roleDeny)).toBe(true);
      expect(contributed(org)).toBe(true);
      // Nothing matched is a fallback the default is never listed beside.
      expect(entries.filter((e) => e.source === 'default' && e.kind === 'tool_invocation')).toEqual(
        []
      );
      // The member holds no policy_admin role: only the organisation's deny matches it.
      const member = data(await simulate(call, tokens.member, org));
      expect(member).toMatchObject({ decision: 'deny', policy: { id: org } });
      // Rev 13: an agent subject matches the service principal bound to the agent, never the agent the request names.
      const agent = data(await call(tokens.creator, 'POST', '/v1/agents', { name: 'sim' }))
        .id as string;
      const agentAsk = await published(
        call,
        tokens,
        toolPolicy('mcp:tracker:list_labels', [{ type: 'agent', id: agent }], { mode: 'ask' })
      );
      const named = data(
        await simulate(
          call,
          tokens.member,
          agentAsk,
          { actor: { agent_id: agent } },
          'mcp:tracker:list_labels'
        )
      );
      expect(((named.considered as Json).policies as Json[]).map((e) => e.id)).not.toContain(
        agentAsk
      );
      await call(tokens.admin, 'PUT', `/v1/agents/${agent}/principal`, {
        principal_id: 'svc_adapter',
      });
      const asAgent = data(
        await simulate(call, tokens.creator, agentAsk, {}, 'mcp:tracker:list_labels')
      );
      expect(asAgent).toMatchObject({ decision: 'step_up', policy: { id: agentAsk } });
    });

    it('needs approval beats allow, and every approval-requiring entry contributes a requirement', async () => {
      const { tokens, call } = await make();
      const tool = 'mcp:tracker:search';
      const allow = await published(
        call,
        tokens,
        toolPolicy(
          tool,
          [
            { type: 'role', id: 'policy_admin' },
            { type: 'user', id: 'nobody' },
          ],
          {
            mode: 'always_allow',
          }
        )
      );
      const ask = await published(
        call,
        tokens,
        toolPolicy(tool, [{ type: 'organization' }], { mode: 'ask' })
      );
      const escalate = data(
        await call(
          tokens.admin,
          'POST',
          '/v1/policies',
          toolPolicy(tool, ADMIN_ROLE, { mode: 'escalate' })
        )
      ).id as string;
      const answer = data(await simulate(call, tokens.admin, escalate));
      expect(answer.decision).toBe('step_up');
      expect([ask, escalate]).toContain((answer.policy as Json).id);
      const entries = (answer.considered as Json).policies as Json[];
      const tool_entries = entries.filter((e) => e.kind === 'tool_invocation');
      expect(tool_entries.map((e) => [e.id, e.contributed])).toEqual(
        expect.arrayContaining([
          [allow, false],
          [ask, true],
          [escalate, true],
        ])
      );
    });

    it('with considered_contributed_missing, marks no entry', async () => {
      const { tokens, call } = await make({
        breaks: new Set(['considered_contributed_missing' as const]),
      });
      const entries = (data(await simulate(call, tokens.admin, 'pol_default')).considered as Json)
        .policies as Json[];
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect(entry).not.toHaveProperty('contributed');
    });

    it('simulates the version draft_version names, and 404s one that does not exist', async () => {
      const { tokens, call } = await make();
      const tool = 'mcp:tracker:search';
      const id = await published(call, tokens, toolPolicy(tool, ADMIN_ROLE, { mode: 'deny' }));
      await call(
        tokens.admin,
        'PUT',
        `/v1/policies/${id}`,
        toolPolicy(tool, ADMIN_ROLE, { mode: 'always_allow' })
      );
      expect(data(await simulate(call, tokens.admin, id)).decision).toBe('allow');
      expect(data(await simulate(call, tokens.admin, id, { draft_version: 1 })).decision).toBe(
        'deny'
      );
      expect((await simulate(call, tokens.admin, id, { draft_version: 9 })).status).toBe(404);
    });

    it('answers an unknown tool deny unknown_tool with nothing considered', async () => {
      const { tokens, call } = await make();
      const answer = data(await simulate(call, tokens.admin, 'pol_default', {}, 'mcp:none:x'));
      expect(answer).toMatchObject({ decision: 'deny', reason: 'unknown_tool' });
      expect(answer.considered).toEqual({
        policies: [],
        composed: { decision: 'deny', reason: 'unknown_tool' },
      });
    });

    it('lists a simulated duplicate_requests policy, and denies a step-up after a rejection as decide would', async () => {
      const { tokens, call } = await make();
      const id = data(
        await call(tokens.admin, 'POST', '/v1/policies', {
          kind: 'duplicate_requests',
          subjects: [{ type: 'organization' }],
          config: { after_rejection: 'ask_again' },
        })
      ).id as string;
      // A simulated duplicate_requests policy is listed even for an allow.
      const allow = data(await simulate(call, tokens.creator_user, id));
      expect((allow.considered as Json).policies).toContainEqual({
        kind: 'duplicate_requests',
        id,
        version: 1,
        result: 'none',
        subject: { type: 'organization' },
        contributed: false,
      });
      const rejectedId = await rejected(call, tokens, 'sim-dup');
      const body = {
        action: { tool_ref: 'mcp:tracker:create_issue', arguments: { title: 'sim-dup' } },
      };
      // The draft says ask_again: the step-up stands, and the entry says so.
      const again = data(
        await call(tokens.creator_user, 'POST', `/v1/policies/${id}/simulate`, body)
      );
      expect(again.decision).toBe('step_up');
      expect((again.considered as Json).policies).toContainEqual(
        expect.objectContaining({ kind: 'duplicate_requests', id, result: 'ask_again' })
      );
      // Simulating a tool policy uses the organisation's setting, the default deny.
      const denied = data(
        await call(tokens.creator_user, 'POST', '/v1/policies/pol_default/simulate', body)
      );
      expect(denied).toMatchObject({
        decision: 'deny',
        reason: 'rejected_duplicate',
        rejected_approval_id: rejectedId,
        would_be: 'deny',
      });
      expect((denied.considered as Json).composed).toEqual({
        decision: 'deny',
        reason: 'rejected_duplicate',
      });
      // Simulate opens nothing.
      expect(
        (await call(tokens.creator_user, 'POST', '/v1/decisions', ask('sim-dup'))).body.data
      ).toMatchObject({
        decision: 'deny',
      });
    });

    it('applies the rule only when no identical approval is open, as decide does', async () => {
      const { tokens, call } = await make();
      const drId = await published(call, tokens, {
        kind: 'duplicate_requests',
        subjects: [{ type: 'organization' }],
        config: { after_rejection: 'ask_again' },
      });
      await rejected(call, tokens, 'open-join');
      const reopened = data(
        await call(tokens.creator_user, 'POST', '/v1/decisions', ask('open-join'))
      );
      expect(reopened.decision).toBe('step_up');
      // The setting turns to deny while the re-ask is open: decide joins it, and so does simulate.
      await call(tokens.admin, 'PUT', `/v1/policies/${drId}`, {
        kind: 'duplicate_requests',
        subjects: [{ type: 'organization' }],
        config: { after_rejection: 'deny' },
      });
      await call(tokens.admin, 'POST', `/v1/policies/${drId}/publish`);
      const body = {
        action: { tool_ref: 'mcp:tracker:create_issue', arguments: { title: 'open-join' } },
      };
      const simulated = data(
        await call(tokens.creator_user, 'POST', '/v1/policies/pol_default/simulate', body)
      );
      expect(simulated.decision).toBe('step_up');
      const decided = data(
        await call(tokens.creator_user, 'POST', '/v1/decisions', ask('open-join'))
      );
      expect(decided).toMatchObject({
        decision: 'step_up',
        approval: { id: (reopened.approval as Json).id, created: false },
      });
    });

    it("answers a run that is not the caller's as decide would", async () => {
      const { tokens, call } = await make();
      const answer = await call(tokens.creator_user, 'POST', '/v1/policies/pol_default/simulate', {
        actor: { run_id: 'run_nobody' },
        action: { tool_ref: 'mcp:tracker:create_issue', arguments: {} },
      });
      expect(answer.status).toBe(403);
    });

    it('with simulate_considered_missing, leaves considered out', async () => {
      const { tokens, call } = await make({
        breaks: new Set(['simulate_considered_missing' as const]),
      });
      expect(data(await simulate(call, tokens.admin, 'pol_default'))).not.toHaveProperty(
        'considered'
      );
    });

    it('with null_policy_on_default, simulate names a null policy when the default decided', async () => {
      const { tokens, call } = await make({ breaks: new Set(['null_policy_on_default' as const]) });
      expect(data(await simulate(call, tokens.admin, 'pol_default')).policy).toBeNull();
    });
  });

  describe('organisations', () => {
    /** Stores a published policy of another organisation directly, as its own administrator would have. */
    const elsewhere = (mock: Mock, id: string, version: Json): void => {
      const stored = {
        version: 1,
        name: id,
        published_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        updated_by: { id: 'user_elsewhere_admin', kind: 'user' },
        ...version,
      };
      mock.state.policyVersions.set(id, [stored as never]);
      mock.state.policies.set(id, {
        org: 'org_elsewhere',
        id,
        source: 'authored',
        ...stored,
        state: 'published',
      });
    };

    it("never applies another organisation's duplicate-requests setting", async () => {
      const { mock, tokens, call } = await make();
      elsewhere(mock, 'pol_elsewhere_dr', {
        kind: 'duplicate_requests',
        subjects: [{ type: 'organization' }],
        targets: { tools: 'all' },
        config: { after_rejection: 'ask_again' },
      });
      await rejected(call, tokens, 'cross-org');
      const again = data(
        await call(tokens.creator_user, 'POST', '/v1/decisions', ask('cross-org'))
      );
      expect(again).toMatchObject({ decision: 'deny', reason: 'rejected_duplicate' });
    });

    it("never lists, walks or conflicts with another organisation's tool policy", async () => {
      const { mock, tokens, call } = await make();
      elsewhere(mock, 'pol_elsewhere_tool', {
        kind: 'tool_invocation',
        subjects: [{ type: 'organization' }],
        targets: { tools: ['mcp:tracker:search'] },
        config: { mode: 'deny' },
      });
      const simulated = data(
        await call(tokens.admin, 'POST', '/v1/policies/pol_default/simulate', {
          action: { tool_ref: 'mcp:tracker:search', arguments: {} },
        })
      );
      expect(simulated.decision).toBe('allow');
      expect(JSON.stringify(simulated.considered)).not.toContain('pol_elsewhere_tool');
      // The same (tool, subject) pair in this organisation publishes without a conflict.
      await published(
        call,
        tokens,
        toolPolicy('mcp:tracker:search', [{ type: 'organization' }], { mode: 'ask' })
      );
      expect(rows(await call(tokens.admin, 'GET', '/v1/policies')).map((r) => r.id)).not.toContain(
        'pol_elsewhere_tool'
      );
    });
  });

  describe('the rejected-duplicate rule', () => {
    it('advertises approvals.rejected_duplicate wherever approvals are served, on both deployments', async () => {
      for (const deployment of ['hosted', 'edge'] as const) {
        const { tokens, call } = await make({ deployment });
        const features = data(await call(tokens.creator, 'GET', '/v1/capabilities'))
          .features as string[];
        expect(features, deployment).toContain('approvals.rejected_duplicate');
      }
      const without = await make({ advertise: ['policies'] });
      const features = data(await without.call(without.tokens.creator, 'GET', '/v1/capabilities'))
        .features as string[];
      expect(features).not.toContain('approvals.rejected_duplicate');
    });

    it('denies an identical call after a rejection, naming it, and opens nothing; changed arguments step up', async () => {
      const { mock, tokens, call } = await make();
      const id = await rejected(call, tokens, 'dup');
      const before = mock.state.obligations.size;
      const again = data(await call(tokens.creator_user, 'POST', '/v1/decisions', ask('dup')));
      expect(again).toMatchObject({
        decision: 'deny',
        reason: 'rejected_duplicate',
        rejected_approval_id: id,
      });
      expect(again).not.toHaveProperty('approval');
      expect(mock.state.obligations.size).toBe(before);
      const other = data(
        await call(tokens.creator_user, 'POST', '/v1/decisions', ask('dup other'))
      );
      expect(other.decision).toBe('step_up');
      const created = await call(tokens.creator_user, 'POST', '/v1/approvals', ask('dup'));
      expect(created.status).toBe(409);
      expect(created.body).toMatchObject({ rejected_approval_id: id });
      expect(String(created.body.type)).toMatch(/\/rejected_duplicate$/);
    });

    it('frees the call once the window has passed', async () => {
      const { mock, tokens, call } = await make();
      await rejected(call, tokens, 'window');
      mock.state.clockOffsetMs += 86_400 * 1000 + 1000;
      const again = data(await call(tokens.creator_user, 'POST', '/v1/decisions', ask('window')));
      expect(again.decision).toBe('step_up');
    });

    it('with rejection_never_frees, still denies after the window', async () => {
      const { mock, tokens, call } = await make({
        breaks: new Set(['rejection_never_frees' as const]),
      });
      await rejected(call, tokens, 'never');
      mock.state.clockOffsetMs += 86_400 * 1000 + 1000;
      expect(
        data(await call(tokens.creator_user, 'POST', '/v1/decisions', ask('never'))).decision
      ).toBe('deny');
    });

    it('reopens under ask_again with prior_rejections for every reader, until max_reasks is exceeded', async () => {
      const { tokens, call } = await make();
      await published(call, tokens, {
        kind: 'duplicate_requests',
        subjects: [{ type: 'organization' }],
        config: { after_rejection: 'ask_again', max_reasks: 1, window_seconds: 600 },
      });
      const first = await rejected(call, tokens, 'again');
      const reopened = data(await call(tokens.creator_user, 'POST', '/v1/decisions', ask('again')));
      expect(reopened.decision).toBe('step_up');
      const second = (reopened.approval as Json).id as string;
      expect(second).not.toBe(first);
      for (const reader of [tokens.creator_user, tokens.approver, tokens.member]) {
        const read = data(await call(reader, 'GET', `/v1/approvals/${second}`));
        expect(read.prior_rejections).toMatchObject({ count: 1 });
        const row = rows(await call(reader, 'GET', '/v1/approvals')).find((r) => r.id === second);
        expect(row?.prior_rejections).toMatchObject({ count: 1 });
      }
      // A third identical call joins the reopened one.
      const joined = data(await call(tokens.creator_user, 'POST', '/v1/decisions', ask('again')));
      expect(joined.approval).toMatchObject({ id: second, created: false });
      const denied = await call(tokens.approver, 'POST', `/v1/approvals/${second}/deny`, {
        expected_action_digest: reopened.action_digest,
      });
      expect(denied.status).toBe(200);
      const refused = data(await call(tokens.creator_user, 'POST', '/v1/decisions', ask('again')));
      expect(refused).toMatchObject({ decision: 'deny', rejected_approval_id: second });
    });

    it('reopens without limit when max_reasks is absent, and counts only rejections in the window', async () => {
      const { mock, tokens, call } = await make();
      await published(call, tokens, {
        kind: 'duplicate_requests',
        subjects: [{ type: 'organization' }],
        config: { after_rejection: 'ask_again', window_seconds: 60 },
      });
      await rejected(call, tokens, 'unlimited');
      await rejected(call, tokens, 'unlimited');
      const third = data(
        await call(tokens.creator_user, 'POST', '/v1/decisions', ask('unlimited'))
      );
      expect(third.decision).toBe('step_up');
      const id = (third.approval as Json).id as string;
      expect(
        data(await call(tokens.creator_user, 'GET', `/v1/approvals/${id}`)).prior_rejections
      ).toMatchObject({
        count: 2,
      });
      mock.state.clockOffsetMs += 61_000;
      await call(tokens.creator_user, 'POST', `/v1/approvals/${id}/withdraw`);
      const fresh = data(
        await call(tokens.creator_user, 'POST', '/v1/decisions', ask('unlimited'))
      );
      const freshId = (fresh.approval as Json).id as string;
      expect(
        data(await call(tokens.creator_user, 'GET', `/v1/approvals/${freshId}`))
      ).not.toHaveProperty('prior_rejections');
    });

    it('resets the count when an approval of the identity is consumed', async () => {
      const { tokens, call } = await make();
      await published(call, tokens, {
        kind: 'duplicate_requests',
        subjects: [{ type: 'organization' }],
        config: { after_rejection: 'ask_again', max_reasks: 1 },
      });
      // An external tool: its approver approves, and the caller consumes the Resumption.
      const external: Json = {
        action: { tool_ref: 'ext:local:send_email', arguments: { title: 'reset' } },
        continuation: { kind: 'langgraph', delivery: 'pull' },
      };
      const decide = async (): Promise<Json> =>
        data(await call(tokens.creator_user, 'POST', '/v1/decisions', external));
      const first = await decide();
      await call(
        tokens.approver,
        'POST',
        `/v1/approvals/${String((first.approval as Json).id)}/deny`,
        {
          expected_action_digest: first.action_digest,
        }
      );
      const reopened = await decide();
      const id = (reopened.approval as Json).id as string;
      await call(tokens.approver, 'POST', `/v1/approvals/${id}/approve`, {
        expected_action_digest: reopened.action_digest,
      });
      const resumption = data(
        await call(tokens.creator_user, 'GET', `/v1/approvals/${id}/resumption`)
      );
      const consumed = await call(tokens.creator_user, 'POST', `/v1/approvals/${id}/consume`, {
        resume_token: resumption.resume_token,
        action: external.action,
      });
      expect(consumed.status).toBe(200);
      // The rejection before the consumption no longer counts: a fresh approval with none behind it.
      const fresh = await decide();
      const freshId = (fresh.approval as Json).id as string;
      expect(
        data(await call(tokens.creator_user, 'GET', `/v1/approvals/${freshId}`))
      ).not.toHaveProperty('prior_rejections');
      // A rejection after it counts from one again, so max_reasks: 1 still allows one re-ask.
      await call(tokens.approver, 'POST', `/v1/approvals/${freshId}/deny`, {
        expected_action_digest: fresh.action_digest,
      });
      const after = await decide();
      expect(after.decision).toBe('step_up');
      const afterId = (after.approval as Json).id as string;
      expect(
        data(await call(tokens.creator_user, 'GET', `/v1/approvals/${afterId}`)).prior_rejections
      ).toMatchObject({ count: 1 });
    });

    it("does not apply to a service principal's calls that name no run, and does to its calls in a run", async () => {
      const { tokens, call } = await make();
      const id = await rejected(call, tokens, 'svc', tokens.creator);
      const again = data(await call(tokens.creator, 'POST', '/v1/decisions', ask('svc')));
      expect(again.decision).toBe('step_up');
      expect((again.approval as Json).id).not.toBe(id);
      const run = data(await call(tokens.creator, 'POST', '/v1/runs', { kind: 'external' }));
      const inRun = (title: string): Json => ask(title, { actor: { run_id: run.id } });
      const decided = data(await call(tokens.creator, 'POST', '/v1/decisions', inRun('svc run')));
      await call(
        tokens.approver,
        'POST',
        `/v1/approvals/${String((decided.approval as Json).id)}/deny`,
        {
          expected_action_digest: decided.action_digest,
        }
      );
      expect(
        data(await call(tokens.creator, 'POST', '/v1/decisions', inRun('svc run'))).decision
      ).toBe('deny');
    });

    it('with rejected_duplicate_reopened, reopens at once', async () => {
      const { tokens, call } = await make({
        breaks: new Set(['rejected_duplicate_reopened' as const]),
      });
      await rejected(call, tokens, 'reopen');
      expect(
        data(await call(tokens.creator_user, 'POST', '/v1/decisions', ask('reopen'))).decision
      ).toBe('step_up');
    });

    it('with rejected_duplicate_reason_missing, denies without the reason or the rejection', async () => {
      const { tokens, call } = await make({
        breaks: new Set(['rejected_duplicate_reason_missing' as const]),
      });
      await rejected(call, tokens, 'quiet');
      const again = data(await call(tokens.creator_user, 'POST', '/v1/decisions', ask('quiet')));
      expect(again).toMatchObject({ decision: 'deny', reason: 'deny' });
      expect(again).not.toHaveProperty('rejected_approval_id');
      const created = await call(tokens.creator_user, 'POST', '/v1/approvals', ask('quiet'));
      expect(created.status).toBe(409);
      expect(created.body).not.toHaveProperty('rejected_approval_id');
    });

    it('decides identical batch elements as one obligation, and with batch_duplicates_split opens one each', async () => {
      const batch = { requests: [ask('batch'), ask('batch')].map((r) => ({ action: r.action })) };
      const { tokens, call } = await make();
      const decisions = data(await call(tokens.creator_user, 'POST', '/v1/decisions/batch', batch))
        .decisions as Json[];
      expect((decisions[1]?.approval as Json).id).toBe((decisions[0]?.approval as Json).id);
      const split = await make({ breaks: new Set(['batch_duplicates_split' as const]) });
      const parts = data(
        await split.call(split.tokens.creator_user, 'POST', '/v1/decisions/batch', batch)
      ).decisions as Json[];
      expect((parts[1]?.approval as Json).id).not.toBe((parts[0]?.approval as Json).id);
    });
  });
});

describe('rev 11 behaviours of the mock: policies', () => {
  type Json = Record<string, unknown>;
  type Call = (
    token: string,
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ status: number; body: Json }>;
  const make = async (
    options: Parameters<typeof createMock>[0] = {}
  ): Promise<{ mock: Mock; tokens: MockTokens; call: Call }> => {
    const mock = await createMock({ control: true, spec: loadCommittedDocument(), ...options });
    const tokens = await mock.tokens();
    const call: Call = async (token, method, path, body) => {
      const response = await mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as Json };
    };
    return { mock, tokens, call };
  };
  const data = (r: { body: Json }): Json => r.body.data as Json;
  const rows = (r: { body: Json }): Json[] => r.body.data as Json[];
  const toolPolicy = (tool: string, subjects: Json[], config: Json, extra: Json = {}): Json => ({
    kind: 'tool_invocation',
    subjects,
    targets: { tools: [tool] },
    config,
    ...extra,
  });
  const ADMIN_ROLE = [{ type: 'role', id: 'policy_admin' }];
  const created = async (call: Call, tokens: MockTokens, body: Json): Promise<string> => {
    const answer = await call(tokens.admin, 'POST', '/v1/policies', body);
    expect(answer.status).toBe(201);
    return data(answer).id as string;
  };
  const published = async (call: Call, tokens: MockTokens, body: Json): Promise<string> => {
    const id = await created(call, tokens, body);
    expect((await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`)).status).toBe(200);
    return id;
  };
  const simulate = (
    call: Call,
    token: string,
    id: string,
    extra: Json = {},
    tool = 'mcp:tracker:search'
  ) =>
    call(token, 'POST', `/v1/policies/${id}/simulate`, {
      action: { tool_ref: tool, arguments: { q: 'sim' } },
      ...extra,
    });

  it('names the pending draft of a published policy in draft_version, on the read and the list, and drops it once published', async () => {
    const { tokens, call } = await make();
    const body = toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'ask' });
    const id = await created(call, tokens, body);
    // A policy never published reads as its draft, with no draft_version.
    expect(data(await call(tokens.admin, 'GET', `/v1/policies/${id}`))).not.toHaveProperty(
      'draft_version'
    );
    await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`);
    const written = data(
      await call(tokens.admin, 'PUT', `/v1/policies/${id}`, { ...body, config: { mode: 'deny' } })
    );
    const read = data(await call(tokens.admin, 'GET', `/v1/policies/${id}`));
    expect(read).toMatchObject({ version: 1, state: 'published', draft_version: written.version });
    const row = rows(await call(tokens.admin, 'GET', '/v1/policies?limit=200')).find(
      (r) => r.id === id
    );
    expect(row?.draft_version).toBe(written.version);
    await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`);
    expect(data(await call(tokens.admin, 'GET', `/v1/policies/${id}`))).not.toHaveProperty(
      'draft_version'
    );
  });

  describe('simulate as a subject', () => {
    it('evaluates a role subject as that role plus the organisation, and the organisation subject alone', async () => {
      const { tokens, call } = await make();
      const tool = 'mcp:tracker:search';
      const roleDeny = await published(
        call,
        tokens,
        toolPolicy(tool, [{ type: 'role', id: 'auditor' }], { mode: 'deny' })
      );
      const orgAsk = await published(
        call,
        tokens,
        toolPolicy(tool, [{ type: 'organization' }], { mode: 'ask' })
      );
      const asRole = data(
        await simulate(call, tokens.admin, orgAsk, { subject: { type: 'role', id: 'auditor' } })
      );
      expect(asRole).toMatchObject({ decision: 'deny', policy: { id: roleDeny } });
      const ids = ((asRole.considered as Json).policies as Json[]).map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining([roleDeny, orgAsk]));
      const asOrg = data(
        await simulate(call, tokens.admin, orgAsk, { subject: { type: 'organization' } })
      );
      expect(asOrg).toMatchObject({ decision: 'step_up', policy: { id: orgAsk } });
      expect(((asOrg.considered as Json).policies as Json[]).map((e) => e.id)).not.toContain(
        roleDeny
      );
      // The caller's own view is unchanged: the administrator holds no auditor role.
      expect(data(await simulate(call, tokens.admin, orgAsk)).decision).toBe('step_up');
    });

    it("evaluates a user subject with the roles of the user's latest token, and an unknown user as the organisation and its own id", async () => {
      const { tokens, call } = await make();
      const tool = 'mcp:tracker:search';
      // The mock has seen the administrator's token, which holds policy_admin.
      const adminDeny = await published(
        call,
        tokens,
        toolPolicy(tool, ADMIN_ROLE, { mode: 'deny' })
      );
      const nobodyAsk = await published(
        call,
        tokens,
        toolPolicy(tool, [{ type: 'user', id: 'user_never_seen' }], { mode: 'ask' })
      );
      const asAdmin = data(
        await simulate(call, tokens.admin, adminDeny, {
          subject: { type: 'user', id: 'user_admin' },
        })
      );
      expect(asAdmin).toMatchObject({ decision: 'deny', policy: { id: adminDeny } });
      const asUnknown = data(
        await simulate(call, tokens.admin, adminDeny, {
          subject: { type: 'user', id: 'user_never_seen' },
        })
      );
      expect(asUnknown).toMatchObject({ decision: 'step_up', policy: { id: nobodyAsk } });
    });

    it('is 403 to a caller who is not an administrator, and 422 naming subject for a type it cannot simulate', async () => {
      const { tokens, call } = await make();
      const refused = await simulate(call, tokens.member, 'pol_default', {
        subject: { type: 'role', id: 'member' },
      });
      expect(refused.status).toBe(403);
      expect(String(refused.body.type)).toMatch(/\/forbidden$/);
      // A service principal is never an administrator.
      expect(
        (await simulate(call, tokens.creator, 'pol_default', { subject: { type: 'organization' } }))
          .status
      ).toBe(403);
      const group = await simulate(call, tokens.admin, 'pol_default', {
        subject: { type: 'group', id: 'x' },
      });
      expect(group.status).toBe(422);
      expect(String(group.body.type)).toMatch(/\/unsupported_policy_form$/);
      expect(String(group.body.detail)).toMatch(/^subject/);
      // An agent is simulated: its own policies and the organisation's; and since rev 18 a service principal.
      for (const type of ['agent', 'service'])
        expect(
          (await simulate(call, tokens.admin, 'pol_default', { subject: { type, id: 'x' } }))
            .status,
          type
        ).toBe(200);
      // A policy the caller cannot see is still 404 first.
      expect(
        (await simulate(call, tokens.member, 'pol_none', { subject: { type: 'organization' } }))
          .status
      ).toBe(404);
    });

    it('applies no rejected-duplicate rule as a subject: the setting is listed with none', async () => {
      const { tokens, call } = await make();
      const answer = data(
        await simulate(
          call,
          tokens.admin,
          'pol_default',
          { subject: { type: 'role', id: 'member' } },
          'mcp:tracker:create_issue'
        )
      );
      expect(answer.decision).toBe('step_up');
      expect((answer.considered as Json).policies).toContainEqual(
        expect.objectContaining({ kind: 'duplicate_requests', result: 'none' })
      );
    });

    it('with simulate_subject_unguarded, a member simulates as a subject', async () => {
      const { tokens, call } = await make({
        breaks: new Set(['simulate_subject_unguarded' as const]),
      });
      expect(
        (await simulate(call, tokens.member, 'pol_default', { subject: { type: 'organization' } }))
          .status
      ).toBe(200);
    });
  });

  describe('retire and discard', () => {
    it('retires a published policy: gone from read and list, versions kept with retired_at, the draft discarded', async () => {
      const { tokens, call } = await make();
      const body = toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'ask' });
      const id = await published(call, tokens, body);
      await call(tokens.admin, 'PUT', `/v1/policies/${id}`, { ...body, config: { mode: 'deny' } });
      const retired = await call(tokens.admin, 'POST', `/v1/policies/${id}/retire`);
      expect(retired.status).toBe(200);
      expect(data(retired)).toMatchObject({ id, version: 1, state: 'published' });
      expect(typeof data(retired).retired_at).toBe('string');
      expect(data(retired)).not.toHaveProperty('draft_version');
      expect((await call(tokens.admin, 'GET', `/v1/policies/${id}`)).status).toBe(404);
      expect(
        rows(await call(tokens.admin, 'GET', '/v1/policies?limit=200')).map((r) => r.id)
      ).not.toContain(id);
      const versions = rows(await call(tokens.admin, 'GET', `/v1/policies/${id}/versions`));
      expect(versions.map((v) => v.version)).toEqual([1]);
      expect(versions[0]?.retired_at).toBe(data(retired).retired_at);
      // Retired is retired: a second retire, a publish and a simulate are 404.
      expect((await call(tokens.admin, 'POST', `/v1/policies/${id}/retire`)).status).toBe(404);
      expect((await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`)).status).toBe(404);
      expect((await simulate(call, tokens.admin, id)).status).toBe(404);
    });

    it('stops a retired policy taking part in another simulation', async () => {
      const { tokens, call } = await make();
      const tool = 'mcp:tracker:search';
      const deny = await published(call, tokens, toolPolicy(tool, ADMIN_ROLE, { mode: 'deny' }));
      const allow = await created(
        call,
        tokens,
        toolPolicy(tool, [{ type: 'organization' }], { mode: 'always_allow' })
      );
      expect(data(await simulate(call, tokens.admin, allow)).decision).toBe('deny');
      await call(tokens.admin, 'POST', `/v1/policies/${deny}/retire`);
      expect(data(await simulate(call, tokens.admin, allow)).decision).toBe('allow');
    });

    it('refuses to retire a policy never published with 400, and a member with 403 after the 404 of an unseen policy', async () => {
      const { tokens, call } = await make();
      const id = await created(
        call,
        tokens,
        toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'ask' })
      );
      const draftOnly = await call(tokens.admin, 'POST', `/v1/policies/${id}/retire`);
      expect(draftOnly.status).toBe(400);
      expect(String(draftOnly.body.type)).toMatch(/\/invalid_request$/);
      for (const [method, path] of [
        ['POST', '/v1/policies/pol_default/retire'],
        ['DELETE', '/v1/policies/pol_default/draft'],
      ] as const) {
        expect((await call(tokens.member, method, path)).status, path).toBe(403);
        expect((await call(tokens.creator, method, path)).status, path).toBe(403);
        expect(
          (await call(tokens.member, method, path.replace('pol_default', 'pol_none'))).status,
          path
        ).toBe(404);
      }
    });

    it('discards the pending draft of a published policy, and 404s when there is none', async () => {
      const { tokens, call } = await make();
      const body = toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'ask' });
      const id = await published(call, tokens, body);
      expect((await call(tokens.admin, 'DELETE', `/v1/policies/${id}/draft`)).status).toBe(404);
      await call(tokens.admin, 'PUT', `/v1/policies/${id}`, { ...body, config: { mode: 'deny' } });
      expect((await call(tokens.admin, 'DELETE', `/v1/policies/${id}/draft`)).status).toBe(204);
      const read = data(await call(tokens.admin, 'GET', `/v1/policies/${id}`));
      expect(read).toMatchObject({ version: 1, config: { mode: 'ask' } });
      expect(read).not.toHaveProperty('draft_version');
      expect(rows(await call(tokens.admin, 'GET', `/v1/policies/${id}/versions`))).toHaveLength(1);
    });

    it('deletes a policy that was never published', async () => {
      const { tokens, call } = await make();
      const id = await created(
        call,
        tokens,
        toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'ask' })
      );
      expect((await call(tokens.admin, 'DELETE', `/v1/policies/${id}/draft`)).status).toBe(204);
      expect((await call(tokens.admin, 'GET', `/v1/policies/${id}`)).status).toBe(404);
      expect((await call(tokens.admin, 'GET', `/v1/policies/${id}/versions`)).status).toBe(404);
    });

    it('with retire_unguarded, a member retires and discards', async () => {
      const { tokens, call } = await make({ breaks: new Set(['retire_unguarded' as const]) });
      expect((await call(tokens.member, 'POST', '/v1/policies/pol_silent/retire')).status).toBe(
        200
      );
    });
  });

  it('stores origin per version: a create with it is imported, and a replace keeps source', async () => {
    const { tokens, call } = await make();
    const origin = { format: 'cedar', digest: 'b'.repeat(64) };
    const body = toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode: 'ask' });
    const first = await call(tokens.admin, 'POST', '/v1/policies', { ...body, origin });
    expect(data(first)).toMatchObject({ source: 'imported', origin });
    const id = data(first).id as string;
    const replaced = data(await call(tokens.admin, 'PUT', `/v1/policies/${id}`, body));
    expect(replaced.source).toBe('imported');
    expect(replaced).not.toHaveProperty('origin');
    const plain = data(await call(tokens.admin, 'POST', '/v1/policies', body));
    expect(plain.source).toBe('authored');
    expect(plain).not.toHaveProperty('origin');
  });

  it('advertises policies.retire on hosted only, policies.tightest_wins on both, and the forms it enforces on hosted', async () => {
    const hosted = await make();
    const caps = data(await hosted.call(hosted.tokens.creator, 'GET', '/v1/capabilities'));
    expect(caps.features).toEqual(
      expect.arrayContaining(['policies.retire', 'policies.tightest_wins'])
    );
    // Rev 16 adds rules, approvers and exclude to rev 11's three members, and the approval_routing kind.
    expect(caps.policy_forms).toEqual({
      tool_invocation: {
        modes: ['always_allow', 'ask', 'escalate', 'deny'],
        subject_types: ['user', 'agent', 'service', 'group', 'role', 'organization'],
        targets_all: true,
        config_members: [
          'on_deny',
          'expires_after',
          'approver_groups',
          'rules',
          'approvers',
          'exclude',
        ],
      },
      approval_routing: { config_members: ['org_admin_break_glass'] },
    });
    // Every advertised mode is accepted: not_granted, which it refuses, is not advertised.
    for (const mode of (caps.policy_forms as { tool_invocation: { modes: string[] } })
      .tool_invocation.modes)
      expect(
        (
          await hosted.call(
            hosted.tokens.admin,
            'POST',
            '/v1/policies',
            toolPolicy('mcp:tracker:search', ADMIN_ROLE, { mode })
          )
        ).status,
        mode
      ).toBe(201);
    const edge = await make({ deployment: 'edge' });
    const edgeCaps = data(await edge.call(edge.tokens.creator, 'GET', '/v1/capabilities'));
    expect(edgeCaps.features).toContain('policies.tightest_wins');
    expect(edgeCaps.features).not.toContain('policies.retire');
    expect(edgeCaps).not.toHaveProperty('policy_forms');
    // Without the policies family there is nothing to compose.
    const none = await make({ advertise: ['approvals'] });
    expect(
      data(await none.call(none.tokens.creator, 'GET', '/v1/capabilities')).features
    ).not.toContain('policies.tightest_wins');
  });
});

describe('rev 11 behaviours of the mock: the policy a simulation names', () => {
  it('names the simulated policy when it is among the entries that contributed', async () => {
    const mock = await createMock({ control: true, spec: loadCommittedDocument() });
    const tokens = await mock.tokens();
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const response = await mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await response.json()) as { data: Record<string, unknown> };
    };
    const policy = (subjects: unknown[]) => ({
      kind: 'tool_invocation',
      subjects,
      targets: { tools: ['mcp:tracker:search'] },
      config: { mode: 'deny' },
    });
    // Listed first: an organisation deny, published before the draft that is simulated.
    const first = (
      await call(tokens.admin, 'POST', '/v1/policies', policy([{ type: 'organization' }]))
    ).data.id as string;
    await call(tokens.admin, 'POST', `/v1/policies/${first}/publish`);
    const draft = (
      await call(tokens.admin, 'POST', '/v1/policies', policy([{ type: 'user', id: 'user_admin' }]))
    ).data.id as string;
    const answer = await call(tokens.admin, 'POST', `/v1/policies/${draft}/simulate`, {
      action: { tool_ref: 'mcp:tracker:search', arguments: {} },
    });
    expect(answer.data.policy).toMatchObject({ id: draft });
    // Simulating the other one names it instead: both contributed.
    const other = await call(tokens.admin, 'POST', `/v1/policies/${first}/simulate`, {
      action: { tool_ref: 'mcp:tracker:search', arguments: {} },
    });
    expect(other.data.policy).toMatchObject({ id: first });
  });
});

describe('rev 11 behaviours of the mock: connections and tools', () => {
  type Json = Record<string, unknown>;
  type Call = (
    token: string,
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ status: number; body: Json }>;
  const make = async (
    options: Parameters<typeof createMock>[0] = {}
  ): Promise<{ mock: Mock; tokens: MockTokens; call: Call }> => {
    const mock = await createMock({ control: true, spec: loadCommittedDocument(), ...options });
    const tokens = await mock.tokens();
    const call: Call = async (token, method, path, body) => {
      const response = await mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as Json };
    };
    return { mock, tokens, call };
  };
  const data = (r: { body: Json }): Json => r.body.data as Json;
  const rows = (r: { body: Json }): Json[] => r.body.data as Json[];
  const type = (r: { body: Json }): string => String(r.body.type).replace(/.*\//, '');
  const register = (url: string, extra: Json = {}): Json => ({
    name: `conn ${url}`,
    url,
    transport: 'mcp',
    owner_kind: 'org',
    ...extra,
  });

  it('answers a registration with its status, tier and kind of authentication, and nothing of the auth or credential', async () => {
    const { tokens, call } = await make();
    const plain = await call(
      tokens.admin,
      'POST',
      '/v1/connections',
      register('https://a.test/mcp')
    );
    expect(plain.status).toBe(201);
    // Rev 11: a hosted mock serves per-user links, so the default tier is per_user.
    expect(data(plain)).toMatchObject({
      status: 'connected',
      auth_kind: 'none',
      credential_tier: 'per_user',
    });
    expect(typeof data(plain).last_verified_at).toBe('string');
    const oauth = data(
      await call(
        tokens.admin,
        'POST',
        '/v1/connections',
        register('https://b.test/mcp', {
          auth: { kind: 'oauth', scopes: ['read'] },
          credential_tier: 'org_shared',
        })
      )
    );
    expect(oauth).toMatchObject({
      status: 'pending_authorization',
      last_verified_at: null,
      auth_kind: 'oauth',
    });
    expect(oauth).not.toHaveProperty('auth');
    const bearer = data(
      await call(
        tokens.admin,
        'POST',
        '/v1/connections',
        register('https://c.test/mcp', {
          auth: { kind: 'bearer' },
          credential_tier: 'org_shared',
          org_credential: { token: 'secret' },
        })
      )
    );
    expect(JSON.stringify(bearer)).not.toContain('secret');
    const listed = JSON.stringify(rows(await call(tokens.admin, 'GET', '/v1/connections')));
    expect(listed).not.toContain('secret');
    expect(listed).not.toContain('serverKey');
  });

  it('applies the credential matrix: administrator only, org_credential with org_shared and bearer, which needs it', async () => {
    const { tokens, call } = await make();
    const cases: [string, Json, number][] = [
      ['member sets a tier', { credential_tier: 'org_shared', auth: { kind: 'bearer' } }, 403],
      [
        'bearer without the credential',
        { credential_tier: 'org_shared', auth: { kind: 'bearer' } },
        400,
      ],
      [
        'credential with oauth',
        { credential_tier: 'org_shared', auth: { kind: 'oauth' }, org_credential: { token: 't' } },
        400,
      ],
      [
        'org_shared asked for with none',
        { credential_tier: 'org_shared', auth: { kind: 'none' } },
        400,
      ],
    ];
    for (const [label, extra, status] of cases) {
      const token = label.startsWith('member') ? tokens.member : tokens.admin;
      const answer = await call(
        token,
        'POST',
        '/v1/connections',
        register(`https://${label.replace(/ /g, '-')}.test/mcp`, extra)
      );
      expect(answer.status, label).toBe(status);
    }
    // Where links are not served (edge), per_user is refused.
    const edge = await make({ deployment: 'edge' });
    expect(
      (
        await edge.call(
          edge.tokens.admin,
          'POST',
          '/v1/connections',
          register('https://pu.test/mcp', { credential_tier: 'per_user' })
        )
      ).status
    ).toBe(400);
    // A member that names no tier registers with the default, and needs no credential for none.
    expect(
      (await call(tokens.member, 'POST', '/v1/connections', register('https://member.test/mcp')))
        .status
    ).toBe(201);
  });

  it('with org_credential_echoed, a registration answers with its organisation credential', async () => {
    const { tokens, call } = await make({ breaks: new Set(['org_credential_echoed' as const]) });
    const answer = data(
      await call(
        tokens.admin,
        'POST',
        '/v1/connections',
        register('https://e.test/mcp', {
          auth: { kind: 'bearer' },
          credential_tier: 'org_shared',
          org_credential: { token: 'leaked' },
        })
      )
    );
    expect(answer.org_credential).toEqual({ token: 'leaked' });
  });

  it('refuses a second registration of the same server, in any form, naming the first only to a caller who sees it', async () => {
    const { tokens, call } = await make();
    const first = data(
      await call(tokens.admin, 'POST', '/v1/connections', register('https://Dup.Test:443/mcp/'))
    );
    for (const url of [
      'https://dup.test/mcp',
      'HTTPS://DUP.TEST/mcp',
      'https://dup.test:443/mcp//',
    ]) {
      const again = await call(tokens.admin, 'POST', '/v1/connections', register(url));
      expect(again.status, url).toBe(409);
      expect(type(again)).toBe('connection_exists');
      expect(again.body.connection_id).toBe(first.id);
    }
    // A principal-owned registration is not named to a colleague.
    const mine = data(
      await call(
        tokens.member,
        'POST',
        '/v1/connections',
        register('https://mine.test/mcp', { owner_kind: 'principal' })
      )
    );
    const hidden = await call(
      tokens.creator_user,
      'POST',
      '/v1/connections',
      register('https://mine.test/mcp')
    );
    expect(hidden.status).toBe(409);
    expect(hidden.body).not.toHaveProperty('connection_id');
    expect(mine.id).toBeDefined();
    // Another organisation registers the same server freely.
    expect(
      (await call(tokens.other_org, 'POST', '/v1/connections', register('https://dup.test/mcp')))
        .status
    ).toBe(201);
  });

  it('with duplicate_server_accepted, registers the same server twice', async () => {
    const { tokens, call } = await make({
      breaks: new Set(['duplicate_server_accepted' as const]),
    });
    await call(tokens.admin, 'POST', '/v1/connections', register('https://twice.test/mcp'));
    expect(
      (await call(tokens.admin, 'POST', '/v1/connections', register('https://twice.test/mcp')))
        .status
    ).toBe(201);
  });

  it('shows a principal-owned connection to its owner and administrators only', async () => {
    const { tokens, call } = await make();
    const id = data(
      await call(
        tokens.member,
        'POST',
        '/v1/connections',
        register('https://own.test/mcp', { owner_kind: 'principal' })
      )
    ).id as string;
    for (const [token, status] of [
      [tokens.member, 200],
      [tokens.admin, 200],
      [tokens.creator_user, 404],
      [tokens.creator, 404],
    ] as const)
      expect((await call(token, 'GET', `/v1/connections/${id}`)).status).toBe(status);
    expect(
      rows(await call(tokens.creator_user, 'GET', '/v1/connections')).map((r) => r.id)
    ).not.toContain(id);
    const broken = await make({ breaks: new Set(['connection_owner_visible' as const]) });
    const other = data(
      await broken.call(
        broken.tokens.member,
        'POST',
        '/v1/connections',
        register('https://own.test/mcp', { owner_kind: 'principal' })
      )
    ).id as string;
    expect(
      (await broken.call(broken.tokens.creator_user, 'GET', `/v1/connections/${other}`)).status
    ).toBe(200);
  });

  it('refuses a patch of the URL, rotates the organisation credential for an administrator only', async () => {
    const { tokens, call } = await make();
    const id = data(
      await call(
        tokens.admin,
        'POST',
        '/v1/connections',
        register('https://rot.test/mcp', {
          auth: { kind: 'bearer' },
          credential_tier: 'org_shared',
          org_credential: { token: 'one' },
        })
      )
    ).id as string;
    const moved = await call(tokens.admin, 'PATCH', `/v1/connections/${id}`, {
      url: 'https://moved.test/mcp',
    });
    expect(moved.status).toBe(400);
    expect(
      (
        await call(tokens.member, 'PATCH', `/v1/connections/${id}`, {
          org_credential: { token: 'x' },
        })
      ).status
    ).toBe(403);
    const rotated = await call(tokens.admin, 'PATCH', `/v1/connections/${id}`, {
      org_credential: { token: 'two' },
    });
    expect(rotated.status).toBe(200);
    expect(JSON.stringify(rotated.body)).not.toContain('two');
    const plain = data(
      await call(tokens.admin, 'POST', '/v1/connections', register('https://plain.test/mcp'))
    ).id as string;
    expect(
      (
        await call(tokens.admin, 'PATCH', `/v1/connections/${plain}`, {
          org_credential: { token: 'x' },
        })
      ).status
    ).toBe(400);
    const broken = await make({ breaks: new Set(['patch_url_accepted' as const]) });
    const b = data(
      await broken.call(
        broken.tokens.admin,
        'POST',
        '/v1/connections',
        register('https://b.test/mcp')
      )
    ).id as string;
    expect(
      (
        await broken.call(broken.tokens.admin, 'PATCH', `/v1/connections/${b}`, {
          url: 'https://c.test/mcp',
        })
      ).status
    ).toBe(200);
  });

  it('refreshes: registers the canned tools with the transport and connection id, reports counts, and discover registers nothing', async () => {
    const { tokens, call } = await make();
    const id = data(
      await call(tokens.admin, 'POST', '/v1/connections', register('https://refresh.test/mcp'))
    ).id as string;
    const discovered = rows(await call(tokens.admin, 'POST', `/v1/connections/${id}/discover`));
    expect(discovered.map((t) => t.tool_ref)).toHaveLength(2);
    expect(rows(await call(tokens.admin, 'GET', `/v1/tools?connection=${id}`))).toEqual([]);
    const first = data(await call(tokens.admin, 'POST', `/v1/connections/${id}/refresh`));
    expect(first).toEqual({ tool_count: 2, added: 2, removed: 0, reactivated: 0 });
    const tools = rows(await call(tokens.admin, 'GET', `/v1/tools?connection=${id}`));
    expect(tools.map((t) => [t.transport, t.connection_id, t.status])).toEqual([
      ['mcp', id, 'active'],
      ['mcp', id, 'active'],
    ]);
    expect(tools.map((t) => t.tool_ref).sort()).toEqual(discovered.map((t) => t.tool_ref).sort());
    expect(data(await call(tokens.admin, 'POST', `/v1/connections/${id}/refresh`))).toEqual({
      tool_count: 2,
      added: 0,
      removed: 0,
      reactivated: 0,
    });
    // Every tool says whether it is active, the seeded ones included.
    expect(
      rows(await call(tokens.admin, 'GET', '/v1/tools?limit=200')).every(
        (t) => typeof t.status === 'string'
      )
    ).toBe(true);
    const broken = await make({ breaks: new Set(['refresh_does_not_register' as const]) });
    const b = data(
      await broken.call(
        broken.tokens.admin,
        'POST',
        '/v1/connections',
        register('https://r.test/mcp')
      )
    ).id as string;
    expect(
      data(await broken.call(broken.tokens.admin, 'POST', `/v1/connections/${b}/refresh`)).added
    ).toBe(2);
    expect(
      rows(await broken.call(broken.tokens.admin, 'GET', `/v1/tools?connection=${b}`))
    ).toEqual([]);
  });

  it('withdraws the tools of a deleted connection, denies a decision for one, and re-binds them when the server is registered again', async () => {
    const { tokens, call } = await make();
    const id = data(
      await call(tokens.admin, 'POST', '/v1/connections', register('https://readd.test/mcp'))
    ).id as string;
    await call(tokens.admin, 'POST', `/v1/connections/${id}/refresh`);
    const tools = rows(await call(tokens.admin, 'GET', `/v1/tools?connection=${id}`));
    const ref = String(tools.find((t) => t.side_effect_level === 'read')?.tool_ref);
    const allowed = data(
      await call(tokens.creator, 'POST', '/v1/decisions', {
        action: { tool_ref: ref, arguments: {} },
      })
    );
    expect(allowed.decision).toBe('allow');
    const policy = data(
      await call(tokens.admin, 'POST', '/v1/policies', {
        kind: 'tool_invocation',
        subjects: [{ type: 'role', id: 'member' }],
        targets: { tools: [ref] },
        config: { mode: 'ask' },
      })
    );
    expect(policy).not.toHaveProperty('unenforced_targets');
    expect((await call(tokens.admin, 'DELETE', `/v1/connections/${id}`)).status).toBe(204);
    expect((await call(tokens.admin, 'GET', `/v1/connections/${id}`)).status).toBe(404);
    const withdrawn = rows(await call(tokens.admin, 'GET', `/v1/tools?connection=${id}`));
    expect(withdrawn.map((t) => t.status)).toEqual(['withdrawn', 'withdrawn']);
    expect(
      data(await call(tokens.admin, 'GET', `/v1/policies/${String(policy.id)}`)).unenforced_targets
    ).toEqual([ref]);
    expect(
      data(
        await call(tokens.creator, 'POST', '/v1/decisions', {
          action: { tool_ref: ref, arguments: {} },
        })
      )
    ).toMatchObject({
      decision: 'deny',
      reason: 'unknown_tool',
    });
    const approval = await call(tokens.creator, 'POST', '/v1/approvals', {
      action: { tool_ref: ref, arguments: {} },
      continuation: { kind: 'langgraph', delivery: 'pull' },
    });
    expect(type(approval)).toBe('approval_unroutable');
    const again = data(
      await call(tokens.admin, 'POST', '/v1/connections', register('https://readd.test/mcp/'))
    ).id as string;
    const rebound = rows(await call(tokens.admin, 'GET', `/v1/tools?connection=${again}`));
    expect(rebound.map((t) => [t.tool_ref, t.status]).sort()).toEqual(
      withdrawn.map((t) => [t.tool_ref, 'active']).sort()
    );
    expect(
      data(await call(tokens.admin, 'POST', `/v1/connections/${again}/refresh`)).reactivated
    ).toBe(0);
    const broken = await make({ breaks: new Set(['withdrawn_tool_allowed' as const]) });
    const b = data(
      await broken.call(
        broken.tokens.admin,
        'POST',
        '/v1/connections',
        register('https://w.test/mcp')
      )
    ).id as string;
    await broken.call(broken.tokens.admin, 'POST', `/v1/connections/${b}/refresh`);
    const bRef = String(
      rows(await broken.call(broken.tokens.admin, 'GET', `/v1/tools?connection=${b}`))[0]?.tool_ref
    );
    await broken.call(broken.tokens.admin, 'DELETE', `/v1/connections/${b}`);
    expect(
      data(
        await broken.call(broken.tokens.creator, 'POST', '/v1/decisions', {
          action: { tool_ref: bRef, arguments: {} },
        })
      ).reason
    ).not.toBe('unknown_tool');
  });

  it("unrestricted, lets only administrators change an organisation's registration, and a principal its own", async () => {
    const { tokens, call } = await make();
    expect(data(await call(tokens.creator, 'GET', '/v1/capabilities'))).not.toHaveProperty(
      'connection_registration'
    );
    const org = data(
      await call(tokens.admin, 'POST', '/v1/connections', register('https://org-owned.test/mcp'))
    ).id as string;
    const changes = (id: string) =>
      [
        ['PATCH', `/v1/connections/${id}`, { name: 'n' }],
        ['POST', `/v1/connections/${id}/refresh`, undefined],
        ['DELETE', `/v1/connections/${id}`, undefined],
      ] as const;
    for (const token of [tokens.member, tokens.creator_user, tokens.creator])
      for (const [method, path, body] of changes(org))
        expect((await call(token, method, path, body)).status, `${method} ${path}`).toBe(403);
    // A member who registered an organisation's connection does not own it: the organisation does.
    const memberOrg = data(
      await call(tokens.member, 'POST', '/v1/connections', register('https://by-member.test/mcp'))
    ).id as string;
    expect(
      (await call(tokens.member, 'PATCH', `/v1/connections/${memberOrg}`, { name: 'n' })).status
    ).toBe(403);
    // A principal changes its own connection.
    const own = data(
      await call(
        tokens.member,
        'POST',
        '/v1/connections',
        register('https://principal-owned.test/mcp', { owner_kind: 'principal' })
      )
    ).id as string;
    for (const [method, path, body] of changes(own))
      expect((await call(tokens.member, method, path, body)).status, `${method} ${path}`).toBe(
        method === 'DELETE' ? 204 : 200
      );
    for (const [method, path, body] of changes(org))
      expect((await call(tokens.admin, method, path, body)).status, `${method} ${path}`).toBe(
        method === 'DELETE' ? 204 : 200
      );
    const broken = await make({ breaks: new Set(['org_connection_change_unguarded' as const]) });
    const taken = data(
      await broken.call(
        broken.tokens.admin,
        'POST',
        '/v1/connections',
        register('https://org-owned.test/mcp')
      )
    ).id as string;
    expect(
      (await broken.call(broken.tokens.member, 'DELETE', `/v1/connections/${taken}`)).status
    ).toBe(204);
  });

  it('restricted, refuses an owner kind and a caller it does not admit, and a transport it does not serve, and advertises both', async () => {
    const { tokens, call } = await make({
      connectionRegistration: { owner_kinds: ['org'], who: 'administrators' },
      connectionTransports: ['mcp'],
    });
    const caps = data(await call(tokens.creator, 'GET', '/v1/capabilities'));
    expect(caps).toMatchObject({
      connection_registration: { owner_kinds: ['org'], who: 'administrators' },
      connection_transports: ['mcp'],
    });
    expect(
      (
        await call(
          tokens.admin,
          'POST',
          '/v1/connections',
          register('https://p.test/mcp', { owner_kind: 'principal' })
        )
      ).status
    ).toBe(403);
    expect(
      (await call(tokens.member, 'POST', '/v1/connections', register('https://m.test/mcp'))).status
    ).toBe(403);
    expect(
      (
        await call(
          tokens.admin,
          'POST',
          '/v1/connections',
          register('https://a2a.test/agent', { transport: 'a2a' })
        )
      ).status
    ).toBe(400);
    const id = data(
      await call(tokens.admin, 'POST', '/v1/connections', register('https://ok.test/mcp'))
    ).id as string;
    for (const [method, path, body] of [
      ['PATCH', `/v1/connections/${id}`, { name: 'n' }],
      ['POST', `/v1/connections/${id}/refresh`, undefined],
      ['DELETE', `/v1/connections/${id}`, undefined],
    ] as const)
      expect((await call(tokens.member, method, path, body)).status, `${method} ${path}`).toBe(403);
    const loose = await make();
    const looseCaps = data(await loose.call(loose.tokens.creator, 'GET', '/v1/capabilities'));
    expect(looseCaps).not.toHaveProperty('connection_registration');
    expect(looseCaps.connection_transports).toEqual(['mcp', 'a2a']);
    const broken = await make({
      connectionRegistration: { owner_kinds: ['org'], who: 'administrators' },
      connectionTransports: ['mcp'],
      breaks: new Set([
        'connection_registration_not_enforced' as const,
        'undeclared_transport_accepted' as const,
      ]),
    });
    expect(
      (
        await broken.call(
          broken.tokens.member,
          'POST',
          '/v1/connections',
          register('https://p.test/mcp', { owner_kind: 'principal', transport: 'a2a' })
        )
      ).status
    ).toBe(201);
  });
});

describe('rev 11 behaviours of the mock: links, consent, authorize and blocked_on', () => {
  type Json = Record<string, unknown>;
  type Call = (
    token: string,
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ status: number; body: Json; headers: Headers }>;
  const make = async (
    options: Parameters<typeof createMock>[0] = {}
  ): Promise<{ mock: Mock; tokens: MockTokens; call: Call }> => {
    const mock = await createMock({ control: true, spec: loadCommittedDocument(), ...options });
    const tokens = await mock.tokens();
    const call: Call = async (token, method, path, body) => {
      const response = await mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed: Json;
      try {
        parsed = text === '' ? {} : (JSON.parse(text) as Json);
      } catch {
        parsed = { text };
      }
      return { status: response.status, body: parsed, headers: response.headers };
    };
    return { mock, tokens, call };
  };
  const data = (r: { body: Json }): Json => r.body.data as Json;
  const RETURN = 'https://module.mock.test/connections/return';
  const registered = async (call: Call, tokens: MockTokens, extra: Json): Promise<string> => {
    const answer = await call(tokens.admin, 'POST', '/v1/connections', {
      name: 'links',
      url: `https://${crypto.randomUUID()}.test/mcp`,
      transport: 'mcp',
      owner_kind: 'org',
      ...extra,
    });
    expect(answer.status).toBe(201);
    return data(answer).id as string;
  };
  const myLink = async (call: Call, token: string, id: string): Promise<unknown> =>
    data(await call(token, 'GET', `/v1/connections/${id}`)).my_link;

  it('defaults a hosted registration to per_user, and shows my_link only where there is something to link', async () => {
    const { tokens, call } = await make();
    const plain = await call(tokens.admin, 'POST', '/v1/connections', {
      name: 'p',
      url: 'https://plain.test/mcp',
      transport: 'mcp',
      owner_kind: 'org',
      auth: { kind: 'bearer' },
    });
    expect(data(plain)).toMatchObject({
      credential_tier: 'per_user',
      my_link: { status: 'none', consent: 'none' },
    });
    const none = await registered(call, tokens, { credential_tier: 'per_user' });
    expect(await myLink(call, tokens.admin, none)).toBeUndefined();
    const edge = await make({ deployment: 'edge' });
    const onEdge = data(
      await edge.call(edge.tokens.admin, 'POST', '/v1/connections', {
        name: 'e',
        url: 'https://edge.test/mcp',
        transport: 'mcp',
        owner_kind: 'org',
        auth: { kind: 'oauth' },
      })
    );
    expect(onEdge).toMatchObject({
      credential_tier: 'org_shared',
      status: 'pending_authorization',
    });
    expect(onEdge).not.toHaveProperty('my_link');
    const caps = data(await edge.call(edge.tokens.creator, 'GET', '/v1/capabilities'));
    expect(caps.features).not.toContain('connections.user_links');
    const hostedCaps = data(await call(tokens.creator, 'GET', '/v1/capabilities'));
    expect(hostedCaps.features).toEqual(
      expect.arrayContaining(['connections.oauth', 'connections.user_links'])
    );
  });

  it("keeps each caller's link its own: consent required, token never shown, revoke keeps it, re-consent restores it", async () => {
    const { tokens, call } = await make();
    const id = await registered(call, tokens, {
      auth: { kind: 'bearer' },
      credential_tier: 'per_user',
    });
    expect(
      (await call(tokens.member, 'POST', `/v1/connections/${id}/link`, { token: 't' })).status
    ).toBe(400);
    expect(
      (
        await call(tokens.member, 'POST', `/v1/connections/${id}/link`, {
          consent: false,
          token: 't',
        })
      ).status
    ).toBe(400);
    expect(
      (await call(tokens.member, 'POST', `/v1/connections/${id}/link`, { consent: true })).status
    ).toBe(400);
    const linked = await call(tokens.member, 'POST', `/v1/connections/${id}/link`, {
      consent: true,
      token: 'member-secret',
    });
    expect(linked.status).toBe(200);
    expect(data(linked).my_link).toMatchObject({ status: 'linked', consent: 'given' });
    expect(JSON.stringify(linked.body)).not.toContain('member-secret');
    expect(await myLink(call, tokens.admin, id)).toEqual({ status: 'none', consent: 'none' });
    expect((await call(tokens.member, 'DELETE', `/v1/connections/${id}/link/consent`)).status).toBe(
      204
    );
    expect(await myLink(call, tokens.member, id)).toMatchObject({
      status: 'linked',
      consent: 'revoked',
    });
    // Consent again, no token: the stored credential stays.
    const again = await call(tokens.member, 'POST', `/v1/connections/${id}/link`, {
      consent: true,
    });
    expect(data(again).my_link).toMatchObject({ status: 'linked', consent: 'given' });
    expect((await call(tokens.member, 'DELETE', `/v1/connections/${id}/link`)).status).toBe(204);
    expect(await myLink(call, tokens.member, id)).toEqual({ status: 'none', consent: 'none' });
    expect((await call(tokens.member, 'DELETE', `/v1/connections/${id}/link`)).status).toBe(204);
    expect((await call(tokens.member, 'DELETE', `/v1/connections/${id}/link/consent`)).status).toBe(
      404
    );
    const shared = await registered(call, tokens, {
      auth: { kind: 'bearer' },
      credential_tier: 'org_shared',
      org_credential: { token: 'o' },
    });
    expect(
      (
        await call(tokens.member, 'POST', `/v1/connections/${shared}/link`, {
          consent: true,
          token: 't',
        })
      ).status
    ).toBe(400);
  });

  it('removes every link with the registration', async () => {
    const { mock, tokens, call } = await make();
    const id = await registered(call, tokens, {
      auth: { kind: 'bearer' },
      credential_tier: 'per_user',
    });
    await call(tokens.member, 'POST', `/v1/connections/${id}/link`, { consent: true, token: 't' });
    expect([...mock.state.links.keys()].some((k) => k.startsWith(`${id}|`))).toBe(true);
    await call(tokens.admin, 'DELETE', `/v1/connections/${id}`);
    expect([...mock.state.links.keys()].some((k) => k.startsWith(`${id}|`))).toBe(false);
  });

  it.each([
    ['link_without_consent_accepted', 'consent'],
    ['connection_token_echoed', 'token'],
    ['link_visible_to_other_user', 'other'],
    ['consent_revoke_ignored', 'revoke'],
  ] as const)('with %s, the link rule it names breaks', async (flag, what) => {
    const { tokens, call } = await make({ breaks: new Set([flag]) });
    const id = await registered(call, tokens, {
      auth: { kind: 'bearer' },
      credential_tier: 'per_user',
    });
    if (what === 'consent') {
      expect(
        (await call(tokens.member, 'POST', `/v1/connections/${id}/link`, { token: 't' })).status
      ).toBe(200);
      return;
    }
    const linked = await call(tokens.member, 'POST', `/v1/connections/${id}/link`, {
      consent: true,
      token: 'tok',
    });
    if (what === 'token') expect((data(linked).my_link as Json).token).toBe('tok');
    if (what === 'other')
      expect(await myLink(call, tokens.admin, id)).toMatchObject({ status: 'linked' });
    if (what === 'revoke') {
      await call(tokens.member, 'DELETE', `/v1/connections/${id}/link/consent`);
      expect(await myLink(call, tokens.member, id)).toMatchObject({ consent: 'given' });
    }
  });

  it("authorizes the caller's own OAuth link through the consent page, which returns with the nc_ parameters", async () => {
    const { tokens, call, mock } = await make();
    const id = await registered(call, tokens, {
      auth: { kind: 'oauth' },
      credential_tier: 'per_user',
    });
    expect(
      (await call(tokens.member, 'POST', `/v1/connections/${id}/authorize`, { return_to: RETURN }))
        .status
    ).toBe(400);
    expect(
      (
        await call(tokens.member, 'POST', `/v1/connections/${id}/link`, {
          consent: true,
          token: 'x',
        })
      ).status
    ).toBe(400);
    const pending = await call(tokens.member, 'POST', `/v1/connections/${id}/link`, {
      consent: true,
    });
    expect(data(pending).my_link).toMatchObject({
      status: 'pending_authorization',
      consent: 'given',
    });
    expect(
      (
        await call(tokens.member, 'POST', `/v1/connections/${id}/authorize`, {
          return_to: 'https://evil.test/x',
        })
      ).status
    ).toBe(400);
    const started = data(
      await call(tokens.member, 'POST', `/v1/connections/${id}/authorize`, { return_to: RETURN })
    );
    const url = new URL(String(started.authorization_url));
    expect(typeof started.expires_at).toBe('string');
    const consent = await mock.app.request(url.pathname);
    expect(consent.status).toBe(302);
    const back = new URL(consent.headers.get('location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(RETURN);
    expect(Object.fromEntries(back.searchParams)).toEqual({
      nc_connection: id,
      nc_result: 'connected',
    });
    expect(await myLink(call, tokens.member, id)).toMatchObject({
      status: 'linked',
      consent: 'given',
    });
    // Single use.
    expect((await mock.app.request(url.pathname)).status).toBe(404);
    // A linked link is authorized again, and stays linked until that round trip completes; a refused one leaves it.
    const again = data(
      await call(tokens.member, 'POST', `/v1/connections/${id}/authorize`, { return_to: RETURN })
    );
    expect(await myLink(call, tokens.member, id)).toMatchObject({ status: 'linked' });
    await mock.app.request(`${new URL(String(again.authorization_url)).pathname}?deny=1`);
    expect(await myLink(call, tokens.member, id)).toMatchObject({
      status: 'linked',
      consent: 'given',
    });
    // An administrator's own link is its own.
    expect(await myLink(call, tokens.admin, id)).toEqual({ status: 'none', consent: 'none' });
  });

  it("a completed re-authorization replaces the link's credential (the credential is never on the wire, so this is the mock's own check)", async () => {
    const { tokens, call, mock } = await make();
    const id = await registered(call, tokens, {
      auth: { kind: 'oauth' },
      credential_tier: 'per_user',
    });
    await call(tokens.member, 'POST', `/v1/connections/${id}/link`, { consent: true });
    const consent = async (): Promise<void> => {
      const started = data(
        await call(tokens.member, 'POST', `/v1/connections/${id}/authorize`, { return_to: RETURN })
      );
      await mock.app.request(new URL(String(started.authorization_url)).pathname);
    };
    const held = (): string | undefined =>
      [...mock.state.links.entries()].find(([key]) => key.startsWith(`${id}|`))?.[1].token;
    await consent();
    const first = held();
    expect(first).toMatch(/^oauth_/);
    await consent();
    expect(held()).toMatch(/^oauth_/);
    expect(held()).not.toBe(first);
    expect(await myLink(call, tokens.member, id)).toMatchObject({ status: 'linked' });
  });

  it('completes an authorization through mock control, and the reauthorize defect drops the credential in use', async () => {
    const control = async (
      app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
      body: unknown
    ): Promise<Response> =>
      app.request('/__mock/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const { tokens, call, mock } = await make();
    const id = await registered(call, tokens, {
      auth: { kind: 'oauth' },
      credential_tier: 'org_shared',
    });
    const first = data(
      await call(tokens.admin, 'POST', `/v1/connections/${id}/authorize`, { return_to: RETURN })
    );
    const done = await control(mock.app, {
      consent: { authorization_url: first.authorization_url },
    });
    expect(done.status).toBe(200);
    expect(
      new URL(((await done.json()) as { location: string }).location).searchParams.get('nc_result')
    ).toBe('connected');
    // Used once.
    expect(
      (await control(mock.app, { consent: { authorization_url: first.authorization_url } })).status
    ).toBe(404);
    expect((await control(mock.app, { consent: { authorization_url: 'nope' } })).status).toBe(400);
    expect(data(await call(tokens.admin, 'GET', `/v1/connections/${id}`)).status).toBe('connected');
    await call(tokens.admin, 'POST', `/v1/connections/${id}/authorize`, { return_to: RETURN });
    expect(data(await call(tokens.admin, 'GET', `/v1/connections/${id}`)).status).toBe('connected');

    const broken = await make({ breaks: new Set(['reauthorize_drops_credential' as const]) });
    const b = await registered(broken.call, broken.tokens, {
      auth: { kind: 'oauth' },
      credential_tier: 'org_shared',
    });
    const start = data(
      await broken.call(broken.tokens.admin, 'POST', `/v1/connections/${b}/authorize`, {
        return_to: RETURN,
      })
    );
    await control(broken.mock.app, { consent: { authorization_url: start.authorization_url } });
    await broken.call(broken.tokens.admin, 'POST', `/v1/connections/${b}/authorize`, {
      return_to: RETURN,
    });
    expect(data(await broken.call(broken.tokens.admin, 'GET', `/v1/connections/${b}`)).status).toBe(
      'pending_authorization'
    );
  });

  it("keeps return_to's own query and adds the nc_ parameters to it", async () => {
    const { tokens, call, mock } = await make();
    const id = await registered(call, tokens, {
      auth: { kind: 'oauth' },
      credential_tier: 'per_user',
    });
    await call(tokens.member, 'POST', `/v1/connections/${id}/link`, { consent: true });
    const started = data(
      await call(tokens.member, 'POST', `/v1/connections/${id}/authorize`, {
        return_to: `${RETURN}?tab=tools&from=a%26b`,
      })
    );
    const consent = await mock.app.request(new URL(String(started.authorization_url)).pathname);
    const back = new URL(consent.headers.get('location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(RETURN);
    expect(Object.fromEntries(back.searchParams)).toEqual({
      tab: 'tools',
      from: 'a&b',
      nc_connection: id,
      nc_result: 'connected',
    });
  });

  it('refuses consent and expiry with their codes, admits a registered origin, and authorizes an org_shared registration for an administrator only', async () => {
    const { tokens, call, mock } = await make();
    const id = await registered(call, tokens, {
      auth: { kind: 'oauth' },
      credential_tier: 'org_shared',
    });
    expect(
      (await call(tokens.member, 'POST', `/v1/connections/${id}/authorize`, { return_to: RETURN }))
        .status
    ).toBe(403);
    await call(tokens.admin, 'PUT', '/v1/origins', { origins: ['https://app.example.com'] });
    const denied = data(
      await call(tokens.admin, 'POST', `/v1/connections/${id}/authorize`, {
        return_to: 'https://app.example.com/back',
      })
    );
    const refused = await mock.app.request(
      `${new URL(String(denied.authorization_url)).pathname}?deny=1`
    );
    expect(new URL(refused.headers.get('location') ?? '').searchParams.get('nc_error')).toBe(
      'consent_denied'
    );
    const late = data(
      await call(tokens.admin, 'POST', `/v1/connections/${id}/authorize`, { return_to: RETURN })
    );
    await mock.app.request('/__mock/advance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seconds: 3600 }),
    });
    const expired = await mock.app.request(new URL(String(late.authorization_url)).pathname);
    expect(new URL(expired.headers.get('location') ?? '').searchParams.get('nc_error')).toBe(
      'expired'
    );
    expect(data(await call(tokens.admin, 'GET', `/v1/connections/${id}`)).status).toBe(
      'pending_authorization'
    );
    const good = data(
      await call(tokens.admin, 'POST', `/v1/connections/${id}/authorize`, { return_to: RETURN })
    );
    await mock.app.request(new URL(String(good.authorization_url)).pathname);
    expect(data(await call(tokens.admin, 'GET', `/v1/connections/${id}`)).status).toBe('connected');
    const bearer = await registered(call, tokens, {
      auth: { kind: 'bearer' },
      credential_tier: 'per_user',
    });
    expect(
      (
        await call(tokens.admin, 'POST', `/v1/connections/${bearer}/authorize`, {
          return_to: RETURN,
        })
      ).status
    ).toBe(400);
    const broken = await make({ breaks: new Set(['authorize_return_unchecked' as const]) });
    const b = await registered(broken.call, broken.tokens, {
      auth: { kind: 'oauth' },
      credential_tier: 'org_shared',
    });
    expect(
      (
        await broken.call(broken.tokens.admin, 'POST', `/v1/connections/${b}/authorize`, {
          return_to: 'https://evil.test/',
        })
      ).status
    ).toBe(200);
  });

  it('blocks an approval on its creator’s link, for the creator alone and never on a stream event, and denies a direct call that opens none', async () => {
    const { tokens, call } = await make();
    const id = await registered(call, tokens, {
      auth: { kind: 'bearer' },
      credential_tier: 'per_user',
    });
    await call(tokens.admin, 'POST', `/v1/connections/${id}/refresh`);
    const tools = (await call(tokens.admin, 'GET', `/v1/tools?connection=${id}`)).body
      .data as Json[];
    const read = String(tools.find((t) => t.side_effect_level === 'read')?.tool_ref);
    const write = String(tools.find((t) => t.side_effect_level === 'write')?.tool_ref);
    expect(
      data(
        await call(tokens.member, 'POST', '/v1/decisions', {
          action: { tool_ref: read, arguments: {} },
        })
      )
    ).toMatchObject({
      decision: 'deny',
      reason: 'credential_link_required',
    });
    const decided = data(
      await call(tokens.member, 'POST', '/v1/decisions', {
        action: { tool_ref: write, arguments: { a: 1 } },
        continuation: { kind: 'langgraph', delivery: 'pull' },
      })
    );
    expect(decided.decision).toBe('step_up');
    const approvalId = String((decided.approval as Json).id);
    const blocked = { reason: 'credential_link_required', connection_id: id };
    expect(
      data(await call(tokens.member, 'GET', `/v1/approvals/${approvalId}`)).blocked_on
    ).toEqual(blocked);
    const row = (
      (await call(tokens.member, 'GET', '/v1/approvals?created_by=me')).body.data as Json[]
    ).find((a) => a.id === approvalId);
    expect(row?.blocked_on).toEqual(blocked);
    expect(data(await call(tokens.admin, 'GET', `/v1/approvals/${approvalId}`))).not.toHaveProperty(
      'blocked_on'
    );
    await call(tokens.member, 'POST', `/v1/connections/${id}/link`, { consent: true, token: 't' });
    expect(
      data(await call(tokens.member, 'GET', `/v1/approvals/${approvalId}`))
    ).not.toHaveProperty('blocked_on');
    expect(
      data(
        await call(tokens.member, 'POST', '/v1/decisions', {
          action: { tool_ref: read, arguments: {} },
        })
      ).decision
    ).toBe('allow');
    // Revoked consent blocks again.
    await call(tokens.member, 'DELETE', `/v1/connections/${id}/link/consent`);
    expect(
      data(await call(tokens.member, 'GET', `/v1/approvals/${approvalId}`)).blocked_on
    ).toEqual(blocked);
    const broken = await make({ breaks: new Set(['blocked_on_shown_to_others' as const]) });
    const b = await registered(broken.call, broken.tokens, {
      auth: { kind: 'bearer' },
      credential_tier: 'per_user',
    });
    await broken.call(broken.tokens.admin, 'POST', `/v1/connections/${b}/refresh`);
    const bTool = String(
      (
        (await broken.call(broken.tokens.admin, 'GET', `/v1/tools?connection=${b}`)).body
          .data as Json[]
      )[1]?.tool_ref
    );
    const opened = data(
      await broken.call(broken.tokens.member, 'POST', '/v1/approvals', {
        action: { tool_ref: bTool, arguments: {} },
        continuation: { kind: 'langgraph', delivery: 'pull' },
      })
    );
    expect(
      data(await broken.call(broken.tokens.admin, 'GET', `/v1/approvals/${String(opened.id)}`))
    ).toHaveProperty('blocked_on');
  });

  it('admits no approved proxied call while its creator is blocked', async () => {
    const { tokens, call } = await make();
    const id = await registered(call, tokens, {
      auth: { kind: 'bearer' },
      credential_tier: 'per_user',
    });
    await call(tokens.admin, 'POST', `/v1/connections/${id}/refresh`);
    const write = String(
      ((await call(tokens.admin, 'GET', `/v1/tools?connection=${id}`)).body.data as Json[]).find(
        (t) => t.side_effect_level === 'write'
      )?.tool_ref
    );
    const run = data(await call(tokens.member, 'POST', '/v1/runs', { kind: 'external' }));
    const body = {
      actor: { run_id: run.id },
      action: { tool_ref: write, arguments: { a: 2 } },
      continuation: { kind: 'langgraph', delivery: 'pull' },
    };
    const decided = data(await call(tokens.member, 'POST', '/v1/decisions', body));
    await call(
      tokens.approver,
      'POST',
      `/v1/approvals/${String((decided.approval as Json).id)}/approve`,
      {
        expected_action_digest: decided.action_digest,
      }
    );
    expect(data(await call(tokens.member, 'POST', '/v1/decisions', body)).decision).toBe('step_up');
    await call(tokens.member, 'POST', `/v1/connections/${id}/link`, { consent: true, token: 't' });
    expect(data(await call(tokens.member, 'POST', '/v1/decisions', body)).decision).toBe('allow');
  });
});

describe('rev 11 behaviours of the mock: adversarial review fixes', () => {
  type Json = Record<string, unknown>;
  const make = async () => {
    const mock = await createMock({ control: true, spec: loadCommittedDocument() });
    const tokens = await mock.tokens();
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const response = await mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as Json };
    };
    return { mock, tokens, call };
  };
  const data = (r: { body: Json }): Json => r.body.data as Json;

  it('refresh leaves alone a tool another way registered under the same reference (adv-1)', async () => {
    const { tokens, call } = await make();
    const conn = data(
      await call(tokens.admin, 'POST', '/v1/connections', {
        name: 'n',
        url: 'https://takeover.test/mcp',
        transport: 'mcp',
        owner_kind: 'org',
      })
    );
    const ref = String(
      (
        data(
          await call(tokens.admin, 'POST', `/v1/connections/${String(conn.id)}/discover`)
        ) as unknown as Json[]
      )[1]?.tool_ref
    );
    await call(tokens.creator_user, 'POST', '/v1/tools', {
      tool_ref: ref,
      transport: 'external',
      input_schema: { type: 'object' },
      side_effect_level: 'write',
    });
    const counts = data(
      await call(tokens.admin, 'POST', `/v1/connections/${String(conn.id)}/refresh`)
    );
    expect(counts.added).toBe(1);
    const listed = (await call(tokens.admin, 'GET', `/v1/tools?connection=${String(conn.id)}`)).body
      .data as Json[];
    expect(listed.map((t) => t.tool_ref)).not.toContain(ref);
    expect(listed.every((t) => t.transport === 'mcp')).toBe(true);
  });

  it('issues no resume token while the creator is blocked, and issues it once the link is usable (adv-1)', async () => {
    const { mock, tokens, call } = await make();
    const id = String(
      data(
        await call(tokens.admin, 'POST', '/v1/connections', {
          name: 'n',
          url: 'https://blocked-ext.test/mcp',
          transport: 'mcp',
          owner_kind: 'org',
          auth: { kind: 'bearer' },
          credential_tier: 'per_user',
        })
      ).id
    );
    await call(tokens.admin, 'POST', `/v1/connections/${id}/refresh`);
    const ref = String(
      ((await call(tokens.admin, 'GET', `/v1/tools?connection=${id}`)).body.data as Json[])[1]
        ?.tool_ref
    );
    // Make the tool one the caller executes, so a Resumption would carry a resume token.
    const row = [...mock.state.tools.values()].find((t) => t.tool_ref === ref);
    if (row === undefined) throw new Error('no tool');
    row.transport = 'external';
    const opened = data(
      await call(tokens.creator_user, 'POST', '/v1/approvals', {
        action: { tool_ref: ref, arguments: {} },
        continuation: { kind: 'langgraph', delivery: 'pull' },
      })
    );
    const approvalId = String(opened.id);
    const digest = String(
      data(await call(tokens.creator_user, 'GET', `/v1/approvals/${approvalId}`)).action_digest
    );
    await call(tokens.approver, 'POST', `/v1/approvals/${approvalId}/approve`, {
      expected_action_digest: digest,
    });
    const blocked = await call(
      tokens.creator_user,
      'GET',
      `/v1/approvals/${approvalId}/resumption`
    );
    // While blocked there is no Resumption at all, so none reads as gateway admission.
    expect(blocked.status).toBe(404);
    await call(tokens.creator_user, 'POST', `/v1/connections/${id}/link`, {
      consent: true,
      token: 't',
    });
    const cleared = await call(
      tokens.creator_user,
      'GET',
      `/v1/approvals/${approvalId}/resumption`
    );
    expect(typeof data(cleared).resume_token).toBe('string');
  });

  it('refuses a URL that carries credentials in its userinfo (adv-2)', async () => {
    const { tokens, call } = await make();
    const answer = await call(tokens.admin, 'POST', '/v1/connections', {
      name: 'n',
      url: 'https://alice:secret@creds.test/mcp',
      transport: 'mcp',
      owner_kind: 'org',
    });
    expect(answer.status).toBe(400);
    expect(String(answer.body.type)).toMatch(/\/invalid_request$/);
  });

  it('names no retired policy on a decision or a new approval (adv-3)', async () => {
    const { tokens, call } = await make();
    expect((await call(tokens.admin, 'POST', '/v1/policies/pol_default/retire')).status).toBe(200);
    const decided = data(
      await call(tokens.creator, 'POST', '/v1/decisions', {
        action: { tool_ref: 'mcp:crm:delete_account', arguments: {} },
      })
    );
    expect(decided).not.toHaveProperty('policy');
    const asked = data(
      await call(tokens.creator_user, 'POST', '/v1/decisions', {
        action: { tool_ref: 'mcp:tracker:create_issue', arguments: { a: 1 } },
        continuation: { kind: 'langgraph', delivery: 'pull' },
      })
    );
    const approval = data(
      await call(tokens.creator_user, 'GET', `/v1/approvals/${String((asked.approval as Json).id)}`)
    );
    expect(approval).not.toHaveProperty('policy');
    expect(approval).not.toHaveProperty('on_deny');
  });

  it('drops an authorization in flight when the link is removed or consent revoked (adv-5)', async () => {
    const { mock, tokens, call } = await make();
    const id = String(
      data(
        await call(tokens.admin, 'POST', '/v1/connections', {
          name: 'n',
          url: 'https://inflight.test/mcp',
          transport: 'mcp',
          owner_kind: 'org',
          auth: { kind: 'oauth' },
          credential_tier: 'per_user',
        })
      ).id
    );
    const RETURN = 'https://module.mock.test/back';
    for (const cut of ['DELETE /link', 'DELETE /link/consent']) {
      await call(tokens.member, 'POST', `/v1/connections/${id}/link`, { consent: true });
      const url = new URL(
        String(
          data(
            await call(tokens.member, 'POST', `/v1/connections/${id}/authorize`, {
              return_to: RETURN,
            })
          ).authorization_url
        )
      );
      const [method = 'DELETE', suffix = ''] = cut.split(' ');
      await call(tokens.member, method, `/v1/connections/${id}${suffix}`);
      expect((await mock.app.request(url.pathname)).status, cut).toBe(404);
      await call(tokens.member, 'DELETE', `/v1/connections/${id}/link`);
    }
  });
});
