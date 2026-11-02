/**
 * Outward leak: importing the theme and rendering a module changes nothing outside the module root. The host
 * page's computed styles (html, body and its own elements, sampled properties and variables) are read before
 * the theme loads and after it has loaded and a module has mounted, and must be identical. The control proves
 * the check can fail: the same steps with a leaky stylesheet must change them.
 */
import { expect, test } from '@playwright/test';

import {
  CONTROL_CSS,
  differences,
  injectStylesheet,
  mount,
  openHostPage,
  snapshotHost,
} from './harness.js';

for (const hostile of [true, false]) {
  test(`theme: no host style changes (${hostile ? 'hostile' : 'plain'} host)`, async ({ page }) => {
    await openHostPage(page, { hostile });
    const before = await snapshotHost(page);
    expect(Object.keys(before).length).toBeGreaterThan(15);
    await injectStylesheet(page, '/theme/index.css');
    await mount(page, { demo: 'gallery', dialogOpen: false });
    await mount(page, { demo: 'slot', theme: 'dark' });
    // The root between two host paragraphs: a sibling selector after `.nc-root` would reach them.
    await mount(page, { demo: 'gallery', besideHost: true });
    const after = await snapshotHost(page);
    expect(differences(before, after)).toEqual([]);
  });
}

test(`control (${CONTROL_CSS}): the same check fails on a leaky stylesheet`, async ({ page }) => {
  await openHostPage(page, { hostile: false });
  const before = await snapshotHost(page);
  await injectStylesheet(page, '/control.css');
  await mount(page, { demo: 'gallery' });
  const after = await snapshotHost(page);
  const changed = differences(before, after);
  test
    .info()
    .annotations.push({ type: 'control differences', description: String(changed.length) });
  expect(changed.length).toBeGreaterThan(0);
});
