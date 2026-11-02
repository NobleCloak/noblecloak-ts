import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  call,
  ids,
  live,
  openApproval,
  problemResponse,
  recorder,
  startHarness,
  toolHidingArguments,
  until,
} from './testing/approvals-harness.js';
import type { Harness, Live } from './testing/approvals-harness.js';

// A service that implements contract rev 5 only, made from the rev 6 mock: the members rev 6 added are removed
// from every JSON reply, and the rev 6 routes and query forms answer as a rev 5 service would (400, or 404 for
// the batch route). The mock has no rev 5 mode of its own, so this wrapper is the test's rev 5 service.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

let open: Live[] = [];
afterEach(() => {
  for (const l of open) l.close();
  open = [];
});

const REV6_MEMBERS = ['requester', 'arguments_state', 'waiting_on', 'display_name'];
const strip = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(strip);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !REV6_MEMBERS.includes(key))
      .map(([key, member]) => [key, strip(member)])
  );
};

const rev5Fetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  if (url.pathname === '/v1/approvals/resolve/batch') return problemResponse(404, 'not_found');
  if (url.pathname === '/v1/approvals/stream' && url.searchParams.has('approver'))
    return problemResponse(400, 'invalid_request');
  if (url.pathname === '/v1/approvals' && (url.searchParams.has('order') || state.includes(',')))
    return problemResponse(400, 'invalid_request');
  const response = await globalThis.fetch(request);
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  const body: unknown = await response.json();
  return new Response(JSON.stringify(strip(body)), {
    status: response.status,
    headers: response.headers,
  });
};

const rev5Live = (): { l: Live; rec: ReturnType<typeof recorder> } => {
  const rec = recorder(rev5Fetch);
  const l = live({
    baseUrl: h.baseUrl,
    getToken: () => h.tokens.approver,
    reconcileMs: 600_000,
    fetch: rec.fetch,
  });
  open.push(l);
  return { l, rec };
};

describe('against a service that implements rev 5 only', () => {
  it('lists the queue with no rev 6 member, and still approves one request it has read', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const { l } = rev5Live();
    await until(l.store, (s) => s.status === 'ready' && ids(s.approvals).includes(opened.id));
    const row = l.snapshot().approvals.find((r) => r.id === opened.id);
    expect(row?.requester).toBeUndefined();
    expect(row?.arguments_state).toBeUndefined();
    l.store.openDetail(opened.id);
    await until(l.store, (s) => s.detail?.status === 'loaded');
    const result = await l.store.approve(opened.id);
    expect(result.ok).toBe(true);
  });

  it('denies one request it has read', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const { l } = rev5Live();
    await until(l.store, (s) => ids(s.approvals).includes(opened.id));
    l.store.openDetail(opened.id);
    await until(l.store, (s) => s.detail?.status === 'loaded');
    expect((await l.store.deny(opened.id)).ok).toBe(true);
  });

  it('approves nothing in a batch (no row says its arguments are not shown), and sends no batch request', async () => {
    const tool = await toolHidingArguments(h.baseUrl);
    const opened = await openApproval(h.baseUrl, h.tokens.creator, { tool });
    const { l, rec } = rev5Live();
    await until(l.store, (s) => ids(s.approvals).includes(opened.id));
    const result = await l.store.approveMany([opened.id], new Map([[opened.id, opened.digest]]));
    expect(result).toMatchObject({
      ok: true,
      results: [{ ok: false, error: { kind: 'precondition' } }],
    });
    expect(rec.calls.filter((c) => c.path === '/v1/approvals/resolve/batch')).toHaveLength(0);
    const still = await call(h.baseUrl, h.tokens.approver, 'GET', `/v1/approvals/${opened.id}`);
    expect(((await still.json()) as { data: { state: string } }).data.state).toBe('pending');
  });

  it('shows the recently resolved view as an error when the service refuses it, and leaves the queue as it was', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const { l } = rev5Live();
    await until(l.store, (s) => ids(s.approvals).includes(opened.id));
    await l.store.loadRecent();
    const snap = l.snapshot();
    expect(snap.recent?.status).toBe('error');
    expect(snap.recent?.approvals).toEqual([]);
    expect(snap.status).toBe('ready');
    expect(ids(snap.approvals)).toContain(opened.id);
  });
});
