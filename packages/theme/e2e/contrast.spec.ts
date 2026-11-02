/**
 * Contrast: axe-core's color-contrast rule over every primitive in the gallery, with the default light and dark
 * palettes and with the builder's brand file (which sets only the eight shipped names), and over the open
 * ConfirmDialog and the open Tooltip (both hidden in the default state, where axe skips them). axe exempts
 * disabled controls from the rule, so the gallery's disabled and loading buttons are not checked.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { MountOptions } from './fixture/main.js';
import { injectStylesheet, mount, openHostPage } from './harness.js';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

interface AxeResult {
  violations: { id: string; nodes: { target: string[]; failureSummary?: string }[] }[];
  passes: { id: string; nodes: unknown[] }[];
}

async function contrast(page: Page, selector: string): Promise<AxeResult> {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(
    (context) =>
      (window as unknown as { axe: { run: (c: string, o: object) => Promise<AxeResult> } }).axe.run(
        context,
        {
          runOnly: { type: 'rule', values: ['color-contrast'] },
        }
      ),
    selector
  );
}

const CASES: [string, MountOptions, { brand?: boolean }][] = [
  ['default light', { demo: 'gallery', theme: 'light' }, {}],
  ['default dark', { demo: 'gallery', theme: 'dark' }, {}],
  [
    'builder brand (eight names only)',
    { demo: 'gallery', theme: 'light', wrapperClass: 'builder-brand' },
    { brand: true },
  ],
];

for (const [name, options, page_] of CASES) {
  test(`${name}: every primitive passes color-contrast`, async ({ page }) => {
    await openHostPage(page, page_);
    await injectStylesheet(page, '/theme/index.css');
    await mount(page, options);
    const result = await contrast(page, '#nc-mount');
    const checked = result.passes.find((rule) => rule.id === 'color-contrast')?.nodes.length ?? 0;
    expect(checked).toBeGreaterThan(30);
    expect(
      result.violations.flatMap((v) =>
        v.nodes.map((n) => `${n.target.join(' ')}: ${n.failureSummary ?? ''}`)
      )
    ).toEqual([]);
  });

  test(`${name}: the open ConfirmDialog passes color-contrast`, async ({ page }) => {
    await openHostPage(page, page_);
    await injectStylesheet(page, '/theme/index.css');
    await mount(page, { ...options, dialogOpen: true });
    const result = await contrast(page, '#nc-mount dialog');
    expect(result.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' ')))).toEqual([]);
  });

  test(`${name}: the open Tooltip passes color-contrast`, async ({ page }) => {
    await openHostPage(page, page_);
    await injectStylesheet(page, '/theme/index.css');
    await mount(page, options);
    await page.getByRole('button', { name: 'Approve selected' }).focus();
    await expect(page.getByRole('tooltip')).toBeVisible();
    const result = await contrast(page, '#nc-mount [role="tooltip"]');
    const checked = result.passes.find((rule) => rule.id === 'color-contrast')?.nodes.length ?? 0;
    expect(checked).toBe(1);
    expect(result.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' ')))).toEqual([]);
  });
}
