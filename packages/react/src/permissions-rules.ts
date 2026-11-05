/**
 * Rules, approvers and `exclude` of a `tool_invocation` policy (contract rev 16), as the editor holds and checks them.
 * Pure: no timers, no network, no storage. Everything here reads the configuration as the wire states it and never
 * trusts it: a member that is present and not the shape the contract gives, or whose rule, condition or approver
 * carries a key outside the contract's set, is `unreadable`, left exactly as it is, and
 * never edited from here, so a write cannot drop what the editor could not show.
 *
 * Two kinds of finding come from `checkRules`. A *problem* is something the contract refuses (the service answers 400
 * or 422 for it), so the editor does not send it. A *warning* is something the contract accepts and the person likely
 * did not mean (approvers that no outcome can reach; a fact the target tools do not declare, or a test that does not
 * fit its type, where the policy targets `all` or a tool that is not registered yet): shown, never blocking.
 */
import {
  CONDITION_OPS,
  OPS_BY_FACT_TYPE,
  RULE_LIMITS,
  RULE_OUTCOMES,
  takesConditions,
} from './permissions-vocabulary.js';
import type { ConditionOp, RuleOutcome } from './permissions-vocabulary.js';
import type { FactType, ToolFacts } from './connections-facts.js';

/** A JSON scalar: what `eq` and `ne` compare to, and what a list of `in` and `not_in` holds. */
export type Scalar = string | number | boolean | null;

/** One test of one fact of the call. `value` is a scalar, a list of scalars (`in`, `not_in`), or absent (`exists`). */
export interface RuleCondition {
  readonly fact: string;
  readonly op: ConditionOp;
  readonly value?: Scalar | readonly Scalar[];
}

/** An approver entry: a role by its bare key, or a user by principal id; in force only while its `when` holds. */
export type PolicyApprover =
  | { readonly role: string; readonly when?: readonly RuleCondition[] }
  | { readonly user: string; readonly when?: readonly RuleCondition[] };

export interface PolicyRule {
  readonly when: readonly RuleCondition[];
  readonly then: RuleOutcome;
  /** Only with `then: ask`. */
  readonly approvers?: readonly PolicyApprover[];
}

/** A member of the configuration, read: absent, readable, or present and not the contract's shape. */
export type MemberRead<T> =
  | { readonly state: 'absent' }
  | { readonly state: 'ok'; readonly value: T }
  | { readonly state: 'unreadable' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

const isOp = (value: unknown): value is ConditionOp =>
  typeof value === 'string' && (CONDITION_OPS as readonly string[]).includes(value);

const isOutcome = (value: unknown): value is RuleOutcome =>
  typeof value === 'string' && (RULE_OUTCOMES as readonly string[]).includes(value);

/** True when `value` has a member outside `keys`: one this editor would drop on its next write. */
const hasOtherKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).some((key) => !keys.includes(key));

function conditionOf(value: unknown): RuleCondition | undefined {
  if (
    !isRecord(value) ||
    hasOtherKeys(value, ['fact', 'op', 'value']) ||
    typeof value.fact !== 'string' ||
    !isOp(value.op)
  )
    return undefined;
  const raw = value.value;
  if (raw !== undefined && !isScalar(raw) && !(Array.isArray(raw) && raw.every(isScalar)))
    return undefined;
  return {
    fact: value.fact,
    op: value.op,
    ...(raw === undefined ? {} : { value: Array.isArray(raw) ? [...raw] : raw }),
  };
}

function conditionsOf(value: unknown): RuleCondition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RuleCondition[] = [];
  for (const entry of value as unknown[]) {
    const one = conditionOf(entry);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}

function approverOf(value: unknown): PolicyApprover | undefined {
  if (!isRecord(value) || hasOtherKeys(value, ['role', 'user', 'when'])) return undefined;
  const when = value.when === undefined ? undefined : conditionsOf(value.when);
  if (value.when !== undefined && when === undefined) return undefined;
  const tail = when === undefined ? {} : { when };
  if (typeof value.role === 'string' && value.user === undefined)
    return { role: value.role, ...tail };
  if (typeof value.user === 'string' && value.role === undefined)
    return { user: value.user, ...tail };
  return undefined;
}

function approversOf(value: unknown): PolicyApprover[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PolicyApprover[] = [];
  for (const entry of value as unknown[]) {
    const one = approverOf(entry);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}

/** `config.rules`: the rules when every one is readable, `unreadable` when the member is there and anything is not. */
export function readRules(config: Readonly<Record<string, unknown>>): MemberRead<PolicyRule[]> {
  const raw = config.rules;
  if (raw === undefined) return { state: 'absent' };
  if (!Array.isArray(raw)) return { state: 'unreadable' };
  const rules: PolicyRule[] = [];
  for (const entry of raw as unknown[]) {
    if (
      !isRecord(entry) ||
      hasOtherKeys(entry, ['when', 'then', 'approvers']) ||
      !isOutcome(entry.then)
    )
      return { state: 'unreadable' };
    const when = conditionsOf(entry.when);
    const approvers = entry.approvers === undefined ? undefined : approversOf(entry.approvers);
    if (when === undefined || (entry.approvers !== undefined && approvers === undefined))
      return { state: 'unreadable' };
    rules.push({ when, then: entry.then, ...(approvers === undefined ? {} : { approvers }) });
  }
  return { state: 'ok', value: rules };
}

/** `config.approvers`, read as `readRules` reads `rules`. */
export function readApprovers(
  config: Readonly<Record<string, unknown>>
): MemberRead<PolicyApprover[]> {
  if (config.approvers === undefined) return { state: 'absent' };
  const read = approversOf(config.approvers);
  return read === undefined ? { state: 'unreadable' } : { state: 'ok', value: read };
}

/** `config.exclude`: a list of text; a value other than `requester` is kept and left alone by `setRequesterExcluded`. */
export function readExclude(config: Readonly<Record<string, unknown>>): MemberRead<string[]> {
  const raw = config.exclude;
  if (raw === undefined) return { state: 'absent' };
  return Array.isArray(raw) && raw.every((v) => typeof v === 'string')
    ? { state: 'ok', value: [...raw] }
    : { state: 'unreadable' };
}

/** The values of a list-valued condition (`in`, `not_in`); empty when the value is not a list. */
export function listOf(value: RuleCondition['value']): readonly Scalar[] {
  return isScalar(value) || value === undefined ? [] : value;
}

/** The value of a one-valued condition; `undefined` when it has none or holds a list. */
export function singleOf(value: RuleCondition['value']): Scalar | undefined {
  return isScalar(value) ? value : undefined;
}

// ---- editing: each function returns a new list and never changes its argument -------------------------------

/** A rule the editor starts from: one condition on `fact` (when there is one) and the outcome `ask`. */
export function newRule(fact?: { readonly name: string; readonly type?: FactType }): PolicyRule {
  return { when: [newCondition(fact)], then: 'ask' };
}

/** A condition on `fact`: `eq` with no value yet (a true-or-false fact starts at `true`). */
export function newCondition(fact?: {
  readonly name: string;
  readonly type?: FactType;
}): RuleCondition {
  const name = fact?.name ?? '';
  return fact?.type === 'boolean'
    ? { fact: name, op: 'eq', value: true }
    : { fact: name, op: 'eq' };
}

export const addRule = (rules: readonly PolicyRule[], rule: PolicyRule): PolicyRule[] => [
  ...rules,
  rule,
];

export const removeAt = <T>(list: readonly T[], index: number): T[] =>
  list.filter((_, at) => at !== index);

/** Moves the item at `index` one place up (`-1`) or down (`1`); out of range, or at an end, changes nothing. */
export function moveAt<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item as T);
  return next;
}

export const replaceAt = <T>(list: readonly T[], index: number, item: T): T[] =>
  list.map((held, at) => (at === index ? item : held));

/**
 * A rule with another outcome. `approvers` belong to an `ask` rule alone, so a rule that stops asking drops them (the
 * editor says so; the contract refuses an `always_allow` or `deny` rule that carries them).
 */
export function withOutcome(rule: PolicyRule, then: RuleOutcome): PolicyRule {
  if (then === 'ask') return { ...rule, then };
  return { when: rule.when, then };
}

/** The tests offered for a fact of `type`, and `current` when the condition already holds one the list would drop. */
export function opsFor(type: string | undefined, current?: ConditionOp): readonly ConditionOp[] {
  const offered = type === undefined ? CONDITION_OPS : (OPS_BY_FACT_TYPE[type] ?? CONDITION_OPS);
  return current === undefined || offered.includes(current) ? offered : [...offered, current];
}

/** Whether a test takes a list of values, takes none, or takes one. */
export const opShape = (op: ConditionOp): 'list' | 'none' | 'one' =>
  op === 'in' || op === 'not_in' ? 'list' : op === 'exists' ? 'none' : 'one';

/** A condition with another test: its value is kept where the new test can use it and dropped where it cannot. */
export function withOp(condition: RuleCondition, op: ConditionOp): RuleCondition {
  const shape = opShape(op);
  const { value } = condition;
  if (shape === 'none') return { fact: condition.fact, op };
  if (shape === 'list') {
    if (Array.isArray(value)) return { ...condition, op };
    return value === undefined
      ? { fact: condition.fact, op, value: [] }
      : { fact: condition.fact, op, value: [value as Scalar] };
  }
  if (Array.isArray(value)) {
    const [first] = value as Scalar[];
    return first === undefined
      ? { fact: condition.fact, op }
      : { fact: condition.fact, op, value: first };
  }
  return value === undefined ? { fact: condition.fact, op } : { ...condition, op };
}

/**
 * A condition on another fact. The test is kept when the new fact's type offers it, else it goes back to `eq`; the
 * value starts again, since a value typed for the old fact would read as another type for the new one (a
 * true-or-false fact starts at `true`, a list at empty).
 */
export function withFact(
  condition: RuleCondition,
  fact: { readonly name: string; readonly type?: FactType }
): RuleCondition {
  const op = opsFor(fact.type).includes(condition.op) ? condition.op : 'eq';
  const bare = { fact: fact.name, op };
  const shape = opShape(op);
  if (shape === 'none') return bare;
  if (shape === 'list') return { ...bare, value: [] };
  return fact.type === 'boolean' ? { ...bare, value: true } : bare;
}

/** Whether `entry` is a role (and not a user). */
export const isRoleApprover = (
  entry: PolicyApprover
): entry is { role: string; when?: readonly RuleCondition[] } => 'role' in entry;

/** The entry's id: the role's key or the user's principal id. */
export const approverId = (entry: PolicyApprover): string =>
  'role' in entry ? entry.role : entry.user;

/** An entry of the same `when` with another kind or id. */
export function withApprover(
  entry: PolicyApprover,
  kind: 'role' | 'user',
  id: string
): PolicyApprover {
  const when = entry.when === undefined ? {} : { when: entry.when };
  return kind === 'role' ? { role: id, ...when } : { user: id, ...when };
}

/** The entry with `when` set, or, with none, removed. */
export function withApproverWhen(
  entry: PolicyApprover,
  when: readonly RuleCondition[] | undefined
): PolicyApprover {
  const tail = when === undefined ? {} : { when };
  return 'role' in entry ? { role: entry.role, ...tail } : { user: entry.user, ...tail };
}

/** The condition without its value. */
export const withoutValue = (condition: RuleCondition): RuleCondition => ({
  fact: condition.fact,
  op: condition.op,
});

/** A rule with its approvers set, or, with none, removed. */
export function withRuleApprovers(
  rule: PolicyRule,
  approvers: readonly PolicyApprover[]
): PolicyRule {
  return approvers.length === 0
    ? { when: rule.when, then: rule.then }
    : { when: rule.when, then: rule.then, approvers };
}

/** `exclude` with `requester` in it or out; any other value it holds stays. */
export function setRequesterExcluded(exclude: readonly string[], excluded: boolean): string[] {
  const rest = exclude.filter((value) => value !== 'requester');
  return excluded ? [...rest, 'requester'] : rest;
}

// ---- the facts a condition may name --------------------------------------------------------------------------

/** A fact as `newRule`, `newCondition` and `withFact` take it: its name, and its type when it has one. */
export interface FactRef {
  readonly name: string;
  readonly type?: FactType;
}

/** What a condition may name: the facts of the policy's target tools, by name, with their type when the tools agree. */
export interface FactCatalog {
  /** Whether any target tool is registered and listed: without one, nothing says which facts exist. */
  readonly known: boolean;
  /**
   * True when the policy names its targets and every one is a registered tool. Then the contract refuses (400) a
   * condition naming a fact a target does not declare, or `gt`, `gte`, `lt`, `lte` on a fact a target declares as
   * neither `number` nor `count`; otherwise it accepts them and they are unevaluable where they do not fit. Absent as
   * well when a target sent facts this module could not read in full (it cannot tell what that target declares).
   */
  readonly registered?: boolean;
  readonly facts: ReadonlyMap<
    string,
    {
      readonly type?: FactType;
      /** True when some target declares the fact as neither `number` nor `count`, whether or not the targets agree. */
      readonly nonNumeric?: true;
    }
  >;
}

/**
 * The facts of the tools a policy targets. For named targets, the facts every one of them declares (a condition
 * the contract refuses is one that names a fact a target does not declare); for every tool, those any declares. A
 * fact whose type differs between tools has no type here, so the editor offers every test for it; `nonNumeric` still
 * says when an order test on it is one the contract refuses.
 */
export function factCatalogOf(
  tools: readonly {
    readonly toolRef: string;
    readonly facts?: ToolFacts | undefined;
    readonly factsUnreadable?: true | undefined;
  }[],
  targets: 'all' | readonly string[] | undefined
): FactCatalog {
  const targeted =
    targets === undefined || targets === 'all'
      ? tools
      : tools.filter((tool) => targets.includes(tool.toolRef));
  if (targeted.length === 0) return { known: false, facts: new Map() };
  const everyTool = targets !== undefined && targets !== 'all';
  const merged = new Map<string, { type?: FactType; seen: number; nonNumeric: boolean }>();
  for (const tool of targeted) {
    for (const [name, binding] of Object.entries(tool.facts ?? {})) {
      const numeric = binding.type === 'number' || binding.type === 'count';
      const held = merged.get(name);
      if (held === undefined)
        merged.set(name, { type: binding.type, seen: 1, nonNumeric: !numeric });
      else {
        held.seen += 1;
        if (!numeric) held.nonNumeric = true;
        if (held.type !== binding.type) delete held.type;
      }
    }
  }
  const facts = new Map<string, { readonly type?: FactType; readonly nonNumeric?: true }>();
  for (const [name, held] of merged)
    if (!everyTool || held.seen === targeted.length)
      facts.set(name, {
        ...(held.type === undefined ? {} : { type: held.type }),
        ...(held.nonNumeric ? { nonNumeric: true as const } : {}),
      });
  // A target whose `facts` this module could not read in full declares facts it cannot see, so nothing is refused for
  // a fact it does not list: the findings stay warnings.
  const registered =
    everyTool &&
    targets.every((ref) => tools.some((tool) => tool.toolRef === ref)) &&
    !targeted.some((tool) => tool.factsUnreadable === true);
  return { known: true, ...(registered ? { registered } : {}), facts };
}

/** The fact `name` of `catalog` as a `FactRef`. */
export function factRefOf(catalog: FactCatalog, name: string): FactRef {
  const type = catalog.facts.get(name)?.type;
  return type === undefined ? { name } : { name, type };
}

// ---- values typed into a condition ---------------------------------------------------------------------------

/**
 * The value typed as `text` for a fact of `type`, or `undefined` when it is not one: a number for `number` and
 * `count` (and for `gt`, `gte`, `lt`, `lte` whatever the type), `true` or `false` for `boolean`, the text for
 * `string`. For a fact of no known type the text is read as JSON (`5000`, `"prod"`, `true`, `null`), and as text when it is not.
 */
export function parseScalar(
  text: string,
  type: string | undefined,
  op: ConditionOp
): Scalar | undefined {
  const numeric = type === 'number' || type === 'count' || ['gt', 'gte', 'lt', 'lte'].includes(op);
  if (numeric) {
    const trimmed = text.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'boolean') return text === 'true' ? true : text === 'false' ? false : undefined;
  if (type === 'string') return text === '' ? undefined : text;
  try {
    const parsed: unknown = JSON.parse(text);
    return isScalar(parsed) ? parsed : text;
  } catch {
    return text === '' ? undefined : text;
  }
}

/** A value as the text of an input. A string is shown as it is; any other scalar as JSON. */
export function scalarText(value: Scalar | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The lines of a multi-value input as scalars, with a line that is not one of `type` left out. */
export function parseScalarLines(
  text: string,
  type: string | undefined,
  op: ConditionOp
): Scalar[] {
  const out: Scalar[] = [];
  for (const line of text.split('\n')) {
    const value = parseScalar(line.trim(), type, op);
    if (value !== undefined) out.push(value);
  }
  return out;
}

// ---- checks ---------------------------------------------------------------------------------------------------

/**
 * A refusal of the contract, by the path of the member in the configuration (`rules[0].when[1].value`,
 * `approvers[2].role`, `rules[1].approvers`, `rules`).
 */
export interface RuleProblem {
  readonly path: string;
  readonly code:
    | 'rules_empty'
    | 'rules_too_many'
    | 'when_empty'
    | 'when_too_many'
    | 'fact_missing'
    | 'value_missing'
    | 'value_unexpected'
    | 'value_not_number'
    | 'list_empty'
    | 'list_too_long'
    | 'approvers_empty'
    | 'approvers_too_many'
    | 'approvers_with_outcome'
    | 'approver_id_missing'
    /** Only where every target is a registered tool (`FactCatalog.registered`). */
    | 'fact_not_declared'
    | 'op_not_for_type';
}

/**
 * Something the contract accepts and the person probably did not mean. `fact_not_declared` and `op_not_for_type` are
 * warnings only where the contract accepts them (`targets: all`, or a target that is not a registered tool); where
 * every target is registered they are problems.
 */
export interface RuleWarning {
  readonly path: string;
  readonly code:
    'fact_not_declared' | 'op_not_for_type' | 'approvers_unreachable' | 'exclude_unreachable';
}

export interface RuleChecks {
  readonly problems: readonly RuleProblem[];
  readonly warnings: readonly RuleWarning[];
}

function checkWhen(
  path: string,
  when: readonly RuleCondition[],
  catalog: FactCatalog,
  out: { problems: RuleProblem[]; warnings: RuleWarning[] }
): void {
  if (when.length === 0) out.problems.push({ path, code: 'when_empty' });
  if (when.length > RULE_LIMITS.conditions) out.problems.push({ path, code: 'when_too_many' });
  when.forEach((condition, index) => {
    const at = `${path}[${String(index)}]`;
    if (condition.fact === '') out.problems.push({ path: `${at}.fact`, code: 'fact_missing' });
    else if (catalog.known) {
      const declared = catalog.facts.get(condition.fact);
      const orderTest = ['gt', 'gte', 'lt', 'lte'].includes(condition.op);
      if (declared === undefined)
        (catalog.registered === true ? out.problems : out.warnings).push({
          path: `${at}.fact`,
          code: 'fact_not_declared',
        });
      else if (catalog.registered === true && orderTest && declared.nonNumeric === true)
        out.problems.push({ path: `${at}.op`, code: 'op_not_for_type' });
      else if (declared.type !== undefined && !opsFor(declared.type).includes(condition.op))
        out.warnings.push({ path: `${at}.op`, code: 'op_not_for_type' });
    }
    const { value } = condition;
    const shape = opShape(condition.op);
    if (shape === 'none') {
      if (value !== undefined) out.problems.push({ path: `${at}.value`, code: 'value_unexpected' });
    } else if (shape === 'list') {
      if (!Array.isArray(value) || value.length === 0)
        out.problems.push({ path: `${at}.value`, code: 'list_empty' });
      else if (value.length > RULE_LIMITS.listValues)
        out.problems.push({ path: `${at}.value`, code: 'list_too_long' });
    } else if (value === undefined || Array.isArray(value)) {
      out.problems.push({ path: `${at}.value`, code: 'value_missing' });
    } else if (['gt', 'gte', 'lt', 'lte'].includes(condition.op) && typeof value !== 'number') {
      out.problems.push({ path: `${at}.value`, code: 'value_not_number' });
    }
  });
}

function checkApprovers(
  path: string,
  approvers: readonly PolicyApprover[],
  catalog: FactCatalog,
  out: { problems: RuleProblem[]; warnings: RuleWarning[] }
): void {
  if (approvers.length === 0) out.problems.push({ path, code: 'approvers_empty' });
  if (approvers.length > RULE_LIMITS.approvers)
    out.problems.push({ path, code: 'approvers_too_many' });
  approvers.forEach((entry, index) => {
    const at = `${path}[${String(index)}]`;
    if (approverId(entry) === '')
      out.problems.push({
        path: `${at}.${isRoleApprover(entry) ? 'role' : 'user'}`,
        code: 'approver_id_missing',
      });
    if (entry.when !== undefined) checkWhen(`${at}.when`, entry.when, catalog, out);
  });
}

/**
 * Whether a call under this configuration can reach an `ask` that the policy's own `approvers` answer: the mode
 * asks, or a rule gives `ask` without approvers of its own. (A walk a missing fact stops takes the stopping rule's
 * approvers, never the policy's, so it does not count.)
 */
function policyApproversReachable(
  config: Readonly<Record<string, unknown>>,
  rules: readonly PolicyRule[]
): boolean {
  const mode = typeof config.mode === 'string' ? config.mode : '';
  return (
    takesConditions(mode) ||
    rules.some((rule) => rule.then === 'ask' && rule.approvers === undefined)
  );
}

/** Whether any `ask` is reachable at all (an `exclude` shapes every requirement the policy contributes). */
function askReachable(
  config: Readonly<Record<string, unknown>>,
  rules: readonly PolicyRule[]
): boolean {
  const mode = typeof config.mode === 'string' ? config.mode : '';
  return (
    takesConditions(mode) ||
    rules.some(
      (rule) => rule.then === 'ask' || rule.when.some((condition) => condition.op !== 'exists')
    )
  );
}

/**
 * The checks of a configuration's rules, approvers and `exclude`. A member that is unreadable is not checked (the
 * editor leaves it as it is). `catalog` is the facts of the target tools: with none known, no fact is called
 * undeclared.
 */
export function checkRules(
  config: Readonly<Record<string, unknown>>,
  catalog: FactCatalog
): RuleChecks {
  const out = { problems: [] as RuleProblem[], warnings: [] as RuleWarning[] };
  const rules = readRules(config);
  const approvers = readApprovers(config);
  const exclude = readExclude(config);
  if (rules.state === 'ok') {
    if (rules.value.length === 0) out.problems.push({ path: 'rules', code: 'rules_empty' });
    if (rules.value.length > RULE_LIMITS.rules)
      out.problems.push({ path: 'rules', code: 'rules_too_many' });
    rules.value.forEach((rule, index) => {
      const at = `rules[${String(index)}]`;
      checkWhen(`${at}.when`, rule.when, catalog, out);
      if (rule.approvers !== undefined) {
        if (rule.then !== 'ask')
          out.problems.push({ path: `${at}.approvers`, code: 'approvers_with_outcome' });
        checkApprovers(`${at}.approvers`, rule.approvers, catalog, out);
      }
    });
  }
  const ruleList = rules.state === 'ok' ? rules.value : [];
  if (approvers.state === 'ok') {
    checkApprovers('approvers', approvers.value, catalog, out);
    if (approvers.value.length > 0 && !policyApproversReachable(config, ruleList))
      out.warnings.push({ path: 'approvers', code: 'approvers_unreachable' });
  }
  if (exclude.state === 'ok' && exclude.value.length > 0 && !askReachable(config, ruleList))
    out.warnings.push({ path: 'exclude', code: 'exclude_unreachable' });
  return out;
}
