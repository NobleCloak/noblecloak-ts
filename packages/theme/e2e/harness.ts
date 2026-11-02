/**
 * The end-to-end harness. Every page is served by `page.route` from one made-up origin, so nothing listens on a
 * port and any request to another origin is recorded and aborted: the no-network test reads that record, and
 * no test can reach the internet.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Page } from '@playwright/test';

import type { MountOptions } from './fixture/main.js';

export const ORIGIN = 'http://nc.test';
const PACKAGE = resolve(import.meta.dirname, '..');

/**
 * The stylesheet a negative control loads in place of the theme: by default `fixtures/leaky-control.css`,
 * which reproduces the design system's three leaks; `NC_THEME_CONTROL_CSS` points it at another file, such as
 * the design system's own built `dist/index.css`.
 */
export const CONTROL_CSS =
  process.env.NC_THEME_CONTROL_CSS ?? join(import.meta.dirname, 'fixtures', 'leaky-control.css');

/**
 * The no-network controls, one per import form: `CONTROL_CSS` (an `@import url(...)`) and
 * `fixtures/string-import-control.css` (the minified bare-string `@import"https://..."`). With
 * `NC_THEME_CONTROL_CSS` set, only that file.
 */
export const NO_NETWORK_CONTROLS: readonly string[] =
  process.env.NC_THEME_CONTROL_CSS !== undefined
    ? [CONTROL_CSS]
    : [CONTROL_CSS, join(import.meta.dirname, 'fixtures', 'string-import-control.css')];

/**
 * The stylesheet served as the theme: `dist/index.css`, unless `NC_THEME_CSS` names another file. Pointing it at
 * a leaky stylesheet (the design system's `dist/index.css`) shows the leak, inward and no-network tests failing
 * (README, "The leak guarantee", records the run).
 */
export const THEME_CSS = process.env.NC_THEME_CSS ?? join(PACKAGE, 'dist', 'index.css');

const FILES: Record<string, { path: string; type: string }> = {
  '/theme/index.css': { path: THEME_CSS, type: 'text/css' },
  '/theme/fonts.css': { path: join(PACKAGE, 'dist', 'fonts.css'), type: 'text/css' },
  '/control.css': { path: CONTROL_CSS, type: 'text/css' },
  ...Object.fromEntries(
    NO_NETWORK_CONTROLS.map((path, index) => [
      `/no-network-control-${String(index)}.css`,
      { path, type: 'text/css' },
    ])
  ),
  '/hostile.css': { path: join(PACKAGE, 'demo', 'hostile.css'), type: 'text/css' },
  '/brand.css': { path: join(PACKAGE, 'demo', 'builder-brand.css'), type: 'text/css' },
  '/fixture.js': {
    path: join(import.meta.dirname, '.build', 'fixture.global.js'),
    type: 'text/javascript',
  },
};

/**
 * The host's own markup: the elements whose styles the leak test samples, each marked `data-host`. The header
 * carries a class that only starts with `nc-root`, and `#nc-host-slot` holds the paragraphs a `besideHost`
 * mount puts the root between, so a sibling or prefix selector in the theme shows up as a change.
 */
const HOST_MARKUP = `
<header data-host="header" class="nc-root-shell flex p-4 bg-background rounded border">
  <h1 data-host="h1">Builder's app</h1>
  <span data-host="utility" class="text-primary">Signed in</span>
</header>
<main data-host="main">
  <h2 data-host="h2">Orders</h2>
  <p data-host="p">Some text with <a data-host="a" href="#orders">a link</a>.</p>
  <button data-host="button" type="button" class="btn">Host button</button>
  <button data-host="button-plain" type="button">Plain button</button>
  <input data-host="input" type="text" value="host input" aria-label="Host input">
  <input data-host="checkbox" type="checkbox" aria-label="Host checkbox">
  <select data-host="select" aria-label="Host select"><option>One</option></select>
  <textarea data-host="textarea" aria-label="Host textarea">host</textarea>
  <label data-host="label">Host label</label>
  <ul data-host="ul"><li data-host="li">Item</li></ul>
  <table data-host="table"><tbody><tr><td data-host="td">Cell</td></tr></tbody></table>
  <section id="nc-host-slot" data-host="slot">
    <p data-host="sibling-before">Before the module</p>
    <p data-host="sibling-after">After the module</p>
  </section>
</main>`;

export interface PageOptions {
  /** Load the hostile host stylesheet first (false). */
  readonly hostile?: boolean;
  /** Load the builder's brand stylesheet (false). */
  readonly brand?: boolean;
}

export interface ServedPage {
  /** Every request the page made to an origin other than ORIGIN. */
  readonly external: string[];
}

/** Opens a host page on ORIGIN. The theme is not loaded; `injectStylesheet` adds it. */
export async function openHostPage(page: Page, options: PageOptions = {}): Promise<ServedPage> {
  const external: string[] = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      external.push(url.href);
      await route.abort();
      return;
    }
    if (url.pathname === '/') {
      const sheets = [
        options.hostile === true ? '/hostile.css' : null,
        options.brand === true ? '/brand.css' : null,
      ]
        .filter((href): href is string => href !== null)
        .map((href) => `<link rel="stylesheet" href="${href}">`)
        .join('\n');
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Host</title>${sheets}</head><body>${HOST_MARKUP}<script src="/fixture.js"></script></body></html>`,
      });
      return;
    }
    const file = FILES[url.pathname];
    if (file === undefined) {
      await route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    await route.fulfill({ contentType: file.type, body: readFileSync(file.path) });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => 'ncFixture' in window);
  return { external };
}

/** Adds a stylesheet to the page and waits for it (and its own imports) to finish loading or fail. */
export async function injectStylesheet(page: Page, href: string): Promise<void> {
  await page.evaluate(
    (url) =>
      new Promise<void>((done) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        link.addEventListener('load', () => {
          done();
        });
        link.addEventListener('error', () => {
          done();
        });
        document.head.append(link);
      }),
    href
  );
}

export async function mount(page: Page, options: MountOptions): Promise<void> {
  await page.evaluate((o) => {
    window.ncFixture.mount(o);
  }, options);
  await page
    .locator(options.besideHost === true ? '#nc-host-slot > .nc-root' : '#nc-mount .nc-root')
    .last()
    .waitFor();
}

/** The properties compared: what a reset, an element rule or a theme leak would change. */
export const SAMPLED_PROPERTIES = [
  'display',
  'box-sizing',
  'position',
  'color',
  'background-color',
  'background-image',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-left-width',
  'border-left-color',
  'border-top-left-radius',
  'padding-top',
  'padding-left',
  'margin-top',
  'margin-left',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-decoration-line',
  'text-align',
  'white-space',
  'vertical-align',
  'cursor',
  'opacity',
  'visibility',
  'outline-style',
  'appearance',
] as const;

/**
 * Layout, stacking and shadow properties, sampled on the theme's elements only (the inward test): on the host's
 * elements a mounted module legitimately changes sizes, `body`'s height for one.
 */
export const PRIMITIVE_LAYOUT_PROPERTIES = [
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'padding-right',
  'padding-bottom',
  'margin-right',
  'margin-bottom',
  'border-right-width',
  'border-bottom-width',
  'gap',
  'row-gap',
  'column-gap',
  'flex-direction',
  'flex-wrap',
  'align-items',
  'justify-content',
  'grid-template-columns',
  'overflow-x',
  'overflow-y',
  'z-index',
  'box-shadow',
  'transform',
  'outline-color',
  'outline-width',
] as const;

/** Custom properties a leaky theme would set on the host's root. */
export const SAMPLED_VARIABLES = [
  '--background',
  '--foreground',
  '--primary',
  '--border',
  '--radius',
  '--nc-background',
  '--ncbg',
] as const;

export type StyleSnapshot = Record<string, Record<string, string>>;

/** `getComputedStyle` of html, body and every `[data-host]` element, for the sampled properties and variables. */
export async function snapshotHost(page: Page): Promise<StyleSnapshot> {
  return page.evaluate(
    ({ properties, variables }) => {
      const out: Record<string, Record<string, string>> = {};
      const elements: [string, Element][] = [
        ['html', document.documentElement],
        ['body', document.body],
        ...[...document.querySelectorAll('[data-host]')].map(
          (element) => [element.getAttribute('data-host') ?? '', element] as [string, Element]
        ),
      ];
      for (const [name, element] of elements) {
        const style = getComputedStyle(element);
        const row: Record<string, string> = {};
        for (const property of [...properties, ...variables])
          row[property] = style.getPropertyValue(property);
        out[name] = row;
      }
      return out;
    },
    { properties: [...SAMPLED_PROPERTIES], variables: [...SAMPLED_VARIABLES] }
  );
}

/**
 * `getComputedStyle` of every theme element (`.nc-ui`) inside the mount, keyed by its position and classes, for
 * the sampled and the layout properties. Font family is left out: the module inherits the host's on purpose.
 * The layout properties are skipped on an element that contains the slot demo's builder button: that button
 * is the builder's markup, which the host's rules reach by design, so its size (and its container's) may move.
 * A theme element inside a builder button (the DataTable sort glyph, when the sort header is the builder's
 * button) inherits from that button, so it is not sampled at all.
 */
export async function snapshotPrimitives(page: Page): Promise<StyleSnapshot> {
  return page.evaluate(
    ({ properties, layout }) => {
      const out: Record<string, Record<string, string>> = {};
      document.querySelectorAll('#nc-mount .nc-ui').forEach((element, index) => {
        if (element.closest('[data-builder-button]') !== null) return;
        const style = getComputedStyle(element);
        const row: Record<string, string> = {};
        const sampled =
          element.querySelector('[data-builder-button]') === null
            ? [...properties, ...layout]
            : properties;
        for (const property of sampled) row[property] = style.getPropertyValue(property);
        out[
          `${String(index)} ${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`
        ] = row;
      });
      return out;
    },
    {
      properties: SAMPLED_PROPERTIES.filter((property) => property !== 'font-family'),
      layout: [...PRIMITIVE_LAYOUT_PROPERTIES],
    }
  );
}

/** The rows and properties where two snapshots differ, as `key property: before -> after`. */
export function differences(before: StyleSnapshot, after: StyleSnapshot): string[] {
  const found: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key] ?? {};
    const b = after[key] ?? {};
    for (const property of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[property] !== b[property])
        found.push(`${key} ${property}: ${a[property] ?? '(none)'} -> ${b[property] ?? '(none)'}`);
    }
  }
  return found;
}

/**
 * Every element inside the mounted root that lacks `nc-ui`, as `parent classes > tag.classes`, other than `<option>` (drawn by
 * the browser) and the slot demo's replacement buttons (`data-builder-button`), which are the builder's markup.
 */
export async function unmarkedElements(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#nc-mount .nc-root *:not(.nc-ui, option)')]
      .filter((element) => element.closest('[data-builder-button]') === null)
      .map(
        (element) =>
          `${element.parentElement?.className ?? ''} > ${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`
      )
  );
}
