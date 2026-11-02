import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';

import { API_ORIGIN, APP_ORIGIN } from '../playwright.config.js';
import { startBrowserDemo } from './demo.js';
import type { BrowserDemo } from './demo.js';

/** Records every content-security-policy violation the page reports, and every error it throws. */
async function watch(page: Page): Promise<() => Promise<string[]>> {
  const problems: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { __violations: string[] }).__violations.push(
        `${event.violatedDirective} ${event.blockedURI}`
      );
    });
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  return async () => [
    ...problems,
    ...(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)),
  ];
}

let demo: BrowserDemo | undefined;
test.afterEach(async () => {
  await demo?.stop();
  demo = undefined;
});

const rowOf = (page: Page) => page.getByRole('button', { name: /issue_refund/ });

// Three kinds of test live here. The CSP tests are tagged `@csp`: they assert the example's content-security
// policy (`app/csp.ts`, applied by `proxy.ts`). The callback-headers test is tagged `@callback-headers`: it
// asserts the callback route's `Cache-Control` and `Referrer-Policy` (A8), which `next.config.ts` sets. The
// example alone ships both; the skill generates no middleware or framework configuration. The flow tests
// (untagged) see, decide and resume against the mock and hold for any app that wires the Approvals module in.
// The example's own run (`bun run test:e2e`) runs every test; `scripts/skill-exercise.ts` runs the spec for
// the app the `skills/approvals` skill wires with `--grep-invert '@csp|@callback-headers'`, because that app
// has neither the policy nor the headers yet.

test.describe('T23b: the production build serves a content-security policy @csp', () => {
  test('the home page carries the policy and a nonce on every script too', async ({ request }) => {
    const home = await request.get('/');
    expect(home.ok()).toBe(true);
    const policy = home.headers()['content-security-policy'] ?? '';
    expect(policy).toMatch(/script-src 'self' 'nonce-[\w+/=-]+'/);
    const nonce = /'nonce-([\w+/=-]+)'/.exec(policy)?.[1];
    if (nonce === undefined) throw new Error('the policy has no nonce');
    const scripts = (await home.text()).match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
  });

  test('the page and the policy itself', async ({ request }) => {
    const page: APIResponse = await request.get('/approvals');
    expect(page.ok()).toBe(true);
    const policy = page.headers()['content-security-policy'] ?? '';
    expect(policy).toMatch(/script-src 'self' 'nonce-[\w+/=-]+'/);
    expect(policy).toMatch(/style-src 'self' 'nonce-[\w+/=-]+'/);
    expect(policy).toContain(`connect-src 'self' ${API_ORIGIN}`);
    for (const forbidden of [
      "'unsafe-inline'",
      "'unsafe-eval'",
      "'strict-dynamic'",
      ' * ',
      'data:',
    ])
      expect(` ${policy} `).not.toContain(forbidden);
    for (const required of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ])
      expect(policy).toContain(required);

    // A14: the page's own scripts carry this response's nonce, so the browser runs them. A prerendered page
    // has none and the browser blocks every script.
    const nonce = /'nonce-([\w+/=-]+)'/.exec(policy)?.[1];
    if (nonce === undefined) throw new Error('the policy has no nonce');
    const html = await page.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);

    // Every response has its own nonce.
    const again = (await request.get('/approvals')).headers()['content-security-policy'];
    expect(again).not.toBe(policy);
  });
});

test('A8: the callback route is never cached and its address is not sent on @callback-headers', async ({
  request,
}) => {
  const callback = await request.get('/approvals/callback?code=x&state=y');
  expect(callback.headers()['cache-control']).toBe('no-store');
  expect(callback.headers()['referrer-policy']).toBe('no-referrer');
});

test("the approvals page of a real navigation carries a nonce'd policy @csp", async ({ page }) => {
  const response = await page.goto('/approvals');
  expect(response?.headers()['content-security-policy']).toContain("'nonce-");
});

test.describe('across two origins, against the mock', () => {
  test('T23 + T23d: see the request, read its detail (Approve waits for it), approve, the agent resumes once', async ({
    page,
  }) => {
    const problems = await watch(page);
    demo = await startBrowserDemo('approve', APP_ORIGIN);

    // T23d: hold the single read of one approval until the test lets it go.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    await page.route(
      (url) => new RegExp(`/v1/approvals/${demo?.approvalId ?? ''}$`).test(url.pathname),
      async (route) => {
        held += 1;
        await gate;
        await route.continue();
      }
    );

    await page.goto('/approvals');
    expect(page.url().startsWith(APP_ORIGIN)).toBe(true);
    await expect(page.getByTestId('mock-banner')).toContainText('Mock token');

    // The refund approval is in the queue, from another origin, over the stream or the poll.
    // The brief's 2 s, timed from the page's load (the approval already exists then: the agent paused
    // before the page opened, so this is the page's own latency, not the agent-to-page time).
    const loaded = Date.now();
    await expect(rowOf(page)).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - loaded).toBeLessThan(2_000);
    await expect(page.getByText(/Live\./)).toBeVisible({ timeout: 10_000 });

    await rowOf(page).click();
    // The read has not come back: the detail says it is loading and offers nothing to decide with.
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    await expect.poll(() => held).toBe(1);
    // Still waiting after a moment: the page does not offer a decision on a request it has not read.
    await page.waitForTimeout(500);
    await expect(page.getByText('Loading the request…')).toBeVisible();
    // Absent or disabled both mean "nothing to decide with"; an enabled one does not.
    const deny = page.getByRole('button', { name: 'Deny', exact: true });
    for (const button of [approve, deny]) {
      const count = await button.count();
      expect(count === 0 || (await button.first().isDisabled())).toBe(true);
    }
    release();
    await expect(approve).toBeEnabled();
    await expect(deny).toBeEnabled();
    // The detail shows the call: the tool was registered to show its arguments to approvers.
    await expect(page.getByText('A-7').first()).toBeVisible();

    await approve.click();
    await expect(page.getByText('Approved. The request has left your queue.')).toBeVisible();

    // Read before afterEach stops the mock: a stream cut by a stopped server is the browser's own message.
    expect(await problems()).toEqual([]);

    expect(await demo.exited).toBe(0);
    expect(demo.approvalState()).toBe('consumed');
    expect(demo.lines().filter((l) => l.includes('"worker_resumed"'))).toHaveLength(1);
  });

  test('deny: the approval is rejected and there is no refund', async ({ page }) => {
    const problems = await watch(page);
    demo = await startBrowserDemo('deny', APP_ORIGIN);
    await page.goto('/approvals');
    await rowOf(page).click();
    const deny = page.getByRole('button', { name: 'Deny', exact: true });
    await expect(deny).toBeEnabled();
    await page.getByLabel('Reason (optional)').fill('Not for this order.');
    await deny.click();
    await expect(page.getByText('Denied. The request has left your queue.')).toBeVisible();
    expect(await problems()).toEqual([]);
    expect(await demo.exited).toBe(0);
    expect(demo.approvalState()).toBe('rejected');
  });

  for (const [what, expected] of [
    ['arguments', { expectedRefund: { order_id: 'A-7', amount_cents: 1 } }],
    ['tool', { expectedToolRef: 'ext:billing:issue_other' }],
  ] as const)
    test(`an approval whose resumption names other ${what} is not consumed`, async ({ page }) => {
      const problems = await watch(page);
      demo = await startBrowserDemo('approve', APP_ORIGIN, expected);
      await page.goto('/approvals');
      await rowOf(page).click();
      const approve = page.getByRole('button', { name: 'Approve', exact: true });
      await expect(approve).toBeEnabled();
      await approve.click();
      await expect(page.getByText('Approved. The request has left your queue.')).toBeVisible();
      expect(await problems()).toEqual([]);
      // The agent read the resumption, found it names a different refund, and stopped before consuming.
      expect(await demo.exited).toBe(1);
      expect(demo.approvalState()).toBeUndefined();
      expect(demo.lines().filter((l) => l.includes('"worker_resumed"'))).toHaveLength(0);
      expect(
        demo.lines().some((l) => l.includes('does not name the refund the agent asked for'))
      ).toBe(true);
    });
});
