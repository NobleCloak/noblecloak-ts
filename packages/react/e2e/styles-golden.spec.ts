/**
 * The golden proof that building `dist/styles.css` from `@noblecloak/theme`'s tokens changed nothing a host can see:
 * a page with the module's markup is loaded once with the stylesheet 0.4.2 shipped (`test-fixtures/styles-0.4.2.css`,
 * the old `src/styles.css` that the build copied verbatim) and once with the built `dist/styles.css`, and the
 * computed styles of the module's elements must be equal. That runs in five modes (light; `data-nc-theme="dark"`
 * on an ancestor; `prefers-color-scheme: dark` with no attribute; `prefers-color-scheme: dark` with
 * `data-nc-theme="light"` on an ancestor; `data-nc-theme="dark"` on the `.nc-root` element itself), once with a
 * host bridge that sets the eight inputs on the module's wrapper and once with none of them set (the defaults).
 *
 * Since the modules render the theme's primitives, the module rules for a bare `button` and `textarea`, for the
 * `.nc-error` block, the tab pair and the detail's border are gone (`SUPERSEDED`): the primitives' own rules style
 * those elements, and `e2e/modules.spec.ts` checks them on the real markup. Those elements, and what sits inside a
 * bare button here, are left out of the comparison; `code` and `.nc-json` now use the theme's monospace
 * (`--nc-font-mono`), so their `font-family` is too. Everything else must still be equal, the variables included.
 *
 * The page is served by `page.route` from one made-up origin, the pattern of `packages/theme/e2e/harness.ts`
 * (copied, not imported: that harness serves the theme's own fixture bundle and waits for it), so nothing listens
 * on a port and any request to another origin is aborted and fails the test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const ORIGIN = 'http://nc.test';
const PACKAGE = resolve(import.meta.dirname, '..');
const GOLDEN = join(PACKAGE, 'test-fixtures', 'styles-0.4.2.css');
/** The stylesheet under test: the built `dist/styles.css`, unless `NC_REACT_STYLES_CSS` names another file. */
const BUILT = process.env.NC_REACT_STYLES_CSS ?? join(PACKAGE, 'dist', 'styles.css');

/**
 * A host's bridge: the eight inputs mapped onto the host's own semantic variables, on the module's wrapper and
 * never on `:root`, `html` or `body`, and with no `data-nc-theme` (the shape of an embedding host's block). The
 * host's variables are on `:root`, as a host's design system would put them.
 */
const BRIDGE_CSS = `
:root {
  --background: #fbfaf7;
  --foreground: #20242a;
  --muted-foreground: #5b6270;
  --border: #d4d0c8;
  --primary: #2f55d4;
  --destructive: #c92a2a;
  --radius-sm: 6px;
  --font-sans: Georgia, serif;
}
.approvals-module {
  --nc-bg: var(--background);
  --nc-fg: var(--foreground);
  --nc-muted: var(--muted-foreground);
  --nc-border: var(--border);
  --nc-accent: var(--primary);
  --nc-danger: var(--destructive);
  --nc-radius: var(--radius-sm);
  --nc-font-sans: var(--font-sans);
}`;

/** A representative set of the module's elements, each marked `data-el` for sampling. */
const MODULE_MARKUP = `
<div class="nc-root nc-approvals" data-el="root">
  <ul class="nc-rows" data-el="rows">
    <li><button type="button" class="nc-row" aria-current="true" data-el="row">
      <span class="nc-row-tool" data-el="row-tool">tool.call</span>
      <span class="nc-muted" data-el="muted">2 minutes ago</span>
    </button></li>
  </ul>
  <p class="nc-live" data-el="live">
    <span class="nc-row-tool" data-el="row-tool-alone">tool.call</span>
    <span class="nc-muted" data-el="muted-alone">2 minutes ago</span>
  </p>
  <div class="nc-batch" data-el="batch">2 chosen</div>
  <section class="nc-detail" data-el="detail">
    <h3 tabindex="-1" data-el="h3">Approve tool.call?</h3>
    <p class="nc-muted" data-el="muted-text">Requested by an agent</p>
    <div class="nc-tabs"><button type="button" aria-pressed="true" data-el="tab">Arguments</button></div>
    <dl class="nc-facts" data-el="facts">
      <div class="nc-fact" data-el="fact"><dt data-el="dt">Tool</dt><dd data-el="dd">tool.call</dd></div>
    </dl>
    <pre class="nc-json" data-el="json">{"a": 1}</pre>
    <p class="nc-error" role="alert" data-el="error">Something went wrong</p>
    <div class="nc-actions">
      <label data-el="label">Reason <textarea data-el="textarea">because</textarea></label>
      <div class="nc-buttons"><button type="button" data-el="button">Approve</button></div>
    </div>
  </section>
</div>`;

/**
 * Elements whose 0.4.2 rules the theme's primitives superseded (the bare `button` and `textarea`, the `.nc-error`
 * block, the tab pair, the detail's border) and the spans inside a bare button, which inherit from it. The
 * row's own text classes (`.nc-row-tool`, `.nc-muted`) are still compared, on copies outside the button
 * (`row-tool-alone`, `muted-alone`).
 */
const SUPERSEDED: ReadonlySet<string> = new Set([
  'row',
  'row-tool',
  'muted',
  'tab',
  'button',
  'textarea',
  'error',
  'detail',
]);

/** The properties compared on every sampled element. */
const PROPERTIES = [
  'color',
  'background-color',
  'border-top-color',
  'border-top-left-radius',
  'font-family',
  'outline-color',
] as const;

/** The internal variables 0.4.2 declared, compared on the root: the module rules read only these. */
const VARIABLES = [
  '--nc-i-bg',
  '--nc-i-fg',
  '--nc-i-muted',
  '--nc-i-border',
  '--nc-i-accent',
  '--nc-i-danger',
  '--nc-i-radius',
] as const;

/**
 * `attribute-dark` and `media-light-override` put `data-nc-theme` on the `#host` ancestor; `own-dark` puts
 * `data-nc-theme="dark"` on the `.nc-root` element itself. `media-dark` and `media-light-override` emulate
 * `prefers-color-scheme: dark`.
 */
type Mode = 'light' | 'attribute-dark' | 'media-dark' | 'media-light-override' | 'own-dark';
type Snapshot = Record<string, Record<string, string>>;

interface Case {
  readonly mode: Mode;
  readonly bridge: boolean;
}

/** Serves the page with `stylesheet` as the module's stylesheet and returns every off-origin request it made. */
async function open(page: Page, stylesheet: string, { mode, bridge }: Case): Promise<string[]> {
  const external: string[] = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      external.push(url.href);
      await route.abort();
      return;
    }
    if (url.pathname === '/styles.css') {
      await route.fulfill({ contentType: 'text/css', body: readFileSync(stylesheet) });
      return;
    }
    if (url.pathname === '/') {
      const wrapper = [
        bridge ? 'class="approvals-module"' : '',
        mode === 'attribute-dark' ? 'data-nc-theme="dark"' : '',
        mode === 'media-light-override' ? 'data-nc-theme="light"' : '',
      ].join(' ');
      const markup =
        mode === 'own-dark'
          ? MODULE_MARKUP.replace('data-el="root"', 'data-el="root" data-nc-theme="dark"')
          : MODULE_MARKUP;
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Host</title>
<style>${bridge ? BRIDGE_CSS : ''}</style><link rel="stylesheet" href="/styles.css"></head>
<body><div id="host" ${wrapper}>${markup}</div></body></html>`,
      });
      return;
    }
    await route.fulfill({ status: 404, body: 'not found' });
  });
  const dark = mode === 'media-dark' || mode === 'media-light-override';
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
  await page.goto(`${ORIGIN}/`);
  // A focused textarea always matches :focus-visible, so the accent-coloured ring is sampled too.
  await page.locator('[data-el="textarea"]').focus();
  return external;
}

/** `getComputedStyle` of every `[data-el]` element for `PROPERTIES`, and of the root for `VARIABLES`. */
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(
    ({ properties, variables }) => {
      const out: Record<string, Record<string, string>> = {};
      for (const element of document.querySelectorAll('[data-el]')) {
        const style = getComputedStyle(element);
        const row: Record<string, string> = {};
        for (const property of properties) row[property] = style.getPropertyValue(property);
        if (element.getAttribute('data-el') === 'root') {
          for (const variable of variables) row[variable] = style.getPropertyValue(variable).trim();
        }
        out[element.getAttribute('data-el') ?? ''] = row;
      }
      return out;
    },
    { properties: [...PROPERTIES], variables: [...VARIABLES] }
  );
}

/** `snapshot` without the superseded elements and without the monospace `font-family` of `.nc-json`. */
function comparable(taken: Snapshot | undefined): Snapshot {
  const out: Snapshot = {};
  for (const [element, row] of Object.entries(taken ?? {})) {
    if (SUPERSEDED.has(element)) continue;
    out[element] =
      element === 'json'
        ? Object.fromEntries(Object.entries(row).filter(([property]) => property !== 'font-family'))
        : row;
  }
  return out;
}

/** The root's background in each case with the golden file: shows the stylesheet loaded and the mode took. */
const EXPECTED_ROOT_BACKGROUND: Record<Mode, { bridge: string; defaults: string }> = {
  light: { bridge: 'rgb(251, 250, 247)', defaults: 'rgb(255, 255, 255)' },
  'attribute-dark': { bridge: 'rgb(251, 250, 247)', defaults: 'rgb(18, 18, 18)' },
  'media-dark': { bridge: 'rgb(251, 250, 247)', defaults: 'rgb(18, 18, 18)' },
  'media-light-override': { bridge: 'rgb(251, 250, 247)', defaults: 'rgb(255, 255, 255)' },
  'own-dark': { bridge: 'rgb(251, 250, 247)', defaults: 'rgb(18, 18, 18)' },
};

const MODES: readonly Mode[] = [
  'light',
  'attribute-dark',
  'media-dark',
  'media-light-override',
  'own-dark',
];

const CASES: readonly Case[] = MODES.flatMap((mode) => [
  { mode, bridge: true },
  { mode, bridge: false },
]);

test.beforeAll(() => {
  if (!existsSync(BUILT)) throw new Error(`${BUILT} is missing: run \`bun run build\` first`);
});

for (const testCase of CASES) {
  const name = `${testCase.mode}, ${testCase.bridge ? "the bridge's eight set" : 'none of the eight set'}`;

  test(`computed styles equal 0.4.2's: ${name}`, async ({ browser }) => {
    const snapshots: Snapshot[] = [];
    for (const stylesheet of [GOLDEN, BUILT]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const external = await open(page, stylesheet, testCase);
      snapshots.push(await snapshot(page));
      expect(external, 'requests off the page origin').toEqual([]);
      await context.close();
    }
    const [golden, built] = snapshots.map((taken) => comparable(taken));
    // The positive control: the golden stylesheet applied, in the mode the case names.
    expect(golden?.root?.['background-color']).toBe(
      EXPECTED_ROOT_BACKGROUND[testCase.mode][testCase.bridge ? 'bridge' : 'defaults']
    );
    expect(Object.keys(golden ?? {}).length).toBeGreaterThan(10);
    expect(built).toEqual(golden);
  });
}
