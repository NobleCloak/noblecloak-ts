/**
 * The outcome a rev 16 policy is exported as. A Cedar or AGT engine has no per-call facts, so a
 * rule-bearing policy is written as one statement that is never looser than NobleCloak's own evaluation:
 * the tightest outcome the policy can reach for any call.
 */
import type { Mode } from './validate.js';

/**
 * How tight an outcome is, as the contract composes policies (`policies.tightest_wins`): `deny` and
 * `not_granted` over `ask` and `escalate` over `always_allow`.
 */
const RANK: Readonly<Record<Mode, number>> = {
  always_allow: 0,
  ask: 1,
  escalate: 1,
  deny: 2,
  not_granted: 2,
};

interface RuleLike {
  readonly when: readonly { readonly op: string }[];
  readonly then: 'always_allow' | 'ask' | 'deny';
}

/**
 * Whether a policy with `rules` can ask where a fact of the call has no value: some rule has a condition
 * whose op is not `exists` (`exists` is never unevaluable).
 */
export function canAskOnMissingFact(rules: readonly RuleLike[] | undefined): boolean {
  return (rules ?? []).some((rule) => rule.when.some((condition) => condition.op !== 'exists'));
}

/**
 * The tightest outcome of a policy with `mode` and `rules`: the strictly tightest of `mode`, every rule's
 * `then`, and `ask` when any rule has a condition whose op is not `exists` (a fact with no value stops
 * the walk with `ask`; `exists` is never unevaluable). Among equally tight outcomes the earliest wins,
 * `mode` first, so the result is `mode` itself whenever nothing is tighter. Expects valid rules.
 */
export function tightestOutcome(mode: Mode, rules: readonly RuleLike[] | undefined): Mode {
  let outcome = mode;
  const consider = (candidate: Mode): void => {
    if (RANK[candidate] > RANK[outcome]) outcome = candidate;
  };
  for (const rule of rules ?? []) consider(rule.then);
  if (canAskOnMissingFact(rules)) consider('ask');
  return outcome;
}
