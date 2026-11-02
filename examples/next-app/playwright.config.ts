import { defineConfig } from '@playwright/test';

/**
 * The end-to-end lane (`bun run test:e2e`), not part of `test`: a real browser against the production
 * build of the example (`next build`, then `next start`, so the content-security policy is in force), in
 * mock mode, across two origins: by default the page on http://localhost:3000 and the mock on
 * http://127.0.0.1:8787. Each approvals test starts its own mock and a held approval through `e2e/demo.ts`;
 * each permissions and connections test starts its own mock in the test process.
 *
 * Two runs, because `NEXT_PUBLIC_*` values are inlined by `next build` and both builds use `.next`: the
 * default run is mock mode (`e2e/approvals.spec.ts`, `e2e/permissions.spec.ts` and `e2e/connections.spec.ts`);
 * `NC_E2E_MODE=oidc` builds the sign-in mode and runs
 * `e2e/signin.spec.ts` against a sign-in service the test stands in for (`bun run test:e2e` runs both).
 *
 * `scripts/skill-exercise.ts` points the same config at an app it scaffolds elsewhere, through these
 * environment variables (all optional; unset, the example runs as above): `NC_E2E_APP_PORT` (3000),
 * `NC_MOCK_PORT` (8787; the variable `e2e/demo.ts` reads), `NC_E2E_READY_PATH` (`/api/health`,
 * the route that says the app is up), `NC_E2E_APP_DIR` (where the app lives; unset, Playwright's working
 * directory, which is this one) and `NC_E2E_APP_COMMAND` (`next build && next start -p <port>`).
 */
const appPort = process.env.NC_E2E_APP_PORT ?? '3000';
const mockPort = process.env.NC_MOCK_PORT ?? '8787';
export const APP_ORIGIN = `http://localhost:${appPort}`;
export const API_ORIGIN = `http://127.0.0.1:${mockPort}`;
/**
 * The API of the oidc run. Sign-in names the API as the token's audience, and the module accepts `https:` or
 * `http://localhost` there, not `http://127.0.0.1`, so this run's API is on `localhost`. Nothing listens
 * there: the test answers for it.
 */
export const OIDC_API_ORIGIN = 'http://localhost:8789';
/** The sign-in service of the oidc run: `http://localhost` is the one plain-http issuer the module accepts. */
export const ISSUER_ORIGIN = 'http://localhost:8788';

const oidc = process.env.NC_E2E_MODE === 'oidc';

export default defineConfig({
  testDir: 'e2e',
  // `NC_E2E_SPEC` narrows the mock run to one spec (the skill exercise runs one skill's spec at a time).
  testMatch: oidc
    ? 'signin.spec.ts'
    : (process.env.NC_E2E_SPEC ?? [
        'approvals.spec.ts',
        'permissions.spec.ts',
        'connections.spec.ts',
      ]),
  // One mock on one fixed port: the tests take turns.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: { baseURL: APP_ORIGIN, browserName: 'chromium' },
  webServer: {
    command: process.env.NC_E2E_APP_COMMAND ?? `next build && next start -p ${appPort}`,
    url: `${APP_ORIGIN}${process.env.NC_E2E_READY_PATH ?? '/api/health'}`,
    ...(process.env.NC_E2E_APP_DIR === undefined ? {} : { cwd: process.env.NC_E2E_APP_DIR }),
    timeout: 180_000,
    reuseExistingServer: false,
    // NEXT_PUBLIC_* values are inlined by `next build`: the mock's origin is part of the build.
    env: oidc
      ? {
          NEXT_PUBLIC_NC_MODE: 'oidc',
          NEXT_PUBLIC_NC_API_URL: OIDC_API_ORIGIN,
          NEXT_PUBLIC_NC_ISSUER: ISSUER_ORIGIN,
          NEXT_PUBLIC_NC_CLIENT_ID: 'e2e-client',
          NEXT_PUBLIC_NC_REDIRECT_URI: `${APP_ORIGIN}/approvals/callback`,
        }
      : { NEXT_PUBLIC_NC_MODE: 'mock', NEXT_PUBLIC_NC_API_URL: API_ORIGIN },
  },
});
