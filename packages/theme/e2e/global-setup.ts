/**
 * Bundles the page script (fixture/main.tsx with React) into `.build/fixture.js` before the suite runs, and
 * checks the package has been built (the suite loads `dist/index.css`).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { build } from 'tsup';

export const PACKAGE = join(import.meta.dirname, '..');
export const BUILD_DIR = join(import.meta.dirname, '.build');

export default async function globalSetup(): Promise<void> {
  if (!existsSync(join(PACKAGE, 'dist', 'index.css'))) {
    throw new Error('packages/theme/dist/index.css is missing: run `bun run build` first');
  }
  await build({
    entry: { fixture: join(import.meta.dirname, 'fixture', 'main.tsx') },
    outDir: BUILD_DIR,
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    noExternal: [/.*/],
    define: { 'process.env.NODE_ENV': '"production"' },
    tsconfig: join(PACKAGE, 'tsconfig.json'),
    sourcemap: false,
    dts: false,
    clean: true,
    silent: true,
    config: false,
  });
}
