import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkDist } from './assert-dist.js';

function packageWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'policy-formats-dist-'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './import': { types: './dist/import.d.ts', import: './dist/import.js' },
      },
    })
  );
  for (const [name, text] of Object.entries({
    'dist/index.d.ts': '',
    'dist/import.d.ts': '',
    ...files,
  }))
    writeFileSync(join(root, name), text);
  return root;
}

const LOADS = "const c = await import('@cedar-policy/cedar-wasm');\n";

describe('checkDist', () => {
  it('passes when only the import entry loads the peer', () => {
    const root = packageWith({
      'dist/index.js': "export { a } from './chunk-1.js';\n",
      'dist/chunk-1.js': 'export const a = 1;\n',
      'dist/import.js': `import { a } from './chunk-1.js';\n${LOADS}`,
    });
    expect(checkDist(root)).toEqual([]);
  });

  it('fails when a chunk the root entry imports loads the peer', () => {
    const root = packageWith({
      'dist/index.js': "import './chunk-2.js';\nexport { a } from './chunk-1.js';\n",
      'dist/chunk-1.js': 'export const a = 1;\n',
      'dist/chunk-2.js': LOADS,
      'dist/import.js': LOADS,
    });
    expect(checkDist(root)).toEqual([
      `${join(root, 'dist/chunk-2.js')} imports @cedar-policy/cedar-wasm; the root entry must not`,
    ]);
  });

  it('fails when the import entry does not load the peer, or a target is missing', () => {
    const root = packageWith({ 'dist/index.js': '', 'dist/import.js': '' });
    expect(checkDist(root)).toEqual([
      'dist/import.js does not load @cedar-policy/cedar-wasm (the check above would pass vacuously)',
    ]);
    const empty = packageWith({});
    expect(checkDist(empty)).toContain('export-map target missing: ./dist/index.js');
  });
});
