// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalsController, UseApprovalsOptions } from '../approvals-types.js';
import { createBrowserAuthWith } from '../auth/browser-auth.js';
import { memoryRefreshStore } from '../auth/stores.js';
import { useApprovals } from '../use-approvals.js';
import {
  at,
  openApproval,
  problemResponse,
  recorder,
  startHarness,
} from '../testing/approvals-harness.js';
import type { Harness, Recorder } from '../testing/approvals-harness.js';
import { clock, completeFlow, newStub } from '../testing/auth-harness.js';
import { Approvals } from './Approvals.js';

/**
 * The component on a real `useApprovals` over the in-process mock: what the person sees after a click is what
 * the store did, with no fake controller between them.
 */
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});
beforeEach(() => {
  clock.now = 1_000_000;
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Exposed {
  current: ApprovalsController | undefined;
}

function Probe(props: {
  readonly options: UseApprovalsOptions;
  readonly expose: Exposed;
  readonly onSignIn?: () => void;
}) {
  const controller = useApprovals(props.options);
  props.expose.current = controller;
  return (
    <Approvals
      controller={controller}
      {...(props.onSignIn === undefined ? {} : { onSignIn: props.onSignIn })}
    />
  );
}

const optionsFor = (
  rec: Recorder,
  extra: Partial<UseApprovalsOptions> = {}
): UseApprovalsOptions => ({
  baseUrl: h.baseUrl,
  getToken: () => h.tokens.approver,
  fetch: rec.fetch,
  reconcileMs: 600_000,
  ...extra,
});

/** The queue row of the approval opened with `digest` (its first characters are on the row). */
const rowOf = (digest: string): Promise<HTMLElement> =>
  screen.findByRole('button', {
    name: new RegExp(digest.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  });

const button = (name: string): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name });

async function openRow(user: ReturnType<typeof userEvent.setup>, digest: string): Promise<void> {
  await user.click(await rowOf(digest));
  await waitFor(() => {
    expect(button('Approve').disabled).toBe(false);
  });
}

const posts = (rec: Recorder) => rec.calls.filter((c) => c.method === 'POST');

describe('c1-17 the component over a real store', () => {
  it('approve: the POST carries the read digest, the row leaves, a stale list does not revive it, the detail closes', async () => {
    const user = userEvent.setup();
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const expose: Exposed = { current: undefined };
    render(<Probe options={optionsFor(rec)} expose={expose} />);
    await openRow(user, opened.digest);

    // A stale list that still shows the row as pending, as a lagging replica would.
    let stale: unknown;
    rec.intercept(async (c, request) => {
      if (c.method !== 'GET' || c.path !== '/v1/approvals') return undefined;
      const body = (await (await fetch(request)).json()) as { data: { id: string }[] };
      stale ??= expose.current?.approvals.find((a) => a.id === opened.id);
      const row = stale as { id: string };
      return Response.json({
        ...body,
        data: body.data.some((r) => r.id === row.id) ? body.data : [...body.data, row],
      });
    });
    // Prime the stale row while the row is still in the queue.
    stale = expose.current?.approvals.find((a) => a.id === opened.id);
    expect(stale).toBeDefined();

    await user.click(button('Approve'));
    await screen.findByText('Approved. The request has left your queue.');
    expect(posts(rec)).toHaveLength(1);
    expect(posts(rec)[0]?.path).toBe(`/v1/approvals/${opened.id}/resolve`);
    expect(posts(rec)[0]?.body).toMatchObject({
      resolution: 'approved',
      expected_action_digest: opened.digest,
    });
    expect(
      screen.queryByRole('button', { name: new RegExp(opened.digest.slice(0, 12)) })
    ).toBeNull();
    expect(document.querySelector('.nc-detail')).toBeNull();

    await act(async () => {
      await expose.current?.refresh();
    });
    await waitFor(() => {
      expect(expose.current?.status).toBe('ready');
    });
    expect(expose.current?.approvals.some((a) => a.id === opened.id)).toBe(false);
    expect(
      screen.queryByRole('button', { name: new RegExp(opened.digest.slice(0, 12)) })
    ).toBeNull();
  });

  it('deny: the POST carries the reason and the rejected resolution, and the detail closes', async () => {
    const user = userEvent.setup();
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    render(<Probe options={optionsFor(rec)} expose={{ current: undefined }} />);
    await openRow(user, opened.digest);
    await user.type(screen.getByRole('textbox'), 'not today');
    await user.click(button('Deny'));
    await screen.findByText('Denied. The request has left your queue.');
    expect(posts(rec)[0]?.body).toMatchObject({
      resolution: 'rejected',
      reason: 'not today',
      expected_action_digest: opened.digest,
    });
    expect(document.querySelector('.nc-detail')).toBeNull();
  });

  it('a 409 conflict shows the approval as it is now, and the buttons come back', async () => {
    const user = userEvent.setup();
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    render(<Probe options={optionsFor(rec)} expose={{ current: undefined }} />);
    await openRow(user, opened.digest);
    rec.intercept((c) =>
      c.method === 'POST' ? problemResponse(409, 'approval_conflict') : undefined
    );
    await user.click(button('Approve'));
    expect(await screen.findByText(/changed while you were looking/)).toBeDefined();
    expect(screen.getByText('Its state now: pending.')).toBeDefined();
    await waitFor(() => {
      expect(button('Approve').disabled).toBe(false);
    });
    expect(button('Deny').disabled).toBe(false);
    expect(document.querySelector('.nc-detail')).not.toBeNull();
  });

  it('an expired session shows Sign in again, which calls onSignIn', async () => {
    const user = userEvent.setup();
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const onSignIn = vi.fn();
    let valid = true;
    render(
      <Probe
        options={optionsFor(rec, { getToken: () => (valid ? h.tokens.approver : 'expired-token') })}
        expose={{ current: undefined }}
        onSignIn={onSignIn}
      />
    );
    await openRow(user, opened.digest);
    valid = false;
    await user.click(button('Approve'));
    expect((await screen.findAllByText('Your session has expired.')).length).toBeGreaterThan(0);
    // The queue, the detail and the failed decision each offer it; any of them calls onSignIn.
    const offers = await screen.findAllByRole('button', { name: 'Sign in again' });
    expect(offers.length).toBeGreaterThan(0);
    await user.click(at(offers, 0));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('the same, with getToken wired to createBrowserAuth over the sign-in stub', async () => {
    const user = userEvent.setup();
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const stub = newStub();
    const navigations: string[] = [];
    const auth = createBrowserAuthWith(
      {
        issuer: stub.issuer,
        clientId: stub.clientId,
        redirectUri: stub.redirectUri,
        resource: stub.resource,
        fetch: stub.fetch,
        storage: memoryRefreshStore(),
        now: () => clock.now,
      },
      { navigate: (url) => navigations.push(url) }
    );
    await completeFlow({ stub, auth, store: memoryRefreshStore(), navigations });
    // The stub's access tokens are not the mock's: every request is a 401, and the refresh that follows
    // is answered with another token the mock does not know either, so the session is over.
    render(
      <Probe
        options={optionsFor(rec, { getToken: (x) => auth.getToken(x) })}
        expose={{ current: undefined }}
        onSignIn={() => {
          void auth.signIn();
        }}
      />
    );
    expect((await screen.findAllByText('Your session has expired.')).length).toBeGreaterThan(0);
    expect(stub.requestsTo('/token').length).toBeGreaterThan(1);
    const before = navigations.length;
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    await waitFor(() => {
      expect(navigations.length).toBe(before + 1);
    });
    expect(opened.id).toBeDefined();
  });
});
