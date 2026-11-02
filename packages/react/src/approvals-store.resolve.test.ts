import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { advance, advanceUntil, fakeTime } from './testing/approvals-fake-time.js';
import {
  call,
  failNextIn,
  inProcessFetch,
  ids,
  live,
  openApproval,
  openLoaded,
  recorder,
  startHarness,
  until,
} from './testing/approvals-harness.js';
import type { Harness } from './testing/approvals-harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

const approverLive = (
  extra: Parameters<typeof live>[0] extends infer O ? Partial<O> : never = {}
) =>
  live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, reconcileMs: 600_000, ...extra });

describe('T3 approve, end to end', () => {
  it('answers 200, the row leaves, and the creator reads the Resumption', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const l = approverLive();
    try {
      await until(l.store, (s) => ids(s.approvals).includes(opened.id));
      await openLoaded(l.store, opened.id);
      const result = await l.store.approve(opened.id);
      expect(result).toMatchObject({ ok: true, approval: { id: opened.id, state: 'approved' } });
      expect(ids(l.snapshot().approvals)).not.toContain(opened.id);
      expect(l.snapshot().detail).toMatchObject({ id: opened.id, status: 'resolved' });
      const resumption = await call(
        h.baseUrl,
        h.tokens.creator,
        'GET',
        `/v1/approvals/${opened.id}/resumption`
      );
      expect(resumption.status).toBe(200);
    } finally {
      l.close();
    }
  });
});

describe('T4 deny with a reason', () => {
  it('rejects, and the history carries the reason', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    try {
      await until(l.store, (s) => ids(s.approvals).includes(opened.id));
      await openLoaded(l.store, opened.id);
      const result = await l.store.deny(opened.id, { reason: 'not today' });
      expect(result).toMatchObject({ ok: true, approval: { state: 'rejected' } });
      const post = rec.calls.find((c) => c.method === 'POST');
      expect(post?.path).toBe(`/v1/approvals/${opened.id}/resolve`);
      expect(post?.body).toMatchObject({ resolution: 'rejected', reason: 'not today' });
      const read = (await (
        await call(h.baseUrl, h.tokens.approver, 'GET', `/v1/approvals/${opened.id}`)
      ).json()) as { data: { resolution_history?: { reason?: string }[] } };
      expect(read.data.resolution_history?.[0]?.reason).toBe('not today');
    } finally {
      l.close();
    }
  });

  it('leaves the reason out when it is empty', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    try {
      await openLoaded(l.store, opened.id);
      await l.store.approve(opened.id, { reason: '' });
      const post = rec.calls.find((c) => c.method === 'POST');
      expect(post?.body).toEqual({ resolution: 'approved', expected_action_digest: opened.digest });
    } finally {
      l.close();
    }
  });
});

describe('T5 a stale digest', () => {
  it('is conflict/approval_conflict with the approval as re-read in current, row kept', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const other = await openApproval(h.baseUrl, h.tokens.creator);
    const l = approverLive();
    try {
      await until(l.store, (s) => ids(s.approvals).includes(opened.id));
      await openLoaded(l.store, opened.id);
      const result = await l.store.resolve(opened.id, {
        resolution: 'approved',
        expectedActionDigest: other.digest,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        kind: 'conflict',
        code: 'approval_conflict',
        status: 409,
      });
      if (result.error.kind !== 'conflict') return;
      expect(result.error.current).toMatchObject({ id: opened.id, state: 'pending' });
      expect('arguments' in (result.error.current ?? {})).toBe(false);
      expect(ids(l.snapshot().approvals)).toContain(opened.id);
      // The detail was re-read by the 409 and is loaded again, so a later approve goes to the network.
      expect(l.snapshot().detail?.status).toBe('loaded');
      expect((await l.store.approve(opened.id)).ok).toBe(true);
    } finally {
      l.close();
    }
  });
});

describe('T6 two approvers race', () => {
  it('gives one 200 and one already_resolved with the winner in current', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const second = await h.mock.issuer.mint({
      sub: 'user_second_approver',
      org: 'org_mock',
      aud: h.mock.config.audience,
      exp: Math.floor(Date.now() / 1000) + 3600,
      principal_kind: 'user',
      scope: 'approvals:resolve',
    });
    const a = approverLive();
    const b = live({ baseUrl: h.baseUrl, getToken: () => second, reconcileMs: 600_000 });
    try {
      await Promise.all([openLoaded(a.store, opened.id), openLoaded(b.store, opened.id)]);
      const [x, y] = await Promise.all([a.store.approve(opened.id), b.store.approve(opened.id)]);
      const results = [x, y];
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const loser = results.find((r) => !r.ok);
      expect(loser).toMatchObject({
        ok: false,
        error: {
          kind: 'conflict',
          code: 'already_resolved',
          current: { id: opened.id, state: 'approved' },
        },
      });
      // The loser's queue and detail follow the winner.
      for (const l of [a, b]) {
        expect(ids(l.snapshot().approvals)).not.toContain(opened.id);
        expect(l.snapshot().detail).toMatchObject({ id: opened.id, status: 'resolved' });
      }
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('a 409 whose re-read is overtaken by the stream', () => {
  it('still reports the approval as it is now in current', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    try {
      await until(l.store, (s) => s.connection === 'live');
      await openLoaded(l.store, opened.id);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      rec.intercept(async (c, request) => {
        if (c.method === 'POST') {
          return new Response(
            JSON.stringify({
              type: 'https://x/problems/approval_conflict',
              title: 'Conflict',
              status: 409,
            }),
            { status: 409, headers: { 'content-type': 'application/problem+json' } }
          );
        }
        if (c.path !== `/v1/approvals/${opened.id}`) return undefined;
        // The 409's re-read is held while someone else decides the approval and the event arrives.
        await gate;
        return fetch(request);
      });
      const pending = l.store.approve(opened.id);
      await until(l.store, (s) => s.detail?.status === 'refreshing');
      await call(h.baseUrl, h.tokens.approver, 'POST', `/v1/approvals/${opened.id}/resolve`, {
        resolution: 'approved',
        expected_action_digest: opened.digest,
      });
      await until(l.store, (s) => s.detail?.status === 'resolved');
      release();
      expect(await pending).toMatchObject({
        ok: false,
        error: { kind: 'conflict', current: { id: opened.id, state: 'approved' } },
      });
    } finally {
      l.close();
    }
  });
});

describe('T7 a creator that is a user', () => {
  it('can read its own approval but is refused the resolve: forbidden/not_eligible, also through resolve()', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator_user);
    const l = live({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.creator_user,
      reconcileMs: 600_000,
    });
    try {
      await openLoaded(l.store, opened.id);
      const viaApprove = await l.store.approve(opened.id);
      expect(viaApprove).toMatchObject({
        ok: false,
        error: { kind: 'forbidden', code: 'not_eligible', status: 403 },
      });
      // Suppressed for 30 seconds, but the detail is still the read's: a second try reaches the network.
      const viaResolve = await l.store.resolve(opened.id, { resolution: 'rejected' });
      expect(viaResolve).toMatchObject({
        ok: false,
        error: { kind: 'forbidden', code: 'not_eligible' },
      });
    } finally {
      l.close();
    }
  });

  it('is not retried automatically', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator_user);
    fakeTime();
    const rec = recorder(inProcessFetch(h.mock));
    const l = live({ baseUrl: h.baseUrl, getToken: () => h.tokens.creator_user, fetch: rec.fetch });
    try {
      l.store.openDetail(opened.id);
      await advanceUntil(() => l.snapshot().detail?.status === 'loaded');
      await l.store.approve(opened.id);
      await advance(1500);
      expect(rec.count('POST', `/v1/approvals/${opened.id}/resolve`)).toBe(1);
    } finally {
      l.close();
      vi.useRealTimers();
    }
  });
});

describe('T8 a service principal as the module token', () => {
  it("reads what it created, is refused the resolve, and gets 404 for another service's approval", async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const svc = live({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.creator,
      reconcileMs: 600_000,
    });
    const other = live({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.other_service,
      reconcileMs: 600_000,
    });
    try {
      await openLoaded(svc.store, opened.id);
      expect(await svc.store.approve(opened.id)).toMatchObject({
        ok: false,
        error: { kind: 'forbidden', code: 'not_eligible' },
      });
      other.store.openDetail(opened.id);
      const seen = await until(other.store, (s) => s.detail?.status === 'not_found');
      expect(seen.detail).toEqual({ id: opened.id, status: 'not_found' });
    } finally {
      svc.close();
      other.close();
    }
  });
});

describe('T13, T15 one in flight per id', () => {
  it('sends one POST for two synchronous approves, and both get the same result', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    try {
      await openLoaded(l.store, opened.id);
      const first = l.store.approve(opened.id);
      const second = l.store.approve(opened.id, { reason: 'a different reason is dropped' });
      expect(l.snapshot().resolving.has(opened.id)).toBe(true);
      expect(second).toBe(first);
      const [x, y] = await Promise.all([first, second]);
      expect(x).toEqual(y);
      expect(x.ok).toBe(true);
      expect(rec.count('POST', /resolve$/)).toBe(1);
      expect(rec.calls.find((c) => c.method === 'POST')?.body).not.toHaveProperty('reason');
      expect(l.snapshot().resolving.size).toBe(0);
    } finally {
      l.close();
    }
  });

  it("answers a different resolution while one runs with resolve_in_flight, never the first's result", async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    try {
      await openLoaded(l.store, opened.id);
      const approve = l.store.approve(opened.id);
      const deny = l.store.deny(opened.id);
      const denied = await deny;
      expect(denied).toMatchObject({
        ok: false,
        error: { kind: 'conflict', code: 'resolve_in_flight', local: true },
      });
      expect(denied.ok ? undefined : denied.error.status).toBeUndefined();
      const approved = await approve;
      expect(approved).toMatchObject({ ok: true, approval: { state: 'approved' } });
      expect(rec.count('POST', /resolve$/)).toBe(1);
    } finally {
      l.close();
    }
  });
});

describe('T14 a tombstoned id', () => {
  it('is answered locally as already_resolved, with no request and no detail read', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    try {
      await until(l.store, (s) => ids(s.approvals).includes(opened.id) && s.connection === 'live');
      // Someone else decides it: the stream event tombstones the id here.
      await call(h.baseUrl, h.tokens.approver, 'POST', `/v1/approvals/${opened.id}/resolve`, {
        resolution: 'approved',
        expected_action_digest: opened.digest,
      });
      await until(l.store, (s) => !ids(s.approvals).includes(opened.id));
      const posts = rec.count('POST', /resolve$/);
      const reads = rec.count('GET', `/v1/approvals/${opened.id}`);
      const result = await l.store.approve(opened.id);
      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'conflict', code: 'already_resolved', local: true },
      });
      expect(rec.count('POST', /resolve$/)).toBe(posts);
      expect(rec.count('GET', `/v1/approvals/${opened.id}`)).toBe(reads);
    } finally {
      l.close();
    }
  });
});

describe('failures of a resolve', () => {
  it('keeps the row and says unavailable on a 503, with no automatic retry; a second try may succeed (T27)', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    // The "no automatic retry" wait runs on fake time against the in-process mock.
    fakeTime();
    const rec = recorder(inProcessFetch(h.mock));
    const l = approverLive({ fetch: rec.fetch });
    try {
      await advanceUntil(() => ids(l.snapshot().approvals).includes(opened.id));
      l.store.openDetail(opened.id);
      await advanceUntil(() => l.snapshot().detail?.status === 'loaded');
      await failNextIn(h.mock, h.tokens.approver, 'resolveApproval', 503);
      const failed = await l.store.approve(opened.id);
      expect(failed).toMatchObject({ ok: false, error: { kind: 'unavailable', status: 503 } });
      expect(ids(l.snapshot().approvals)).toContain(opened.id);
      expect(l.snapshot().detail?.status).toBe('loaded');
      await advance(1500);
      expect(rec.count('POST', /resolve$/)).toBe(1);
      expect((await l.store.approve(opened.id)).ok).toBe(true);
    } finally {
      l.close();
      vi.useRealTimers();
    }
  });

  it('keeps the row on a 429 and on a network failure', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    try {
      await until(l.store, (s) => ids(s.approvals).includes(opened.id));
      await openLoaded(l.store, opened.id);
      rec.intercept((c) =>
        c.method === 'POST'
          ? new Response(
              JSON.stringify({
                type: 'https://x/problems/rate_limited',
                title: 'Slow',
                status: 429,
              }),
              {
                status: 429,
                headers: { 'content-type': 'application/problem+json' },
              }
            )
          : undefined
      );
      expect(await l.store.approve(opened.id)).toMatchObject({
        ok: false,
        error: { kind: 'rate_limited' },
      });
      rec.intercept((c) => {
        if (c.method === 'POST') throw new TypeError('Failed to fetch');
        return undefined;
      });
      expect(await l.store.approve(opened.id)).toMatchObject({
        ok: false,
        error: { kind: 'network' },
      });
      expect(ids(l.snapshot().approvals)).toContain(opened.id);
    } finally {
      l.close();
    }
  });

  it('follows the 401 rule: one forced refresh and one retry, and then the session ends', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    // The stream's connect queues a re-list behind the 1 s list floor. If it landed after `bad = true` it would
    // take a forced refresh of its own and the count would read 2 or more. So the test settles the store first
    // (stream live, past the floor, no request in flight) and only then flips the token.
    fakeTime();
    let bad = false;
    let inFlight = 0;
    const inProcess = inProcessFetch(h.mock);
    const tracked: typeof fetch = async (input, init) => {
      inFlight += 1;
      try {
        return await inProcess(input, init);
      } finally {
        inFlight -= 1;
      }
    };
    const forced = vi.fn();
    const onExpired = vi.fn();
    const l = live({
      baseUrl: h.baseUrl,
      getToken: (x) => {
        if (x?.forceRefresh === true) forced();
        return bad ? h.tokens.expired : h.tokens.approver;
      },
      fetch: tracked,
      reconcileMs: 600_000,
      onSessionExpired: onExpired,
    });
    try {
      l.store.openDetail(opened.id);
      await advanceUntil(() => l.snapshot().detail?.status === 'loaded');
      await advanceUntil(() => l.snapshot().connection === 'live');
      await advance(1500);
      await advanceUntil(() => inFlight === 0);
      expect(forced).toHaveBeenCalledTimes(0);
      bad = true;
      const result = await l.store.approve(opened.id);
      expect(result).toMatchObject({ ok: false, error: { kind: 'unauthorized' } });
      expect(forced).toHaveBeenCalledTimes(1);
      expect(onExpired).toHaveBeenCalledTimes(1);
      expect(l.snapshot()).toMatchObject({ status: 'error', connection: 'offline' });
    } finally {
      l.close();
      vi.useRealTimers();
    }
  });

  it('reports an answer it cannot read as malformed and keeps the row', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const l = approverLive({ fetch: rec.fetch });
    try {
      await until(l.store, (s) => ids(s.approvals).includes(opened.id));
      await openLoaded(l.store, opened.id);
      rec.intercept((c) => (c.method === 'POST' ? new Response('ok', { status: 200 }) : undefined));
      expect(await l.store.approve(opened.id)).toMatchObject({
        ok: false,
        error: { kind: 'malformed_response' },
      });
      expect(ids(l.snapshot().approvals)).toContain(opened.id);
    } finally {
      l.close();
    }
  });
});
