import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { missingFiles } from './assert-files.js';
import { listTarEntries, missingEntries, packAll, verifyTarballs } from './pack-all.js';
import type { Runner } from './pack-all.js';
import {
  GITHUB_PACKAGES_ALLOWLIST,
  GITHUB_REGISTRY,
  NPMJS_REGISTRY,
  decide,
  githubVersion,
  internalDependencies,
  main,
  npmView,
  parseNpmView,
  parseRegistryArgument,
  parseVersionView,
  publishOrder,
  readPackedManifest,
  registryFlags,
  release,
  tarballFor,
} from './release.js';
import type { NpmSpawn, RegistryState, VersionLookup } from './release.js';
import { listPublicPackages, listWorkspacePackages } from './workspace.js';

let root: string;

function writePackage(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
  if (manifest.private !== true) {
    writeFileSync(join(root, dir, 'LICENSE'), 'Apache License\n');
    writeFileSync(join(root, dir, 'NOTICE'), 'NobleCloak UI\n');
  }
}

/** Writes a real tarball of the package's package.json, LICENSE and NOTICE, as bun would. */
function fakePack(cwd: string, tarball: string): void {
  const staging = mkdtempSync(join(tmpdir(), 'pack-staging-'));
  mkdirSync(join(staging, 'package'));
  for (const file of ['package.json', 'LICENSE', 'NOTICE']) {
    if (existsSync(join(cwd, file))) copyFileSync(join(cwd, file), join(staging, 'package', file));
  }
  spawnSync('tar', ['czf', tarball, '-C', staging, 'package']);
  rmSync(staging, { recursive: true, force: true });
}

/** A fake `bun pm pack` / `npm publish`: records calls, writes the tarball bun would write. */
function fakeRunner(calls: string[][], failPublish = false): Runner {
  return (command, args, cwd) => {
    calls.push([command, ...args]);
    if (command === 'bun') {
      const destination = args[args.indexOf('--destination') + 1] ?? '';
      const manifest = listWorkspacePackages(root).find((p) => p.dir === cwd);
      if (manifest === undefined) return 1;
      const base = manifest.name.replace(/^@/, '').replace('/', '-');
      fakePack(cwd, join(destination, `${base}-${manifest.version}.tgz`));
      return 0;
    }
    return failPublish ? 1 : 0;
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'release-fixture-'));
  writePackage('.', {
    name: 'root',
    private: true,
    workspaces: ['packages/*', 'tools', 'missing/*'],
  });
  writePackage('packages/a', { name: '@noblecloak/a', version: '1.0.0' });
  writePackage('packages/b', { name: 'n8n-nodes-noblecloak', version: '0.1.0' });
  writePackage('tools', { name: '@noblecloak/tools', version: '0.0.0', private: true });
  mkdirSync(join(root, 'packages/not-a-package'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('workspace listing', () => {
  it('resolves literal and trailing-star globs, only directories with a package.json', () => {
    expect(listWorkspacePackages(root).map((p) => p.name)).toEqual([
      '@noblecloak/a',
      'n8n-nodes-noblecloak',
      '@noblecloak/tools',
    ]);
  });

  it('treats a workspace without a workspaces field as empty', () => {
    writePackage('.', { name: 'root', private: true });
    expect(listWorkspacePackages(root)).toEqual([]);
  });

  it('lists only non-private packages as public', () => {
    expect(listPublicPackages(root).map((p) => p.name)).toEqual([
      '@noblecloak/a',
      'n8n-nodes-noblecloak',
    ]);
  });
});

describe('decide', () => {
  const published: RegistryState = { kind: 'versions', versions: ['0.9.0', '1.0.0'] };
  it('skips a package npm has never seen, instead of publishing it with a token', () => {
    expect(decide('1.0.0', { kind: 'not-found' })).toBe('skip-not-seeded');
  });
  it('skips a version that is already published', () => {
    expect(decide('1.0.0', published)).toBe('skip-already-published');
  });
  it('publishes a new version of a seeded package', () => {
    expect(decide('1.1.0', published)).toBe('publish');
  });
});

describe('parseNpmView', () => {
  it('reads a version list', () => {
    expect(parseNpmView(0, '["0.1.0","0.2.0"]', '')).toEqual({
      kind: 'versions',
      versions: ['0.1.0', '0.2.0'],
    });
  });
  it('reads a single version', () => {
    expect(parseNpmView(0, '"0.1.0"', '')).toEqual({ kind: 'versions', versions: ['0.1.0'] });
  });
  it('maps a 404 to not-found', () => {
    expect(parseNpmView(1, '', 'npm error code E404')).toEqual({ kind: 'not-found' });
    expect(parseNpmView(1, '{"error":{"code":"E404"}}', '')).toEqual({ kind: 'not-found' });
  });
  it('throws on any other failure', () => {
    expect(() => parseNpmView(1, '', 'npm error code ETIMEDOUT')).toThrow(/ETIMEDOUT/);
  });
});

describe('packAll', () => {
  it('packs every public package into artifacts/', () => {
    const calls: string[][] = [];
    const tarballs = packAll(root, fakeRunner(calls));
    expect(tarballs.map((t) => t.split('/').pop())).toEqual([
      'n8n-nodes-noblecloak-0.1.0.tgz',
      'noblecloak-a-1.0.0.tgz',
    ]);
    expect(calls).toHaveLength(2);
  });

  it('fails loudly when a pack fails', () => {
    expect(() => packAll(root, () => 2)).toThrow(/bun pm pack failed for @noblecloak\/a/);
  });

  it('refuses a tarball that does not carry LICENSE and NOTICE', () => {
    rmSync(join(root, 'packages/b/NOTICE'));
    rmSync(join(root, 'packages/a/LICENSE'));
    expect(() => packAll(root, fakeRunner([]))).toThrow(
      'n8n-nodes-noblecloak-0.1.0.tgz is missing package/NOTICE\n' +
        'noblecloak-a-1.0.0.tgz is missing package/LICENSE'
    );
  });

  it('reads the entries of a real tarball', () => {
    const tarball = join(root, 'a.tgz');
    fakePack(join(root, 'packages/a'), tarball);
    expect(listTarEntries(tarball)).toEqual(
      expect.arrayContaining(['package/package.json', 'package/LICENSE', 'package/NOTICE'])
    );
    expect(missingEntries(listTarEntries(tarball))).toEqual([]);
    expect(() => listTarEntries(join(root, 'missing.tgz'))).toThrow(/tar tzf failed/);
  });
});

describe('verifyTarballs', () => {
  it('fails when the artifact directory is missing or empty', () => {
    expect(() => verifyTarballs(join(root, 'artifacts'))).toThrow(/does not exist/);
    mkdirSync(join(root, 'artifacts'));
    expect(() => verifyTarballs(join(root, 'artifacts'))).toThrow(/holds no \.tgz files/);
  });
});

describe('release', () => {
  // The pack job builds the tarballs; the publish job only downloads them into artifacts/.
  beforeEach(() => {
    packAll(root, fakeRunner([]));
  });

  it('publishes the downloaded tarballs without packing, installing or building', () => {
    const calls: string[][] = [];
    const lookup = (): RegistryState => ({ kind: 'versions', versions: [] });
    expect(release(root, () => undefined, lookup, fakeRunner(calls))).toBe(0);
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['npm publish', 'npm publish']);
  });

  it('refuses to run when the pack artifact was not downloaded', () => {
    rmSync(join(root, 'artifacts'), { recursive: true });
    const lookup = (): RegistryState => ({ kind: 'versions', versions: [] });
    expect(() => release(root, () => undefined, lookup, fakeRunner([]))).toThrow(/does not exist/);
  });

  it('publishes seeded packages with provenance and skips unseeded ones with a warning', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = (name: string): RegistryState =>
      name === '@noblecloak/a' ? { kind: 'versions', versions: ['0.9.0'] } : { kind: 'not-found' };
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner(calls))).toBe(0);
    const publishes = calls.filter((c) => c[0] === 'npm');
    expect(publishes).toHaveLength(1);
    expect(publishes[0]).toEqual([
      'npm',
      'publish',
      join(root, 'artifacts', 'noblecloak-a-1.0.0.tgz'),
      ...registryFlags(NPMJS_REGISTRY),
      '--provenance',
      '--access',
      'public',
    ]);
    expect(lines).toContain('published @noblecloak/a@1.0.0');
    expect(
      lines.some((l) => l.startsWith('::warning::n8n-nodes-noblecloak is not on npm yet'))
    ).toBe(true);
  });

  it('skips a version that is already on npm', () => {
    const lines: string[] = [];
    const lookup = (): RegistryState => ({ kind: 'versions', versions: ['1.0.0', '0.1.0'] });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner([]))).toBe(0);
    expect(lines).toContain('@noblecloak/a@1.0.0 already published; skipped.');
  });

  it('exits 1 when a publish fails', () => {
    const lines: string[] = [];
    const lookup = (): RegistryState => ({ kind: 'versions', versions: [] });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner([], true))).toBe(1);
    expect(lines).toContain('::error::npm publish failed for @noblecloak/a@1.0.0');
  });

  it('refuses to publish a package whose tarball is missing', () => {
    const pkg = { dir: root, name: '@noblecloak/a', version: '1.0.0', private: false };
    expect(() => tarballFor(pkg, [])).toThrow(/no packed tarball/);
  });
});

describe('release dependency guard', () => {
  // react ships a runtime dependency on theme; bun pm pack has rewritten workspace:* to 0.1.0 in
  // the tarball, which is what the fixture writes. Listing order puts react before theme.
  beforeEach(() => {
    writePackage('packages/react', {
      name: '@noblecloak/react',
      version: '0.6.1',
      dependencies: { '@noblecloak/theme': '0.1.0', 'some-lib': '1.2.3' },
      peerDependencies: { react: '^19.0.0' },
      devDependencies: { '@noblecloak/spec': '9.9.9' },
    });
    writePackage('packages/theme', { name: '@noblecloak/theme', version: '0.1.0' });
    packAll(root, fakeRunner([]));
  });

  const published = (calls: string[][]): string[] =>
    calls.filter((c) => c[0] === 'npm').map((c) => (c[2] ?? '').split('/').pop() ?? '');

  function registry(entries: Record<string, RegistryState>): (name: string) => RegistryState {
    return (name) => entries[name] ?? { kind: 'versions', versions: ['1.0.0', '0.1.0'] };
  }

  it('publishes nothing when a publishing package needs a dependency npm has never seen', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({
      '@noblecloak/react': { kind: 'versions', versions: ['0.6.0'] },
      '@noblecloak/theme': { kind: 'not-found' },
      '@noblecloak/a': { kind: 'versions', versions: [] },
    });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner(calls))).toBe(1);
    expect(published(calls)).toEqual([]);
    expect(lines).toContain(
      '::error::@noblecloak/react@0.6.1 depends on @noblecloak/theme@0.1.0, but @noblecloak/theme is not on npm yet and this run does not publish it. Seed or publish @noblecloak/theme@0.1.0 in the same release.'
    );
    expect(lines).toContain('::error::Nothing was published.');
  });

  it('publishes a dependent whose dependency is already on npm at that version', () => {
    const calls: string[][] = [];
    const lookup = registry({
      '@noblecloak/react': { kind: 'versions', versions: ['0.6.0'] },
      '@noblecloak/theme': { kind: 'versions', versions: ['0.1.0'] },
    });
    expect(release(root, () => undefined, lookup, fakeRunner(calls))).toBe(0);
    expect(published(calls)).toEqual(['noblecloak-react-0.6.1.tgz']);
  });

  it('publishes a dependency released in the same run before its dependent', () => {
    const calls: string[][] = [];
    const lookup = registry({
      '@noblecloak/react': { kind: 'versions', versions: ['0.6.0'] },
      '@noblecloak/theme': { kind: 'versions', versions: ['0.0.9'] },
    });
    expect(release(root, () => undefined, lookup, fakeRunner(calls))).toBe(0);
    expect(published(calls)).toEqual(['noblecloak-theme-0.1.0.tgz', 'noblecloak-react-0.6.1.tgz']);
  });

  it('publishes nothing when the dependency this run publishes is a different version', () => {
    writePackage('packages/theme', { name: '@noblecloak/theme', version: '0.2.0' });
    rmSync(join(root, 'artifacts'), { recursive: true });
    packAll(root, fakeRunner([]));
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({
      '@noblecloak/react': { kind: 'versions', versions: ['0.6.0'] },
      '@noblecloak/theme': { kind: 'versions', versions: ['0.0.9'] },
    });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner(calls))).toBe(1);
    expect(published(calls)).toEqual([]);
    expect(lines).toContain(
      '::error::@noblecloak/react@0.6.1 depends on @noblecloak/theme@0.1.0, but npm has no @noblecloak/theme@0.1.0 and this run publishes @noblecloak/theme@0.2.0. Seed or publish @noblecloak/theme@0.1.0 in the same release.'
    );
  });

  it('refuses a tarball whose internal dependency is not an exact version', () => {
    writePackage('packages/react', {
      name: '@noblecloak/react',
      version: '0.6.1',
      peerDependencies: { '@noblecloak/theme': 'workspace:*' },
    });
    rmSync(join(root, 'artifacts'), { recursive: true });
    packAll(root, fakeRunner([]));
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({ '@noblecloak/react': { kind: 'versions', versions: [] } });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner(calls))).toBe(1);
    expect(published(calls)).toEqual([]);
    expect(lines).toContain(
      '::error::@noblecloak/react@0.6.1 depends on @noblecloak/theme@workspace:*, which is not an exact version; the packed tarball must pin it.'
    );
  });

  it('leaves a package with no internal dependencies unaffected by an unseeded one', () => {
    const calls: string[][] = [];
    const lookup = registry({
      '@noblecloak/a': { kind: 'versions', versions: ['0.9.0'] },
      '@noblecloak/react': { kind: 'versions', versions: ['0.6.1'] },
      '@noblecloak/theme': { kind: 'not-found' },
    });
    expect(release(root, () => undefined, lookup, fakeRunner(calls))).toBe(0);
    expect(published(calls)).toEqual(['noblecloak-a-1.0.0.tgz']);
  });

  it('stops at the first failed publish so no dependent goes live without its dependency', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({
      '@noblecloak/react': { kind: 'versions', versions: [] },
      '@noblecloak/theme': { kind: 'versions', versions: [] },
    });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner(calls, true))).toBe(1);
    expect(published(calls)).toEqual(['noblecloak-theme-0.1.0.tgz']);
    expect(lines).toContain('::error::npm publish failed for @noblecloak/theme@0.1.0');
    expect(lines).toContain(
      '::error::Stopped before @noblecloak/react@0.6.1; a rerun publishes what npm does not have.'
    );
  });

  it('reads the dependencies out of a real packed tarball', () => {
    const tarball = join(root, 'artifacts', 'noblecloak-react-0.6.1.tgz');
    const names = new Set(['@noblecloak/react', 'n8n-nodes-noblecloak']);
    expect(internalDependencies(readPackedManifest(tarball), names)).toEqual([
      { name: '@noblecloak/theme', range: '0.1.0' },
    ]);
    expect(
      internalDependencies({ peerDependencies: { 'n8n-nodes-noblecloak': '0.1.0' } }, names)
    ).toEqual([{ name: 'n8n-nodes-noblecloak', range: '0.1.0' }]);
    expect(() => readPackedManifest(join(root, 'missing.tgz'))).toThrow(/tar xzOf failed/);
  });

  it('orders dependencies first and refuses a cycle', () => {
    const dep = (name: string) => ({ name, range: '1.0.0' });
    const c = (name: string, deps: string[]) => ({
      name,
      version: '1.0.0',
      dependencies: deps.map(dep),
    });
    expect(
      publishOrder([c('x', ['y', 'outside']), c('y', ['z']), c('z', []), c('w', [])]).map(
        (p) => p.name
      )
    ).toEqual(['z', 'y', 'x', 'w']);
    expect(() => publishOrder([c('x', ['y']), c('y', ['x'])])).toThrow(/dependency cycle/);
  });
});

describe('registry argument', () => {
  it('defaults to npm when absent, so the npm job needs no argument', () => {
    expect(parseRegistryArgument([])).toBe(NPMJS_REGISTRY);
  });
  it('accepts the two registries, as two words or with an equals sign', () => {
    expect(parseRegistryArgument(['--registry', GITHUB_REGISTRY])).toBe(GITHUB_REGISTRY);
    expect(parseRegistryArgument([`--registry=${GITHUB_REGISTRY}`])).toBe(GITHUB_REGISTRY);
    expect(parseRegistryArgument(['--registry', NPMJS_REGISTRY])).toBe(NPMJS_REGISTRY);
  });
  it('refuses any other registry, an empty value and any other argument', () => {
    expect(() => parseRegistryArgument(['--registry', 'https://example.com'])).toThrow(
      /unsupported registry "https:\/\/example.com"/
    );
    expect(() => parseRegistryArgument(['--registry'])).toThrow(/unsupported registry ""/);
    expect(() => parseRegistryArgument(['--provenance'])).toThrow(/unknown argument/);
  });
});

describe('parseVersionView', () => {
  it('reads the version as present', () => {
    expect(parseVersionView(0, '"1.0.0"', '', '1.0.0')).toBe('present');
    expect(parseVersionView(0, '["1.0.0"]', '', '1.0.0')).toBe('present');
  });
  it('reads a 404 and an empty answer as absent', () => {
    expect(parseVersionView(1, '', 'npm error code E404', '1.0.0')).toBe('absent');
    expect(parseVersionView(1, '{"error":{"code":"E404"}}', '', '1.0.0')).toBe('absent');
    expect(parseVersionView(0, '\n', '', '1.0.0')).toBe('absent');
  });
  // Kills: treating a non-404 npm view failure as absent (parseVersionView returns 'absent' instead of throwing).
  it('throws on any other failure and on an answer that is not the version', () => {
    expect(() => parseVersionView(1, '', 'npm error code E401', '1.0.0')).toThrow(/E401/);
    expect(() => parseVersionView(1, '', 'npm error code ETIMEDOUT', '1.0.0')).toThrow(/ETIMEDOUT/);
    expect(() => parseVersionView(0, '"2.0.0"', '', '1.0.0')).toThrow(/not that version/);
  });
});

describe('release to GitHub Packages', () => {
  // spec and react publish (react needs theme, which publishes in the same run); langgraph, a and b are
  // packed too but are not on the allowlist.
  beforeEach(() => {
    writePackage('packages/spec', { name: '@noblecloak/spec', version: '0.9.0' });
    writePackage('packages/react', {
      name: '@noblecloak/react',
      version: '0.8.2',
      dependencies: { '@noblecloak/theme': '0.1.1' },
    });
    writePackage('packages/theme', { name: '@noblecloak/theme', version: '0.1.1' });
    writePackage('packages/langgraph', { name: '@noblecloak/langgraph', version: '0.3.9' });
    packAll(root, fakeRunner([]));
  });

  const github = { registry: GITHUB_REGISTRY, token: 'job-token' };
  const absent: VersionLookup = () => 'absent';
  const npmNames = (): never => {
    throw new Error('the npm name lookup must not run against GitHub Packages');
  };
  const tarballs = (calls: string[][]): string[] =>
    calls.filter((c) => c[0] === 'npm').map((c) => (c[2] ?? '').split('/').pop() ?? '');

  // Kills: treating an empty token as valid (drop the empty-token check in release()).
  it('refuses an empty token before it looks anything up or publishes', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const looked: string[] = [];
    const versionLookup: VersionLookup = (name) => {
      looked.push(name);
      return 'absent';
    };
    for (const tokenOption of [{ token: '' }, {}]) {
      expect(
        release(root, (l) => lines.push(l), npmNames, fakeRunner(calls), undefined, undefined, {
          registry: GITHUB_REGISTRY,
          versionLookup,
          ...tokenOption,
        })
      ).toBe(1);
    }
    expect(lines).toContain(
      `::error::NODE_AUTH_TOKEN is empty; publishing to ${GITHUB_REGISTRY} needs the job token.`
    );
    expect(looked).toEqual([]);
    expect(tarballs(calls)).toEqual([]);
  });

  // Kills: dropping the allowlist check, so every packed package is published to GitHub Packages.
  it('publishes only the allowlist, dependencies first, and names what it skipped', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    expect(
      release(root, (l) => lines.push(l), npmNames, fakeRunner(calls), undefined, undefined, {
        ...github,
        versionLookup: absent,
      })
    ).toBe(0);
    expect(tarballs(calls)).toEqual([
      'noblecloak-spec-0.9.0.tgz',
      'noblecloak-theme-0.1.1.tgz',
      'noblecloak-react-0.8.2.tgz',
    ]);
    for (const name of ['@noblecloak/a', '@noblecloak/langgraph', 'n8n-nodes-noblecloak']) {
      expect(lines).toContain(`${name} is not published to GitHub Packages; skipped.`);
    }
  });

  // Kills: adding --provenance or --access to the GitHub publish arguments.
  it('publishes with --registry and with neither --provenance nor --access', () => {
    const calls: string[][] = [];
    release(root, () => undefined, npmNames, fakeRunner(calls), undefined, undefined, {
      ...github,
      versionLookup: absent,
    });
    const spec = calls.find((c) => (c[2] ?? '').endsWith('noblecloak-spec-0.9.0.tgz'));
    expect(spec).toEqual([
      'npm',
      'publish',
      join(root, 'artifacts', 'noblecloak-spec-0.9.0.tgz'),
      '--registry',
      GITHUB_REGISTRY,
      `--@noblecloak:registry=${GITHUB_REGISTRY}`,
    ]);
    expect(calls.flat()).not.toContain('--provenance');
    expect(calls.flat()).not.toContain('--access');
  });

  // Kills: reading a 404 as present (parseVersionView), which would skip a package the registry lacks.
  it('asks the registry per exact version, and publishes a 404 and skips a present version', () => {
    const asked: string[] = [];
    const lines: string[] = [];
    const calls: string[][] = [];
    const versionLookup: VersionLookup = (name, version) => {
      asked.push(`${name}@${version}`);
      return name === '@noblecloak/spec' ? 'present' : 'absent';
    };
    expect(
      release(root, (l) => lines.push(l), npmNames, fakeRunner(calls), undefined, undefined, {
        ...github,
        versionLookup,
      })
    ).toBe(0);
    expect(asked).toEqual(
      expect.arrayContaining([
        '@noblecloak/spec@0.9.0',
        '@noblecloak/react@0.8.2',
        '@noblecloak/theme@0.1.1',
      ])
    );
    expect(lines).toContain('@noblecloak/spec@0.9.0 already published; skipped.');
    expect(tarballs(calls)).toEqual(['noblecloak-theme-0.1.1.tgz', 'noblecloak-react-0.8.2.tgz']);
  });

  // Kills: swallowing a lookup error after the catch in release() and carrying on to publish.
  it('refuses the run, publishing nothing, when the lookup fails for any reason but a 404', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const versionLookup: VersionLookup = (name) => {
      if (name === '@noblecloak/theme')
        throw new Error('npm view failed (exit 1): E401 Unauthorized');
      return 'absent';
    };
    expect(
      release(root, (l) => lines.push(l), npmNames, fakeRunner(calls), undefined, undefined, {
        ...github,
        versionLookup,
      })
    ).toBe(1);
    expect(tarballs(calls)).toEqual([]);
    expect(lines).toContain('::error::npm view failed (exit 1): E401 Unauthorized');
    expect(lines).toContain('::error::Nothing was published.');
  });

  it('holds a dependent back when its dependency is neither on the registry nor in the run', () => {
    writePackage('packages/theme', { name: '@noblecloak/theme', version: '0.2.0' });
    rmSync(join(root, 'artifacts'), { recursive: true });
    packAll(root, fakeRunner([]));
    const calls: string[][] = [];
    const lines: string[] = [];
    expect(
      release(root, (l) => lines.push(l), npmNames, fakeRunner(calls), undefined, undefined, {
        ...github,
        versionLookup: absent,
      })
    ).toBe(1);
    expect(tarballs(calls)).toEqual([]);
    expect(lines).toContain(
      '::error::@noblecloak/react@0.8.2 depends on @noblecloak/theme@0.1.1, but GitHub Packages has no @noblecloak/theme@0.1.1 and this run publishes @noblecloak/theme@0.2.0. Seed or publish @noblecloak/theme@0.1.1 in the same release.'
    );
  });

  it('stops at the first failed publish and says a rerun publishes what the registry lacks', () => {
    const lines: string[] = [];
    expect(
      release(root, (l) => lines.push(l), npmNames, fakeRunner([], true), undefined, undefined, {
        ...github,
        versionLookup: absent,
      })
    ).toBe(1);
    expect(lines).toContain('::error::npm publish failed for @noblecloak/spec@0.9.0');
    expect(lines).toContain(
      '::error::Stopped before @noblecloak/theme@0.1.1, @noblecloak/react@0.8.2; a rerun publishes what the registry does not have.'
    );
  });

  // Kills: giving the npm path the GitHub publish arguments (the registry branch always true).
  it('leaves the npm path alone: the npm registry argument keeps provenance and the name lookup', () => {
    const calls: string[][] = [];
    const lookup = (): RegistryState => ({ kind: 'versions', versions: [] });
    expect(
      release(root, () => undefined, lookup, fakeRunner(calls), undefined, undefined, {
        registry: NPMJS_REGISTRY,
      })
    ).toBe(0);
    const spec = calls.find((c) => (c[2] ?? '').endsWith('noblecloak-spec-0.9.0.tgz'));
    expect(spec?.slice(3)).toEqual([
      '--registry',
      NPMJS_REGISTRY,
      `--@noblecloak:registry=${NPMJS_REGISTRY}`,
      '--provenance',
      '--access',
      'public',
    ]);
  });

  // A public package (not `private`, so it is packed and scanned) that no publish allowlist names yet.
  // Adding a name here is a decision to hold the package back; removing it needs the allowlist entry.
  const HELD_BACK = ['@noblecloak/cards'];

  it('allowlists exactly the public packages, except those held back', () => {
    const publicNames = listPublicPackages(resolve(import.meta.dirname, '..')).map((p) => p.name);
    const publishable = publicNames.filter((name) => !HELD_BACK.includes(name));
    expect([...GITHUB_PACKAGES_ALLOWLIST].sort()).toEqual([...publishable].sort());
    for (const name of HELD_BACK) expect(publicNames).toContain(name);
  });
});

/** Both registry flags, in the pair order `registryFlags` emits, somewhere in an npm argument list. */
function pinnedTo(args: readonly string[], registry: string): boolean {
  const at = args.indexOf('--registry');
  return (
    at >= 0 &&
    args[at + 1] === registry &&
    args.filter((a) => a.startsWith('--@noblecloak:registry=')).join() ===
      `--@noblecloak:registry=${registry}`
  );
}

describe('scope pinning: every npm call names the registry twice', () => {
  const answer = (stdout: string, status = 0): ReturnType<NpmSpawn> => ({
    status,
    stdout,
    stderr: '',
  });

  beforeEach(() => {
    writePackage('packages/spec', { name: '@noblecloak/spec', version: '0.9.0' });
    packAll(root, fakeRunner([]));
  });

  it('registryFlags is the registry flag and the scope flag', () => {
    expect(registryFlags(GITHUB_REGISTRY)).toEqual([
      '--registry',
      GITHUB_REGISTRY,
      `--@noblecloak:registry=${GITHUB_REGISTRY}`,
    ]);
  });

  // Kills: dropping the scope flag from the name lookup's argument list in npmView().
  it('the npmjs name lookup carries both flags', () => {
    const seen: string[][] = [];
    const lookup = npmView(NPMJS_REGISTRY, (args) => {
      seen.push([...args]);
      return answer('["1.0.0"]');
    });
    lookup('@noblecloak/spec');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.slice(0, 4)).toEqual(['view', '@noblecloak/spec', 'versions', '--json']);
    expect(pinnedTo(seen[0] ?? [], NPMJS_REGISTRY)).toBe(true);
  });

  // Kills: dropping the scope flag from the per-version lookup's argument list in githubVersion().
  it('the GitHub version lookup carries both flags', () => {
    const seen: string[][] = [];
    const lookup = githubVersion((args) => {
      seen.push([...args]);
      return { status: 1, stdout: '', stderr: 'npm error code E404' };
    });
    expect(lookup('@noblecloak/spec', '0.9.0')).toBe('absent');
    expect(seen[0]?.slice(0, 3)).toEqual(['view', '@noblecloak/spec@0.9.0', 'version']);
    expect(pinnedTo(seen[0] ?? [], GITHUB_REGISTRY)).toBe(true);
  });

  // Kills: dropping the scope flag from either publish branch of release().
  it.each([[NPMJS_REGISTRY], [GITHUB_REGISTRY]])(
    'main publishes to %s with both flags, and its view calls carry them too',
    (registry) => {
      const views: string[][] = [];
      const publishes: string[][] = [];
      const code = main(
        registry === NPMJS_REGISTRY ? [] : ['--registry', registry],
        { NODE_AUTH_TOKEN: 'job-token' },
        {
          cwd: root,
          out: () => undefined,
          spawn: (args) => {
            views.push([...args]);
            // npmjs: the name is seeded; GitHub: the version is a 404 (to be published).
            return registry === NPMJS_REGISTRY
              ? answer('["0.1.0"]')
              : { status: 1, stdout: '', stderr: 'npm error code E404' };
          },
          run: (command, args) => {
            if (command === 'npm') publishes.push([...args]);
            return 0;
          },
        }
      );
      expect(code).toBe(0);
      expect(views.length).toBeGreaterThan(0);
      expect(publishes.length).toBeGreaterThan(0);
      for (const args of [...views, ...publishes]) expect(pinnedTo(args, registry)).toBe(true);
      expect(publishes.flat().includes('--provenance')).toBe(registry === NPMJS_REGISTRY);
    }
  );
});

describe('main', () => {
  beforeEach(() => {
    writePackage('packages/spec', { name: '@noblecloak/spec', version: '0.9.0' });
    packAll(root, fakeRunner([]));
  });

  const notFound = { status: 1, stdout: '', stderr: 'npm error code E404' };

  // Kills: main() passing npmjs as the registry to release() whatever --registry says (no allowlist, no token check).
  it('--registry GITHUB applies the allowlist through the GitHub per-version lookup', () => {
    const views: string[][] = [];
    const publishes: string[][] = [];
    const lines: string[] = [];
    const code = main(
      ['--registry', GITHUB_REGISTRY],
      { NODE_AUTH_TOKEN: 'job-token' },
      {
        cwd: root,
        out: (l) => lines.push(l),
        spawn: (args) => {
          views.push([...args]);
          return notFound;
        },
        run: (_command, args) => {
          publishes.push([...args]);
          return 0;
        },
      }
    );
    expect(code).toBe(0);
    expect(views.length).toBeGreaterThan(0);
    expect(views.every((v) => v[2] === 'version')).toBe(true);
    expect(publishes.map((a) => (a[1] ?? '').split('/').pop())).toEqual([
      'noblecloak-spec-0.9.0.tgz',
    ]);
    expect(lines).toContain('@noblecloak/a is not published to GitHub Packages; skipped.');
  });

  // Kills: main() handing release() a made-up token instead of env.NODE_AUTH_TOKEN, so an empty one reaches npm.
  it('--registry GITHUB with an empty or missing token refuses before any npm call', () => {
    for (const env of [{ NODE_AUTH_TOKEN: '' }, {}]) {
      const npmCalls: string[][] = [];
      const lines: string[] = [];
      const code = main(['--registry', GITHUB_REGISTRY], env, {
        cwd: root,
        out: (l) => lines.push(l),
        spawn: (args) => {
          npmCalls.push([...args]);
          return notFound;
        },
        run: (_command, args) => {
          npmCalls.push([...args]);
          return 0;
        },
      });
      expect(code).toBe(1);
      expect(npmCalls).toEqual([]);
      expect(lines.some((l) => l.includes('NODE_AUTH_TOKEN is empty'))).toBe(true);
    }
  });

  // Kills: main() passing GitHub as the registry to release() when no --registry is given (allowlist and token check on npmjs).
  it('no argument keeps the npmjs behaviour: name lookup, skip-not-seeded, no token needed', () => {
    const views: string[][] = [];
    const publishes: string[][] = [];
    const lines: string[] = [];
    const code = main(
      [],
      {},
      {
        cwd: root,
        out: (l) => lines.push(l),
        spawn: (args) => {
          views.push([...args]);
          return (args[1] ?? '') === '@noblecloak/spec'
            ? { status: 0, stdout: '["0.1.0"]', stderr: '' }
            : notFound;
        },
        run: (_command, args) => {
          publishes.push([...args]);
          return 0;
        },
      }
    );
    expect(code).toBe(0);
    expect(views.every((v) => v[2] === 'versions')).toBe(true);
    expect(publishes.map((a) => (a[1] ?? '').split('/').pop())).toEqual([
      'noblecloak-spec-0.9.0.tgz',
    ]);
    expect(publishes[0]).toContain('--provenance');
    expect(lines.some((l) => l.startsWith('::warning::@noblecloak/a is not on npm yet'))).toBe(
      true
    );
  });

  // Kills: main() returning 1 (or throwing) for an unparseable command line.
  it('exits 2 on a bad argument, before any npm call', () => {
    for (const argv of [['--registry', 'https://example.com'], ['--provenance'], ['--registry']]) {
      const npmCalls: string[][] = [];
      const lines: string[] = [];
      const code = main(
        argv,
        { NODE_AUTH_TOKEN: 'job-token' },
        {
          cwd: root,
          out: (l) => lines.push(l),
          spawn: (args) => {
            npmCalls.push([...args]);
            return notFound;
          },
          run: (_command, args) => {
            npmCalls.push([...args]);
            return 0;
          },
        }
      );
      expect(code).toBe(2);
      expect(npmCalls).toEqual([]);
      expect(lines[0]).toMatch(/^::error::/);
    }
  });
});

describe('missingFiles', () => {
  it('returns only the paths that do not exist', () => {
    expect(missingFiles(root, ['package.json', 'dist/schema.d.ts'])).toEqual(['dist/schema.d.ts']);
  });
});
