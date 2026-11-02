/**
 * Repository policy: the properties the repository's foundation requires, asserted against the tree so a
 * change that breaks one fails CI instead of surfacing at the public release.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { findViolations } from './check-private-deps.js';
import { listWorkspacePackages } from './workspace.js';

const ROOT = resolve(import.meta.dirname, '..');
const GATE = "vars.PUBLIC_RELEASE_ENABLED == 'true'";
// The second gate: the organisation's own repository, and only for a job that publishes to GitHub Packages.
const PRIVATE_GATE_TERMS = [
  "github.repository_owner == 'NobleCloak'",
  "vars.PRIVATE_PUBLISH_ENABLED == 'true'",
];
const GITHUB_RELEASE_RUN =
  'bun --no-install scripts/release.ts --registry https://npm.pkg.github.com';

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(read(path)) as Record<string, unknown>;

interface Step {
  uses?: string;
  run?: string;
  name?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
/** A permissions block: a scope map, or a string (`read-all`, `write-all`). */
type Permissions = Record<string, string> | string;
interface Job {
  name?: string;
  uses?: string;
  needs?: string | string[];
  environment?: string | { name?: string; url?: string };
  strategy?: { matrix?: Record<string, unknown> };
  if?: string;
  permissions?: Permissions;
  env?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  permissions?: Permissions;
  jobs: Record<string, Job>;
}

const isPlainMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
// `write-all` (or any string other than `read-all`) grants every write scope, id-token and packages included.
const grantsEverything = (permissions: Permissions | undefined): boolean =>
  typeof permissions === 'string' && permissions !== 'read-all';
const scopeLevel = (permissions: Permissions | undefined, scope: string): string | undefined =>
  isPlainMap(permissions) ? permissions[scope] : undefined;
const holdsWrite = (permissions: Permissions | undefined): boolean =>
  grantsEverything(permissions) ||
  (isPlainMap(permissions) && Object.values(permissions).includes('write'));

/**
 * Every `scope: write` grant as `<file>:<job or (workflow)>:<scope>`; a string block that grants everything
 * (`write-all`) is `<file>:<job or (workflow)>:*`.
 */
const writers = (files: Record<string, Workflow>): string[] => {
  const found: string[] = [];
  for (const [file, workflow] of Object.entries(files)) {
    const scopes = [
      ['(workflow)', workflow.permissions],
      ...Object.entries(workflow.jobs).map(([name, job]) => [name, job.permissions] as const),
    ] as const;
    for (const [name, permissions] of scopes) {
      if (typeof permissions === 'string') {
        if (grantsEverything(permissions)) found.push(`${file}:${name}:*`);
        continue;
      }
      for (const [scope, level] of Object.entries(permissions ?? {})) {
        if (level === 'write') found.push(`${file}:${name}:${scope}`);
      }
    }
  }
  return found.sort();
};

/**
 * `<file>:<job>` for every job that holds any write scope (its own block, or the workflow's when the job has
 * none; `write-all` counts) and has a checkout step that does not set `persist-credentials: false`, which
 * would leave the job's token in `.git/config` for every later step, dependency code included.
 */
const persistingCheckouts = (files: Record<string, Workflow>): string[] => {
  const found: string[] = [];
  for (const [file, workflow] of Object.entries(files)) {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (!holdsWrite(job.permissions ?? workflow.permissions)) continue;
      const bad = (job.steps ?? []).some(
        (step) =>
          step.uses?.startsWith('actions/checkout@') === true &&
          step.with?.['persist-credentials'] !== false
      );
      if (bad) found.push(`${file}:${name}`);
    }
  }
  return found.sort();
};

/**
 * Where a workflow's permissions leave the narrow shape: the top level must be exactly `contents: read`
 * (without it every job inherits the repository default token), and a job's block must be absent or a scope
 * map (a string such as `write-all` is not).
 */
const permissionShapeViolations = (workflow: Workflow): string[] => {
  const found: string[] = [];
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: 'read' }))
    found.push('(workflow)');
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if ('permissions' in job && !isPlainMap(job.permissions)) found.push(name);
  }
  return found;
};

const SHA_PIN = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const DIGEST_PIN = /^docker:\/\/[\w./-]+@sha256:[0-9a-f]{64}$/;

/**
 * Every `uses` that is not a full commit SHA or an image digest (step and job level), and every `uses:` line
 * (quoted or not) whose pin has no version comment: ` # vX.Y.Z` after a SHA, ` # X.Y.Z` after a digest.
 */
const unpinnedUses = (workflow: Workflow, raw: string): string[] => {
  const found: string[] = [];
  const values = Object.values(workflow.jobs).flatMap((job) => [
    ...(job.uses === undefined ? [] : [job.uses]),
    ...(job.steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
  ]);
  for (const value of values) {
    if (!SHA_PIN.test(value) && !DIGEST_PIN.test(value))
      found.push(`${value}: not a SHA or digest pin`);
  }
  for (const line of raw.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const value = /\buses:\s*['"]?([^'"\s#]+)['"]?/.exec(line)?.[1];
    if (value === undefined) continue;
    if (SHA_PIN.test(value) && !/ # v\d+\.\d+\.\d+$/.test(line))
      found.push(`${value}: no # vX.Y.Z comment`);
    if (DIGEST_PIN.test(value) && !/ # \d+\.\d+\.\d+$/.test(line))
      found.push(`${value}: no # X.Y.Z comment`);
  }
  return found;
};

const WORKFLOW_DIR = join(ROOT, '.github/workflows');
const workflowFiles = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml'));
const loadWorkflow = (file: string): Workflow =>
  parse(read(`.github/workflows/${file}`)) as Workflow;

const packages = listWorkspacePackages(ROOT);

describe('license and holder', () => {
  it('NOTICE names NobleCloak as the copyright holder', () => {
    expect(read('NOTICE').split('\n').slice(0, 2)).toEqual([
      'NobleCloak UI',
      'Copyright 2026 NobleCloak',
    ]);
  });

  it.each([
    'package.json',
    ...packages.map((p) => join(p.dir, 'package.json').slice(ROOT.length + 1)),
  ])('%s declares Apache-2.0 and author NobleCloak', (path) => {
    const manifest = readJson(path);
    expect(manifest.license).toBe('Apache-2.0');
    expect(manifest.author).toBe('NobleCloak');
  });

  // The root NOTICE lists the runtime dependencies of every published package, one block per package
  // (a line naming the package, then its entries). A package's own NOTICE is the root header plus only
  // its own block, so it names no dependency it does not install, and a dependency moved to
  // devDependencies is named nowhere.
  const THIRD_PARTY = '== Third-party ==\n';
  const noticeFor = (name: string): string => {
    const root = read('NOTICE');
    const [header = '', third = ''] = root.split(THIRD_PARTY);
    const paragraphs = third.split('\n\n');
    const intro = paragraphs[0] ?? '';
    const blocks = paragraphs.slice(1).join('\n\n');
    const own = blocks
      .split(/\n\n(?=@noblecloak\/\S+\n)/)
      .find((block) => block.startsWith(`${name}\n`));
    return own === undefined
      ? header.replace(/\n+$/, '\n')
      : `${header}${THIRD_PARTY}${intro}\n\n${own.replace(/\n+$/, '')}\n`;
  };

  it.each(packages.filter((p) => !p.private).map((p) => p.dir.slice(ROOT.length + 1)))(
    '%s ships the root LICENSE, and a NOTICE that is the root header plus its own third-party block',
    (dir) => {
      expect(read(`${dir}/LICENSE`), 'LICENSE').toBe(read('LICENSE'));
      const manifest = readJson(`${dir}/package.json`);
      expect(read(`${dir}/NOTICE`), 'NOTICE').toBe(noticeFor(String(manifest.name)));
      expect(manifest.files).toEqual(expect.arrayContaining(['LICENSE', 'NOTICE']));
      // Every third-party runtime dependency is named, and nothing a package does not install is.
      const dependencies = Object.keys(
        (manifest.dependencies ?? {}) as Record<string, string>
      ).filter((name) => !name.startsWith('@noblecloak/'));
      for (const name of dependencies) expect(read(`${dir}/NOTICE`), name).toContain(name);
    }
  );

  it('the root NOTICE names no devDependency of any package', () => {
    const notice = read('NOTICE');
    for (const pkg of packages) {
      const dev = Object.keys(
        readJson(`${pkg.dir.slice(ROOT.length + 1)}/package.json`).devDependencies ?? {}
      );
      const runtime = new Set(
        packages.flatMap((p) =>
          Object.keys(
            (readJson(`${p.dir.slice(ROOT.length + 1)}/package.json`).dependencies ?? {}) as Record<
              string,
              string
            >
          )
        )
      );
      // An entry names a package and its version (`name 1.2.3`); a URL that contains the name is no entry.
      for (const name of dev.filter((n) => !runtime.has(n))) {
        const entry = new RegExp(`(^|\\s)${name.replace(/[/.]/g, '\\$&')} \\d`, 'm');
        expect(notice, name).not.toMatch(entry);
      }
    }
  });

  it('the tree passes the private-dependency guard', () => {
    expect(findViolations(ROOT)).toEqual([]);
  });
});

describe('pre-commit hook', () => {
  it('bun install points git at .githooks, whose pre-commit runs the guard', () => {
    const scripts = readJson('package.json').scripts as Record<string, string>;
    expect(scripts.prepare).toContain('git config core.hooksPath .githooks');
    const hook = join(ROOT, '.githooks/pre-commit');
    expect(statSync(hook).mode & 0o111, 'pre-commit is executable').not.toBe(0);
    expect(read('.githooks/pre-commit')).toMatch(/^exec bun run guard$/m);
  });

  it('the hook exits 0 on this tree', () => {
    const result = spawnSync(join(ROOT, '.githooks/pre-commit'), { cwd: ROOT, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('private-dependency guard: OK');
  }, 60_000);
});

describe('versions are pinned exactly', () => {
  it.each([
    'package.json',
    ...packages.map((p) => join(p.dir, 'package.json').slice(ROOT.length + 1)),
  ])('%s pins every dependency to an exact version', (path) => {
    const manifest = readJson(path);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = (manifest[field] ?? {}) as Record<string, string>;
      for (const [name, range] of Object.entries(deps)) {
        expect(range, `${field}.${name}`).toMatch(/^(\d+\.\d+\.\d+(-[\w.]+)?|workspace:.+)$/);
      }
    }
  });

  it('packageManager pins an exact bun version', () => {
    expect(readJson('package.json').packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
  });

  // The pin is justified only while the installed linter's peer range stops short of 7. Reading
  // the range from node_modules makes the lift mechanical: the week typescript-eslint widens it,
  // the grouped Dependabot bump fails here, and the fix is to lift the pin (CONTRIBUTING.md).
  it('a TypeScript pin behind 7 is forced by typescript-eslint and recorded with its lift', () => {
    const devDependencies = readJson('package.json').devDependencies as Record<string, string>;
    const typescript = devDependencies.typescript ?? '';
    const major = Number(typescript.split('.')[0]);
    if (major >= 7) return;
    const peers = readJson('node_modules/typescript-eslint/package.json').peerDependencies as
      Record<string, string> | undefined;
    const range = peers?.typescript ?? '';
    expect(range, 'typescript-eslint peer range for typescript').not.toBe('');
    // Every `||` clause on its own must carry an upper bound of 7.0.0 or lower; checking the
    // whole string would let one narrow clause hide a wide one (`<6.1.0 || ~7.0.0`).
    for (const clause of range.split('||')) {
      expect(
        clause.trim(),
        `typescript-eslint admits TypeScript 7 (${range}); lift the pin`
      ).toMatch(/<\s*(?:[0-6]\.\d+\.\d+|7\.0\.0)\b/);
    }
    const pins = read('CONTRIBUTING.md').split('## Toolchain pins')[1] ?? '';
    const entry = pins
      .split('\n- ')
      .find((item) => item.startsWith(`**\`typescript\` ${String(major)}.x**`));
    expect(
      entry,
      `CONTRIBUTING.md Toolchain pins entry for typescript ${String(major)}.x`
    ).toBeDefined();
    expect(entry).toContain('typescript-eslint');
    expect(entry).toMatch(/Lift when/);
    expect(entry).toMatch(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/);
  });

  it('@types/node tracks the .node-version line and the pin is recorded by line', () => {
    const devDependencies = readJson('package.json').devDependencies as Record<string, string>;
    const typesNode = devDependencies['@types/node'] ?? '';
    const line = read('.node-version').trim().split('.')[0] ?? '';
    expect(typesNode.split('.')[0]).toBe(line);
    const pins = read('CONTRIBUTING.md').split('## Toolchain pins')[1] ?? '';
    const entry = pins
      .split('\n- ')
      .find((item) => item.startsWith(`**\`@types/node\` ${line}.x**`));
    expect(entry, `CONTRIBUTING.md Toolchain pins entry for @types/node ${line}.x`).toMatch(
      /Lift when/
    );
  });

  it('.node-version pins an exact Node version', () => {
    expect(read('.node-version').trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('strictness', () => {
  it('tsconfig.base.json carries the workspace strict set plus the two extra flags', () => {
    const options = (readJson('tsconfig.base.json').compilerOptions ?? {}) as Record<
      string,
      unknown
    >;
    for (const flag of [
      'strict',
      'noImplicitAny',
      'strictNullChecks',
      'noUnusedLocals',
      'noUnusedParameters',
      'noImplicitReturns',
      'noFallthroughCasesInSwitch',
      'noImplicitOverride',
      'noUncheckedIndexedAccess',
      'exactOptionalPropertyTypes',
      'isolatedModules',
      'forceConsistentCasingInFileNames',
    ]) {
      expect(options[flag], flag).toBe(true);
    }
  });

  it.each(packages.map((p) => p.dir.slice(ROOT.length + 1)))(
    '%s runs vitest with coverage at an 80 percent threshold',
    (dir) => {
      const config = read(`${dir}/vitest.config.ts`);
      for (const metric of ['lines', 'functions', 'branches', 'statements']) {
        expect(config, metric).toMatch(new RegExp(`${metric}: 80,`));
      }
      const scripts = (readJson(`${dir}/package.json`).scripts ?? {}) as Record<string, string>;
      expect(scripts.test).toBe('vitest run --coverage');
      // The tooling workspace has nothing to build; every other workspace does.
      const tasks = dir === 'scripts' ? ['typecheck', 'lint'] : ['typecheck', 'lint', 'build'];
      for (const task of tasks) {
        expect(scripts[task], task).toBeDefined();
      }
    }
  );

  // Coverage measures every source file: `include` is a glob, never a hand-picked file, and
  // `exclude` holds only tests, the vitest config itself, and the files listed here with a reason.
  const COVERAGE_EXCLUDE_ALLOWED: Record<string, readonly string[]> = {
    // Generated by packages/client/tools/generate-schema.ts: declarations only, no statements, and a test
    // asserts the file is the generator's current output.
    'packages/client': ['src/schema.ts'],
    // The Playwright configuration (read by the e2e runner, not by the app) and the declarations Next generates.
    'examples/next-app': ['playwright.config.ts', 'next-env.d.ts'],
    // The bin wrapper runs at import: it binds stdio, SIGINT and the browser opener into an Io and sets
    // process.exitCode from runCli, which is covered. The test-support files are the stand-in server and
    // harness the tests run against.
    'packages/cli': ['src/noblecloak.ts', 'src/**/*.test-support.ts'],
    // Thin command-line wrappers that run at import and call process.exit. The decisions they make
    // (arguments, exit codes) live in src/cli/*-main.ts and nc-conform-options.ts, which are covered.
    'packages/spec': [
      'src/cli/nc-conform.ts',
      'src/cli/nc-mock.ts',
      'src/cli/build-public.ts',
      'src/cli/conformance-mock.ts',
      'src/cli/generate-fixtures.ts',
      'src/cli/lint.ts',
    ],
  };

  it.each(packages.map((p) => p.dir.slice(ROOT.length + 1)))(
    '%s measures coverage over all of its source',
    async (dir) => {
      const module = (await import(join(ROOT, dir, 'vitest.config.ts'))) as {
        default: { test?: { coverage?: { include?: string[]; exclude?: string[] } } };
      };
      const coverage = module.default.test?.coverage ?? {};
      expect(coverage.include?.length, 'coverage.include').toBeGreaterThan(0);
      for (const glob of coverage.include ?? []) expect(glob).toMatch(/(^|\/)\*(\*\/\*)?\.tsx?$/);
      const allowed = COVERAGE_EXCLUDE_ALLOWED[dir] ?? [];
      for (const glob of coverage.exclude ?? []) {
        const isTest = /\*\.test\.tsx?$/.test(glob);
        expect(isTest || glob === 'vitest.config.ts' || allowed.includes(glob), glob).toBe(true);
      }
    }
  );

  it('the root gate runs exactly the five CI tasks, with build through the root script', () => {
    const scripts = readJson('package.json').scripts as Record<string, string>;
    expect(scripts.gate).toBe('turbo run format:check lint typecheck test && bun run build');
    expect(scripts.build).toBe('turbo run build');
  });
});

describe('eslint', () => {
  // The first lintText call loads the typed-lint program for the whole workspace: 55 s on a CI runner on main's last
  // green run, over 60 s once the export tests share the runner, so the first call has its own generous timeout.
  const FIRST_LINT_TIMEOUT = 240_000;
  const eslint = new ESLint({ cwd: ROOT });
  const lint = async (code: string): Promise<string[]> => {
    const [result] = await eslint.lintText(code, {
      filePath: join(ROOT, 'packages/spec/src/index.ts'),
    });
    return (result?.messages ?? []).map((m) => m.ruleId ?? m.message);
  };

  it(
    'rejects an explicit any',
    async () => {
      expect(await lint('export const value: any = 1;\n')).toContain(
        '@typescript-eslint/no-explicit-any'
      );
    },
    FIRST_LINT_TIMEOUT
  );

  it('rejects a relative import without a .js suffix', async () => {
    expect(await lint("export { SCHEMA_INFO } from './schema';\n")).toContain(
      'no-restricted-syntax'
    );
  }, 60_000);

  it('accepts the placeholder source as written', async () => {
    expect(await lint(read('packages/spec/src/index.ts'))).toEqual([]);
  }, 60_000);
});

describe('workflows', () => {
  it.each(workflowFiles)('%s pins every action to a full commit SHA or image digest', (file) => {
    expect(unpinnedUses(loadWorkflow(file), read(`.github/workflows/${file}`))).toEqual([]);
  });

  // Kills: a job-level `uses` on a branch ref, a quoted SHA `uses:` with the version comment removed, a
  // short SHA, a tag ref, and a digest without its version comment.
  it('the pin check rejects a tag, a short SHA, a missing comment and a reusable workflow on a branch', () => {
    const sha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
    const digest = `sha256:${'b'.repeat(64)}`;
    const check = (uses: string, line: string): string[] =>
      unpinnedUses({ jobs: { x: { name: 'x', steps: [{ uses }] } } }, line);

    expect(check(`actions/checkout@${sha}`, `- uses: actions/checkout@${sha} # v7.0.1`)).toEqual(
      []
    );
    expect(check(`actions/checkout@${sha}`, `- uses: "actions/checkout@${sha}" # v7.0.1`)).toEqual(
      []
    );
    expect(
      check(
        `docker://rhysd/actionlint@${digest}`,
        `uses: docker://rhysd/actionlint@${digest} # 1.7.12`
      )
    ).toEqual([]);

    expect(check('actions/checkout@v7', 'uses: actions/checkout@v7')).not.toEqual([]);
    expect(
      check('actions/checkout@3d3c42e', 'uses: actions/checkout@3d3c42e # v7.0.1')
    ).not.toEqual([]);
    expect(
      check('docker://rhysd/actionlint:1.7.12', 'uses: docker://rhysd/actionlint:1.7.12')
    ).not.toEqual([]);
    // A SHA with no version comment, or a major-only one, quoted or not.
    expect(check(`actions/checkout@${sha}`, `uses: actions/checkout@${sha}`)).not.toEqual([]);
    expect(check(`actions/checkout@${sha}`, `uses: "actions/checkout@${sha}"`)).not.toEqual([]);
    expect(check(`actions/checkout@${sha}`, `uses: 'actions/checkout@${sha}' # v7`)).not.toEqual(
      []
    );
    expect(
      check(`docker://rhysd/actionlint@${digest}`, `uses: docker://rhysd/actionlint@${digest}`)
    ).not.toEqual([]);
    // A job-level reusable-workflow call is an action too.
    expect(
      unpinnedUses(
        { jobs: { reuse: { name: 'reuse', uses: 'someorg/repo/.github/workflows/x.yml@main' } } },
        'uses: someorg/repo/.github/workflows/x.yml@main'
      )
    ).not.toEqual([]);
  });

  // A required status check is matched by job name alone, across every workflow, so each check
  // name must be unique or branch protection cannot tell two jobs apart.
  it('every job has an explicit name, unique across workflows once matrices expand', () => {
    const checks: string[] = [];
    for (const file of workflowFiles) {
      for (const [key, job] of Object.entries(loadWorkflow(file).jobs)) {
        expect(job.name, `${file}:${key} name`).toBeDefined();
        const name = job.name ?? key;
        const matrix = /\$\{\{ matrix\.(\w+) \}\}/.exec(name);
        if (matrix === null) {
          checks.push(name);
          continue;
        }
        const values = job.strategy?.matrix?.[matrix[1] ?? ''];
        expect(Array.isArray(values), `${file}:${key} matrix.${matrix[1] ?? ''}`).toBe(true);
        for (const value of values as unknown[]) {
          checks.push(name.replace(matrix[0], String(value)));
        }
      }
    }
    expect(checks.filter((name, index) => checks.indexOf(name) !== index)).toEqual([]);
  });

  // Any use of the secrets context outside a comment: secrets.X, secrets['X'], toJSON(secrets),
  // a bare `if: secrets.X` condition, or `secrets: inherit` on a reusable-workflow call.
  it.each(workflowFiles)('%s reads no secrets', (file) => {
    const code = read(`.github/workflows/${file}`)
      .split('\n')
      .map((line) => line.replace(/(^|\s)#.*$/, ''));
    expect(code.filter((line) => /\bsecrets\b/.test(line))).toEqual([]);
  });

  // A step that publishes a package or deploys a site, by command or by action.
  const RELEASE_RUN =
    /\b(npm|bun|pnpm|yarn)\s+(npm\s+)?publish\b|\bchangeset\s+publish\b|\brun\s+release\b|\bscripts\/release\.ts\b|\bwrangler\b|\baws\s+s3\b|\bgh-pages\b|\bnetlify\s+deploy\b|\bvercel\b|\bfirebase\s+deploy\b|\bgh\s+release\b|\bsurge\b/;
  const RELEASE_ACTION =
    /^(actions\/deploy-pages|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy-action|cloudflare\/[\w-]+|aws-actions\/[\w-]+|nwtgck\/actions-netlify|amondnet\/vercel-action|softprops\/action-gh-release)@/;
  const isReleaseStep = (step: Step): boolean =>
    RELEASE_RUN.test(step.run ?? '') ||
    RELEASE_ACTION.test(step.uses ?? '') ||
    (step.uses?.startsWith('changesets/action@') === true && step.with?.publish !== undefined);
  const isReleaseJob = (name: string, job: Job): boolean =>
    name === 'publish' ||
    name === 'deploy' ||
    grantsEverything(job.permissions) ||
    scopeLevel(job.permissions, 'id-token') === 'write' ||
    (job.steps ?? []).some(isReleaseStep);

  /**
   * True when the job publishes to GitHub Packages and nothing else: it has a release step, and every
   * release step is exactly the release script with the GitHub registry.
   */
  const publishesToGithubOnly = (job: Job | undefined): boolean => {
    const releaseSteps = (job?.steps ?? []).filter(isReleaseStep);
    return (
      releaseSteps.length > 0 &&
      releaseSteps.every((step) => step.run?.trim() === GITHUB_RELEASE_RUN)
    );
  };

  /**
   * True when the condition is the public gate, or the public gate ANDed with other terms. It is also
   * true for both private-gate terms ANDed, but only for a job that publishes to GitHub Packages and
   * nothing else, so the private gate can never admit an npm publish. Any `||`, negation or grouping
   * could weaken a gate, so a condition containing one is rejected outright.
   */
  const isGated = (condition: string | undefined, job?: Job): boolean => {
    const expression = (condition ?? '')
      .trim()
      .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
      .trim();
    if (/\|\||!(?!=)|[()]/.test(expression)) return false;
    const terms = expression.split('&&').map((term) => term.trim());
    if (terms.includes(GATE)) return true;
    return PRIVATE_GATE_TERMS.every((term) => terms.includes(term)) && publishesToGithubOnly(job);
  };

  it('isGated accepts only the gate or a conjunction containing it', () => {
    expect(isGated(GATE)).toBe(true);
    expect(isGated(`\${{ ${GATE} }}`)).toBe(true);
    expect(isGated(`github.event_name == 'push' && ${GATE}`)).toBe(true);
    expect(isGated(`github.event_name == 'push' || ${GATE}`)).toBe(false);
    expect(isGated(`!(${GATE})`)).toBe(false);
    expect(isGated(`always() && ${GATE}`)).toBe(false);
    expect(isGated(`${GATE}x`)).toBe(false);
    expect(isGated(undefined)).toBe(false);
  });

  const jobs = (): Record<string, Job> => loadWorkflow('publish.yml').jobs;
  const privateGate = PRIVATE_GATE_TERMS.join(' && ');

  // Kills: dropping the publishesToGithubOnly(job) condition, `every` becoming `some`, or removing the owner term from the publish-github-packages `if`.
  it('the private gate admits only a job that publishes to GitHub Packages', () => {
    const github = jobs()['publish-github-packages'];
    const npm = jobs().publish;
    expect(isGated(github?.if, github)).toBe(true);
    // The same gate planted on the npm job, or on any job without the GitHub registry, is refused.
    expect(isGated(privateGate, npm)).toBe(false);
    expect(isGated(privateGate)).toBe(false);
    const withNpmStep: Job = { steps: [...(github?.steps ?? []), { run: 'bun run release' }] };
    expect(isGated(privateGate, withNpmStep)).toBe(false);
    const chained: Job = { steps: [{ run: `${GITHUB_RELEASE_RUN} && npm publish x.tgz` }] };
    expect(isGated(privateGate, chained)).toBe(false);
    // Both terms are required, and the usual weakening forms stay refused.
    for (const term of PRIVATE_GATE_TERMS) {
      expect(isGated(term, github)).toBe(false);
    }
    expect(isGated(`${privateGate} || always()`, github)).toBe(false);
    expect(isGated(`!(${privateGate})`, github)).toBe(false);
    // The npm job keeps the public gate and its own release step.
    expect(isGated(npm?.if, npm)).toBe(true);
    expect(npm?.steps?.filter(isReleaseStep).map((s) => s.run)).toEqual(['bun run release']);
  });

  it.each(['publish.yml', 'preview.yml'])('%s has a publish or deploy job', (file) => {
    const jobs = Object.entries(loadWorkflow(file).jobs);
    expect(jobs.filter(([name, job]) => isReleaseJob(name, job)).length).toBeGreaterThan(0);
  });

  it.each(workflowFiles)(
    '%s runs every publish or deploy step in a job behind its gate',
    (file) => {
      for (const [name, job] of Object.entries(loadWorkflow(file).jobs)) {
        if (isReleaseJob(name, job)) expect(isGated(job.if, job), `${file}:${name} if`).toBe(true);
      }
    }
  );

  // Kills: adding `id-token: write` to the publish-github-packages job.
  it('grants write permissions only to the version job, id-token to publish and packages to publish-github-packages', () => {
    const allWorkflows = Object.fromEntries(workflowFiles.map((f) => [f, loadWorkflow(f)]));
    expect(writers(allWorkflows)).toEqual([
      'publish.yml:publish-github-packages:packages',
      'publish.yml:publish:id-token',
      'publish.yml:version:contents',
      'publish.yml:version:pull-requests',
    ]);
    const releases = read('CONTRIBUTING.md').split('## Releases')[1]?.split('\n## ')[0] ?? '';
    const prose = releases.replace(/\s+/g, ' ');
    expect(prose).toContain('only job in any workflow with `contents` or `pull-requests` write');
    expect(prose).toContain('The `publish` job alone holds `id-token: write`');
    expect(prose).toContain('The `publish-github-packages` job alone holds `packages: write`');
  });

  // Kills: dropping `persist-credentials: false` from the checkout of the version job (or of any job that
  // holds a write scope, `write-all` included), which would leave github.token in .git/config for later steps.
  it('checks out without persisting credentials in every job that holds a write permission', () => {
    const all = Object.fromEntries(workflowFiles.map((f) => [f, loadWorkflow(f)]));
    expect(persistingCheckouts(all)).toEqual([]);
    // The rule reaches the three writers: it is not vacuous on this tree.
    expect(
      Object.entries(all).flatMap(([file, workflow]) =>
        Object.entries(workflow.jobs)
          .filter(([, job]) => holdsWrite(job.permissions ?? workflow.permissions))
          .map(([name]) => `${file}:${name}`)
          .sort()
      )
    ).toEqual(
      ['publish.yml:publish-github-packages', 'publish.yml:publish', 'publish.yml:version'].sort()
    );

    const publish = (): Workflow => structuredClone(all['publish.yml'] ?? { jobs: {} });
    const persist = (workflow: Workflow, key: string): Workflow => {
      const job = workflow.jobs[key];
      if (job === undefined) throw new Error(`${key} job missing`);
      job.steps = (job.steps ?? []).map((step) =>
        step.uses?.startsWith('actions/checkout@') === true ? { uses: step.uses } : step
      );
      return workflow;
    };
    expect(persistingCheckouts({ 'publish.yml': persist(publish(), 'version') })).toEqual([
      'publish.yml:version',
    ]);

    // A `write-all` job holds write without naming a scope, and a workflow-level write reaches jobs with no block.
    const writeAll = publish();
    const pack = writeAll.jobs.pack;
    if (pack === undefined) throw new Error('pack job missing');
    pack.permissions = 'write-all';
    expect(persistingCheckouts({ 'publish.yml': persist(writeAll, 'pack') })).toEqual([
      'publish.yml:pack',
    ]);
    const inherited = publish();
    inherited.permissions = { contents: 'write' };
    expect(persistingCheckouts({ 'publish.yml': persist(inherited, 'pack') })).toContain(
      'publish.yml:pack'
    );
  });

  it.each(workflowFiles)(
    '%s has top-level contents: read and only map-shaped job permissions',
    (file) => {
      expect(permissionShapeViolations(loadWorkflow(file))).toEqual([]);
    }
  );

  // Kills: `permissions: write-all` on ci.yml's gate job, `permissions: write-all` at workflow level,
  // deleting a workflow's top-level permissions block, and an empty job-level `permissions:`.
  it('the permission checks reject write-all and a missing top-level block', () => {
    const ci = (): Workflow => structuredClone(loadWorkflow('ci.yml'));

    const noTop = ci();
    delete noTop.permissions;
    expect(permissionShapeViolations(noTop)).toEqual(['(workflow)']);

    const topWriteAll = ci();
    topWriteAll.permissions = 'write-all';
    expect(permissionShapeViolations(topWriteAll)).toEqual(['(workflow)']);
    expect(writers({ 'ci.yml': topWriteAll })).toEqual(['ci.yml:(workflow):*']);

    const jobWriteAll = ci();
    const gate = jobWriteAll.jobs.gate;
    if (gate === undefined) throw new Error('gate job missing');
    gate.permissions = 'write-all';
    expect(permissionShapeViolations(jobWriteAll)).toEqual(['gate']);
    expect(writers({ 'ci.yml': jobWriteAll })).toEqual(['ci.yml:gate:*']);
    // A write-all job is a release job, so it must carry a gate it does not have.
    expect(isReleaseJob('gate', gate)).toBe(true);
    expect(isGated(gate.if, gate)).toBe(false);

    const emptyBlock = ci();
    const skill = emptyBlock.jobs.skill;
    if (skill === undefined) throw new Error('skill job missing');
    (skill as { permissions?: unknown }).permissions = null;
    expect(permissionShapeViolations(emptyBlock)).toEqual(['skill']);

    // `read-all` grants no write and is not a release job.
    expect(writers({ 'ci.yml': { ...ci(), permissions: 'read-all' } })).toEqual([]);
    expect(isReleaseJob('gate', { permissions: 'read-all' })).toBe(false);
    // Any other string is write-everything.
    expect(grantsEverything('anything-else')).toBe(true);
  });

  // A job that can mint an OIDC token can publish to npm. Nothing from the lockfile may run there.
  it('the id-token job installs and builds nothing and publishes the pack artifact', () => {
    const INSTALL_OR_BUILD =
      /\b(bun|npm|pnpm|yarn)\s+(install|i|ci|add)\b|\bbun\s+x\b|\bbunx\b|\bnpx\b|\bturbo\b|\brun\s+(build|pack:all)\b/;
    const minters = workflowFiles.flatMap((file) =>
      Object.entries(loadWorkflow(file).jobs)
        .filter(([, job]) => scopeLevel(job.permissions, 'id-token') === 'write')
        .map(([name, job]) => [`${file}:${name}`, job] as const)
    );
    expect(minters.map(([id]) => id)).toEqual(['publish.yml:publish']);
    for (const [id, job] of minters) {
      for (const step of job.steps ?? []) expect(step.run ?? '', id).not.toMatch(INSTALL_OR_BUILD);
      expect(job.needs, id).toEqual('pack');
      const download = job.steps?.find((s) => s.uses?.startsWith('actions/download-artifact@'));
      expect(download?.with, id).toEqual({ name: 'npm-packages', path: 'artifacts' });
    }
    const scripts = readJson('package.json').scripts as Record<string, string>;
    expect(scripts.release).toBe('bun --no-install scripts/release.ts');
    const pack = loadWorkflow('publish.yml').jobs.pack;
    const upload = pack?.steps?.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.name).toBe('npm-packages');
    expect(pack?.permissions).toBeUndefined();
  });

  // The job that holds `packages: write` can publish to the organisation's registry. Like the id-token
  // job, nothing from the lockfile may run there, and it reads no secret: only the job's own token.
  it('the packages job installs and builds nothing, publishes the pack artifact and reads github.token', () => {
    const INSTALL_OR_BUILD =
      /\b(bun|npm|pnpm|yarn)\s+(install|i|ci|add)\b|\bbun\s+x\b|\bbunx\b|\bnpx\b|\bturbo\b|\brun\s+(build|pack:all)\b/;
    const holders = workflowFiles.flatMap((file) =>
      Object.entries(loadWorkflow(file).jobs)
        .filter(([, job]) => scopeLevel(job.permissions, 'packages') === 'write')
        .map(([name, job]) => [`${file}:${name}`, job] as const)
    );
    expect(holders.map(([id]) => id)).toEqual(['publish.yml:publish-github-packages']);
    const job = holders[0]?.[1];
    expect(job?.name).toBe('publish github-packages');
    expect(job?.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(job?.needs).toBe('pack');
    expect(job?.environment).toBeUndefined();
    for (const step of job?.steps ?? []) expect(step.run ?? '').not.toMatch(INSTALL_OR_BUILD);
    const download = job?.steps?.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(download?.with).toEqual({ name: 'npm-packages', path: 'artifacts' });
    const node = job?.steps?.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(node?.with?.['registry-url']).toBe('https://npm.pkg.github.com');
    expect(node?.with?.scope).toBe('@noblecloak');
    const release = job?.steps?.filter(isReleaseStep) ?? [];
    expect(release.map((s) => s.run)).toEqual([GITHUB_RELEASE_RUN]);
    expect(release[0]?.env).toEqual({ NODE_AUTH_TOKEN: '${{ github.token }}' });
    // The npm job passes no registry, so release.ts keeps its npm behaviour there.
    expect(
      loadWorkflow('publish.yml').jobs.publish?.steps?.some((s) =>
        (s.run ?? '').includes('--registry')
      )
    ).toBe(false);
  });

  // The registry ban is about what a consumer installs from, not about the workflow that publishes.
  it('limits the GitHub Packages registry ban to install configuration', () => {
    const rules = read('CONTRIBUTING.md').split('## Rules the tree enforces')[1] ?? '';
    const rule = (rules.split('\n- ')[1] ?? '').replace(/\s+/g, ' ');
    expect(rule).toContain(
      'no reference to `npm.pkg.github.com` in install configuration (`.npmrc`, `bunfig.toml`, `bun.lock`, `publishConfig`)'
    );
    expect(rule).toContain(
      '`publish.yml` and `scripts/release.ts` name the registry only to publish to it'
    );
    // The workflow does name it; 'the tree passes the private-dependency guard' covers the install side.
    expect(read('.github/workflows/publish.yml')).toContain('https://npm.pkg.github.com');
  });

  // A v* tag push runs publish.yml as it exists at the tagged commit, so the workflow file cannot
  // guard itself. npm's trusted publisher is bound to the npm-publish environment (reviewer
  // required, main and v* only) and a tag ruleset limits who can push v* tags.
  it('the publish job runs in the npm-publish environment the flip configures', () => {
    const publish = loadWorkflow('publish.yml').jobs.publish;
    expect(publish?.environment).toBe('npm-publish');
    const environment = JSON.parse(read('.github/settings/npm-publish-environment.json')) as {
      reviewers?: unknown[];
      deployment_branch_policy?: { custom_branch_policies?: boolean };
    };
    expect(environment.reviewers?.length).toBeGreaterThan(0);
    expect(environment.deployment_branch_policy?.custom_branch_policies).toBe(true);
    const ruleset = JSON.parse(read('.github/settings/release-tags-ruleset.json')) as {
      target?: string;
      enforcement?: string;
      conditions?: { ref_name?: { include?: string[] } };
      rules?: { type: string }[];
    };
    expect(ruleset.target).toBe('tag');
    expect(ruleset.enforcement).toBe('active');
    expect(ruleset.conditions?.ref_name?.include).toEqual(['refs/tags/v*']);
    expect(ruleset.rules?.map((r) => r.type).sort()).toEqual(['creation', 'deletion', 'update']);
  });

  it('documents how the token-opened version pull request gets its checks', () => {
    const version = loadWorkflow('publish.yml').jobs.version;
    const action = version?.steps?.find((s) => s.uses?.startsWith('changesets/action@'));
    expect(action).toBeDefined();
    const releases = read('CONTRIBUTING.md').split('## Releases')[1]?.split('\n## ')[0] ?? '';
    // Only a pull request opened with github.token needs the manual reopen.
    if (action?.env?.GITHUB_TOKEN === '${{ github.token }}') {
      expect(releases).toContain('gh pr close <n> && gh pr reopen <n>');
    }
  });

  it('stranger-install runs with read-only permissions and every token emptied', () => {
    const code = read('.github/workflows/stranger-install.yml')
      .split('\n')
      .map((line) => line.replace(/(^|\s)#.*$/, ''));
    expect(code.filter((line) => /github\.token|\bsecrets\b/.test(line))).toEqual([]);
    const workflow = loadWorkflow('stranger-install.yml');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const job = workflow.jobs['stranger-install'];
    expect(job?.permissions).toBeUndefined();
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) {
      expect(job?.env?.[name], name).toBe('');
    }
    const steps = job?.steps ?? [];
    // No job- or step-level env or `with` input may put a credential back.
    const credentialInputs = [
      ...Object.entries(job?.env ?? {}),
      ...steps.flatMap((step) => [
        ...Object.entries(step.env ?? {}),
        ...Object.entries(step.with ?? {}).filter(([key]) => /token|auth|password/i.test(key)),
      ]),
    ].filter(
      ([key]) => /token|auth|password|credential/i.test(key) && key !== 'persist-credentials'
    );
    expect(credentialInputs.length).toBeGreaterThanOrEqual(4);
    for (const [key, value] of credentialInputs) expect(value, key).toBe('');
    expect(steps[0]?.uses).toMatch(/^actions\/checkout@/);
    expect(steps[0]?.with?.['persist-credentials']).toBe(false);
    const assertion = steps.find((s) => s.name === 'Assert no credentials are available');
    expect(assertion?.run).toContain('npm whoami');
    expect(assertion?.run).toContain('gh auth status');
    const runs = steps.map((s) => s.run ?? '');
    expect(runs).toEqual(
      expect.arrayContaining(['bun install --frozen-lockfile', 'bun run build', 'bun run test'])
    );
    expect(runs.indexOf(assertion?.run ?? '')).toBeLessThan(
      runs.indexOf('bun install --frozen-lockfile')
    );
  });

  it('ci runs the five gate tasks, the guard and actionlint', () => {
    const jobs = loadWorkflow('ci.yml').jobs as Record<
      string,
      Job & { strategy?: { matrix?: { task?: string[] } } }
    >;
    expect(jobs.gate?.strategy?.matrix?.task).toEqual([
      'format:check',
      'lint',
      'typecheck',
      'test',
      'build',
    ]);
    expect(jobs.guard?.steps?.some((s) => s.run === 'bun run guard')).toBe(true);
    expect(
      jobs.actionlint?.steps?.some((s) => s.uses?.startsWith('docker://rhysd/actionlint'))
    ).toBe(true);
  });
});

describe('dependabot', () => {
  const config = parse(read('.github/dependabot.yml')) as {
    updates: Record<string, unknown>[];
  };

  it('toolchain-currency checks the pins Dependabot does not move, weekly', () => {
    const workflow = parse(read('.github/workflows/toolchain-currency.yml')) as Workflow & {
      on: { schedule?: { cron: string }[] };
    };
    expect(workflow.on.schedule?.length).toBe(1);
    const steps = workflow.jobs.check?.steps ?? [];
    const check = steps.find((s) => s.run === 'bun run check:toolchain');
    expect(check?.env?.GITHUB_TOKEN).toBe('${{ github.token }}');
    const scripts = readJson('package.json').scripts as Record<string, string>;
    expect(scripts['check:toolchain']).toBe('bun scripts/check-toolchain.ts');
  });

  it('covers github-actions and bun, grouped as the workspace groups them, with no allowlist', () => {
    expect(config.updates.map((u) => u['package-ecosystem'])).toEqual(['github-actions', 'bun']);
    for (const update of config.updates) {
      expect(update.allow).toBeUndefined();
      expect(update.directory).toBe('/');
      expect(update.schedule).toEqual({ interval: 'weekly' });
    }
    const [actions, bun] = config.updates;
    expect(actions?.['commit-message']).toEqual({ prefix: 'ci' });
    expect(actions?.groups).toEqual({ actions: { patterns: ['*'] } });
    expect(bun?.['commit-message']).toEqual({ prefix: 'chore' });
    expect(bun?.['versioning-strategy']).toBe('increase');
    expect(bun?.groups).toEqual({
      'minor-and-patch': { 'update-types': ['minor', 'patch'] },
      major: { 'update-types': ['major'] },
    });
  });

  // An ignore is the one place a stale dependency can hide, so each one is allowed only for the
  // majors of a dependency whose pin CONTRIBUTING.md records with its lift condition.
  it('ignores only the majors of a recorded toolchain pin', () => {
    const pins = read('CONTRIBUTING.md').split('## Toolchain pins')[1] ?? '';
    const ignores = config.updates.flatMap((u) => (u.ignore ?? []) as Record<string, unknown>[]);
    expect(ignores.map((i) => i['dependency-name'])).toEqual(['typescript', '@types/node']);
    for (const entry of ignores) {
      const name = String(entry['dependency-name']);
      // The whole entry: a `versions:` key beside it would hide every update, not just majors.
      expect(entry).toEqual({
        'dependency-name': name,
        'update-types': ['version-update:semver-major'],
      });
      const pin = pins.split('\n- ').find((item) => item.startsWith(`**\`${name}\` `));
      expect(pin, `CONTRIBUTING.md Toolchain pins entry for ${name}`).toMatch(/Lift when/);
    }
  });
});
