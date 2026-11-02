// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { UseActionStatusOptions } from './action-status-types.js';
import { useActionStatus } from './use-action-status.js';
import { consume, decide, openAction, recordOutcome } from './testing/action-status-harness.js';
import {
  cannedApproval,
  jsonResponse,
  problemResponse,
  recorder,
  startHarness,
} from './testing/approvals-harness.js';
import type { Harness } from './testing/approvals-harness.js';
import { canned } from './testing/canned-api.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await h.stop();
});

const strict = ({ children }: { children: ReactNode }): ReactNode => (
  <StrictMode>{children}</StrictMode>
);

const options = (extra: Partial<UseActionStatusOptions> = {}): UseActionStatusOptions => ({
  baseUrl: h.baseUrl,
  getToken: () => h.tokens.creator,
  reconcileMs: 600_000,
  ...extra,
});

describe('useActionStatus against the mock', () => {
  it('goes loading, then ready, and follows the approval from pending to approved', async () => {
    const a = await openAction(h);
    const { result } = renderHook(() => useActionStatus(a.id, options()));
    expect(result.current.status).toBe('loading');
    await waitFor(() => {
      expect(result.current).toMatchObject({ status: 'ready', state: 'pending', onDeny: 'resume' });
    });
    await decide(h, a, 'approve');
    await waitFor(() => {
      expect(result.current).toMatchObject({ status: 'ready', state: 'approved' });
    });
  });

  it('shows the outcome of a consumed approval', async () => {
    const a = await openAction(h);
    await consume(h, a);
    const recordId = await recordOutcome(h, a);
    const { result } = renderHook(() => useActionStatus(a.id, options()));
    await waitFor(() => {
      expect(result.current).toMatchObject({
        status: 'ready',
        state: 'consumed',
        outcome: { status: 'recorded', recordId, result: 'succeeded' },
        settled: true,
      });
    });
  });

  it('survives StrictMode: one live store, and the status still arrives', async () => {
    const a = await openAction(h);
    const rec = recorder();
    const { result } = renderHook(() => useActionStatus(a.id, options({ fetch: rec.fetch })), {
      wrapper: strict,
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
  });

  it('reads nothing while enabled is false, and starts when it becomes true', async () => {
    const a = await openAction(h);
    const rec = recorder();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useActionStatus(a.id, options({ fetch: rec.fetch, enabled })),
      { initialProps: { enabled: false } }
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.current.status).toBe('loading');
    expect(rec.calls).toEqual([]);
    rerender({ enabled: true });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
  });

  it('starts over for another approval, and drops the old one', async () => {
    const a = await openAction(h);
    const b = await openAction(h);
    await decide(h, b, 'deny');
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useActionStatus(id, options()),
      {
        initialProps: { id: a.id },
      }
    );
    await waitFor(() => {
      expect(result.current).toMatchObject({ approvalId: a.id, state: 'pending' });
    });
    rerender({ id: b.id });
    expect(result.current.status).toBe('loading');
    expect(result.current.approvalId).toBe(b.id);
    await waitFor(() => {
      expect(result.current).toMatchObject({ approvalId: b.id, state: 'rejected' });
    });
  });

  it('keeps the same controller object while nothing changes', async () => {
    const a = await openAction(h);
    const { result, rerender } = renderHook(() => useActionStatus(a.id, options()));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });
});

describe('useActionStatus against a canned API', () => {
  const cannedOptions = (
    api: { readonly fetch: typeof fetch },
    extra: Partial<UseActionStatusOptions> = {}
  ): UseActionStatusOptions => ({
    baseUrl: 'https://canned.test',
    getToken: () => 'tok',
    fetch: api.fetch,
    reconcileMs: 600_000,
    ...extra,
  });

  it('reads getToken, fetch and the callbacks through a ref: an inline function does not rebuild the store', async () => {
    const api = canned();
    api.read = (id) => jsonResponse({ data: cannedApproval(id) });
    const { result, rerender } = renderHook(() =>
      useActionStatus(
        'apr_1',
        cannedOptions(api, { getToken: () => 'tok', onFault: () => undefined })
      )
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const reads = api.calls.filter((c) => c === 'GET /v1/approvals/apr_1').length;
    rerender();
    rerender();
    expect(api.calls.filter((c) => c === 'GET /v1/approvals/apr_1').length).toBe(reads);
  });

  it('retry reads again after a failure', async () => {
    const api = canned();
    let allow = false;
    api.read = (id) =>
      allow ? jsonResponse({ data: cannedApproval(id) }) : problemResponse(403, 'forbidden');
    const { result } = renderHook(() => useActionStatus('apr_1', cannedOptions(api)));
    await waitFor(() => {
      expect(result.current.status).toBe('forbidden');
    });
    allow = true;
    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
  });
});
