import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUDGET_BYTES, checkSize, formatReport } from '../../tools/check-size.js';
import {
  classNames,
  nonTokenSelectors,
  remoteReferences,
  unscopedSelectors,
} from '../../tools/css-scope.js';
import { parseRules } from '../../tools/tokens.js';

const PACKAGE = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(PACKAGE, path), 'utf8');
const tokens = read('src/styles/tokens.css');
const components = read('src/styles/components.css');
const fonts = read('src/styles/fonts.css');
const reactStyles = read('../react/src/styles.css');
const MAIN = { 'tokens.css': tokens, 'components.css': components };

describe('scope: nothing reaches outside .nc-root', () => {
  it.each(Object.entries(MAIN))('%s: every selector starts at .nc-root', (_, css) => {
    expect(parseRules(css).length).toBeGreaterThan(0);
    expect(unscopedSelectors(css)).toEqual([]);
  });

  it.each(Object.entries(MAIN))('%s: no html, body, :root or universal selector', (_, css) => {
    const selectors = parseRules(css).map((rule) => rule.selector);
    for (const selector of selectors)
      expect(selector).not.toMatch(/(^|[\s,>+~])(html|body|:root|\*)(?=$|[\s,.:[>+~])/);
  });

  it('a primitive rule targets a theme class, never a bare element under the root', () => {
    for (const rule of parseRules(components)) {
      if (rule.atRule.startsWith('@keyframes')) continue;
      for (const selector of rule.selector.split(', ')) {
        // The root itself: its own rule, and the one that keeps the `hidden` attribute working.
        if (selector === '.nc-root' || selector === '.nc-root[hidden]') continue;
        expect(selector, selector).toMatch(/^\.nc-root \.nc-[\w-]+/);
      }
    }
  });

  it("uses no class name of @noblecloak/react's module rules (other than the root)", () => {
    const ours = classNames(components);
    // The module's plain-element reset (`all: revert`, zero specificity) names `nc-ui` to keep resetting the
    // primitives and `nc-toggle` among the classes it leaves to a replacement; it sets no look of its own, so it
    // is not a module rule on a theme class. Every other rule of the module stylesheet is.
    const rules = parseRules(reactStyles);
    const isReset = (body: string) => /^\s*all:\s*revert;?\s*$/.test(body);
    expect(rules.filter((rule) => isReset(rule.body))).toHaveLength(1);
    const theirs = classNames(
      rules
        .filter((rule) => !isReset(rule.body))
        .map((rule) => `${rule.selector} {}`)
        .join('\n')
    );
    expect(ours.size).toBeGreaterThan(20);
    expect(theirs.size).toBeGreaterThan(15);
    expect([...ours].filter((name) => name !== 'nc-root' && theirs.has(name))).toEqual([]);
  });

  it('tokens.css uses only the token contract selectors', () => {
    expect(nonTokenSelectors(tokens)).toEqual([]);
    expect(nonTokenSelectors('.nc-root ~ p { color: red } .nc-root { --nc-x: 1 }')).toEqual([
      '.nc-root ~ p',
    ]);
  });

  it('the scope checks catch what they are meant to', () => {
    expect(unscopedSelectors('body { margin: 0 } .nc-root .x, button { color: red }')).toEqual([
      'body',
      '.nc-root .x',
      'button',
    ]);
    // A host sibling of the root, a class that only starts with nc-root, and a child of the root that is not ours.
    expect(
      unscopedSelectors(
        '.nc-root ~ p, .nc-root + p, .nc-root-shell h1, .nc-root > p, .nc-root p { color: red }'
      )
    ).toEqual(['.nc-root ~ p', '.nc-root + p', '.nc-root-shell h1', '.nc-root > p', '.nc-root p']);
    expect(
      unscopedSelectors(
        ".nc-root, .nc-root.nc-root, .nc-root[hidden], [data-nc-theme='dark'] .nc-root .nc-btn { color: red }"
      )
    ).toEqual([]);
    expect(unscopedSelectors('@keyframes spin { to { rotate: 1turn } }')).toEqual([]);
  });
});

describe('no network, no reset of the host, no layers', () => {
  it.each(Object.entries(MAIN))('%s has no remote import, remote url or font face', (_, css) => {
    expect(remoteReferences(css)).toEqual([]);
  });

  it.each(Object.entries(MAIN))('%s has no @import and no @layer', (_, css) => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/@import/);
    expect(code).not.toMatch(/@layer/);
  });

  it('fonts.css is the one stylesheet with a remote import, and it only sets the two families, as fallbacks', () => {
    expect(remoteReferences(fonts)).toContain(String(/@import\b/i));
    expect(fonts).not.toMatch(/@font-face/);
    const declarations = parseRules(fonts).flatMap((rule) =>
      rule.body
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => d.split(':')[0])
    );
    expect(declarations).toEqual(['font-family', '--nc-i-font-mono']);
    // Fallbacks only: the host's inputs, wherever they are set, come first.
    expect(fonts).toContain('var(--nc-font-sans, ');
    expect(fonts).toContain('var(--nc-font-mono, ');
    expect(unscopedSelectors(fonts)).toEqual([]);
  });

  it('remoteReferences catches each form', () => {
    expect(remoteReferences("@import url('/a.css');")).toEqual([String(/@import\b/i)]);
    expect(remoteReferences("a { background: url('http://x.test/a.png') }")).not.toEqual([]);
    expect(remoteReferences('@font-face { font-family: x; src: local(x) }')).toHaveLength(1);
    expect(remoteReferences('a { background: url(data:image/png;base64,AA) }')).toEqual([]);
    expect(remoteReferences('a { background: url(/local.png) }')).toEqual([]);
  });

  // The design system's built CSS (shared-design-system 0.4.0, dist/index.css) opens with a minified bare-string
  // import of this shape: no `url(` and no space after `@import`.
  it.each([
    [
      'minified bare-string import',
      '@import"https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400&display=swap";',
    ],
    ['spaced bare-string import', '@import "https://a.test/b.css";'],
    ['protocol-relative import', "@import '//a.test/b.css';"],
    ['protocol-relative url()', 'a { background: url(//cdn.test/a.png) }'],
    ['unquoted https url()', 'a { background: url( https://cdn.test/a.png) }'],
    ['quoted URL outside url()', 'a { background-image: image-set("https://cdn.test/a.png" 1x) }'],
  ])('remoteReferences catches a %s', (_, css) => {
    expect(remoteReferences(css)).not.toEqual([]);
  });
});

describe('size budget', () => {
  it('index.css (tokens then components) is under 20 KB gzip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-theme-size-'));
    const file = join(dir, 'index.css');
    writeFileSync(file, `${tokens}\n${components}`);
    const report = checkSize(file);
    expect(report.ok).toBe(true);
    expect(report.gzipBytes).toBeLessThan(BUDGET_BYTES);
    expect(formatReport(report)).toMatch(/KB gzip \(budget 20\.00 KB gzip\) OK$/);
  });

  it('fails over the budget, and on a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-theme-size-'));
    const file = join(dir, 'big.css');
    writeFileSync(file, 'x'.repeat(4096));
    const report = checkSize(file, 10);
    expect(report.ok).toBe(false);
    expect(formatReport(report, 10)).toMatch(/OVER BUDGET$/);
    expect(() => checkSize(join(dir, 'missing.css'))).toThrow('missing (build first)');
  });
});
