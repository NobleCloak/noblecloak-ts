// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { UseConnectionsOptions } from './connections-types.js';
import { call, inProcessFetch, recorder, startHarness } from './testing/approvals-harness.js';
import type { Harness, Recorder } from './testing/approvals-harness.js';
import { WAITING_KEY } from './connections-store.js';
import { useConnection } from './use-connection.js';
import { useConnections } from './use-connections.js';

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

function options(rec: Recorder, extra: Partial<UseConnectionsOptions> = {}): UseConnectionsOptions {
  return { baseUrl: h.baseUrl, getToken: () => h.tokens.admin, fetch: rec.fetch, ...extra };
}

describe('the lifecycle of useConnections', () => {
  it('reads once under StrictMode, and reads nothing after unmount', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { result, unmount } = renderHook(() => useConnections(options(rec)), { wrapper: strict });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(rec.count('GET', '/v1/connections')).toBeLessThanOrEqual(1);
    unmount();
    const sent = rec.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.calls.length).toBe(sent);
  });

  it('keeps one store across renders with inline callbacks, and the actions keep their identity', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { result, rerender } = renderHook(() =>
      useConnections(options(rec, { onFault: () => undefined, getToken: () => h.tokens.admin }))
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const rename = result.current.rename;
    rerender();
    expect(result.current.rename).toBe(rename);
    expect(rec.count('GET', '/v1/capabilities')).toBe(1);
  });

  it('disposes the old store when an option that keys it changes, and starts from loading; readOnly keys nothing', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { result, rerender } = renderHook<
      ReturnType<typeof useConnections>,
      Partial<UseConnectionsOptions>
    >((props) => useConnections(options(rec, props)), { initialProps: { enabled: false } });
    expect(result.current.status).toBe('idle');
    expect(rec.calls).toEqual([]);
    rerender({ enabled: true });
    expect(result.current.status).toBe('loading');
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    rerender({ enabled: true, readOnly: true });
    await waitFor(() => {
      expect(result.current.administration).toEqual({ readOnly: true, reason: 'host' });
    });
  });

  it('keeps its store, and the result of a round trip, when the host learns readOnly later', async () => {
    const created = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/connections', {
      name: 'hook return',
      url: 'https://hook-return.example.com/mcp',
      transport: 'mcp',
      owner_kind: 'org',
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    window.sessionStorage.setItem(WAITING_KEY, JSON.stringify({ state: 'n1', connectionId: id }));
    window.history.replaceState(null, '', `/c?nc_state=n1&nc_connection=${id}&nc_result=connected`);
    const rec = recorder(inProcessFetch(h.mock));
    const { result, rerender } = renderHook<
      ReturnType<typeof useConnections>,
      { readOnly: boolean | undefined }
    >((props) => useConnections(options(rec, { readOnly: props.readOnly })), {
      initialProps: { readOnly: undefined },
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.lastReturn?.connectionId).toBe(id);
    rerender({ readOnly: true });
    await waitFor(() => {
      expect(result.current.administration).toEqual({ readOnly: true, reason: 'host' });
    });
    expect(result.current.lastReturn?.connectionId).toBe(id);
    expect(rec.count('GET', '/v1/capabilities')).toBe(1);
    rerender({ readOnly: false });
    await waitFor(() => {
      expect(result.current.administration).toEqual({ readOnly: false });
    });
    window.history.replaceState(null, '', '/');
  });

  it('reads the returnTo and onNavigate of the latest render when an authorization starts', async () => {
    const created = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/connections', {
      name: 'hook oauth',
      url: 'https://hook-oauth.example.com/mcp',
      transport: 'mcp',
      owner_kind: 'org',
      auth: { kind: 'oauth' },
      credential_tier: 'org_shared',
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const rec = recorder(inProcessFetch(h.mock));
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      (props: { navigate: (url: string) => void; returnTo: string }) =>
        useConnections(options(rec, { onNavigate: props.navigate, returnTo: props.returnTo })),
      { initialProps: { navigate: first, returnTo: 'https://module.mock.test/a' } }
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    rerender({ navigate: second, returnTo: 'https://module.mock.test/b' });
    await act(async () => {
      await result.current.authorize(id);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    const sent = rec.calls.find((c) => c.path.endsWith('/authorize'));
    const sentTo = new URL((sent?.body as { return_to: string }).return_to);
    expect(sentTo.origin + sentTo.pathname).toBe('https://module.mock.test/b');
  });
});

describe('useConnection', () => {
  it('reads the registered tools of one registration on its first subscriber', async () => {
    const created = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/connections', {
      name: 'hook tools',
      url: 'https://hook-tools.example.com/mcp',
      transport: 'mcp',
      owner_kind: 'org',
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    await call(h.baseUrl, h.tokens.admin, 'POST', `/v1/connections/${id}/refresh`);
    const rec = recorder(inProcessFetch(h.mock));
    const { result } = renderHook(
      () => {
        const connections = useConnections(options(rec));
        return useConnection(connections, id);
      },
      { wrapper: strict }
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    await waitFor(() => {
      expect(result.current.connection?.name).toBe('hook tools');
    });
    expect(result.current.tools).toHaveLength(2);
    expect(
      rec.calls
        .filter((c) => c.path === '/v1/tools')
        .every((c) => c.query.includes(`connection=${id}`))
    ).toBe(true);
    await act(async () => {
      await result.current.discover();
    });
    expect(result.current.discovery.status).toBe('ready');
    expect(result.current.rows.every((r) => r.standing === 'registered')).toBe(true);
  });
});
