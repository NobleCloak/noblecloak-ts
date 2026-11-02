/**
 * Builds `@noblecloak/react`'s `dist/styles.css`: the package's `src/styles.css` with its two markers replaced by
 * `@noblecloak/theme`'s `tokens.css` and `components.css` (the primitives the modules render), each inlined byte for
 * byte. Nothing is `@import`ed, so the shipped stylesheet is still one file that makes no request. Called from the
 * `onSuccess` of `packages/react/tsup.config.ts`; `check-react-dist.ts` (`checkThemeTokens`, `checkThemeComponents`)
 * checks the result.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** The name in the token marker; `check-react-dist.ts` fails a `dist/styles.css` that still holds it. */
export const TOKENS_MARKER_NAME = '@nc-theme-tokens';

/** The line of `src/styles.css` the token CSS replaces. */
export const TOKENS_MARKER = `/* ${TOKENS_MARKER_NAME} */`;

/** The name in the primitives marker; `check-react-dist.ts` fails a `dist/styles.css` that still holds it. */
export const COMPONENTS_MARKER_NAME = '@nc-theme-components';

/** The line of `src/styles.css` the primitives' CSS replaces. */
export const COMPONENTS_MARKER = `/* ${COMPONENTS_MARKER_NAME} */`;

/** The theme's export of its token CSS (`packages/theme/package.json` maps it to `dist/tokens.css`). */
export const THEME_TOKENS_EXPORT = '@noblecloak/theme/tokens.css';

/** The theme's export of its primitives' CSS (`packages/theme/package.json` maps it to `dist/components.css`). */
export const THEME_COMPONENTS_EXPORT = '@noblecloak/theme/components.css';

/** `source` with `marker` replaced by `text`; throws unless the marker occurs exactly once and `text` is not blank. */
function replaceMarker(source: string, marker: string, text: string, what: string): string {
  if (text.trim() === '') throw new Error(`the theme ${what} CSS is empty`);
  const occurrences = source.split(marker).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected the marker ${marker} exactly once in the stylesheet, found ${String(occurrences)}`
    );
  }
  // A function replacement, so a `$` in the inlined CSS is never read as a replacement pattern.
  return source.replace(marker, () => text);
}

/**
 * `source` with `TOKENS_MARKER` replaced by `tokens` and, when `components` is given, `COMPONENTS_MARKER` replaced by
 * it. Throws unless each marker occurs exactly once and its CSS holds more than whitespace, so a stylesheet can never
 * ship without its tokens or primitives or with either twice. The components are inlined first, so a marker inside the
 * token CSS is never replaced.
 */
export function composeStyles(source: string, tokens: string, components?: string): string {
  if (tokens.trim() === '') throw new Error('the theme token CSS is empty');
  const withComponents =
    components === undefined
      ? source
      : replaceMarker(source, COMPONENTS_MARKER, components, 'components');
  return replaceMarker(withComponents, TOKENS_MARKER, tokens, 'token');
}

/** The path of the theme's token CSS as a package at `packageRoot` resolves it (through the theme's export map). */
export function resolveThemeTokens(packageRoot: string): string {
  return createRequire(join(packageRoot, 'package.json')).resolve(THEME_TOKENS_EXPORT);
}

/** The theme's token CSS as a package at `packageRoot` resolves it. */
export function readThemeTokens(packageRoot: string): string {
  return readFileSync(resolveThemeTokens(packageRoot), 'utf8');
}

/** The path of the theme's primitives' CSS as a package at `packageRoot` resolves it (through the theme's export map). */
export function resolveThemeComponents(packageRoot: string): string {
  return createRequire(join(packageRoot, 'package.json')).resolve(THEME_COMPONENTS_EXPORT);
}

/** The theme's primitives' CSS as a package at `packageRoot` resolves it. */
export function readThemeComponents(packageRoot: string): string {
  return readFileSync(resolveThemeComponents(packageRoot), 'utf8');
}

/** Writes `dist/styles.css` of the package at `packageRoot` from its `src/styles.css` and the theme's CSS. */
export function buildReactStyles(packageRoot: string): void {
  const source = readFileSync(join(packageRoot, 'src', 'styles.css'), 'utf8');
  const styles = composeStyles(
    source,
    readThemeTokens(packageRoot),
    readThemeComponents(packageRoot)
  );
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'dist', 'styles.css'), styles);
}
