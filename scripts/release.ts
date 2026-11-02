/**
 * Publishes the tarballs in `artifacts/` to a registry. Runs only in publish.yml's publish jobs, each
 * behind its own gate. Those jobs run no install and no build: they download the `npm-packages`
 * artifact the `pack` job built and this script publishes those tarballs as they are. It imports
 * only Node built-ins and the sibling scripts, so it runs without `node_modules`.
 *
 *   bun --no-install scripts/release.ts [--registry <url>]
 *
 * Two registries, chosen by `--registry <url>`:
 *
 * - Absent, or `https://registry.npmjs.org`: npm through OIDC trusted publishing (the `publish npm`
 *   job, gated on `vars.PUBLIC_RELEASE_ENABLED == 'true'`, which holds `id-token: write`). npm trusted
 *   publishing is configured per existing package, so a package that has never been published
 *   (npm view → 404) is skipped with a warning: its first publish is a manual maintainer step. Packages are published with `--provenance --access public`
 *   plus the two registry flags below. This path never reads or uses an npm token.
 * - `https://npm.pkg.github.com`: GitHub Packages (the `publish github-packages` job). It refuses an
 *   empty `NODE_AUTH_TOKEN`, publishes only the names in `GITHUB_PACKAGES_ALLOWLIST` and skips every
 *   other tarball with a printed line. Per version, `npm view <name>@<version>` decides: a 404 or an
 *   empty answer publishes, a present version is skipped, and any other error refuses the run. It
 *   publishes with the two registry flags below and neither `--provenance` nor `--access`: GitHub
 *   Packages ignores `access` and gives a package the visibility of the repository its
 *   `repository.url` links.
 *
 * Every `npm view` and `npm publish` the script makes, on either registry, carries
 * `--registry <registry>` and `--@noblecloak:registry=<registry>` (`registryFlags`). A bare
 * `--registry` loses to an `@noblecloak:registry` mapping in any `.npmrc` for a scoped package, and
 * only the scope flag beats that mapping, so without it a mapped `.npmrc` would send the precheck
 * or the publish to the wrong registry.
 *
 * `main(argv, env, deps)` is the command line: it parses the arguments (a bad one exits 2), builds
 * both lookups from the parsed registry and calls `release`, which takes its lookup explicitly.
 *
 * Any other `--registry` value, and any other argument, is refused before anything is published.
 *
 * Before publishing anything it checks every package it will publish against the internal
 * (`@noblecloak/*` or workspace) entries in the `dependencies` and `peerDependencies` of the
 * package.json inside that package's tarball, where `bun pm pack` has already rewritten
 * `workspace:` ranges. Each such entry must be an exact version that the registry already has, or
 * that this run publishes. Any failure publishes nothing and exits 1; an unseeded dependency is one
 * of those failures, not a warning. Packages are then published dependencies first, and the run
 * stops at the first failed publish, so a dependent never goes live ahead of its dependency.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { listTarEntries, runCommand, verifyTarballs } from './pack-all.js';
import type { EntryLister, Runner } from './pack-all.js';
import { listPublicPackages } from './workspace.js';
import type { WorkspacePackage } from './workspace.js';

export type RegistryState =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'versions'; readonly versions: readonly string[] };

export const NPMJS_REGISTRY = 'https://registry.npmjs.org';
export const GITHUB_REGISTRY = 'https://npm.pkg.github.com';

/** The only names published to GitHub Packages; any other packed tarball is skipped, never failed. */
export const GITHUB_PACKAGES_ALLOWLIST: readonly string[] = [
  '@noblecloak/spec',
  '@noblecloak/client',
  '@noblecloak/react',
  '@noblecloak/theme',
  '@noblecloak/cli',
  '@noblecloak/policy-formats',
];

/** Reads `--registry <url>` (or `--registry=<url>`) from the arguments after the script name. */
export function parseRegistryArgument(args: readonly string[]): string {
  let registry = NPMJS_REGISTRY;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--registry') {
      registry = args[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--registry=')) {
      registry = arg.slice('--registry='.length);
    } else {
      throw new Error(`unknown argument ${arg}; the only argument is --registry <url>`);
    }
  }
  if (registry !== NPMJS_REGISTRY && registry !== GITHUB_REGISTRY) {
    throw new Error(
      `unsupported registry "${registry}"; use ${NPMJS_REGISTRY} (the default) or ${GITHUB_REGISTRY}`
    );
  }
  return registry;
}

export type Decision = 'publish' | 'skip-not-seeded' | 'skip-already-published';

export function decide(version: string, state: RegistryState): Decision {
  if (state.kind === 'not-found') return 'skip-not-seeded';
  return state.versions.includes(version) ? 'skip-already-published' : 'publish';
}

/** Parses `npm view <name> versions --json`. A 404 is `not-found`; any other failure throws. */
export function parseNpmView(status: number, stdout: string, stderr: string): RegistryState {
  if (status !== 0) {
    if (stdout.includes('E404') || stderr.includes('E404')) return { kind: 'not-found' };
    throw new Error(`npm view failed (exit ${String(status)}): ${stderr.trim()}`);
  }
  const parsed: unknown = JSON.parse(stdout);
  const versions = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  return { kind: 'versions', versions };
}

export type RegistryLookup = (name: string) => RegistryState;

export type VersionState = 'present' | 'absent';

/**
 * Parses `npm view <name>@<version> version --json` against the GitHub registry. A 404, or an
 * empty answer for a package that exists, is `absent`; the version in the answer is `present`; any
 * other failure or answer throws, so the run refuses instead of guessing.
 */
export function parseVersionView(
  status: number,
  stdout: string,
  stderr: string,
  version: string
): VersionState {
  if (status !== 0) {
    if (stdout.includes('E404') || stderr.includes('E404')) return 'absent';
    throw new Error(`npm view failed (exit ${String(status)}): ${stderr.trim()}`);
  }
  if (stdout.trim() === '') return 'absent';
  const parsed: unknown = JSON.parse(stdout);
  const versions = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  if (versions.includes(version)) return 'present';
  throw new Error(`npm view ${version} answered ${stdout.trim()}, which is not that version`);
}

/** Looks up one exact version on the registry named by `--registry`. */
export type VersionLookup = (name: string, version: string) => VersionState;

/** The flags that pin an npm call on a `@noblecloak/*` package to `registry`, over any `.npmrc` scope mapping. */
export function registryFlags(registry: string): string[] {
  return ['--registry', registry, `--@noblecloak:registry=${registry}`];
}

/** The result of one `npm` call, as far as the lookups read it. */
export type NpmSpawn = (args: readonly string[]) => {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

const spawnNpm: NpmSpawn = (args) => spawnSync('npm', [...args], { encoding: 'utf8' });

/** The per-version precheck against the GitHub registry. */
export function githubVersion(spawn: NpmSpawn = spawnNpm): VersionLookup {
  return (name, version) => {
    const result = spawn([
      'view',
      `${name}@${version}`,
      'version',
      '--json',
      ...registryFlags(GITHUB_REGISTRY),
    ]);
    return parseVersionView(result.status ?? 1, result.stdout, result.stderr, version);
  };
}

/** The name lookup against the npmjs registry. */
export function npmView(registry: string, spawn: NpmSpawn = spawnNpm): RegistryLookup {
  return (name) => {
    const result = spawn(['view', name, 'versions', '--json', ...registryFlags(registry)]);
    return parseNpmView(result.status ?? 1, result.stdout, result.stderr);
  };
}

export function tarballFor(pkg: WorkspacePackage, tarballs: readonly string[]): string {
  const base = pkg.name.replace(/^@/, '').replace('/', '-');
  const match = tarballs.find((t) => t.endsWith(`/${base}-${pkg.version}.tgz`));
  if (match === undefined) throw new Error(`no packed tarball for ${pkg.name}@${pkg.version}`);
  return match;
}

/** The `dependencies` and `peerDependencies` a tarball's package.json declares. */
export interface PackedManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** Reads `package/package.json` out of a packed tarball. */
export type ManifestReader = (tarball: string) => PackedManifest;

export const readPackedManifest: ManifestReader = (tarball) => {
  const result = spawnSync('tar', ['xzOf', tarball, 'package/package.json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar xzOf failed for ${tarball}: ${result.stderr}`);
  return JSON.parse(result.stdout) as PackedManifest;
};

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** A dependency on another package this repository publishes. */
export interface InternalDependency {
  readonly name: string;
  readonly range: string;
}

/**
 * The internal entries of a packed manifest's `dependencies` and `peerDependencies`: any
 * `@noblecloak/*` name, plus any other name this repository publishes (`n8n-nodes-noblecloak`).
 */
export function internalDependencies(
  manifest: PackedManifest,
  workspaceNames: ReadonlySet<string>
): InternalDependency[] {
  return [manifest.dependencies, manifest.peerDependencies].flatMap((block) =>
    Object.entries(block ?? {})
      .filter(([name]) => name.startsWith('@noblecloak/') || workspaceNames.has(name))
      .map(([name, range]) => ({ name, range }))
  );
}

/** A package this run publishes, with the internal dependencies its tarball declares. */
export interface PublishCandidate {
  readonly name: string;
  readonly version: string;
  readonly dependencies: readonly InternalDependency[];
}

/**
 * The problems that stop the run, one line per unmet dependency. A dependency is met when its
 * range is an exact version that the registry already has, or that a candidate publishes in this
 * run at exactly that version.
 */
export function unmetDependencies(
  candidates: readonly PublishCandidate[],
  registry: (name: string, version: string) => RegistryState,
  where: { readonly label: string; readonly hint: string } = {
    label: 'npm',
    hint: '',
  }
): string[] {
  const publishing = new Map(candidates.map((c) => [c.name, c.version]));
  const problems: string[] = [];
  for (const candidate of candidates) {
    const who = `${candidate.name}@${candidate.version}`;
    for (const dep of candidate.dependencies) {
      if (!EXACT_VERSION.test(dep.range)) {
        problems.push(
          `${who} depends on ${dep.name}@${dep.range}, which is not an exact version; the packed tarball must pin it.`
        );
        continue;
      }
      if (publishing.get(dep.name) === dep.range) continue;
      const state = registry(dep.name, dep.range);
      if (state.kind === 'versions' && state.versions.includes(dep.range)) continue;
      const missing =
        state.kind === 'not-found'
          ? `${dep.name} is not on ${where.label} yet`
          : `${where.label} has no ${dep.name}@${dep.range}`;
      const queued = publishing.get(dep.name);
      const run =
        queued === undefined
          ? 'and this run does not publish it'
          : `and this run publishes ${dep.name}@${queued}`;
      problems.push(
        `${who} depends on ${dep.name}@${dep.range}, but ${missing} ${run}. Seed or publish ${dep.name}@${dep.range} in the same release${where.hint}.`
      );
    }
  }
  return problems;
}

/**
 * Orders candidates so each comes after the candidates it depends on, keeping the input order
 * otherwise. Throws on a dependency cycle.
 */
export function publishOrder<T extends PublishCandidate>(candidates: readonly T[]): T[] {
  const names = new Set(candidates.map((c) => c.name));
  const ordered: T[] = [];
  const placed = new Set<string>();
  let remaining = [...candidates];
  while (remaining.length > 0) {
    const next = remaining.find((c) =>
      c.dependencies.every((d) => !names.has(d.name) || d.name === c.name || placed.has(d.name))
    );
    if (next === undefined) {
      throw new Error(`dependency cycle among ${remaining.map((c) => c.name).join(', ')}`);
    }
    ordered.push(next);
    placed.add(next.name);
    remaining = remaining.filter((c) => c !== next);
  }
  return ordered;
}

/** What differs between the two registries; `release` reads everything else from the tarballs. */
export interface ReleaseOptions {
  /** `--registry`: absent or `NPMJS_REGISTRY` is npm, `GITHUB_REGISTRY` is GitHub Packages. */
  readonly registry?: string;
  /** GitHub only: the value of `NODE_AUTH_TOKEN`; an empty one refuses the run. */
  readonly token?: string;
  /** GitHub only: the per-version precheck; `main` builds it, and a GitHub run without one throws. */
  readonly versionLookup?: VersionLookup;
}

/**
 * `lookup` (npmjs, by name) has no default: the caller builds it for the registry it passes, so a
 * lookup can never silently name a different registry from the publish.
 */
export function release(
  root: string,
  out: (line: string) => void,
  lookup: RegistryLookup,
  run: Runner = runCommand,
  list: EntryLister = listTarEntries,
  readManifest: ManifestReader = readPackedManifest,
  options: ReleaseOptions = {}
): number {
  const github = options.registry === GITHUB_REGISTRY;
  if (github && (options.token ?? '') === '') {
    out(`::error::NODE_AUTH_TOKEN is empty; publishing to ${GITHUB_REGISTRY} needs the job token.`);
    out('::error::Nothing was published.');
    return 1;
  }
  const versionLookup = options.versionLookup;
  if (github && versionLookup === undefined) {
    throw new Error('a GitHub Packages run needs a versionLookup');
  }
  const tarballs = verifyTarballs(join(root, 'artifacts'), list);
  const packages = listPublicPackages(root);
  const workspaceNames = new Set(packages.map((pkg) => pkg.name));
  const states = new Map<string, RegistryState>();
  const registry = (name: string, version: string): RegistryState => {
    // On GitHub the answer is for one exact version, so the cache key carries it.
    const key = github ? `${name}@${version}` : name;
    const known = states.get(key);
    if (known !== undefined) return known;
    const state: RegistryState = github
      ? {
          kind: 'versions',
          versions: versionLookup?.(name, version) === 'present' ? [version] : [],
        }
      : lookup(name);
    states.set(key, state);
    return state;
  };

  const candidates: (PublishCandidate & { readonly tarball: string })[] = [];
  const problems: string[] = [];
  try {
    for (const pkg of packages) {
      if (github && !GITHUB_PACKAGES_ALLOWLIST.includes(pkg.name)) {
        out(`${pkg.name} is not published to GitHub Packages; skipped.`);
        continue;
      }
      const state = registry(pkg.name, pkg.version);
      // On GitHub `state` lists at most this version, so a package the registry has never seen is
      // `publish` (the job token creates it), never `skip-not-seeded`.
      const decision = decide(pkg.version, state);
      if (decision === 'skip-not-seeded') {
        out(`::warning::${pkg.name} is not on npm yet; skipped. First publish is manual.`);
      } else if (decision === 'skip-already-published') {
        out(`${pkg.name}@${pkg.version} already published; skipped.`);
      } else {
        const tarball = tarballFor(pkg, tarballs);
        const dependencies = internalDependencies(readManifest(tarball), workspaceNames);
        candidates.push({ name: pkg.name, version: pkg.version, dependencies, tarball });
      }
    }
    problems.push(
      ...unmetDependencies(
        candidates,
        registry,
        github ? { label: 'GitHub Packages', hint: '' } : undefined
      )
    );
  } catch (error) {
    if (!github) throw error;
    // A lookup that is neither "found" nor "404" is not evidence the version is absent.
    out(`::error::${error instanceof Error ? error.message : String(error)}`);
    out('::error::Nothing was published.');
    return 1;
  }

  if (problems.length > 0) {
    for (const problem of problems) out(`::error::${problem}`);
    out('::error::Nothing was published.');
    return 1;
  }

  const ordered = publishOrder(candidates);
  for (const [index, candidate] of ordered.entries()) {
    const status = run(
      'npm',
      github
        ? ['publish', candidate.tarball, ...registryFlags(GITHUB_REGISTRY)]
        : [
            'publish',
            candidate.tarball,
            ...registryFlags(NPMJS_REGISTRY),
            '--provenance',
            '--access',
            'public',
          ],
      root
    );
    if (status === 0) {
      out(`published ${candidate.name}@${candidate.version}`);
      continue;
    }
    out(`::error::npm publish failed for ${candidate.name}@${candidate.version}`);
    const rest = ordered.slice(index + 1).map((c) => `${c.name}@${c.version}`);
    if (rest.length > 0) {
      out(
        `::error::Stopped before ${rest.join(', ')}; a rerun publishes what ${github ? 'the registry' : 'npm'} does not have.`
      );
    }
    return 1;
  }
  return 0;
}

/** What `main` reaches outside the process; tests replace it. */
export interface MainDeps {
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly spawn?: NpmSpawn;
  readonly run?: Runner;
  readonly list?: EntryLister;
  readonly readManifest?: ManifestReader;
}

/**
 * The command line: parses `argv`, builds both lookups from the parsed registry and returns the
 * exit code. A bad argument is 2; `release` returns 0 or 1.
 */
export function main(argv: readonly string[], env: NodeJS.ProcessEnv, deps: MainDeps): number {
  let registry: string;
  try {
    registry = parseRegistryArgument(argv);
  } catch (error) {
    deps.out(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  return release(
    deps.cwd,
    deps.out,
    npmView(registry, deps.spawn),
    deps.run,
    deps.list,
    deps.readManifest,
    { registry, token: env.NODE_AUTH_TOKEN ?? '', versionLookup: githubVersion(deps.spawn) }
  );
}

if (import.meta.main) {
  process.exit(
    main(process.argv.slice(2), process.env, {
      cwd: process.cwd(),
      out: (line) => {
        console.log(line);
      },
    })
  );
}
