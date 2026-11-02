import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { buildCsp, newNonce, originOf, withCsp } from './csp.js';

const FORBIDDEN = ["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", ' * ', 'data:'];

describe('buildCsp', () => {
  const policy = buildCsp({
    nonce: 'N0NCE',
    connectOrigins: [
      'http://127.0.0.1:8787',
      undefined,
      'https://auth.example.test',
      'http://127.0.0.1:8787',
    ],
  });
  const directive = (name: string): string | undefined =>
    policy.split('; ').find((d) => d.startsWith(`${name} `));

  it('allows scripts and styles from this origin or with the nonce, and nothing inline', () => {
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('script-src')).toBe("script-src 'self' 'nonce-N0NCE'");
    expect(directive('style-src')).toBe("style-src 'self' 'nonce-N0NCE'");
    for (const forbidden of FORBIDDEN) expect(` ${policy} `).not.toContain(forbidden);
  });

  it('lets the page call itself, the API and the issuer, each once', () => {
    expect(directive('connect-src')).toBe(
      "connect-src 'self' http://127.0.0.1:8787 https://auth.example.test"
    );
  });

  it('closes objects, base, forms and framing', () => {
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
    expect(directive('form-action')).toBe("form-action 'self'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
  });
});

describe('nonce and origins', () => {
  it('a nonce is new each time', () => {
    expect(newNonce()).not.toBe(newNonce());
  });

  it('originOf is the origin, or nothing', () => {
    expect(originOf('https://auth.example.test/path?q=1')).toBe('https://auth.example.test');
    expect(originOf('not a url')).toBeUndefined();
    expect(originOf(undefined)).toBeUndefined();
  });
});

describe('withCsp', () => {
  const request = (): NextRequest => new NextRequest('http://localhost:3000/approvals');
  const environment = { nodeEnv: 'production', apiUrl: 'http://127.0.0.1:8787', issuer: undefined };

  it('puts the policy on the response and on the request Next reads the nonce from, the same one', () => {
    const response = withCsp(request(), environment);
    const header = response.headers.get('content-security-policy');
    expect(header).toContain("script-src 'self' 'nonce-");
    expect(header).toContain("connect-src 'self' http://127.0.0.1:8787;");
    // NextResponse.next({request}) hands the changed request headers on under this prefix.
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(header);
  });

  it('every response has its own nonce', () => {
    const a = withCsp(request(), environment).headers.get('content-security-policy');
    const b = withCsp(request(), environment).headers.get('content-security-policy');
    expect(a).not.toBe(b);
  });

  it('development has no policy', () => {
    const response = withCsp(request(), { ...environment, nodeEnv: 'development' });
    expect(response.headers.get('content-security-policy')).toBeNull();
  });
});
