import { describe, expect, it } from 'vitest';

import { GovernanceApi, ModuleApiError, isTransient } from './governance-api.js';
import type { Answer } from './governance-api.js';

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
}

const META = { request_id: 'r1', deployment: 'hosted' };
const ok = (data: unknown, extra: Record<string, unknown> = {}): Response =>
  Response.json({ data, meta: { ...META, ...extra } });
const status = (code: number, body: unknown = {}): Response =>
  Response.json(body, { status: code });

type Reply = (request: Request) => Response | Promise<Response>;

function harness(
  reply: Reply = () => ok({}),
  options: {
    isPassThrough?: (e: unknown) => boolean;
  } = {}
) {
  const seen: Seen[] = [];
  const api = new GovernanceApi({
    baseUrl: 'https://govern.test',
    getToken: () => 'tok',
    ...options,
    fetch: async (input) => {
      const request = input as Request;
      const text = await request.clone().text();
      seen.push({
        method: request.method,
        url: new URL(request.url),
        headers: request.headers,
        body: text === '' ? undefined : (JSON.parse(text) as unknown),
      });
      return reply(request);
    },
  });
  return { api, seen };
}

const problem = (code: number, type: string, detail?: string): Response =>
  status(code, { type: `https://govern.test/problems/${type}`, title: type, status: code, detail });

describe('GovernanceApi requests', () => {
  it('sends each operation as the module API specifies, with the bearer token', async () => {
    const { api, seen } = harness();
    await api.capabilities();
    await api.createRun('key-1');
    await api.decide({ action: { tool_ref: 't', arg_digest: 'd' } });
    await api.getApproval('a1');
    await api.waitApproval('a1', 25);
    await api.getResumption('a1');
    await api.consume('a1', 'rt', 'tool:x', { q: 1 });
    await api.withdraw('a1');
    await api.appendRecord({ kind: 'k' } as never, 'key-2');
    await api.listApprovals('pending', 'c1').catch(() => undefined);

    expect(seen.map((s) => `${s.method} ${s.url.pathname}${s.url.search}`)).toEqual([
      'GET /v1/capabilities',
      'POST /v1/runs',
      'POST /v1/decisions',
      'GET /v1/approvals/a1',
      'GET /v1/approvals/a1/wait?timeout=25',
      'GET /v1/approvals/a1/resumption',
      'POST /v1/approvals/a1/consume',
      'POST /v1/approvals/a1/withdraw',
      'POST /v1/records',
      'GET /v1/approvals?state=pending&created_by=me&cursor=c1',
    ]);
    expect(seen.every((s) => s.headers.get('authorization') === 'Bearer tok')).toBe(true);
    expect(seen[1]?.headers.get('idempotency-key')).toBe('key-1');
    expect(seen[1]?.body).toEqual({ kind: 'external' });
    expect(seen[6]?.body).toEqual({
      resume_token: 'rt',
      action: { tool_ref: 'tool:x', arguments: { q: 1 } },
    });
    expect(seen[8]?.headers.get('idempotency-key')).toBe('key-2');
  });

  it('asks for the approvals of this principal only, whatever the state', async () => {
    const { api, seen } = harness(() => ok([], { next: null }));
    await api.listApprovals('pending');
    expect(seen[0]?.url.searchParams.get('created_by')).toBe('me');
    expect(seen[0]?.url.searchParams.has('cursor')).toBe(false);
  });
});

describe('GovernanceApi answers', () => {
  it('unwraps data from the envelope', async () => {
    const { api } = harness(() => ok({ id: 'a1', state: 'pending' }));
    expect(await api.getApproval('a1')).toEqual({ ok: true, data: { id: 'a1', state: 'pending' } });
  });

  it('returns a 4xx as a Problem whose code is the last segment of the type URI', async () => {
    const { api } = harness(() => problem(409, 'consume-conflict', 'already consumed'));
    expect(await api.getApproval('a1')).toEqual({
      ok: false,
      problem: { status: 409, code: 'consume-conflict', detail: 'already consumed' },
    });
  });

  it('returns a Problem without a detail member when the body has none', async () => {
    const { api } = harness(() => status(404, 'not json shaped'));
    const answer = await api.getApproval('a1');
    expect(answer).toEqual({ ok: false, problem: { status: 404, code: '' } });
  });

  it('reads a list page into rows and the next cursor', async () => {
    const { api } = harness(() => ok([{ id: 'a1' }], { next: 'c2' }));
    expect(await api.listApprovals('pending')).toEqual({
      ok: true,
      data: { rows: [{ id: 'a1' }], next: 'c2' },
    });
  });

  it('reads a page without meta.next as the last page', async () => {
    const { api } = harness(() => ok([]));
    expect(await api.listApprovals('pending')).toEqual({
      ok: true,
      data: { rows: [], next: null },
    });
  });
});

describe('unreachable', () => {
  it('a list page whose data is not an array is unreachable, never an empty page', async () => {
    const { api } = harness(() => ok({ rows: [] }, { next: null }));
    await expect(api.listApprovals('pending')).rejects.toMatchObject({
      name: 'ModuleApiError',
      code: 'unreachable',
      message: '/v1 answered an approvals page whose data is not an array',
    });
  });

  it('a list page whose meta.next is neither a string nor null is unreachable', async () => {
    const { api } = harness(() => ok([], { next: 7 }));
    await expect(api.listApprovals('pending')).rejects.toMatchObject({
      code: 'unreachable',
      message: '/v1 answered an approvals page whose meta.next is not a string or null',
    });
  });

  it('a 2xx body without a data member is unreachable', async () => {
    const { api } = harness(() => Response.json({ meta: META }));
    await expect(api.capabilities()).rejects.toMatchObject({
      code: 'unreachable',
      message: '/v1 answered 200 without a data member',
    });
  });

  it('a dropped connection is unreachable and keeps its cause', async () => {
    const cause = new TypeError('fetch failed');
    const { api } = harness(() => {
      throw cause;
    });
    const error = await api.capabilities().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModuleApiError);
    expect(error).toMatchObject({
      code: 'unreachable',
      message: '/v1 could not be reached: fetch failed',
      cause,
    });
  });

  it('the key set and the stream are unreachable on any non-ok status, 4xx included', async () => {
    const jwks = harness(() => status(404));
    await expect(jwks.api.jwks()).rejects.toMatchObject({
      code: 'unreachable',
      message: 'the key set answered 404',
    });
    const stream = harness(() => status(403));
    await expect(stream.api.stream(new AbortController().signal)).rejects.toMatchObject({
      code: 'unreachable',
      message: 'the approval stream answered 403',
    });
  });

  it('the key set must carry a keys array', async () => {
    const { api } = harness(() => Response.json({ nope: true }));
    await expect(api.jwks()).rejects.toMatchObject({ message: 'the key set answered 200' });
    const good = harness(() => Response.json({ keys: [] }));
    expect(await good.api.jwks()).toEqual({ keys: [] });
  });

  it('opens the approval stream as a readable body', async () => {
    const { api, seen } = harness(
      () => new Response('event: x\n\n', { headers: { 'content-type': 'text/event-stream' } })
    );
    const body = await api.stream(new AbortController().signal);
    expect(body).toBeInstanceOf(ReadableStream);
    expect(seen[0]?.url.search).toBe('?created_by=me');
  });

  it('forwards the caller signal to the stream request', async () => {
    let aborted: boolean | undefined;
    const { api } = harness((request) => {
      aborted = request.signal.aborted;
      return new Response('x', { headers: { 'content-type': 'text/event-stream' } });
    });
    const controller = new AbortController();
    controller.abort();
    await api.stream(controller.signal).catch(() => undefined);
    expect(aborted).toBe(true);
  });

  it('forwards the caller signal to the approval wait', async () => {
    let aborted: boolean | undefined;
    const { api } = harness((request) => {
      aborted = request.signal.aborted;
      return ok({});
    });
    const controller = new AbortController();
    controller.abort();
    await api.waitApproval('a1', 5, controller.signal).catch(() => undefined);
    expect(aborted).toBe(true);
  });

  it('a 200 stream answer with no body is unreachable', async () => {
    const { api } = harness(() => new Response(null, { status: 200 }));
    await expect(api.stream(new AbortController().signal)).rejects.toMatchObject({
      code: 'unreachable',
      message: 'the approval stream answered 200',
    });
  });

  it('a network failure opening the key set or the stream is unreachable', async () => {
    const fail = () => {
      throw new TypeError('down');
    };
    await expect(harness(fail).api.jwks()).rejects.toMatchObject({
      code: 'unreachable',
      message: 'the key set could not be read: down',
    });
    await expect(harness(fail).api.stream(new AbortController().signal)).rejects.toMatchObject({
      code: 'unreachable',
      message: 'the approval stream could not be opened: down',
    });
  });
});

describe('transient classification, one case per status', () => {
  // 5xx never comes back as an answer: the API throws unreachable, and isTransient reads that.
  it.each([500, 502, 503])('a %i throws unreachable, which is transient', async (code) => {
    const { api } = harness(() => status(code));
    const error = await api.capabilities().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModuleApiError);
    expect((error as Error).message).toBe(`/v1 answered ${String(code)}`);
    expect(isTransient(error)).toBe(true);
  });

  it.each([408, 429])('a %i comes back as a Problem and is transient', async (code) => {
    const { api } = harness(() => problem(code, 'slow-down'));
    const answer = await api.capabilities();
    expect(answer).toMatchObject({ ok: false, problem: { status: code } });
    expect(isTransient(answer)).toBe(true);
  });

  it.each([400, 403, 409])('a %i is not transient', async (code) => {
    const { api } = harness(() => problem(code, 'refused'));
    const answer = await api.capabilities();
    expect(answer).toMatchObject({ ok: false, problem: { status: code } });
    expect(isTransient(answer)).toBe(false);
  });

  it('a dropped connection is transient', async () => {
    const { api } = harness(() => {
      throw new TypeError('fetch failed');
    });
    expect(isTransient(await api.capabilities().catch((e: unknown) => e))).toBe(true);
  });

  it('a success is not transient', async () => {
    const { api } = harness();
    expect(isTransient(await api.capabilities())).toBe(false);
  });

  it('reads a bare Problem and rejects things that are not answers or API errors', () => {
    expect(isTransient({ status: 429, code: 'x' })).toBe(true);
    expect(isTransient({ status: 404, code: 'x' })).toBe(false);
    expect(isTransient({ status: 500, code: 'x' })).toBe(true);
    expect(isTransient({ status: 499, code: 'x' })).toBe(false);
    expect(isTransient({ ok: false, problem: { status: 599, code: 'x' } })).toBe(true);
    expect(isTransient({ ok: false, problem: { status: 'x' } })).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
    expect(isTransient(Object.assign(new Error('boom'), { status: 503 }))).toBe(false);
    expect(isTransient(new TypeError('fetch failed'))).toBe(false);
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
    expect(isTransient('429')).toBe(false);
    expect(isTransient([])).toBe(false);
    const answer: Answer<number> = { ok: true, data: 1 };
    expect(isTransient(answer)).toBe(false);
  });
});

describe('isPassThrough', () => {
  class Principal extends Error {}
  const failing = (error: Error) => ({
    seen: [] as string[],
    api: new GovernanceApi({
      baseUrl: 'https://govern.test',
      getToken: () => {
        throw error;
      },
      fetch: () => Promise.resolve(ok({})),
      isPassThrough: (e) => e instanceof Principal,
    }),
  });

  it('re-throws an error the predicate accepts, unwrapped, from every operation that can fail on the token', async () => {
    const error = new Principal('wrong principal');
    const { api } = failing(error);
    await expect(api.capabilities()).rejects.toBe(error);
    await expect(api.jwks()).rejects.toBe(error);
    await expect(api.stream(new AbortController().signal)).rejects.toBe(error);
  });

  it('wraps any other error from getToken as unreachable', async () => {
    const { api } = failing(new Error('token endpoint down'));
    const error = await api.capabilities().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModuleApiError);
    expect(error).toMatchObject({
      code: 'unreachable',
      message: '/v1 could not be reached: token endpoint down',
    });
    await expect(api.jwks()).rejects.toBeInstanceOf(ModuleApiError);
    await expect(api.stream(new AbortController().signal)).rejects.toBeInstanceOf(ModuleApiError);
  });

  it('wraps every error when no predicate is given', async () => {
    const api = new GovernanceApi({
      baseUrl: 'https://govern.test',
      getToken: () => {
        throw new Principal('x');
      },
      fetch: () => Promise.resolve(ok({})),
    });
    await expect(api.capabilities()).rejects.toBeInstanceOf(ModuleApiError);
  });

  it('uses a client it is given instead of building one', async () => {
    const calls: string[] = [];
    const client = {
      GET: (path: string) => {
        calls.push(path);
        return Promise.resolve({ data: { data: { ok: 1 } }, response: new Response() });
      },
    };
    const api = new GovernanceApi({
      baseUrl: 'https://x.test',
      getToken: () => 't',
      client: client as never,
    });
    expect(await api.capabilities()).toEqual({ ok: true, data: { ok: 1 } });
    expect(calls).toEqual(['/v1/capabilities']);
    expect(api.baseUrl).toBe('https://x.test');
  });
});
