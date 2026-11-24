/**
 * Says whether a publish run has anything to do on npm, before the job that holds the publish credential (and
 * asks for the `npm-publish` environment's approval) starts. It publishes nothing and needs no install: it
 * reads each public workspace package's name and version from its manifest and asks npm which versions it has,
 * with the same lookup and the same decision `scripts/release.ts` uses.
 *
 * The answer is `has_unpublished=true` or `has_unpublished=false`, printed and, when `GITHUB_OUTPUT` names a
 * file, appended to it. It is `false` only when npm already has every public package at its current version,
 * which is the case where the release script would skip them all. Everything else is `true`, so the release
 * script still runs and reports: a version npm lacks, a package npm has never seen (the release script checks
 * its dependencies and fails on an unmet one) and a lookup that failed.
 */
import { appendFileSync } from 'node:fs';

import { NPMJS_REGISTRY, decide, npmView } from './release.js';
import type { NpmSpawn, RegistryLookup } from './release.js';
import { listPublicPackages } from './workspace.js';

/** Whether npm lacks any public package of `root` at its current version; one line per package goes to `out`. */
export function hasUnpublished(
  root: string,
  out: (line: string) => void,
  lookup: RegistryLookup
): boolean {
  let unpublished = false;
  for (const pkg of listPublicPackages(root)) {
    const who = `${pkg.name}@${pkg.version}`;
    try {
      const decision = decide(pkg.version, lookup(pkg.name));
      if (decision === 'skip-already-published') {
        out(`${who} is on npm already.`);
        continue;
      }
      out(
        decision === 'publish'
          ? `${who} is not on npm.`
          : `${pkg.name} is not on npm at any version; the release script decides.`
      );
    } catch (error) {
      out(
        `::warning::could not look ${pkg.name} up on npm (${error instanceof Error ? error.message : String(error)}); the release script decides.`
      );
    }
    unpublished = true;
  }
  return unpublished;
}

/** What `main` reaches outside the process; tests replace it. */
export interface PlanDeps {
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly spawn?: NpmSpawn;
  readonly append?: (file: string, text: string) => void;
}

/** Prints the answer, appends it to `GITHUB_OUTPUT` when that is set, and returns 0. */
export function main(env: NodeJS.ProcessEnv, deps: PlanDeps): number {
  const answer = `has_unpublished=${String(hasUnpublished(deps.cwd, deps.out, npmView(NPMJS_REGISTRY, deps.spawn)))}`;
  deps.out(answer);
  const file = env.GITHUB_OUTPUT ?? '';
  if (file !== '') (deps.append ?? appendFileSync)(file, `${answer}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(
    main(process.env, {
      cwd: process.cwd(),
      out: (line) => {
        console.log(line);
      },
    })
  );
}
