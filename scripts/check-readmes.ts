/**
 * README check. Reads the README.md of every package the workspace publishes and of every example,
 * and fails when one is missing or lacks a section a stranger needs.
 *
 * A publishable package (a workspace package not marked `private`) must have:
 *
 * - `# <package name>` as its first heading;
 * - a `## Install` section;
 * - a `## Quickstart`, `## Usage` or `## Use` section;
 * - a `## License` section.
 *
 * An example (a workspace package under `examples/`) must have `## What this shows`, a `##` heading
 * that starts with `Run it`, and `## Troubleshooting`.
 *
 * Section names are matched without regard to case. A required section must have something under it
 * before the next `#` or `##` heading. Headings inside fenced code blocks are not headings. A private
 * package outside `examples/` is not checked, and the OK line names each one.
 *
 * Run with `bun run check:readmes`. Exit code 1 and one line per problem (`file: package — reason`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { listWorkspacePackages, type WorkspacePackage } from './workspace.js';

export type ReadmeProblemKind =
  'missing-readme' | 'wrong-title' | 'missing-section' | 'empty-section';

export interface ReadmeProblem {
  /** Path of the README relative to the scanned root, with forward slashes. */
  readonly file: string;
  /** The package's name. */
  readonly subject: string;
  readonly kind: ReadmeProblemKind;
  /** The required section, for `missing-section` and `empty-section`. */
  readonly section?: string;
}

interface SectionRule {
  /** How the section is named in a problem. */
  readonly label: string;
  /** The heading texts that satisfy the rule, as a README writes them. Matched without regard to case. */
  readonly names: readonly string[];
  /** When true a heading that starts with a name satisfies the rule; otherwise it must equal one. */
  readonly prefix?: boolean;
}

const PACKAGE_SECTIONS: readonly SectionRule[] = [
  { label: 'Install', names: ['Install'] },
  { label: 'Quickstart, Usage or Use', names: ['Quickstart', 'Usage', 'Use'] },
  { label: 'License', names: ['License'] },
];

const EXAMPLE_SECTIONS: readonly SectionRule[] = [
  { label: 'What this shows', names: ['What this shows'] },
  { label: 'Run it', names: ['Run it'], prefix: true },
  { label: 'Troubleshooting', names: ['Troubleshooting'] },
];

const RULES_BY_LABEL = new Map(
  [...PACKAGE_SECTIONS, ...EXAMPLE_SECTIONS].map((rule) => [rule.label, rule])
);

interface Heading {
  readonly level: number;
  readonly text: string;
  /** True when a non-blank line follows before the next level 1 or 2 heading. */
  readonly hasContent: boolean;
}

type MutableHeading = { -readonly [K in keyof Heading]: Heading[K] };

const FENCE = /^\s{0,3}(```|~~~)/;
const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** The ATX headings of a Markdown document, in order, skipping fenced code blocks. */
function parseHeadings(markdown: string): Heading[] {
  const headings: MutableHeading[] = [];
  // The nearest level 1 or 2 heading above the current line: the section non-blank lines belong to.
  let open: MutableHeading | undefined;
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    const wasInFence = fence !== undefined;
    if (wasInFence) {
      if (marker === fence) fence = undefined;
    } else if (marker !== undefined) {
      fence = marker;
    }
    const match = wasInFence || marker !== undefined ? null : ATX_HEADING.exec(line);
    if (match) {
      const heading = { level: (match[1] ?? '').length, text: match[2] ?? '', hasContent: false };
      headings.push(heading);
      if (heading.level <= 2) open = heading;
    } else if (line.trim() !== '' && open) {
      open.hasContent = true;
    }
  }
  return headings;
}

function satisfies(rule: SectionRule, heading: Heading): boolean {
  if (heading.level !== 2) return false;
  const text = heading.text.toLowerCase();
  return rule.names.some((name) => {
    const wanted = name.toLowerCase();
    return rule.prefix ? text.startsWith(wanted) : text === wanted;
  });
}

function checkSections(
  headings: readonly Heading[],
  rules: readonly SectionRule[],
  where: Pick<ReadmeProblem, 'file' | 'subject'>
): ReadmeProblem[] {
  const problems: ReadmeProblem[] = [];
  for (const rule of rules) {
    const found = headings.filter((heading) => satisfies(rule, heading));
    if (found.length === 0) {
      problems.push({ ...where, kind: 'missing-section', section: rule.label });
    } else if (!found.some((heading) => heading.hasContent)) {
      problems.push({ ...where, kind: 'empty-section', section: rule.label });
    }
  }
  return problems;
}

const toPosix = (path: string): string => path.split(sep).join('/');

const isExample = (root: string, pkg: WorkspacePackage): boolean =>
  toPosix(relative(root, pkg.dir)).startsWith('examples/');

/** The workspace packages whose README is checked, and the private ones that are not. */
function partition(root: string): {
  publishable: WorkspacePackage[];
  examples: WorkspacePackage[];
  unchecked: WorkspacePackage[];
} {
  const packages = listWorkspacePackages(root);
  const examples = packages.filter((pkg) => isExample(root, pkg));
  const rest = packages.filter((pkg) => !isExample(root, pkg));
  return {
    publishable: rest.filter((pkg) => !pkg.private),
    examples,
    unchecked: rest.filter((pkg) => pkg.private),
  };
}

/** Every README problem under `root`, in path order. */
export function findReadmeProblems(root: string): ReadmeProblem[] {
  const { publishable, examples } = partition(root);
  const checked = [...publishable, ...examples].sort((a, b) => (a.dir < b.dir ? -1 : 1));
  return checked.flatMap((pkg) => {
    const path = join(pkg.dir, 'README.md');
    const where = { file: toPosix(relative(root, path)), subject: pkg.name };
    if (!existsSync(path)) return [{ ...where, kind: 'missing-readme' as const }];
    const headings = parseHeadings(readFileSync(path, 'utf8'));
    if (isExample(root, pkg)) return checkSections(headings, EXAMPLE_SECTIONS, where);
    const title = headings[0];
    const titleProblems: ReadmeProblem[] =
      title?.level === 1 && title.text === pkg.name ? [] : [{ ...where, kind: 'wrong-title' }];
    return [...titleProblems, ...checkSections(headings, PACKAGE_SECTIONS, where)];
  });
}

/** `"## A"`, `"## A" or "## B"`, `"## A", "## B" or "## C"`. */
function headingChoices(rule: SectionRule): string {
  const quoted = rule.names.map((name) => `"## ${name}"`);
  const last = quoted.at(-1) ?? '';
  return quoted.length === 1 ? last : `${quoted.slice(0, -1).join(', ')} or ${last}`;
}

function reason(problem: ReadmeProblem): string {
  if (problem.kind === 'missing-readme') return 'has no README.md';
  if (problem.kind === 'wrong-title') return `the first heading must be "# ${problem.subject}"`;
  const rule = RULES_BY_LABEL.get(problem.section ?? '');
  const choices = rule ? headingChoices(rule) : `"## ${problem.section ?? ''}"`;
  if (problem.kind === 'empty-section') return `the ${choices} section is empty`;
  return rule?.prefix
    ? `has no section whose heading starts with ${choices}`
    : `has no ${choices} section`;
}

const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/** Runs the check over `root`, writing one line per problem. Returns the process exit code. */
export function runReadmeCheck(root: string, out: (line: string) => void): number {
  const problems = findReadmeProblems(root);
  if (problems.length === 0) {
    const { publishable, examples, unchecked } = partition(root);
    const skipped =
      unchecked.length === 0
        ? ''
        : `; not checked, private: ${unchecked.map((pkg) => pkg.name).join(', ')}`;
    out(
      `README check: OK (${count(publishable.length, 'publishable package')}, ${count(examples.length, 'example')}${skipped})`
    );
    return 0;
  }
  for (const problem of problems) {
    out(`${problem.file}: ${problem.subject} — ${reason(problem)}`);
  }
  out(`README check: ${String(problems.length)} problem(s)`);
  return 1;
}

if (import.meta.main) {
  process.exit(
    runReadmeCheck(process.cwd(), (line) => {
      console.log(line);
    })
  );
}
