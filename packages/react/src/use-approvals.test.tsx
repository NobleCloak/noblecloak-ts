// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { useApprovals } from './use-approvals.js';
import { ids, openApproval, recorder, startHarness } from './testing/approvals-harness.js';
import type { Harness } from './testing/approvals-harness.js';
import type { UseApprovalsOptions } from './approvals-types.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await h.stop();
});

const streams = (): number => h.mock.state.listeners.size;

const strict = ({ children }: { children: ReactNode }): ReactNode => (
  <StrictMode>{children}</StrictMode>
);

const options = (extra: Partial<UseApprovalsOptions> = {}): UseApprovalsOptions => ({
  baseUrl: h.baseUrl,
  getToken: () => h.tokens.approver,
  reconcileMs: 600_000,
  ...extra,
});

const initialOptions: Partial<UseApprovalsOptions> = { scope: 'a' };

describe('T18 the lifecycle of the hook', () => {
  it('keeps one stream at a time under StrictMode, and none after unmount', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator_user);
    const rec = recorder();
    const { result, unmount } = renderHook(() => useApprovals(options({ fetch: rec.fetch })), {
      wrapper: strict,
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
      expect(result.current.connection).toBe('live');
    });
    expect(ids(result.current.approvals)).toContain(opened.id);
    await waitFor(() => {
      expect(streams()).toBe(1);
    });
    // StrictMode mounted, unmounted and mounted again: the first start was cancelled, not duplicated.
    await act(() => new Promise((r) => setTimeout(r, 200)));
    await waitFor(() => {
      expect(streams()).toBe(1);
    });
    unmount();
    await waitFor(() => {
      expect(streams()).toBe(0);
    });
    const sent = rec.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(rec.calls.length).toBe(sent);
  });

  it('disposes the old store when an option that keys it changes, and starts again from loading', async () => {
    const { result, rerender } = renderHook(
      (props: Partial<UseApprovalsOptions>) => useApprovals(options(props)),
      {
        initialProps: initialOptions,
        wrapper: strict,
      }
    );
    await waitFor(() => {
      expect(result.current.connection).toBe('live');
    });
    await waitFor(() => {
      expect(streams()).toBe(1);
    });
    rerender({ scope: 'b' });
    expect(result.current.status).toBe('loading');
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
      expect(result.current.connection).toBe('live');
    });
    await act(() => new Promise((r) => setTimeout(r, 200)));
    await waitFor(() => {
      expect(streams()).toBe(1);
    });
    // Switched off: no work at all.
    rerender({ scope: 'b', enabled: false });
    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    await waitFor(() => {
      expect(streams()).toBe(0);
    });
    expect(result.current.connection).toBe('offline');
  });

  it('does not rebuild the store for an inline getToken, and calls the latest one', async () => {
    const rec = recorder();
    const first = vi.fn((): string => h.tokens.approver);
    const second = vi.fn((): string => h.tokens.approver);
    const expired = vi.fn();
    const { result, rerender } = renderHook(
      (props: { getToken: UseApprovalsOptions['getToken'] }) =>
        useApprovals(
          options({ fetch: rec.fetch, getToken: props.getToken, onSessionExpired: expired })
        ),
      { initialProps: { getToken: () => first() }, wrapper: strict }
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const capabilities = rec.count('GET', '/v1/capabilities');
    rerender({ getToken: () => second() });
    rerender({ getToken: () => second() });
    expect(result.current.status).toBe('ready');
    await act(async () => {
      await result.current.refresh();
    });
    expect(second).toHaveBeenCalled();
    // A refresh reads capabilities once more; a rebuilt store would have read them again on each rerender.
    expect(rec.count('GET', '/v1/capabilities')).toBe(capabilities + 1);
  });

  it('calls the latest onSessionExpired and the latest fetch', async () => {
    const calledA = vi.fn();
    const calledB = vi.fn();
    let bad = false;
    const recA = recorder();
    const recB = recorder();
    const { result, rerender } = renderHook(
      (props: { onSessionExpired: () => void; fetch: typeof fetch }) =>
        useApprovals(
          options({
            getToken: () => (bad ? h.tokens.expired : h.tokens.approver),
            ...props,
          })
        ),
      { initialProps: { onSessionExpired: calledA, fetch: recA.fetch } }
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    rerender({ onSessionExpired: calledB, fetch: recB.fetch });
    bad = true;
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(calledA).not.toHaveBeenCalled();
    expect(calledB).toHaveBeenCalledTimes(1);
    expect(recB.count('GET', '/v1/capabilities')).toBeGreaterThanOrEqual(1);
  });
});

describe('the controller the hook returns', () => {
  it('carries the snapshot and the actions, and is stable until something changes', async () => {
    const opened = await openApproval(h.baseUrl, h.tokens.creator);
    const { result, rerender } = renderHook(() => useApprovals(options()));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const same = result.current;
    rerender();
    expect(result.current).toBe(same);
    act(() => {
      result.current.openDetail(opened.id);
    });
    await waitFor(() => {
      expect(result.current.detail?.status).toBe('loaded');
    });
    let decision: Awaited<ReturnType<typeof result.current.approve>> | undefined;
    await act(async () => {
      decision = await result.current.approve(opened.id);
    });
    expect(decision).toMatchObject({ ok: true });
    await waitFor(() => {
      expect(ids(result.current.approvals)).not.toContain(opened.id);
    });
    act(() => {
      result.current.closeDetail();
      result.current.retryDetail();
    });
    expect(result.current.detail).toBeUndefined();
    await act(async () => {
      expect(await result.current.deny(opened.id)).toMatchObject({ ok: false });
    });
  });
});
