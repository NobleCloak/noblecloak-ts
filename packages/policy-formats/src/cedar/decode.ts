/**
 * Cedar statements (cedar-wasm's JSON policy format) → NobleCloak `tool_invocation` policies.
 *
 * The body is authoritative for what Cedar says (the effect, the principal, the tools); `@noblecloak_*`
 * annotations supply only what Cedar cannot. A statement whose body and annotations disagree is a
 * conflict, and nothing of it is imported, so an edited body is never overridden by a stale annotation.
 * The one sanctioned difference is `@noblecloak_encoding("fail_closed")`: an `ask` or `escalate` policy
 * written as a `forbid` for an engine that has no approval outcome.
 *
 * A policy is imported whole or not at all: when any statement of a policy key is unsupported or in
 * conflict, none of that key's statements is imported, and each is reported.
 */
import canonicalize from 'canonicalize';

import { pointer, quote, show } from '../pointer.js';
import type { PolicySubject, PolicyWrite, ReportEntry, ToolInvocationConfig } from '../types.js';
import { APPROVAL_MODES, isMode, toolInvocationProblems } from '../validate.js';
import type { Mode } from '../validate.js';
import type { Dialect, EntityRef, Scope } from './ast.js';
import { ANNOTATION, FAIL_CLOSED, statementReason } from './encode.js';
import type { ApprovalEncoding } from './encode.js';

/** Resolves a tool entity id to a `tool_ref`, with a lossy entry when the mapping is not exact. */
export type ToolResolver = (id: string, path: string) => { ref: string; lossy?: ReportEntry };

export const IDENTITY_TOOLS: ToolResolver = (id) => ({ ref: id });

interface Fields {
  readonly name?: string;
  readonly description?: string;
  readonly config: ToolInvocationConfig;
  readonly tools: 'all' | readonly string[];
}

type Decoded =
  | { readonly type: 'baseline'; readonly lossy: readonly ReportEntry[] }
  | {
      readonly type: 'policy';
      readonly key: string | undefined;
      readonly subject: PolicySubject;
      readonly fields: Fields;
      readonly encoding: ApprovalEncoding | undefined;
      readonly lossy: readonly ReportEntry[];
    }
  | {
      readonly type: 'rejected';
      readonly key: string | undefined;
      readonly bucket: 'unsupported' | 'conflicts';
      readonly entries: readonly ReportEntry[];
    };

const NOBLECLOAK_PREFIX = 'noblecloak_';
const KNOWN_NOBLECLOAK = new Set<string>([
  ANNOTATION.policy,
  ANNOTATION.kind,
  ANNOTATION.mode,
  ANNOTATION.name,
  ANNOTATION.description,
  ANNOTATION.onDeny,
  ANNOTATION.expiresAfter,
  ANNOTATION.approverGroups,
  ANNOTATION.encoding,
  ANNOTATION.baseline,
]);
const POLICY_LEVEL = [...KNOWN_NOBLECLOAK].filter((key) => key !== ANNOTATION.baseline);
const ADVICE_REASON = /^noblecloak\.(ask|escalate):([\s\S]*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEntity(value: unknown): EntityRef | undefined {
  const inner = isRecord(value) && isRecord(value.__entity) ? value.__entity : value;
  return isRecord(inner) && typeof inner.type === 'string' && typeof inner.id === 'string'
    ? { type: inner.type, id: inner.id }
    : undefined;
}

/** A scope in the subset (`All`, `==` or `in` one entity), or undefined. */
function readScope(value: unknown): Scope | undefined {
  if (!isRecord(value)) return undefined;
  if (value.op === 'All') return { op: 'All' };
  if ((value.op === '==' || value.op === 'in') && value.entity !== undefined) {
    const ref = readEntity(value.entity);
    if (ref !== undefined) return { op: value.op, entity: ref };
  }
  return undefined;
}

/** The tool entities of `[E1, E2, ...].contains(resource)`, or undefined for any other expression. */
function readResourceIn(body: unknown): EntityRef[] | undefined {
  if (!isRecord(body) || !isRecord(body.contains)) return undefined;
  const { left, right } = body.contains;
  if (!isRecord(right) || right.Var !== 'resource') return undefined;
  if (!isRecord(left) || !Array.isArray(left.Set) || left.Set.length === 0) return undefined;
  const refs: EntityRef[] = [];
  for (const element of left.Set as unknown[]) {
    const ref = isRecord(element) ? readEntity(element.Value) : undefined;
    if (ref === undefined) return undefined;
    refs.push(ref);
  }
  return refs;
}

function sameEntity(a: EntityRef, b: EntityRef): boolean {
  return a.type === b.type && a.id === b.id;
}

/**
 * Whether an action scope stands for the dialect's one action: unconstrained, `==` it, or `in` it (alone or
 * in a list of it alone). The dialect declares no action group, so `in` the action is the action.
 */
function isDialectAction(value: unknown, dialect: Dialect): boolean {
  if (!isRecord(value)) return false;
  if (value.op === 'All') return true;
  if (value.op === '==' || (value.op === 'in' && value.entity !== undefined)) {
    const ref = readEntity(value.entity);
    return ref !== undefined && sameEntity(ref, dialect.action);
  }
  if (value.op === 'in' && Array.isArray(value.entities) && value.entities.length > 0)
    return (value.entities as unknown[]).every((entity) => {
      const ref = readEntity(entity);
      return ref !== undefined && sameEntity(ref, dialect.action);
    });
  return false;
}

interface Body {
  readonly subject: PolicySubject;
  readonly toolIds: 'all' | readonly string[];
}

/** The subject and tools of a statement's body, or the reasons it is outside the subset. */
function readBody(
  est: Record<string, unknown>,
  path: string,
  dialect: Dialect
): { body: Body } | { problems: ReportEntry[] } {
  const problems: ReportEntry[] = [];
  const principal = readScope(est.principal);
  const subject = principal === undefined ? undefined : dialect.subjectOf(principal);
  if (subject === undefined)
    problems.push({
      path: `${path}/principal`,
      reason: `the principal is not one ${dialect.label} writes for a NobleCloak subject`,
    });
  if (!isDialectAction(est.action, dialect))
    problems.push({
      path: `${path}/action`,
      reason: `the action is not ${dialect.action.type}::${quote(dialect.action.id)}`,
    });
  const resource = readScope(est.resource);
  let toolIds: 'all' | string[] | undefined;
  if (
    resource === undefined ||
    resource.op === 'in' ||
    (resource.op === '==' && resource.entity.type !== dialect.toolType)
  ) {
    problems.push({
      path: `${path}/resource`,
      reason: `the resource is not unconstrained or == one ${dialect.toolType}`,
    });
  } else {
    toolIds = resource.op === 'All' ? 'all' : [resource.entity.id];
  }
  const conditions = Array.isArray(est.conditions) ? (est.conditions as unknown[]) : [];
  conditions.forEach((condition, index) => {
    const refs =
      isRecord(condition) && condition.kind === 'when' && index === 0
        ? readResourceIn(condition.body)
        : undefined;
    if (
      refs !== undefined &&
      conditions.length === 1 &&
      toolIds === 'all' &&
      refs.every((ref) => ref.type === dialect.toolType)
    ) {
      toolIds = refs.map((ref) => ref.id);
    } else {
      problems.push({
        path: `${path}/conditions/${String(index)}`,
        reason: `a condition other than one when { [${dialect.toolType}::...].contains(resource) } on an unconstrained resource has no NobleCloak form`,
      });
    }
  });
  if (problems.length > 0 || subject === undefined || toolIds === undefined) return { problems };
  return { body: { subject, toolIds } };
}

interface Advice {
  readonly mode?: 'ask' | 'escalate';
  readonly key?: string;
  readonly reason?: string;
  readonly message?: string;
}

/** The members AGT's advice schema allows; it fails any other closed. */
const ADVICE_MEMBERS = new Set(['verdict', 'reason', 'message', 'transform']);

/** `@advice` read as AGT's advice: escalate only; returns a problem for anything else. */
function readAdvice(text: string, path: string): Advice | ReportEntry {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { path, reason: '@advice is not JSON' };
  }
  if (!isRecord(value) || value.verdict !== 'escalate') {
    const verdict = isRecord(value) ? value.verdict : undefined;
    return {
      path,
      reason: `@advice with verdict ${show(verdict)} has no NobleCloak form; only escalate does`,
    };
  }
  for (const member of Object.keys(value))
    if (!ADVICE_MEMBERS.has(member) || member === 'transform')
      return {
        path,
        reason: `@advice member ${quote(member)} is not one an escalate advice may carry; AGT fails it closed`,
      };
  const { reason, message } = value;
  if (
    (reason !== undefined && reason !== null && typeof reason !== 'string') ||
    (message !== undefined && message !== null && typeof message !== 'string')
  )
    return { path, reason: '@advice reason and message are strings; AGT fails any other closed' };
  const withMessage = typeof message === 'string' ? { message } : {};
  if (typeof reason !== 'string') return withMessage;
  const match = ADVICE_REASON.exec(reason);
  return match === null
    ? { reason, ...withMessage }
    : { mode: match[1] as 'ask' | 'escalate', key: match[2] ?? '', reason, ...withMessage };
}

/**
 * The mode a statement stands for, from its effect, `@noblecloak_mode`, `@noblecloak_encoding` and
 * `@advice`, or the conflict when they disagree.
 */
function readMode(
  effect: 'permit' | 'forbid',
  mode: string | undefined,
  encoding: string | undefined,
  advice: Advice | undefined,
  path: string
): { mode: Mode; encoding?: ApprovalEncoding } | { conflict: ReportEntry } {
  const conflict = (reason: string): { conflict: ReportEntry } => ({ conflict: { path, reason } });
  if (mode !== undefined && !isMode(mode))
    return conflict(`@noblecloak_mode ${quote(mode)} is not a mode`);
  if (effect === 'permit') {
    if (encoding !== undefined)
      return conflict('@noblecloak_encoding("fail_closed") is on a permit');
    if (advice === undefined) {
      return mode === undefined || mode === 'always_allow'
        ? { mode: 'always_allow' }
        : conflict(`the body permits the call and @noblecloak_mode says ${mode}`);
    }
    const resolved = mode ?? advice.mode ?? 'ask';
    if (!APPROVAL_MODES.includes(resolved))
      return conflict(`@advice escalate is on a policy whose @noblecloak_mode is ${resolved}`);
    if (advice.mode !== undefined && advice.mode !== resolved)
      return conflict(
        `the @advice reason names ${advice.mode} and @noblecloak_mode says ${resolved}`
      );
    return { mode: resolved, encoding: 'advice' };
  }
  if (advice !== undefined) return conflict('@advice is on a forbid, where no engine reads it');
  if (mode === undefined || mode === 'deny' || mode === 'not_granted') {
    return encoding === undefined
      ? { mode: mode ?? 'deny' }
      : conflict(`@noblecloak_encoding is on a ${mode ?? 'deny'} policy`);
  }
  if (mode === 'always_allow')
    return conflict('the body forbids the call and @noblecloak_mode says always_allow');
  if (encoding !== FAIL_CLOSED)
    return conflict(
      `the body forbids the call and @noblecloak_mode says ${mode}, without @noblecloak_encoding("fail_closed")`
    );
  return { mode, encoding: 'fail_closed' };
}

function annotationsOf(est: Record<string, unknown>): Map<string, string> | undefined {
  const raw = est.annotations ?? {};
  if (!isRecord(raw)) return undefined;
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    // A bare `@key` has the value "" in Cedar; the JSON format writes it as null.
    if (value === null) out.set(key, '');
    else if (typeof value === 'string') out.set(key, value);
    else return undefined;
  }
  return out;
}

/** One statement, classified. `path` is the statement's JSON pointer. */
export function decodeStatement(
  json: unknown,
  path: string,
  dialect: Dialect,
  resolveTool: ToolResolver
): Decoded {
  const reject = (
    bucket: 'unsupported' | 'conflicts',
    entries: readonly ReportEntry[],
    key: string | undefined
  ): Decoded => ({
    type: 'rejected',
    key,
    bucket,
    entries: key === undefined ? entries : entries.map((entry) => ({ ...entry, policy: key })),
  });
  const annotations = isRecord(json) ? annotationsOf(json) : undefined;
  if (
    !isRecord(json) ||
    annotations === undefined ||
    (json.effect !== 'permit' && json.effect !== 'forbid')
  )
    return reject(
      'unsupported',
      [{ path, reason: 'not a Cedar policy in the JSON policy format' }],
      undefined
    );
  const effect = json.effect;
  const at = (name: string): string => `${path}${pointer('annotations', name)}`;
  const key = annotations.get(ANNOTATION.policy);
  if (key === '')
    return reject(
      'unsupported',
      [{ path: at(ANNOTATION.policy), reason: '@noblecloak_policy is empty' }],
      undefined
    );

  const unknown = [...annotations.keys()].filter(
    (name) => name.startsWith(NOBLECLOAK_PREFIX) && !KNOWN_NOBLECLOAK.has(name)
  );
  if (unknown.length > 0)
    return reject(
      'unsupported',
      unknown.map((name) => ({
        path: at(name),
        reason: `@${name} is not an annotation this version of the format reads`,
      })),
      key
    );

  if (annotations.has(ANNOTATION.baseline))
    return decodeBaseline(json, annotations, dialect, at, key);

  const read = readBody(json, path, dialect);
  if ('problems' in read) return reject('unsupported', read.problems, key);

  const problems: ReportEntry[] = [];
  const kind = annotations.get(ANNOTATION.kind);
  if (kind !== undefined && kind !== 'tool_invocation')
    problems.push({
      path: at(ANNOTATION.kind),
      reason: `kind ${quote(kind)} has no Cedar form; only tool_invocation does`,
    });
  let advice: Advice | undefined;
  const adviceText = annotations.get(ANNOTATION.advice);
  if (adviceText !== undefined) {
    const parsed = readAdvice(adviceText, at(ANNOTATION.advice));
    if ('path' in parsed) problems.push(parsed);
    else advice = parsed;
  }
  let approverGroups: string[] | undefined;
  const groupsText = annotations.get(ANNOTATION.approverGroups);
  if (groupsText !== undefined) {
    let groups: unknown;
    try {
      groups = JSON.parse(groupsText);
    } catch {
      groups = undefined;
    }
    if (Array.isArray(groups) && groups.every((group) => typeof group === 'string'))
      approverGroups = groups;
    else
      problems.push({
        path: at(ANNOTATION.approverGroups),
        reason: '@noblecloak_approver_groups is not a JSON array of strings',
      });
  }
  const onDenyText = annotations.get(ANNOTATION.onDeny);
  const onDeny = onDenyText === 'resume' || onDenyText === 'halt' ? onDenyText : undefined;
  if (onDenyText !== undefined && onDeny === undefined)
    problems.push({ path: at(ANNOTATION.onDeny), reason: '@noblecloak_on_deny is resume or halt' });
  if (problems.length > 0) return reject('unsupported', problems, key);

  const decided = readMode(
    effect,
    annotations.get(ANNOTATION.mode),
    annotations.get(ANNOTATION.encoding),
    advice,
    path
  );
  if ('conflict' in decided) return reject('conflicts', [decided.conflict], key);
  const { mode } = decided;
  const lossy: ReportEntry[] = [];
  const conflicts: ReportEntry[] = [];
  if (key !== undefined) {
    const expected = statementReason(mode, key);
    const id = annotations.get(ANNOTATION.id);
    if (id !== undefined && id !== expected)
      conflicts.push({ path: at(ANNOTATION.id), reason: `@id is not ${quote(expected)}` });
    if (advice?.key !== undefined && advice.key !== key)
      conflicts.push({
        path: at(ANNOTATION.advice),
        reason: `the @advice reason names policy ${quote(advice.key)}, not ${quote(key)}`,
      });
  }
  if (conflicts.length > 0) return reject('conflicts', conflicts, key);

  for (const name of annotations.keys()) {
    if (KNOWN_NOBLECLOAK.has(name) || name === ANNOTATION.advice) continue;
    if (name === ANNOTATION.id && key !== undefined) continue;
    lossy.push({ path: at(name), reason: `annotation @${name} is not kept` });
  }
  if (advice !== undefined) {
    const modeAnnotated = annotations.has(ANNOTATION.mode);
    if (advice.mode === undefined && (advice.reason !== undefined || !modeAnnotated))
      lossy.push({
        path: at(ANNOTATION.advice),
        reason:
          advice.reason === undefined
            ? `an escalate advice is imported as ${mode}`
            : `an escalate advice is imported as ${mode}; its reason ${quote(advice.reason)} is not kept`,
      });
    if (advice.key !== undefined && key === undefined)
      lossy.push({
        path: at(ANNOTATION.advice),
        reason: `the @advice reason names policy ${quote(advice.key)}, but the statement has no @noblecloak_policy: it imports as a policy of its own, without that key`,
      });
    if (advice.message !== undefined)
      lossy.push({
        path: at(ANNOTATION.advice),
        reason: `the @advice message ${quote(advice.message)} is not kept`,
      });
  }

  const tools =
    read.body.toolIds === 'all'
      ? ('all' as const)
      : read.body.toolIds.map((id, index) => {
          const resolved = resolveTool(
            id,
            read.body.toolIds.length === 1
              ? `${path}/resource`
              : `${path}/conditions/0/${String(index)}`
          );
          if (resolved.lossy !== undefined) lossy.push(resolved.lossy);
          return resolved.ref;
        });
  const config: ToolInvocationConfig = {
    mode,
    ...(onDeny === undefined ? {} : { on_deny: onDeny }),
    ...(annotations.has(ANNOTATION.expiresAfter)
      ? { expires_after: annotations.get(ANNOTATION.expiresAfter) ?? '' }
      : {}),
    ...(approverGroups === undefined ? {} : { approver_groups: approverGroups }),
  };
  const name = annotations.get(ANNOTATION.name);
  const description = annotations.get(ANNOTATION.description);
  return {
    type: 'policy',
    key,
    subject: read.body.subject,
    fields: {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      config,
      tools,
    },
    encoding: decided.encoding,
    lossy: key === undefined ? lossy : lossy.map((entry) => ({ ...entry, policy: key })),
  };
}

function decodeBaseline(
  est: Record<string, unknown>,
  annotations: Map<string, string>,
  dialect: Dialect,
  at: (name: string) => string,
  key: string | undefined
): Decoded {
  const others = [...annotations.keys()].filter(
    (name) =>
      name !== ANNOTATION.baseline && (POLICY_LEVEL.includes(name) || name === ANNOTATION.advice)
  );
  const plain =
    annotations.get(ANNOTATION.baseline) === 'allow' &&
    est.effect === 'permit' &&
    readScope(est.principal)?.op === 'All' &&
    readScope(est.resource)?.op === 'All' &&
    isDialectAction(est.action, dialect) &&
    (!Array.isArray(est.conditions) || est.conditions.length === 0) &&
    others.length === 0;
  return plain
    ? {
        type: 'baseline',
        lossy: [...annotations.keys()]
          .filter((name) => name !== ANNOTATION.baseline)
          .map((name) => ({ path: at(name), reason: `annotation @${name} is not kept` })),
      }
    : {
        type: 'rejected',
        // A baseline marker on a statement of a policy holds the whole policy back.
        key,
        bucket: 'unsupported',
        entries: [
          {
            ...(key === undefined ? {} : { policy: key }),
            path: at(ANNOTATION.baseline),
            reason:
              '@noblecloak_baseline("allow") marks only an unconditional permit for every principal and tool, with no other NobleCloak annotation or @advice',
          },
        ],
      };
}

export interface Assembled {
  readonly policies: { readonly key?: string; readonly write: PolicyWrite }[];
  readonly unsupported: ReportEntry[];
  readonly lossy: ReportEntry[];
  readonly conflicts: ReportEntry[];
  readonly baseline: boolean;
  /** How the imported `ask`/`escalate` policies were written: one encoding, `mixed`, or undefined when there were none. */
  readonly encoding: ApprovalEncoding | 'mixed' | undefined;
}

function sameFields(a: Fields, b: Fields): boolean {
  return canonicalize(a) === canonicalize(b);
}

/**
 * Groups decoded statements into policies: statements with the same policy key are one policy, its
 * subjects in statement order; a statement without a key is a policy of its own. A policy is imported only
 * when every statement of it decoded, they agree on everything but the subject, and the result is a valid
 * rev 10 `tool_invocation` policy.
 */
export function assemble(statements: readonly { path: string; decoded: Decoded }[]): Assembled {
  const out: Assembled = {
    policies: [],
    unsupported: [],
    lossy: [],
    conflicts: [],
    baseline: false,
    encoding: undefined,
  };
  // A key's siblings are reported in the bucket of the first reason the key was rejected.
  const rejectedKeys = new Map<string, 'unsupported' | 'conflicts'>();
  for (const { decoded } of statements) {
    if (decoded.type === 'rejected') {
      out[decoded.bucket].push(...decoded.entries);
      if (decoded.key !== undefined && !rejectedKeys.has(decoded.key))
        rejectedKeys.set(decoded.key, decoded.bucket);
    }
  }
  const groups = new Map<
    string | symbol,
    { path: string; decoded: Extract<Decoded, { type: 'policy' }> }[]
  >();
  let baseline = false;
  const encodings = new Set<ApprovalEncoding>();
  for (const { path, decoded } of statements) {
    if (decoded.type === 'baseline') {
      baseline = true;
      out.lossy.push(...decoded.lossy);
    }
    if (decoded.type !== 'policy') continue;
    const rejectedAs = decoded.key === undefined ? undefined : rejectedKeys.get(decoded.key);
    if (decoded.key !== undefined && rejectedAs !== undefined) {
      out[rejectedAs].push({
        path,
        reason: `not imported: another statement of policy ${quote(decoded.key)} was not`,
        policy: decoded.key,
      });
      continue;
    }
    const groupKey = decoded.key ?? Symbol(path);
    const group = groups.get(groupKey) ?? [];
    group.push({ path, decoded });
    groups.set(groupKey, group);
  }
  for (const group of groups.values()) {
    const [first] = group;
    /* v8 ignore next -- a group is created with its first statement */
    if (first === undefined) continue;
    const key = first.decoded.key;
    const tag = (entry: ReportEntry): ReportEntry =>
      key === undefined ? entry : { ...entry, policy: key };
    const disagreeing = group.filter(
      (member) => !sameFields(member.decoded.fields, first.decoded.fields)
    );
    if (disagreeing.length > 0) {
      out.conflicts.push(
        ...group.map((member) =>
          tag({
            path: member.path,
            reason: `the statements of policy ${quote(key ?? '')} disagree on something other than the principal`,
          })
        )
      );
      continue;
    }
    const { tools, ...rest } = first.decoded.fields;
    const write: PolicyWrite = {
      kind: 'tool_invocation',
      ...rest,
      subjects: group.map((member) => member.decoded.subject),
      targets: { tools: tools === 'all' ? 'all' : [...tools] },
    };
    const problems = toolInvocationProblems(write);
    if (problems.length > 0) {
      // Every statement of the policy is reported: none of them is imported.
      out.unsupported.push(
        ...group.flatMap((member) =>
          problems.map((problem) =>
            tag({
              path: member.path,
              reason: `the policy it stands for is not a valid tool_invocation policy: ${problem.path} ${problem.reason}`,
            })
          )
        )
      );
      continue;
    }
    for (const member of group) {
      out.lossy.push(...member.decoded.lossy);
      if (member.decoded.encoding !== undefined) encodings.add(member.decoded.encoding);
    }
    out.policies.push(key === undefined ? { write } : { key, write });
  }
  const [only] = encodings;
  return {
    ...out,
    baseline,
    encoding: encodings.size === 0 ? undefined : encodings.size === 1 ? only : 'mixed',
  };
}
