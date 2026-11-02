/**
 * The modules on a host page, in a real browser, rendered from the built `dist/` with the built
 * `dist/styles.css`:
 *
 * - Hostile host: the host's own elements (its `h1`, `button`, `input` and the rest) compute the same styles
 *   before and after the stylesheet loads and the modules mount, on a hostile page and on a plain one; and the
 *   modules' elements compute the same styles on the hostile page as on the plain one, with the queue rows, the
 *   reason box and the decision buttons visible and focusable.
 * - One Button replaces every button: with `Button` replaced through `NcProvider` or a module's `components`
 *   prop, each module (and the queue and detail in their render-failure state) shows as many replaced buttons as
 *   its default render shows native ones, and no native button of the theme is left, on the hostile page.
 * - A builder Button's own classed elements keep the builder's rules under the module's plain-element reset, and
 *   so do a builder's shadcn-style Card and Alert that merge the module's class (`nc-detail`, `nc-error`) into
 *   their own, with the builder's rules unlayered and loaded first, or in a cascade layer.
 * - A queue row, the open request's row and the detail keep their pinned look (layout, padding, borders).
 * - The Pending/Recent tabs row keeps its height with a short detail and a tall one (noblecloak-ui#55).
 * - Focus: a primitive shows the theme's ring (2px, --nc-ring); the detail heading the module's (3px, accent).
 * - Re-theme by `--nc-*` only: a stylesheet that sets only `--nc-*` names on the modules' wrapper changes the
 *   colours and radius of the Button, Textarea, Alert, Card and Tabs elements the modules render.
 *
 * `NC_REACT_STYLES_CSS` points the module stylesheet at another file, which is how the mutations are run.
 */
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

import type { MountOptions } from './fixture/main.js';
import {
  differences,
  injectStylesheet,
  mount,
  openHostPage,
  snapshotHost,
  snapshotModule,
} from './harness.js';

const MODULES: readonly MountOptions['module'][] = [
  'approvals',
  'request',
  'status',
  'permissions',
  'connections',
];

async function mountAll(page: Page, extra: Omit<MountOptions, 'module'> = {}): Promise<void> {
  for (const module of MODULES) await mount(page, { module, ...extra });
}

for (const hostile of [true, false]) {
  test(`the host's own elements are untouched (${hostile ? 'hostile' : 'plain'} host)`, async ({
    page,
  }) => {
    const { external } = await openHostPage(page, hostile);
    const before = await snapshotHost(page);
    expect(Object.keys(before).length).toBeGreaterThan(12);
    await injectStylesheet(page, '/react/styles.css');
    await mountAll(page);
    // The stylesheet applied: a module button is the theme's (an accent fill), not the browser's.
    await expect(page.locator('#nc-mount .nc-btn[data-variant="primary"]').first()).toHaveCSS(
      'border-top-left-radius',
      '4px'
    );
    const after = await snapshotHost(page);
    expect(differences(before, after)).toEqual([]);
    expect(external).toEqual([]);
  });
}

test('the modules render on a hostile host as on a plain one', async ({ browser }) => {
  const snapshots = [];
  for (const hostile of [false, true]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { external } = await openHostPage(page, hostile);
    await injectStylesheet(page, '/react/styles.css');
    await mountAll(page);
    const rows = page.locator('#nc-mount .nc-row');
    await expect(rows).toHaveCount(3);
    const focusable = [
      rows.first(),
      page.getByRole('textbox', { name: 'Reason (optional)' }),
      page.getByRole('button', { name: 'Approve', exact: true }),
      page.getByRole('button', { name: 'Deny', exact: true }),
    ];
    for (const control of focusable) {
      await expect(control).toBeVisible();
      await control.focus();
      await expect(control).toBeFocused();
    }
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    snapshots.push(await snapshotModule(page));
    expect(external).toEqual([]);
    await context.close();
  }
  const [plain, hostile] = snapshots;
  expect(Object.keys(plain ?? {}).length).toBeGreaterThan(80);
  expect(differences(plain ?? {}, hostile ?? {})).toEqual([]);
});

/** The modules the Button check mounts: the three, and the queue and detail in their render-failure state. */
const BUTTON_MODULES: readonly MountOptions['module'][] = [...MODULES, 'fallback'];

/** Per mounted module (in `BUTTON_MODULES` order): its native buttons, and those marked as replaced. */
async function buttonCounts(
  browser: Browser,
  replaceButton: NonNullable<MountOptions['replaceButton']>
): Promise<{ native: number; replaced: number; unreplaced: string[] }[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openHostPage(page, true);
  await injectStylesheet(page, '/react/styles.css');
  for (const module of BUTTON_MODULES) await mount(page, { module, replaceButton });
  const counts = await page.evaluate(() =>
    [...document.querySelectorAll('#nc-mount')].map((mounted) => ({
      native: mounted.querySelectorAll('button').length,
      replaced: mounted.querySelectorAll('[data-replaced]').length,
      unreplaced: [...mounted.querySelectorAll('button:not([data-replaced])')].map(
        (button) => button.outerHTML
      ),
    }))
  );
  await context.close();
  return counts;
}

test('one Button replaces every button of every module (hostile host)', async ({ browser }) => {
  const plain = await buttonCounts(browser, false);
  expect(plain.map((row) => row.replaced)).toEqual(BUTTON_MODULES.map(() => 0));
  for (const row of plain) expect(row.native).toBeGreaterThan(0);
  for (const how of ['provider', 'prop'] as const) {
    const replaced = await buttonCounts(browser, how);
    // Every button the default render shows is the replacement, module by module, so fewer cannot pass.
    expect(
      replaced.map((row) => row.replaced),
      how
    ).toEqual(plain.map((row) => row.native));
    expect(
      replaced.flatMap((row) => row.unreplaced),
      how
    ).toEqual([]);
  }
});

test("a builder Button's own classed elements keep the builder's rules (hostile host)", async ({
  page,
}) => {
  await openHostPage(page, true);
  await injectStylesheet(page, '/builder.css');
  await injectStylesheet(page, '/react/styles.css');
  await mountAll(page, { replaceButton: 'builder' });
  const labels = page.locator('#nc-mount .nc-root .b-label');
  expect(await labels.count()).toBeGreaterThan(8);
  const styles = await labels.evaluateAll((spans) =>
    spans.map((span) => {
      const style = getComputedStyle(span);
      return [style.display, style.paddingLeft, style.letterSpacing, style.textTransform].join(' ');
    })
  );
  expect(new Set(styles)).toEqual(new Set(['inline-block 7px 3px uppercase']));
});

/** The builder's rules for its Card and Alert (`BUILDER_CSS`), as computed styles. */
const BUILDER_PANELS = {
  card: '2px solid rgb(255, 0, 0) rgb(255, 192, 203)',
  alert: '5px dashed rgb(0, 128, 0) rgb(255, 255, 0) rgb(0, 0, 255)',
};

// A layered builder sheet loses to any unlayered rule, the hostile host's `* { all: unset }` among them, so the
// layered case runs on a plain host: what it checks is that the module stylesheet does not undo the builder.
for (const [sheet, hostile] of [
  ['/builder.css', true],
  ['/builder-layered.css', false],
] as const) {
  test(`a builder's Card and Alert that merge the module's class keep the builder's rules (${sheet})`, async ({
    page,
  }) => {
    await openHostPage(page, hostile);
    await injectStylesheet(page, sheet);
    await injectStylesheet(page, '/react/styles.css');
    await mountAll(page, { replacePanels: true });
    const looks = async (selector: string, alert: boolean): Promise<string[]> =>
      page.locator(`#nc-mount .nc-root ${selector}`).evaluateAll(
        (elements, withColor) =>
          elements.map((element) => {
            const style = getComputedStyle(element);
            const parts = [
              style.borderTopWidth,
              style.borderTopStyle,
              style.borderTopColor,
              style.backgroundColor,
            ];
            if (withColor) parts.push(style.color);
            return parts.join(' ');
          }),
        alert
      );
    // The module's class is on the builder's element, so the module still lays it out.
    const cards = await looks('.b-card.nc-detail', false);
    const alerts = await looks('.b-alert.nc-error', true);
    expect(cards.length).toBeGreaterThan(0);
    expect(alerts.length).toBeGreaterThan(1);
    expect(new Set(cards)).toEqual(new Set([BUILDER_PANELS.card]));
    expect(new Set(alerts)).toEqual(new Set([BUILDER_PANELS.alert]));
    await expect(page.locator('#nc-mount .nc-root .b-card.nc-detail').first()).toHaveCSS(
      'padding-top',
      '16px'
    );
  });
}

/**
 * The look of a queue row (the theme's secondary Button laid out as lines, left-aligned, wrapping), of the open
 * request's row and of the detail (the theme's Card, padded by the module), pinned: the 0.4.2 golden spec no
 * longer compares these elements.
 */
const PINNED: Record<string, Record<string, string>> = {
  '.nc-rows li:nth-child(2) .nc-row': {
    display: 'grid',
    'justify-items': 'start',
    'text-align': 'start',
    'white-space': 'normal',
    'padding-top': '6px',
    'padding-left': '10px',
    'border-top-width': '1px',
    'border-top-style': 'solid',
    'border-top-left-radius': '4px',
    'font-weight': '400',
  },
  // The open request's row: marked by a border width and style, not colour alone.
  ".nc-row[aria-current='true']": {
    'border-top-width': '3px',
    'border-top-style': 'double',
  },
  '.nc-detail': {
    display: 'block',
    'padding-top': '16px',
    'padding-left': '16px',
    'border-top-width': '1px',
    'border-top-style': 'solid',
    'border-top-left-radius': '4px',
  },
};

for (const hostile of [false, true]) {
  test(`a queue row and the detail keep their look (${hostile ? 'hostile' : 'plain'} host)`, async ({
    page,
  }) => {
    await openHostPage(page, hostile);
    await injectStylesheet(page, '/react/styles.css');
    await mount(page, { module: 'approvals' });
    const seen = await page.evaluate((pinned) => {
      const out: Record<string, Record<string, string>> = {};
      for (const [selector, properties] of Object.entries(pinned)) {
        const element = document.querySelector(`#nc-mount ${selector}`);
        const style = element === null ? null : getComputedStyle(element);
        out[selector] = Object.fromEntries(
          Object.keys(properties).map((property) => [
            property,
            style?.getPropertyValue(property) ?? 'missing',
          ])
        );
      }
      return out;
    }, PINNED);
    expect(seen).toEqual(PINNED);
  });
}

/** The detail's height for the tabs-row check: a short one, and one far taller than the queue column. */
const DETAIL_HEIGHTS = {
  short: '#nc-mount .nc-root .nc-detail { height: 40px; overflow: hidden; }',
  tall: '#nc-mount .nc-root .nc-detail { min-height: 1500px; }',
} as const;

for (const hostile of [false, true]) {
  test(`the tabs row keeps its height whatever the detail's height (${hostile ? 'hostile' : 'plain'} host)`, async ({
    browser,
  }) => {
    const seen: Record<string, { tabsRow: number; tabs: number; detail: number; column: number }> =
      {};
    for (const [name, rule] of Object.entries(DETAIL_HEIGHTS)) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await openHostPage(page, hostile);
      await injectStylesheet(page, '/react/styles.css');
      await mount(page, { module: 'approvals' });
      await page.addStyleTag({ content: rule });
      seen[name] = await page.evaluate(() => {
        const root = document.querySelector('#nc-mount .nc-approvals');
        const box = (selector: string): DOMRect => {
          const element = root?.querySelector(selector);
          if (element === null || element === undefined) throw new Error(`${selector} is missing`);
          return element.getBoundingClientRect();
        };
        const tabs = box('.nc-tabs');
        const queue = box('.nc-queue');
        return {
          // The tabs row: from the tabs' top to the queue's top, so a row grown past the tabs shows as a gap.
          tabsRow: queue.top - tabs.top,
          tabs: tabs.height,
          detail: box('.nc-detail').height,
          column: queue.bottom - tabs.top,
        };
      });
      await context.close();
    }
    const { short, tall } = seen;
    // The fixture reaches the case: the tall detail is taller than the tabs and the queue together, the short one not.
    expect(tall?.detail).toBe(1500);
    expect(tall?.detail).toBeGreaterThan(tall?.column ?? Infinity);
    expect(short?.detail).toBe(40);
    expect(short?.tabs).toBeGreaterThan(0);
    expect(tall?.tabs).toBe(short?.tabs);
    expect(tall?.tabsRow).toBe(short?.tabsRow);
  });
}

test("focus: a primitive draws the theme's 2px ring, the detail heading the module's 3px accent ring", async ({
  page,
}) => {
  await openHostPage(page, true);
  await injectStylesheet(page, '/react/styles.css');
  await injectStylesheet(page, '/retheme-all.css');
  await mount(page, { module: 'approvals', wrapperClass: 'nc-retheme' });
  const ring = async (selector: string): Promise<string> => {
    await page.locator(`#nc-mount ${selector}`).focus();
    return page.evaluate((s) => {
      const element = document.querySelector(`#nc-mount ${s}`);
      if (element?.matches(':focus-visible') !== true) return 'not focus-visible';
      const style = getComputedStyle(element);
      return `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`;
    }, selector);
  };
  // --nc-ring and --nc-accent are set apart by the re-theme, so the two rings are told apart by colour too.
  expect(await ring('.nc-textarea')).toBe('2px solid rgb(0, 163, 163)');
  expect(await ring('.nc-detail > h3')).toBe('3px solid rgb(138, 43, 226)');
});

/** The elements re-theme samples: a Button, Textarea, Alert, Card and Tabs element from each module. */
const SAMPLED = [
  ['approvals', '.nc-approvals .nc-toggle-group'],
  ['approvals', ".nc-approvals .nc-toggle[aria-pressed='true']"],
  ['approvals', '.nc-approvals .nc-row'],
  ['approvals', ".nc-approvals .nc-btn[data-variant='primary']"],
  ['approvals', '.nc-approvals .nc-textarea'],
  ['approvals', '.nc-approvals .nc-alert'],
  ['approvals', '.nc-approvals .nc-card'],
  ['request', '.nc-approvals .nc-card'],
  ['request', '.nc-approvals .nc-btn'],
  ['status', '.nc-action-status .nc-alert'],
  ['status', '.nc-action-status .nc-btn'],
  ['connections', ".nc-connections-detail .nc-btn[data-variant='secondary']"],
] as const;

const COLOURS = [
  'color',
  'background-color',
  'border-top-color',
  'border-top-left-radius',
] as const;

type Paint = Record<string, Record<string, string>>;

/** The sampled colours and radius; each module is mounted in its own `#nc-mount`, in `MODULES` order. */
async function paint(page: Page): Promise<Paint> {
  const sampled = SAMPLED.map(([module, selector]) => [MODULES.indexOf(module), selector] as const);
  return page.evaluate(
    ({ pairs, properties }) => {
      const out: Record<string, Record<string, string>> = {};
      const mounts = [...document.querySelectorAll('#nc-mount')];
      for (const [position, selector] of pairs) {
        const key = `${String(position)} ${selector}`;
        const element = mounts[position]?.querySelector(selector);
        if (element === null || element === undefined) {
          out[key] = { missing: 'true' };
          continue;
        }
        const style = getComputedStyle(element);
        out[key] = Object.fromEntries(
          properties.map((property) => [property, style.getPropertyValue(property)])
        );
      }
      return out;
    },
    { pairs: sampled, properties: [...COLOURS] }
  );
}

test('re-theme by --nc-* only, on the hostile host: the eight, then the additions', async ({
  page,
}) => {
  await openHostPage(page, true);
  await injectStylesheet(page, '/react/styles.css');
  await mountAll(page, { wrapperClass: 'nc-retheme' });
  const before = await paint(page);
  expect(Object.values(before).filter((row) => 'missing' in row)).toEqual([]);

  await injectStylesheet(page, '/retheme-eight.css');
  const eight = await paint(page);
  for (const [key, row] of Object.entries(eight)) {
    for (const property of ['background-color', 'border-top-color', 'border-top-left-radius']) {
      expect(row[property], `${key} ${property}`).not.toBe(before[key]?.[property]);
    }
  }
  // A filled control's text is the accent's foreground, an addition; every other sampled text changes with --nc-fg.
  const recoloured = Object.entries(eight).filter(([key, row]) => row.color !== before[key]?.color);
  expect(recoloured.length).toBeGreaterThanOrEqual(SAMPLED.length - 2);

  await injectStylesheet(page, '/retheme-all.css');
  const all = await paint(page);
  for (const [key, row] of Object.entries(all)) {
    for (const property of COLOURS) {
      expect(row[property], `${key} ${property}`).not.toBe(before[key]?.[property]);
    }
  }
});
