/**
 * The headless hooks and their stores import nothing from `@noblecloak/theme` and no component module, directly or
 * through anything they import: a host that renders its own markup with `useApprovals` gets no primitive. The walk
 * follows every relative import (including `import type`, which is erased, but would still tie the hook's source to
 * the theme) from each hook and store.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

/** The hooks and stores that must stay headless. */
const HEADLESS_SOURCES = [
  'use-approvals.ts',
  'use-approval-request.ts',
  'use-action-status.ts',
  'approvals-store.ts',
  'approval-request-store.ts',
  'action-status-store.ts',
  'use-policies.ts',
  'use-policy-editor.ts',
  'use-policy-simulate.ts',
  'permissions-store.ts',
  'permissions-effective.ts',
  'use-effective-policies.ts',
  'use-connections.ts',
  'use-connection.ts',
  'connections-store.ts',
] as const;

/** `from '...'` of an import or re-export, a bare side-effect `import '...'`, and a dynamic `import('...')`. */
const SPECIFIER =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every module specifier in `text`. */
function specifiers(text: string): string[] {
  return [...text.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

/** The source files `entry` reaches through relative imports, and the bare specifiers it (or they) import. */
function reach(entry: string, root = SRC): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [join(root, entry)];
  while (queue.length > 0) {
    const file = queue.pop() ?? '';
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        packages.add(specifier);
        continue;
      }
      const target = join(dirname(file), specifier);
      // Sources import `.js`; the file on disk is `.ts` or `.tsx`.
      const base = target.replace(/\.js$/, '');
      const source = [`${base}.ts`, `${base}.tsx`].find((path) => existsSync(path));
      if (source !== undefined) queue.push(source);
    }
  }
  return {
    files: [...files].map((file) => relative(root, file).replaceAll('\\', '/')).sort(),
    packages: [...packages].sort(),
  };
}

describe('the headless hooks import no theme and no component', () => {
  it.each(HEADLESS_SOURCES)('%s', (entry) => {
    const { files, packages } = reach(entry);
    expect(files.length).toBeGreaterThan(1);
    expect(packages.filter((name) => name.startsWith('@noblecloak/theme'))).toEqual([]);
    expect(files.filter((file) => file.startsWith('components/'))).toEqual([]);
  });

  it('the walk sees a theme import and a component import where there is one', () => {
    const approvals = reach('approvals.ts');
    expect(approvals.packages).toContain('@noblecloak/theme');
    expect(approvals.files).toContain('components/Approvals.tsx');
  });

  it('reads static, re-export, type and dynamic specifiers', () => {
    expect(
      specifiers(
        [
          "import { a } from './a.js';",
          "import type { B } from '@noblecloak/theme';",
          "export { c } from './c.js';",
          "export * from 'pkg';",
          "const d = await import('./d.js');",
          "import './e.css';",
        ].join('\n')
      )
    ).toEqual(['./a.js', '@noblecloak/theme', './c.js', 'pkg', './d.js', './e.css']);
  });
});
