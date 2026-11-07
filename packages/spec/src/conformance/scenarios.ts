/** Loading scenario files and the vendored corpus. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';

import { FAMILIES, FEATURES, isFamily, isFeature } from '../spec/families.js';
import type { Family, Feature } from '../spec/families.js';
import { packageRoot } from '../spec/paths.js';
import {
  CAPABILITY_MEMBERS,
  CONTINUATION_KINDS,
  DPOP_MODES,
  LIMIT_NAMES,
  PROPOSAL_MEMBERS,
  PROPOSAL_ROW_KINDS,
} from './types.js';
import type { Scenario } from './types.js';

export const SCENARIO_DIR = (): string => resolve(packageRoot(), 'scenarios');

/**
 * Every scenario in `dirs`, in file order; by default the published ones. A file holds one scenario
 * or a list.
 */
export function loadScenarios(dirs: readonly string[] = [SCENARIO_DIR()]): Scenario[] {
  const out: Scenario[] = [];
  for (const dir of dirs.filter((d) => existsSync(d))) {
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .sort()) {
      const parsed = parse(readFileSync(resolve(dir, file), 'utf8')) as Scenario | Scenario[];
      for (const scenario of Array.isArray(parsed) ? parsed : [parsed]) {
        if (
          typeof scenario.id !== 'string' ||
          !Array.isArray(scenario.steps) ||
          !Array.isArray(scenario.tags)
        ) {
          throw new Error(`${file}: a scenario needs id, tags and steps`);
        }
        assertRequires(scenario, file);
        assertFeatures(scenario, file);
        assertDpop(scenario, file);
        assertLimits(scenario, file);
        assertRestrictions(scenario, file);
        assertPredicates(scenario, file);
        out.push(scenario);
      }
    }
  }
  const ids = out.map((s) => s.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) throw new Error(`duplicate scenario id ${duplicate}`);
  return out;
}

const OPERATORS = [
  'equals',
  'equals_canonical',
  'not_equals',
  'exists',
  'matches',
  'in',
  'length',
  'contains',
  'contains_where',
  'contains_members',
  'lacks_members',
  'lacks_where',
  'lacks_where_matches',
  'lacks',
  'differs_from',
  'lacks_key',
  'keys_exactly',
] as const;

const asList = (value: Family | readonly Family[] | undefined): readonly Family[] =>
  value === undefined ? [] : typeof value === 'string' ? [value] : value;

/** The families a scenario requires: none for a floor scenario. */
export const requiredFamilies = (scenario: Scenario): readonly Family[] =>
  asList(scenario.requires);

/** The families a scenario runs without: it is skipped when the deployment advertises any of them. */
export const excludedFamilies = (scenario: Scenario): readonly Family[] => asList(scenario.unless);

/** Throws when `requires` or `unless` names something that is not a route family (the floor cannot be named). */
export function assertRequires(scenario: Scenario, file: string): void {
  for (const field of ['requires', 'unless'] as const) {
    const value: unknown = scenario[field];
    if (value === undefined) continue;
    const named: readonly unknown[] = Array.isArray(value)
      ? (value as readonly unknown[])
      : [value];
    if (named.length === 0 || !named.every(isFamily))
      throw new Error(
        `${file}: ${scenario.id} ${field} ${JSON.stringify(value)}; it must name one or more of ${FAMILIES.join(', ')}`
      );
  }
}

/** The features a scenario requires: none unless it says. */
export const requiredFeatures = (scenario: Scenario): readonly Feature[] => scenario.features ?? [];

/** Throws when `features` names something that is not a feature (a family is named in `requires`). */
export function assertFeatures(scenario: Scenario, file: string): void {
  const value: unknown = scenario.features;
  if (value === undefined) return;
  const named: readonly unknown[] = Array.isArray(value) ? (value as readonly unknown[]) : [];
  if (named.length === 0 || !named.every(isFeature))
    throw new Error(
      `${file}: ${scenario.id} features ${JSON.stringify(value)}; it must be a list of ${FEATURES.join(', ')}`
    );
}

/** Throws when `dpop` is not one of the modes capabilities can advertise. */
export function assertDpop(scenario: Scenario, file: string): void {
  const value: unknown = scenario.dpop;
  if (value !== undefined && !(DPOP_MODES as readonly unknown[]).includes(value))
    throw new Error(
      `${file}: ${scenario.id} dpop ${JSON.stringify(value)}; it must be one of ${DPOP_MODES.join(', ')}`
    );
}

/** Throws when `limits` or `unreduced_limits` names something `Capabilities.limits` does not have. */
export function assertLimits(scenario: Scenario, file: string): void {
  for (const field of ['limits', 'unreduced_limits'] as const) {
    const value: unknown = scenario[field];
    if (value === undefined) continue;
    const named: readonly unknown[] = Array.isArray(value) ? (value as readonly unknown[]) : [];
    if (named.length === 0 || !named.every((n) => (LIMIT_NAMES as readonly unknown[]).includes(n)))
      throw new Error(
        `${file}: ${scenario.id} ${field} ${JSON.stringify(value)}; it must be a list of ${LIMIT_NAMES.join(', ')}`
      );
  }
}

/** `PolicySubjectType` of the contract. */
const POLICY_SUBJECT_TYPES = ['user', 'agent', 'service', 'group', 'role', 'organization'] as const;

/**
 * A step's `gate`: only on an HTTP step, with an integer status the step expects, a reason, and an `otherwise`
 * whose status the step also expects and whose problem is named. A gate that could never match would skip forever.
 */
export function assertGate(step: unknown, where: string): void {
  if (typeof step !== 'object' || step === null || !('gate' in step)) return;
  const {
    gate: g,
    request,
    expect,
  } = step as {
    gate?: {
      status?: unknown;
      reason?: unknown;
      otherwise?: {
        status?: unknown;
        problem?: unknown;
        detail_matches?: unknown;
        member?: unknown;
      } | null;
    } | null;
    request?: unknown;
    expect?: { status?: unknown };
  };
  if (g === undefined) return;
  const gate: unknown = g;
  const statuses = Array.isArray(expect?.status) ? expect.status : [expect?.status];
  const validPattern = (pattern: unknown): boolean => {
    if (pattern === undefined) return true;
    if (typeof pattern !== 'string') return false;
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  };
  const ok =
    request !== undefined &&
    typeof g === 'object' &&
    g !== null &&
    Number.isInteger(g.status) &&
    statuses.includes(g.status) &&
    typeof g.reason === 'string' &&
    g.reason !== '' &&
    typeof g.otherwise === 'object' &&
    g.otherwise !== null &&
    Number.isInteger(g.otherwise.status) &&
    statuses.includes(g.otherwise.status) &&
    g.otherwise.status !== g.status &&
    typeof g.otherwise.problem === 'string' &&
    g.otherwise.problem !== '' &&
    validPattern(g.otherwise.detail_matches) &&
    (g.otherwise.member === undefined ||
      (typeof g.otherwise.member === 'string' && g.otherwise.member !== ''));
  if (!ok)
    throw new Error(
      `${where}: gate ${JSON.stringify(gate)}; it goes on an HTTP step, with a status and an otherwise.status the step expects, a reason and an otherwise.problem`
    );
}

/** Throws when `advertises`, `tool_registration`, `self_approval_from_approver_surface` or `unserved_delivery` names something the capabilities do not have. */
export function assertRestrictions(scenario: Scenario, file: string): void {
  const advertises: unknown = scenario.advertises;
  if (advertises !== undefined) {
    const named: readonly unknown[] = Array.isArray(advertises)
      ? (advertises as readonly unknown[])
      : [];
    if (
      named.length === 0 ||
      !named.every((n) => (CAPABILITY_MEMBERS as readonly unknown[]).includes(n))
    )
      throw new Error(
        `${file}: ${scenario.id} advertises ${JSON.stringify(advertises)}; it must be a list of ${CAPABILITY_MEMBERS.join(', ')}`
      );
  }
  const argumentsBytes: unknown = scenario.arguments_bytes;
  if (
    argumentsBytes !== undefined &&
    (typeof argumentsBytes !== 'number' || !Number.isInteger(argumentsBytes) || argumentsBytes < 1)
  )
    throw new Error(
      `${file}: ${scenario.id} arguments_bytes ${JSON.stringify(argumentsBytes)}; it must be a positive integer`
    );
  const surface: unknown = scenario.self_approval_from_approver_surface;
  if (surface !== undefined && typeof surface !== 'boolean')
    throw new Error(
      `${file}: ${scenario.id} self_approval_from_approver_surface ${JSON.stringify(surface)}; it must be true or false`
    );
  const servesOnDeny: unknown = scenario.serves_on_deny;
  if (servesOnDeny !== undefined && servesOnDeny !== true)
    throw new Error(`${file}: ${scenario.id} serves_on_deny must be true when given`);
  const registration: unknown = scenario.tool_registration;
  if (registration !== undefined && registration !== 'any' && registration !== 'administrators')
    throw new Error(
      `${file}: ${scenario.id} tool_registration ${JSON.stringify(registration)}; it must be any or administrators`
    );
  for (const field of ['unserved_connection_owner_kind', 'serves_connection_owner_kind'] as const) {
    const kind: unknown = scenario[field];
    if (kind !== undefined && kind !== 'principal' && kind !== 'org')
      throw new Error(
        `${file}: ${scenario.id} ${field} ${JSON.stringify(kind)}; it must be principal or org`
      );
  }
  const who: unknown = scenario.connection_registration_who;
  if (who !== undefined && who !== 'any' && who !== 'administrators')
    throw new Error(
      `${file}: ${scenario.id} connection_registration_who ${JSON.stringify(who)}; it must be any or administrators`
    );
  for (const field of ['unserved_connection_transport', 'serves_connection_transport'] as const) {
    const transport: unknown = scenario[field];
    if (transport !== undefined && transport !== 'mcp' && transport !== 'a2a')
      throw new Error(
        `${file}: ${scenario.id} ${field} ${JSON.stringify(transport)}; it must be mcp or a2a`
      );
  }
  const subjectTypes: unknown = scenario.serves_policy_subject_type;
  const listed = typeof subjectTypes === 'string' ? [subjectTypes] : subjectTypes;
  if (
    subjectTypes !== undefined &&
    (!Array.isArray(listed) ||
      listed.length === 0 ||
      listed.some((t) => !(POLICY_SUBJECT_TYPES as readonly unknown[]).includes(t)))
  )
    throw new Error(
      `${file}: ${scenario.id} serves_policy_subject_type ${JSON.stringify(subjectTypes)}; it must be one or more of ${POLICY_SUBJECT_TYPES.join(', ')}`
    );
  for (const [i, step] of scenario.steps.entries())
    assertGate(step, `${file}: ${scenario.id} step ${String(i + 1)}`);
  const cleanup: unknown = scenario.cleanup;
  if (
    cleanup !== undefined &&
    (!Array.isArray(cleanup) ||
      cleanup.some(
        (step: unknown) =>
          typeof step !== 'object' ||
          step === null ||
          !('request' in step) ||
          'gate' in step ||
          'save' in step
      ))
  )
    throw new Error(
      `${file}: ${scenario.id} cleanup must be a list of request steps with no gate and no save`
    );
  // A gated run stops at the gate, so a variable saved at or after the first gate step may never be saved, and a
  // cleanup step that names it could not run.
  const firstGate = scenario.steps.findIndex((step) => 'gate' in step);
  if (Array.isArray(cleanup) && firstGate !== -1) {
    const unsaved = scenario.steps
      .slice(firstGate)
      .flatMap((step) => ('save' in step ? Object.keys(step.save) : []));
    const named = JSON.stringify(cleanup);
    const unsafe = unsaved.find((name) => named.includes(`\${${name}}`));
    if (unsafe !== undefined)
      throw new Error(
        `${file}: ${scenario.id} cleanup names \${${unsafe}}, which is saved at or after a gate step, so a gated run never saves it`
      );
  }
  for (const field of ['unserved_delivery', 'serves_delivery'] as const) {
    const delivery: unknown = scenario[field];
    if (delivery !== undefined && delivery !== 'push' && delivery !== 'pull' && delivery !== 'held')
      throw new Error(
        `${file}: ${scenario.id} ${field} ${JSON.stringify(delivery)}; it must be push, pull or held`
      );
  }
  const kind: unknown = scenario.serves_kind;
  if (kind !== undefined && !(CONTINUATION_KINDS as readonly unknown[]).includes(kind))
    throw new Error(
      `${file}: ${scenario.id} serves_kind ${JSON.stringify(kind)}; it must be one of ${CONTINUATION_KINDS.join(', ')}`
    );
  const rowKind: unknown = scenario.serves_row_kind;
  if (rowKind !== undefined && !(PROPOSAL_ROW_KINDS as readonly unknown[]).includes(rowKind))
    throw new Error(
      `${file}: ${scenario.id} serves_row_kind ${JSON.stringify(rowKind)}; it must be one of ${PROPOSAL_ROW_KINDS.join(', ')}`
    );
  const member: unknown = scenario.serves_proposal_member;
  if (member !== undefined && !(PROPOSAL_MEMBERS as readonly unknown[]).includes(member))
    throw new Error(
      `${file}: ${scenario.id} serves_proposal_member ${JSON.stringify(member)}; it must be one of ${PROPOSAL_MEMBERS.join(', ')}`
    );
}

/** Throws unless `predicates` is a list of predicates that each check something: a `path` and an operator the engine knows. */
function assertPredicateList(
  predicates: unknown,
  file: string,
  scenario: Scenario,
  where: string
): void {
  if (!Array.isArray(predicates))
    throw new Error(`${file}: ${scenario.id} ${where}: expect.body must be a list`);
  for (const predicate of predicates as Record<string, unknown>[]) {
    const known = OPERATORS.filter((operator) => operator in predicate);
    if (typeof predicate.path !== 'string' || known.length === 0)
      throw new Error(
        `${file}: ${scenario.id} ${where}: a predicate needs a path and one of ${OPERATORS.join(', ')}: ${JSON.stringify(predicate)}`
      );
  }
}

/**
 * Throws when a step would check nothing. A body predicate needs a `path` and a known operator, in a
 * request step and in the `delivers` of a stream step alike. A stream step needs at least one of
 * `delivers` and `lacks`; a `lacks` proves something only when the stream is shown to work, so it needs a
 * `delivers` in the same step or an explicit `open: true`.
 */
export function assertPredicates(scenario: Scenario, file: string): void {
  if (scenario.cleanup !== undefined) {
    const { cleanup, ...rest } = scenario;
    assertPredicates({ ...rest, steps: cleanup }, file);
  }
  for (const [i, step] of scenario.steps.entries()) {
    const where = `step ${String(i + 1)}`;
    if ('stream_events' in step) {
      const spec = step.stream_events;
      if (spec.during.length === 0)
        throw new Error(
          `${file}: ${scenario.id} ${where}: stream_events needs requests to run during`
        );
      for (const sub of spec.during) assertPredicates({ ...scenario, steps: [sub] }, file);
      const delivers = spec.expect.delivers ?? [];
      const lacks = spec.expect.lacks ?? [];
      if (delivers.length === 0 && lacks.length === 0)
        throw new Error(
          `${file}: ${scenario.id} ${where}: a stream_events step needs at least one of expect.delivers and expect.lacks`
        );
      if (lacks.length > 0 && delivers.length === 0 && spec.expect.open !== true)
        throw new Error(
          `${file}: ${scenario.id} ${where}: expect.lacks alone proves nothing, since a stream that delivers nothing satisfies it; add an expect.delivers in the same step or set expect.open: true`
        );
      for (const wanted of delivers) {
        if (typeof wanted === 'string') continue;
        assertPredicateList(wanted.body, file, scenario, `${where} delivers ${wanted.id}`);
        if (wanted.every_event !== undefined && (wanted.every_event as unknown) !== true)
          throw new Error(
            `${file}: ${scenario.id} ${where} delivers ${wanted.id}: every_event must be true when given`
          );
      }
      continue;
    }
    // Rev 12: a control step's answer is checked with the same predicates.
    const controlPredicates = (step as { expect_body?: unknown }).expect_body;
    if (controlPredicates !== undefined)
      assertPredicateList(controlPredicates, file, scenario, `${where} expect_body`);
    const predicates = (step as { expect?: { body?: unknown } }).expect?.body;
    if (predicates === undefined) continue;
    assertPredicateList(predicates, file, scenario, where);
  }
}

export interface CorpusPair {
  readonly id: string;
  readonly arguments: unknown;
  readonly arg_digest: string;
}

/** The vendored `(arguments -> arg_digest)` pairs, with the arguments parsed. */
export function loadCorpusPairs(): CorpusPair[] {
  const corpus = JSON.parse(
    readFileSync(resolve(packageRoot(), 'corpus/arg-digest-pairs.json'), 'utf8')
  ) as {
    pairs: { id: string; arguments_json: string; arg_digest: string }[];
  };
  return corpus.pairs.map((pair) => ({
    id: pair.id,
    arguments: JSON.parse(pair.arguments_json) as unknown,
    arg_digest: pair.arg_digest,
  }));
}
