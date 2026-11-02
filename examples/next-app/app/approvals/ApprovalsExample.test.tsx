// @vitest-environment jsdom
import { startMock } from '@noblecloak/spec';
import type { RunningMock } from '@noblecloak/spec';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAuth } from '../../test-support/fake-auth.js';
import { AuthError } from '@noblecloak/react/auth';
import { ApprovalsExample, fetchMockApproverToken } from './ApprovalsExample.js';
import { logFault } from './auth.js';
import type { ExampleConfig } from './config.js';

/**
 * Mock mode loads the queue over four serial real HTTP round trips: the mock's token, `/v1/capabilities`, then a
 * token again and the list (`getToken` fetches a fresh mock token for every request). Locally the chain takes
 * ~150 ms; with 300 ms injected per request it takes ~1.25 s and testing-library's 1 s default expires with the
 * queue still loading; on the 2-vCPU runner the error-path tests, which do one round trip, took 400-900 ms
 * against 35-50 ms locally. Vitest's own 5 s test timeout also ends the test before a longer `waitFor` can, so
 * the test timeout is set above the wait: a stall then fails on the assertion, not on a bare timeout.
 */
const REAL_MOCK_WAIT_MS = 10_000;
const REAL_MOCK_TEST_MS = 15_000;

const OIDC: Extract<ExampleConfig, { mode: 'oidc' }> = {
  mode: 'oidc',
  apiUrl: 'https://govern.example.test',
  issuer: 'https://auth.example.test',
  clientId: 'bnoauth_REPLACE_ME',
  redirectUri: 'http://localhost:3000/approvals/callback',
};

afterEach(cleanup);

describe('mock mode', () => {
  let mock: RunningMock;
  beforeEach(async () => {
    mock = await startMock({ control: true });
  });
  afterEach(async () => {
    cleanup();
    await mock.stop();
  });

  it(
    'says it is using the mock token and shows the approver an empty queue from the mock',
    async () => {
      render(<ApprovalsExample config={{ mode: 'mock', apiUrl: mock.baseUrl }} />);
      expect(screen.getByTestId('mock-banner').textContent).toContain('Mock token');
      expect(screen.getByTestId('mock-banner').textContent).toContain(mock.baseUrl);
      await waitFor(
        () => {
          expect(screen.getByRole('status').textContent).toContain('No requests');
        },
        { timeout: REAL_MOCK_WAIT_MS }
      );
    },
    REAL_MOCK_TEST_MS
  );

  it.each([
    ['an error status', '{}', 500],
    ['a body without the approver', '{}', 200],
    ['an empty approver', '{"approver":""}', 200],
    ['a body that is not JSON', '<html>', 200],
  ])(
    'a mock that gives no token (%s) ends in the error text with a retry, not an empty queue',
    async (_name, body, status) => {
      render(
        <ApprovalsExample
          config={{ mode: 'mock', apiUrl: mock.baseUrl }}
          fetch={(input, init) => {
            const url =
              typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            return url.endsWith('/__mock/tokens')
              ? Promise.resolve(new Response(body, { status }))
              : fetch(input, init);
          }}
        />
      );
      await waitFor(
        () => {
          expect(
            screen.getAllByRole('button', { name: /retry|try again/i }).length
          ).toBeGreaterThan(0);
        },
        { timeout: REAL_MOCK_WAIT_MS }
      );
    },
    REAL_MOCK_TEST_MS
  );
});

describe('fetchMockApproverToken', () => {
  const answering =
    (body: string, status = 200) =>
    () =>
      Promise.resolve(new Response(body, { status }));

  it('returns the approver token', async () => {
    expect(await fetchMockApproverToken('http://m', answering('{"approver":"tok"}'))).toBe('tok');
  });

  it.each([
    ['an error status', '{}', 500, 'the mock did not give a token'],
    ['no approver', '{}', 200, 'the mock gave no approver token'],
    ['an empty approver', '{"approver":""}', 200, 'the mock gave no approver token'],
    ['a body that is not JSON', '<html>', 200, 'the mock gave no approver token'],
  ])('%s is an AuthError that says so', async (_name, body, status, message) => {
    const failure: unknown = await fetchMockApproverToken(
      'http://m',
      answering(body, status)
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthError);
    expect((failure as AuthError).message).toBe(message);
  });
});

describe('sign-in mode', () => {
  it('signed out: a Sign in button, and a click is the only thing that signs in', async () => {
    const auth = fakeAuth({ status: 'signed_out' });
    render(<ApprovalsExample config={OIDC} auth={auth} />);
    // The page restores a stored session on load; it does not sign in.
    await waitFor(() => {
      expect(auth.restore).toHaveBeenCalledTimes(1);
    });
    expect(auth.signIn).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(auth.signIn).toHaveBeenCalledExactlyOnceWith('/approvals');
  });

  it('shows the reason a session ended', () => {
    const auth = fakeAuth({ status: 'signed_out', message: 'This tab was signed out.' });
    render(<ApprovalsExample config={OIDC} auth={auth} />);
    expect(screen.getByRole('status').textContent).toBe('This tab was signed out.');
  });

  it('denied: says so, offers Try again, and never navigates or signs in by itself (A16, T23c)', async () => {
    const auth = fakeAuth({ status: 'denied' });
    const before = window.location.href;
    render(<ApprovalsExample config={OIDC} auth={auth} />);
    expect(screen.getByRole('alert').textContent).toContain('Access was not granted');
    // Let every effect and microtask run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(auth.signIn).toHaveBeenCalledTimes(1);
  });

  it('an error shows its message and a retry that is a click', async () => {
    const auth = fakeAuth({
      status: 'error',
      error: new AuthError('invalid_target', 'the sign-in service does not accept this API'),
    });
    render(<ApprovalsExample config={OIDC} auth={auth} />);
    expect(screen.getByRole('alert').textContent).toContain('does not accept this API');
    expect(auth.signIn).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(auth.signIn).toHaveBeenCalledTimes(1);
  });

  it.each(['redirecting', 'completing'] as const)('%s: says it is signing in', (status) => {
    render(<ApprovalsExample config={OIDC} auth={fakeAuth({ status })} />);
    expect(screen.getByRole('status').textContent).toBe('Signing in.');
  });

  it('signed in: the queue is shown, calling the API with the module token', async () => {
    const auth = fakeAuth({ status: 'signed_in' });
    const calls: string[] = [];
    render(
      <ApprovalsExample
        config={OIDC}
        auth={auth}
        fetch={(input) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          calls.push(url);
          return Promise.resolve(new Response('{}', { status: 503 }));
        }}
      />
    );
    await waitFor(() => {
      expect(auth.getToken).toHaveBeenCalled();
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) expect(url.startsWith('https://govern.example.test/')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('moves from signed out to the queue when the session starts', async () => {
    const auth = fakeAuth({ status: 'signed_out' });
    render(
      <ApprovalsExample
        config={OIDC}
        auth={auth}
        fetch={() => Promise.resolve(new Response('{}', { status: 503 }))}
      />
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDefined();
    auth.set({ status: 'signed_in' });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    });
  });
});

describe('a refusal by the sign-in module', () => {
  it('renders ConfigProblem with the module message, not a crash', () => {
    // http://127.0.0.1 is not an https or http://localhost API origin: createBrowserAuth throws on `resource`.
    render(<ApprovalsExample config={{ ...OIDC, apiUrl: 'http://127.0.0.1:8787' }} />);
    expect(screen.getByRole('alert').textContent).toContain('This app is not configured');
    expect(screen.getByRole('alert').textContent).toContain('resource must use https');
  });
});

describe('logFault', () => {
  it('logs the name and the type, never the object', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logFault(Object.assign(new TypeError('secret-token-abc'), { token: 'secret-token-abc' }));
    logFault({ token: 'secret-token-abc' });
    const lines = spy.mock.calls.map((call) => call.map(String).join(' '));
    spy.mockRestore();
    expect(lines).toEqual([
      'noblecloak fault: TypeError (object)',
      'noblecloak fault: non-Error (object)',
    ]);
  });
});

describe('server render', () => {
  it('renders without the queue, which needs the clock', () => {
    const html = renderToStaticMarkup(
      <ApprovalsExample config={{ mode: 'mock', apiUrl: 'http://127.0.0.1:8787' }} />
    );
    expect(html).toContain('Mock token');
    expect(html).toContain('Loading approvals.');
  });
});
