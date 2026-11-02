/**
 * Build assertion: fails when an expected build output is missing. `skipLibCheck` hides a missing
 * declaration file from consumers' type checks, so a package whose public types live in a named
 * file asserts that file after its build (`bun ../../scripts/assert-files.ts dist/schema.d.ts`).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** The subset of `paths` (relative to `cwd`) that do not exist. */
export function missingFiles(cwd: string, paths: readonly string[]): string[] {
  return paths.filter((path) => !existsSync(resolve(cwd, path)));
}

if (import.meta.main) {
  const missing = missingFiles(process.cwd(), process.argv.slice(2));
  for (const path of missing) console.error(`assert-files: expected build output missing: ${path}`);
  process.exit(missing.length === 0 ? 0 : 1);
}
