import { startMock } from '@noblecloak/spec';
import type { RunningMock } from '@noblecloak/spec';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { APP_ORIGIN } from '../playwright.config.js';

/**
 * The connections page in a browser against a fresh mock per test, which the test starts itself on the mock's port
 * with the app's origin allowed (so an OAuth consent may return to the page): an administrator registers a tool server,
 * refreshes its tools, links a credential of their own with consent, and completes an OAuth link through the mock's
 * consent page, which returns the browser to the page with the result. Every test here holds for any app the
 * `skills/connections` skill wires.
 */

const mockPort = Number(process.env.NC_MOCK_PORT ?? '8787');

let mock: RunningMock | undefined;
test.beforeEach(async () => {
  mock = await startMock({ port: mockPort, control: true, allowedOrigins: [APP_ORIGIN] });
});
test.afterEach(async ({ context }) => {
  // The browser keeps its connections to the mock open; closing them first lets the server close.
  await context.close();
  await mock?.stop();
  mock = undefined;
});

/** Records every error the page throws or logs. */
function watch(page: Page): () => string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  return () => problems;
}

/** Registers a server through the page's form, and waits for it to open. */
async function register(page: Page, name: string, url: string, auth: string): Promise<void> {
  await page.getByRole('button', { name: 'Register a server' }).click();
  const form = page.getByRole('form', { name: 'Register a tool server' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Server URL').fill(url);
  await form.getByLabel('How the server authenticates callers').selectOption(auth);
  await form.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

test('an administrator registers a server, refreshes its tools and links a token with consent', async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto('/connections');
  await expect(page.getByTestId('mock-banner')).toContainText('Mock token');
  await expect(page.getByText('No tool servers are registered.')).toBeVisible();

  await register(page, 'Tracker', 'https://tracker.example.com/mcp', 'bearer');
  await page.getByRole('button', { name: 'Refresh tools' }).click();
  await expect(
    page.getByText('The server offers 2 tools: 2 added, 0 withdrawn, 0 active again.')
  ).toBeVisible();
  const tools = page.getByRole('table', { name: 'Tools of Tracker' });
  await expect(tools.getByText('Registered', { exact: true })).toHaveCount(2);

  const mine = page.getByRole('region', { name: 'My credential' });
  await expect(mine.getByText('You have not linked a credential.')).toBeVisible();
  await mine.getByRole('button', { name: 'Link my account' }).click();
  const consent = mine.getByRole('form', { name: 'Your consent' });
  await consent.getByLabel('My bearer token').fill('tracker-token-of-the-admin');
  const submit = consent.getByRole('button', { name: 'Link with my consent' });
  await expect(submit).toBeDisabled();
  await consent.getByRole('checkbox', { name: 'I consent to this use of my credential' }).check();
  await submit.click();
  await expect(mine.getByTestId('nc-conn-my-state')).toHaveText(/^Your credential is linked/);
  // The token is in no part of the page once sent.
  expect(await page.content()).not.toContain('tracker-token-of-the-admin');
  expect(problems()).toEqual([]);
});

test('an OAuth link leaves for the consent page and comes back with the result', async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto('/connections');
  await register(page, 'Docs', 'https://docs.example.com/mcp', 'oauth');
  const mine = page.getByRole('region', { name: 'My credential' });
  await mine.getByRole('button', { name: 'Link my account' }).click();
  const consent = mine.getByRole('form', { name: 'Your consent' });
  await consent.getByRole('checkbox', { name: 'I consent to this use of my credential' }).check();
  await consent.getByRole('button', { name: 'Consent and continue to authorize' }).click();
  // The mock's consent page completes it and sends the browser back to this page, which reads the result once.
  await page.waitForURL(/\/connections$/);
  await expect(page.getByText('Authorization of Docs completed.')).toBeVisible();
  await page.getByRole('button', { name: 'Open Docs' }).first().click();
  await expect(
    page.getByRole('region', { name: 'My credential' }).getByTestId('nc-conn-my-state')
  ).toHaveText(/^Your credential is linked/);
  expect(problems()).toEqual([]);
});
