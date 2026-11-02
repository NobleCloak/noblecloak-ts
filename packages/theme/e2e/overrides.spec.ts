/**
 * How a builder restyles one primitive instance. The scoped reset is `.nc-root .nc-ui` (two classes), which is
 * what keeps a host's element and single-class rules out (the inward test fails with it lowered to `:where()`),
 * so a single-class rule passed through `className` (a utility such as `ml-2`) loses to it. A rule scoped
 * under the root (`.nc-root .my-class`), loaded after the theme, wins, and so does an inline `style`.
 */
import { expect, test } from '@playwright/test';

import { injectStylesheet, mount, openHostPage } from './harness.js';

test('a className rule scoped under .nc-root overrides the theme; a single-class one does not', async ({
  page,
}) => {
  await openHostPage(page);
  await injectStylesheet(page, '/theme/index.css');
  await mount(page, { demo: 'gallery' });
  await page.addStyleTag({
    content: '.utility-ml { margin-left: 11px; } .nc-root .scoped-ml { margin-left: 13px; }',
  });
  const margins = await page.evaluate(() => {
    const [first, second] = [...document.querySelectorAll<HTMLElement>('#nc-mount .nc-btn')];
    if (first === undefined || second === undefined) throw new Error('no buttons');
    first.classList.add('utility-ml');
    second.classList.add('scoped-ml');
    return [getComputedStyle(first).marginLeft, getComputedStyle(second).marginLeft];
  });
  expect(margins).toEqual(['0px', '13px']);
});

test('an inline style overrides the theme', async ({ page }) => {
  await openHostPage(page);
  await injectStylesheet(page, '/theme/index.css');
  await mount(page, { demo: 'gallery' });
  const margin = await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('#nc-mount .nc-btn');
    if (button === null) throw new Error('no button');
    button.style.marginLeft = '17px';
    return getComputedStyle(button).marginLeft;
  });
  expect(margin).toBe('17px');
});
