import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  ARG_MARKER,
  call,
  live,
  openApproval,
  openLoaded,
  SHOW_ARGUMENTS_FIELD,
  startHarness,
  toolShowingArguments,
  until,
} from './testing/approvals-harness.js';
import type { Harness, Live } from './testing/approvals-harness.js';

// Contract revision 5 (hosted shape), proved against the mock that vendors it: `Approval.arguments` is
// returned only by the single read `GET /v1/approvals/{id}`, only to the creator and an eligible approver,
// only for a tool with `show_arguments_to_approvers` on, and only while the approval is pending or
// approved. T38 asserts what the mock does (the row of the table says "rev 5 mock"); the module's own
// handling of arguments is T31-T37.

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

const approverLive = (): Live => {
  const l = live({ baseUrl: h.baseUrl, getToken: () => h.tokens.approver, reconcileMs: 600_000 });
  open.push(l);
  return l;
};

const get = (token: string, path: string): Promise<Response> => call(h.baseUrl, token, 'GET', path);
const post = (token: string, path: string, body?: unknown): Promise<Response> =>
  call(h.baseUrl, token, 'POST', path, body);

/** The approval as JSON read from `response`: `data` of the envelope. */
const dataOf = async (response: Response): Promise<Record<string, unknown>> =>
  ((await response.json()) as { data: Record<string, unknown> }).data;

const hasMarker = (value: unknown): boolean => JSON.stringify(value).includes(ARG_MARKER);

/** Registers a tool of its own (so changing its setting touches no other test) with the setting on. */
async function ownTool(): Promise<{ toolRef: string; id: string }> {
  const toolRef = `ext:rev5-own:${crypto.randomUUID()}`;
  const response = await post(h.tokens.creator, '/v1/tools', {
    tool_ref: toolRef,
    transport: 'external',
    input_schema: { type: 'object' },
    side_effect_level: 'write',
    owner_kind: 'org',
    [SHOW_ARGUMENTS_FIELD]: true,
  });
  expect(response.status).toBe(201);
  return { toolRef, id: String((await dataOf(response)).id) };
}

/** An approval of `toolRef` opened with a continuation, so it has a Resumption and can be consumed. */
async function openWithContinuation(
  toolRef: string
): Promise<{ id: string; digest: string; action: { tool_ref: string; arguments: unknown } }> {
  const action = { tool_ref: toolRef, arguments: { marker: ARG_MARKER, k: crypto.randomUUID() } };
  const response = await post(h.tokens.creator, '/v1/decisions', {
    action,
    continuation: { kind: 'adk', delivery: 'pull' },
  });
  expect(response.status).toBe(200);
  const body = (await dataOf(response)) as { approval: { id: string }; action_digest: string };
  return { id: body.approval.id, digest: body.action_digest, action };
}

describe('T38 hosted-shaped behaviour (contract rev 5 mock)', () => {
  it('has the per-tool setting, so the helper registered a real tool and not a seeded one', async () => {
    const toolRef = await toolShowingArguments(h.baseUrl);
    expect(toolRef.startsWith('ext:args-shown:')).toBe(true);
  });

  it('puts arguments on no list, wait, stream event, approve or deny response', async () => {
    const toolRef = await toolShowingArguments(h.baseUrl);
    const a = await openApproval(h.baseUrl, h.tokens.creator, { tool: toolRef });
    const b = await openApproval(h.baseUrl, h.tokens.creator, { tool: toolRef });
    // The approvals do hold them: the single read below returns them.
    expect(hasMarker(await dataOf(await get(h.tokens.creator, `/v1/approvals/${a.id}`)))).toBe(
      true
    );

    for (const [token, path] of [
      [h.tokens.approver, '/v1/approvals?approver=me&state=pending&limit=100'],
      [h.tokens.creator, '/v1/approvals?created_by=me&limit=100'],
      [h.tokens.creator, `/v1/approvals/${a.id}/wait?timeout=0`],
      [h.tokens.approver, `/v1/approvals/${a.id}/wait?timeout=0`],
    ] as const) {
      const response = await get(token, path);
      expect([path, response.status]).toEqual([path, 200]);
      expect([path, hasMarker(await response.text())]).toEqual([path, false]);
    }

    // The stream: read its first events, then change an approval so there is one to carry.
    const stream = await get(h.tokens.approver, '/v1/approvals/stream');
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let received = '';
    const reading = (async () => {
      while (!received.includes('approval.updated')) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
      }
    })();
    const approved = await post(h.tokens.approver, `/v1/approvals/${a.id}/approve`, {
      expected_action_digest: a.digest,
    });
    expect(approved.status).toBe(200);
    expect(hasMarker(await approved.text())).toBe(false);
    await reading;
    await reader.cancel();
    expect(received).toContain('approval.updated');
    expect(hasMarker(received)).toBe(false);

    const denied = await post(h.tokens.approver, `/v1/approvals/${b.id}/deny`, {
      expected_action_digest: b.digest,
    });
    expect(denied.status).toBe(200);
    expect(hasMarker(await denied.text())).toBe(false);
  });

  it('shows them on the single read to the creator and to an eligible approver, through the store too', async () => {
    const a = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolShowingArguments(h.baseUrl),
    });
    expect(hasMarker(await dataOf(await get(h.tokens.creator, `/v1/approvals/${a.id}`)))).toBe(
      true
    );
    expect(hasMarker(await dataOf(await get(h.tokens.approver, `/v1/approvals/${a.id}`)))).toBe(
      true
    );
    const l = approverLive();
    const seen = await until(l.store, (s) => s.approvals.some((row) => row.id === a.id));
    expect(hasMarker(seen.approvals)).toBe(false);
    expect(hasMarker((await openLoaded(l.store, a.id)).detail)).toBe(true);
  });

  it('shows an ineligible member a digest-only read (200) and refuses its resolve with 403 not_eligible', async () => {
    const a = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolShowingArguments(h.baseUrl),
    });
    const read = await get(h.tokens.member, `/v1/approvals/${a.id}`);
    expect(read.status).toBe(200);
    const view = await dataOf(read);
    expect(view.action_digest).toBe(a.digest);
    expect('arguments' in view).toBe(false);
    const resolve = await post(h.tokens.member, `/v1/approvals/${a.id}/approve`, {
      expected_action_digest: a.digest,
    });
    expect(resolve.status).toBe(403);
    expect(((await resolve.json()) as { type: string }).type).toContain('not_eligible');
  });

  it('removes them from the read after reject, withdraw and consume, and keeps the digest', async () => {
    const toolRef = await toolShowingArguments(h.baseUrl);
    const rejected = await openApproval(h.baseUrl, h.tokens.creator, { tool: toolRef });
    const withdrawn = await openApproval(h.baseUrl, h.tokens.creator, { tool: toolRef });
    const consumed = await openWithContinuation(toolRef);
    await post(h.tokens.approver, `/v1/approvals/${rejected.id}/deny`, {
      expected_action_digest: rejected.digest,
    });
    await post(h.tokens.creator, `/v1/approvals/${withdrawn.id}/withdraw`);
    await post(h.tokens.approver, `/v1/approvals/${consumed.id}/approve`, {
      expected_action_digest: consumed.digest,
    });
    // Approved and not consumed is not final: the arguments are still there.
    expect(
      hasMarker(await dataOf(await get(h.tokens.creator, `/v1/approvals/${consumed.id}`)))
    ).toBe(true);
    const token = String(
      (await dataOf(await get(h.tokens.creator, `/v1/approvals/${consumed.id}/resumption`)))
        .resume_token
    );
    const consume = await post(h.tokens.creator, `/v1/approvals/${consumed.id}/consume`, {
      resume_token: token,
      action: consumed.action,
    });
    expect(consume.status).toBe(200);

    for (const [id, state, digest] of [
      [rejected.id, 'rejected', rejected.digest],
      [withdrawn.id, 'withdrawn', withdrawn.digest],
      [consumed.id, 'consumed', consumed.digest],
    ] as const) {
      for (const who of [h.tokens.creator, h.tokens.approver]) {
        const view = await dataOf(await get(who, `/v1/approvals/${id}`));
        expect([id, view.state, 'arguments' in view, view.action_digest]).toEqual([
          id,
          state,
          false,
          digest,
        ]);
      }
    }
  });

  it('removes them from an open approval when the tool is patched off, and turning it on restores nothing', async () => {
    const tool = await ownTool();
    const a = await openApproval(h.baseUrl, h.tokens.creator, { tool: tool.toolRef });
    expect(hasMarker(await dataOf(await get(h.tokens.approver, `/v1/approvals/${a.id}`)))).toBe(
      true
    );
    const off = await call(h.baseUrl, h.tokens.creator, 'PATCH', `/v1/tools/${tool.id}`, {
      [SHOW_ARGUMENTS_FIELD]: false,
    });
    expect(off.status).toBe(200);
    for (const who of [h.tokens.creator, h.tokens.approver]) {
      expect(hasMarker(await dataOf(await get(who, `/v1/approvals/${a.id}`)))).toBe(false);
    }
  });

  it('removes them from the read once the approval has expired', async () => {
    // Last: it moves this file's mock clock two hours on.
    const a = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolShowingArguments(h.baseUrl),
    });
    expect(hasMarker(await dataOf(await get(h.tokens.approver, `/v1/approvals/${a.id}`)))).toBe(
      true
    );
    const moved = await post(h.tokens.creator, '/__mock/advance', { seconds: 7200 });
    expect(moved.status).toBe(200);
    for (const who of [h.tokens.creator, h.tokens.approver]) {
      const view = await dataOf(await get(who, `/v1/approvals/${a.id}`));
      expect([view.state, 'arguments' in view]).toEqual(['expired', false]);
    }
  });
});

describe('T39 the member token', () => {
  it('opens loaded and digest-only, leaves approve to the server, and answers forbidden/not_eligible', async () => {
    const a = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolShowingArguments(h.baseUrl),
    });
    const l = live({ baseUrl: h.baseUrl, getToken: () => h.tokens.member, reconcileMs: 600_000 });
    open.push(l);
    const loaded = await openLoaded(l.store, a.id);
    expect(loaded.detail).toMatchObject({ id: a.id, status: 'loaded' });
    expect(hasMarker(loaded.detail)).toBe(false);
    expect(JSON.stringify(loaded.detail)).toContain(a.digest);
    // The read was fine, so the store does not refuse locally; the server answers.
    const result = await l.store.approve(a.id);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'forbidden', code: 'not_eligible', status: 403 },
    });
  });
});
