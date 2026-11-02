// @vitest-environment jsdom
import { AuthError } from '@noblecloak/react/auth';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth } from '../../test-support/fake-auth.js';
import { CallbackClient } from './CallbackClient.js';
import type { ExampleConfig } from './config.js';

const replace = vi.fn<(to: string) => void>();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const CONFIG: Extract<ExampleConfig, { mode: 'oidc' }> = {
  mode: 'oidc',
  apiUrl: 'https://govern.example.test',
  issuer: 'https://auth.example.test',
  clientId: 'bnoauth_REPLACE_ME',
  redirectUri: 'http://localhost:3000/permissions/callback',
  roles: [],
};

afterEach(() => {
  cleanup();
  replace.mockClear();
});

describe('the callback page', () => {
  it('completes the sign-in once on mount and says it is signing in', async () => {
    const auth = fakeAuth({ status: 'completing' });
    render(<CallbackClient config={CONFIG} auth={auth} />);
    expect(screen.getByRole('status').textContent).toBe('Signing in.');
    await waitFor(() => {
      expect(auth.completeSignIn).toHaveBeenCalledTimes(1);
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it('goes on to where the person came from once signed in, and to the permissions page without one', async () => {
    const auth = fakeAuth({ status: 'completing' });
    const first = render(<CallbackClient config={CONFIG} auth={auth} />);
    auth.set({ status: 'signed_in', returnTo: '/permissions?x=1' });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledExactlyOnceWith('/permissions?x=1');
    });
    first.unmount();
    replace.mockClear();
    render(<CallbackClient config={CONFIG} auth={fakeAuth({ status: 'signed_in' })} />);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledExactlyOnceWith('/permissions');
    });
  });

  it('denied: stays, says so and links back; it neither navigates nor signs in (T23c)', async () => {
    const auth = fakeAuth({ status: 'denied' });
    render(<CallbackClient config={CONFIG} auth={auth} />);
    expect(screen.getByRole('alert').textContent).toContain('Access was not granted');
    expect(screen.getByRole('link', { name: 'Back to permissions' }).getAttribute('href')).toBe(
      '/permissions'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replace).not.toHaveBeenCalled();
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('an error stays and shows the message', async () => {
    const auth = fakeAuth({
      status: 'error',
      error: new AuthError('server_error', 'The token request failed.'),
    });
    render(<CallbackClient config={CONFIG} auth={auth} />);
    expect(screen.getByRole('alert').textContent).toContain('The token request failed.');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replace).not.toHaveBeenCalled();
    expect(auth.signIn).not.toHaveBeenCalled();
  });
});

describe('a refusal by the sign-in module', () => {
  it('renders ConfigProblem with the module message, not a crash', () => {
    render(<CallbackClient config={{ ...CONFIG, redirectUri: 'http://localhost:3000/cb?x=1' }} />);
    expect(screen.getByRole('alert').textContent).toContain('This app is not configured');
    expect(screen.getByRole('alert').textContent).toContain('redirectUri must be exact');
  });
});
