/**
 * The evaluation of rev 16, with no state: reading the facts of a call through a tool's fact bindings
 * (`FactBinding`), testing a condition (`PolicyCondition`), walking one policy's `rules` (`ToolInvocationConfig`), the
 * approver entries in force (`PolicyApprover`), and the write-time check of a condition against the tools it targets.
 * The mock composes policies and keeps requirements around these; nothing here knows of either.
 */

/** A JSON scalar: the value a fact holds, or a condition compares against. */
export type Scalar = string | number | boolean | null;

/** `FactBinding.type`. */
export type FactType = 'number' | 'string' | 'boolean' | 'count';

/** `FactBinding`. */
export interface FactBinding {
  readonly path: string;
  readonly type: FactType;
  readonly description?: string;
}

/** `ToolFacts`: the bindings of a tool, by fact name. */
export type FactBindings = Readonly<Record<string, FactBinding>>;

/** The facts of a call with a value, by name; a fact with no value is absent. */
export type Facts = ReadonlyMap<string, Scalar>;

/** `PolicyCondition.op`. */
export type Op = 'eq' | 'ne' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';

/** `PolicyCondition`. */
export interface Condition {
  readonly fact: string;
  readonly op: Op;
  readonly value?: Scalar | readonly Scalar[];
}

/** `ApproverRef`: an approver entry without its `when`. */
export type ApproverRef = { readonly role: string } | { readonly user: string };

/** `PolicyApprover`. */
export type Approver = ApproverRef & { readonly when?: readonly Condition[] };

/** `PolicyRule.then`. */
export type RuleThen = 'always_allow' | 'ask' | 'deny';

/** `PolicyRule`. */
export interface Rule {
  readonly when: readonly Condition[];
  readonly then: RuleThen;
  readonly approvers?: readonly Approver[];
}

/** The members of `ToolInvocationConfig` the walk reads. */
export interface RuleConfig {
  readonly mode: string;
  readonly rules?: readonly Rule[];
}

/** What one policy gave for one call. */
export interface WalkResult {
  /** A mode: the matching rule's `then`, `ask` when a fact was missing, else the policy's `mode`. */
  readonly result: string;
  /** The rule that decided (`ConsideredPolicy.rule`), when one matched. */
  readonly rule?: { readonly index: number; readonly then: RuleThen };
  /**
   * The approvers the policy's requirement takes in place of the policy's own `approvers`: the matching rule's, when
   * it is an `ask` rule that has them; when a rule stopped the walk, that rule's, when it is an `ask` rule that has
   * them, else none (an empty list: the organisation's administrators). Absent: the policy's own.
   */
  readonly approvers?: readonly Approver[];
  /** The facts the rule that stopped the walk needed and had no value for (`ConsideredPolicy.missing_facts`). */
  readonly missing_facts?: readonly string[];
}

/** The truth of a condition: three-valued, as `ToolInvocationConfig` states. */
export type Truth = 'true' | 'false' | 'unevaluable';

/** One segment of a binding's path: a member name, or an array index. */
type Segment = { readonly key: string } | { readonly index: number };

const SEGMENT = /\.([A-Za-z_][A-Za-z0-9_-]*)|\[([0-9]+)\]/y;

/**
 * The segments of `path`, or undefined when it is not in the deterministic subset `FactBinding.path` allows (a
 * wildcard or a recursive descent included): the schema refuses such a binding, and a reader that meets one reads
 * nothing.
 */
export function pathSegments(path: string): readonly Segment[] | undefined {
  const out: Segment[] = [];
  SEGMENT.lastIndex = 0;
  while (SEGMENT.lastIndex < path.length) {
    const at = SEGMENT.lastIndex;
    const match = SEGMENT.exec(path);
    if (match?.index !== at) return undefined;
    out.push(match[1] === undefined ? { index: Number(match[2]) } : { key: match[1] });
  }
  return out.length === 0 ? undefined : out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The value of one fact of a call: the value at the binding's path of `args`, when it has the binding's JSON type
 * (a `count` is an array's length). Undefined when there is none: no arguments, a path that selects nothing, or a
 * value of another type. Nothing is coerced.
 */
export function readFact(
  args: unknown,
  binding: FactBinding
): { readonly value: Scalar } | undefined {
  const segments = pathSegments(binding.path);
  if (segments === undefined) return undefined;
  let here: unknown = args;
  for (const segment of segments) {
    if ('key' in segment) {
      if (!isRecord(here) || !Object.hasOwn(here, segment.key)) return undefined;
      here = here[segment.key];
    } else {
      if (!Array.isArray(here) || segment.index >= here.length) return undefined;
      here = here[segment.index];
    }
  }
  switch (binding.type) {
    case 'number':
      return typeof here === 'number' && Number.isFinite(here) ? { value: here } : undefined;
    case 'string':
      return typeof here === 'string' ? { value: here } : undefined;
    case 'boolean':
      return typeof here === 'boolean' ? { value: here } : undefined;
    case 'count':
      return Array.isArray(here) ? { value: here.length } : undefined;
  }
}

/** Every fact of a call with a value, read through `bindings`. A call with no arguments has none. */
export function readFacts(args: unknown, bindings: FactBindings | undefined): Map<string, Scalar> {
  const out = new Map<string, Scalar>();
  if (bindings === undefined || args === undefined) return out;
  for (const [name, binding] of Object.entries(bindings)) {
    const read = readFact(args, binding);
    if (read !== undefined) out.set(name, read.value);
  }
  return out;
}

const COMPARISONS: readonly Op[] = ['gt', 'gte', 'lt', 'lte'];

/** The truth of `condition` over `facts`. A fact with no value is unevaluable, except under `exists`. */
export function conditionTruth(condition: Condition, facts: Facts): Truth {
  const has = facts.has(condition.fact);
  if (condition.op === 'exists') return has ? 'true' : 'false';
  if (!has) return 'unevaluable';
  const fact = facts.get(condition.fact) ?? null;
  const verdict = (yes: boolean): Truth => (yes ? 'true' : 'false');
  const value = condition.value;
  switch (condition.op) {
    case 'eq':
      return verdict(fact === value);
    case 'ne':
      return verdict(fact !== value);
    case 'in':
      return verdict(Array.isArray(value) && value.includes(fact));
    case 'not_in':
      return verdict(Array.isArray(value) && !value.includes(fact));
    default: {
      if (typeof fact !== 'number' || typeof value !== 'number') return 'unevaluable';
      if (condition.op === 'gt') return verdict(fact > value);
      if (condition.op === 'gte') return verdict(fact >= value);
      if (condition.op === 'lt') return verdict(fact < value);
      return verdict(fact <= value);
    }
  }
}

/** The facts with no value that make the conditions of a `when` unevaluable, each once, in order. */
const missingOf = (when: readonly Condition[], facts: Facts): string[] => [
  ...new Set(when.filter((c) => conditionTruth(c, facts) === 'unevaluable').map((c) => c.fact)),
];

/**
 * The result of one policy for one call: walk `rules` in order; a rule with a false condition is skipped whatever
 * its other conditions, otherwise one with an unevaluable condition stops the walk with `ask`, the facts it missed,
 * and its own approvers when it is an `ask` rule that has them, else none (never the policy's), otherwise it
 * matches and its `then` is the result. No rule matches: `mode`.
 */
export function walkRules(config: RuleConfig, facts: Facts): WalkResult {
  for (const [index, rule] of (config.rules ?? []).entries()) {
    const truths = rule.when.map((c) => conditionTruth(c, facts));
    if (truths.includes('false')) continue;
    if (truths.includes('unevaluable'))
      return {
        result: 'ask',
        missing_facts: missingOf(rule.when, facts),
        approvers: rule.then === 'ask' && rule.approvers !== undefined ? rule.approvers : [],
      };
    return {
      result: rule.then,
      rule: { index, then: rule.then },
      ...(rule.then === 'ask' && rule.approvers !== undefined ? { approvers: rule.approvers } : {}),
    };
  }
  return { result: config.mode };
}

/**
 * The entries of `approvers` in force for a call: those whose every `when` condition is true, without `when`, each
 * once (an entry listed twice is one), in the order they are first listed.
 */
export function approversInForce(
  approvers: readonly Approver[] | undefined,
  facts: Facts
): ApproverRef[] {
  const seen = new Set<string>();
  const out: ApproverRef[] = [];
  for (const a of approvers ?? []) {
    if (!(a.when ?? []).every((c) => conditionTruth(c, facts) === 'true')) continue;
    const ref: ApproverRef = 'role' in a ? { role: a.role } : { user: a.user };
    const key = 'role' in ref ? `role:${ref.role}` : `user:${ref.user}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Why `condition` is refused at write time against the fact types of each targeted tool (`declared`, one map per
 * tool), or undefined when it fits them all: a fact one of them does not declare, or a comparison of a fact one of
 * them declares as neither `number` nor `count`.
 */
export function refusedCondition(
  condition: Condition,
  declared: readonly Readonly<Record<string, FactType>>[]
): string | undefined {
  for (const tool of declared) {
    const type = tool[condition.fact];
    if (type === undefined) return `a targeted tool declares no fact ${condition.fact}.`;
    if (COMPARISONS.includes(condition.op) && type !== 'number' && type !== 'count')
      return `${condition.op} compares ${condition.fact}, which a targeted tool declares as ${type}: neither a number nor a count.`;
  }
  return undefined;
}
