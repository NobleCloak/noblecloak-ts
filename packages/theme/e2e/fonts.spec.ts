/**
 * The opt-in fonts.css supplies the brand families only as fallbacks: a `--nc-font-sans` or `--nc-font-mono`
 * the host sets on an ancestor (or on the root) still wins, whichever order the two stylesheets load in. Its
 * Google Fonts import is aborted here like every external request; only the cascade is under test.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { injectStylesheet, mount, openHostPage } from './harness.js';

async function families(page: Page): Promise<{ sans: string; mono: string }> {
  return page.evaluate(() => {
    const root = document.querySelector('#nc-mount .nc-root');
    if (root === null) throw new Error('no root');
    return {
      sans: getComputedStyle(root).fontFamily,
      mono: getComputedStyle(root).getPropertyValue('--nc-i-font-mono').trim(),
    };
  });
}

for (const order of ['index.css first', 'fonts.css first'] as const) {
  const sheets =
    order === 'index.css first'
      ? ['/theme/index.css', '/theme/fonts.css']
      : ['/theme/fonts.css', '/theme/index.css'];

  test(`fonts.css (${order}): the brand families apply when the host sets none`, async ({
    page,
  }) => {
    await openHostPage(page);
    for (const sheet of sheets) await injectStylesheet(page, sheet);
    await mount(page, { demo: 'gallery' });
    const { sans, mono } = await families(page);
    expect(sans).toMatch(/^['"]?Space Grotesk['"]?,/);
    expect(mono).toMatch(/^['"]?JetBrains Mono['"]?,/);
  });

  test(`fonts.css (${order}): a family the host sets on an ancestor wins`, async ({ page }) => {
    await openHostPage(page, { brand: true });
    for (const sheet of sheets) await injectStylesheet(page, sheet);
    await page.addStyleTag({ content: '.builder-brand { --nc-font-mono: Courier, monospace; }' });
    await mount(page, { demo: 'gallery', wrapperClass: 'builder-brand' });
    const { sans, mono } = await families(page);
    expect(sans).toMatch(/^Georgia,/);
    expect(mono).toMatch(/^Courier,/);
  });
}
