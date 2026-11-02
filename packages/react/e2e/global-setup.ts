/**
 * Bundles the page script (e2e/fixture/main.tsx, which renders the built `dist/` modules with React) into
 * `e2e/.build/fixture.global.js` before the suite runs, and checks the package has been built: the specs load
 * `dist/styles.css` and the fixture imports `dist/approvals.js`, `dist/action-status.js`, `dist/slots.js`, `dist/permissions.js` and `dist/connections.js`, which
 * import the built `@noblecloak/theme`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { build } from 'tsup';
import type { Options } from 'tsup';

/** An esbuild plugin, typed through tsup (esbuild is tsup's dependency, not this package's). */
type Plugin = NonNullable<Options['esbuildPlugins']>[number];

export const PACKAGE = join(import.meta.dirname, '..');
export const BUILD_DIR = join(import.meta.dirname, '.build');

/** The entries the fixture names by their sources, bundled from `dist/`. */
const ENTRIES = ['approvals', 'action-status', 'slots', 'permissions', 'connections'] as const;

/**
 * Resolves the fixture's `../../src/<entry>.js` imports to `dist/<entry>.js`, so the page runs the built modules
 * (and the built theme they import), and records which it redirected.
 */
function fromDist(redirected: Set<string>): Plugin {
  return {
    name: 'nc-fixture-from-dist',
    setup(build) {
      build.onResolve(
        {
          filter: /^\.\.\/\.\.\/src\/(approvals|action-status|slots|permissions|connections)\.js$/,
        },
        (args) => {
          const entry = /([a-z-]+)\.js$/.exec(args.path)?.[1] ?? '';
          redirected.add(entry);
          return { path: join(PACKAGE, 'dist', `${entry}.js`) };
        }
      );
    },
  };
}

export default async function globalSetup(): Promise<void> {
  for (const file of [
    'styles.css',
    'approvals.js',
    'action-status.js',
    'slots.js',
    'permissions.js',
    'connections.js',
  ]) {
    if (!existsSync(join(PACKAGE, 'dist', file))) {
      throw new Error(`packages/react/dist/${file} is missing: run \`bun run build\` first`);
    }
  }
  const redirected = new Set<string>();
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
    esbuildPlugins: [fromDist(redirected)],
  });
  const missing = ENTRIES.filter((entry) => !redirected.has(entry));
  if (missing.length > 0) {
    throw new Error(`the fixture did not import ${missing.join(', ')} from dist/`);
  }
}
