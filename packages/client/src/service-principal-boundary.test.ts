/** The main entry stays browser-safe: it must not reach the service-principal code, or any key handling. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(here, entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const target = match[1];
      if (target !== undefined) queue.push(resolve(dirname(file), target.replace(/\.js$/, '.ts')));
    }
  }
  return seen;
}

describe('package boundaries', () => {
  it('the main entry does not import the service-principal modules', () => {
    const files = [...reachable('index.ts')].map((f) => f.slice(here.length + 1));
    expect(files).toContain('client.ts');
    expect(files.filter((f) => f.startsWith('service-principal'))).toEqual([]);
  });

  it('the main entry does not import the node fs/path modules the credential loader uses', () => {
    for (const file of reachable('index.ts')) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/node:(fs|path|os)/);
    }
  });

  it('the subpath is exported and built', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./service-principal']).toEqual({
      types: './dist/service-principal.d.ts',
      import: './dist/service-principal.js',
    });
    // No private dependency: the repo's private-dependency guard (`bun run guard`) checks every package.json.
    expect(readFileSync(resolve(root, 'tsup.config.ts'), 'utf8')).toContain(
      'src/service-principal.ts'
    );
  });

  it('the main entry does not import the governance API module', () => {
    const files = [...reachable('index.ts')].map((f) => f.slice(here.length + 1));
    expect(files.filter((f) => f.startsWith('governance-api'))).toEqual([]);
  });

  it('the governance-api subpath is exported and built', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./governance-api']).toEqual({
      types: './dist/governance-api.d.ts',
      import: './dist/governance-api.js',
    });
    expect(readFileSync(resolve(root, 'tsup.config.ts'), 'utf8')).toContain(
      'src/governance-api.ts'
    );
  });
});
