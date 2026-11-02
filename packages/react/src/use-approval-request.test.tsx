// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { useApprovalRequest } from './use-approval-request.js';
import type { UseApprovalRequestOptions } from './approvals-types.js';
import { canned } from './testing/canned-api.js';
import {
  ARG_MARKER,
  cannedApproval,
  jsonResponse,
  openApproval,
  problemResponse,
  recorder,
  startHarness,
  toolHidingArguments,
  toolShowingArguments,
} from './testing/approvals-harness.js';
import type { Harness } from './testing/approvals-harness.js';

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

const options = (extra: Partial<UseApprovalRequestOptions> = {}): UseApprovalRequestOptions => ({
  baseUrl: h.baseUrl,
  getToken: () => h.tokens.approver,
  ...extra,
});

const cannedOptions = (
  api: { readonly fetch: typeof fetch },
  extra: Partial<UseApprovalRequestOptions> = {}
): UseApprovalRequestOptions => ({
  baseUrl: 'https://canned.test',
  getToken: () => 'tok',
  fetch: api.fetch,
  ...extra,
});

describe('useApprovalRequest against the mock', () => {
  it('goes loading then loaded with the arguments of a tool that shows them, and reads no queue', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolShowingArguments(h.baseUrl),
    });
    const rec = recorder();
    const { result } = renderHook(
      () => useApprovalRequest(opened.id, options({ fetch: rec.fetch })),
      {
        wrapper: strict,
      }
    );
    expect(result.current.status).toBe('loading');
    await waitFor(() => {
      expect(result.current.status).toBe('loaded');
    });
    expect(result.current).toMatchObject({ id: opened.id, approval: { id: opened.id } });
    expect(JSON.stringify(result.current)).toContain(ARG_MARKER);
    // Only the single route: no capabilities, no list, no stream.
    const paths = new Set(rec.calls.map((c) => c.path));
    expect([...paths]).toEqual([`/v1/approvals/${opened.id}`]);
  });

  it('shows no arguments for a tool that withholds them', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolHidingArguments(h.baseUrl),
    });
    const { result } = renderHook(() => useApprovalRequest(opened.id, options()));
    await waitFor(() => {
      expect(result.current.status).toBe('loaded');
    });
    expect('arguments' in result.current).toBe(false);
    expect(JSON.stringify(result.current)).not.toContain(ARG_MARKER);
  });

  it('is not_found for an id the service does not know', async () => {
    const { result } = renderHook(() => useApprovalRequest('apr_missing', options()));
    await waitFor(() => {
      expect(result.current.status).toBe('not_found');
    });
  });

  it('is unauthorized for a token the service refuses, tells the host once, and reads again on retry', async () => {
    const onSessionExpired = vi.fn();
    const opened = await openApproval(h.baseUrl, h.tokens.creator, {
      tool: await toolHidingArguments(h.baseUrl),
    });
    let token = 'not-a-token';
    const { result } = renderHook(() =>
      useApprovalRequest(opened.id, options({ getToken: () => token, onSessionExpired }))
    );
    await waitFor(() => {
      expect(result.current.status).toBe('unauthorized');
    });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    token = h.tokens.approver;
    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('loaded');
    });
  });

  it('keeps nothing running after unmount', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const rec = recorder();
    const { result, unmount } = renderHook(
      () => useApprovalRequest(opened.id, options({ fetch: rec.fetch })),
      { wrapper: strict }
    );
    await waitFor(() => {
      expect(result.current.status).toBe('loaded');
    });
    unmount();
    const seen = rec.calls.length;
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(rec.calls.length).toBe(seen);
  });
});

describe('useApprovalRequest against a canned API', () => {
  it('tells the host once however many times a dead session is retried, and again after a read succeeds', async () => {
    const api = canned();
    let refuse = true;
    api.read = (id) =>
      refuse ? problemResponse(401, 'unauthorized') : jsonResponse({ data: cannedApproval(id) });
    const onSessionExpired = vi.fn();
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useApprovalRequest(id, cannedOptions(api, { onSessionExpired })),
      { initialProps: { id: 'apr_1' } }
    );
    await waitFor(() => {
      expect(result.current.status).toBe('unauthorized');
    });
    for (let i = 0; i < 2; i += 1) {
      const before = api.calls.length;
      act(() => {
        result.current.retry();
      });
      await waitFor(() => {
        expect(api.calls.length).toBeGreaterThan(before);
      });
      await waitFor(() => {
        expect(result.current.status).toBe('unauthorized');
      });
    }
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    refuse = false;
    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('loaded');
    });
    // The session dies again: a later refusal is told to the host again.
    refuse = true;
    rerender({ id: 'apr_2' });
    await waitFor(() => {
      expect(onSessionExpired).toHaveBeenCalledTimes(2);
    });
  });

  it('is unavailable with a retry delay, and stops retrying once unmounted', async () => {
    const api = canned();
    api.read = () => problemResponse(503, 'unavailable');
    const { result, unmount } = renderHook(() => useApprovalRequest('apr_1', cannedOptions(api)), {
      wrapper: strict,
    });
    await waitFor(() => {
      expect(result.current.status).toBe('unavailable');
    });
    expect(result.current).toMatchObject({
      status: 'unavailable',
      retryingInMs: expect.any(Number) as number,
    });
    unmount();
    const seen = api.calls.length;
    // Past the longest first backoff (1.2 s): a surviving retry timer would have read again by now.
    await new Promise((r) => setTimeout(r, 1600));
    expect(api.calls.length).toBe(seen);
  }, 10_000);

  it('refetches when the id changes and drops the reply of the id it left', async () => {
    const api = canned();
    const gates = new Map<string, (r: Response) => void>();
    api.read = (id) =>
      new Promise<Response>((resolve) => {
        gates.set(id, resolve);
      });
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useApprovalRequest(id, cannedOptions(api)),
      { initialProps: { id: 'apr_1' } }
    );
    await waitFor(() => {
      expect(gates.has('apr_1')).toBe(true);
    });
    rerender({ id: 'apr_2' });
    expect(result.current).toMatchObject({ id: 'apr_2', status: 'loading' });
    await waitFor(() => {
      expect(gates.has('apr_2')).toBe(true);
    });
    // The first id's reply arrives late: it must not be applied under the new id.
    await act(async () => {
      gates.get('apr_1')?.(jsonResponse({ data: cannedApproval('apr_1') }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current).toMatchObject({ id: 'apr_2', status: 'loading' });
    await act(async () => {
      gates.get('apr_2')?.(jsonResponse({ data: cannedApproval('apr_2') }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current).toMatchObject({
      id: 'apr_2',
      status: 'loaded',
      approval: { id: 'apr_2' },
    });
  });

  it('degrades when the optional lineage, policy and timing fields are absent', async () => {
    const api = canned();
    const { result } = renderHook(() => useApprovalRequest('apr_1', cannedOptions(api)));
    await waitFor(() => {
      expect(result.current.status).toBe('loaded');
    });
    if (result.current.status !== 'loaded') throw new Error('not loaded');
    expect(result.current.approval.agent).toBeUndefined();
    expect(result.current.approval.policy).toBeUndefined();
    expect(result.current.approval.expires_at).toBeUndefined();
  });

  it('refuses a reply for another id', async () => {
    const api = canned();
    api.read = () => jsonResponse({ data: cannedApproval('apr_other') });
    const { result } = renderHook(() => useApprovalRequest('apr_1', cannedOptions(api)));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
  });

  it('reads again by hand after an error', async () => {
    const api = canned();
    let next: () => Response = () => problemResponse(400, 'bad_request');
    api.read = () => next();
    const { result } = renderHook(() => useApprovalRequest('apr_1', cannedOptions(api)));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    next = () => jsonResponse({ data: cannedApproval('apr_1') });
    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('loaded');
    });
  });

  it('reads nothing while disabled', async () => {
    const api = canned();
    const { result } = renderHook(() =>
      useApprovalRequest('apr_1', cannedOptions(api, { enabled: false }))
    );
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(result.current.status).toBe('loading');
    expect(api.calls).toEqual([]);
  });

  it('is resolved for an approval that is no longer pending', async () => {
    const api = canned();
    api.read = (id) =>
      jsonResponse({
        data: cannedApproval(id, { state: 'approved', resolved_at: '2026-10-06T00:00:00.000Z' }),
      });
    const { result } = renderHook(() => useApprovalRequest('apr_1', cannedOptions(api)));
    await waitFor(() => {
      expect(result.current.status).toBe('resolved');
    });
  });

  it('is forbidden when the service refuses this person, and does not show it as empty', async () => {
    const api = canned();
    api.read = () => problemResponse(403, 'forbidden');
    const { result } = renderHook(() => useApprovalRequest('apr_1', cannedOptions(api)));
    await waitFor(() => {
      expect(result.current.status).toBe('forbidden');
    });
    expect('approval' in result.current).toBe(false);
  });

  it('reads once enabled turns true, and nothing before', async () => {
    const api = canned();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useApprovalRequest('apr_1', cannedOptions(api, { enabled })),
      { initialProps: { enabled: false } }
    );
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(api.calls).toEqual([]);
    rerender({ enabled: true });
    await waitFor(() => {
      expect(result.current.status).toBe('loaded');
    });
  });
});
