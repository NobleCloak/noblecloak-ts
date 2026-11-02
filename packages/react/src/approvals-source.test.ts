import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A source check, because importing the hook cannot show what its source would touch in a browser: the
// headless core and the hook reach for no browser global, no storage, no log and no EventSource.
const files = [
  'approvals-store.ts',
  'approvals-parse.ts',
  'approvals-errors.ts',
  'use-approvals.ts',
];
const text = (file: string): string => readFileSync(resolve(import.meta.dirname, file), 'utf8');
const code = (file: string): string =>
  text(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the headless core and the hook', () => {
  it.each(files)('%s reads no browser global, storage, log or EventSource', (file) => {
    const source = code(file);
    for (const banned of [
      /\bwindow\b/,
      /\bdocument\b/,
      /\bsessionStorage\b/,
      /\blocalStorage\b/,
      /\bcrypto\.subtle\b/,
      /\bconsole\./,
      /\bEventSource\b/,
      /\bnavigator\b/,
    ]) {
      expect([file, banned.test(source)]).toEqual([file, false]);
    }
  });

  it.each(files)('%s imports no CSS and no component', (file) => {
    const imports = [...text(file).matchAll(/\bfrom '([^']+)'/g)].map((m) => m[1] ?? '');
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/\.css$/);
      expect(spec).not.toMatch(/components\//);
    }
  });
});
