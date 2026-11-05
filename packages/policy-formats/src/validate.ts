import { compareSubjects } from './canonical.js';
import { pointer, quote, show } from './pointer.js';
import type { PolicyWrite } from './types.js';

export const MODES = ['always_allow', 'ask', 'escalate', 'deny', 'not_granted'] as const;
export type Mode = (typeof MODES)[number];
/** The modes that need an approval, the only ones `on_deny`, `expires_after` and `approver_groups` apply to. */
export const APPROVAL_MODES: readonly Mode[] = ['ask', 'escalate'];
export const PRINCIPAL_KINDS = ['user', 'agent', 'service', 'group', 'role'] as const;
const CONFIG_MEMBERS = [
  'mode',
  'on_deny',
  'expires_after',
  'approver_groups',
  'rules',
  'approvers',
  'exclude',
];
const MAX_RULES = 32;
const MAX_APPROVERS = 32;
const MAX_CONDITIONS = 8;
const MAX_IN_VALUES = 100;
const FACT_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const CONDITION_OPS = ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'exists'];
const RULE_OUTCOMES = ['always_allow', 'ask', 'deny'];
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
 * What makes a policy something other than a valid `tool_invocation` policy (contract rev 16): its kind, the
 * `PolicyWrite` schema (subjects, targets, name and description limits), the `ToolInvocationConfig`
 * schema and its legality matrix (`on_deny`, `expires_after` and `approver_groups` only with `ask` or
 * `escalate`; rev 16 `rules`, `approvers` and `exclude` with every mode, as the contract's schemas shape
 * them), and strings Cedar cannot represent. Empty when it is one.
 */
export function toolInvocationProblems(policy: PolicyWrite): Problem[] {
  if (policy.kind !== 'tool_invocation') {
    return [
      {
        path: '/kind',
        reason:
          policy.kind === 'approval_routing'
            ? 'kind "approval_routing" has no Cedar or AGT form: it is an organisation setting for who may satisfy approvals, not a policy on a call; only tool_invocation policies convert'
            : `kind ${show(policy.kind)} has no Cedar form; only tool_invocation policies convert`,
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
  if (members.rules !== undefined) problems.push(...rulesProblems(members.rules, '/config/rules'));
  if (members.approvers !== undefined)
    problems.push(...approversProblems(members.approvers, '/config/approvers'));
  if (members.exclude !== undefined) problems.push(...excludeProblems(members.exclude));
  return problems;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Members of an object outside `allowed`, as problems (a file cannot carry what this version does not read). */
function extraMembers(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): Problem[] {
  return Object.keys(value)
    .filter((key) => value[key] !== undefined && !allowed.includes(key))
    .map((key) => ({
      path: `${path}${pointer(key)}`,
      reason: `${quote(key)} is not a member here`,
    }));
}

/** Every string below a JSON value that holds an unpaired surrogate, as problems. */
function surrogateProblems(value: unknown, path: string): Problem[] {
  if (typeof value === 'string') return stringProblem(path, value);
  if (Array.isArray(value))
    return (value as unknown[]).flatMap((element, index) =>
      surrogateProblems(element, `${path}${pointer(index)}`)
    );
  if (isObject(value))
    return Object.entries(value).flatMap(([key, member]) => [
      ...stringProblem(`${path}${pointer(key)}`, key),
      ...surrogateProblems(member, `${path}${pointer(key)}`),
    ]);
  return [];
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function conditionProblems(condition: unknown, path: string): Problem[] {
  if (!isObject(condition)) return [{ path, reason: 'a condition is an object' }];
  const problems = extraMembers(condition, ['fact', 'op', 'value'], path);
  const { fact, op, value } = condition;
  if (typeof fact !== 'string' || !FACT_NAME.test(fact))
    problems.push({
      path: `${path}/fact`,
      reason:
        'fact is a fact name: a lowercase letter, then up to 62 lowercase letters, digits or _',
    });
  if (typeof op !== 'string' || !CONDITION_OPS.includes(op)) {
    problems.push({ path: `${path}/op`, reason: `op is one of ${CONDITION_OPS.join(', ')}` });
    return problems;
  }
  if (op === 'exists') {
    if (value !== undefined)
      problems.push({ path: `${path}/value`, reason: 'exists takes no value' });
  } else if (op === 'in' || op === 'not_in') {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > MAX_IN_VALUES ||
      !(value as unknown[]).every(isScalar)
    )
      problems.push({
        path: `${path}/value`,
        reason: `${op} takes a list of 1 to ${String(MAX_IN_VALUES)} scalars (string, number, boolean or null)`,
      });
    else problems.push(...surrogateProblems(value, `${path}/value`));
  } else if (op === 'eq' || op === 'ne') {
    if (!isScalar(value))
      problems.push({
        path: `${path}/value`,
        reason: `${op} takes a scalar value (string, number, boolean or null)`,
      });
    else problems.push(...surrogateProblems(value, `${path}/value`));
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push({ path: `${path}/value`, reason: `${op} takes a number` });
  }
  return problems;
}

function conditionsProblems(conditions: unknown, path: string): Problem[] {
  if (!Array.isArray(conditions) || conditions.length < 1 || conditions.length > MAX_CONDITIONS)
    return [{ path, reason: `when is an array of 1 to ${String(MAX_CONDITIONS)} conditions` }];
  return (conditions as unknown[]).flatMap((condition, index) =>
    conditionProblems(condition, `${path}${pointer(index)}`)
  );
}

export function approversProblems(approvers: unknown, path: string): Problem[] {
  if (!Array.isArray(approvers) || approvers.length < 1 || approvers.length > MAX_APPROVERS)
    return [{ path, reason: `approvers is an array of 1 to ${String(MAX_APPROVERS)} entries` }];
  return (approvers as unknown[]).flatMap((entry, index) => {
    const at = `${path}${pointer(index)}`;
    if (!isObject(entry)) return [{ path: at, reason: 'an approver is { role } or { user }' }];
    const problems = extraMembers(entry, ['role', 'user', 'when'], at);
    const named = ['role', 'user'].filter((key) => entry[key] !== undefined);
    const [only] = named;
    if (named.length !== 1 || only === undefined)
      problems.push({
        path: at,
        reason: 'an approver is { role } or { user }, not both or neither',
      });
    else {
      const id = entry[only];
      if (typeof id !== 'string' || id.length === 0)
        problems.push({ path: `${at}/${only}`, reason: `${only} is a non-empty string` });
      else problems.push(...stringProblem(`${at}/${only}`, id));
    }
    if (entry.when !== undefined) problems.push(...conditionsProblems(entry.when, `${at}/when`));
    return problems;
  });
}

export function rulesProblems(rules: unknown, path: string): Problem[] {
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > MAX_RULES)
    return [{ path, reason: `rules is an array of 1 to ${String(MAX_RULES)} rules` }];
  return (rules as unknown[]).flatMap((rule, index) => {
    const at = `${path}${pointer(index)}`;
    if (!isObject(rule)) return [{ path: at, reason: 'a rule is { when, then, approvers? }' }];
    const problems = extraMembers(rule, ['when', 'then', 'approvers'], at);
    problems.push(...conditionsProblems(rule.when, `${at}/when`));
    if (typeof rule.then !== 'string' || !RULE_OUTCOMES.includes(rule.then))
      problems.push({ path: `${at}/then`, reason: `then is one of ${RULE_OUTCOMES.join(', ')}` });
    if (rule.approvers !== undefined) {
      if (rule.then !== 'ask')
        problems.push({
          path: `${at}/approvers`,
          reason: 'approvers applies only to a rule whose then is ask',
        });
      else problems.push(...approversProblems(rule.approvers, `${at}/approvers`));
    }
    return problems;
  });
}

/** `exclude` is the one-entry list `["requester"]`: the schema's enum has one value and the list is unique. */
export function excludeProblems(exclude: unknown, path = '/config/exclude'): Problem[] {
  return Array.isArray(exclude) && exclude.length === 1 && exclude[0] === 'requester'
    ? []
    : [{ path, reason: 'exclude is ["requester"]' }];
}
