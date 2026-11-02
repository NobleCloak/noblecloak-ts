// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { UsePoliciesOptions } from './permissions-types.js';
import {
  inProcessFetch,
  problemResponse,
  recorder,
  startHarness,
} from './testing/approvals-harness.js';
import type { Harness, Recorder } from './testing/approvals-harness.js';
import { usePolicies } from './use-policies.js';
import { usePolicyEditor } from './use-policy-editor.js';
import { usePolicySimulate } from './use-policy-simulate.js';

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

const strict = ({ children }: { children: ReactNode }): ReactNode => (
  <StrictMode>{children}</StrictMode>
);

const capabilityReads = (rec: Recorder): number => rec.count('GET', '/v1/capabilities');

function options(rec: Recorder, extra: Partial<UsePoliciesOptions> = {}): UsePoliciesOptions {
  return { baseUrl: h.baseUrl, getToken: () => h.tokens.admin, fetch: rec.fetch, ...extra };
}

describe('the lifecycle of usePolicies', () => {
  it('reads once under StrictMode, builds the matrix, and reads nothing after unmount', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { result, unmount } = renderHook(() => usePolicies(options(rec)), { wrapper: strict });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.matrix?.columns.map((c) => c.key)).toContain('role:member');
    // StrictMode mounted twice: at most one read reached its end, and the store was not rebuilt.
    expect(rec.count('GET', '/v1/tools')).toBeLessThanOrEqual(2);
    unmount();
    const sent = rec.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.calls.length).toBe(sent);
  });

  it('a change of roles rebuilds the matrix and reads nothing', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { result, rerender } = renderHook(
      (props: { roles: { id: string; label?: string }[] }) =>
        usePolicies(options(rec, { roles: props.roles })),
      { initialProps: { roles: [{ id: 'admin' }] as { id: string; label?: string }[] } }
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const reads = capabilityReads(rec);
    expect(result.current.matrix?.columns[0]).toMatchObject({ key: 'role:admin', label: 'admin' });
    rerender({ roles: [{ id: 'admin', label: 'Administrators' }] });
    expect(result.current.matrix?.columns[0]).toMatchObject({ label: 'Administrators' });
    // An inline array that is equal does not rebuild the matrix.
    const before = result.current.matrix;
    rerender({ roles: [{ id: 'admin', label: 'Administrators' }] });
    expect(result.current.matrix).toBe(before);
    expect(capabilityReads(rec)).toBe(reads);
  });

  it('disposes the old store when an option that keys it changes, and starts from loading', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const initialProps: Partial<UsePoliciesOptions> = { enabled: false };
    const { result, rerender } = renderHook(
      (props: Partial<UsePoliciesOptions>) => usePolicies(options(rec, props)),
      { initialProps, wrapper: strict }
    );
    expect(result.current.status).toBe('idle');
    await new Promise((r) => setTimeout(r, 50));
    expect(rec.calls).toEqual([]);
    rerender({ enabled: true });
    expect(result.current.status).toBe('loading');
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    rerender({ enabled: true, readOnly: true });
    expect(result.current.status).toBe('loading');
    await waitFor(() => {
      expect(result.current.authoring).toEqual({
        readOnly: true,
        reason: 'host',
        canPublish: false,
        canRetire: false,
      });
    });
  });

  it('reads getToken, fetch and onFault through a ref: a fault reaches the handler given last', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.path === '/v1/capabilities' ? problemResponse(401, 'invalid_token') : undefined
    );
    const first = vi.fn();
    const second = vi.fn();
    const thrown = new Error('host callback failed');
    const { result, rerender } = renderHook(
      (props: { onFault: (f: unknown) => void }) =>
        usePolicies(
          options(rec, {
            onFault: props.onFault,
            onSessionExpired: () => {
              throw thrown;
            },
          })
        ),
      { initialProps: { onFault: first } }
    );
    rerender({ onFault: second });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error?.kind).toBe('unauthorized');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(thrown);
  });

  it('answers a server render with the idle snapshot', async () => {
    const { createPoliciesStore } = await import('./permissions-store.js');
    const store = createPoliciesStore({ baseUrl: h.baseUrl, getToken: () => h.tokens.admin });
    expect(store.getServerSnapshot()).toMatchObject({ status: 'idle', policies: [], tools: [] });
    store.dispose();
  });
});

describe('usePolicyEditor and usePolicySimulate', () => {
  it('edit and simulate one policy through the controller', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { result } = renderHook(
      () => {
        const policies = usePolicies(options(rec));
        return {
          policies,
          editor: usePolicyEditor(policies, 'pol_silent'),
          simulation: usePolicySimulate(policies, 'pol_silent'),
        };
      },
      { wrapper: strict }
    );
    await waitFor(() => {
      expect(result.current.editor.status).toBe('ready');
      expect(result.current.policies.status).toBe('ready');
    });
    expect(result.current.editor.authoring).toEqual({
      readOnly: false,
      canPublish: true,
      canRetire: true,
    });
    expect(result.current.editor.working?.config).toMatchObject({ mode: 'ask' });
    act(() => {
      result.current.editor.setMode('always_allow');
    });
    expect(result.current.editor).toMatchObject({
      dirty: true,
      notes: ['conditions_cleared'],
      working: { config: { mode: 'always_allow' } },
    });
    act(() => {
      result.current.editor.edit({ name: 'Comments allowed' });
      result.current.editor.setCondition('on_deny', 'halt');
    });
    expect(result.current.editor.working).toMatchObject({
      name: 'Comments allowed',
      config: { mode: 'always_allow', on_deny: 'halt' },
    });
    act(() => {
      result.current.editor.setCondition('on_deny', undefined);
    });
    expect(result.current.editor.working?.config).toEqual({ mode: 'always_allow' });

    expect(result.current.simulation).toMatchObject({ status: 'idle', runsOffered: true });
    await act(async () => {
      await result.current.simulation.run({ toolRef: 'mcp:tracker:add_comment' });
    });
    expect(result.current.simulation.status).toBe('done');
    expect(result.current.simulation.result?.appliesToCaller).toBe(false);
    // The working version of the open editor is the version simulated.
    expect(rec.calls.find((c) => c.path.endsWith('/simulate'))?.body).toMatchObject({
      draft_version: 3,
    });

    await act(async () => {
      await result.current.editor.reload();
    });
    expect(result.current.editor.dirty).toBe(false);
  });
});
