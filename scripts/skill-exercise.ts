/**
 * The acceptance test of a skill under `packages/skills/` (`--skill approvals`, the default, `--skill permissions`
 * or `--skill connections`), one script that CI and a developer both run: pack the packages, scaffold a fresh Next.js app,
 * apply the skill to it with its own script, then build it and run the example's Playwright specs against it in
 * each mode (`e2eStages`): mock mode with the skill's spec (`e2e/approvals.spec.ts`, `e2e/permissions.spec.ts`,
 * `e2e/connections.spec.ts`),
 * then, for approvals, sign-in mode with `e2e/signin.spec.ts`. `SKILL_RUN_GREP_INVERT` leaves out the `@csp` and
 * `@callback-headers` tests, which assert what only the example ships. Last it compares the files the skill
 * generated with the example's. It writes the wall time of each step to
 * `artifacts/skill-exercise-wall-time.json` (approvals) or `artifacts/skill-exercise-<skill>-wall-time.json`.
 *
 *   bun scripts/skill-exercise.ts [--skill approvals|permissions|connections] [--keep] [--skip-e2e]
 *
 * `--skip-e2e` still builds both modes and leaves out both specs; the report then lists them as skipped.
 *
 * Network: the package registry only (the scaffold's Google font import is replaced before the build; in sign-in
 * mode the test answers for the sign-in service and the API).
 *
 * Prerequisites (CI installs them; locally they are already there): `bun install`, the Playwright browser
 * (`bun run --cwd examples/next-app playwright install chromium-headless-shell`).
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';

import {
  SKILLS,
  SKILL_RUN_GREP_INVERT,
  compareTrees,
  coverageGaps,
  skillOf,
  wallTimeReport,
} from './skill-compare.js';
import type { SkillName, StepTime } from './skill-compare.js';
import { listPublicPackages } from './workspace.js';
import type { WorkspacePackage } from './workspace.js';

/** The `create-next-app` the exercise scaffolds with; the Next.js the example pins (`examples/next-app`). */
export const CREATE_NEXT_APP_VERSION = '16.4.3';

/** A root layout with no font import: the exercise's only network use is the package registry. */
export const PLAIN_LAYOUT = `import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

export function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {}
): void {
  const result = spawnSync(command, [...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    // A command that never started (ENOENT, EACCES) has no exit status; its error says why.
    const why = result.error === undefined ? '' : `: ${result.error.message}`;
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${String(result.status)}) in ${cwd}${why}`
    );
  }
}

/**
 * Writes the wall-time report. On a run whose step failed, a report that cannot be written is said on stderr and
 * the step's error stays the one that ends the run; on a run whose steps passed, it is the error.
 */
export function settleReport(write: () => void, failed: boolean): void {
  try {
    write();
  } catch (error) {
    if (!failed) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`The wall-time report could not be written either: ${message}`);
  }
}

export function listTemplateFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => posix.relative(dir, posix.join(entry.parentPath, entry.name)))
    .sort();
}

export interface E2eStage {
  /** The app's production build, with the mode's `NEXT_PUBLIC_*` values (inlined by `next build`). */
  readonly build: { readonly name: string; readonly env: Readonly<Record<string, string>> };
  /** The example's Playwright spec of the mode, against that build (`next start`, no second build). */
  readonly e2e: {
    readonly name: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  };
}

/**
 * The two modes the exercise builds and end-to-end tests the scaffolded app in, in order: mock mode
 * (`e2e/approvals.spec.ts`) and sign-in mode (`NC_E2E_MODE=oidc`, `e2e/signin.spec.ts`), each the way the
 * example's own `test:e2e` runs it, with `SKILL_RUN_GREP_INVERT` leaving out what only the example ships.
 *
 * Each mode has its own app port (`NC_E2E_APP_PORT`, default 3100; `NC_E2E_OIDC_APP_PORT`, default 3101), so
 * neither stage meets the other's server or the example's (3000). The mock runs on `NC_MOCK_PORT` (default
 * 8797). Sign-in mode starts no other server: the test answers for the sign-in service and the API
 * (`ISSUER_ORIGIN`, `OIDC_API_ORIGIN` in the example's `playwright.config.ts`).
 *
 * The sign-in build's environment is the one the example's Playwright config gives its own sign-in build
 * (a test checks the two are equal). The redirect URI is part of it, so it names the sign-in stage's port.
 */
export function e2eStages(options: {
  root: string;
  appDir: string;
  env: NodeJS.ProcessEnv;
  skill?: SkillName;
}): E2eStage[] {
  const { root, appDir, env } = options;
  const skill = options.skill ?? 'approvals';
  const shape = SKILLS[skill];
  const exampleDir = join(root, 'examples/next-app');
  const mockAppPort = env.NC_E2E_APP_PORT ?? '3100';
  const oidcAppPort = env.NC_E2E_OIDC_APP_PORT ?? '3101';
  const mockPort = env.NC_MOCK_PORT ?? '8797';
  const playwright = ['run', 'playwright', 'test', '--grep-invert', SKILL_RUN_GREP_INVERT];
  const server = (port: string) => ({
    NC_E2E_APP_PORT: port,
    NC_E2E_READY_PATH: `/${shape.dir}`,
    NC_E2E_APP_DIR: appDir,
    NC_E2E_APP_COMMAND: `${join(appDir, 'node_modules/.bin/next')} start -p ${port}`,
  });
  const mock = {
    NEXT_PUBLIC_NC_MODE: 'mock',
    NEXT_PUBLIC_NC_API_URL: `http://127.0.0.1:${mockPort}`,
  };
  const oidc = oidcBuildEnv(`http://localhost:${oidcAppPort}`);
  const mockStage: E2eStage = {
    build: { name: 'build the app in mock mode', env: mock },
    e2e: {
      name: `run the ${skill} spec in mock mode (flow tests, no @csp or @callback-headers)`,
      args: playwright,
      cwd: exampleDir,
      // The example's mock run holds every skill's spec; the scaffold has only this skill's page.
      env: { ...mock, NC_MOCK_PORT: mockPort, NC_E2E_SPEC: shape.mockSpec, ...server(mockAppPort) },
    },
  };
  if (!shape.signInStage) return [mockStage];
  return [
    mockStage,
    {
      build: { name: 'build the app in sign-in mode', env: oidc },
      e2e: {
        name: 'run the sign-in spec in sign-in mode (no @csp or @callback-headers)',
        args: playwright,
        cwd: exampleDir,
        env: { ...oidc, NC_E2E_MODE: 'oidc', ...server(oidcAppPort) },
      },
    },
  ];
}

/** The steps a run leaves out: with `--skip-e2e`, the spec of every mode (the builds still run). */
export function skippedSteps(stages: readonly E2eStage[], skipE2e: boolean): string[] {
  return skipE2e ? stages.map((stage) => stage.e2e.name) : [];
}

/**
 * The sign-in build's `NEXT_PUBLIC_*` values for an app at `appOrigin`: the example's Playwright config's
 * oidc `webServer.env`, whose sign-in service and API the test answers for.
 */
export function oidcBuildEnv(appOrigin: string): Record<string, string> {
  return {
    NEXT_PUBLIC_NC_MODE: 'oidc',
    NEXT_PUBLIC_NC_API_URL: 'http://localhost:8789',
    NEXT_PUBLIC_NC_ISSUER: 'http://localhost:8788',
    NEXT_PUBLIC_NC_CLIENT_ID: 'e2e-client',
    NEXT_PUBLIC_NC_REDIRECT_URI: `${appOrigin}/approvals/callback`,
  };
}

/**
 * The public packages whose tarballs the skill installs: `@noblecloak/react` and, transitively, every workspace
 * package in its `dependencies` (each of which `apply.mjs` pins to its tarball). Sorted by name.
 */
export function tarballPackages(root: string): WorkspacePackage[] {
  const packages = listPublicPackages(root);
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const needed = new Set<string>();
  const visit = (name: string): void => {
    const pkg = byName.get(name);
    if (pkg === undefined || needed.has(name)) return;
    needed.add(name);
    const manifest = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency);
  };
  visit('@noblecloak/react');
  return packages.filter((pkg) => needed.has(pkg.name));
}

export async function exercise(
  root: string,
  options: { keep: boolean; skipE2e: boolean; skill?: SkillName }
): Promise<StepTime[]> {
  const skill = options.skill ?? 'approvals';
  const shape = SKILLS[skill];
  const steps: StepTime[] = [];
  let failedStep: string | undefined;
  const step = async (name: string, body: () => void | Promise<void>): Promise<void> => {
    const started = Date.now();
    console.log(`\n== ${name}`);
    try {
      await body();
    } catch (error) {
      failedStep = name;
      throw error;
    } finally {
      steps.push({ name, ms: Date.now() - started });
    }
  };
  const work = mkdtempSync(join(tmpdir(), 'skill-exercise-'));
  const appDir = join(work, 'app');
  const tarballs = join(work, 'tarballs');
  const stages = e2eStages({ root, appDir, env: process.env, skill });
  let failed = false;
  try {
    await step('build the workspace and pack the packages', () => {
      run('bun', ['run', 'build'], root);
      run('bun', ['run', 'pack:all'], root);
      mkdirSync(tarballs);
      for (const pkg of tarballPackages(root)) {
        const file = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`;
        cpSync(join(root, 'artifacts', file), join(tarballs, file));
      }
    });
    await step('scaffold a fresh Next.js app', () => {
      run(
        'npx',
        [
          '--yes',
          `create-next-app@${CREATE_NEXT_APP_VERSION}`,
          'app',
          '--ts',
          '--app',
          '--no-tailwind',
          '--no-eslint',
          '--no-src-dir',
          '--import-alias',
          '@/*',
          '--use-bun',
          '--disable-git',
          '--yes',
          '--no-agent-feedback',
        ],
        work
      );
    });
    await step('replace the scaffold layout (no network font fetch)', () => {
      // The scaffold's layout imports `next/font/google`, and `next build` downloads those fonts from
      // Google's hosts. The exercise needs only the package registry, so the layout becomes a bare one.
      writeFileSync(join(appDir, 'app', 'layout.tsx'), PLAIN_LAYOUT);
    });
    await step('apply the skill', () => {
      run(
        'node',
        [
          join(root, 'packages/skills', skill, 'scripts/apply.mjs'),
          '--project',
          appDir,
          '--source',
          tarballs,
        ],
        root
      );
    });
    // Mock mode, then sign-in mode: `NEXT_PUBLIC_*` values are inlined by `next build`, so each mode is a build
    // of its own (into the same `.next`), and its spec runs against that build before the next one replaces it.
    for (const stage of stages) {
      await step(stage.build.name, () => {
        run('bun', ['run', 'build'], appDir, stage.build.env);
      });
      if (!options.skipE2e)
        await step(stage.e2e.name, () => {
          run('bun', stage.e2e.args, stage.e2e.cwd, stage.e2e.env);
        });
    }
    await step('compare the generated files with the example', async () => {
      const gaps = coverageGaps(
        listTemplateFiles(join(root, 'packages/skills', skill, 'templates')),
        shape.compared
      );
      const differences = await compareTrees(
        join(root, 'examples/next-app/app'),
        join(appDir, 'app'),
        shape.compared
      );
      for (const d of differences) console.error(`${d.reason}: ${d.file}`);
      for (const f of gaps.uncompared) console.error(`template with no comparison: ${f}`);
      for (const f of gaps.untemplated) console.error(`compared file with no template: ${f}`);
      if (differences.length > 0 || gaps.uncompared.length > 0 || gaps.untemplated.length > 0)
        throw new Error('the skill and the example have drifted apart');
    });
    return steps;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Written on a failed run too (the error then goes on, so the exit code is non-zero): the report says
    // which step failed and is marked not complete. A report that cannot be written does not hide that error.
    const skipped = skippedSteps(stages, options.skipE2e);
    const report = wallTimeReport(steps, skipped, failedStep);
    settleReport(() => {
      mkdirSync(join(root, 'artifacts'), { recursive: true });
      writeFileSync(
        join(
          root,
          'artifacts',
          skill === 'approvals'
            ? 'skill-exercise-wall-time.json'
            : `skill-exercise-${skill}-wall-time.json`
        ),
        `${JSON.stringify(report, null, 2)}\n`
      );
    }, failed);
    if (failedStep !== undefined)
      console.log(`\nFAILED at step "${failedStep}". This is not the acceptance result.`);
    else if (!report.complete)
      console.log(
        `\nNOT a full run: skipped ${skipped.join(', ')}. This is not the acceptance result.`
      );
    console.log(`\nwall time ${(report.totalMs / 1000).toFixed(1)} s`);
    for (const s of steps) console.log(`  ${(s.ms / 1000).toFixed(1).padStart(7)} s  ${s.name}`);
    if (options.keep) console.log(`kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flags = new Set(args);
  await exercise(resolve(import.meta.dirname, '..'), {
    keep: flags.has('--keep'),
    skipE2e: flags.has('--skip-e2e'),
    skill: skillOf(args),
  });
}
