// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { factRowOfMember } from './connections-facts.js';
import { createConnectionsStore, toolPendingKey } from './connections-store.js';
import type { ConnectionsSnapshot, ConnectionsStore } from './connections-types.js';
import {
  inProcessFetch,
  jsonResponse,
  recorder,
  startHarness,
} from './testing/approvals-harness.js';
import type { Harness } from './testing/approvals-harness.js';
import { untilState } from './testing/permissions-harness.js';

const settled = (store: ConnectionsStore): Promise<ConnectionsSnapshot> =>
  untilState(store, (s) => s.status !== 'loading' && s.status !== 'idle');

let unique = 0;
const host = (): string => {
  unique += 1;
  return `https://facts-${String(unique)}.example.com/mcp`;
};

const AMOUNT = { amount: { path: '.amount', type: 'number' as const } };

describe('updateToolFacts on the default service', () => {
  let h: Harness;
  const closers: (() => void)[] = [];
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    for (const close of closers) close();
    await h.stop();
  });

  /** A store with one registered tool, its detail view subscribed. */
  async function withTool(options: { readOnly?: boolean; token?: string } = {}) {
    const rec = recorder(inProcessFetch(h.mock));
    const store = createConnectionsStore({
      baseUrl: h.baseUrl,
      getToken: () => options.token ?? h.tokens.admin,
      fetch: rec.fetch,
      ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    });
    const stop = store.subscribe(() => undefined);
    closers.push(() => {
      stop();
      store.dispose();
    });
    await settled(store);
    // The administrator registers it; a read-only store reads it.
    const admin = createConnectionsStore({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.admin,
      fetch: inProcessFetch(h.mock),
    });
    const stopAdmin = admin.subscribe(() => undefined);
    closers.push(() => {
      stopAdmin();
      admin.dispose();
    });
    await settled(admin);
    const made = await admin.create({
      name: 'facts',
      url: host(),
      transport: 'mcp',
      ownerKind: 'org',
    });
    if (!made.ok) throw new Error('create failed');
    await admin.refresh(made.connection.id);
    await store.reload();
    const detail = store.detail(made.connection.id);
    const stopDetail = detail.subscribe(() => undefined);
    closers.push(stopDetail);
    const read = await untilState(detail, (s) => s.status === 'ready' && s.tools.length > 0);
    const tool = read.tools[0];
    if (tool === undefined) throw new Error('no tool registered');
    return { store, rec, detail, tool };
  }

  it('reads tools.facts from the capabilities', async () => {
    const { store } = await withTool();
    expect(store.getSnapshot().facts?.toolFacts).toBe(true);
  });

  it('replaces the whole map with { facts } alone, and shows the tool as the service now holds it', async () => {
    const { store, rec, detail, tool } = await withTool();
    expect(tool.facts).toBeUndefined();
    const result = await store.updateToolFacts(tool.id, AMOUNT);
    expect(result).toMatchObject({ ok: true, tool: { id: tool.id, facts: AMOUNT } });
    const patch = rec.calls.filter(
      (c) => c.method === 'PATCH' && c.path === `/v1/tools/${tool.id}`
    );
    expect(patch.map((c) => c.body)).toEqual([{ facts: AMOUNT }]);
    expect(detail.getSnapshot().tools.find((t) => t.id === tool.id)?.facts).toEqual(AMOUNT);
    // The list carries the facts, so a fresh read agrees.
    await detail.reload();
    expect(detail.getSnapshot().tools.find((t) => t.id === tool.id)?.facts).toEqual(AMOUNT);
    // A second write replaces, it does not merge.
    const replaced = {
      env: { path: '.target.env', type: 'string' as const, description: 'where' },
    };
    await store.updateToolFacts(tool.id, replaced);
    await detail.reload();
    expect(detail.getSnapshot().tools.find((t) => t.id === tool.id)?.facts).toEqual(replaced);
  });

  it('sends null to clear the facts', async () => {
    const { store, rec, detail, tool } = await withTool();
    await store.updateToolFacts(tool.id, AMOUNT);
    const cleared = await store.updateToolFacts(tool.id, null);
    expect(cleared.ok).toBe(true);
    expect(rec.calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ facts: null });
    expect(detail.getSnapshot().tools.find((t) => t.id === tool.id)?.facts).toBeUndefined();
  });

  it('maps a 400 that names a fact to its member, so the editor can mark the row', async () => {
    const { store, tool } = await withTool();
    const refused = await store.updateToolFacts(tool.id, {
      amount: { path: '.items[*].price', type: 'number' },
    });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.error).toMatchObject({ kind: 'invalid_request', status: 400 });
    expect(refused.error.member).toBe('facts.amount.path');
    expect(
      factRowOfMember(refused.error.member, [
        { name: 'amount', path: '', type: '', description: '' },
      ])
    ).toEqual({ row: 0, field: 'path' });
  });

  it('refuses, without a request, a tool the store does not hold', async () => {
    const { store, rec } = await withTool();
    const before = rec.calls.length;
    expect(await store.updateToolFacts('no-such-tool', AMOUNT)).toMatchObject({
      ok: false,
      error: { kind: 'precondition', code: 'not_loaded' },
    });
    expect(rec.calls.length).toBe(before);
  });

  it("refuses, without a request, an organisation's tool for a caller known not to be an administrator", async () => {
    const { store, rec, tool } = await withTool({ readOnly: true });
    const before = rec.calls.length;
    expect(await store.updateToolFacts(tool.id, AMOUNT)).toMatchObject({
      ok: false,
      error: { kind: 'precondition', code: 'read_only' },
    });
    expect(rec.calls.length).toBe(before);
  });
});

describe('updateToolFacts against a stubbed service', () => {
  const connection = {
    id: 'c1',
    name: 'one',
    url: 'https://one.example.com/mcp',
    transport: 'mcp',
    owner: { kind: 'org', id: 'o' },
    created_at: '2026-10-22T00:00:00Z',
  };
  const baseTool = {
    id: 't1',
    tool_ref: 'one/pay',
    connection_id: 'c1',
    transport: 'mcp',
    side_effect_level: 'write',
  };

  /** A service that advertises `features`, lists `tool` for `c1`, and answers a PATCH with `onPatch`. */
  function open(
    features: string[],
    tool: Record<string, unknown>,
    onPatch: (request: Request) => Promise<Response>
  ) {
    const patches: Request[] = [];
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/v1/capabilities')
        return Promise.resolve(jsonResponse({ data: { features }, meta: {} }));
      if (request.method === 'PATCH') {
        patches.push(request);
        return onPatch(request);
      }
      if (path === '/v1/tools')
        return Promise.resolve(jsonResponse({ data: [tool], meta: { next: null } }));
      return Promise.resolve(jsonResponse({ data: [connection], meta: { next: null } }));
    });
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch,
    });
    const stop = store.subscribe(() => undefined);
    return { store, patches, stop };
  }

  async function ready(setup: ReturnType<typeof open>) {
    await settled(setup.store);
    const detail = setup.store.detail('c1');
    const stopDetail = detail.subscribe(() => undefined);
    await untilState(detail, (s) => s.status === 'ready');
    return () => {
      stopDetail();
      setup.stop();
      setup.store.dispose();
    };
  }

  it('is not offered, and sends nothing, when the service does not advertise tools.facts', async () => {
    const setup = open(['connections'], baseTool, () => Promise.reject(new Error('no request')));
    const close = await ready(setup);
    expect(setup.store.getSnapshot().facts?.toolFacts).toBeUndefined();
    expect(await setup.store.updateToolFacts('t1', AMOUNT)).toMatchObject({
      ok: false,
      error: { kind: 'precondition', code: 'facts_not_offered' },
    });
    expect(setup.patches).toEqual([]);
    close();
  });

  it('never replaces a facts member it could not read', async () => {
    const setup = open(
      ['connections', 'tools.facts'],
      { ...baseTool, facts: { amount: { path: '.amount', type: 'float' } } },
      () => Promise.reject(new Error('no request'))
    );
    const close = await ready(setup);
    const tool = setup.store.detail('c1').getSnapshot().tools[0];
    expect(tool).toMatchObject({ id: 't1', factsUnreadable: true });
    expect(tool?.facts).toBeUndefined();
    expect(await setup.store.updateToolFacts('t1', AMOUNT)).toMatchObject({
      ok: false,
      error: { kind: 'precondition', code: 'facts_not_offered' },
    });
    expect(setup.patches).toEqual([]);
    close();
  });

  it('refuses a second change to the same tool while the first is in flight', async () => {
    let release: (() => void) | undefined;
    const setup = open(
      ['connections', 'tools.facts'],
      baseTool,
      () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(jsonResponse({ data: { ...baseTool, facts: AMOUNT }, meta: {} }));
          };
        })
    );
    const close = await ready(setup);
    const first = setup.store.updateToolFacts('t1', AMOUNT);
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    expect(setup.store.getSnapshot().pending.has(toolPendingKey('t1'))).toBe(true);
    expect(setup.store.getSnapshot().pending.has('c1')).toBe(false);
    expect(await setup.store.updateToolFacts('t1', null)).toMatchObject({
      ok: false,
      error: { code: 'write_in_flight' },
    });
    release?.();
    expect(await first).toMatchObject({ ok: true, tool: { facts: AMOUNT } });
    expect(setup.store.getSnapshot().pending.has(toolPendingKey('t1'))).toBe(false);
    close();
  });

  it('turns a 403 into the administrator-only state, as a change to the registration does', async () => {
    const setup = open(['connections', 'tools.facts'], baseTool, () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ type: 'https://x/problems/forbidden', title: 'no', status: 403 }),
          {
            status: 403,
            headers: { 'content-type': 'application/problem+json' },
          }
        )
      )
    );
    const close = await ready(setup);
    expect(await setup.store.updateToolFacts('t1', AMOUNT)).toMatchObject({
      ok: false,
      error: { kind: 'forbidden' },
    });
    expect(setup.store.getSnapshot().administration).toEqual({
      readOnly: true,
      reason: 'forbidden',
    });
    close();
  });
});
