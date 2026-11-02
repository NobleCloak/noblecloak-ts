// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ActionStatusState } from './action-status-types.js';
import recorded from './testing/fixtures/approval-status.fixture.json' with { type: 'json' };
import { useActionStatus } from './use-action-status.js';
import { parseFixture, replayFetch, stepOf } from './testing/approval-fixture.js';
import type { ApprovalFixture, FixtureStep, StepName } from './testing/approval-fixture.js';
import { consume, openAction, recordOutcome } from './testing/action-status-harness.js';
import { startHarness } from './testing/approvals-harness.js';
import type { Harness } from './testing/approvals-harness.js';

// Shape parity: the action-status hook, given what the hosted service recorded and given what the mock says now,
// produces the same view-model. The recording is `testing/fixtures/approval-status.fixture.json`, written by
// `tools/capture-hosted-fixtures.ts`. What a hosted service leaves out is listed below and asserted, not skipped.
// This is shape parity (same fields, same kinds, same states), not an identical rendering of identical values.

const fixture: ApprovalFixture = parseFixture(recorded);

/** What a hosted service does not send today, on the wire (contract rev 9 and the COO approval view). */
const HOSTED_ABSENT = ['on_deny', 'agent.name', 'agent.parent'] as const;
/** `run.kind` is not typed through on hosted: an external run is always `external`. */
const HOSTED_RUN_KIND = 'external';

type Wire = Record<string, unknown>;

const isObject = (value: unknown): value is Wire =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every approval object a step holds: the list rows, the single read and the stream frames. */
function approvalsOf(step: FixtureStep): Wire[] {
  const rows: unknown[] =
    isObject(step.list.body) && Array.isArray(step.list.body.data)
      ? (step.list.body.data as unknown[])
      : [];
  const detail = isObject(step.detail.body) ? step.detail.body.data : undefined;
  return [...rows, detail, ...step.stream.map((e) => e.data)].filter(isObject);
}

/** The ways `approval` is not hosted-shaped: a field of `HOSTED_ABSENT` it carries, or a run kind other than external. */
function hostedViolations(approval: Wire): string[] {
  const found: string[] = [];
  if ('on_deny' in approval) found.push('on_deny');
  const agent = approval.agent;
  if (isObject(agent)) {
    if ('name' in agent) found.push('agent.name');
    if ('parent' in agent) found.push('agent.parent');
  }
  const run = approval.run;
  if (isObject(run) && run.kind !== HOSTED_RUN_KIND) found.push('run.kind');
  return found;
}

/** `fixture` with the hosted-absent fields removed from every approval object, as a hosted service would have sent it. */
function asHosted(source: ApprovalFixture): ApprovalFixture {
  const without = (wire: Wire, keys: readonly string[]): Wire =>
    Object.fromEntries(Object.entries(wire).filter(([k]) => !keys.includes(k)));
  const strip = (approval: Wire): Wire => {
    const rest = without(approval, ['on_deny']);
    return isObject(rest.agent)
      ? { ...rest, agent: without(rest.agent, ['name', 'parent']) }
      : rest;
  };
  const reply = <T extends { body: unknown }>(r: T): T => {
    if (!isObject(r.body)) return r;
    const body = r.body;
    const data = Array.isArray(body.data)
      ? body.data.map((row: unknown) => (isObject(row) ? strip(row) : row))
      : isObject(body.data)
        ? strip(body.data)
        : body.data;
    return { ...r, body: { ...body, data } };
  };
  return {
    ...source,
    steps: source.steps.map((s) => ({
      ...s,
      list: reply(s.list),
      detail: reply(s.detail),
      stream: s.stream.map((e) => ({ ...e, data: strip(e.data) })),
    })),
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * The view-model as a shape: values that differ by deployment or by run (ids, times, counts) are kinds, and `onDeny`,
 * which the two differ on by design, is left out and asserted on its own.
 */
function shapeOf(view: ActionStatusState): unknown {
  if (view.status !== 'ready') return { status: view.status };
  const pendingOn = view.pendingOn;
  const outcome = view.outcome;
  return {
    status: view.status,
    state: view.state,
    since: ISO.test(view.since) ? '<iso>' : view.since,
    pendingOn:
      pendingOn === undefined
        ? undefined
        : pendingOn.kind === 'unknown'
          ? { kind: 'unknown' }
          : pendingOn.kind === 'count'
            ? { kind: 'count', count: typeof pendingOn.count }
            : {
                kind: 'principals',
                count: typeof pendingOn.count,
                principals: pendingOn.principals.map((p) => Object.keys(p).sort()),
              },
    outcome:
      outcome === undefined
        ? undefined
        : outcome.status === 'recorded'
          ? {
              status: 'recorded',
              result: outcome.result,
              recordId: typeof outcome.recordId,
              recordedAt: ISO.test(outcome.recordedAt) ? '<iso>' : outcome.recordedAt,
            }
          : outcome.status === 'unavailable'
            ? { status: 'unavailable', reason: outcome.reason }
            : { status: 'loading' },
    refreshing: view.refreshing,
    settled: view.settled,
  };
}

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(cleanup);
afterAll(async () => {
  await h.stop();
});

async function viewOf(
  approvalId: string,
  baseUrl: string,
  send: typeof fetch,
  token: string,
  until: (view: ActionStatusState) => boolean
): Promise<Extract<ActionStatusState, { status: 'ready' }>> {
  const { result } = renderHook(() =>
    useActionStatus(approvalId, {
      baseUrl,
      getToken: () => token,
      fetch: send,
      reconcileMs: 600_000,
    })
  );
  // Past the store's one-second list floor: a frame on creation (hosted sends one) is answered after it.
  await waitFor(
    () => {
      expect(until(result.current)).toBe(true);
    },
    { timeout: 5000 }
  );
  const view = result.current;
  if (view.status !== 'ready') throw new Error(`not ready: ${view.status}`);
  return view;
}

// Each wait also requires the view at rest (`!refreshing`): hosted sends an `approval.updated` on creation where the
// mock does not, and the refetch that frame starts must not decide the comparison.
const WAITS: Record<StepName, (view: ActionStatusState) => boolean> = {
  pending: (v) => v.status === 'ready' && v.state === 'pending' && !v.refreshing,
  consumed: (v) =>
    v.status === 'ready' &&
    v.state === 'consumed' &&
    v.outcome?.status === 'recorded' &&
    !v.refreshing,
};

/** The hook over the recording of `step`; with `transition`, the recorded stream frames move it on to that step. */
async function replayed(source: ApprovalFixture, step: FixtureStep, transition?: FixtureStep) {
  const replay = replayFetch(source, step, transition === undefined ? {} : { transition });
  const view = await viewOf(
    source.ids.approval,
    'https://recorded.test',
    replay.fetch,
    'tok',
    WAITS[(transition ?? step).name]
  );
  return { view, replay };
}

/** The hook over the mock, with the approval taken to the same point as the recording. */
async function live(name: StepName) {
  const opened = await openAction(h);
  if (name === 'consumed') {
    await consume(h, opened);
    await recordOutcome(h, opened);
  }
  return viewOf(opened.id, h.baseUrl, globalThis.fetch, h.tokens.creator, WAITS[name]);
}

describe('the recording', () => {
  it('is a readable fixture with a header that says where it came from', () => {
    expect(fixture.header.format).toBe(1);
    expect(['hosted', 'mock']).toContain(fixture.header.source);
    expect(fixture.header.capturedAt).toMatch(ISO);
    expect(fixture.header.serviceVersion).not.toBe('');
    expect(fixture.header.script).toBe('packages/react/tools/capture-hosted-fixtures.ts');
    expect(fixture.steps.map((s) => s.name)).toEqual(['pending', 'consumed']);
  });

  it('carries an agent and an external run on every approval, so the hosted-absent check reads real data', () => {
    for (const step of fixture.steps) {
      const approvals = approvalsOf(step);
      expect(approvals.length).toBeGreaterThan(0);
      for (const approval of approvals) {
        const { agent, run } = approval;
        expect(isObject(agent) && typeof agent.id === 'string').toBe(true);
        expect(isObject(run) && typeof run.id === 'string').toBe(true);
        expect(isObject(run) ? run.kind : undefined).toBe(HOSTED_RUN_KIND);
      }
    }
  });

  it('holds stream frames for the transition to consumed (an event on creation is allowed but not required)', () => {
    const frames = stepOf(fixture, 'consumed').stream;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((e) => e.event === 'approval.updated')).toBe(true);
    expect(frames.map((e) => e.data.state)).toContain('consumed');
  });

  it('is scrubbed: ids are placeholders and no token is left', () => {
    const text = JSON.stringify(fixture);
    expect(text).not.toMatch(/eyJ[\w-]+\.[\w-]+\./);
    // The signing key ids of the deployment are placeholders too.
    const capabilities = fixture.capabilities.body;
    const kids =
      isObject(capabilities) && isObject(capabilities.data) ? capabilities.data.kids : undefined;
    expect(Array.isArray(kids) && kids.length > 0).toBe(true);
    for (const kid of kids as unknown[]) expect(kid).toMatch(/^kid_FIXTURE_\d+$/);
    expect(fixture.ids.approval).toBe('apr_FIXTURE_1');
    for (const step of fixture.steps) {
      for (const approval of approvalsOf(step)) expect(approval.id).toBe(fixture.ids.approval);
    }
  });

  it.runIf(fixture.header.source === 'mock')(
    'is marked provisional while it is a capture of the mock',
    () => {
      expect(fixture.header.provisional).toBe(true);
      expect(fixture.header.note).toMatch(/replace it with a capture from beta/);
    }
  );

  it.runIf(fixture.header.source === 'hosted')(
    'is not marked provisional once it is a capture of hosted',
    () => {
      expect(fixture.header.provisional).toBeUndefined();
    }
  );

  it('is from a hosted service only when its wire is hosted-shaped', () => {
    const violations = fixture.steps.flatMap((s) => approvalsOf(s).flatMap(hostedViolations));
    if (fixture.header.source === 'hosted') expect(violations).toEqual([]);
    else
      expect(violations).toEqual(expect.arrayContaining(['on_deny', 'agent.name', 'agent.parent']));
  });
});

describe('what a hosted service leaves out', () => {
  const hosted = asHosted(fixture);

  it('names the fields, and the stripped recording carries none of them', () => {
    expect(HOSTED_ABSENT).toEqual(['on_deny', 'agent.name', 'agent.parent']);
    for (const step of hosted.steps) {
      const approvals = approvalsOf(step);
      expect(approvals.length).toBeGreaterThan(0);
      for (const approval of approvals) {
        // The agent and the run are present, so an empty violation list is a result and not an absence.
        expect(approval.agent).toBeDefined();
        expect(approval.run).toBeDefined();
        expect(hostedViolations(approval)).toEqual([]);
      }
    }
  });

  it('is found by the check: a recording that states on_deny, an agent name or a run kind is flagged', () => {
    expect(hostedViolations({ on_deny: 'resume' })).toEqual(['on_deny']);
    expect(hostedViolations({ agent: { id: 'a', name: 'n', parent: null } })).toEqual([
      'agent.name',
      'agent.parent',
    ]);
    expect(hostedViolations({ run: { id: 'r', kind: 'managed' } })).toEqual(['run.kind']);
    expect(hostedViolations({ agent: { id: 'a' }, run: { id: 'r', kind: 'external' } })).toEqual(
      []
    );
  });

  it('strips what it should: a recording that carries on_deny, an agent name and parent everywhere comes out hosted-shaped', () => {
    // A positive control: the recording is hosted, so stripping it proves nothing on its own. Put the fields into
    // every list row, single read and stream frame, and check they go and the rest stays.
    const add = (approval: unknown): unknown =>
      isObject(approval)
        ? {
            ...approval,
            on_deny: 'halt',
            agent: { ...(isObject(approval.agent) ? approval.agent : {}), name: 'n', parent: 'p' },
          }
        : approval;
    const reply = <T extends { body: unknown }>(r: T): T => {
      if (!isObject(r.body)) return r;
      const data: unknown = r.body.data;
      return { ...r, body: { ...r.body, data: Array.isArray(data) ? data.map(add) : add(data) } };
    };
    const stating: ApprovalFixture = {
      ...fixture,
      steps: fixture.steps.map((st) => ({
        ...st,
        list: reply(st.list),
        detail: reply(st.detail),
        stream: st.stream.map((e) => ({ ...e, data: add(e.data) as Wire })),
      })),
    };
    const sources = (f: ApprovalFixture) =>
      f.steps.flatMap((st) => [
        ...approvalsOf({ ...st, detail: { ...st.detail, body: undefined }, stream: [] }),
        ...approvalsOf({ ...st, list: { ...st.list, body: undefined }, stream: [] }),
        ...approvalsOf({
          ...st,
          list: { ...st.list, body: undefined },
          detail: { ...st.detail, body: undefined },
        }),
      ]);
    const before = sources(stating);
    // Each of the three places holds an approval somewhere in the recording, so each is stripped, not skipped.
    expect(fixture.steps.some((st) => st.stream.length > 0)).toBe(true);
    expect(before.length).toBe(sources(fixture).length);
    for (const approval of before) {
      expect(hostedViolations(approval)).toEqual(['on_deny', 'agent.name', 'agent.parent']);
    }
    const after = sources(asHosted(stating));
    expect(after.length).toBe(before.length);
    for (const approval of after) expect(hostedViolations(approval)).toEqual([]);
    // Only those fields go: the rest of each approval, the agent's id included, is as it was.
    expect(after).toEqual(sources(asHosted(fixture)));
  });

  it('is shown to the hook as not stated, and the recording as it is gives what it states', async () => {
    const step = stepOf(fixture, 'pending');
    const raw = (await replayed(fixture, step)).view.onDeny;
    const stripped = (await replayed(hosted, stepOf(hosted, 'pending'))).view.onDeny;
    expect(stripped).toBe('not_stated');
    expect(raw).toBe(fixture.header.source === 'hosted' ? 'not_stated' : 'resume');
  });
});

describe('the hook gives the same view-model from the recording and from the mock', () => {
  for (const step of fixture.steps) {
    it(`at ${step.name}: from what the service recorded`, async () => {
      const { view, replay } = await replayed(
        asHosted(fixture),
        stepOf(asHosted(fixture), step.name)
      );
      const mock = await live(step.name);
      expect(shapeOf(view)).toEqual(shapeOf(mock));
      expect(replay.unexpected).toEqual([]);
      // Both stopped waiting for a change at the same point.
      expect(view.settled).toBe(mock.settled);
    });
  }

  it('would tell a difference: a recording that states another state is not the mock', async () => {
    const pending = stepOf(fixture, 'pending');
    const { view } = await replayed(fixture, pending);
    const consumed = await live('consumed');
    expect(shapeOf(view)).not.toEqual(shapeOf(consumed));
  });

  it('moves from pending to consumed when the recorded stream frames arrive, as the mock does', async () => {
    const hosted = asHosted(fixture);
    const { view, replay } = await replayed(
      hosted,
      stepOf(hosted, 'pending'),
      stepOf(hosted, 'consumed')
    );
    // The reads said pending until the frames arrived: only a frame the hook recognises made it read again.
    expect(view.state).toBe('consumed');
    expect(shapeOf(view)).toEqual(shapeOf(await live('consumed')));
    expect(replay.unexpected).toEqual([]);
    expect(replay.calls).toContain(`GET /v1/records/${hosted.ids.record ?? ''}`);
  });

  it('shows a consumed approval its outcome the way the mock does', async () => {
    const { view } = await replayed(asHosted(fixture), stepOf(asHosted(fixture), 'consumed'));
    expect(view.outcome).toMatchObject({ status: 'recorded', result: 'succeeded' });
    expect(view.settled).toBe(true);
  });
});
