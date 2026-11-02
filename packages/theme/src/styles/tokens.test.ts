import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contrastRatio, parseColour } from '../../tools/contrast.js';
import {
  buildTokensJson,
  DARK_MEDIA,
  DARK_MEDIA_SELECTOR,
  DARK_SELECTOR,
  parseRules,
  serializeTokensJson,
  SHIPPED_NAMES,
  tokenDeclarations,
} from '../../tools/tokens.js';
import type { TokensJson } from '../../tools/tokens.js';

const PACKAGE = join(import.meta.dirname, '..', '..');
const tokensCss = readFileSync(join(PACKAGE, 'src/styles/tokens.css'), 'utf8');
const tokensJsonText = readFileSync(join(PACKAGE, 'src/tokens.json'), 'utf8');
const tokensJson = JSON.parse(tokensJsonText) as TokensJson;

const token = (name: string) => {
  const entry = tokensJson.tokens.find((t) => t.name === name);
  if (entry === undefined) throw new Error(`${name} missing from tokens.json`);
  return entry;
};

describe('tokens.json and tokens.css agree', () => {
  it('tokens.json is exactly what tokens:generate builds from tokens.css', () => {
    expect(tokensJsonText).toBe(serializeTokensJson(buildTokensJson(tokensCss)));
  });

  it('the theme values are light and dark only (no system value)', () => {
    expect(tokensJson.themeValues).toEqual(['light', 'dark']);
    expect(tokensCss).not.toMatch(/data-nc-theme=['"]system['"]/);
  });

  it('the media-query dark rules set exactly what the attribute dark rules set', () => {
    const rules = parseRules(tokensCss);
    const declarations = (selector: string, atRule: string) =>
      rules
        .filter((r) => r.selector === selector && r.atRule === atRule)
        .flatMap((r) => tokenDeclarations(r.body));
    const media = declarations(DARK_MEDIA_SELECTOR, DARK_MEDIA);
    expect(media.length).toBeGreaterThan(0);
    expect(media).toEqual(declarations(DARK_SELECTOR, ''));
  });
});

describe('the eight shipped names are unchanged (no renames)', () => {
  // @noblecloak/react@0.4.2, src/styles.css lines 7 to 39. Changing a row here is changing the public contract.
  const SHIPPED = [
    ['--nc-bg', '#ffffff', '#121212'],
    ['--nc-fg', '#1a1a1a', '#ececec'],
    ['--nc-muted', '#595959', '#b0b0b0'],
    ['--nc-border', '#bdbdbd', '#5c5c5c'],
    ['--nc-accent', '#0b57d0', '#8ab4f8'],
    ['--nc-danger', '#b3261e', '#f2b8b5'],
    ['--nc-radius', '4px', '4px'],
    ['--nc-font-sans', 'inherit', 'inherit'],
  ] as const;

  it('lists the eight in order as the shipped set', () => {
    expect(SHIPPED_NAMES).toEqual(SHIPPED.map(([name]) => name));
    expect(tokensJson.tokens.filter((t) => t.shipped).map((t) => t.name)).toEqual(SHIPPED_NAMES);
  });

  it.each(SHIPPED)('%s keeps its name and its light and dark defaults', (name, light, dark) => {
    expect(token(name)).toMatchObject({ name, shipped: true, light, dark });
  });
});

describe('additions', () => {
  const ADDITIONS = [
    '--nc-accent-fg',
    '--nc-danger-fg',
    '--nc-surface',
    '--nc-subtle',
    '--nc-success',
    '--nc-warning',
    '--nc-font-mono',
    '--nc-ring',
  ];

  it('are exactly the names the brief justifies, in the short style', () => {
    expect(tokensJson.tokens.filter((t) => !t.shipped).map((t) => t.name)).toEqual(ADDITIONS);
  });

  it('derive from the eight where the contract says so', () => {
    expect(token('--nc-surface')).toMatchObject({ light: '#ffffff', dark: '#121212' });
    expect(token('--nc-ring')).toMatchObject({ light: '#0b57d0', dark: '#8ab4f8' });
    expect(token('--nc-font-mono').light).toBe('ui-monospace, monospace');
    expect(tokensCss).toContain('--nc-i-surface: var(--nc-surface, var(--nc-i-bg));');
    expect(tokensCss).toContain('--nc-i-ring: var(--nc-ring, var(--nc-i-accent));');
  });
});

describe('default palettes meet WCAG AA (4.5:1 for text)', () => {
  // [foreground, background]: each text pairing a carried primitive renders with the defaults.
  const PAIRS = [
    ['--nc-fg', '--nc-bg'],
    ['--nc-muted', '--nc-bg'],
    ['--nc-accent', '--nc-bg'],
    ['--nc-danger', '--nc-bg'],
    ['--nc-success', '--nc-bg'],
    ['--nc-warning', '--nc-bg'],
    ['--nc-accent-fg', '--nc-accent'],
    ['--nc-danger-fg', '--nc-danger'],
    ['--nc-fg', '--nc-surface'],
    ['--nc-fg', '--nc-subtle'],
    ['--nc-muted', '--nc-subtle'],
    ['--nc-success', '--nc-subtle'],
    ['--nc-warning', '--nc-subtle'],
    ['--nc-danger', '--nc-subtle'],
    ['--nc-accent', '--nc-subtle'],
  ] as const;

  const rows = (['light', 'dark'] as const).flatMap((mode) =>
    PAIRS.map(([fg, bg]) => [mode, fg, bg] as const)
  );

  it.each(rows)('%s: %s on %s', (mode, fg, bg) => {
    const ratio = contrastRatio(token(fg)[mode], token(bg)[mode]);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('contrastRatio matches known values and rejects what it cannot read', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(parseColour('color-mix(in srgb, #000000 50%, #ffffff)')).toEqual([128, 128, 128]);
    expect(() => parseColour('red')).toThrow('not a #rrggbb colour');
  });
});

describe('the token parser', () => {
  it('rejects a stylesheet with unbalanced braces or parentheses', () => {
    expect(() => parseRules('.nc-root { --nc-i-bg: red;')).toThrow('unbalanced braces');
    expect(() => tokenDeclarations('--nc-i-bg: var(--nc-bg, rgb(0 0 0)')).toThrow(
      'unbalanced parentheses'
    );
  });

  it('ignores declarations without a public input or without a fallback', () => {
    expect(
      tokenDeclarations('color: var(--nc-i-fg); --x: var(--nc-i-bg, red); --y: var(--nc-bg)')
    ).toEqual([]);
  });

  it('refuses a name with no meaning, a meaning with no rule, and a dark-only default', () => {
    expect(() => buildTokensJson('.nc-root { --nc-i-x: var(--nc-x, red); }')).toThrow(
      '--nc-x has no meaning'
    );
    expect(() => buildTokensJson('.nc-root { --nc-i-bg: var(--nc-bg, red); }')).toThrow(
      'is in TOKEN_MEANINGS but no rule reads it'
    );
    expect(() =>
      buildTokensJson(`${tokensCss}\n${DARK_SELECTOR} { --nc-i-q: var(--nc-q, red); }`)
    ).toThrow('--nc-i-q has a dark default but no light one');
    expect(() =>
      buildTokensJson(`${tokensCss}\n.nc-root { --nc-i-z: var(--nc-bg, red); }`)
    ).toThrow('--nc-bg is read twice');
  });

  it('refuses a default that refers to itself', () => {
    const cyclic = tokensCss.replace(
      '--nc-i-ring: var(--nc-ring, var(--nc-i-accent));',
      '--nc-i-ring: var(--nc-ring, var(--nc-i-ring));'
    );
    expect(() => buildTokensJson(cyclic)).toThrow('token default cycle at --nc-i-ring');
  });

  it('refuses a fallback that reads an internal variable nothing declares', () => {
    const dangling = tokensCss.replace(
      '--nc-i-ring: var(--nc-ring, var(--nc-i-accent));',
      '--nc-i-ring: var(--nc-ring, var(--nc-i-nothing));'
    );
    expect(() => buildTokensJson(dangling)).toThrow('no declaration for --nc-i-nothing');
  });
});
