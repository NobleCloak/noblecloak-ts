import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  EFFECTIVE_CONCURRENCY,
  createEffectiveStore,
  effectiveCellKey,
  effectiveResultOf,
} from './permissions-effective.js';
import type {
  EffectiveDeps,
  EffectiveSendResult,
  EffectiveCell,
  EffectiveRequest,
  EffectiveSnapshot,
  EffectiveStore,
} from './permissions-effective.js';
import type {
  PermissionsError,
  PolicyInfo,
  PolicySubject,
  SimulationResult,
} from './permissions-types.js';
import { policyOf } from './permissions-parse.js';
import {
  call,
  inProcessFetch,
  jsonResponse,
  problemResponse,
  recorder,
  startHarness,
} from './testing/approvals-harness.js';
import type { Harness, Recorder } from './testing/approvals-harness.js';
import { livePolicies, settled, untilState } from './testing/permissions-harness.js';
import type { LivePolicies } from './testing/permissions-harness.js';

/*
 * The effective view against the mock, with a fixture of its own (organisation, role, agent and user policies; the
 * wire has no platform or tool subject, and the deployment's default is the null-id entry). The harness is this file's
 * alone: the organisation policies it publishes would change every other test's cells.
 */

const TOOL_A = 'mcp:tracker:search';
const TOOL_B = 'mcp:tracker:create_issue';
/** Governed by nothing the fixture publishes for its role: the default applies. */
const TOOL_C = 'mcp:tracker:list_labels';
const ROLE: PolicySubject = { type: 'role', id: 'effective_reviewer' };
const ORG: PolicySubject = { type: 'organization' };
const ROLE_KEY = 'role:effective_reviewer';

const simulateCalls = (rec: Recorder): number =>
  rec.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/simulate')).length;

const ask = (subject: PolicySubject, columnKey: string, ...tools: string[]): EffectiveRequest[] =>
  tools.map((toolRef) => ({ columnKey, subject, toolRef }));

const cellOf = (s: EffectiveSnapshot, columnKey: string, toolRef: string): EffectiveCell => {
  const cell = s.cells.get(effectiveCellKey(columnKey, toolRef));
  if (cell === undefined) throw new Error(`no cell ${columnKey} × ${toolRef}`);
  return cell;
};

const allSettled = (store: EffectiveStore, keys: readonly string[]): Promise<EffectiveSnapshot> =>
  untilState(store, (s) =>
    keys.every((k) => {
      const c = s.cells.get(k);
      return c !== undefined && c.state !== 'loading';
    })
  );

/** A 422 `unsupported_policy_form` whose `detail` names a member. */
const unprocessable = (detail: string): Response =>
  new Response(
    JSON.stringify({
      type: 'https://x/problems/unsupported_policy_form',
      title: 'unsupported_policy_form',
      status: 422,
      detail,
      request_id: 'req_t',
    }),
    { status: 422, headers: { 'content-type': 'application/problem+json' } }
  );

let h: Harness;
const opened: LivePolicies[] = [];
const ids: Record<string, string> = {};

async function publish(name: string, body: Record<string, unknown>): Promise<string> {
  const created = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/policies', {
    kind: 'tool_invocation',
    name,
    ...body,
  });
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { data: { id: string } }).data.id;
  expect((await call(h.baseUrl, h.tokens.admin, 'POST', `/v1/policies/${id}/publish`)).status).toBe(
    200
  );
  ids[name] = id;
  return id;
}

beforeAll(async () => {
  h = await startHarness();
  // Tool A: the organisation allows, the role denies; an agent and a user policy name it too.
  await publish('org allows A', {
    subjects: [ORG],
    targets: { tools: [TOOL_A] },
    config: { mode: 'always_allow' },
  });
  await publish('role denies A', {
    subjects: [ROLE],
    targets: { tools: [TOOL_A] },
    config: { mode: 'deny' },
  });
  await publish('agent asks A', {
    subjects: [{ type: 'agent', id: 'agent_effective' }],
    targets: { tools: [TOOL_A] },
    config: { mode: 'ask' },
  });
  await publish('user denies B', {
    subjects: [{ type: 'user', id: 'user_effective' }],
    targets: { tools: [TOOL_B] },
    config: { mode: 'deny' },
  });
  // Tool B: the organisation asks, the role allows.
  await publish('org asks B', {
    subjects: [ORG],
    targets: { tools: [TOOL_B] },
    config: { mode: 'ask' },
  });
  await publish('role allows B', {
    subjects: [ROLE],
    targets: { tools: [TOOL_B] },
    config: { mode: 'always_allow' },
  });
});

afterAll(async () => {
  for (const l of opened) l.close();
  await h.stop();
});

function open(token: string, rec: Recorder, extra: Record<string, unknown> = {}): LivePolicies {
  const l = livePolicies({ baseUrl: h.baseUrl, getToken: () => token, fetch: rec.fetch, ...extra });
  opened.push(l);
  return l;
}

describe('the effective cell, on a fixture of organisation, role, agent and user policies', () => {
  it('names, for every cell, the subject and policy that set it, and never an agent or user policy for a role', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { store } = open(h.tokens.admin, rec);
    await settled(store);
    const effective = store.effective();
    const asked = [
      ...ask(ROLE, ROLE_KEY, TOOL_A, TOOL_B, TOOL_C),
      ...ask(ORG, 'organization', TOOL_A, TOOL_B),
    ];
    effective.request(asked);
    const s = await allSettled(
      effective,
      asked.map((a) => effectiveCellKey(a.columnKey, a.toolRef))
    );
    expect(s.status).toBe('ready');
    expect(s.composition).toBe(true);

    const done = (columnKey: string, tool: string) => {
      const c = cellOf(s, columnKey, tool);
      if (c.state !== 'done') throw new Error(JSON.stringify(c));
      return c.result;
    };
    const setBy = (columnKey: string, tool: string) =>
      (done(columnKey, tool).setBy ?? []).map((e) => [e.policyId, e.subject?.type ?? null]);

    // The role's deny is tighter than the organisation's allow: it alone set the cell.
    expect(done(ROLE_KEY, TOOL_A).decision).toBe('deny');
    expect(setBy(ROLE_KEY, TOOL_A)).toEqual([[ids['role denies A'], 'role']]);
    // The allow matched too, and is listed, without having set it.
    expect(done(ROLE_KEY, TOOL_A).matched.map((e) => e.policyId)).toContain(ids['org allows A']);
    // The organisation's ask is tighter than the role's allow.
    expect(done(ROLE_KEY, TOOL_B).decision).toBe('step_up');
    expect(setBy(ROLE_KEY, TOOL_B)).toEqual([[ids['org asks B'], 'organization']]);
    // Nothing the role holds matched: the deployment's default set it.
    expect(done(ROLE_KEY, TOOL_C).setBy).toEqual([
      expect.objectContaining({ policyId: null, source: 'default' }),
    ]);
    // The organisation alone.
    expect(done('organization', TOOL_A).decision).toBe('allow');
    expect(setBy('organization', TOOL_A)).toEqual([[ids['org allows A'], 'organization']]);
    expect(setBy('organization', TOOL_B)).toEqual([[ids['org asks B'], 'organization']]);
    // An agent or user policy never applies to a holder of a role or of the organisation.
    for (const key of [ROLE_KEY, 'organization'])
      for (const tool of [TOOL_A, TOOL_B]) {
        const types = done(key, tool).matched.map((e) => e.subject?.type);
        expect(types).not.toContain('agent');
        expect(types).not.toContain('user');
      }
    // Each simulation names its subject and its anchor's version, and never the caller.
    const bodies = rec.calls.filter((c) => c.path.endsWith('/simulate')).map((c) => c.body);
    expect(bodies).toContainEqual({
      draft_version: 1,
      subject: { type: 'role', id: 'effective_reviewer' },
      action: { tool_ref: TOOL_A, arguments: {} },
    });
    expect(bodies).toContainEqual(expect.objectContaining({ subject: { type: 'organization' } }));
    // Asking again sends nothing: the cells are cached.
    const before = simulateCalls(rec);
    effective.request(asked);
    expect(simulateCalls(rec)).toBe(before);
  });

  it('claims no composition where the service does not advertise it', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/capabilities') return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: { features: string[] } };
      return jsonResponse({
        ...body,
        data: {
          ...body.data,
          features: body.data.features.filter((f) => f !== 'policies.tightest_wins'),
        },
      });
    });
    const { store } = open(h.tokens.admin, rec);
    await settled(store);
    const effective = store.effective();
    effective.request(ask(ROLE, ROLE_KEY, TOOL_A));
    const s = await allSettled(effective, [effectiveCellKey(ROLE_KEY, TOOL_A)]);
    expect(s.composition).toBe(false);
    const c = cellOf(s, ROLE_KEY, TOOL_A);
    if (c.state !== 'done') throw new Error(JSON.stringify(c));
    expect(c.result.decision).toBe('deny');
    expect(c.result).not.toHaveProperty('setBy');
    expect(c.result.matched.length).toBeGreaterThan(1);
  });

  it('a member is refused once, and nothing more is sent', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { store } = open(h.tokens.member, rec);
    await settled(store);
    const effective = store.effective();
    effective.request([
      ...ask(ROLE, ROLE_KEY, TOOL_A, TOOL_B, TOOL_C),
      ...ask(ORG, 'organization', TOOL_A, TOOL_B, TOOL_C),
    ]);
    const s = await untilState(effective, (x) => x.status === 'not_permitted');
    expect(s.error?.kind).toBe('forbidden');
    effective.request(ask(ROLE, ROLE_KEY, TOOL_A, TOOL_B));
    await new Promise((r) => setTimeout(r, 50));
    expect(simulateCalls(rec)).toBe(1);
    expect(effective.getSnapshot().cells.size).toBe(0);
  });

  it('a host that says its user is not an administrator sends nothing', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { store } = open(h.tokens.admin, rec, { readOnly: true });
    await settled(store);
    const effective = store.effective();
    effective.request(ask(ROLE, ROLE_KEY, TOOL_A, TOOL_B));
    expect(effective.getSnapshot().status).toBe('not_offered');
    await new Promise((r) => setTimeout(r, 20));
    expect(simulateCalls(rec)).toBe(0);
  });

  it('a host that says its user is not an administrator sends nothing, where authoring is not offered too (merge gate)', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/capabilities') return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: { features: string[] } };
      return jsonResponse({
        ...body,
        data: {
          ...body.data,
          features: body.data.features.filter((f) => f !== 'policies.author'),
        },
      });
    });
    const { store } = open(h.tokens.admin, rec, { readOnly: true });
    const s = await settled(store);
    expect(s.authoring.reason).toBe('not_offered');
    const effective = store.effective();
    effective.request(ask(ROLE, ROLE_KEY, TOOL_A, TOOL_B));
    expect(effective.getSnapshot().status).toBe('not_offered');
    await new Promise((r) => setTimeout(r, 20));
    expect(simulateCalls(rec)).toBe(0);
  });

  it('marks a subject type the service cannot simulate after one refusal, and sends no more of it', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.path.endsWith('/simulate') &&
      (c.body as { subject?: { type?: string } } | undefined)?.subject?.type === 'organization'
        ? unprocessable('subject: not simulated here')
        : undefined
    );
    const { store } = open(h.tokens.admin, rec);
    await settled(store);
    const effective = store.effective();
    const asked = [
      ...ask(ORG, 'organization', TOOL_A, TOOL_B, TOOL_C),
      ...ask(ROLE, ROLE_KEY, TOOL_A, TOOL_B),
    ];
    effective.request(asked);
    const s = await allSettled(
      effective,
      asked.map((a) => effectiveCellKey(a.columnKey, a.toolRef))
    );
    expect([TOOL_A, TOOL_B, TOOL_C].map((t) => cellOf(s, 'organization', t).state)).toEqual([
      'unsupported',
      'unsupported',
      'unsupported',
    ]);
    expect(cellOf(s, ROLE_KEY, TOOL_A).state).toBe('done');
    const orgCalls = rec.calls.filter(
      (c) =>
        c.path.endsWith('/simulate') &&
        (c.body as { subject?: { type?: string } }).subject?.type === 'organization'
    );
    expect(orgCalls).toHaveLength(1);
    expect([...s.unsupportedSubjects]).toEqual(['organization']);
  });

  it(`keeps at most ${String(EFFECTIVE_CONCURRENCY)} simulations in flight, and aborts them on dispose`, async () => {
    const rec = recorder(inProcessFetch(h.mock));
    let live = 0;
    let most = 0;
    const signals: AbortSignal[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    rec.intercept(async (c, request) => {
      if (!c.path.endsWith('/simulate')) return undefined;
      live += 1;
      most = Math.max(most, live);
      signals.push(request.signal);
      // The first (the probe of the role type) answers at once; the rest wait.
      if (signals.length > 1) await gate;
      live -= 1;
      return undefined;
    });
    const l = open(h.tokens.admin, rec);
    const { store } = l;
    await settled(store);
    const effective = store.effective();
    const tools = store.getSnapshot().tools.map((t) => t.toolRef);
    expect(tools.length).toBeGreaterThan(EFFECTIVE_CONCURRENCY + 1);
    effective.request(ask(ROLE, ROLE_KEY, ...tools));
    await vi.waitFor(() => {
      expect(signals).toHaveLength(EFFECTIVE_CONCURRENCY + 1);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(most).toBe(EFFECTIVE_CONCURRENCY);
    expect(signals).toHaveLength(EFFECTIVE_CONCURRENCY + 1);
    const notified: number[] = [];
    effective.subscribe(() => notified.push(1));
    l.close();
    expect(signals.slice(1).every((s) => s.aborted)).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(notified).toEqual([]);
  });

  it('computes again when a policy is published, and on a draft basis as if the draft were published', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { store } = open(h.tokens.admin, rec);
    await settled(store);
    const effective = store.effective();
    effective.request(ask(ROLE, ROLE_KEY, TOOL_C));
    const first = await allSettled(effective, [effectiveCellKey(ROLE_KEY, TOOL_C)]);
    const firstCell = cellOf(first, ROLE_KEY, TOOL_C);
    if (firstCell.state !== 'done') throw new Error(JSON.stringify(firstCell));
    expect(firstCell.result.setBy).toEqual([expect.objectContaining({ policyId: null })]);
    // A draft that denies C to the role: as if published, it sets the cell; the published basis is unchanged.
    const created = await store.create({
      kind: 'tool_invocation',
      name: 'role denies C',
      subjects: [ROLE],
      targets: [TOOL_C],
      config: { mode: 'deny' },
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    effective.setBasis({
      kind: 'draft',
      policyId: created.policy.id,
      version: created.policy.version,
    });
    effective.request(ask(ROLE, ROLE_KEY, TOOL_C));
    const asDraft = await allSettled(effective, [effectiveCellKey(ROLE_KEY, TOOL_C)]);
    const draftCell = cellOf(asDraft, ROLE_KEY, TOOL_C);
    if (draftCell.state !== 'done') throw new Error(JSON.stringify(draftCell));
    expect(draftCell.result.decision).toBe('deny');
    expect(draftCell.result.anchor).toEqual({ policyId: created.policy.id, version: 1 });
    expect(draftCell.result.setBy?.map((e) => e.policyId)).toEqual([created.policy.id]);
    // Published, the published basis computes it again: a new round, a new request.
    effective.setBasis({ kind: 'published' });
    const before = simulateCalls(rec);
    expect((await store.publish(created.policy.id, created.policy)).ok).toBe(true);
    await untilState(store, (x) =>
      x.policies.some((p) => p.id === created.policy.id && p.state === 'published')
    );
    effective.request(ask(ROLE, ROLE_KEY, TOOL_C));
    const after = await allSettled(effective, [effectiveCellKey(ROLE_KEY, TOOL_C)]);
    expect(simulateCalls(rec)).toBe(before + 1);
    const c = cellOf(after, ROLE_KEY, TOOL_C);
    if (c.state !== 'done') throw new Error(JSON.stringify(c));
    expect(c.result.decision).toBe('deny');
  });
});

describe('the effective queue after failures', () => {
  it('pauses on a failure that would fail the rest, and a retry asks again for every cell until all are done', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    let calls = 0;
    rec.intercept((c) => {
      if (!c.path.endsWith('/simulate')) return undefined;
      calls += 1;
      return calls === 2 ? problemResponse(503, 'unavailable') : undefined;
    });
    const { store } = open(h.tokens.admin, rec);
    await settled(store);
    const effective = store.effective();
    const cells = ask(ROLE, ROLE_KEY, TOOL_A, TOOL_B, TOOL_C);
    effective.request(cells);
    const paused = await untilState(effective, (s) => s.status === 'paused');
    expect(paused.error?.kind).toBe('unavailable');
    // Everything in flight settles; nothing more is sent while paused.
    await new Promise((r) => setTimeout(r, 30));
    const sent = simulateCalls(rec);
    effective.request(cells);
    expect(simulateCalls(rec)).toBe(sent);
    effective.retry();
    const keys = cells.map((c) => effectiveCellKey(c.columnKey, c.toolRef));
    const done = await untilState(effective, (s) =>
      keys.every((k) => s.cells.get(k)?.state === 'done')
    );
    expect(done.status).toBe('ready');
  });

  it('marks a cell, not its column, for a 422 that does not name the subject', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.path.endsWith('/simulate') &&
      (c.body as { action?: { tool_ref?: string } }).action?.tool_ref === TOOL_B
        ? unprocessable('config.mode: not here')
        : undefined
    );
    const { store } = open(h.tokens.admin, rec);
    await settled(store);
    const effective = store.effective();
    const asked = ask(ROLE, ROLE_KEY, TOOL_A, TOOL_B, TOOL_C);
    effective.request(asked);
    const s = await allSettled(
      effective,
      asked.map((a) => effectiveCellKey(a.columnKey, a.toolRef))
    );
    expect(cellOf(s, ROLE_KEY, TOOL_B).state).toBe('error');
    expect(cellOf(s, ROLE_KEY, TOOL_C).state).toBe('done');
    expect([...s.unsupportedSubjects]).toEqual([]);
  });

  it('computes a draft basis again when the draft is rewritten in place', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { store } = open(h.tokens.admin, rec);
    await settled(store);
    const effective = store.effective();
    const role: PolicySubject = { type: 'role', id: 'effective_rewrite' };
    const created = await store.create({
      kind: 'tool_invocation',
      name: 'rewritten draft',
      subjects: [role],
      targets: [TOOL_C],
      config: { mode: 'deny' },
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    effective.setBasis({
      kind: 'draft',
      policyId: created.policy.id,
      version: created.policy.version,
    });
    const key = effectiveCellKey('role:effective_rewrite', TOOL_C);
    effective.request(ask(role, 'role:effective_rewrite', TOOL_C));
    const first = await allSettled(effective, [key]);
    const before = cellOf(first, 'role:effective_rewrite', TOOL_C);
    if (before.state !== 'done') throw new Error(JSON.stringify(before));
    expect(before.result.decision).toBe('deny');
    // Rewritten in place: the same version, another mode.
    const editor = store.editor(created.policy.id);
    await untilState(editor, (e) => e.status === 'ready');
    editor.setMode('always_allow');
    const saved = await editor.save();
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    expect(saved.policy.version).toBe(created.policy.version);
    await untilState(effective, (s) => s.round > first.round);
    effective.request(ask(role, 'role:effective_rewrite', TOOL_C));
    const after = await untilState(effective, (s) => {
      const c = s.cells.get(key);
      return c?.state === 'done';
    });
    const cell = cellOf(after, 'role:effective_rewrite', TOOL_C);
    if (cell.state !== 'done') throw new Error(JSON.stringify(cell));
    expect(cell.result.decision).toBe('allow');
  });
});

describe('the effective store on fake answers', () => {
  const parsed = policyOf({
    id: 'p1',
    version: 1,
    source: 'authored',
    kind: 'tool_invocation',
    state: 'published',
    subjects: [{ type: 'organization' }],
    targets: { tools: 'all' },
    config: { mode: 'ask' },
  });
  if (parsed === undefined) throw new Error('fixture does not parse');
  const published: PolicyInfo = parsed;
  const ok: EffectiveSendResult = {
    ok: true,
    value: { decision: 'allow', actionDigest: 'd', enforced: false },
  };
  const fail = (
    error: Partial<PermissionsError> & Pick<PermissionsError, 'kind'>
  ): EffectiveSendResult => ({
    ok: false,
    error: { code: 'x', title: 'x', ...error } as PermissionsError,
  });

  /** A store whose answers the test releases one by one. */
  function harness() {
    let loaded = true;
    const change = new Set<() => void>();
    const pending: { body: Record<string, unknown>; settle: (r: EffectiveSendResult) => void }[] =
      [];
    const deps: EffectiveDeps = {
      facts: () => ({
        served: true,
        author: true,
        publish: true,
        importExport: false,
        principals: false,
        connections: false,
        runs: false,
        suggested: false,
        approvals: true,
        tightestWins: true,
        retire: false,
      }),
      loaded: () => loaded,
      policies: () => [published],
      draft: () => undefined,
      tools: () => [],
      notAdministrator: () => false,
      send: (_id, body, signal) =>
        new Promise((resolve) => {
          pending.push({ body, settle: resolve });
          signal.addEventListener('abort', () => {
            resolve({ ok: false, aborted: true });
          });
        }),
      onChange: (listener) => {
        change.add(listener);
        return () => change.delete(listener);
      },
      reportFault: () => undefined,
    };
    const store = createEffectiveStore(deps);
    return {
      store,
      pending,
      setLoaded(value: boolean) {
        loaded = value;
        for (const l of change) l();
      },
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const cellsOf = (n: number, type = 'role') =>
    Array.from({ length: n }, (_, i) => ({
      columnKey: `${type}:r`,
      subject: type === 'organization' ? { type } : { type, id: 'r' },
      toolRef: `t:${String(i)}`,
    }));

  it('resumes the queue when a reload ends, so no cell waits for good (ADV-B1)', async () => {
    const h = harness();
    h.store.request(cellsOf(10));
    expect(h.pending).toHaveLength(1);
    h.pending[0]?.settle(ok);
    await tick();
    expect(h.pending).toHaveLength(1 + EFFECTIVE_CONCURRENCY);
    h.setLoaded(false);
    for (const p of h.pending.slice(1)) p.settle(ok);
    await tick();
    h.setLoaded(true);
    await tick();
    expect(h.pending.length).toBeGreaterThan(1 + EFFECTIVE_CONCURRENCY);
    // Answer everything sent, round after round (settling a settled one again does nothing).
    for (let round = 0; round < 20; round += 1) {
      for (const p of h.pending) p.settle(ok);
      await tick();
    }
    const s = h.store.getSnapshot();
    expect([...s.cells.values()].every((c) => c.state === 'done')).toBe(true);
    expect(s.cells.size).toBe(10);
  });

  it('takes a 422 that names subject anywhere in its detail as a refusal of the type (ADV-B2)', async () => {
    const h = harness();
    h.store.request(cellsOf(5, 'organization'));
    h.pending[0]?.settle(
      fail({
        kind: 'unprocessable',
        detail: 'This deployment cannot simulate as a `subject` of this type.',
      })
    );
    await tick();
    expect(h.pending).toHaveLength(1);
    expect([...h.store.getSnapshot().unsupportedSubjects]).toEqual(['organization']);
    expect([...h.store.getSnapshot().cells.values()].every((c) => c.state === 'unsupported')).toBe(
      true
    );
  });

  it('sends the next request of a type alone after its first failed in another way (ADV-B3)', async () => {
    const h = harness();
    h.store.request(cellsOf(6));
    h.pending[0]?.settle(fail({ kind: 'malformed_response' }));
    await tick();
    expect(h.pending).toHaveLength(2);
    h.pending[1]?.settle(fail({ kind: 'forbidden' }));
    await tick();
    expect(h.store.getSnapshot().status).toBe('not_permitted');
    expect(h.pending).toHaveLength(2);
  });

  it('a new round sends no second first request while the first is still settling (ADV-B3)', async () => {
    const h = harness();
    h.store.request(cellsOf(3));
    expect(h.pending).toHaveLength(1);
    h.store.setBasis({ kind: 'draft', policyId: 'p1', version: 2 });
    h.store.request(cellsOf(3));
    expect(h.pending).toHaveLength(1);
    // The aborted request settles on its abort; only then does the new round's first go, alone.
    await tick();
    expect(h.pending).toHaveLength(2);
  });
});

describe('effectiveResultOf', () => {
  const result: SimulationResult = {
    decision: 'deny',
    actionDigest: 'sha256:x',
    enforced: false,
    considered: {
      policies: [
        { kind: 'tool_invocation', id: 'p1', version: 1, result: 'deny', contributed: true },
        {
          kind: 'tool_invocation',
          id: 'p2',
          version: 2,
          result: 'always_allow',
          contributed: false,
        },
      ],
      composed: { decision: 'deny' },
    },
  };
  it('takes the contributing entries only where the composition is advertised', () => {
    const anchor = { policyId: 'p1', version: 1 };
    expect(effectiveResultOf(result, anchor, true).setBy?.map((e) => e.policyId)).toEqual(['p1']);
    expect(effectiveResultOf(result, anchor, false)).not.toHaveProperty('setBy');
    expect(effectiveResultOf(result, anchor, false).matched).toHaveLength(2);
  });
});
