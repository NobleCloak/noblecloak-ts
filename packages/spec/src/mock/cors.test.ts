import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMockCli, parseMockArgs } from '../cli/nc-mock-main.js';
import { loadCommittedDocument } from '../spec/testing.js';
import { createMock } from './app.js';
import type { Mock } from './app.js';
import { parseAllowedOrigins } from './cors.js';
import { startMock } from './serve.js';
import type { RunningMock } from './serve.js';

// The document comes from the repository's source, so this suite does not need a built `dist/`.
const spec = loadCommittedDocument();
const LISTED = 'http://localhost:3000';
const OTHER = 'http://localhost:3001';

const header = (response: Response, name: string): string | null => response.headers.get(name);
const corsHeaders = (response: Response): string[] =>
  [...response.headers.keys()].filter((name) => name.startsWith('access-control-'));

describe('parseAllowedOrigins', () => {
  it('accepts exact http and https origins and drops duplicates', () => {
    expect(
      parseAllowedOrigins([LISTED, 'https://app.example.test', 'http://127.0.0.1:8080', LISTED])
    ).toEqual([LISTED, 'https://app.example.test', 'http://127.0.0.1:8080']);
    expect(parseAllowedOrigins([])).toEqual([]);
  });

  it.each([
    ['*'],
    ['http://*.example.test'],
    ['https://*'],
    ['http://localhost:3000/'],
    ['http://localhost:3000/app'],
    ['http://localhost:3000?x=1'],
    ['http://localhost:3000#x'],
    ['localhost:3000'],
    ['localhost'],
    ['ftp://example.test'],
    ['null'],
    [''],
    ['http://LOCALHOST:3000'],
    ['http://localhost:80'],
  ])('refuses %j', (value) => {
    expect(() => parseAllowedOrigins([value])).toThrow(/origin/);
  });

  it('names the wildcard as the reason for a wildcard', () => {
    expect(() => parseAllowedOrigins(['*'])).toThrow(/wildcard/);
  });
});

describe('the mock with no allowed origin', () => {
  let mock: Mock;
  beforeAll(async () => {
    mock = await createMock({ control: true, spec });
  });

  it('adds no CORS header for an origin nothing admits, and only Vary: Origin (the mock’s module origin is always admitted)', async () => {
    const response = await mock.app.request('/v1/capabilities', { headers: { Origin: LISTED } });
    expect(corsHeaders(response)).toEqual([]);
    expect(header(response, 'vary')).toBe('Origin');
  });

  it('answers a preflight as it always did: 404, with no CORS header', async () => {
    const response = await mock.app.request('/v1/approvals', {
      method: 'OPTIONS',
      headers: {
        Origin: LISTED,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(response.status).toBe(404);
    expect(corsHeaders(response)).toEqual([]);
  });
});

describe('the mock with an allowed origin', () => {
  let mock: Mock;
  let tokens: Awaited<ReturnType<Mock['tokens']>>;
  beforeAll(async () => {
    mock = await createMock({ control: true, allowedOrigins: [LISTED], spec });
    tokens = await mock.tokens();
  });

  const preflight = (path: string, origin: string): Promise<Response> =>
    Promise.resolve(
      mock.app.request(path, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      })
    );

  it('answers a preflight for a listed origin with 204 and the façade headers, before authentication', async () => {
    const response = await preflight('/v1/approvals', LISTED);
    expect(response.status).toBe(204);
    expect(header(response, 'access-control-allow-origin')).toBe(LISTED);
    expect(header(response, 'access-control-allow-methods')).toBe(
      'GET,POST,DELETE,PUT,PATCH,OPTIONS'
    );
    expect(header(response, 'access-control-allow-headers')).toBe(
      'Content-Type,Authorization,Idempotency-Key,X-Request-Id,DPoP'
    );
    expect(header(response, 'access-control-max-age')).toBe('600');
    expect(header(response, 'access-control-allow-credentials')).toBeNull();
    expect(header(response, 'vary')).toMatch(/^Origin(, Access-Control-Request-Headers)?$/);
  });

  it('answers a preflight on /__mock/* too', async () => {
    const response = await preflight('/__mock/tokens', LISTED);
    expect(response.status).toBe(204);
    expect(header(response, 'access-control-allow-origin')).toBe(LISTED);
  });

  it('adds the allow-origin and the exposed header to a listed origin, on success and on a problem', async () => {
    const ok = await mock.app.request('/__mock/tokens', { headers: { Origin: LISTED } });
    expect(ok.status).toBe(200);
    expect(header(ok, 'access-control-allow-origin')).toBe(LISTED);
    expect(header(ok, 'access-control-expose-headers')).toBe('X-Request-Id');
    expect(header(ok, 'access-control-allow-credentials')).toBeNull();
    expect(header(ok, 'vary')).toBe('Origin');

    const refused = await mock.app.request('/v1/approvals', { headers: { Origin: LISTED } });
    expect(refused.status).toBe(401);
    expect(header(refused, 'access-control-allow-origin')).toBe(LISTED);
    expect(header(refused, 'access-control-expose-headers')).toBe('X-Request-Id');
    expect(header(refused, 'vary')).toBe('Origin');

    const authorised = await mock.app.request('/v1/approvals', {
      headers: { Origin: LISTED, Authorization: `Bearer ${tokens.approver}` },
    });
    expect(authorised.status).toBe(200);
    expect(header(authorised, 'access-control-allow-origin')).toBe(LISTED);
  });

  it('gives an unlisted origin no CORS header, but still Vary: Origin', async () => {
    const response = await mock.app.request('/__mock/tokens', { headers: { Origin: OTHER } });
    expect(response.status).toBe(200);
    expect(corsHeaders(response)).toEqual([]);
    expect(header(response, 'vary')).toContain('Origin');
  });

  it('gives an unlisted origin no preflight answer', async () => {
    const response = await preflight('/v1/approvals', OTHER);
    expect(response.status).toBe(404);
    expect(corsHeaders(response)).toEqual([]);
    expect(header(response, 'vary')).toBe('Origin');
  });

  it('gives a request with no Origin no CORS header, but still Vary: Origin', async () => {
    const response = await mock.app.request('/__mock/tokens');
    expect(corsHeaders(response)).toEqual([]);
    expect(header(response, 'vary')).toContain('Origin');
  });

  it('answers the event stream, whose handler builds its own Response, with the origin headers', async () => {
    const response = await mock.app.request('/v1/approvals/stream', {
      headers: { Origin: LISTED, Authorization: `Bearer ${tokens.approver}` },
    });
    try {
      expect(response.status).toBe(200);
      expect(header(response, 'content-type')).toBe('text/event-stream');
      expect(header(response, 'access-control-allow-origin')).toBe(LISTED);
      expect(header(response, 'access-control-expose-headers')).toBe('X-Request-Id');
      expect(header(response, 'vary')).toBe('Origin');
    } finally {
      await response.body?.cancel();
    }
  });

  it('answers an Idempotency-Key replay, also a handler-built Response, with the origin headers', async () => {
    const send = (): Promise<Response> =>
      Promise.resolve(
        mock.app.request('/v1/approvals', {
          method: 'POST',
          headers: {
            Origin: LISTED,
            Authorization: `Bearer ${tokens.creator}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'cors-replay-1',
          },
          body: JSON.stringify({
            action: { tool_ref: 'mcp:tracker:create_issue', arguments: { cors: 1 } },
            continuation: { kind: 'langgraph', delivery: 'pull' },
          }),
        })
      );
    const first = await send();
    expect(first.status, await first.clone().text()).toBeLessThan(300);
    expect(header(first, 'idempotent-replayed')).toBeNull();
    const replay = await send();
    expect(header(replay, 'idempotent-replayed')).toBe('true');
    expect(header(replay, 'access-control-allow-origin')).toBe(LISTED);
    expect(header(replay, 'access-control-expose-headers')).toBe('X-Request-Id');
    expect(header(replay, 'vary')).toBe('Origin');
  });

  it('never answers with a wildcard or a reflected origin', async () => {
    for (const origin of [LISTED, OTHER, 'null', 'https://evil.test']) {
      const response = await mock.app.request('/__mock/tokens', { headers: { Origin: origin } });
      const allowed = header(response, 'access-control-allow-origin');
      expect(allowed === null || allowed === LISTED).toBe(true);
    }
  });
});

describe('the mock with several allowed origins', () => {
  it('answers each listed origin with itself', async () => {
    const mock = await createMock({ control: true, allowedOrigins: [LISTED, OTHER], spec });
    for (const origin of [LISTED, OTHER]) {
      const response = await mock.app.request('/__mock/tokens', { headers: { Origin: origin } });
      expect(header(response, 'access-control-allow-origin')).toBe(origin);
    }
  });
});

describe('createMock', () => {
  it('refuses a wildcard origin', async () => {
    await expect(createMock({ allowedOrigins: ['*'], spec })).rejects.toThrow(/wildcard/);
  });
});

describe('over HTTP', () => {
  let running: RunningMock;
  beforeAll(async () => {
    running = await startMock({ control: true, allowedOrigins: [LISTED], spec });
  });
  afterAll(async () => {
    await running.stop();
  });

  it('answers a real preflight from the listed origin', async () => {
    const response = await fetch(`${running.baseUrl}/v1/approvals`, {
      method: 'OPTIONS',
      headers: {
        Origin: LISTED,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(response.status).toBe(204);
    expect(header(response, 'access-control-allow-origin')).toBe(LISTED);
  });
});

describe('nc-mock --allow-origin', () => {
  it('is repeatable and defaults to none', () => {
    expect(parseMockArgs([]).allowedOrigins).toEqual([]);
    expect(
      parseMockArgs(['--allow-origin', LISTED, '--allow-origin', 'https://app.example.test'])
        .allowedOrigins
    ).toEqual([LISTED, 'https://app.example.test']);
  });

  it('exits 2 for a wildcard or a pattern, naming the flag', async () => {
    for (const value of ['*', 'http://*.example.test', 'http://localhost:3000/']) {
      const err: string[] = [];
      const result = await startMockCli(['--allow-origin', value], {
        out: () => undefined,
        err: (line) => err.push(line),
      });
      expect(result).toEqual({ exit: 2 });
      expect(err.join()).toMatch(/^nc-mock: --allow-origin: /);
    }
  });

  it('starts a mock that answers the listed origin', async () => {
    const result = await startMockCli(
      ['--port', '0', '--allow-origin', LISTED],
      { out: () => undefined, err: () => undefined },
      spec
    );
    expect('mock' in result).toBe(true);
    if (!('mock' in result)) return;
    try {
      const response = await fetch(`${result.mock.baseUrl}/__mock/tokens`, {
        headers: { Origin: LISTED },
      });
      expect(header(response, 'access-control-allow-origin')).toBe(LISTED);
    } finally {
      await result.mock.stop();
    }
  });
});
