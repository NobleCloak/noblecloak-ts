// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthError } from './auth-types.js';
import { canned } from './testing/canned-api.js';
import { useApprovals } from './use-approvals.js';
import type { UseApprovalsOptions } from './approvals-types.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('c2-7 the hook forwards faults to the handler the host has now', () => {
  it('a fault goes to onFault when it is added after the first render, and to the default when it is removed', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const api = canned();
    const boom = new Error('host onSessionExpired failed');
    const handled: unknown[] = [];
    const base = (onFault: UseApprovalsOptions['onFault']): UseApprovalsOptions => ({
      baseUrl: 'https://api.test',
      getToken: () => Promise.reject(new AuthError('signed_out')),
      fetch: api.fetch,
      onSessionExpired: () => {
        throw boom;
      },
      ...(onFault === undefined ? {} : { onFault }),
    });
    const { result, rerender } = renderHook(
      (props: { onFault: UseApprovalsOptions['onFault'] }) => useApprovals(base(props.onFault)),
      { initialProps: { onFault: undefined as UseApprovalsOptions['onFault'] } }
    );
    // 1. No handler yet: the default report.
    await waitFor(() => {
      expect(reported).toEqual([boom]);
    });
    // 2. A handler added after the first render receives the next fault, and the default does not.
    rerender({ onFault: (fault) => handled.push(fault) });
    await act(() => result.current.refresh());
    await waitFor(() => {
      expect(handled).toEqual([boom]);
    });
    expect(reported).toEqual([boom]);
    // 3. Removed again: back to the default, and no fault is lost.
    rerender({ onFault: undefined });
    await act(() => result.current.refresh());
    await waitFor(() => {
      expect(reported).toEqual([boom, boom]);
    });
    expect(handled).toEqual([boom]);
  });
});
