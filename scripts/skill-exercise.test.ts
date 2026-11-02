import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLASSIFIED_DIR,
  COMPARED_FILES,
  EXCLUDED_FILES,
  classificationGaps,
  SKILLS,
  SKILL_RUN_GREP_INVERT,
  compareTrees,
  coverageGaps,
  normalize,
  resolveAliases,
  skillOf,
  wallTimeReport,
} from './skill-compare.js';
import {
  CREATE_NEXT_APP_VERSION,
  e2eStages,
  exercise,
  oidcBuildEnv,
  run,
  settleReport,
  skippedSteps,
  tarballPackages,
} from './skill-exercise.js';

const ROOT = resolve(import.meta.dirname, '..');
const APPLY = join(ROOT, 'packages/skills/approvals/scripts/apply.mjs');
const TEMPLATES = join(ROOT, 'packages/skills/approvals/templates');
const EXAMPLE_APP = join(ROOT, 'examples/next-app/app');

describe('CREATE_NEXT_APP_VERSION', () => {
  it('is the Next.js the example pins, so the scaffold builds what the example is tested with', () => {
    const example = JSON.parse(
      readFileSync(join(ROOT, 'examples/next-app/package.json'), 'utf8')
    ) as { dependencies: Record<string, string> };
    expect(CREATE_NEXT_APP_VERSION).toBe(example.dependencies.next);
  });
});

describe('resolveAliases', () => {
  it('makes an alias import relative to the importing file', () => {
    expect(resolveAliases("import { a } from '@app/approvals/auth';", 'approvals')).toBe(
      "import { a } from './auth';"
    );
    expect(resolveAliases("import { a } from '@app/approvals/auth';", 'approvals/callback')).toBe(
      "import { a } from '../auth';"
    );
  });

  it('leaves other specifiers alone', () => {
    const text = "import x from '@noblecloak/react/auth'; import y from './z';";
    expect(resolveAliases(text, 'approvals')).toBe(text);
  });
});

describe('normalize', () => {
  const same = async (a: string, b: string, file = 'x.ts') =>
    (await normalize(a, file)) === (await normalize(b, file));

  it('ignores formatting and the order of binding imports', async () => {
    const a =
      "import b from 'b';\nimport type { T } from 't';\n\nimport a from 'a';\n\n\n  const x   =  1;\n";
    const b = "import a from 'a';\nimport b from 'b';\nimport type { T } from 't';\nconst x = 1;\n";
    expect(await same(a, b)).toBe(true);
    const multi = "import {\n  b,\n  a,\n} from 'm';\nimport z from 'z';\n";
    expect(await same(multi, "import z from 'z';\nimport { b, a } from 'm';\n")).toBe(true);
  });

  it('does not ignore a changed statement or a moved non-import line', async () => {
    expect(await same('const x = 1;\n', 'const x = 2;\n')).toBe(false);
    expect(
      await same("const x = 1;\nimport a from 'a';\n", "import a from 'a';\nconst x = 1;\n")
    ).toBe(false);
  });

  it('keeps the order of side-effect imports: swapped stylesheets differ', async () => {
    expect(
      await same("import './a.css';\nimport './b.css';\n", "import './b.css';\nimport './a.css';\n")
    ).toBe(false);
    // A binding import may move around them; the side-effect imports keep their places.
    expect(
      await same(
        "import './a.css';\nimport z from 'z';\nimport y from 'y';\nimport './b.css';\n",
        "import './a.css';\nimport y from 'y';\nimport z from 'z';\nimport './b.css';\n"
      )
    ).toBe(true);
  });

  it('does not collapse a blank line in a template literal', async () => {
    expect(await same('const s = `a\n\nb`;\n', 'const s = `a\nb`;\n')).toBe(false);
  });

  it('does not collapse whitespace in a string literal', async () => {
    expect(await same("const s = 'a  b';\n", "const s = 'a b';\n")).toBe(false);
  });

  it('parses TSX by the file name', async () => {
    expect(await same('const a = <p   >x</p>;\n', 'const a = <p>x</p>;\n', 'x.tsx')).toBe(true);
  });
});

describe('the skill and the example', () => {
  it('the templates are the example files, up to aliases and formatting', async () => {
    expect(await compareTrees(EXAMPLE_APP, TEMPLATES)).toEqual([]);
  });

  it('compares every file the skill ships, and ships every file it compares', () => {
    const listed = spawnSync('find', [TEMPLATES, '-type', 'f'], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(TEMPLATES.length + 1))
      .sort();
    expect(coverageGaps(listed)).toEqual({ uncompared: [], untemplated: [] });
  });

  it('names a template nobody compares and a comparison with no template', () => {
    expect(coverageGaps(['approvals/new.tsx', ...COMPARED_FILES.slice(1)])).toEqual({
      uncompared: ['approvals/new.tsx'],
      untemplated: [COMPARED_FILES[0]],
    });
  });

  it('puts every example file under app/approvals in COMPARED_FILES or EXCLUDED_FILES, once', () => {
    const listed = spawnSync('find', [join(EXAMPLE_APP, CLASSIFIED_DIR), '-type', 'f'], {
      encoding: 'utf8',
    })
      .stdout.split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(EXAMPLE_APP.length + 1))
      .sort();
    expect(listed.length).toBe(COMPARED_FILES.length + EXCLUDED_FILES.length);
    expect(classificationGaps(listed)).toEqual({ unclassified: [], both: [], stale: [] });
  });

  it('names a new example file, a file on both lists and a listed file that is gone', () => {
    const example = [...COMPARED_FILES, ...EXCLUDED_FILES.slice(1), 'approvals/New.tsx'];
    expect(
      classificationGaps(example, COMPARED_FILES, [...EXCLUDED_FILES, COMPARED_FILES[0] ?? ''])
    ).toEqual({
      unclassified: ['approvals/New.tsx'],
      both: [COMPARED_FILES[0]],
      stale: [EXCLUDED_FILES[0]],
    });
  });

  describe('against a generated tree', () => {
    let generated: string;
    beforeEach(() => {
      generated = mkdtempSync(join(tmpdir(), 'generated-'));
      for (const file of COMPARED_FILES) {
        mkdirSync(join(generated, file, '..'), { recursive: true });
        writeFileSync(join(generated, file), readFileSync(join(TEMPLATES, file)));
      }
    });
    afterEach(() => {
      rmSync(generated, { recursive: true, force: true });
    });

    it('reports a changed file and a missing one', async () => {
      writeFileSync(join(generated, 'approvals/config.ts'), 'export {};\n');
      rmSync(join(generated, 'approvals/layout.tsx'));
      expect(await compareTrees(EXAMPLE_APP, generated)).toEqual([
        { file: 'approvals/layout.tsx', reason: 'missing' },
        { file: 'approvals/config.ts', reason: 'differs' },
      ]);
    });

    it('accepts reformatting', async () => {
      const path = join(generated, 'approvals/ConfigProblem.tsx');
      writeFileSync(path, `\n\n${readFileSync(path, 'utf8').replace(/^ {2}/gm, '      ')}`);
      expect(await compareTrees(EXAMPLE_APP, generated)).toEqual([]);
    });
  });
});

describe("the skill's end-to-end run", () => {
  const SPEC = join(ROOT, 'examples/next-app/e2e/approvals.spec.ts');
  /** The spec's top-level tests and groups: the first line (the title) and the body of each. */
  const blocks = (): { title: string; body: string }[] =>
    readFileSync(SPEC, 'utf8')
      .split(/\n(?=test(?:\.describe)?\()/)
      .slice(1)
      .map((body) => ({ title: body.split('\n')[0] ?? '', body }));
  const excluded = new RegExp(SKILL_RUN_GREP_INVERT);

  it('leaves out the @csp and @callback-headers tests and keeps the flow tests', () => {
    const all = blocks();
    expect(all.length).toBeGreaterThan(3);
    for (const { title } of all)
      expect(excluded.test(title), title).toBe(/@csp|@callback-headers/.test(title));
    expect(all.some(({ title }) => !excluded.test(title))).toBe(true);
  });

  it('asserts the callback headers (A8) only in a test tagged @callback-headers, not inside a @csp one', () => {
    const withHeaders = blocks().filter(({ body }) => body.includes("['cache-control']"));
    expect(withHeaders.map(({ title }) => title.includes('@callback-headers'))).toEqual([true]);
    expect(withHeaders[0]?.body).toContain("['referrer-policy']");
  });
});

describe("the skill's end-to-end stages", () => {
  const appDir = '/tmp/scaffold/app';
  const EXAMPLE = join(ROOT, 'examples/next-app');
  const stages = e2eStages({ root: ROOT, appDir, env: {} });
  const [mock, oidc] = stages;

  /** What the example's Playwright config makes of a stage's environment (it is loaded, not reread). */
  const configFor = (env: Readonly<Record<string, string>>) => {
    const script =
      "const c = (await import('./playwright.config.ts')).default; console.log(JSON.stringify({ testMatch: c.testMatch, ...c.webServer }));";
    const result = spawnSync('bun', ['-e', script], {
      cwd: EXAMPLE,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
      testMatch: string;
      command: string;
      url: string;
      cwd?: string;
      env: Record<string, string>;
    };
  };

  it('runs mock mode, then sign-in mode, each a build and then a spec', () => {
    expect(stages).toHaveLength(2);
    expect(mock?.build.env.NEXT_PUBLIC_NC_MODE).toBe('mock');
    expect(oidc?.build.env.NEXT_PUBLIC_NC_MODE).toBe('oidc');
    expect(oidc?.e2e.env.NC_E2E_MODE).toBe('oidc');
    expect(mock?.e2e.env).not.toHaveProperty('NC_E2E_MODE');
  });

  it('runs Playwright from the example with the same tag filter in both modes', () => {
    for (const stage of [mock, oidc]) {
      expect(stage?.e2e.cwd).toBe(EXAMPLE);
      expect(stage?.e2e.args).toEqual([
        'run',
        'playwright',
        'test',
        '--grep-invert',
        SKILL_RUN_GREP_INVERT,
      ]);
    }
  });

  it('gives each mode its own app port, from the environment or 3100 and 3101', () => {
    expect(mock?.e2e.env.NC_E2E_APP_PORT).toBe('3100');
    expect(oidc?.e2e.env.NC_E2E_APP_PORT).toBe('3101');
    const [m, o] = e2eStages({
      root: ROOT,
      appDir,
      env: { NC_E2E_APP_PORT: '4000', NC_E2E_OIDC_APP_PORT: '4001', NC_MOCK_PORT: '4002' },
    });
    expect(m?.e2e.env).toMatchObject({ NC_E2E_APP_PORT: '4000', NC_MOCK_PORT: '4002' });
    expect(m?.build.env.NEXT_PUBLIC_NC_API_URL).toBe('http://127.0.0.1:4002');
    expect(o?.e2e.env.NC_E2E_APP_PORT).toBe('4001');
    // The redirect URI is inlined by the build: it names the port the sign-in spec's server listens on.
    expect(o?.build.env.NEXT_PUBLIC_NC_REDIRECT_URI).toBe(
      'http://localhost:4001/approvals/callback'
    );
  });

  // Three `bun -e` processes, each loading the example's Playwright config and `@playwright/test`: warm,
  // under half a second; on a cold CI runner next to other packages' tests, 6.5 s, past vitest's 5 s
  // default (noblecloak-ui#48 stranger-install run 39307370845).
  it(
    "the example's config runs the scaffold's build on each stage's port, with the stage's spec",
    { timeout: 30_000 },
    () => {
      const m = configFor(mock?.e2e.env ?? {});
      expect(m.testMatch).toBe('approvals.spec.ts');
      expect(m.url).toBe('http://localhost:3100/approvals');
      expect(m.cwd).toBe(appDir);
      expect(m.command).toBe(`${appDir}/node_modules/.bin/next start -p 3100`);
      expect(m.env).toEqual(mock?.build.env);

      const o = configFor(oidc?.e2e.env ?? {});
      expect(o.testMatch).toBe('signin.spec.ts');
      expect(o.url).toBe('http://localhost:3101/approvals');
      expect(o.cwd).toBe(appDir);
      expect(o.command).toBe(`${appDir}/node_modules/.bin/next start -p 3101`);
      // The sign-in build has the environment the example's own sign-in build gets: the same sign-in service,
      // API and client the spec answers for, and the redirect back to this app.
      expect(o.env).toEqual(oidc?.build.env);
      expect(oidcBuildEnv('http://localhost:3000')).toEqual(configFor({ NC_E2E_MODE: 'oidc' }).env);
    }
  );

  it('--skip-e2e leaves out the spec of both modes and names them', () => {
    expect(skippedSteps(stages, false)).toEqual([]);
    expect(skippedSteps(stages, true)).toEqual([mock?.e2e.name, oidc?.e2e.name]);
    expect(wallTimeReport([], skippedSteps(stages, true)).complete).toBe(false);
  });

  it('the sign-in spec has no test the tag filter leaves out, and asserts no headers', () => {
    const spec = readFileSync(join(EXAMPLE, 'e2e/signin.spec.ts'), 'utf8');
    const titles = [...spec.matchAll(/^\s*test(?:\.describe)?\(\s*'([^']*)'/gm)].map(
      (m) => m[1] ?? ''
    );
    expect(titles.length).toBeGreaterThanOrEqual(3);
    for (const title of titles)
      expect(new RegExp(SKILL_RUN_GREP_INVERT).test(title), title).toBe(false);
    // A header assertion needs what only the example ships (`next.config.ts`, `proxy.ts`): it would belong
    // in a tagged test, as in the approvals spec.
    expect(spec).not.toMatch(
      /headers\(\)\)\[|cache-control|referrer-policy|content-security-policy/i
    );
  });
});

describe('wallTimeReport', () => {
  it('marks a run that skipped a step as not complete', () => {
    const steps = [{ name: 'a', ms: 1 }];
    expect(wallTimeReport(steps)).toMatchObject({ complete: true, skipped: [] });
    expect(wallTimeReport(steps, ['e2e'])).toMatchObject({ complete: false, skipped: ['e2e'] });
  });

  it('marks a run in which a step threw as not complete, and names the step', () => {
    const steps = [
      { name: 'a', ms: 1 },
      { name: 'b', ms: 2 },
    ];
    expect(wallTimeReport(steps, [], 'b')).toMatchObject({
      complete: false,
      failedStep: 'b',
      totalMs: 3,
    });
    expect(wallTimeReport(steps, ['e2e'], 'b')).toMatchObject({ complete: false, failedStep: 'b' });
    expect(wallTimeReport(steps)).not.toHaveProperty('failedStep');
  });

  it('the exercise writes the report when a step fails, then fails itself', async () => {
    // An empty root has no `build` script: the first step fails at once, before any network use.
    const root = mkdtempSync(join(tmpdir(), 'exercise-root-'));
    try {
      await expect(exercise(root, { keep: false, skipE2e: false })).rejects.toThrow(
        /failed \(exit/
      );
      const report = JSON.parse(
        readFileSync(join(root, 'artifacts/skill-exercise-wall-time.json'), 'utf8')
      ) as Record<string, unknown>;
      expect(report).toMatchObject({
        complete: false,
        failedStep: 'build the workspace and pack the packages',
        skipped: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sums the steps', () => {
    expect(
      wallTimeReport([
        { name: 'a', ms: 1500 },
        { name: 'b', ms: 500 },
      ]).totalMs
    ).toBe(2000);
  });
});

describe('apply.mjs', () => {
  let project: string;
  const apply = (...args: string[]) => {
    return spawnSync('node', [APPLY, '--project', project, ...args], { encoding: 'utf8' });
  };
  const manifest = (extra: Record<string, unknown> = {}): void => {
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { next: '16.4.0' }, ...extra })
    );
  };

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'apply-'));
    manifest();
    mkdirSync(join(project, 'app'));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('writes the route, the provider, the token getter, the callback and the stylesheet import', () => {
    const result = apply('--skip-install');
    expect(result.status).toBe(0);
    for (const file of COMPARED_FILES) expect(existsSync(join(project, 'app', file))).toBe(true);
    expect(readFileSync(join(project, 'app/approvals/layout.tsx'), 'utf8')).toContain(
      "import '@noblecloak/react/styles.css';"
    );
    expect(readFileSync(join(project, '.env.example'), 'utf8')).toContain(
      'NEXT_PUBLIC_NC_API_URL='
    );
    expect(result.stdout).toContain('would run npm install @noblecloak/react');
  });

  it('is idempotent and keeps what the env file already has', () => {
    writeFileSync(join(project, '.env.example'), 'NEXT_PUBLIC_NC_API_URL=https://mine.test\n');
    expect(apply('--skip-install').status).toBe(0);
    const once = readFileSync(join(project, '.env.example'), 'utf8');
    expect(once).toContain('NEXT_PUBLIC_NC_API_URL=https://mine.test');
    expect(once.match(/NEXT_PUBLIC_NC_API_URL=/g)).toHaveLength(1);
    const again = apply('--skip-install');
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('unchanged app/approvals/page.tsx');
    expect(readFileSync(join(project, '.env.example'), 'utf8')).toBe(once);
  });

  it('refuses to overwrite a different file, and writes nothing, unless forced', () => {
    mkdirSync(join(project, 'app/approvals'));
    writeFileSync(join(project, 'app/approvals/page.tsx'), 'mine\n');
    const refused = apply('--skip-install');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('app/approvals/page.tsx');
    expect(existsSync(join(project, 'app/approvals/config.ts'))).toBe(false);
    expect(readFileSync(join(project, 'app/approvals/page.tsx'), 'utf8')).toBe('mine\n');
    expect(apply('--skip-install', '--force').status).toBe(0);
    expect(readFileSync(join(project, 'app/approvals/page.tsx'), 'utf8')).not.toBe('mine\n');
  });

  it('un-ignores .env.example under a .env* rule, once, and says so on a dry run', () => {
    writeFileSync(join(project, '.gitignore'), '# env files\n.env*\n/node_modules');
    const dry = apply('--dry-run');
    expect(dry.stdout).toContain('add !.env.example to .gitignore');
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe(
      '# env files\n.env*\n/node_modules'
    );
    expect(apply('--skip-install').status).toBe(0);
    const once = readFileSync(join(project, '.gitignore'), 'utf8');
    expect(once).toBe('# env files\n.env*\n/node_modules\n!.env.example\n');
    const again = apply('--skip-install');
    expect(again.stdout).not.toContain('.gitignore');
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe(once);
  });

  it('leaves a .gitignore alone that has no .env* rule, or negates it after the rule', () => {
    writeFileSync(join(project, '.gitignore'), '.env.local\n');
    expect(apply('--skip-install').stdout).not.toContain('.gitignore');
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('.env.local\n');
    writeFileSync(join(project, '.gitignore'), '.env*\n!/.env.example\n');
    expect(apply('--skip-install').stdout).not.toContain('.gitignore');
    // A negation before the rule does not undo it.
    writeFileSync(join(project, '.gitignore'), '!.env.example\n.env*\n');
    expect(apply('--dry-run').stdout).toContain('add !.env.example to .gitignore');
  });

  it('writes nothing on a dry run', () => {
    const result = apply('--dry-run');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('create app/approvals/page.tsx');
    expect(existsSync(join(project, 'app/approvals'))).toBe(false);
    expect(existsSync(join(project, '.env.example'))).toBe(false);
  });

  it('uses src/app when the project has one, and the lockfile picks the package manager', () => {
    rmSync(join(project, 'app'), { recursive: true });
    mkdirSync(join(project, 'src/app'), { recursive: true });
    writeFileSync(join(project, 'bun.lock'), '');
    const result = apply('--skip-install');
    expect(result.status).toBe(0);
    expect(existsSync(join(project, 'src/app/approvals/page.tsx'))).toBe(true);
    expect(result.stdout).toContain('would run bun add @noblecloak/react');
  });

  it('finds the lockfile of the workspace a member project sits in', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'workspace-'));
    try {
      writeFileSync(join(workspace, 'pnpm-lock.yaml'), '');
      const member = join(workspace, 'apps/web');
      mkdirSync(join(member, 'app'), { recursive: true });
      writeFileSync(
        join(member, 'package.json'),
        JSON.stringify({ name: 'web', dependencies: { next: '16.4.0' } })
      );
      const result = spawnSync('node', [APPLY, '--project', member, '--dry-run'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('would run pnpm add @noblecloak/react');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("takes the manifest's packageManager field over a lockfile", () => {
    manifest({ dependencies: { next: '16.4.0' }, packageManager: 'yarn@4.5.0' });
    writeFileSync(join(project, 'package-lock.json'), '{}');
    expect(apply('--dry-run').stdout).toContain('would run yarn add @noblecloak/react');
    manifest({ dependencies: { next: '16.4.0' }, packageManager: 'nonsense' });
    expect(apply('--dry-run').stdout).toContain('would run npm install @noblecloak/react');
  });

  it('prefers the root app/ over src/app when both exist (Next.js ignores src/app then)', () => {
    mkdirSync(join(project, 'src/app'), { recursive: true });
    const result = apply('--skip-install');
    expect(result.status).toBe(0);
    expect(existsSync(join(project, 'app/approvals/page.tsx'))).toBe(true);
    expect(existsSync(join(project, 'src/app/approvals'))).toBe(false);
  });

  it('says why the install failed, and what was already written', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-path-'));
    try {
      const result = spawnSync(process.execPath, [APPLY, '--project', project], {
        encoding: 'utf8',
        env: { ...process.env, PATH: empty },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('apply: npm install @noblecloak/react failed:');
      expect(result.stderr).toContain('ENOENT');
      expect(result.stderr).toContain('The files above were written');
      expect(existsSync(join(project, 'app/approvals/page.tsx'))).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('says what is wrong with a project that is not a Next.js App Router app', () => {
    manifest({ dependencies: {} });
    expect(apply().stderr).toContain('does not depend on next');
    manifest();
    rmSync(join(project, 'app'), { recursive: true });
    expect(apply().stderr).toContain('no app/ or src/app/');
    rmSync(join(project, 'package.json'));
    expect(apply().stderr).toContain('has no package.json');
    expect(apply('--bogus').stderr).toContain('unknown argument --bogus');
    expect(apply('--source').stderr).toContain('--source needs a value');
  });

  describe('--source <tarballs>', () => {
    let tarballs: string;
    beforeEach(() => {
      tarballs = mkdtempSync(join(tmpdir(), 'tarballs-'));
    });
    afterEach(() => {
      rmSync(tarballs, { recursive: true, force: true });
    });

    /** One empty tarball per package, named as `bun pm pack` names it. */
    const pack = (...files: string[]): void => {
      for (const file of files) writeFileSync(join(tarballs, file), '');
    };
    const ALL = [
      'noblecloak-react-1.2.3.tgz',
      'noblecloak-client-4.5.6.tgz',
      'noblecloak-theme-7.8.9.tgz',
    ];

    it('needs exactly one tarball of each package', () => {
      expect(apply('--source', tarballs).stderr).toContain(
        'expected one noblecloak-react-<version>.tgz, found 0'
      );
      expect(apply('--source', join(tarballs, 'nope')).stderr).toContain('no such directory');
    });

    it('refuses a directory without the theme tarball, which the react tarball depends on', () => {
      pack('noblecloak-react-1.2.3.tgz', 'noblecloak-client-4.5.6.tgz');
      const result = apply('--source', tarballs, '--skip-install');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('expected one noblecloak-theme-<version>.tgz, found 0');
    });

    it('installs the three and pins the client and theme dependencies of the react tarball to theirs', () => {
      pack(...ALL);
      const result = apply('--source', tarballs, '--skip-install');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `would run npm install ${tarballs}/noblecloak-react-1.2.3.tgz ${tarballs}/noblecloak-client-4.5.6.tgz ${tarballs}/noblecloak-theme-7.8.9.tgz`
      );
      expect(result.stdout).toContain('pin @noblecloak/client to file:');
      expect(result.stdout).toContain('pin @noblecloak/theme to file:');
      const written = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
        overrides: Record<string, string>;
        dependencies: Record<string, string>;
      };
      expect(written.overrides).toEqual({
        '@noblecloak/client': `file:${tarballs}/noblecloak-client-4.5.6.tgz`,
        '@noblecloak/theme': `file:${tarballs}/noblecloak-theme-7.8.9.tgz`,
      });
      expect(written.dependencies.next).toBe('16.4.0');
    });

    it('adds only the override the manifest lacks', () => {
      pack(...ALL);
      manifest({
        overrides: { '@noblecloak/client': `file:${tarballs}/noblecloak-client-4.5.6.tgz` },
      });
      const result = apply('--source', tarballs, '--skip-install');
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('pin @noblecloak/client');
      expect(result.stdout).toContain('pin @noblecloak/theme');
      const written = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
        overrides: Record<string, string>;
      };
      expect(Object.keys(written.overrides)).toEqual(['@noblecloak/client', '@noblecloak/theme']);
    });

    it('keeps the manifest indent and line endings, and does not rewrite it on a second run', () => {
      pack(...ALL);
      writeFileSync(
        join(project, 'package.json'),
        '{\r\n\t"name": "x",\r\n\t"dependencies": { "next": "16.4.0" }\r\n}\r\n'
      );
      expect(apply('--source', tarballs, '--skip-install').status).toBe(0);
      const first = readFileSync(join(project, 'package.json'), 'utf8');
      expect(first).toContain('\r\n\t"overrides"');
      expect(first.replace(/\r\n/g, '')).not.toContain('\n');
      const second = apply('--source', tarballs, '--skip-install');
      expect(second.stdout).not.toContain('pin @noblecloak/');
      expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe(first);
    });

    it('names the override field of pnpm and yarn, and writes both pins into it', () => {
      pack(...ALL);
      writeFileSync(join(project, 'pnpm-lock.yaml'), '');
      expect(apply('--source', tarballs, '--skip-install').stdout).toContain('(pnpm.overrides');
      const pnpm = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
        pnpm: { overrides: Record<string, string> };
      };
      expect(Object.keys(pnpm.pnpm.overrides)).toEqual(['@noblecloak/client', '@noblecloak/theme']);
      rmSync(join(project, 'pnpm-lock.yaml'));
      manifest();
      writeFileSync(join(project, 'yarn.lock'), '');
      expect(apply('--source', tarballs, '--skip-install').stdout).toContain('(resolutions');
      const yarn = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
        resolutions: Record<string, string>;
      };
      expect(Object.keys(yarn.resolutions)).toEqual(['@noblecloak/client', '@noblecloak/theme']);
    });

    it('accepts the tarballs the exercise copies: react and every workspace package it depends on', () => {
      const packages = tarballPackages(ROOT);
      expect(packages.map((pkg) => pkg.name)).toEqual([
        '@noblecloak/client',
        '@noblecloak/react',
        '@noblecloak/theme',
      ]);
      pack(...packages.map((pkg) => `${pkg.name.slice(1).replace('/', '-')}-${pkg.version}.tgz`));
      expect(apply('--source', tarballs, '--skip-install').status).toBe(0);
    });
  });
});

describe('run', () => {
  it('names why a command could not start, not only that it exited without a status', () => {
    expect(() => {
      run('nc-no-such-command-for-the-exercise', [], tmpdir());
    }).toThrow(/ENOENT/);
  });
});

describe('settleReport', () => {
  it('lets the failed step stay the error when the report cannot be written either, and says so', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => {
        settleReport(() => {
          throw new Error('disk full');
        }, true);
      }).not.toThrow();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    } finally {
      logged.mockRestore();
    }
  });

  it('fails a run whose steps passed when the report cannot be written', () => {
    expect(() => {
      settleReport(() => {
        throw new Error('disk full');
      }, false);
    }).toThrow('disk full');
  });
});

describe('the permissions skill', () => {
  const PERMISSIONS_TEMPLATES = join(ROOT, 'packages/skills/permissions/templates');
  const PERMISSIONS_APPLY = join(ROOT, 'packages/skills/permissions/scripts/apply.mjs');
  const shape = SKILLS.permissions;
  const filesUnder = (dir: string, base: string): string[] =>
    spawnSync('find', [dir, '-type', 'f'], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(base.length + 1))
      .sort();

  it('its templates are the example files, up to aliases and formatting', async () => {
    expect(await compareTrees(EXAMPLE_APP, PERMISSIONS_TEMPLATES, shape.compared)).toEqual([]);
  });

  it('compares every file it ships, and ships every file it compares', () => {
    expect(
      coverageGaps(filesUnder(PERMISSIONS_TEMPLATES, PERMISSIONS_TEMPLATES), shape.compared)
    ).toEqual({ uncompared: [], untemplated: [] });
  });

  it('puts every example file under app/permissions in its compared or excluded list, once', () => {
    const listed = filesUnder(join(EXAMPLE_APP, shape.dir), EXAMPLE_APP);
    expect(listed.length).toBe(shape.compared.length + shape.excluded.length);
    expect(classificationGaps(listed, shape.compared, shape.excluded)).toEqual({
      unclassified: [],
      both: [],
      stale: [],
    });
  });

  it('runs mock mode only, with its own spec and page', () => {
    const stages = e2eStages({
      root: ROOT,
      appDir: '/tmp/scaffold/app',
      env: {},
      skill: 'permissions',
    });
    expect(stages).toHaveLength(1);
    expect(stages[0]?.e2e.env).toMatchObject({
      NC_E2E_SPEC: 'permissions.spec.ts',
      NC_E2E_READY_PATH: '/permissions',
    });
    expect(stages[0]?.e2e.name).toBe(
      'run the permissions spec in mock mode (flow tests, no @csp or @callback-headers)'
    );
    // The approvals mock stage names its own spec too: the example's mock run holds both.
    expect(e2eStages({ root: ROOT, appDir: '/tmp/a', env: {} })[0]?.e2e.env.NC_E2E_SPEC).toBe(
      'approvals.spec.ts'
    );
  });

  it('reads --skill, approvals by default, and refuses another name', () => {
    expect(skillOf([])).toBe('approvals');
    expect(skillOf(['--keep', '--skill', 'permissions'])).toBe('permissions');
    expect(() => skillOf(['--skill', 'audit'])).toThrow(
      '--skill takes one of approvals, permissions, connections'
    );
    expect(() => skillOf(['--skill'])).toThrow();
  });

  it('apply.mjs writes the route and the roles key', () => {
    const project = mkdtempSync(join(tmpdir(), 'apply-permissions-'));
    try {
      writeFileSync(
        join(project, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { next: '16.4.0' } })
      );
      mkdirSync(join(project, 'app'));
      const result = spawnSync(
        'node',
        [PERMISSIONS_APPLY, '--project', project, '--skip-install'],
        {
          encoding: 'utf8',
        }
      );
      expect(result.status, result.stderr).toBe(0);
      for (const file of shape.compared) expect(existsSync(join(project, 'app', file))).toBe(true);
      const env = readFileSync(join(project, '.env.example'), 'utf8');
      expect(env).toContain('NEXT_PUBLIC_NC_ROLES=');
      expect(env).toContain(
        'NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI=http://localhost:3000/permissions/callback'
      );
      expect(env).toContain('NobleCloak Permissions');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('the connections skill', () => {
  const CONNECTIONS_TEMPLATES = join(ROOT, 'packages/skills/connections/templates');
  const CONNECTIONS_APPLY = join(ROOT, 'packages/skills/connections/scripts/apply.mjs');
  const shape = SKILLS.connections;
  const filesUnder = (dir: string, base: string): string[] =>
    spawnSync('find', [dir, '-type', 'f'], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(base.length + 1))
      .sort();

  it('its templates are the example files, up to aliases and formatting', async () => {
    expect(await compareTrees(EXAMPLE_APP, CONNECTIONS_TEMPLATES, shape.compared)).toEqual([]);
  });

  it('compares every file it ships, and ships every file it compares', () => {
    expect(
      coverageGaps(filesUnder(CONNECTIONS_TEMPLATES, CONNECTIONS_TEMPLATES), shape.compared)
    ).toEqual({ uncompared: [], untemplated: [] });
  });

  it('puts every example file under app/connections in its compared or excluded list, once', () => {
    const listed = filesUnder(join(EXAMPLE_APP, shape.dir), EXAMPLE_APP);
    expect(listed.length).toBe(shape.compared.length + shape.excluded.length);
    expect(classificationGaps(listed, shape.compared, shape.excluded)).toEqual({
      unclassified: [],
      both: [],
      stale: [],
    });
  });

  it('runs mock mode only, with its own spec and page', () => {
    const stages = e2eStages({
      root: ROOT,
      appDir: '/tmp/scaffold/app',
      env: {},
      skill: 'connections',
    });
    expect(stages).toHaveLength(1);
    expect(stages[0]?.e2e.env).toMatchObject({
      NC_E2E_SPEC: 'connections.spec.ts',
      NC_E2E_READY_PATH: '/connections',
    });
    expect(skillOf(['--skill', 'connections'])).toBe('connections');
  });

  it('apply.mjs writes the route and its own redirect key, and no roles key', () => {
    const project = mkdtempSync(join(tmpdir(), 'apply-connections-'));
    try {
      writeFileSync(
        join(project, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { next: '16.4.0' } })
      );
      mkdirSync(join(project, 'app'));
      const result = spawnSync(
        'node',
        [CONNECTIONS_APPLY, '--project', project, '--skip-install'],
        { encoding: 'utf8' }
      );
      expect(result.status, result.stderr).toBe(0);
      for (const file of shape.compared) expect(existsSync(join(project, 'app', file))).toBe(true);
      const env = readFileSync(join(project, '.env.example'), 'utf8');
      expect(env).toContain(
        'NEXT_PUBLIC_NC_CONNECTIONS_REDIRECT_URI=http://localhost:3000/connections/callback'
      );
      expect(env).not.toContain('NEXT_PUBLIC_NC_ROLES=');
      expect(env).toContain('NobleCloak Connections');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('applies beside the permissions skill: each page keeps its own redirect key', () => {
    const project = mkdtempSync(join(tmpdir(), 'apply-both-'));
    try {
      writeFileSync(
        join(project, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { next: '16.4.0' } })
      );
      mkdirSync(join(project, 'app'));
      for (const skill of ['permissions', 'connections']) {
        const result = spawnSync(
          'node',
          [
            join(ROOT, 'packages/skills', skill, 'scripts/apply.mjs'),
            '--project',
            project,
            '--skip-install',
          ],
          { encoding: 'utf8' }
        );
        expect(result.status, result.stderr).toBe(0);
      }
      const env = readFileSync(join(project, '.env.example'), 'utf8');
      expect(env).toContain('NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI=');
      expect(env).toContain('NEXT_PUBLIC_NC_CONNECTIONS_REDIRECT_URI=');
      // The shared keys are written once.
      expect(env.match(/^NEXT_PUBLIC_NC_API_URL=/gm)).toHaveLength(1);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
