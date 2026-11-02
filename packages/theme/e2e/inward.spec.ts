/**
 * Inward robustness: on the hostile host page the theme's primitives look as they do on a clean page. Every
 * theme element's computed style (sampled properties; font family excepted, which the module inherits on
 * purpose) is compared between the two pages, for the slot demo and for the gallery with its ConfirmDialog
 * open.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { MountOptions } from './fixture/main.js';
import {
  differences,
  injectStylesheet,
  mount,
  openHostPage,
  snapshotPrimitives,
  unmarkedElements,
} from './harness.js';

async function primitivesOn(page: Page, hostile: boolean, options: MountOptions) {
  // Stops the skeleton's pulse and the spinner's turn, so a sample never lands mid-animation.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openHostPage(page, { hostile });
  await injectStylesheet(page, '/theme/index.css');
  await mount(page, options);
  return snapshotPrimitives(page);
}

const CASES: [string, MountOptions][] = [
  ['SlotDemo', { demo: 'slot' }],
  ['gallery with ConfirmDialog open', { demo: 'gallery', dialogOpen: true }],
  ['gallery, dark', { demo: 'gallery', theme: 'dark' }],
];

for (const [name, options] of CASES) {
  test(`${name}: hostile host matches the clean page`, async ({ browser }) => {
    const clean = await browser.newPage();
    const hostile = await browser.newPage();
    const baseline = await primitivesOn(clean, false, options);
    const underFire = await primitivesOn(hostile, true, options);
    expect(Object.keys(baseline).length).toBeGreaterThan(50);
    expect(differences(baseline, underFire)).toEqual([]);
    // The comparison only sees `.nc-ui` elements, so an element without it would be unguarded and unsampled.
    expect(await unmarkedElements(hostile)).toEqual([]);
    await clean.close();
    await hostile.close();
  });
}

test('the dialog is open, modal and inside the root', async ({ page }) => {
  await openHostPage(page, { hostile: true });
  await injectStylesheet(page, '/theme/index.css');
  await mount(page, { demo: 'gallery', dialogOpen: true });
  const dialog = page.getByRole('dialog', { name: 'Deny the refund?' });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate(
      (element) => element.matches(':modal') && element.closest('.nc-root') !== null
    )
  ).toBe(true);
});
