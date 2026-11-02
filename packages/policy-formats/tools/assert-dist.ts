/**
 * Build assertions, run after the build: every export-map target exists, and the root entry's built
 * module graph (`dist/index.js` and the chunks it imports) imports `@cedar-policy/cedar-wasm` nowhere,
 * while `dist/import.js`'s does. So a consumer without the optional peer can bundle and run an export.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORTS_CEDAR = /(?:from\s*|import\s*\(\s*)['"]@cedar-policy\/cedar-wasm/;

/** The built files a module reaches through its relative static imports. */
export function builtGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string): void => {
    if (seen.has(file) || !existsSync(file)) return;
    const text = readFileSync(file, 'utf8');
    seen.set(file, text);
    for (const match of text.matchAll(
      /(?:^|[;\s])(?:import|export)\s*(?:[^'";]*?from\s*)?['"](\.{1,2}\/[^'"]+)['"]/g
    )) {
      const target = match[1];
      if (target !== undefined) visit(resolve(dirname(file), target));
    }
  };
  visit(entry);
  return seen;
}

export function checkDist(root: string): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { types: string; import: string }>;
  };
  for (const entry of Object.values(manifest.exports)) {
    for (const target of typeof entry === 'string' ? [entry] : [entry.types, entry.import])
      if (!existsSync(join(root, target))) problems.push(`export-map target missing: ${target}`);
  }
  const rootGraph = builtGraph(join(root, 'dist/index.js'));
  if (rootGraph.size === 0) problems.push('dist/index.js missing');
  for (const [file, text] of rootGraph)
    if (IMPORTS_CEDAR.test(text))
      problems.push(`${file} imports @cedar-policy/cedar-wasm; the root entry must not`);
  const importGraph = [...builtGraph(join(root, 'dist/import.js')).values()];
  if (!importGraph.some((text) => IMPORTS_CEDAR.test(text)))
    problems.push(
      'dist/import.js does not load @cedar-policy/cedar-wasm (the check above would pass vacuously)'
    );
  return problems;
}

if (import.meta.main) {
  const problems = checkDist(join(dirname(fileURLToPath(import.meta.url)), '..'));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
}
