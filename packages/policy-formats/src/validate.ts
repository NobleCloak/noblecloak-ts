import { compareSubjects } from './canonical.js';
import { pointer, quote, show } from './pointer.js';
import type { PolicyWrite } from './types.js';

export const MODES = ['always_allow', 'ask', 'escalate', 'deny', 'not_granted'] as const;
export type Mode = (typeof MODES)[number];
/** The modes that need an approval, the only ones `on_deny`, `expires_after` and `approver_groups` apply to. */
export const APPROVAL_MODES: readonly Mode[] = ['ask', 'escalate'];
export const PRINCIPAL_KINDS = ['user', 'agent', 'service', 'group', 'role'] as const;
const CONFIG_MEMBERS = ['mode', 'on_deny', 'expires_after', 'approver_groups'];
const MAX_TOOLS = 100;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;
const LIMIT = {
  tools: String(MAX_TOOLS),
  name: String(MAX_NAME),
  description: String(MAX_DESCRIPTION),
};

/** A string's length as JSON Schema's maxLength counts it: in code points, not UTF-16 units. */
function codePoints(value: string): number {
  // Each surrogate pair is one code point in two UTF-16 units.
  return value.length - (value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);
}

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/** A string JavaScript holds and Cedar and YAML cannot: one with an unpaired UTF-16 surrogate. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function hasLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE.test(value);
}

export interface Problem {
  /** JSON pointer below the policy. */
  readonly path: string;
  readonly reason: string;
}

function stringProblem(path: string, value: string): Problem[] {
  return hasLoneSurrogate(value)
    ? [{ path, reason: 'holds an unpaired UTF-16 surrogate, which Cedar cannot represent' }]
    : [];
}

/**
 * What makes a policy something other than a valid rev 10 `tool_invocation` policy: its kind, the
 * `PolicyWrite` schema (subjects, targets, name and description limits), the `ToolInvocationConfig`
 * schema and its legality matrix (`on_deny`, `expires_after` and `approver_groups` only with `ask` or
 * `escalate`), and strings Cedar cannot represent. Empty when it is one.
 */
export function toolInvocationProblems(policy: PolicyWrite): Problem[] {
  if (policy.kind !== 'tool_invocation') {
    return [
      {
        path: '/kind',
        reason: `kind ${show(policy.kind)} has no Cedar form; only tool_invocation policies convert`,
      },
    ];
  }
  const problems: Problem[] = [];
  if (policy.name !== undefined) {
    if (
      typeof policy.name !== 'string' ||
      codePoints(policy.name) < 1 ||
      codePoints(policy.name) > MAX_NAME
    )
      problems.push({
        path: '/name',
        reason: `name must be a string of 1 to ${LIMIT.name} characters`,
      });
    else problems.push(...stringProblem('/name', policy.name));
  }
  if (policy.description !== undefined) {
    if (typeof policy.description !== 'string' || codePoints(policy.description) > MAX_DESCRIPTION)
      problems.push({
        path: '/description',
        reason: `description must be a string of at most ${LIMIT.description} characters`,
      });
    else problems.push(...stringProblem('/description', policy.description));
  }
  problems.push(...subjectProblems(policy), ...targetProblems(policy), ...configProblems(policy));
  return problems;
}

function subjectProblems(policy: PolicyWrite): Problem[] {
  const subjects: unknown = policy.subjects;
  if (!Array.isArray(subjects) || subjects.length === 0)
    return [{ path: '/subjects', reason: 'a policy needs at least one subject' }];
  const problems: Problem[] = [];
  subjects.forEach((subject: unknown, index) => {
    const path = pointer('subjects', index);
    if (typeof subject !== 'object' || subject === null) {
      problems.push({ path, reason: 'a subject is an object' });
      return;
    }
    const { type, id, ...rest } = subject as { type?: unknown; id?: unknown };
    const extra = Object.keys(rest);
    if (type === 'organization') {
      if (id !== undefined || extra.length > 0)
        problems.push({ path, reason: 'the organization subject has no other member' });
    } else if (
      typeof type !== 'string' ||
      !(PRINCIPAL_KINDS as readonly string[]).includes(type) ||
      typeof id !== 'string' ||
      extra.length > 0
    ) {
      problems.push({
        path,
        reason:
          'a subject is { type: user|agent|service|group|role, id } or { type: organization }',
      });
    } else {
      problems.push(...stringProblem(`${path}/id`, id));
    }
  });
  if (problems.length > 0) return problems;
  const sorted = [...policy.subjects].sort(compareSubjects);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous !== undefined && current !== undefined && compareSubjects(previous, current) === 0)
      return [{ path: '/subjects', reason: 'subjects must be unique' }];
  }
  return [];
}

function targetProblems(policy: PolicyWrite): Problem[] {
  const targets: unknown = policy.targets;
  if (targets === undefined) return [];
  if (typeof targets !== 'object' || targets === null)
    return [{ path: '/targets', reason: 'targets is an object' }];
  const extra = Object.keys(targets).filter(
    (key) => key !== 'tools' && (targets as Record<string, unknown>)[key] !== undefined
  );
  if (extra.length > 0)
    return extra.map((key) => ({
      path: pointer('targets', key),
      reason: `${quote(key)} is not a targets member; a file cannot carry what it would narrow`,
    }));
  const tools: unknown = (targets as { tools?: unknown }).tools;
  if (tools === 'all') return [];
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > MAX_TOOLS)
    return [
      {
        path: '/targets/tools',
        reason: `targets.tools is "all" or an array of 1 to ${LIMIT.tools} tool_refs`,
      },
    ];
  const problems: Problem[] = [];
  tools.forEach((tool: unknown, index) => {
    const path = pointer('targets', 'tools', index);
    if (typeof tool !== 'string' || tool.length === 0)
      problems.push({ path, reason: 'a tool_ref is a non-empty string' });
    else problems.push(...stringProblem(path, tool));
  });
  return problems;
}

function configProblems(policy: PolicyWrite): Problem[] {
  const config: unknown = policy.config;
  if (typeof config !== 'object' || config === null)
    return [{ path: '/config', reason: 'config is an object' }];
  const members = config as Record<string, unknown>;
  const problems: Problem[] = [];
  for (const key of Object.keys(members)) {
    if (members[key] !== undefined && !CONFIG_MEMBERS.includes(key))
      problems.push({
        path: pointer('config', key),
        reason: `${quote(key)} is not a tool_invocation config member`,
      });
  }
  const mode = members.mode;
  if (!isMode(mode)) {
    problems.push({ path: '/config/mode', reason: `mode is one of ${MODES.join(', ')}` });
    return problems;
  }
  const approval = APPROVAL_MODES.includes(mode);
  const { on_deny: onDeny, expires_after: expiresAfter, approver_groups: groups } = members;
  const illegal = (name: string): Problem => ({
    path: pointer('config', name),
    reason: `${name} applies only to ask and escalate, not to ${mode}`,
  });
  if (onDeny !== undefined) {
    if (!approval) problems.push(illegal('on_deny'));
    else if (onDeny !== 'resume' && onDeny !== 'halt')
      problems.push({ path: '/config/on_deny', reason: 'on_deny is resume or halt' });
  }
  if (expiresAfter !== undefined) {
    if (!approval) problems.push(illegal('expires_after'));
    else if (typeof expiresAfter !== 'string')
      problems.push({ path: '/config/expires_after', reason: 'expires_after is a string' });
    else problems.push(...stringProblem('/config/expires_after', expiresAfter));
  }
  if (groups !== undefined) {
    if (!approval) problems.push(illegal('approver_groups'));
    else if (!Array.isArray(groups) || groups.some((group) => typeof group !== 'string'))
      problems.push({
        path: '/config/approver_groups',
        reason: 'approver_groups is an array of strings',
      });
    else
      (groups as string[]).forEach((group, index) => {
        problems.push(...stringProblem(pointer('config', 'approver_groups', index), group));
      });
  }
  return problems;
}
