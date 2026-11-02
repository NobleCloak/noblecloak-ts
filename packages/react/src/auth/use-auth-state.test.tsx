// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';

import { clock, completeFlow, harness } from '../testing/auth-harness.js';
import type { BrowserAuth } from '../auth-types.js';
import { useAuthState } from './use-auth-state.js';

beforeEach(() => {
  clock.now = 1_000_000;
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

function Status({ auth }: { auth: BrowserAuth }) {
  const state = useAuthState(auth);
  return <p>{state.status}</p>;
}

describe('useAuthState', () => {
  it('renders the current state and follows every change, without signing anyone in', async () => {
    const h = harness();
    render(<Status auth={h.auth} />);
    expect(screen.getByText('signed_out')).toBeDefined();
    await act(async () => {
      await completeFlow(h);
    });
    expect(screen.getByText('signed_in')).toBeDefined();
    await act(async () => {
      await h.auth.signOut();
    });
    expect(screen.getByText('signed_out')).toBeDefined();
    expect(h.stub.requestsTo('/authorize')).toHaveLength(0);
  });

  it('on the server the snapshot is signed_out, whatever the object holds', async () => {
    const h = harness();
    await completeFlow(h);
    expect(h.auth.getSnapshot().status).toBe('signed_in');
    expect(renderToString(<Status auth={h.auth} />)).toContain('signed_out');
  });

  it('stops listening when unmounted', async () => {
    const h = harness();
    const { unmount } = render(<Status auth={h.auth} />);
    unmount();
    await act(async () => {
      await completeFlow(h);
    });
    expect(h.auth.getSnapshot().status).toBe('signed_in');
  });
});
