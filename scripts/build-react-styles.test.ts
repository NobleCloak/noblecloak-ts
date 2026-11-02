import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildReactStyles,
  COMPONENTS_MARKER,
  composeStyles,
  readThemeComponents,
  readThemeTokens,
  resolveThemeComponents,
  resolveThemeTokens,
  TOKENS_MARKER,
} from './build-react-styles.js';

const TOKENS = '.nc-root {\n  --nc-i-bg: var(--nc-bg, #ffffff);\n}\n';
const COMPONENTS = '.nc-root .nc-btn {\n  color: var(--nc-i-fg);\n}\n';
const SOURCE = `/* header */\n${TOKENS_MARKER}\n\n.nc-root .nc-row {\n  color: red;\n}\n`;
const SOURCE_WITH_COMPONENTS = `/* header */\n${TOKENS_MARKER}\n${COMPONENTS_MARKER}\n.nc-root .nc-row {\n  color: red;\n}\n`;

describe('composeStyles', () => {
  it('replaces the marker with the token CSS, byte for byte, and keeps the rest', () => {
    const out = composeStyles(SOURCE, TOKENS);
    expect(out).toBe(`/* header */\n${TOKENS}\n\n.nc-root .nc-row {\n  color: red;\n}\n`);
    expect(out).not.toContain(TOKENS_MARKER);
  });

  it('throws when the marker is absent', () => {
    expect(() => composeStyles('.nc-root {}\n', TOKENS)).toThrow(
      `expected the marker ${TOKENS_MARKER} exactly once in the stylesheet, found 0`
    );
  });

  it('throws when the marker occurs twice', () => {
    expect(() => composeStyles(`${SOURCE}${TOKENS_MARKER}\n`, TOKENS)).toThrow(
      `expected the marker ${TOKENS_MARKER} exactly once in the stylesheet, found 2`
    );
  });

  it('throws when the token CSS is empty or whitespace', () => {
    expect(() => composeStyles(SOURCE, '')).toThrow('the theme token CSS is empty');
    expect(() => composeStyles(SOURCE, ' \n\t')).toThrow('the theme token CSS is empty');
  });

  it('replaces the primitives marker with the components CSS, after the tokens', () => {
    expect(composeStyles(SOURCE_WITH_COMPONENTS, TOKENS, COMPONENTS)).toBe(
      `/* header */\n${TOKENS}\n${COMPONENTS}\n.nc-root .nc-row {\n  color: red;\n}\n`
    );
  });

  it('throws when the primitives marker is absent or twice, or their CSS is empty', () => {
    expect(() => composeStyles(SOURCE, TOKENS, COMPONENTS)).toThrow(
      `expected the marker ${COMPONENTS_MARKER} exactly once in the stylesheet, found 0`
    );
    expect(() =>
      composeStyles(`${SOURCE_WITH_COMPONENTS}${COMPONENTS_MARKER}`, TOKENS, COMPONENTS)
    ).toThrow(`expected the marker ${COMPONENTS_MARKER} exactly once in the stylesheet, found 2`);
    expect(() => composeStyles(SOURCE_WITH_COMPONENTS, TOKENS, '\n')).toThrow(
      'the theme components CSS is empty'
    );
  });

  it('leaves a primitives marker inside the token CSS alone, and refuses a token marker inside the primitives', () => {
    expect(composeStyles(SOURCE_WITH_COMPONENTS, `a{} ${COMPONENTS_MARKER}`, COMPONENTS)).toContain(
      `a{} ${COMPONENTS_MARKER}`
    );
    expect(() => composeStyles(SOURCE_WITH_COMPONENTS, TOKENS, `a{} ${TOKENS_MARKER}`)).toThrow(
      `expected the marker ${TOKENS_MARKER} exactly once in the stylesheet, found 2`
    );
  });

  it('inlines a `$` in the token CSS literally', () => {
    expect(composeStyles(TOKENS_MARKER, "a { content: '$&$1'; }")).toBe("a { content: '$&$1'; }");
  });
});

describe('resolving and building', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'build-react-styles-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A package at `root` with a `src/styles.css`, and a theme installed beside it that exports `tokens.css`. */
  function setUp(source = SOURCE_WITH_COMPONENTS): void {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pkg', type: 'module' }));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'styles.css'), source);
    const theme = join(root, 'node_modules', '@noblecloak', 'theme');
    mkdirSync(join(theme, 'dist'), { recursive: true });
    writeFileSync(
      join(theme, 'package.json'),
      JSON.stringify({
        name: '@noblecloak/theme',
        exports: {
          '.': './dist/index.js',
          './tokens.css': './dist/tokens.css',
          './components.css': './dist/components.css',
        },
      })
    );
    writeFileSync(join(theme, 'dist', 'tokens.css'), TOKENS);
    writeFileSync(join(theme, 'dist', 'components.css'), COMPONENTS);
  }

  it('resolves the token CSS through the theme export map', () => {
    setUp();
    expect(resolveThemeTokens(root)).toMatch(
      /node_modules[\\/]@noblecloak[\\/]theme[\\/]dist[\\/]tokens\.css$/
    );
    expect(readThemeTokens(root)).toBe(TOKENS);
    expect(resolveThemeComponents(root)).toMatch(
      /node_modules[\\/]@noblecloak[\\/]theme[\\/]dist[\\/]components\.css$/
    );
    expect(readThemeComponents(root)).toBe(COMPONENTS);
  });

  it('fails when the theme is not installed', () => {
    writeFileSync(join(root, 'package.json'), '{}');
    expect(() => resolveThemeTokens(root)).toThrow(/@noblecloak\/theme\/tokens\.css/);
  });

  it('writes dist/styles.css composed from the source, the tokens and the primitives', () => {
    setUp();
    buildReactStyles(root);
    expect(readFileSync(join(root, 'dist', 'styles.css'), 'utf8')).toBe(
      composeStyles(SOURCE_WITH_COMPONENTS, TOKENS, COMPONENTS)
    );
  });

  it('fails the build when the source has no marker', () => {
    setUp('.nc-root {}\n');
    expect(() => {
      buildReactStyles(root);
    }).toThrow('exactly once');
  });
});
