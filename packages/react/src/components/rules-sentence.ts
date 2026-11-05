/**
 * A rule as a sentence: "If amount is greater than 5000, deny". Deterministic: the words come from the labels (the
 * tests are `opWord_*`, the outcomes `ruleOutcome_*`) and the values from the rule, so the same rule always reads the
 * same. A part that is not chosen yet reads as an ellipsis. Raw text: a caller escapes it.
 */
import {
  approverId,
  isRoleApprover,
  listOf,
  opShape,
  scalarText,
  singleOf,
} from '../permissions-rules.js';
import type { PolicyApprover, PolicyRule, RuleCondition } from '../permissions-rules.js';
import type { PermissionsTranslate } from './permissions-labels.js';

/** One condition: "amount is greater than 5000", "env is one of prod, dr", "amount has a value". */
export function conditionSentence(condition: RuleCondition, t: PermissionsTranslate): string {
  const fact = condition.fact === '' ? t('ruleSentenceMissing') : condition.fact;
  const op = t(`opWord_${condition.op}`);
  const shape = opShape(condition.op);
  if (shape === 'none') return `${fact} ${op}`;
  const { value } = condition;
  if (shape === 'list') {
    const items = listOf(value).map((item) => scalarText(item));
    return `${fact} ${op} ${items.length === 0 ? t('ruleSentenceMissing') : items.join(', ')}`;
  }
  const single = singleOf(value);
  const text = single === undefined || single === '' ? undefined : scalarText(single);
  return `${fact} ${op} ${text ?? t('ruleSentenceMissing')}`;
}

/** The conditions of a `when`, joined. */
export function whenSentence(when: readonly RuleCondition[], t: PermissionsTranslate): string {
  return when.length === 0
    ? t('ruleSentenceMissing')
    : when.map((condition) => conditionSentence(condition, t)).join(t('ruleWhenJoin'));
}

/** An approver entry: "role finance" or "user u-1". */
export function approverSentence(entry: PolicyApprover, t: PermissionsTranslate): string {
  return t(isRoleApprover(entry) ? 'approverSentenceRole' : 'approverSentenceUser', {
    id: approverId(entry),
  });
}

/** A rule: "If amount is greater than 5000, deny", with its approvers in brackets when it has any. */
export function ruleSentence(rule: PolicyRule, t: PermissionsTranslate): string {
  const when = whenSentence(rule.when, t);
  const outcome = t(`ruleOutcome_${rule.then}`);
  if (rule.approvers === undefined || rule.approvers.length === 0)
    return t('ruleSentence', { when, outcome });
  return t('ruleSentenceApprovers', {
    when,
    outcome,
    approvers: rule.approvers.map((entry) => approverSentence(entry, t)).join(', '),
  });
}
