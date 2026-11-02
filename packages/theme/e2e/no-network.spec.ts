/**
 * No network: the built stylesheet holds no remote import, remote url or font face, and loading it with a
 * module mounted makes no request off the page's origin. Each control (a stylesheet with a remote font import,
 * one per import form) must fail both.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { remoteReferences } from '../tools/css-scope.js';
import {
  injectStylesheet,
  mount,
  NO_NETWORK_CONTROLS,
  openHostPage,
  THEME_CSS,
} from './harness.js';

const TOKENS_CSS = join(import.meta.dirname, '..', 'dist', 'tokens.css');

test('the theme stylesheet (dist/index.css) and dist/tokens.css carry no remote reference', () => {
  for (const file of [THEME_CSS, TOKENS_CSS]) {
    expect(remoteReferences(readFileSync(file, 'utf8')), file).toEqual([]);
  }
});

test('loading the theme and mounting a module makes no external request', async ({ page }) => {
  const served = await openHostPage(page, { hostile: true });
  await injectStylesheet(page, '/theme/index.css');
  await mount(page, { demo: 'gallery', dialogOpen: true });
  await page.waitForLoadState('networkidle');
  expect(served.external).toEqual([]);
});

for (const [index, controlFile] of NO_NETWORK_CONTROLS.entries()) {
  test(`control (${controlFile}): the static scan and the request record both catch a remote import`, async ({
    page,
  }) => {
    // A control with nothing to catch proves nothing, so it fails rather than skips.
    expect(
      remoteReferences(readFileSync(controlFile, 'utf8')),
      'the static scan finds no remote reference in this control'
    ).not.toEqual([]);
    const served = await openHostPage(page);
    await injectStylesheet(page, `/no-network-control-${String(index)}.css`);
    await page.waitForLoadState('networkidle');
    expect(served.external.length, 'the page made no external request').toBeGreaterThan(0);
  });
}
