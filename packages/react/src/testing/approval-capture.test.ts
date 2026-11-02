import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../../tools/capture-hosted-fixtures.js';
import { captureFixture, parseSse, scrub } from './approval-capture.js';
import { parseFixture, replayFetch, stepOf } from './approval-fixture.js';
import { startHarness } from './approvals-harness.js';
import type { Harness } from './approvals-harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

const TOOL = 'ext:local:send_email';
const common = () => ({
  baseUrl: h.baseUrl,
  creatorToken: () => h.tokens.creator,
  toolRef: TOOL,
  agentId: 'agent_capture',
  streamWaitMs: 150,
  script: 'tools/capture-hosted-fixtures.ts',
});

/** A fetch that answers `/v1/capabilities` with `body` and passes everything else through. */
const tainting = (body: unknown): typeof fetch => {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(new Request(input).url).pathname !== '/v1/capabilities') return response;
    return new Response(JSON.stringify(body), { status: 200 });
  };
};

describe('parseSse', () => {
  it('reads events, skips comments and frames without data, and returns the unfinished rest', () => {
    const text =
      ': connected\n\nevent: approval.updated\ndata: {"id":"a"}\n\nevent: ping\n\nevent: x\ndata: not json\n\ndata: {"id":"b"}\n\nevent: half\ndata: {"id"';
    const { complete, rest, skipped } = parseSse(text);
    expect(skipped).toBe(1);
    expect(complete).toEqual([
      { event: 'approval.updated', data: { id: 'a' } },
      { event: 'message', data: { id: 'b' } },
    ]);
    expect(rest).toBe('event: half\ndata: {"id"');
  });
});

describe('scrub', () => {
  const raw = {
    data: {
      id: 'uuid-approval-1',
      scope_id: 'scope-abc-123',
      outcome_record_id: 'uuid-record-9',
      action_digest: 'sha256:abcdef',
      requester: { id: 'user-777', display_name: 'Ada Lovelace', email: 'ada@example.test' },
      waiting_on: { principals: [{ id: 'user-778', display_name: 'Grace' }], count: 2 },
      agent: { id: 'agent-1', name: 'Planner', parent: null },
      arguments: { capture: 'nonce-1' },
      link: 'https://x.test/v1/approvals/uuid-approval-1?x=1',
      auth: 'Bearer secret-token-value',
    },
  };
  const run = () =>
    scrub(
      raw,
      ['secret-token-value'],
      [
        ['apr', 'uuid-approval-1'],
        ['rec', 'uuid-record-9'],
      ]
    );

  it('turns ids, names, the digest, the nonce and tokens into placeholders', () => {
    const text = JSON.stringify(run());
    for (const leaked of [
      'uuid-approval-1',
      'uuid-record-9',
      'scope-abc-123',
      'user-777',
      'user-778',
      'Ada Lovelace',
      'Grace',
      'Planner',
      'ada@example.test',
      'nonce-1',
      'secret-token-value',
      'agent-1',
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(run()).toMatchObject({
      data: {
        id: 'apr_FIXTURE_1',
        outcome_record_id: 'rec_FIXTURE_1',
        scope_id: 'scope_FIXTURE_1',
        requester: { id: 'principal_FIXTURE_1', email: '<email>' },
        arguments: { capture: '<nonce>' },
        auth: '<token>',
        link: 'https://x.test/v1/approvals/apr_FIXTURE_1?x=1',
      },
    });
  });

  it('is deterministic, and the same id gets the same placeholder everywhere', () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
    const again = scrub({ a: { id: 'u1' }, b: { id: 'u1' }, c: { id: 'u2' } }, []) as {
      a: { id: string };
      b: { id: string };
      c: { id: string };
    };
    expect(again.a.id).toBe(again.b.id);
    expect(again.c.id).not.toBe(again.a.id);
  });

  it('replaces the signing key ids of the capabilities (kids, kid), the same one with the same placeholder', () => {
    const out = scrub(
      { data: { kids: ['Rkey-one-abcdef', 'Rkey-two-abcdef'], jwk: { kid: 'Rkey-one-abcdef' } } },
      []
    );
    expect(out).toEqual({
      data: { kids: ['kid_FIXTURE_1', 'kid_FIXTURE_2'], jwk: { kid: 'kid_FIXTURE_1' } },
    });
  });

  it('replaces a JWT-looking value wherever it is', () => {
    const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
    expect(scrub({ any: { thing: [jwt] } }, [])).toEqual({ any: { thing: ['<token>'] } });
  });
});

describe('captureFixture against the mock', () => {
  it('records the pending and consumed steps, scrubbed, and the recording replays', async () => {
    const { fixture, warnings } = await captureFixture({
      ...common(),
      approverToken: h.tokens.approver,
      source: 'mock',
      now: () => new Date('2026-10-18T12:00:00.000Z'),
    });
    expect(parseFixture(JSON.parse(JSON.stringify(fixture)))).toBeDefined();
    expect(fixture.header).toMatchObject({
      capturedAt: '2026-10-18T12:00:00.000Z',
      source: 'mock',
      origin: 'http://127.0.0.1:<port>',
      serviceVersion: 'unknown',
      provisional: true,
    });
    expect(fixture.steps.map((s) => s.name)).toEqual(['pending', 'consumed']);
    expect(warnings.every((w) => typeof w === 'string')).toBe(true);
    const text = JSON.stringify(fixture);
    expect(text).not.toContain(h.tokens.creator);
    expect(text).not.toContain(h.tokens.approver);
    expect(text).not.toMatch(/eyJ[\w-]+\.[\w-]+\./);
    expect(fixture.ids).toEqual({ approval: 'apr_FIXTURE_1', record: 'rec_FIXTURE_1' });

    const consumed = stepOf(fixture, 'consumed');
    const replay = replayFetch(fixture, consumed);
    const response = await replay.fetch(`https://r.test/v1/records/${fixture.ids.record ?? ''}`);
    expect(response.status).toBe(200);
    expect((await replay.fetch('https://r.test/v1/approvals/other')).status).toBe(404);
    expect(replay.unexpected).toEqual(['GET /v1/approvals/other']);
  });

  it('records the pending step alone when asked to', async () => {
    const { fixture } = await captureFixture({
      ...common(),
      pendingOnly: true,
      source: 'hosted',
      serviceVersion: 'img-1.2.3',
    });
    expect(fixture.steps.map((s) => s.name)).toEqual(['pending']);
    expect(fixture.header).toMatchObject({ source: 'hosted', serviceVersion: 'img-1.2.3' });
    expect(fixture.header.provisional).toBeUndefined();
    expect(fixture.header.origin).toBe('<origin>');
    expect(JSON.stringify(fixture)).not.toContain(new URL(h.baseUrl).origin);
  });

  it('refuses, before it opens anything, a capture with no approver token that did not ask for pending only', async () => {
    const seen: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      seen.push(new Request(input).url);
      return fetch(input, init);
    };
    await expect(captureFixture({ ...common(), source: 'mock', fetch: spy })).rejects.toThrow(
      /no approver token/
    );
    expect(seen).toEqual([]);
  });

  it('sends the run and the agent as the decision’s actor, and nothing at the top level', async () => {
    let body: Record<string, unknown> | undefined;
    const spy: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/v1/decisions') {
        body = (await request.clone().json()) as Record<string, unknown>;
      }
      return fetch(request);
    };
    // The mock refuses a run it does not know; the body that was sent is what is under test.
    await captureFixture({
      ...common(),
      pendingOnly: true,
      source: 'mock',
      runId: 'run_x',
      agentId: 'agent_x',
      fetch: spy,
    }).catch(() => undefined);
    expect(body?.actor).toEqual({ run_id: 'run_x', agent_id: 'agent_x' });
    expect(body).not.toHaveProperty('run_id');
    expect(body).not.toHaveProperty('agent_id');
  });

  it('creates the external run the decision names when it is given none, and states agent and run on the approval', async () => {
    const seen: string[] = [];
    let actor: unknown;
    const spy: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      seen.push(`${request.method} ${path}`);
      if (path === '/v1/decisions') {
        actor = ((await request.clone().json()) as { actor?: unknown }).actor;
      }
      return fetch(request);
    };
    const { fixture } = await captureFixture({
      ...common(),
      pendingOnly: true,
      source: 'mock',
      fetch: spy,
    });
    expect(seen.indexOf('POST /v1/runs')).toBeGreaterThan(-1);
    expect(seen.indexOf('POST /v1/runs')).toBeLessThan(seen.indexOf('POST /v1/decisions'));
    expect(actor).toMatchObject({ agent_id: 'agent_capture' });
    expect((actor as { run_id: string }).run_id).toMatch(/^run_/);
    const row = (stepOf(fixture, 'pending').detail.body as { data: Record<string, unknown> }).data;
    expect(typeof (row.agent as { id: unknown }).id).toBe('string');
    expect(row.run).toMatchObject({ kind: 'external' });
  });

  it('refuses, before it opens anything, a capture with no agent id', async () => {
    const seen: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      seen.push(new Request(input).url);
      return fetch(input, init);
    };
    await expect(
      captureFixture({ ...common(), agentId: '', pendingOnly: true, source: 'mock', fetch: spy })
    ).rejects.toThrow(/no agent id/);
    expect(seen).toEqual([]);
  });

  it('writes the captured origin in a body as a placeholder', async () => {
    const { fixture } = await captureFixture({
      ...common(),
      approverToken: h.tokens.approver,
      source: 'hosted',
    });
    const origin = new URL(h.baseUrl).origin;
    const text = JSON.stringify({ c: fixture.capabilities, s: fixture.steps });
    expect(text).not.toContain(origin);
    expect(text).not.toContain(new URL(h.baseUrl).port + '/');
    expect(JSON.stringify(fixture.capabilities)).toContain('<origin>/');
  });

  it('refuses to write a fixture that carries an account id, the repo policy refuses it', async () => {
    const tainted = tainting({ data: { owner: ['1234', '56789012'].join('') } });
    await expect(
      captureFixture({ ...common(), pendingOnly: true, source: 'hosted', fetch: tainted })
    ).rejects.toThrow(/repo policy/);
  });

  // The helper names no host. A caller passes the hosts its deployment keeps out of a tracked file.
  it('refuses a host the caller names in internalHosts, and writes the same body without the option', async () => {
    const tainted = tainting({ data: { link: 'https://approvals.acme-internal.example/x' } });
    const options = { ...common(), pendingOnly: true, source: 'hosted' as const, fetch: tainted };
    await expect(
      captureFixture({ ...options, internalHosts: [/\bacme-internal\.example\b/i] })
    ).rejects.toThrow(/a host under the internal domain/);
    await expect(captureFixture(options)).resolves.toBeDefined();
  });

  it('names the approval it left open when a later request fails', async () => {
    const failing: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/approve')) {
        return new Response('{}', { status: 500 });
      }
      return fetch(request);
    };
    await expect(
      captureFixture({
        ...common(),
        approverToken: h.tokens.approver,
        source: 'mock',
        fetch: failing,
      })
    ).rejects.toThrow(/answered 500 \(approval \S+ was left open on the service\)/);
  });

  it('warns, with the reason, when the stream fails', async () => {
    const broken: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== '/v1/approvals/stream') return fetch(request);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('connection reset'));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const { warnings } = await captureFixture({
      ...common(),
      pendingOnly: true,
      source: 'mock',
      fetch: broken,
    });
    expect(warnings).toContain('the stream failed: connection reset');
  });

  it('refuses to write a fixture that still holds a token, even one the scrub cannot see (a key)', async () => {
    const leaky: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(new Request(input).url).pathname !== '/v1/capabilities') return response;
      return new Response(JSON.stringify({ data: { [h.tokens.creator]: 1 } }), { status: 200 });
    };
    await expect(
      captureFixture({ ...common(), pendingOnly: true, source: 'mock', fetch: leaky })
    ).rejects.toThrow(/token survived/);
  });

  it('names the failing request and not the body when the service refuses', async () => {
    await expect(
      captureFixture({
        ...common(),
        pendingOnly: true,
        source: 'mock',
        creatorToken: () => h.tokens.forged,
      })
    ).rejects.toThrow(/GET \/v1\/capabilities answered 401/);
  });

  it('says so when the tool needs no approval', async () => {
    await expect(
      captureFixture({
        ...common(),
        pendingOnly: true,
        source: 'mock',
        toolRef: 'mcp:tracker:search',
      })
    ).rejects.toThrow(/opened no approval|answered/);
  });
});

describe('the command', () => {
  const io = (env: Record<string, string>) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      env,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
      stdout: (line: string) => out.push(line),
      stderr: (text: string) => err.push(text),
      out,
      err,
    };
  };
  const outFile = async () => join(await mkdtemp(join(tmpdir(), 'capture-')), 'f.json');

  it('writes a provisional fixture against the mock with --mock-tokens', async () => {
    const file = await outFile();
    const sink = io({});
    const code = await main(
      [
        '--base-url',
        h.baseUrl,
        '--mock-tokens',
        '--tool-ref',
        TOOL,
        '--agent-id',
        'agent_capture',
        '--out',
        file,
        '--stream-wait-ms',
        '100',
      ],
      sink
    );
    expect(code).toBe(0);
    const written = parseFixture(JSON.parse(await readFile(file, 'utf8')) as unknown);
    expect(written.header).toMatchObject({ source: 'mock', provisional: true });
    expect(JSON.parse(sink.out.join('')) as unknown).toMatchObject({ provisional: true });
    expect(sink.err.join('')).not.toMatch(/no --internal-host given/);
  });

  it('reads the base URL and the creator token from the environment, and records the version flag', async () => {
    const file = await outFile();
    const sink = io({ NC_BASE_URL: h.baseUrl, NC_TOKEN: h.tokens.creator });
    const code = await main(
      [
        '--tool-ref',
        TOOL,
        '--agent-id',
        'agent_capture',
        '--out',
        file,
        '--service-version',
        'coo-9.9',
        '--pending-only',
        '--stream-wait-ms',
        '100',
      ],
      sink
    );
    expect(code).toBe(0);
    const written = parseFixture(JSON.parse(await readFile(file, 'utf8')) as unknown);
    expect(written.header).toMatchObject({ source: 'hosted', serviceVersion: 'coo-9.9' });
    expect(written.header.provisional).toBeUndefined();
    expect(written.steps.map((s) => s.name)).toEqual(['pending']);
  });

  it('takes the approver from NC_APPROVER_TOKEN', async () => {
    const file = await outFile();
    const sink = io({
      NC_BASE_URL: h.baseUrl,
      NC_TOKEN: h.tokens.creator,
      NC_APPROVER_TOKEN: h.tokens.approver,
    });
    expect(
      await main(
        [
          '--tool-ref',
          TOOL,
          '--agent-id',
          'agent_capture',
          '--out',
          file,
          '--stream-wait-ms',
          '100',
        ],
        sink
      )
    ).toBe(0);
    expect(
      parseFixture(JSON.parse(await readFile(file, 'utf8')) as unknown).steps.map((s) => s.name)
    ).toEqual(['pending', 'consumed']);
  });

  it.each([
    ['no tool', ['--base-url', 'http://x.test'], {}, /--tool-ref/],
    ['no base URL', ['--tool-ref', TOOL], {}, /base URL/],
    ['a base URL that is not absolute', ['--tool-ref', TOOL, '--base-url', 'nope'], {}, /absolute/],
    ['an unknown flag', ['--tool-ref', TOOL, '--bogus'], {}, /bogus/],
    [
      'a bad wait',
      [
        '--tool-ref',
        TOOL,
        '--agent-id',
        'a',
        '--base-url',
        'http://x.test',
        '--stream-wait-ms',
        'x',
      ],
      {},
      /non-negative/,
    ],
    [
      'no credential',
      ['--tool-ref', TOOL, '--agent-id', 'a', '--base-url', 'http://x.test'],
      {},
      /NOBLECLOAK_SP_CREDENTIALS/,
    ],
    ['no agent', ['--tool-ref', TOOL, '--base-url', 'http://x.test'], {}, /--agent-id is required/],
  ])('exits 1 for %s', async (_name, argv, env, message) => {
    const sink = io(env);
    expect(await main(argv, sink)).toBe(1);
    expect(sink.err.join('')).toMatch(message);
  });

  it('refuses a capture that names an --internal-host, and writes nothing', async () => {
    const file = await outFile();
    const sink = {
      ...io({ NC_BASE_URL: h.baseUrl, NC_TOKEN: h.tokens.creator }),
      fetch: tainting({ data: { link: 'https://approvals.ACME-internal.example/x' } }),
    };
    const argv = ['--tool-ref', TOOL, '--agent-id', 'a', '--pending-only', '--out', file];
    const wait = ['--stream-wait-ms', '100'];
    expect(
      await main(
        [
          ...argv,
          ...wait,
          '--internal-host',
          'other\\.example',
          '--internal-host',
          'acme-internal\\.example',
        ],
        sink
      )
    ).toBe(1);
    expect(sink.err.join('')).toMatch(/a host under the internal domain/);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
    expect(await main([...argv, ...wait], sink)).toBe(0);
  });

  // Kills: dropping the notice, or printing it for a mock capture or one that did pass a pattern.
  it('warns when a hosted capture names no --internal-host, and only then', async () => {
    const file = await outFile();
    const argv = ['--tool-ref', TOOL, '--agent-id', 'a', '--pending-only', '--out', file];
    const wait = ['--stream-wait-ms', '100'];
    const notice = /no --internal-host given/;
    const bare = io({ NC_BASE_URL: h.baseUrl, NC_TOKEN: h.tokens.creator });
    expect(await main([...argv, ...wait], bare)).toBe(0);
    expect(bare.err.join('')).toMatch(notice);
    const named = io({ NC_BASE_URL: h.baseUrl, NC_TOKEN: h.tokens.creator });
    expect(await main([...argv, ...wait, '--internal-host', 'nowhere\\.example'], named)).toBe(0);
    expect(named.err.join('')).not.toMatch(notice);
  });

  it('exits 1 for an --internal-host that is not a regular expression', async () => {
    const sink = io({ NC_BASE_URL: h.baseUrl, NC_TOKEN: h.tokens.creator });
    expect(await main(['--tool-ref', TOOL, '--agent-id', 'a', '--internal-host', '('], sink)).toBe(
      1
    );
    expect(sink.err.join('')).toMatch(/--internal-host is a regular expression/);
  });

  it('reports a service that refuses, and writes nothing', async () => {
    const file = await outFile();
    const sink = io({ NC_BASE_URL: h.baseUrl, NC_TOKEN: h.tokens.forged });
    expect(
      await main(['--tool-ref', TOOL, '--agent-id', 'a', '--pending-only', '--out', file], sink)
    ).toBe(1);
    expect(sink.err.join('')).toMatch(/401/);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });
});

describe('parseFixture', () => {
  it.each([
    ['not an object', 5, /\$ must be an object/],
    ['no header', {}, /\$\.header/],
    ['another format', { header: { format: 2 } }, /format/],
    ['an unknown source', { header: { format: 1, source: 'cloud' } }, /source/],
  ])('rejects %s', (_name, value, message) => {
    expect(() => parseFixture(value)).toThrow(message);
  });

  it('rejects a provisional header with no note, and a step with a bad name', () => {
    const good = {
      header: {
        format: 1,
        capturedAt: 'x',
        source: 'mock',
        origin: 'o',
        serviceVersion: 'unknown',
        script: 's',
      },
      ids: { approval: 'a' },
      capabilities: { status: 200, body: {} },
      steps: [
        {
          name: 'pending',
          list: { status: 200, body: {} },
          detail: { status: 200, body: {} },
          stream: [],
        },
      ],
    };
    expect(parseFixture(good)).toBeDefined();
    expect(() => parseFixture({ ...good, header: { ...good.header, provisional: true } })).toThrow(
      /note/
    );
    expect(() => parseFixture({ ...good, steps: [{ ...good.steps[0], name: 'done' }] })).toThrow(
      /pending or consumed/
    );
    expect(() => parseFixture({ ...good, steps: [] })).toThrow(/non-empty array/);
    expect(() =>
      parseFixture({ ...good, steps: [{ ...good.steps[0], stream: [{ event: 1 }] }] })
    ).toThrow(/stream/);
    expect(() => parseFixture({ ...good, capabilities: { status: 'x' } })).toThrow(/status/);
    expect(() => stepOf(parseFixture(good), 'consumed')).toThrow(/no consumed step/);
  });
});

describe('captureFixture keeps only the new approval in the lists', () => {
  it('drops the creator’s other approvals from every list', async () => {
    const other = await captureFixture({
      ...common(),
      pendingOnly: true,
      source: 'mock',
      streamWaitMs: 0,
    });
    expect(other.fixture.steps).toHaveLength(1);
    const { fixture } = await captureFixture({
      ...common(),
      approverToken: h.tokens.approver,
      source: 'mock',
      streamWaitMs: 0,
    });
    for (const step of fixture.steps) {
      const rows = (step.list.body as { data: { id: string }[] }).data;
      expect(rows.map((r) => r.id)).toEqual(['apr_FIXTURE_1']);
    }
  });
});
