/**
 * Forced colours (Windows High Contrast) replace backgrounds and border colours, so a state drawn only with them
 * disappears. The switch's on and off, and the selected tab, must still differ.
 */
import { expect, test } from '@playwright/test';

import { injectStylesheet, mount, openHostPage } from './harness.js';

test('forced colours: switch on and off, and the selected tab, still look different', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await openHostPage(page);
  await injectStylesheet(page, '/theme/index.css');
  await mount(page, { demo: 'gallery' });
  const look = await page.evaluate(() => {
    const paint = (selector: string) => {
      const element = document.querySelector(`#nc-mount ${selector}`);
      if (element === null) throw new Error(`no ${selector}`);
      const style = getComputedStyle(element);
      return { bg: style.backgroundColor, border: style.borderTopColor, fg: style.color };
    };
    return {
      on: paint(".nc-switch[aria-checked='true']"),
      off: paint(".nc-switch[aria-checked='false']"),
      onThumb: paint(".nc-switch[aria-checked='true'] .nc-switch-thumb"),
      offThumb: paint(".nc-switch[aria-checked='false'] .nc-switch-thumb"),
      pressed: paint(".nc-toggle[aria-pressed='true']"),
      unpressed: paint(".nc-toggle[aria-pressed='false']"),
    };
  });
  expect(look.on.bg).not.toBe(look.off.bg);
  // Each thumb stands out from its own track.
  expect(look.onThumb.bg).not.toBe(look.on.bg);
  expect(look.offThumb.bg).not.toBe(look.off.bg);
  expect(look.pressed.bg).not.toBe(look.unpressed.bg);
  expect(look.pressed.fg).not.toBe(look.unpressed.fg);
});
