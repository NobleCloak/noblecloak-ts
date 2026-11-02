import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findViolations, runGuard } from './check-private-deps.js';

const CLEAN_PACKAGE = { name: '@noblecloak/fixture', license: 'Apache-2.0' };

let root: string;

function write(relativePath: string, content: unknown): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-fixture-'));
  write('package.json', { name: 'fixture-root', private: true, license: 'Apache-2.0' });
  write('packages/a/package.json', CLEAN_PACKAGE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findViolations', () => {
  it('passes a clean workspace', () => {
    expect(findViolations(root)).toEqual([]);
  });

  it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])(
    'flags a dependency resolved from a tarball URL in %s and names the file and key',
    (field) => {
      write('packages/a/package.json', {
        ...CLEAN_PACKAGE,
        [field]: {
          '@acme-private/shared-auth': 'https://registry.acme.example/shared-auth-1.0.0.tgz',
        },
      });
      expect(findViolations(root)).toEqual([
        {
          file: 'packages/a/package.json',
          key: `${field}.@acme-private/shared-auth`,
          kind: 'foreign-source-dependency',
        },
      ]);
    }
  );

  it.each([
    ['a git URL', 'git+https://git.acme.example/acme-private/shared-auth.git#v1'],
    ['a github: shorthand', 'github:acme-private/shared-auth'],
    ['an owner/repo shorthand', 'acme-private/shared-auth#main'],
    ['a file: path', 'file:../vendor/shared-auth.tgz'],
    ['a link: path', 'link:../shared-auth'],
  ])('flags a dependency on %s', (_label, spec) => {
    write('packages/a/package.json', { ...CLEAN_PACKAGE, dependencies: { 'shared-auth': spec } });
    expect(findViolations(root)).toEqual([
      {
        file: 'packages/a/package.json',
        key: 'dependencies.shared-auth',
        kind: 'foreign-source-dependency',
      },
    ]);
  });

  it('passes registry versions, ranges, workspace links and npm: aliases of public packages', () => {
    write('packages/a/package.json', {
      ...CLEAN_PACKAGE,
      dependencies: {
        '@acme-public/lib': '1.2.3',
        range: '>=1.0.0 <2.0.0 || ^3.1.0',
        local: 'workspace:*',
        alias: 'npm:@acme-public/other@1.0.0',
        tag: 'latest',
      },
    });
    expect(findViolations(root)).toEqual([]);
  });

  it("names no scope: an @acme-private package from the public registry is not the guard's business", () => {
    write('packages/a/package.json', {
      ...CLEAN_PACKAGE,
      dependencies: { '@acme-private/shared-auth': '^1.0.0' },
    });
    expect(findViolations(root)).toEqual([]);
  });

  it('flags a scope registry mapping in an .npmrc', () => {
    write('packages/a/.npmrc', '@acme-private:registry=https://npm.acme.example\n');
    expect(findViolations(root)).toEqual([
      { file: 'packages/a/.npmrc', key: 'line 1', kind: 'foreign-registry' },
    ]);
  });

  it('flags a tarball URL from another host in bun.lock and passes registry.npmjs.org ones', () => {
    write(
      'bun.lock',
      [
        '{',
        '  "packages": {',
        '    "@acme-private/shared-auth": ["@acme-private/shared-auth@1.0.0", "https://npm.acme.example/download/x.tgz", {}],',
        '    "zod": ["zod@4.0.0", "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz", {}, "sha512-x"],',
        '    "viaGit": ["viaGit@github:acme-private/via-git#abc", {}],',
        '  },',
        '}',
      ].join('\n')
    );
    expect(findViolations(root)).toEqual([
      { file: 'bun.lock', key: 'line 3', kind: 'foreign-source-dependency' },
      { file: 'bun.lock', key: 'line 5', kind: 'foreign-source-dependency' },
    ]);
  });

  it('passes a bun.lock that only names the public registry', () => {
    write(
      'bun.lock',
      '{\n  "packages": {\n    "zod": ["zod@4.0.0", "", {}, "sha512-x"],\n    "w": ["w@workspace:packages/w"],\n  },\n}\n'
    );
    expect(findViolations(root)).toEqual([]);
  });

  it('flags a registry other than registry.npmjs.org in bunfig.toml', () => {
    write('bunfig.toml', '[install.scopes]\nacme-private = "https://npm.acme.example"\n');
    expect(findViolations(root)).toEqual([
      { file: 'bunfig.toml', key: 'line 2', kind: 'foreign-registry' },
    ]);
  });

  it('passes the public registry in an .npmrc and in bunfig.toml', () => {
    write('.npmrc', 'registry=https://registry.npmjs.org/\n');
    write('bunfig.toml', '[install]\nregistry = "https://registry.npmjs.org"\n');
    expect(findViolations(root)).toEqual([]);
  });

  it('flags a foreign publishConfig.registry', () => {
    write('packages/a/package.json', {
      ...CLEAN_PACKAGE,
      publishConfig: { registry: 'https://npm.acme.example' },
    });
    expect(findViolations(root)).toEqual([
      {
        file: 'packages/a/package.json',
        key: 'publishConfig.registry',
        kind: 'foreign-registry',
      },
    ]);
  });

  it('flags an auth token line in an .npmrc', () => {
    write('.npmrc', 'registry=https://registry.npmjs.org\n//registry.npmjs.org/:_authToken=abc\n');
    expect(findViolations(root)).toEqual([
      { file: '.npmrc', key: 'line 2', kind: 'npm-auth-token' },
    ]);
  });

  it.each([
    ['missing', undefined],
    ['a different license', 'MIT'],
  ])('flags a package.json whose license is %s', (_label, license) => {
    write('packages/a/package.json', { name: '@noblecloak/fixture', license });
    expect(findViolations(root)).toEqual([
      { file: 'packages/a/package.json', key: 'license', kind: 'missing-apache-license' },
    ]);
  });

  it('reports a package.json that is not valid JSON', () => {
    write('packages/a/package.json', '{ not json');
    expect(findViolations(root)).toEqual([
      { file: 'packages/a/package.json', key: '(file)', kind: 'unreadable-package-json' },
    ]);
  });

  it('does not descend into node_modules or build output', () => {
    write('node_modules/x/package.json', { name: 'x', license: 'MIT' });
    write('packages/a/dist/package.json', { name: 'y' });
    expect(findViolations(root)).toEqual([]);
  });
});

describe('runGuard', () => {
  it('prints each violation with its file and exits 1', () => {
    write('packages/a/package.json', {
      name: '@noblecloak/fixture',
      devDependencies: { '@acme-private/shared-types': 'github:acme-private/shared-types' },
    });
    const lines: string[] = [];
    expect(runGuard(root, (line) => lines.push(line))).toBe(1);
    expect(lines.join('\n')).toContain(
      'packages/a/package.json: devDependencies.@acme-private/shared-types'
    );
    expect(lines.join('\n')).toContain('packages/a/package.json: license');
  });

  it('prints a success line and exits 0 on a clean workspace', () => {
    const lines: string[] = [];
    expect(runGuard(root, (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual(['private-dependency guard: OK (2 package.json files checked)']);
  });
});
