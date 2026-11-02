/**
 * Build assertion: `dist/schema.d.ts` must exist and export `paths`. `skipLibCheck` hides a missing
 * or empty declaration file from consumers' type checks, so the build fails here instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The problems with the schema declaration under `root`'s `dist/`. Empty means it is fine. */
export function schemaDistProblems(root: string): string[] {
  const file = resolve(root, 'dist/schema.d.ts');
  if (!existsSync(file)) return ['dist/schema.d.ts is missing'];
  if (!/export interface paths\b/.test(readFileSync(file, 'utf8'))) {
    return ['dist/schema.d.ts does not export `paths`'];
  }
  return [];
}

if (import.meta.main) {
  const problems = schemaDistProblems(process.cwd());
  for (const problem of problems) console.error(`assert-schema-dist: ${problem}`);
  process.exit(problems.length === 0 ? 0 : 1);
}
