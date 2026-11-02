/**
 * The module end-to-end harness: a host page served by `page.route` from one made-up origin (the pattern of
 * `packages/theme/e2e/harness.ts`), so nothing listens on a port and any request to another origin is recorded and
 * aborted. The hostile host stylesheet is the theme's own (`packages/theme/demo/hostile.css`, read in place, not
 * copied); the sampled property list is copied from the theme's harness, which is bound to the theme's fixture.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Page } from '@playwright/test';

import type { MountOptions } from './fixture/main.js';

export const ORIGIN = 'http://nc.test';
const PACKAGE = resolve(import.meta.dirname, '..');

/** The module stylesheet: the built `dist/styles.css`, unless `NC_REACT_STYLES_CSS` names another file (a mutation). */
export const STYLES_CSS = process.env.NC_REACT_STYLES_CSS ?? join(PACKAGE, 'dist', 'styles.css');

/** The theme's hostile host: a universal `all: unset`, a preflight-style reset, loud element rules, utilities. */
export const HOSTILE_CSS = join(PACKAGE, '..', 'theme', 'demo', 'hostile.css');

/**
 * A host's re-theme: `--nc-*` names only, set on the module's wrapper (`.nc-retheme`). The eight inputs first; the
 * theme's additions second.
 */
export const RETHEME_EIGHT = `
.nc-retheme {
  --nc-bg: #fff7e6;
  --nc-fg: #2b1d0e;
  --nc-muted: #6b4f2a;
  --nc-border: #c08a3e;
  --nc-accent: #8a2be2;
  --nc-danger: #d11a6b;
  --nc-radius: 13px;
  --nc-font-sans: Georgia, serif;
}`;

export const RETHEME_ADDITIONS = `
.nc-retheme {
  --nc-accent-fg: #fffbe0;
  --nc-danger-fg: #fff0f5;
  --nc-surface: #fdf0d5;
  --nc-subtle: #f3e1bf;
  --nc-ring: #00a3a3;
  --nc-font-mono: 'Courier New', monospace;
}`;

/**
 * A builder's own stylesheet for its replacement Button, Card and Alert (one class per rule, as a utility or
 * component class is), loaded before the module stylesheet so the module's rules would win any tie.
 */
export const BUILDER_CSS = `
.b-label {
  display: inline-block;
  padding-left: 7px;
  letter-spacing: 3px;
  text-transform: uppercase;
}
.b-card {
  border: 2px solid rgb(255, 0, 0);
  background-color: rgb(255, 192, 203);
}
.b-alert {
  border: 5px dashed rgb(0, 128, 0);
  background-color: rgb(255, 255, 0);
  color: rgb(0, 0, 255);
}`;

/** The same rules in a cascade layer, as Tailwind v4 emits utilities: any unlayered rule beats them. */
export const BUILDER_LAYERED_CSS = `@layer utilities {${BUILDER_CSS}\n}`;

const FILES: Record<string, { body: () => string | Buffer; type: string }> = {
  '/builder.css': { body: () => BUILDER_CSS, type: 'text/css' },
  '/builder-layered.css': { body: () => BUILDER_LAYERED_CSS, type: 'text/css' },
  '/react/styles.css': { body: () => readFileSync(STYLES_CSS), type: 'text/css' },
  '/hostile.css': { body: () => readFileSync(HOSTILE_CSS), type: 'text/css' },
  '/retheme-eight.css': { body: () => RETHEME_EIGHT, type: 'text/css' },
  '/retheme-all.css': { body: () => `${RETHEME_EIGHT}\n${RETHEME_ADDITIONS}`, type: 'text/css' },
  '/fixture.js': {
    body: () => readFileSync(join(import.meta.dirname, '.build', 'fixture.global.js')),
    type: 'text/javascript',
  },
};

/** The host's own markup: the elements whose styles the host check samples, each marked `data-host`. */
const HOST_MARKUP = `
<header data-host="header" class="flex p-4 bg-background rounded border">
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
  <textarea data-host="textarea" aria-label="Host textarea">host</textarea>
  <label data-host="label">Host label</label>
  <ul data-host="ul"><li data-host="li">Item</li></ul>
</main>`;

export interface ServedPage {
  /** Every request the page made to an origin other than ORIGIN. */
  readonly external: string[];
}

/** Opens a host page on ORIGIN, with the hostile stylesheet when asked. The module stylesheet is not loaded. */
export async function openHostPage(page: Page, hostile: boolean): Promise<ServedPage> {
  const external: string[] = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      external.push(url.href);
      await route.abort();
      return;
    }
    if (url.pathname === '/') {
      const sheet = hostile ? '<link rel="stylesheet" href="/hostile.css">' : '';
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Host</title>${sheet}</head><body>${HOST_MARKUP}<script src="/fixture.js"></script></body></html>`,
      });
      return;
    }
    const file = FILES[url.pathname];
    if (file === undefined) {
      await route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    await route.fulfill({ contentType: file.type, body: file.body() });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => 'ncReact' in window);
  return { external };
}

/** Adds a stylesheet to the page and waits for it to finish loading or fail. */
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

/** Mounts a module into a fresh `#nc-mount` and waits for its root. */
export async function mount(page: Page, options: MountOptions): Promise<void> {
  await page.evaluate((o) => {
    window.ncReact.mount(o);
  }, options);
  await page.locator('#nc-mount .nc-root').last().waitFor();
}

/** The properties compared (copied from `packages/theme/e2e/harness.ts`, `SAMPLED_PROPERTIES`). */
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

export type StyleSnapshot = Record<string, Record<string, string>>;

/** `getComputedStyle` of html, body and every `[data-host]` element, for the sampled properties. */
export async function snapshotHost(page: Page): Promise<StyleSnapshot> {
  return page.evaluate(
    (properties) => {
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
        for (const property of properties) row[property] = style.getPropertyValue(property);
        out[name] = row;
      }
      return out;
    },
    [...SAMPLED_PROPERTIES]
  );
}

/**
 * `getComputedStyle` of every element inside each mounted module root (not the root itself, whose box a host may
 * style through `className`), keyed by its position, tag and classes. Font family is left out: the module inherits
 * the host's on purpose.
 */
export async function snapshotModule(page: Page): Promise<StyleSnapshot> {
  return page.evaluate(
    (properties) => {
      const out: Record<string, Record<string, string>> = {};
      document.querySelectorAll('#nc-mount .nc-root *').forEach((element, index) => {
        const style = getComputedStyle(element);
        const row: Record<string, string> = {};
        for (const property of properties) row[property] = style.getPropertyValue(property);
        out[
          `${String(index)} ${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`
        ] = row;
      });
      return out;
    },
    SAMPLED_PROPERTIES.filter((property) => property !== 'font-family')
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
