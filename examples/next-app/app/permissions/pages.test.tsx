import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigProblem } from './ConfigProblem.js';
import CallbackPage from './callback/page.js';
import PermissionsLayout from './layout.js';
import PermissionsPage from './page.js';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllEnvs();
});

const mockMode = (): void => {
  vi.stubEnv('NEXT_PUBLIC_NC_MODE', 'mock');
  vi.stubEnv('NEXT_PUBLIC_NC_API_URL', 'http://127.0.0.1:8787');
};

describe('/permissions', () => {
  it('names what is missing when the app is not configured', () => {
    const html = renderToStaticMarkup(<PermissionsPage />);
    expect(html).toContain('This app is not configured');
    expect(html).toContain('NEXT_PUBLIC_NC_API_URL is not set');
    expect(html).toContain('.env.example');
  });

  it('in mock mode renders the heading and the mock banner inside the layout', () => {
    mockMode();
    const html = renderToStaticMarkup(
      <PermissionsLayout>
        <PermissionsPage />
      </PermissionsLayout>
    );
    expect(html).toContain('<main>');
    expect(html).toContain('<h1>Permissions</h1>');
    expect(html).toContain('Mock token');
  });

  it('ConfigProblem lists every problem', () => {
    const html = renderToStaticMarkup(
      <ConfigProblem problems={['a is not set', 'b is not set']} />
    );
    expect(html).toContain('<li>a is not set</li>');
    expect(html).toContain('<li>b is not set</li>');
  });
});

describe('/permissions/callback', () => {
  it('names what is missing when the app is not configured', () => {
    expect(renderToStaticMarkup(<CallbackPage />)).toContain('This app is not configured');
  });

  it('in mock mode says there is no sign-in and links back', () => {
    mockMode();
    const html = renderToStaticMarkup(<CallbackPage />);
    expect(html).toContain('The mock has no sign-in.');
    expect(html).toContain('href="/permissions"');
  });

  it('with a deployment configured renders the sign-in page', () => {
    vi.stubEnv('NEXT_PUBLIC_NC_API_URL', 'https://govern.example.test');
    vi.stubEnv('NEXT_PUBLIC_NC_ISSUER', 'https://auth.example.test');
    vi.stubEnv('NEXT_PUBLIC_NC_CLIENT_ID', 'bnoauth_REPLACE_ME');
    vi.stubEnv(
      'NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI',
      'http://localhost:3000/permissions/callback'
    );
    const html = renderToStaticMarkup(<CallbackPage />);
    expect(html).toContain('<h1>Signing in</h1>');
    expect(html).toContain('Signing in.');
  });
});
