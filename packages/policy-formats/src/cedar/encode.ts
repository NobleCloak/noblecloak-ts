/**
 * NobleCloak `tool_invocation` policy → Cedar statements, one per subject. What Cedar's body can say (the
 * effect, the principal, the tools) is in the body; what it cannot (the exact mode, the name, the approval
 * settings, the rev 16 rules, approvers and exclusions) is in `@noblecloak_*` annotations, which no Cedar
 * engine evaluates. A policy with rules is written as its tightest reachable outcome (`tightestOutcome`).
 */
import canonicalize from 'canonicalize';

import { compareSubjects, normalizePolicy } from '../canonical.js';
import { tightestOutcome } from '../rules.js';
import type { ExportablePolicy, ToolInvocationConfig } from '../types.js';
import { APPROVAL_MODES } from '../validate.js';
import type { Mode } from '../validate.js';
import type { Dialect, EntityRef, Scope, Statement } from './ast.js';

/** The annotations this package writes, in print order. */
export const ANNOTATION = {
  policy: 'noblecloak_policy',
  kind: 'noblecloak_kind',
  mode: 'noblecloak_mode',
  name: 'noblecloak_name',
  description: 'noblecloak_description',
  onDeny: 'noblecloak_on_deny',
  expiresAfter: 'noblecloak_expires_after',
  approverGroups: 'noblecloak_approver_groups',
  approvers: 'noblecloak_approvers',
  exclude: 'noblecloak_exclude',
  rules: 'noblecloak_rules',
  encoding: 'noblecloak_encoding',
  baseline: 'noblecloak_baseline',
  id: 'id',
  advice: 'advice',
} as const;

/** The `@noblecloak_encoding` value that marks an `ask`/`escalate` policy written as a `forbid`. */
export const FAIL_CLOSED = 'fail_closed';

/**
 * The `@noblecloak_encoding` value that marks a policy with `rules`: the statement's body is the tightest
 * outcome of `@noblecloak_mode` and `@noblecloak_rules`, which can differ from the mode. It stands in the
 * one `@noblecloak_encoding` annotation, so it takes the place of `fail_closed` when that outcome is `ask`
 * or `escalate` written as a forbid.
 */
export const RULES_TIGHTEST = 'rules_tightest';

/** The outcome a policy's statement encodes: its mode, or the tightest outcome of its rules. */
export function encodedOutcome(config: ToolInvocationConfig): Mode {
  return tightestOutcome(config.mode, config.rules);
}

/**
 * How an `ask` or `escalate` policy is written: `advice`, a `permit` carrying AGT's `@advice` escalate
 * (an approval on an engine that reads it, an allow on one that does not); `fail_closed`, a `forbid`
 * marked `@noblecloak_encoding("fail_closed")` (denied on every engine).
 */
export type ApprovalEncoding = 'advice' | 'fail_closed';

/**
 * The reason a statement carries, in `@id` (the deny reason on AGT `main`) and in the `@advice` reason
 * (the one string that reaches an AGT approval resolver): `noblecloak.<mode>:<policy key>`, where the
 * policy key is the policy's `id` as given to the export, verbatim.
 */
export function statementReason(mode: string, key: string): string {
  return `noblecloak.${mode}:${key}`;
}

export interface EncodeContext {
  readonly dialect: Dialect;
  readonly approvalEncoding: ApprovalEncoding;
  /** The tool's entity id in this dialect. */
  readonly toolId: (toolRef: string) => string;
}

function jcs(value: unknown): string {
  const text = canonicalize(value);
  /* v8 ignore next -- only called with JSON arrays and objects */
  if (text === undefined) throw new TypeError('value has no JSON form');
  return text;
}

/** The tools of a policy as a resource scope (and a `contains` list for two or more), in canonical order. */
function resourceOf(
  policy: ExportablePolicy,
  context: EncodeContext
): { resource: Scope; resourceIn?: readonly EntityRef[] } {
  const tools = (normalizePolicy(policy).targets as { tools: 'all' | string[] }).tools;
  if (tools === 'all') return { resource: { op: 'All' } };
  const refs = tools.map((ref) => ({ type: context.dialect.toolType, id: context.toolId(ref) }));
  const [only] = refs;
  return refs.length === 1 && only !== undefined
    ? { resource: { op: '==', entity: only } }
    : { resource: { op: 'All' }, resourceIn: refs };
}

/**
 * The statements of one valid `tool_invocation` policy whose every subject the dialect can express,
 * subjects in canonical order (type, then id).
 */
export function encodePolicy(policy: ExportablePolicy, context: EncodeContext): Statement[] {
  const config = policy.config as ToolInvocationConfig;
  const key = policy.id;
  const outcome = encodedOutcome(config);
  const approval = APPROVAL_MODES.includes(outcome);
  const effect =
    outcome === 'always_allow' || (approval && context.approvalEncoding === 'advice')
      ? 'permit'
      : 'forbid';
  const annotations: [string, string][] = [
    [ANNOTATION.policy, key],
    [ANNOTATION.kind, 'tool_invocation'],
    [ANNOTATION.mode, config.mode],
  ];
  if (policy.name !== undefined) annotations.push([ANNOTATION.name, policy.name]);
  if (policy.description !== undefined)
    annotations.push([ANNOTATION.description, policy.description]);
  if (config.on_deny !== undefined) annotations.push([ANNOTATION.onDeny, config.on_deny]);
  if (config.expires_after !== undefined)
    annotations.push([ANNOTATION.expiresAfter, config.expires_after]);
  if (config.approver_groups !== undefined)
    annotations.push([ANNOTATION.approverGroups, jcs(config.approver_groups)]);
  if (config.approvers !== undefined)
    annotations.push([ANNOTATION.approvers, jcs(config.approvers)]);
  if (config.exclude !== undefined) annotations.push([ANNOTATION.exclude, jcs(config.exclude)]);
  if (config.rules !== undefined) {
    annotations.push([ANNOTATION.rules, jcs(config.rules)]);
    annotations.push([ANNOTATION.encoding, RULES_TIGHTEST]);
  } else if (approval && effect === 'forbid') annotations.push([ANNOTATION.encoding, FAIL_CLOSED]);
  const reason = statementReason(outcome, key);
  annotations.push([ANNOTATION.id, reason]);
  if (approval && effect === 'permit')
    annotations.push([ANNOTATION.advice, jcs({ reason, verdict: 'escalate' })]);
  const { resource, resourceIn } = resourceOf(policy, context);
  const action: Scope = { op: '==', entity: context.dialect.action };
  return [...policy.subjects].sort(compareSubjects).map((subject) => {
    const principal = context.dialect.subjectScope(subject);
    /* v8 ignore next -- the export reports and skips a policy with a subject the dialect cannot express */
    if (principal === undefined) throw new TypeError(`no principal for subject ${subject.type}`);
    return {
      annotations,
      effect,
      principal,
      action,
      resource,
      ...(resourceIn === undefined ? {} : { resourceIn }),
    };
  });
}

/** The statement `opts.baseline: "allow"` adds: a permit for every principal and tool, so a call no forbid matches is allowed. */
export function baselineStatement(dialect: Dialect): Statement {
  return {
    annotations: [[ANNOTATION.baseline, 'allow']],
    effect: 'permit',
    principal: { op: 'All' },
    action: { op: '==', entity: dialect.action },
    resource: { op: 'All' },
  };
}
