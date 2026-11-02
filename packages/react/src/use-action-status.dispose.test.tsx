// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { createActionStatusStore as CreateStore } from './action-status-store.js';
import { cannedApproval, jsonResponse } from './testing/approvals-harness.js';
import { canned } from './testing/canned-api.js';
import { useActionStatus } from './use-action-status.js';

// The stores the hook built, so a test can see which one it disposed. The real store is used underneath.
const disposals = vi.hoisted((): Mock[] => []);
vi.mock('./action-status-store.js', async (importOriginal) => {
  const actual = await importOriginal<{ createActionStatusStore: typeof CreateStore }>();
  return {
    ...actual,
    createActionStatusStore: (...args: Parameters<typeof CreateStore>) => {
      const store = actual.createActionStatusStore(...args);
      disposals.push(vi.spyOn(store, 'dispose'));
      return store;
    },
  };
});

afterEach(() => {
  cleanup();
  disposals.length = 0;
});

describe('useActionStatus when the approval changes', () => {
  it('disposes the store it leaves, once the new one has committed, and keeps the new one', async () => {
    const api = canned();
    api.read = (id) => jsonResponse({ data: cannedApproval(id) });
    const options = { baseUrl: 'https://canned.test', getToken: () => 'tok', fetch: api.fetch };
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useActionStatus(id, options),
      {
        initialProps: { id: 'apr_1' },
      }
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    rerender({ id: 'apr_2' });
    await waitFor(() => {
      expect(result.current).toMatchObject({ approvalId: 'apr_2', status: 'ready' });
    });
    expect(disposals).toHaveLength(2);
    expect(disposals[0]).toHaveBeenCalledTimes(1);
    expect(disposals[1]).not.toHaveBeenCalled();
  });
});
