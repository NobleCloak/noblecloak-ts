import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { config, proxy } from './proxy.js';

describe('proxy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets the content-security policy from the app and issuer variables', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_NC_API_URL', 'http://127.0.0.1:8787');
    vi.stubEnv('NEXT_PUBLIC_NC_ISSUER', 'https://auth.example.test');
    const policy = proxy(new NextRequest('http://localhost:3000/approvals')).headers.get(
      'content-security-policy'
    );
    expect(policy).toContain("connect-src 'self' http://127.0.0.1:8787 https://auth.example.test");
  });
});

describe('the matcher', () => {
  const [matcher] = config.matcher;
  const matches = (path: string): boolean => new RegExp(`^${matcher?.source ?? ''}$`).test(path);

  it('covers the pages, including the callback', () => {
    expect(matches('/approvals')).toBe(true);
    expect(matches('/approvals/callback')).toBe(true);
    expect(matches('/')).toBe(true);
  });

  it('leaves out the API routes and the static assets', () => {
    for (const path of ['/api/health', '/_next/static/chunks/a.js', '/_next/image', '/favicon.ico'])
      expect(matches(path)).toBe(false);
  });

  it('leaves out prefetch requests', () => {
    expect(matcher?.missing).toEqual([
      { type: 'header', key: 'next-router-prefetch' },
      { type: 'header', key: 'purpose', value: 'prefetch' },
    ]);
  });
});
