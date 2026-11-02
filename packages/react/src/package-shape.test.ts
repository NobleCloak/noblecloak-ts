import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as approvals from './approvals.js';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
const manifest = JSON.parse(read('package.json')) as {
  sideEffects: unknown;
  exports: Record<string, string | { types: string; import: string }>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

describe('package shape', () => {
  it('declares the subpaths: the four modules, ./auth, ./slots and ./styles.css', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(
      [
        '.',
        './action-status',
        './approvals',
        './auth',
        './connections',
        './permissions',
        './slots',
        './styles.css',
      ].sort()
    );
    expect(manifest.exports['./auth']).toEqual({
      types: './dist/auth.d.ts',
      import: './dist/auth.js',
    });
    expect(manifest.exports['./slots']).toEqual({
      types: './dist/slots.d.ts',
      import: './dist/slots.js',
    });
    expect(manifest.exports['./styles.css']).toBe('./dist/styles.css');
  });

  it('keeps stylesheets from being tree-shaken away, and only them', () => {
    expect(manifest.sideEffects).toEqual(['**/*.css']);
  });

  it('depends on the client package, on the theme (the one slot context) and on React 19 as a peer', () => {
    expect(manifest.dependencies).toEqual({
      '@noblecloak/client': 'workspace:*',
      '@noblecloak/theme': 'workspace:*',
    });
    expect(manifest.peerDependencies).toEqual({ react: '^19.0.0' });
  });

  it('keeps the approvals module id', () => {
    expect(approvals.MODULE_ID).toBe('approvals');
  });
});
