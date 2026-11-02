/**
 * The native dialog's behaviour in a real browser, where Escape fires real `cancel` events. Chromium marks the
 * cancel not cancelable after repeated Escapes without a user activation in between, so the dialog closes
 * whatever the page does; jsdom has no such rule.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { injectStylesheet, mount, openHostPage } from './harness.js';

declare global {
  interface Window {
    /** How many `[role="alert"]` elements were added inside the mount's dialog since `watchForAlerts`. */
    ncAlertsDrawn?: number;
  }
}

/**
 * Counts every alert React adds inside the dialog from now on, even one that is gone again by the time the test
 * looks (opening the dialog again clears the error), so "never drawn" does not depend on when the DOM is read.
 */
async function watchForAlerts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dialog = document.querySelector('#nc-mount dialog');
    if (dialog === null) throw new Error('no dialog');
    window.ncAlertsDrawn = 0;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (
            node instanceof Element &&
            (node.matches('[role="alert"]') || node.querySelector('[role="alert"]') !== null)
          )
            window.ncAlertsDrawn = (window.ncAlertsDrawn ?? 0) + 1;
    }).observe(dialog, { childList: true, subtree: true });
  });
}

/** Opens the gallery's confirm dialog and starts a confirm that stays pending until `rejectConfirm`. */
async function startPendingConfirm(page: Page) {
  await openHostPage(page);
  await injectStylesheet(page, '/theme/index.css');
  await mount(page, { demo: 'gallery', dialogOpen: true, pendingConfirm: true });
  const dialog = page.getByRole('dialog', { name: 'Deny the refund?' });
  await expect(dialog).toBeVisible();
  await watchForAlerts(page);
  await dialog.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Deny', exact: true })).toHaveAttribute(
    'aria-busy',
    'true'
  );
  return dialog;
}

/** Fails the pending confirm, then opens the dialog again; the failure must reach onError and nothing else. */
async function rejectThenReopen(page: Page, dialog: ReturnType<Page['getByRole']>): Promise<void> {
  await page.evaluate(() => {
    window.ncFixture.rejectConfirm('server said no');
  });
  await expect
    .poll(() => page.evaluate(() => window.ncFixture.confirmErrors))
    .toEqual(['server said no']);

  // Opening it again is a later React commit than the failure's, so an alert the failure drew is counted by then.
  await page.getByRole('button', { name: 'Deny…' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Deny', exact: true })).not.toHaveAttribute(
    'aria-busy',
    'true'
  );
  // The late failure was never drawn inside the closed dialog.
  expect(await page.evaluate(() => window.ncAlertsDrawn)).toBe(0);
}

test('repeated Escape while a confirm is pending: the forced close is reported, and the dialog reopens', async ({
  page,
}) => {
  const dialog = await startPendingConfirm(page);

  // The first Escape is cancelable, so a pending confirm keeps the dialog open.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  // Keep pressing until Chromium forces the close (its third Escape, as of Chromium 156).
  for (let press = 0; press < 5 && (await dialog.isVisible()); press += 1)
    await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await rejectThenReopen(page, dialog);
});

test('a confirm that fails after the forced close, before its close event is dispatched, is not drawn in the dialog', async ({
  page,
}) => {
  const dialog = await startPendingConfirm(page);
  // Chromium dispatches the close event in a later task than the forced cancel, so the confirm can fail in
  // between (noblecloak-ui#57). Pin that order: a capturing listener on the document runs before the dialog's
  // own, and swallows the close event, so the failure below always lands before the dialog hears of the close.
  await page.evaluate(() => {
    document.addEventListener(
      'close',
      (event) => {
        if (event.target instanceof HTMLDialogElement) event.stopImmediatePropagation();
      },
      { capture: true, once: true }
    );
  });

  for (let press = 0; press < 5 && (await dialog.isVisible()); press += 1)
    await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await rejectThenReopen(page, dialog);
});
