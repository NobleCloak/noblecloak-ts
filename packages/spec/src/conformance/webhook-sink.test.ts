import { describe, expect, it, vi } from 'vitest';

import { runScenario } from './engine.js';
import type { EngineDeps } from './engine.js';
import { formatSkipWarning } from './run.js';
import { loadCommittedDocument } from '../spec/testing.js';
import { SpecIndex } from '../spec/validate.js';
import type { Scenario, Target, WebhookSink } from './types.js';

const SINK = 'https://sink.test';
const URL_UNDER_SINK = `${SINK}/sig/abc`;
const CONTROL = 'http://control.test/__mock/control';
const NOW = Date.parse('2026-10-26T12:00:00Z');

const delivery = (id: string, seconds = 0, type = 'record.appended'): Record<string, unknown> => ({
  specversion: '1.0',
  id,
  type,
  source: 'https://govern.example.test',
  subject: 'rec_1',
  time: new Date(NOW + seconds * 1000).toISOString(),
  datacontenttype: 'application/json',
  data: {
    record_id: 'rec_1',
    tool_ref: 'ext:t',
    decision: 'allow',
    ts: new Date(NOW).toISOString(),
  },
  signature: 'a.b.c',
});

/** What the sink stored for a delivery: the raw CloudEvents body and the header it arrived with. */
const stored = (body: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  received_at: '2026-10-26T12:00:01Z',
  webhook_id: 'wh_1',
  content_type: 'application/cloudevents+json',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...extra,
});

interface Rig {
  calls: {
    url: string;
    method: string;
    authorization: string | undefined;
    body: unknown;
    signal: AbortSignal | undefined;
    redirect: RequestRedirect | undefined;
  }[];
  sleeps: number[];
  reads: number;
  deps: (extra?: Partial<Target>, sink?: Partial<WebhookSink> | null) => EngineDeps;
}

/** A fake sink: `answer(readNumber)` is what the n-th GET of the sink returns; everything else is a mock-control POST. */
function rig(answer: (read: number) => Response | unknown[]): Rig {
  const index = new SpecIndex(loadCommittedDocument());
  let clock = NOW;
  const r: Rig = {
    calls: [],
    sleeps: [],
    reads: 0,
    deps: (extra = {}, sink = {}) => {
      const target: Target = {
        baseUrl: 'http://x.test',
        deployment: 'hosted',
        tokens: { creator: 'c' },
        fixtures: { proxied_tool: 'p', allow_tool: 'a', deny_tool: 'd', default_tool: 'f' },
        fetch: (input, init) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const headers = new Headers(init?.headers);
          r.calls.push({
            url,
            method: init?.method ?? 'GET',
            authorization: headers.get('authorization') ?? undefined,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            signal: init?.signal ?? undefined,
            redirect: init?.redirect,
          });
          if (!url.startsWith(SINK)) return Promise.resolve(Response.json({}));
          r.reads += 1;
          const out = answer(r.reads);
          return Promise.resolve(
            out instanceof Response ? out : Response.json({ deliveries: out })
          );
        },
        ...(sink === null
          ? {}
          : {
              webhookSink: {
                baseUrl: SINK,
                token: 'sink-secret',
                waitSeconds: 60,
                settleSeconds: 10,
                ...sink,
              },
            }),
        ...extra,
      };
      return {
        index,
        advertised: new Set(),
        target,
        exercised: new Set(),
        corpus: [],
        clock: {
          now: () => clock,
          sleep: (ms) => {
            r.sleeps.push(ms);
            clock += ms;
            return Promise.resolve();
          },
        },
      };
    },
  };
  return r;
}

const readStep = (
  expectBody: unknown[],
  url: string | null = URL_UNDER_SINK,
  save?: Record<string, string>
): Scenario['steps'][number] =>
  ({
    control: { deliveries: { webhook_id: 'wh_1', ...(url === null ? {} : { url }) } },
    ...(save === undefined ? {} : { save }),
    expect_body: expectBody,
  }) as never;
const scenario = (...steps: Scenario['steps']): Scenario => ({
  id: 'sink',
  title: 't',
  tags: ['both'],
  steps,
});
const ONE = { path: 'deliveries', length: 1 };

describe('a deliveries step with a webhook sink', () => {
  it('polls every 2 s: a delivery that arrives after two empty reads passes, then the settle read confirms', async () => {
    const r = rig((n) => (n < 3 ? [] : [stored(delivery('evt_1'))]));
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.failures).toEqual([]);
    expect(r.sleeps).toEqual([2000, 2000, 10000]);
    expect(r.reads).toBe(4);
    expect(r.calls.every((c) => c.url === URL_UNDER_SINK && c.method === 'GET')).toBe(true);
    expect(r.calls[0]?.authorization).toBe('Bearer sink-secret');
  });

  it('fails with the last read and "after N s" when the deliveries never match', async () => {
    const r = rig(() => []);
    const result = await runScenario(scenario(readStep([ONE])), r.deps({}, { waitSeconds: 6 }));
    expect(result.outcome).toBe('failed');
    expect(result.failures.join('\n')).toMatch(/length/);
    expect(result.failures.join('\n')).toContain('did not match after 6 s');
    expect(r.sleeps).toEqual([2000, 2000, 2000]);
    expect(r.reads).toBe(4);
  });

  it('a wait shorter than one poll still reads again at the deadline', async () => {
    const r = rig((n) => (n < 2 ? [] : [stored(delivery('evt_1'))]));
    const result = await runScenario(
      scenario(readStep([ONE])),
      r.deps({}, { waitSeconds: 1, settleSeconds: 0 })
    );
    expect(result.failures).toEqual([]);
    expect(r.sleeps).toEqual([1000, 0]);
  });

  it('with a wait of 1 s and no delivery, reads twice and then fails', async () => {
    const r = rig(() => []);
    const result = await runScenario(scenario(readStep([ONE])), r.deps({}, { waitSeconds: 1 }));
    expect(result.failures.join('\n')).toContain('did not match after 1 s');
    expect(r.sleeps).toEqual([1000]);
    expect(r.reads).toBe(2);
  });

  it('dedupes a repeated event on its id and keeps the first', async () => {
    const r = rig(() => [
      stored(delivery('evt_1', 0, 'record.appended')),
      stored(delivery('evt_1', 5, 'approval.resolved')),
    ]);
    const result = await runScenario(
      scenario(readStep([ONE, { path: 'deliveries.0.type', equals: 'record.appended' }])),
      r.deps()
    );
    expect(result.failures).toEqual([]);
  });

  it('orders by time, whatever order they arrived in, and saves from the ordered answer', async () => {
    const r = rig(() => [
      stored(delivery('evt_late', 30)),
      stored(delivery('evt_early', 10)),
      stored(delivery('evt_mid', 20)),
    ]);
    const vars = scenario(
      readStep(
        [
          { path: 'deliveries.0.id', equals: 'evt_early' },
          { path: 'deliveries.2.id', equals: 'evt_late' },
        ],
        URL_UNDER_SINK,
        { first: 'deliveries.0.id' }
      ),
      readStep([{ path: 'deliveries.1.id', equals: 'evt_mid' }])
    );
    expect((await runScenario(vars, r.deps())).failures).toEqual([]);
  });

  it.each([
    [
      'a wrong NobleCloak-Webhook-Id',
      { webhook_id: 'wh_other' },
      /NobleCloak-Webhook-Id "wh_other"/,
    ],
    ['a missing NobleCloak-Webhook-Id', { webhook_id: null }, /NobleCloak-Webhook-Id null/],
    [
      'a wrong content type',
      { content_type: 'application/json' },
      /not application\/cloudevents\+json/,
    ],
    ['a body that is not JSON', { body: '{not json' }, /body is not JSON/],
  ])('fails on %s without polling on', async (_name, extra, message) => {
    const r = rig(() => [stored(delivery('evt_1'), extra)]);
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.outcome).toBe('failed');
    expect(result.failures.join('\n')).toMatch(message);
    expect(r.sleeps).toEqual([]);
    expect(r.reads).toBe(1);
  });

  it('accepts the media type with parameters', async () => {
    const r = rig(() => [
      stored(delivery('evt_1'), { content_type: 'Application/CloudEvents+JSON; charset=utf-8' }),
    ]);
    expect((await runScenario(scenario(readStep([ONE])), r.deps())).failures).toEqual([]);
  });

  it('holds each stored body to WebhookDelivery', async () => {
    const r = rig(() => [stored({ ...delivery('evt_1'), signature: undefined })]);
    const result = await runScenario(scenario(readStep([ONE])), r.deps({}, { waitSeconds: 2 }));
    expect(result.failures.join('\n')).toMatch(/does not match WebhookDelivery/);
  });

  it.each([
    ['a url outside the sink', 'https://other.test/sig/abc'],
    ['a host that merely starts like the sink', 'https://sink.test.evil.example/sig/abc'],
    ['the sink root with no path', SINK],
    ['an http url on the sink host', 'http://sink.test/sig/abc'],
    ['no url at all', null],
  ])('fails %s without sending a request, so the token goes nowhere else', async (_name, url) => {
    const r = rig(() => []);
    const result = await runScenario(scenario(readStep([ONE], url)), r.deps());
    expect(result.outcome).toBe('failed');
    expect(r.calls).toEqual([]);
    expect(result.failures.join('\n')).toMatch(/webhook sink|names no url/);
  });

  it('compares in URL form: a normalised host and port still count as under the sink, and the read goes to the normalised URL', async () => {
    const r = rig(() => [stored(delivery('evt_1'))]);
    const result = await runScenario(
      scenario(readStep([ONE], 'HTTPS://Sink.test:443/sig/abc')),
      r.deps()
    );
    expect(result.failures).toEqual([]);
    expect(r.calls.every((c) => c.url === URL_UNDER_SINK)).toBe(true);
  });

  it('a url that climbs out of a sink base path with .. is refused without a request', async () => {
    const r = rig(() => []);
    const result = await runScenario(
      scenario(readStep([ONE], `${SINK}/hooks/../admin`)),
      r.deps({}, { baseUrl: `${SINK}/hooks` })
    );
    expect(result.outcome).toBe('failed');
    expect(r.calls).toEqual([]);
  });

  it('fails a length 1 step when the settle read shows a second, distinct delivery', async () => {
    const r = rig((n) =>
      n === 1
        ? [stored(delivery('evt_1'))]
        : [stored(delivery('evt_1')), stored(delivery('evt_2', 1))]
    );
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.outcome).toBe('failed');
    expect(result.failures.join('\n')).toContain('after 10 s settle');
    expect(r.sleeps).toEqual([10000]);
  });

  it('holds a length 0 step through the settle window', async () => {
    const r = rig((n) => (n === 1 ? [] : [stored(delivery('evt_leak'))]));
    const none = { path: 'deliveries', length: 0 };
    expect((await runScenario(scenario(readStep([none])), r.deps())).outcome).toBe('failed');
    const quiet = rig(() => []);
    const ok = await runScenario(scenario(readStep([none])), quiet.deps());
    expect(ok.failures).toEqual([]);
    expect(quiet.sleeps).toEqual([10000]);
  });

  it('a settle of 0 re-reads at once', async () => {
    const r = rig(() => [stored(delivery('evt_1'))]);
    const result = await runScenario(scenario(readStep([ONE])), r.deps({}, { settleSeconds: 0 }));
    expect(result.failures).toEqual([]);
    expect(r.sleeps).toEqual([0]);
    expect(r.reads).toBe(2);
  });

  it('fails naming the status when the sink does not answer 200', async () => {
    const r = rig(() => new Response('no', { status: 401 }));
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.failures.join('\n')).toMatch(/webhook sink answered 401/);
    expect(r.sleeps).toEqual([]);
  });

  it.each([[502], [503], [429]])('retries a %i from the sink within the wait', async (status) => {
    const r = rig((n) => (n < 3 ? new Response('busy', { status }) : [stored(delivery('evt_1'))]));
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.failures).toEqual([]);
    expect(r.sleeps.slice(0, 2)).toEqual([2000, 2000]);
  });

  it('retries a read that throws, and names the fault when the wait runs out', async () => {
    const r = rig((n) => {
      if (n < 3) throw new Error('connect refused');
      return [stored(delivery('evt_1'))];
    });
    expect((await runScenario(scenario(readStep([ONE])), r.deps())).failures).toEqual([]);
    const never = rig(() => new Response('down', { status: 503 }));
    const result = await runScenario(scenario(readStep([ONE])), never.deps({}, { waitSeconds: 4 }));
    expect(result.failures.join('\n')).toMatch(/answered 503/);
    expect(result.failures.join('\n')).toContain('did not match after 4 s');
    expect(never.reads).toBe(3);
  });

  it.each([[401], [403], [404]])('does not retry a %i: it fails at once', async (status) => {
    const r = rig(() => new Response('no', { status }));
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.failures.join('\n')).toMatch(new RegExp(`answered ${String(status)}`));
    expect(r.sleeps).toEqual([]);
    expect(r.reads).toBe(1);
  });

  it('never puts the sink token in a failure, on any failing path', async () => {
    const paths: [string, Rig, Partial<WebhookSink>][] = [
      ['non-200', rig(() => new Response('sink-secret', { status: 401 })), {}],
      [
        'transient to the end',
        rig(() => new Response('sink-secret', { status: 503 })),
        { waitSeconds: 2 },
      ],
      [
        'throws',
        rig(() => {
          throw new Error('connect refused');
        }),
        { waitSeconds: 2 },
      ],
      ['wrong header', rig(() => [stored(delivery('evt_1'), { webhook_id: 'wh_other' })]), {}],
      ['no match', rig(() => []), { waitSeconds: 2 }],
      ['bad body', rig(() => [stored('not json')]), {}],
    ];
    for (const [name, r, sink] of paths) {
      const result = await runScenario(scenario(readStep([ONE])), r.deps({}, sink));
      expect(result.outcome, name).toBe('failed');
      expect(JSON.stringify(result), name).not.toContain('sink-secret');
    }
    const outside = rig(() => []);
    const refused = await runScenario(
      scenario(readStep([ONE], 'https://other.test/x')),
      outside.deps()
    );
    expect(JSON.stringify(refused)).not.toContain('sink-secret');
  });

  it('fails when the sink cannot be reached', async () => {
    const r = rig(() => {
      throw new Error('connect refused');
    });
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.failures.join('\n')).toMatch(/reading the webhook sink failed: connect refused/);
  });

  it('cuts each sink read off with an abort signal, so a hung sink cannot outlast the wait', async () => {
    const r = rig(() => [stored(delivery('evt_1'))]);
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.failures).toEqual([]);
    expect(r.calls.length).toBeGreaterThan(0);
    expect(r.calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
  });

  it('never calls mock control, and sends no reset, even with mock control configured', async () => {
    const r = rig(() => [stored(delivery('evt_1'))]);
    const result = await runScenario(scenario(readStep([ONE])), r.deps({ mockControl: CONTROL }));
    expect(result.failures).toEqual([]);
    expect(r.calls.some((c) => c.url === CONTROL)).toBe(false);
    expect(r.calls.every((c) => c.url.startsWith(SINK))).toBe(true);
  });

  it('a step that switches mock behaviour still goes to mock control, with its reset', async () => {
    const r = rig(() => [stored(delivery('evt_1'))]);
    const result = await runScenario(
      scenario({ control: { disable_webhook: 'wh_1' } }, readStep([ONE])),
      r.deps({ mockControl: CONTROL })
    );
    expect(result.failures).toEqual([]);
    expect(r.calls.filter((c) => c.url === CONTROL).map((c) => c.body)).toEqual([
      { disable_webhook: 'wh_1' },
      { reset: true },
    ]);
  });
});

describe('which control steps a run can answer', () => {
  it('disable_webhook is still skipped as unconfigured with a sink and no mock control', async () => {
    const r = rig(() => []);
    const result = await runScenario(
      scenario({ control: { disable_webhook: 'wh_1' } }, readStep([ONE])),
      r.deps()
    );
    expect(result).toMatchObject({ outcome: 'skipped', skipKind: 'unconfigured' });
    expect(result.skipReason).toBe('needs a server that offers mock control');
    expect(r.calls).toEqual([]);
  });

  it('a deliveries-only scenario with neither says so, and the hint names both flags', async () => {
    const r = rig(() => []);
    const result = await runScenario(scenario(readStep([ONE])), r.deps({}, null));
    expect(result).toMatchObject({ outcome: 'skipped', skipKind: 'unconfigured' });
    expect(result.skipReason).toBe('needs mock control or a webhook sink');
    const warning = formatSkipWarning({
      deployment: 'hosted',
      results: [{ ...result, id: 'x' }],
      passed: 0,
      failed: 0,
      skipped: 1,
      exercised: [],
    });
    expect(warning).toContain('(pass --mock-control or --webhook-sink)');
  });

  it('with mock control only, deliveries go to mock control as before, url included and ignorable', async () => {
    const r = rig(() => []);
    const result = await runScenario(
      scenario({
        control: { deliveries: { webhook_id: 'wh_1', url: '${callback_base_url}/p' } },
      }),
      r.deps({ mockControl: CONTROL }, null)
    );
    expect(result.failures.join('\n')).toMatch(/the mock answered no deliveries/);
    expect(r.calls.map((c) => c.body)).toEqual([
      { deliveries: { webhook_id: 'wh_1', url: 'https://hooks.example.com/p' } },
      { reset: true },
    ]);
  });

  it('binds callback_base_url to the sink when there is one', async () => {
    const r = rig(() => [stored(delivery('evt_1'))]);
    const result = await runScenario(
      scenario({
        control: { deliveries: { webhook_id: 'wh_1', url: '${callback_base_url}/sig/abc' } },
        expect_body: [ONE],
      }),
      r.deps()
    );
    expect(result.failures).toEqual([]);
    expect(r.calls[0]?.url).toBe(URL_UNDER_SINK);
  });
});

describe('an authoring error in expect_body', () => {
  it('surfaces as itself, not as a sink read failure', async () => {
    const r = rig(() => [stored(delivery('evt_1'))]);
    const result = await runScenario(
      scenario(readStep([{ path: 'deliveries.0.id', equals: '${nope}' }])),
      r.deps()
    );
    const text = result.failures.join('\n');
    expect(text).toContain('${nope} is not bound');
    expect(text).not.toContain('reading the webhook sink failed');
  });
});

describe('a body that cannot be read', () => {
  const broken = (): Response =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('connection reset'));
        },
      }),
      { status: 200 }
    );

  it('is retried like a 5xx', async () => {
    const r = rig((n) => (n === 1 ? broken() : [stored(delivery('evt_1'))]));
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.failures).toEqual([]);
    expect(r.reads).toBeGreaterThanOrEqual(3);
  });

  it('names the body fault when it never clears', async () => {
    const r = rig(() => broken());
    const result = await runScenario(scenario(readStep([ONE])), r.deps({}, { waitSeconds: 2 }));
    expect(result.failures.join('\n')).toContain(
      'reading the webhook sink body failed: connection reset'
    );
  });

  it('a well-formed answer without a deliveries list stays fatal', async () => {
    const r = rig(() => new Response('{"nope":1}', { status: 200 }));
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.failures.join('\n')).toContain('answered no deliveries list');
    expect(r.reads).toBe(1);
  });
});

describe('the settle read, which decides a passing step', () => {
  it('retries a transient fault at the settle read and still passes', async () => {
    // read 1 matches, read 2 (the settle read) is a 503, read 3 matches again.
    const r = rig((n) =>
      n === 2 ? new Response('busy', { status: 503 }) : [stored(delivery('evt_1'))]
    );
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.failures).toEqual([]);
    expect(r.reads).toBe(3);
    expect(r.sleeps).toEqual([10_000, 2000]);
  });

  it('retries a thrown settle read too, and fails naming the fault when the window runs out', async () => {
    const r = rig((n) => {
      if (n >= 2) throw new Error('connect refused');
      return [stored(delivery('evt_1'))];
    });
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.failures.join('\n')).toMatch(/connect refused.*after 10 s settle/);
    expect(r.reads).toBe(1 + 11);
  });

  it('gives the settle read a full read budget even after a late match used up the wait', async () => {
    const budgets: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      budgets.push(ms);
      return real(ms);
    });
    try {
      const r = rig((n) => (n < 30 ? [] : [stored(delivery('evt_1'))]));
      const result = await runScenario(scenario(readStep([ONE])), r.deps());
      expect(result.failures).toEqual([]);
      expect(budgets.at(-1)).toBe(10_000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the bearer goes only to the sink', () => {
  it('every sink read refuses redirects', async () => {
    const r = rig(() => [stored(delivery('evt_1'))]);
    await runScenario(scenario(readStep([ONE])), r.deps());
    expect(r.calls.length).toBeGreaterThan(0);
    expect(r.calls.every((c) => c.redirect === 'manual')).toBe(true);
  });

  it('a redirect from the sink fails the step at once, naming the status, and is not retried', async () => {
    const r = rig(
      () => new Response(null, { status: 302, headers: { location: 'http://elsewhere.test/x' } })
    );
    const result = await runScenario(scenario(readStep([ONE])), r.deps());
    expect(result.failures.join('\n')).toMatch(/answered 302/);
    expect(r.reads).toBe(1);
    expect(r.calls.some((c) => c.url.startsWith('http://elsewhere.test'))).toBe(false);
  });
});
