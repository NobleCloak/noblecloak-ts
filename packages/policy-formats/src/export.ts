import { compareCodeUnits } from './canonical.js';
import type { Dialect } from './cedar/ast.js';
import { NOBLECLOAK } from './cedar/ast.js';
import { baselineStatement, encodedOutcome, encodePolicy } from './cedar/encode.js';
import { printStatements } from './cedar/print.js';
import { PolicyFormatError } from './errors.js';
import { pointer, quote } from './pointer.js';
import { canAskOnMissingFact } from './rules.js';
import { commentBlock, headerLines } from './report.js';
import type {
  CedarExportOptions,
  ExportablePolicy,
  ExportResult,
  ReportEntry,
  ToolInvocationConfig,
} from './types.js';
import { hasLoneSurrogate, toolInvocationProblems } from './validate.js';

export interface Prepared {
  /** The policies that export, sorted by id. Each keeps its index in the input for report paths. */
  readonly exported: readonly { readonly index: number; readonly policy: ExportablePolicy }[];
  readonly unsupported: ReportEntry[];
  /** What an exported policy carries that the file does not: deployment state, members this version does not read. */
  readonly lossy: ReportEntry[];
}

/**
 * The members of a read `Policy` (contract rev 10) plus `origin` (rev 11 provenance). The write members
 * are the policy; the others are deployment state a file does not carry, and are not reported.
 */
const KNOWN_MEMBERS = new Set([
  'id',
  'kind',
  'name',
  'description',
  'subjects',
  'targets',
  'config',
  'version',
  'source',
  'state',
  'unenforced_targets',
  'published_at',
  'updated_at',
  'updated_by',
  'origin',
]);

/**
 * Checks the input and sorts what can be exported from what cannot. Throws `invalid_input` for a policy
 * without a usable id or for two policies with the same id (their statements would merge on import);
 * reports a policy that is not a valid `tool_invocation` policy as unsupported, and does not export it.
 * A subject the dialect cannot express is dropped and reported, and the policy is exported for its other
 * subjects (not at all when it has none).
 */
export function prepare(policies: readonly ExportablePolicy[], dialect: Dialect): Prepared {
  const seen = new Set<string>();
  (policies as readonly unknown[]).forEach((policy, index) => {
    if (typeof policy !== 'object' || policy === null)
      throw new PolicyFormatError('invalid_input', `policy ${String(index)} is not an object`);
    const id: unknown = (policy as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0 || hasLoneSurrogate(id))
      throw new PolicyFormatError(
        'invalid_input',
        `policy ${String(index)} has no id a file can carry: an id is a non-empty, well-formed string`
      );
    if (seen.has(id))
      throw new PolicyFormatError(
        'invalid_input',
        `two policies have the id ${JSON.stringify(id)}`
      );
    seen.add(id);
  });
  const unsupported: ReportEntry[] = [];
  const lossy: ReportEntry[] = [];
  const exported: { index: number; policy: ExportablePolicy }[] = [];
  policies.forEach((policy, index) => {
    const entries: ReportEntry[] = toolInvocationProblems(policy).map((problem) => ({
      path: `${pointer(index)}${problem.path}`,
      reason: problem.reason,
      policy: policy.id,
    }));
    if (entries.length > 0) {
      unsupported.push(...entries);
      return;
    }
    // A subject the dialect cannot express is dropped and reported; the policy is exported for the
    // others. That never widens it: a narrower forbid denies less, a narrower permit allows less, while
    // omitting a deny or an approval policy outright would let its other subjects through.
    const expressible = policy.subjects.filter(
      (subject) => dialect.subjectScope(subject) !== undefined
    );
    const dropped: ReportEntry[] = [];
    policy.subjects.forEach((subject, subjectIndex) => {
      if (dialect.subjectScope(subject) === undefined)
        dropped.push({
          path: pointer(index, 'subjects', subjectIndex),
          reason: `the ${subject.type} subject${'id' in subject ? ` ${quote(subject.id)}` : ''} is not exported: ${dialect.label} has no principal for it${expressible.length > 0 ? '; the policy is exported for its other subjects' : ', and the policy has no other subject, so it is not exported'}`,
          policy: policy.id,
        });
    });
    unsupported.push(...dropped);
    if (expressible.length === 0) return;
    exported.push({
      index,
      policy: dropped.length === 0 ? policy : { ...policy, subjects: expressible },
    });
    const members = policy as unknown as Record<string, unknown>;
    for (const key of Object.keys(members))
      if (!KNOWN_MEMBERS.has(key) && members[key] !== undefined)
        lossy.push({
          path: pointer(index, key),
          reason: 'not a policy member this version reads; the file does not carry it',
          policy: policy.id,
        });
    const unenforced = members.unenforced_targets;
    if (Array.isArray(unenforced) && unenforced.length > 0)
      lossy.push({
        path: pointer(index, 'unenforced_targets'),
        reason: `the deployment does not enforce this policy on ${String(unenforced.length)} of its targets today (the tool was removed, or another tool answers to the reference); the file names them as targets, and the target engine enforces it on them`,
        policy: policy.id,
      });
  });
  exported.sort((a, b) => compareCodeUnits(a.policy.id, b.policy.id));
  return { exported, unsupported, lossy };
}

/** Lossy entries every Cedar dialect shares: the approval settings no Cedar engine enforces. */
export function approvalSettingsLossy(
  index: number,
  policy: ExportablePolicy,
  engine: string
): ReportEntry[] {
  const config = policy.config as ToolInvocationConfig;
  const entries: ReportEntry[] = [];
  for (const [member, annotation] of [
    ['on_deny', 'noblecloak_on_deny'],
    ['expires_after', 'noblecloak_expires_after'],
    ['approver_groups', 'noblecloak_approver_groups'],
  ] as const) {
    if (config[member] !== undefined)
      entries.push({
        path: pointer(index, 'config', member),
        reason: `kept in @${annotation} only; ${engine} does not enforce it`,
        policy: policy.id,
      });
  }
  // Rev 16: the members kept verbatim in annotations. With rules, the statement carries only the policy's
  // tightest outcome, so another engine never sees the per-call rules, and NobleCloak asks where a fact of
  // the call has no value (only when some condition is not `exists`). Approvers and exclusions alone are plain approval settings no engine enforces.
  const outcome = encodedOutcome(config);
  for (const [member, annotation] of [
    ['rules', 'noblecloak_rules'],
    ['approvers', 'noblecloak_approvers'],
    ['exclude', 'noblecloak_exclude'],
  ] as const) {
    if (config[member] !== undefined)
      entries.push({
        path: pointer(index, 'config', member),
        reason:
          config.rules === undefined
            ? `kept in @${annotation} only; ${engine} does not enforce it`
            : `kept in @${annotation} only; ${engine} applies only the statement's outcome (${outcome}, the tightest the policy can reach), not the per-call rules${canAskOnMissingFact(config.rules) ? ', and NobleCloak asks where a fact of the call has no value' : ''}`,
        policy: policy.id,
      });
  }
  return entries;
}

/**
 * The clause that says a statement encodes the tightest outcome of a policy's rules rather than its
 * configured mode: empty when the two are the same.
 */
export function outcomeNote(outcome: string, mode: string): string {
  return outcome === mode
    ? ''
    : `; the statement encodes the tightest outcome of the rules, not the configured mode`;
}

/** Refuses a `baseline` other than absent or `allow` (a typo would silently mean no baseline). */
export function checkBaseline(baseline: unknown): void {
  if (baseline !== undefined && baseline !== 'allow')
    throw new PolicyFormatError(
      'invalid_input',
      `baseline is "allow" or absent, not ${JSON.stringify(baseline)}`
    );
}

export function unmatchedNote(baseline: boolean): string {
  return baseline
    ? 'A call no policy forbids is allowed by the baseline statement (@noblecloak_baseline).'
    : 'A call no policy matches is denied by the target engine.';
}

/**
 * Cedar text in the NobleCloak dialect (`schemas/noblecloak.cedarschema`): one statement per policy and
 * subject, statements ordered by policy id, then subject. Every `tool_invocation` form is carried; a plain
 * Cedar engine has no approval outcome, so `ask` and `escalate` are written as a `forbid` (fail closed)
 * marked `@noblecloak_encoding("fail_closed")`, and reported as lossy. The text opens with a comment block
 * stating what the export lost.
 */
export function exportCedar(
  policies: readonly ExportablePolicy[],
  opts: CedarExportOptions = {}
): ExportResult {
  checkBaseline(opts.baseline);
  const { exported, unsupported, lossy } = prepare(policies, NOBLECLOAK);
  let membership = false;
  for (const { index, policy } of exported) {
    const config = policy.config as ToolInvocationConfig;
    const mode = encodedOutcome(config);
    if (mode === 'ask' || mode === 'escalate')
      lossy.push({
        path: pointer(index, 'config', 'mode'),
        reason: `${mode} is exported as a forbid (fail closed): a Cedar engine has no approval outcome, so it denies the call; @noblecloak_mode keeps ${config.mode} for an import${outcomeNote(mode, config.mode)}`,
        policy: policy.id,
      });
    else if (mode === 'not_granted')
      lossy.push({
        path: pointer(index, 'config', 'mode'),
        reason:
          'not_granted is exported as a forbid: a Cedar engine denies the call without the reason not_granted',
        policy: policy.id,
      });
    lossy.push(...approvalSettingsLossy(index, policy, 'a Cedar engine'));
    if (policy.subjects.some((subject) => subject.type === 'role' || subject.type === 'group'))
      membership = true;
  }
  const baseline = opts.baseline === 'allow';
  const notes = [unmatchedNote(baseline)];
  if (membership)
    notes.push(
      "Role and group subjects match through `principal in`: the evaluating engine needs the deployment's membership entities."
    );
  const statements = exported.flatMap(({ policy }) =>
    encodePolicy(policy, {
      dialect: NOBLECLOAK,
      approvalEncoding: 'fail_closed',
      toolId: (ref) => ref,
    })
  );
  if (baseline) statements.push(baselineStatement(NOBLECLOAK));
  const header = headerLines(
    'Cedar, NobleCloak dialect (schemas/noblecloak.cedarschema)',
    notes,
    lossy,
    unsupported
  );
  return {
    text: `${commentBlock('//', header)}${printStatements(statements)}`,
    lossy,
    unsupported,
    notes,
  };
}
