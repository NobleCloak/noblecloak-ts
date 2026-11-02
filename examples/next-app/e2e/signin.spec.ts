/**
 * T23c, in a real browser: the sign-in half of the example, in the oidc build, against a sign-in service the
 * test stands in for (`page.route` answers for `http://localhost:8788`; nothing listens there). The browser
 * is real: the production build with its content-security policy, `sessionStorage`, `history`, `fetch`.
 * The only seeded thing is the pending record that `signIn()` would have written before the redirect, because
 * the redirect itself needs a real authorization server (the beta half).
 */
import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';

import { APP_ORIGIN, ISSUER_ORIGIN, OIDC_API_ORIGIN } from '../playwright.config.js';

const STATE = 'e2e-state';
const VERIFIER = 'v'.repeat(64);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

interface Watched {
  readonly requests: Request[];
  readonly problems: string[];
  violations(): Promise<string[]>;
}

/** Seeds the pending record of one sign-in, and records every request to the sign-in service and the API. */
async function open(page: Page): Promise<Watched> {
  await page.addInitScript(
    ({ state, verifier }) => {
      (window as unknown as { __violations: string[] }).__violations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        (window as unknown as { __violations: string[] }).__violations.push(
          `${event.violatedDirective} ${event.blockedURI}`
        );
      });
      if (location.pathname !== '/approvals/callback') return;
      sessionStorage.setItem(
        `nc.auth.pending.${state}`,
        JSON.stringify({ verifier, returnTo: '/approvals', createdAt: Date.now() })
      );
    },
    { state: STATE, verifier: VERIFIER }
  );
  const requests: Request[] = [];
  const problems: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(ISSUER_ORIGIN) || request.url().startsWith(OIDC_API_ORIGIN))
      requests.push(request);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return {
    requests,
    problems,
    violations: () =>
      page.evaluate(
        () => (window as unknown as { __violations?: string[] }).__violations ?? ['not installed']
      ),
  };
}

test.describe('T23c: the sign-in callback in a real browser', () => {
  test('a denied consent stays on the callback and goes nowhere, then the approvals page does not navigate', async ({
    page,
  }) => {
    const watched = await open(page);
    await page.goto(`/approvals/callback?error=access_denied&state=${STATE}`);
    await expect(page.getByText('Access was not granted')).toBeVisible();
    // The code and state are gone from the address, and the page did not move on.
    expect(new URL(page.url()).search).toBe('');
    expect(new URL(page.url()).pathname).toBe('/approvals/callback');
    await page.waitForTimeout(1_000);
    expect(new URL(page.url()).pathname).toBe('/approvals/callback');
    // A denial makes no request at all: no metadata, no token exchange.
    expect(watched.requests.map((r) => r.url())).toEqual([]);

    // Back on the approvals page by an in-app link (a client-side navigation), so the same BrowserAuth
    // instance, still in its `denied` state, is the one the approvals page reads. A full page load would
    // build a fresh, signed-out one and could not show a sign-in that starts by itself after a denial.
    await page.evaluate(() => {
      (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });
    await page.getByRole('link', { name: 'Back to approvals' }).click();
    await expect(page).toHaveURL(`${APP_ORIGIN}/approvals`);
    expect(
      await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)
    ).toBe(true);
    // The denial is still what the page shows, with a click to try again; nothing left for the issuer.
    await expect(page.getByText('Access was not granted. You can try again.')).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(page.url()).toBe(`${APP_ORIGIN}/approvals`);
    expect(watched.requests.map((r) => r.url())).toEqual([]);
    expect(watched.problems).toEqual([]);
    expect(await watched.violations()).toEqual([]);
  });

  test('a granted sign-in exchanges the code once, cleans the address, and the API gets the token', async ({
    page,
  }) => {
    const watched = await open(page);
    let tokenCalls = 0;
    let tokenBody = '';
    await page.route(`${ISSUER_ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        await route.fulfill({
          contentType: 'application/json',
          headers: CORS,
          body: JSON.stringify({
            issuer: ISSUER_ORIGIN,
            authorization_endpoint: `${ISSUER_ORIGIN}/authorize`,
            token_endpoint: `${ISSUER_ORIGIN}/token`,
          }),
        });
      } else if (url.pathname === '/token') {
        tokenCalls += 1;
        tokenBody = route.request().postData() ?? '';
        await route.fulfill({
          contentType: 'application/json',
          headers: CORS,
          body: JSON.stringify({
            access_token: 'e2e-access-token',
            token_type: 'Bearer',
            expires_in: 600,
          }),
        });
      } else {
        await route.fulfill({ status: 404, headers: CORS });
      }
    });
    // The API is not running: the page's calls are answered empty, and the test reads the token they carry.
    const authorizations: string[] = [];
    await page.route(`${OIDC_API_ORIGIN}/**`, async (route) => {
      authorizations.push((await route.request().allHeaders()).authorization ?? '');
      await route.fulfill({
        status: 503,
        headers: CORS,
        contentType: 'application/json',
        body: '{}',
      });
    });

    await page.goto(`/approvals/callback?code=e2e-code&state=${STATE}`);
    await expect(page).toHaveURL(`${APP_ORIGIN}/approvals`);
    expect(tokenCalls).toBe(1);
    const form = new URLSearchParams(tokenBody);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('e2e-code');
    expect(form.get('code_verifier')).toBe(VERIFIER);
    expect(form.get('client_id')).toBe('e2e-client');
    expect(form.get('redirect_uri')).toBe(`${APP_ORIGIN}/approvals/callback`);

    // The approvals page asks the API with the access token it was just given.
    await expect.poll(() => authorizations.length).toBeGreaterThan(0);
    expect(authorizations.every((value) => value === 'Bearer e2e-access-token')).toBe(true);
    // The pending record was used once and removed; the page reported nothing wrong to the console.
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), `nc.auth.pending.${STATE}`)
    ).toBeNull();
    expect(watched.problems).toEqual([]);
    expect(await watched.violations()).toEqual([]);
  });
});
