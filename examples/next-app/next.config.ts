import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  headers() {
    // Each redirect target carries the authorization code in its address (A8): never cached, and the address is
    // not sent on as a referrer.
    return Promise.resolve(
      ['/approvals/callback', '/permissions/callback', '/connections/callback'].map((source) => ({
        source,
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      }))
    );
  },
};

export default config;
