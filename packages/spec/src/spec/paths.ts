/** Locations inside the package, found by walking up to the nearest package.json. */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** The directory holding this package's package.json. */
export function packageRoot(from: string = import.meta.dirname): string {
  let dir = from;
  while (!existsSync(resolve(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${from}`);
    dir = parent;
  }
  return dir;
}

/**
 * The document as a repository checkout holds it: `openapi.public.yaml` at the package root, authored in the
 * spec repository and committed here. The published package carries the copy at `PUBLIC_SPEC`.
 */
export const PUBLIC_SOURCE = (): string => resolve(packageRoot(), 'openapi.public.yaml');

/** The published document: `build:public` copies `PUBLIC_SOURCE` here. */
export const PUBLIC_SPEC = (): string => resolve(packageRoot(), 'dist/openapi.public.yaml');
