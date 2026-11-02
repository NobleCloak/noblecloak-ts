/** `bun run build:public`: check the committed document and copy it to `dist/`, where the package exports it. */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadSpec } from './load.js';
import { PUBLIC_SOURCE, PUBLIC_SPEC } from './paths.js';
import { findDanglingRefs } from './refs.js';

/** Copies the document at `source` to `out` and returns `out`. Throws, writing nothing, when a `$ref` in it resolves to nothing. */
export function buildPublic(source: string = PUBLIC_SOURCE(), out: string = PUBLIC_SPEC()): string {
  const dangling = findDanglingRefs(loadSpec(source));
  if (dangling.length > 0) {
    const lines = dangling.map((d) => `  ${d.at} -> ${d.ref}`);
    throw new Error(`${source} has references that resolve to nothing:\n${lines.join('\n')}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(source, out);
  return out;
}
