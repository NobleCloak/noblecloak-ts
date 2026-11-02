/**
 * The root entry never reaches `@cedar-policy/cedar-wasm` (an optional peer): exporting works without it,
 * and only the `./import` entry loads it. The build checks the same of the built files
 * (`tools/assert-dist.ts`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { packageFile } from './fixtures.test-support.js';
import { AGT_CEDAR_SCHEMA, NOBLECLOAK_CEDAR_SCHEMA } from './schemas.js';

const SRC = dirname(fileURLToPath(import.meta.url));
/** A static or dynamic import of the peer (a comment that names it is no import). */
const IMPORTS_CEDAR = /(?:from\s*|import\s*\(\s*)['"]@cedar-policy\/cedar-wasm/;

/** The source files a module reaches through its static relative imports (type-only imports included). */
function staticGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    // Comments are dropped: one may name the peer without importing it.
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    seen.set(file, text);
    for (const match of text.matchAll(/^(?:import|export)[^'"]*from '(\.{1,2}\/[^']+)\.js';$/gm)) {
      const target = match[1];
      if (target !== undefined) visit(resolve(dirname(file), `${target}.ts`));
    }
  };
  visit(join(SRC, entry));
  return seen;
}

describe('the root entry', () => {
  it('reaches no module that imports @cedar-policy/cedar-wasm', () => {
    const graph = staticGraph('index.ts');
    expect(graph.size).toBeGreaterThan(5);
    for (const [file, text] of graph) expect(text, file).not.toMatch(IMPORTS_CEDAR);
  });

  it('positive control: the import entry does reach it', () => {
    expect([...staticGraph('import.ts').values()].some((text) => IMPORTS_CEDAR.test(text))).toBe(
      true
    );
  });

  it('exports with the peer absent', async () => {
    vi.resetModules();
    vi.doMock('@cedar-policy/cedar-wasm', () => {
      throw new Error('@cedar-policy/cedar-wasm is not installed');
    });
    try {
      const { exportAgt, exportCedar } = await import('./index.js');
      const policy = {
        id: 'p',
        kind: 'tool_invocation' as const,
        subjects: [{ type: 'agent' as const, id: 'a' }],
        config: { mode: 'deny' as const },
      };
      expect(exportCedar([policy]).text).toContain('@noblecloak_policy("p")');
      expect(exportAgt([policy], []).text).toContain('@noblecloak_policy("p")');
      const { importCedar } = await import('./import.js');
      await expect(importCedar('')).rejects.toMatchObject({ code: 'cedar_unavailable' });
    } finally {
      vi.doUnmock('@cedar-policy/cedar-wasm');
      vi.resetModules();
    }
  });
});

describe('the shipped schemas', () => {
  it('schemas/*.cedarschema are the exported constants, byte for byte', () => {
    expect(packageFile('schemas/noblecloak.cedarschema')).toBe(NOBLECLOAK_CEDAR_SCHEMA);
    expect(packageFile('schemas/agt.cedarschema')).toBe(AGT_CEDAR_SCHEMA);
  });

  it('the package exports both files and ships the directory', () => {
    const manifest = JSON.parse(packageFile('package.json')) as {
      exports: Record<string, unknown>;
      files: string[];
      peerDependenciesMeta: Record<string, { optional: boolean }>;
    };
    expect(manifest.exports['./schemas/noblecloak.cedarschema']).toBe(
      './schemas/noblecloak.cedarschema'
    );
    expect(manifest.exports['./schemas/agt.cedarschema']).toBe('./schemas/agt.cedarschema');
    expect(manifest.files).toContain('schemas');
    expect(manifest.peerDependenciesMeta['@cedar-policy/cedar-wasm']).toEqual({ optional: true });
  });
});
