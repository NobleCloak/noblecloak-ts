/**
 * Sets the content-security policy (A14) on every page response; the logic is `withCsp` in `app/csp.ts`.
 * Each variable is named in full so that the build inlines it. Development is exempt: the dev server needs
 * `eval` and inline styles.
 */
import type { NextRequest, NextResponse } from 'next/server';

import { withCsp } from '@app/csp';

export function proxy(request: NextRequest): NextResponse {
  return withCsp(request, {
    nodeEnv: process.env.NODE_ENV,
    apiUrl: process.env.NEXT_PUBLIC_NC_API_URL,
    issuer: process.env.NEXT_PUBLIC_NC_ISSUER,
  });
}

export const config = {
  matcher: [
    {
      source: '/((?!api/|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
