/**
 * Layout that depends on direction or on pointer movement, which jsdom cannot lay out.
 */
import { expect, test } from '@playwright/test';

import { injectStylesheet, mount, openHostPage } from './harness.js';

for (const dir of ['ltr', 'rtl'] as const) {
  test(`switch (${dir}): the checked thumb sits at the inline end of the track`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openHostPage(page);
    await injectStylesheet(page, '/theme/index.css');
    await mount(page, { demo: 'gallery', dir });
    const track = page.getByRole('switch', { name: 'Live updates' });
    await expect(track).toHaveAttribute('aria-checked', 'true');
    const box = await track.evaluate((element, rtl) => {
      const outer = element.getBoundingClientRect();
      const thumb = element.querySelector('.nc-switch-thumb')?.getBoundingClientRect();
      if (thumb === undefined) throw new Error('no thumb');
      return {
        inside: thumb.left >= outer.left && thumb.right <= outer.right,
        startGap: rtl ? outer.right - thumb.right : thumb.left - outer.left,
        endGap: rtl ? thumb.left - outer.left : outer.right - thumb.right,
      };
    }, dir === 'rtl');
    expect(box.inside).toBe(true);
    expect(box.endGap).toBeLessThan(box.startGap);
  });
}

test('tooltip: the tip stays open while the pointer crosses the gap onto it (WCAG 1.4.13, hoverable)', async ({
  page,
}) => {
  await openHostPage(page);
  await injectStylesheet(page, '/theme/index.css');
  await mount(page, { demo: 'gallery' });
  const trigger = page.getByRole('button', { name: 'Approve selected' });
  await trigger.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  const from = await trigger.boundingBox();
  const to = await tip.boundingBox();
  if (from === null || to === null) throw new Error('no box');
  const x = from.x + from.width / 2;
  // Straight up from the trigger's middle, through the gap, to the middle of the tip.
  await page.mouse.move(x, to.y + to.height / 2, { steps: 12 });
  await expect(tip).toBeVisible();
  await page.mouse.move(x, from.y + from.height + 200);
  await expect(tip).toBeHidden();
});

for (const hostile of [false, true]) {
  test(`root (${hostile ? 'hostile' : 'plain'} host): the host can still hide it`, async ({
    page,
  }) => {
    await openHostPage(page, { hostile });
    await injectStylesheet(page, '/theme/index.css');
    await mount(page, { demo: 'gallery' });
    const root = page.locator('#nc-mount .nc-root');
    await expect(root).toBeVisible();
    // The `hidden` attribute on the root itself.
    await root.evaluate((element) => {
      element.toggleAttribute('hidden', true);
    });
    await expect(root).toBeHidden();
    await root.evaluate((element) => {
      element.toggleAttribute('hidden', false);
    });
    // visibility: hidden on an ancestor (a host tab panel, say) reaches the root and its primitives.
    await page.locator('#nc-mount').evaluate((element) => {
      (element as HTMLElement).style.visibility = 'hidden';
    });
    expect(
      await root.evaluate((element) => [
        getComputedStyle(element).visibility,
        getComputedStyle(element.querySelector('.nc-btn') ?? element).visibility,
      ])
    ).toEqual(['hidden', 'hidden']);
  });
}

for (const hostile of [false, true]) {
  test(`primitives (${hostile ? 'hostile' : 'plain'} host): the hidden attribute hides every one`, async ({
    page,
  }) => {
    await openHostPage(page, { hostile });
    await injectStylesheet(page, '/theme/index.css');
    await mount(page, { demo: 'gallery' });
    const result = await page.evaluate(() => {
      const shown: string[] = [];
      // An inline `display` (the gallery's own section layout) beats any rule, as it does for the browser's.
      const elements = [
        ...document.querySelectorAll<HTMLElement>('#nc-mount .nc-root .nc-ui'),
      ].filter((element) => element.style.display === '');
      for (const element of elements) {
        const name = `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`;
        const had = element.getAttribute('hidden');
        element.setAttribute('hidden', '');
        if (getComputedStyle(element).display !== 'none') shown.push(name);
        if (had === null) element.removeAttribute('hidden');
        else element.setAttribute('hidden', had);
      }
      const button = document.querySelector<HTMLElement>('#nc-mount .nc-btn');
      if (button === null) throw new Error('no button');
      button.setAttribute('hidden', 'until-found');
      const untilFound = getComputedStyle(button).display;
      button.removeAttribute('hidden');
      return { count: elements.length, shown, untilFound };
    });
    expect(result.count).toBeGreaterThan(50);
    expect(result.shown).toEqual([]);
    // until-found keeps the box (the browser hides the content), so the button's own display stays.
    expect(result.untilFound).not.toBe('none');
  });
}
