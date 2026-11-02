import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ActionStatusState } from './action-status-types.js';
import {
  TOOL_WITHOUT_ON_DENY,
  TOOL_WITH_ON_DENY,
  consume,
  decide,
  openAction,
  recordOutcome,
  untilStatus,
  watch,
} from './testing/action-status-harness.js';
import type { Watched } from './testing/action-status-harness.js';
import {
  call,
  jsonResponse,
  problemResponse,
  recorder,
  startHarness,
} from './testing/approvals-harness.js';
import type { Harness } from './testing/approvals-harness.js';

// The status of one approval as its creator sees it, proved against the mock that vendors contract rev 9:
// every state, `on_deny` present and absent, a service-principal creator (a count of approvers only), and a
// consumed approval with and without an outcome record.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

let open: Watched[] = [];
afterEach(() => {
  for (const w of open) w.close();
  open = [];
});

const creator = (id: string, extra: Partial<Parameters<typeof watch>[1]> = {}): Watched => {
  const w = watch(id, { baseUrl: h.baseUrl, getToken: () => h.tokens.creator, ...extra });
  open.push(w);
  return w;
};

const ready = (s: ActionStatusState): Extract<ActionStatusState, { status: 'ready' }> => {
  if (s.status !== 'ready') throw new Error(`not ready: ${s.status}`);
  return s;
};

describe('a pending approval', () => {
  it('goes loading, then pending since its creation, with only a count of approvers for a service principal', async () => {
    const a = await openAction(h);
    const w = creator(a.id);
    expect(w.store.getSnapshot()).toEqual({ approvalId: a.id, status: 'loading' });
    const s = ready(await untilStatus(w.store, (x) => x.status === 'ready'));
    expect(s.state).toBe('pending');
    expect(Number.isNaN(Date.parse(s.since))).toBe(false);
    expect(s.settled).toBe(false);
    expect(s.refreshing).toBe(false);
    // Contract rev 6: the creator is a service principal, so `waiting_on` has the count and no principals.
    expect(s.pendingOn?.kind).toBe('count');
    expect(s.pendingOn !== undefined && 'principals' in s.pendingOn).toBe(false);
    expect(s.outcome).toBeUndefined();
  });

  it('states what a denial does when the policy that matched states it (rev 9)', async () => {
    const a = await openAction(h, TOOL_WITH_ON_DENY);
    const w = creator(a.id);
    expect(ready(await untilStatus(w.store, (x) => x.status === 'ready')).onDeny).toBe('resume');
  });

  it('says "not stated" when the matching policy states nothing, and never guesses', async () => {
    const a = await openAction(h, TOOL_WITHOUT_ON_DENY);
    const w = creator(a.id);
    expect(ready(await untilStatus(w.store, (x) => x.status === 'ready')).onDeny).toBe(
      'not_stated'
    );
  });

  it('reads the single route, opens the stream and the list for the creator only, and never asks for an approver view', async () => {
    const a = await openAction(h);
    const rec = recorder();
    const w = creator(a.id, { fetch: rec.fetch });
    await untilStatus(w.store, (x) => x.status === 'ready');
    await untilStatus(w.store, () => rec.calls.some((c) => c.path === '/v1/approvals/stream'));
    const stream = rec.calls.find((c) => c.path === '/v1/approvals/stream');
    expect(new URLSearchParams(stream?.query).get('created_by')).toBe('me');
    expect(new URLSearchParams(stream?.query).has('approver')).toBe(false);
    const list = rec.calls.find((c) => c.method === 'GET' && c.path === '/v1/approvals');
    if (list !== undefined) {
      expect(new URLSearchParams(list.query).get('created_by')).toBe('me');
      expect(new URLSearchParams(list.query).has('approver')).toBe(false);
    }
    expect(rec.count('GET', `/v1/approvals/${a.id}`)).toBe(1);
  });
});

describe('the states after a decision', () => {
  it('shows approved and keeps listening, because an approval is not used until it is consumed', async () => {
    const a = await openAction(h);
    const w = creator(a.id);
    await untilStatus(w.store, (x) => x.status === 'ready');
    await decide(h, a, 'approve');
    const s = ready(
      await untilStatus(w.store, (x) => x.status === 'ready' && x.state === 'approved')
    );
    expect(s.pendingOn).toBeUndefined();
    expect(s.settled).toBe(false);
    expect(s.outcome).toBeUndefined();
  });

  it('shows denied (rejected) and settles', async () => {
    const a = await openAction(h);
    const w = creator(a.id);
    await untilStatus(w.store, (x) => x.status === 'ready');
    await decide(h, a, 'deny');
    const s = ready(
      await untilStatus(w.store, (x) => x.status === 'ready' && x.state === 'rejected')
    );
    expect(s.settled).toBe(true);
    expect(s.pendingOn).toBeUndefined();
    expect(s.onDeny).toBe('resume');
  });

  it('shows withdrawn and settles', async () => {
    const a = await openAction(h);
    const w = creator(a.id);
    await untilStatus(w.store, (x) => x.status === 'ready');
    const response = await call(
      h.baseUrl,
      h.tokens.creator,
      'POST',
      `/v1/approvals/${a.id}/withdraw`
    );
    expect(response.status).toBe(200);
    const s = ready(
      await untilStatus(w.store, (x) => x.status === 'ready' && x.state === 'withdrawn')
    );
    expect(s.settled).toBe(true);
  });

  it('reads an approval that is already decided when it opens', async () => {
    const a = await openAction(h);
    await decide(h, a, 'deny');
    const w = creator(a.id);
    const s = ready(await untilStatus(w.store, (x) => x.status === 'ready'));
    expect([s.state, s.settled]).toEqual(['rejected', true]);
  });

  it('stops the stream and the polls once settled: nothing is requested afterwards', async () => {
    const a = await openAction(h);
    await decide(h, a, 'deny');
    const rec = recorder();
    const w = creator(a.id, { fetch: rec.fetch, pollMs: 1000 });
    await untilStatus(w.store, (x) => x.status === 'ready' && x.settled);
    // Let the detach (a microtask after the status) and any request already on its way finish.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = rec.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(rec.calls.length).toBe(before);
    expect(w.store.getSnapshot().status).toBe('ready');
  });
});

describe("waiting_on is the single read's alone", () => {
  it('reads the detail again when a stream event names this approval, and not for another approval', async () => {
    const mine = await openAction(h);
    const other = await openAction(h);
    const rec = recorder();
    const w = creator(mine.id, { fetch: rec.fetch });
    await untilStatus(w.store, (x) => x.status === 'ready');
    await untilStatus(w.store, () => rec.calls.some((c) => c.path === '/v1/approvals/stream'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(rec.count('GET', `/v1/approvals/${mine.id}`)).toBe(1);

    // An update to another approval of the same creator is on the stream, and is not this one's change.
    const escalateOther = await call(
      h.baseUrl,
      h.tokens.creator_user,
      'POST',
      `/v1/approvals/${other.id}/resolve`,
      {
        resolution: 'escalated',
        expected_action_digest: other.digest,
      }
    );
    expect(escalateOther.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(rec.count('GET', `/v1/approvals/${mine.id}`)).toBe(1);

    // An update to this one is: one more read of the detail.
    const escalate = await call(
      h.baseUrl,
      h.tokens.creator_user,
      'POST',
      `/v1/approvals/${mine.id}/resolve`,
      {
        resolution: 'escalated',
        expected_action_digest: mine.digest,
      }
    );
    expect(escalate.status).toBe(200);
    await untilStatus(w.store, () => rec.count('GET', `/v1/approvals/${mine.id}`) >= 2);
    const s = ready(await untilStatus(w.store, (x) => x.status === 'ready' && !x.refreshing));
    expect(s.state).toBe('pending');
  });

  it('does not read the detail again for the event that decides it: the event carries the new state', async () => {
    const a = await openAction(h);
    const rec = recorder();
    const w = creator(a.id, { fetch: rec.fetch });
    await untilStatus(w.store, (x) => x.status === 'ready');
    await untilStatus(w.store, () => rec.calls.some((c) => c.path === '/v1/approvals/stream'));
    await decide(h, a, 'deny');
    await untilStatus(w.store, (x) => x.status === 'ready' && x.state === 'rejected');
    expect(rec.count('GET', `/v1/approvals/${a.id}`)).toBe(1);
  });
});

describe('a consumed approval', () => {
  it("shows the record's id, its outcome and when it was recorded, and nothing else of the record", async () => {
    const a = await openAction(h);
    await consume(h, a);
    const recordId = await recordOutcome(h, a, 'failed');
    const w = creator(a.id);
    const s = ready(
      await untilStatus(w.store, (x) => x.status === 'ready' && x.outcome?.status === 'recorded')
    );
    expect(s.state).toBe('consumed');
    expect(s.settled).toBe(true);
    expect(s.outcome).toEqual({
      status: 'recorded',
      recordId,
      result: 'failed',
      recordedAt: expect.any(String) as string,
    });
    expect(Object.keys(s.outcome ?? {}).sort()).toEqual([
      'recordId',
      'recordedAt',
      'result',
      'status',
    ]);
  });

  it('reports a succeeded outcome the same way', async () => {
    const a = await openAction(h);
    await consume(h, a);
    await recordOutcome(h, a, 'succeeded');
    const w = creator(a.id);
    const s = ready(
      await untilStatus(w.store, (x) => x.status === 'ready' && x.outcome?.status === 'recorded')
    );
    expect(s.outcome).toMatchObject({ status: 'recorded', result: 'succeeded' });
  });

  it('says "outcome not available" with the reason class when the approval names no record, and keeps listening', async () => {
    const a = await openAction(h);
    await consume(h, a);
    const rec = recorder();
    const w = creator(a.id, { fetch: rec.fetch });
    const s = ready(
      await untilStatus(w.store, (x) => x.status === 'ready' && x.state === 'consumed')
    );
    expect(s.outcome).toEqual({ status: 'unavailable', reason: 'no_record' });
    expect(s.settled).toBe(false);
    expect(rec.count('GET', /^\/v1\/records\//)).toBe(0);
  });

  it('finds the record when it is linked later, on the next list read', async () => {
    const a = await openAction(h);
    await consume(h, a);
    const rec = recorder();
    const w = creator(a.id, { fetch: rec.fetch, reconcileMs: 5000 });
    await untilStatus(w.store, (x) => x.status === 'ready' && x.state === 'consumed');
    // The list read on connect has come and gone: nothing is linked yet, and the next read is the reconcile.
    await untilStatus(w.store, () => rec.count('GET', '/v1/approvals') >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ready(w.store.getSnapshot()).outcome).toEqual({
      status: 'unavailable',
      reason: 'no_record',
    });
    const recordId = await recordOutcome(h, a);
    const s = await untilStatus(
      w.store,
      (x) => x.status === 'ready' && x.outcome?.status === 'recorded',
      12_000
    );
    expect(ready(s).outcome).toMatchObject({ recordId });
    expect(ready(s).settled).toBe(true);
  }, 20_000);

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [503, 'unavailable'],
  ] as const)(
    'says the outcome is not available (%s: %s) when the record read fails',
    async (status, reason) => {
      const a = await openAction(h);
      await consume(h, a);
      const recordId = await recordOutcome(h, a);
      const rec = recorder();
      rec.intercept((c) =>
        c.path === `/v1/records/${recordId}` ? problemResponse(status, `t_${reason}`) : undefined
      );
      const w = creator(a.id, { fetch: rec.fetch });
      const s = ready(
        await untilStatus(
          w.store,
          (x) => x.status === 'ready' && x.outcome?.status === 'unavailable'
        )
      );
      expect(s.state).toBe('consumed');
      expect(s.outcome).toEqual({
        status: 'unavailable',
        reason,
        recordId,
        error: expect.objectContaining({ status }) as unknown,
      });
    }
  );

  it('reads the record again on retry, after a failed read', async () => {
    const a = await openAction(h);
    await consume(h, a);
    const recordId = await recordOutcome(h, a);
    const rec = recorder();
    rec.intercept((c) =>
      c.path === `/v1/records/${recordId}` ? problemResponse(503, 'down') : undefined
    );
    const w = creator(a.id, { fetch: rec.fetch });
    await untilStatus(w.store, (x) => x.status === 'ready' && x.outcome?.status === 'unavailable');
    rec.intercept(undefined);
    w.store.retry();
    const s = ready(
      await untilStatus(w.store, (x) => x.status === 'ready' && x.outcome?.status === 'recorded')
    );
    expect(s.outcome).toMatchObject({ recordId, result: 'succeeded' });
  });

  it('treats a record that is not the named one as malformed, and reports it', async () => {
    const a = await openAction(h);
    await consume(h, a);
    const recordId = await recordOutcome(h, a);
    const rec = recorder();
    rec.intercept((c) =>
      c.path === `/v1/records/${recordId}`
        ? jsonResponse({ data: { id: 'rec_other', ts: '2026-10-05T00:00:00.000Z' } })
        : undefined
    );
    const onFault = vi.fn();
    const w = creator(a.id, { fetch: rec.fetch, onFault });
    const s = ready(
      await untilStatus(w.store, (x) => x.status === 'ready' && x.outcome?.status === 'unavailable')
    );
    expect(s.outcome).toMatchObject({ status: 'unavailable', reason: 'malformed', recordId });
    expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: 'malformed_response' }));
  });
});

describe('who may read it', () => {
  it('answers not_found to a service principal that did not create the approval', async () => {
    const a = await openAction(h);
    const w = watch(a.id, {
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.other_service,
      reconcileMs: 600_000,
    });
    open.push(w);
    const s = await untilStatus(w.store, (x) => x.status !== 'loading');
    expect(s).toEqual({ approvalId: a.id, status: 'not_found' });
  });

  it("shows the user creator's read of an approval it did not create without the creator-only members", async () => {
    const a = await openAction(h);
    const w = watch(a.id, {
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.member,
      reconcileMs: 600_000,
    });
    open.push(w);
    const s = ready(await untilStatus(w.store, (x) => x.status === 'ready'));
    // Not the creator: no waiting_on and no on_deny, so the view says unknown and not stated, never nobody and never a guess.
    expect(s.pendingOn).toEqual({ kind: 'unknown' });
    expect(s.onDeny).toBe('not_stated');
  });
});

describe('an approval that expires', () => {
  it('shows expired from the mock clock, with the time it was created, and settles', async () => {
    // Its own mock: advancing the clock must not move the one the other tests share.
    const own = await startHarness();
    const a = await openAction(own);
    const advanced = await fetch(`${own.baseUrl}/__mock/advance`, {
      method: 'POST',
      body: JSON.stringify({ seconds: 2 * 3600 }),
    });
    expect(advanced.status).toBe(200);
    const w = watch(a.id, { baseUrl: own.baseUrl, getToken: () => own.tokens.creator });
    try {
      const s = ready(await untilStatus(w.store, (x) => x.status === 'ready'));
      expect([s.state, s.settled]).toEqual(['expired', true]);
      expect(s.pendingOn).toBeUndefined();
    } finally {
      w.close();
      await own.stop();
    }
  });
});
