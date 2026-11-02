import { startMock } from '@noblecloak/spec';
import type { RunningMock } from '@noblecloak/spec';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { APP_ORIGIN } from '../playwright.config.js';

/**
 * The permissions page in a browser against a fresh mock per test, which the test starts itself on the mock's port
 * with the app's origin allowed: the table shows the two seeded policies, an administrator sets a cell, simulates the
 * draft (an organisation-subject policy, so it applies to the caller and the decision shows), publishes it, and the
 * table shows the published version. Every test here holds for any app the `skills/permissions` skill wires.
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

/** The cell of `tool` in the column headed `column`. */
async function cell(page: Page, tool: string, column: string): Promise<Locator> {
  const table = page.getByRole('table', { name: /Tool policies by role/ });
  // The table renders after the policies are read; its headers are read once it is there.
  await expect(table).toBeVisible();
  const headers = await table.locator('thead th').allTextContents();
  const index = headers.indexOf(column);
  expect(index).toBeGreaterThan(0);
  return table
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: tool, exact: true }) })
    .locator(':scope > *')
    .nth(index);
}

test('the table shows the seeded policies', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/permissions');
  await expect(page.getByTestId('mock-banner')).toContainText('Mock token');
  await expect(page.getByRole('table', { name: /Tool policies by role/ })).toBeVisible();
  await expect(await cell(page, 'mcp:tracker:search', 'member')).toContainText(
    'Ask the members before a call · v3'
  );
  await expect(await cell(page, 'mcp:tracker:add_comment', 'member')).toContainText(
    'Ask before a comment · v3'
  );
  await expect(await cell(page, 'mcp:tracker:list_labels', 'Organisation')).toContainText(
    'No policy'
  );
  expect(problems()).toEqual([]);
});

test('an administrator sets a cell, simulates the draft, publishes it, and the table shows it', async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto('/permissions');
  const target = await cell(page, 'mcp:tracker:list_labels', 'Organisation');
  await target
    .getByRole('combobox', { name: 'No policy for Organisation on mcp:tracker:list_labels' })
    .selectOption('deny');
  await expect(target).toContainText('Draft pending v1');

  await page
    .getByRole('button', { name: 'Simulate Organisation · mcp:tracker:list_labels' })
    .click();
  await expect(page.getByRole('heading', { name: 'Simulated as you' })).toBeVisible();
  await page.getByRole('button', { name: 'Simulate', exact: true }).click();
  await expect(page.getByText('Decision: deny')).toBeVisible();
  await expect(
    page.getByText('The decision names policy Organisation · mcp:tracker:list_labels v1.')
  ).toBeVisible();
  await expect(page.getByText('Dry run — nothing was enforced.')).toBeVisible();

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText(/^Published v1\. Enforcement follows/).first()).toBeVisible();
  await expect(target).toHaveAttribute('data-state', 'governed');
  await expect(target.locator('.nc-perm-mode')).toHaveText('Deny');
  await expect(target).toContainText('Organisation · mcp:tracker:list_labels · v1');
  expect(problems()).toEqual([]);
});
