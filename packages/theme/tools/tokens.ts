/**
 * Reads the token contract out of `src/styles/tokens.css` and builds `src/tokens.json` from it. The CSS is the
 * source; the JSON is generated (`bun run tokens:generate`) and `tokens.test.ts` fails when the two disagree.
 *
 * A public token is a `--nc-*` name that a `.nc-root` rule reads with a fallback, as in
 * `--nc-i-bg: var(--nc-bg, #ffffff)` or `font-family: var(--nc-font-sans, inherit)`. Its light default is the
 * fallback in the plain `.nc-root` rules; its dark default is the fallback in the `[data-nc-theme='dark']` rule
 * (the same as light when that rule does not override it). A fallback that reads another token's internal
 * variable (`var(--nc-i-bg)`) is resolved to that token's default for the same mode, so the JSON carries
 * values a builder can copy, never an internal name.
 */

export interface CssRule {
  /** The rule's selector, whitespace collapsed. */
  readonly selector: string;
  /** The enclosing at-rule prelude (`@media (prefers-color-scheme: dark)`), or '' at the top level. */
  readonly atRule: string;
  readonly body: string;
}

export interface TokenDeclaration {
  /** The property the rule sets: an internal `--nc-i-*` variable, or `font-family`. */
  readonly property: string;
  /** The public input it reads, `--nc-*`. */
  readonly input: string;
  /** The fallback used when the host leaves the input unset. */
  readonly fallback: string;
}

export interface TokenEntry {
  readonly name: string;
  readonly meaning: string;
  /** True for the eight names @noblecloak/react@0.4.2 shipped; their names and defaults do not change. */
  readonly shipped: boolean;
  readonly light: string;
  readonly dark: string;
}

export interface TokensJson {
  readonly $comment: string;
  readonly root: string;
  readonly themeAttribute: string;
  readonly themeValues: readonly string[];
  readonly tokens: readonly TokenEntry[];
}

export const ROOT_SELECTOR = '.nc-root';
export const DARK_SELECTOR = ".nc-root[data-nc-theme='dark'], [data-nc-theme='dark'] .nc-root";
export const DARK_MEDIA = '@media (prefers-color-scheme: dark)';
export const DARK_MEDIA_SELECTOR =
  ".nc-root:not([data-nc-theme='light']):not([data-nc-theme='light'] .nc-root)";

/** What each public token means. A name in the CSS without an entry here (or the reverse) fails the build of the JSON. */
export const TOKEN_MEANINGS: Readonly<Record<string, string>> = {
  '--nc-bg': 'Surface behind the module.',
  '--nc-fg': 'Text colour.',
  '--nc-muted': 'Secondary text colour (not a surface).',
  '--nc-border': 'Border colour of panels and controls.',
  '--nc-accent': 'Action colour; also the focus ring unless --nc-ring is set.',
  '--nc-danger': 'Colour of errors and destructive actions.',
  '--nc-radius': 'Corner radius of panels and controls.',
  '--nc-font-sans': "Text font family; unset, the module inherits the host's.",
  '--nc-accent-fg': 'Text on the accent colour (primary Button, selected Tabs item).',
  '--nc-danger-fg': 'Text on the danger colour (destructive Button, solid Alert).',
  '--nc-surface':
    'A raised surface (Card, Dialog, Tooltip); defaults to --nc-bg, the border separates it.',
  '--nc-subtle':
    'A quiet surface (Skeleton, Tabs track, DataTable row hover, neutral Badge); defaults to a low-contrast mix of --nc-fg into --nc-bg.',
  '--nc-success': 'Success colour (Badge, Alert); the default meets WCAG AA on --nc-bg.',
  '--nc-warning': 'Warning colour (Badge, Alert); the default meets WCAG AA on --nc-bg.',
  '--nc-font-mono': 'Monospace font family (code Input, code and JSON blocks).',
  '--nc-ring': 'Focus ring colour; defaults to --nc-accent.',
};

/** The eight names @noblecloak/react@0.4.2 ships, in its order. */
export const SHIPPED_NAMES: readonly string[] = [
  '--nc-bg',
  '--nc-fg',
  '--nc-muted',
  '--nc-border',
  '--nc-accent',
  '--nc-danger',
  '--nc-radius',
  '--nc-font-sans',
];

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Splits a stylesheet into its style rules, one level of at-rule nesting deep. Comments are dropped. */
export function parseRules(css: string, atRule = ''): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open === -1) break;
    // A statement at-rule (`@import ...;`) before the block is not part of its selector.
    const raw = text.slice(index, open);
    const prelude = collapse(raw.slice(raw.lastIndexOf(';') + 1));
    let depth = 1;
    let cursor = open + 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === '{') depth += 1;
      else if (text[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) throw new Error(`unbalanced braces after "${prelude}"`);
    const body = text.slice(open + 1, cursor - 1);
    if (prelude.startsWith('@')) rules.push(...parseRules(body, prelude));
    else rules.push({ selector: prelude.replace(/,\s*/g, ', '), atRule, body });
    index = cursor;
  }
  return rules;
}

/** The text inside the parentheses that open at `open`, which must index a `(`. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let cursor = open; cursor < text.length; cursor += 1) {
    if (text[cursor] === '(') depth += 1;
    else if (text[cursor] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, cursor);
    }
  }
  throw new Error(`unbalanced parentheses in "${text}"`);
}

/** The declarations of a rule body that read a public `--nc-*` input with a fallback. */
export function tokenDeclarations(body: string): TokenDeclaration[] {
  const found: TokenDeclaration[] = [];
  for (const raw of body.split(/;(?![^(]*\))/)) {
    const declaration = collapse(raw);
    const match = /^([\w-]+)\s*:\s*var\(/.exec(declaration);
    if (match === null) continue;
    const inner = balanced(declaration, match[0].length - 1);
    const comma = inner.indexOf(',');
    if (comma === -1) continue;
    const input = inner.slice(0, comma).trim();
    if (!input.startsWith('--nc-') || input.startsWith('--nc-i-')) continue;
    found.push({ property: match[1] ?? '', input, fallback: inner.slice(comma + 1).trim() });
  }
  return found;
}

function declarationsOf(
  rules: readonly CssRule[],
  selector: string,
  atRule = ''
): TokenDeclaration[] {
  return rules
    .filter((rule) => rule.selector === selector && rule.atRule === atRule)
    .flatMap((rule) => tokenDeclarations(rule.body));
}

/** Replaces each `var(--nc-i-x)` in `value` with what `resolve` gives for that internal variable. */
function substitute(value: string, resolve: (internal: string) => string): string {
  return value.replace(/var\((--nc-i-[\w-]+)\)/g, (_, internal: string) => resolve(internal));
}

/** Builds the JSON contract from the token stylesheet. Throws when the CSS and the meanings table disagree. */
export function buildTokensJson(css: string): TokensJson {
  const rules = parseRules(css);
  const light = declarationsOf(rules, ROOT_SELECTOR);
  const dark = declarationsOf(rules, DARK_SELECTOR);
  const byProperty = (list: readonly TokenDeclaration[]) =>
    new Map(list.map((d) => [d.property, d] as const));
  const lightByProperty = byProperty(light);
  const darkByProperty = byProperty(dark);

  const defaultFor = (property: string, mode: 'light' | 'dark', seen: Set<string>): string => {
    if (seen.has(property)) throw new Error(`token default cycle at ${property}`);
    const declaration =
      (mode === 'dark' ? darkByProperty.get(property) : undefined) ?? lightByProperty.get(property);
    if (declaration === undefined) throw new Error(`no declaration for ${property}`);
    const next = new Set(seen).add(property);
    return substitute(declaration.fallback, (internal) => defaultFor(internal, mode, next));
  };

  const names = new Set<string>();
  const tokens: TokenEntry[] = light.map((declaration) => {
    const name = declaration.input;
    if (names.has(name)) throw new Error(`${name} is read twice`);
    names.add(name);
    const meaning = TOKEN_MEANINGS[name];
    if (meaning === undefined) throw new Error(`${name} has no meaning in TOKEN_MEANINGS`);
    return {
      name,
      meaning,
      shipped: SHIPPED_NAMES.includes(name),
      light: defaultFor(declaration.property, 'light', new Set()),
      dark: defaultFor(declaration.property, 'dark', new Set()),
    };
  });
  for (const name of Object.keys(TOKEN_MEANINGS)) {
    if (!names.has(name)) throw new Error(`${name} is in TOKEN_MEANINGS but no rule reads it`);
  }
  for (const declaration of dark) {
    if (!lightByProperty.has(declaration.property)) {
      throw new Error(`${declaration.property} has a dark default but no light one`);
    }
  }
  return {
    $comment:
      'Generated from tokens.css by `bun run tokens:generate`; do not edit. Set these on an element with class nc-root (or an ancestor). light and dark are the defaults used when a name is unset.',
    root: ROOT_SELECTOR,
    themeAttribute: 'data-nc-theme',
    themeValues: ['light', 'dark'],
    tokens,
  };
}

/** The JSON text written to `src/tokens.json`. */
export function serializeTokensJson(json: TokensJson): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}
