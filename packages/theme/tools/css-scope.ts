/**
 * Static checks on the theme's stylesheets, shared by the unit tests (on `src/styles`) and the end-to-end
 * suite (on the built `dist/index.css`, and on a control stylesheet that must fail them).
 */
import { parseRules } from './tokens.js';

/**
 * What makes a stylesheet fetch something or reach outside its root: any `@import` (the `url(...)` form and the
 * bare-string form, minified `@import"https://..."` included), a `url()` of an absolute or protocol-relative
 * URL, a quoted absolute or protocol-relative URL anywhere (an `image-set("https://...")`, say), and any
 * `@font-face`. Comments are scanned too, so a commented-out reference also fails.
 */
export const REMOTE_PATTERNS: readonly RegExp[] = [
  /@import\b/i,
  /url\(\s*['"]?\s*(?:[a-z][a-z\d+.-]*:)?\/\//i,
  /['"]\s*(?:https?:)?\/\//i,
  /@font-face/i,
];

/** The remote references in `css`, one string per pattern that matched. */
export function remoteReferences(css: string): string[] {
  return REMOTE_PATTERNS.filter((pattern) => pattern.test(css)).map(String);
}

/**
 * The root's compound selector: `.nc-root` (not `.nc-root-shell`), optionally repeated or qualified by
 * attribute selectors and `:not(...)`.
 */
const ROOT = String.raw`\.nc-root(?![\w-])(?:\.nc-root(?![\w-])|\[[^\]]*\]|:not\((?:[^()]|\([^()]*\))*\))*`;

/**
 * A scoped selector: the root (optionally under `[data-nc-theme='dark']`), alone or followed by a descendant
 * combinator and a theme class. A sibling or child combinator after the root (`.nc-root ~ p`) reaches the
 * host's elements, so it is not scoped.
 */
const SCOPED = new RegExp(String.raw`^(?:\[data-nc-theme='dark'\] )?${ROOT}(?:$| \.nc-[\w-])`);

/**
 * The only selectors tokens.css may use: the root, and the root in dark mode (by attribute on itself or on an
 * ancestor, or by the system preference when no light attribute is set).
 */
export const TOKEN_SELECTORS: readonly string[] = [
  '.nc-root',
  ".nc-root:not([data-nc-theme='light']):not([data-nc-theme='light'] .nc-root)",
  ".nc-root[data-nc-theme='dark']",
  "[data-nc-theme='dark'] .nc-root",
];

/** The selectors of `css` (split on commas, `@keyframes` left out) that are not in `TOKEN_SELECTORS`. */
export function nonTokenSelectors(css: string): string[] {
  return parseRules(css)
    .filter((rule) => !rule.atRule.startsWith('@keyframes'))
    .flatMap((rule) => rule.selector.split(', '))
    .filter((selector) => !TOKEN_SELECTORS.includes(selector));
}

/** Every selector (split on commas) of a style rule outside `@keyframes` that is not scoped to `.nc-root`. */
export function unscopedSelectors(css: string): string[] {
  return parseRules(css)
    .filter((rule) => !rule.atRule.startsWith('@keyframes'))
    .flatMap((rule) => rule.selector.split(', '))
    .filter((selector) => !SCOPED.test(selector));
}

/** The `nc-*` class names used in `css`'s selectors. */
export function classNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const rule of parseRules(css)) {
    for (const match of rule.selector.matchAll(/\.(nc-[\w-]+)/g)) names.add(match[1] ?? '');
  }
  return names;
}
