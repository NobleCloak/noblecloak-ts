/**
 * The built CSS is not committed (`dist/` is ignored repo-wide), so review diffs read the sources. That holds
 * only while the build does not process them: `dist/index.css` is `tokens.css`, a newline and
 * `components.css`, and the other stylesheets and `tokens.json` are copies. This checks it after a build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const PACKAGE = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(PACKAGE, path), 'utf8');

test('dist/index.css is tokens.css then components.css, unprocessed', () => {
  expect(read('dist/index.css')).toBe(
    `${read('src/styles/tokens.css')}\n${read('src/styles/components.css')}`
  );
});

test('dist/tokens.css, dist/components.css, dist/fonts.css and dist/tokens.json are copies of the sources', () => {
  expect(read('dist/tokens.css')).toBe(read('src/styles/tokens.css'));
  expect(read('dist/components.css')).toBe(read('src/styles/components.css'));
  expect(read('dist/fonts.css')).toBe(read('src/styles/fonts.css'));
  expect(read('dist/tokens.json')).toBe(read('src/tokens.json'));
});

test("dist/index.js starts with 'use client' (it calls createContext, which a server component cannot)", () => {
  expect(read('dist/index.js').startsWith("'use client';")).toBe(true);
});
