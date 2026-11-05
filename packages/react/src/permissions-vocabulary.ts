/**
 * The five modes of a `tool_invocation` policy and the decision each maps to on the wire, as the contract publishes
 * them in `x-noblecloak-vocabulary.decision_from_policy_mode`. A test holds `MODE_ON_THE_WIRE` equal to the contract's
 * table, so the module shows the mapping and never a paraphrase of it. Nothing here says how policies compose.
 */

/** The modes the contract documents (`PolicyMode`), in the order it lists them. */
export const POLICY_MODES = ['always_allow', 'ask', 'escalate', 'deny', 'not_granted'] as const;

export type KnownPolicyMode = (typeof POLICY_MODES)[number];

/** The decision a mode maps to: the decision value, and the routing or reason the contract adds to it. */
export interface ModeOnTheWire {
  readonly decision: 'allow' | 'deny' | 'step_up';
  /** Only for `escalate`: the same `step_up`, marked `routing: escalated` (the contract says no more of it yet). */
  readonly routing?: 'escalated';
  /** Only for `not_granted`: the `deny` carries this reason. */
  readonly reason?: 'not_granted';
}

/** `x-noblecloak-vocabulary.decision_from_policy_mode`, member for member. */
export const MODE_ON_THE_WIRE: Readonly<Record<KnownPolicyMode, ModeOnTheWire>> = Object.freeze({
  always_allow: Object.freeze({ decision: 'allow' }),
  ask: Object.freeze({ decision: 'step_up' }),
  escalate: Object.freeze({ decision: 'step_up', routing: 'escalated' }),
  deny: Object.freeze({ decision: 'deny' }),
  not_granted: Object.freeze({ decision: 'deny', reason: 'not_granted' }),
});

/**
 * The modes the contract marks provisional: `not_granted`, which no deployment implements yet; a deployment that does
 * not implement it refuses a policy that sets it with 422 `unsupported_policy_form`.
 */
export const PROVISIONAL_MODES: readonly KnownPolicyMode[] = Object.freeze(['not_granted']);

/** The modes that take `on_deny`, `expires_after` and `approver_groups` (the legality matrix of `ToolInvocationConfig`). */
export const CONDITION_MODES: readonly KnownPolicyMode[] = Object.freeze(['ask', 'escalate']);

/** The members of a `tool_invocation` configuration that only `CONDITION_MODES` take. */
export const CONDITION_FIELDS = Object.freeze([
  'on_deny',
  'expires_after',
  'approver_groups',
] as const);

/** The policy kinds the contract documents (`PolicyKind`'s known values). The enum is open: any other kind is kept. */
export const KNOWN_POLICY_KINDS = Object.freeze([
  'tool_invocation',
  'spending',
  'duplicate_requests',
  'approval_routing',
] as const);

/** Whether `value` is one of the five documented modes. */
export function isKnownMode(value: unknown): value is KnownPolicyMode {
  return typeof value === 'string' && (POLICY_MODES as readonly string[]).includes(value);
}

/** Whether a configuration with this mode may carry `on_deny`, `expires_after` or `approver_groups`. */
export function takesConditions(mode: string): boolean {
  return (CONDITION_MODES as readonly string[]).includes(mode);
}

/** The tests a rule's condition makes of a fact (`PolicyCondition.op`), in the order the contract lists them. */
export const CONDITION_OPS = Object.freeze([
  'eq',
  'ne',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
] as const);

export type ConditionOp = (typeof CONDITION_OPS)[number];

/** What a rule gives when its conditions hold (`PolicyRule.then`), in the order the contract lists them. */
export const RULE_OUTCOMES = Object.freeze(['always_allow', 'ask', 'deny'] as const);

export type RuleOutcome = (typeof RULE_OUTCOMES)[number];

/** The only value of `ToolInvocationConfig.exclude`. */
export const EXCLUDE_VALUES = Object.freeze(['requester'] as const);

/** The members rev 16 adds to a `tool_invocation` configuration, as `policy_forms.tool_invocation.config_members` names them. */
export const RULE_CONFIG_MEMBERS = Object.freeze(['rules', 'approvers', 'exclude'] as const);

/** The limits of the contract: rules, conditions of a `when`, values of `in`/`not_in`, and approver entries. */
export const RULE_LIMITS = Object.freeze({
  rules: 32,
  conditions: 8,
  listValues: 100,
  approvers: 32,
});

/** The members of an `approval_routing` policy's configuration. */
export const APPROVAL_ROUTING_MEMBERS = Object.freeze(['org_admin_break_glass'] as const);

/**
 * The tests offered for a fact of each type. `gt`, `gte`, `lt` and `lte` need a `number` or a `count` (the contract
 * refuses the others); the rest are offered for every type, though `in` and `not_in` of a true-or-false fact say
 * nothing `eq` does not, so those are left out of a boolean's list.
 */
export const OPS_BY_FACT_TYPE: Readonly<Record<string, readonly ConditionOp[]>> = Object.freeze({
  number: Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'exists'] as const),
  count: Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'exists'] as const),
  string: Object.freeze(['eq', 'ne', 'in', 'not_in', 'exists'] as const),
  boolean: Object.freeze(['eq', 'ne', 'exists'] as const),
});
