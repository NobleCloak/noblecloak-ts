/**
 * Issues 33 and 34 in a real browser, on the built `dist/`: the decision stays on screen under a call far taller
 * than the viewport, and the confirm step is a modal dialog (focus held inside, Escape cancels, the page behind
 * unreachable) that names what is being approved. jsdom has no layout and no native `<dialog>`, so these are the
 * checks that a layout or focus claim rests on.
 *
 * `NC_SHOTS_DIR=<dir>` also saves the screenshots the pull request shows.
 */
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { iso, toolWithSource } from '../src/testing/isolates.js';

import { injectStylesheet, mount, openHostPage } from './harness.js';

const SHOTS = process.env.NC_SHOTS_DIR;

async function open(page: Page, module: 'approvals-decide' | 'approvals-proposal'): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 700 });
  await openHostPage(page, false);
  await injectStylesheet(page, '/react/styles.css');
  await mount(page, { module });
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const inViewport = (page: Page, selector: string): Promise<boolean> =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    });

test('Approve and Deny are on screen, unscrolled, under a call taller than the viewport', async ({
  page,
}) => {
  await open(page, 'approvals-decide');
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  const deny = page.getByRole('button', { name: 'Deny', exact: true });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(height).toBeGreaterThan(1500);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  for (const control of [approve, deny]) {
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  expect(await inViewport(page, '.nc-actions')).toBe(true);
  await shot(page, 'v2-after-detail-long-call-top');

  // Still there at the other end, and in the middle of the call.
  await page.mouse.wheel(0, 700);
  await expect(approve).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await expect(approve).toBeInViewport({ ratio: 1 });
});

test('Approve at the admin level opens a modal that names the request and holds focus', async ({
  page,
}) => {
  await open(page, 'approvals-decide');
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  await approve.click();

  const dialog = page.getByRole('dialog', { name: 'Approve this request?' });
  await expect(dialog).toBeVisible();
  // The asker is the verified requester; the caller's agent hint is never named as the asker.
  await expect(dialog).toContainText(
    `You are about to approve this request: “${iso(`${iso('Planes CRM')} wants to use ${toolWithSource('issue_refund', 'ext:billing')}`)}”.`
  );
  await expect(dialog).not.toContainText('Trusted Finance Agent');
  // ...and the exact reference, so the sentence cannot be the only thing the approver reads.
  await expect(dialog).toContainText(
    `Exact reference: ${iso('ext:billing:issue_refund')}. This request`
  );
  await expect(dialog).toContainText('This request has the admin level.');
  // The first focus lands on the safe choice.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  // The dialog sits in the middle of the viewport (the page's own rules do not move it).
  const box = await dialog.boundingBox();
  const view = page.viewportSize();
  expect(box).not.toBeNull();
  expect(view).not.toBeNull();
  if (box !== null && view !== null) {
    expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThan(3);
    expect(Math.abs(box.y + box.height / 2 - view.height / 2)).toBeLessThan(3);
  }
  await shot(page, 'v2-after-confirm-modal');

  // Tab and Shift+Tab never reach the page behind: focus is in the dialog, or has left the document for the
  // browser's own controls (the document body), which a native modal allows.
  const inside = (): Promise<boolean> =>
    page.evaluate(
      () =>
        document.activeElement === document.body ||
        document.activeElement?.closest('dialog') != null
    );
  for (let press = 0; press < 5; press += 1) {
    await page.keyboard.press('Tab');
    expect(await inside()).toBe(true);
  }
  for (let press = 0; press < 5; press += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
  }

  // The page behind does not take a click.
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();

  // Escape cancels, nothing is decided, and focus is back on Approve.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(approve).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Cancel closes the modal and returns focus to Approve', async ({ page }) => {
  await open(page, 'approvals-decide');
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  await approve.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(approve).toBeFocused();
});

test('a setup proposal reads as one, its raw call is open and collapsible, and the decision is reachable', async ({
  page,
}) => {
  await open(page, 'approvals-proposal');
  const rows = page.locator('#nc-mount .nc-row');
  await expect(rows.first()).toContainText('Policy setup from');
  await expect(rows.first()).toContainText('Planes CRM');
  await expect(rows.first()).toContainText('Review and decide');
  await expect(rows.nth(1)).toContainText(
    `wants to use ${toolWithSource('issue_refund', 'ext:billing')}`
  );
  await expect(rows.nth(1)).toContainText('ext:billing:issue_refund');
  await expect(rows.first()).not.toContainText(/Digest|sp_7d1e/);
  await expect(page.getByRole('heading', { level: 3 })).toContainText('Policy setup from');
  // Open by default: nothing is hidden unless the approver closes it.
  await expect(page.locator('details.nc-call-fold')).toHaveAttribute('open', '');
  await expect(page.locator('details.nc-call-fold pre')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await shot(page, 'v2-after-proposal');
  await page.getByText('Show the full call').click();
  await expect(page.locator('details.nc-call-fold pre')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeInViewport({
    ratio: 1,
  });
});
