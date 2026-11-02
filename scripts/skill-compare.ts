/**
 * The pure half of `skill-exercise.ts`: which files the skill generates, and how a generated tree is compared
 * with the example's (aliases resolved, formatting and the order of binding imports ignored).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { format } from 'prettier';

/**
 * The files the skill generates, as paths under the app's `app/` directory. The same path is the example's
 * file and the generated one. To widen the skill (the CSP, `proxy.ts`, the health route and the callback
 * route's headers are the next step), add the file here and under `packages/skills/approvals/templates/`.
 */
export const COMPARED_FILES: readonly string[] = [
  'approvals/page.tsx',
  'approvals/layout.tsx', // the stylesheet import
  'approvals/ApprovalsExample.tsx',
  'approvals/ConfigProblem.tsx',
  'approvals/auth.ts', // the sign-in object
  'approvals/config.ts', // the environment the token getter and the provider read
  'approvals/CallbackClient.tsx', // the sign-in callback
  'approvals/callback/page.tsx',
];

/**
 * The example's files under `app/approvals/` that the skill deliberately does not generate, as paths under
 * `app/`. With `COMPARED_FILES` this is a closed list: a test fails when a file there is in neither, so a new
 * example file is a decision (compare it and template it, or exclude it here), not a silent gap.
 */
export const EXCLUDED_FILES: readonly string[] = [
  // The example's unit tests: the skill ships no tests (SKILL.md says so).
  'approvals/ApprovalsExample.test.tsx',
  'approvals/CallbackClient.test.tsx',
  'approvals/auth.test.ts',
  'approvals/config.test.ts',
  'approvals/pages.test.tsx',
];

/** The example directory, under `app/`, whose every file must be in `COMPARED_FILES` or `EXCLUDED_FILES`. */
export const CLASSIFIED_DIR = 'approvals';

/** The files the permissions skill generates (`packages/skills/permissions/templates/`), as paths under `app/`. */
export const PERMISSIONS_COMPARED_FILES: readonly string[] = [
  'permissions/page.tsx',
  'permissions/layout.tsx', // the stylesheet import
  'permissions/PermissionsExample.tsx',
  'permissions/ConfigProblem.tsx',
  'permissions/auth.ts', // the sign-in object
  'permissions/config.ts', // the environment the token getter, the roles and the provider read
  'permissions/CallbackClient.tsx', // the sign-in callback
  'permissions/callback/page.tsx',
];

/** The example's files under `app/permissions/` the permissions skill does not generate: its unit tests. */
export const PERMISSIONS_EXCLUDED_FILES: readonly string[] = [
  'permissions/PermissionsExample.test.tsx',
  'permissions/CallbackClient.test.tsx',
  'permissions/auth.test.ts',
  'permissions/config.test.ts',
  'permissions/pages.test.tsx',
];

/** The files the connections skill generates (`packages/skills/connections/templates/`), as paths under `app/`. */
export const CONNECTIONS_COMPARED_FILES: readonly string[] = [
  'connections/page.tsx',
  'connections/layout.tsx', // the stylesheet import
  'connections/ConnectionsExample.tsx',
  'connections/ConfigProblem.tsx',
  'connections/auth.ts', // the sign-in object
  'connections/config.ts', // the environment the token getter and the provider read
  'connections/CallbackClient.tsx', // the sign-in callback
  'connections/callback/page.tsx',
];

/** The example's files under `app/connections/` the connections skill does not generate: its unit tests. */
export const CONNECTIONS_EXCLUDED_FILES: readonly string[] = [
  'connections/ConnectionsExample.test.tsx',
  'connections/CallbackClient.test.tsx',
  'connections/auth.test.ts',
  'connections/config.test.ts',
  'connections/pages.test.tsx',
];

/** The skills the exercise knows: each mirrors a directory of `examples/next-app/app`. */
export const SKILL_NAMES = ['approvals', 'permissions', 'connections'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

/**
 * What the exercise needs of a skill: the example directory it mirrors, the files it generates and the
 * example files it leaves out, the example's mock-mode spec, and whether it has a sign-in stage (the sign-in spec
 * covers the approvals route only).
 */
export interface SkillShape {
  readonly dir: string;
  readonly compared: readonly string[];
  readonly excluded: readonly string[];
  readonly mockSpec: string;
  readonly signInStage: boolean;
}

export const SKILLS: Readonly<Record<SkillName, SkillShape>> = {
  approvals: {
    dir: CLASSIFIED_DIR,
    compared: COMPARED_FILES,
    excluded: EXCLUDED_FILES,
    mockSpec: 'approvals.spec.ts',
    signInStage: true,
  },
  permissions: {
    dir: 'permissions',
    compared: PERMISSIONS_COMPARED_FILES,
    excluded: PERMISSIONS_EXCLUDED_FILES,
    mockSpec: 'permissions.spec.ts',
    signInStage: false,
  },
  connections: {
    dir: 'connections',
    compared: CONNECTIONS_COMPARED_FILES,
    excluded: CONNECTIONS_EXCLUDED_FILES,
    mockSpec: 'connections.spec.ts',
    signInStage: false,
  },
};

/** The skill a command line names (`--skill <name>`), `approvals` by default; an unknown name throws. */
export function skillOf(args: readonly string[]): SkillName {
  const at = args.indexOf('--skill');
  if (at === -1) return 'approvals';
  const name = args[at + 1];
  if (name === undefined || !(SKILL_NAMES as readonly string[]).includes(name))
    throw new Error(`--skill takes one of ${SKILL_NAMES.join(', ')}`);
  return name as SkillName;
}

/**
 * Checks the files under `CLASSIFIED_DIR` (paths under `app/`) against the two lists: files in neither, files
 * in both, and listed files that no longer exist.
 */
export function classificationGaps(
  exampleFiles: readonly string[],
  compared: readonly string[] = COMPARED_FILES,
  excluded: readonly string[] = EXCLUDED_FILES
) {
  return {
    unclassified: exampleFiles.filter(
      (file) => !compared.includes(file) && !excluded.includes(file)
    ),
    both: compared.filter((file) => excluded.includes(file)),
    stale: [...compared, ...excluded].filter((file) => !exampleFiles.includes(file)),
  };
}

/**
 * The tags of the example's end-to-end tests that the skill's run leaves out, because they assert what the
 * example ships and the skill does not generate (R-U4-3: no generated configuration or middleware):
 * `@csp`, the content-security policy (`app/csp.ts`, `proxy.ts`), and `@callback-headers`, the callback
 * route's `Cache-Control` and `Referrer-Policy` (`next.config.ts`). The example's own run keeps both.
 */
export const SKILL_RUN_EXCLUDED_TAGS = ['@csp', '@callback-headers'] as const;

/** The Playwright `--grep-invert` pattern that leaves out every test tagged with one of `SKILL_RUN_EXCLUDED_TAGS`. */
export const SKILL_RUN_GREP_INVERT = SKILL_RUN_EXCLUDED_TAGS.join('|');

/** Rewrites `'@app/<path>'` to the relative specifier from the file at `fileDir` (a path under `app/`). */
export function resolveAliases(text: string, fileDir: string): string {
  return text.replace(/(['"])@app\/([^'"]+)\1/g, (_match, quote: string, target: string) => {
    const relative = posix.relative(fileDir, target);
    return `${quote}${relative.startsWith('.') ? relative : `./${relative}`}${quote}`;
  });
}

/** Fixed formatting options (the repository's own), so neither side's prettier configuration takes part. */
const FORMAT = {
  semi: true,
  singleQuote: true,
  trailingComma: 'es5',
  printWidth: 100,
  tabWidth: 2,
} as const;

/** `import x from`, `import { … } from`, `import type …`: an import that binds a name, so its order is free. */
const isBindingImport = (statement: string): boolean => /^import\s[^'"]*\sfrom\s/.test(statement);

/**
 * The text formatted by prettier with fixed options, then, in each run of import statements at the start of a
 * line, the binding imports sorted among the places binding imports hold, and the blank lines in and after the
 * run dropped.
 * A bare side-effect import (`import './x.css';`) keeps its place: their order is the order the styles apply.
 * Prettier leaves string and template literal contents alone, so a difference inside one is a difference.
 * `filepath` picks the parser (`.ts` or `.tsx`).
 */
export async function normalize(text: string, filepath: string): Promise<string> {
  const lines = (await format(text, { ...FORMAT, filepath })).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (!(lines[i] ?? '').startsWith('import ')) {
      out.push(lines[i] ?? '');
      i += 1;
      continue;
    }
    // One run: import statements (each joined onto one line); the blank lines between and after them go.
    const run: string[] = [];
    while (i < lines.length) {
      const line = lines[i] ?? '';
      if (line === '') {
        i += 1;
        continue;
      }
      if (!line.startsWith('import ')) break;
      let statement = line;
      while (!statement.trimEnd().endsWith(';') && i + 1 < lines.length)
        statement += ` ${(lines[++i] ?? '').trim()}`;
      run.push(statement);
      i += 1;
    }
    const sorted = run.filter(isBindingImport).sort();
    out.push(
      ...run.map((statement) => (isBindingImport(statement) ? (sorted.shift() ?? '') : statement))
    );
  }
  return out.join('\n');
}

export interface FileDifference {
  readonly file: string;
  readonly reason: 'missing' | 'differs';
}

/** Files whose normalized text differs between the example (aliases resolved) and the generated app. */
export async function compareTrees(
  exampleApp: string,
  generatedApp: string,
  files = COMPARED_FILES
): Promise<FileDifference[]> {
  const found: FileDifference[] = [];
  for (const file of files) {
    const generated = join(generatedApp, file);
    if (!existsSync(generated)) {
      found.push({ file, reason: 'missing' });
      continue;
    }
    const expected = await normalize(
      resolveAliases(readFileSync(join(exampleApp, file), 'utf8'), posix.dirname(file)),
      file
    );
    if (expected !== (await normalize(readFileSync(generated, 'utf8'), file)))
      found.push({ file, reason: 'differs' });
  }
  return found;
}

/** The template files that no compared file covers, and the compared files that have no template. */
export function coverageGaps(
  templates: readonly string[],
  compared: readonly string[] = COMPARED_FILES
) {
  return {
    uncompared: templates.filter((file) => !compared.includes(file)),
    untemplated: compared.filter((file) => !templates.includes(file)),
  };
}

export interface StepTime {
  readonly name: string;
  readonly ms: number;
}

/** Work the skills' CI jobs do in separate steps, outside the script's timer. */
export const WALL_TIME_EXCLUDES = ['bun install', 'Playwright browser install'] as const;

export interface WallTimeReport {
  totalMs: number;
  /**
   * True only for a run in which every step ran and passed. False when a step was left out (`--skip-e2e`)
   * or a step threw (`failedStep`): the figure is then not comparable with a full run.
   */
  complete: boolean;
  /** The name of the step that threw, when one did; the steps after it did not run. */
  failedStep?: string;
  skipped: readonly string[];
  /** What the steps do not time, so the figure is read for what it is. */
  excludes: readonly string[];
  steps: readonly StepTime[];
}

export function wallTimeReport(
  steps: readonly StepTime[],
  skipped: readonly string[] = [],
  failedStep?: string,
  excludes: readonly string[] = WALL_TIME_EXCLUDES
): WallTimeReport {
  return {
    totalMs: steps.reduce((sum, step) => sum + step.ms, 0),
    complete: failedStep === undefined && skipped.length === 0,
    ...(failedStep === undefined ? {} : { failedStep }),
    skipped,
    excludes,
    steps,
  };
}
