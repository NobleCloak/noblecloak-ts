import { describe, expect, it } from 'vitest';

import type { PolicyRule } from '../permissions-rules.js';
import { PERMISSIONS_DEFAULT_LABELS, createPermissionsTranslate } from './permissions-labels.js';
import {
  approverSentence,
  conditionSentence,
  ruleSentence,
  whenSentence,
} from './rules-sentence.js';

const t = createPermissionsTranslate(undefined);

describe('a rule as a sentence', () => {
  it('reads each test in the words of the vocabulary', () => {
    const cases: [Parameters<typeof conditionSentence>[0], string][] = [
      [{ fact: 'amount', op: 'eq', value: 5 }, 'amount is 5'],
      [{ fact: 'env', op: 'ne', value: 'prod' }, 'env is not prod'],
      [{ fact: 'amount', op: 'gt', value: 5000 }, 'amount is greater than 5000'],
      [{ fact: 'amount', op: 'gte', value: 5000 }, 'amount is at least 5000'],
      [{ fact: 'amount', op: 'lt', value: 1 }, 'amount is less than 1'],
      [{ fact: 'amount', op: 'lte', value: 1 }, 'amount is at most 1'],
      [{ fact: 'env', op: 'in', value: ['prod', 'dr'] }, 'env is one of prod, dr'],
      [{ fact: 'env', op: 'not_in', value: ['dev'] }, 'env is none of dev'],
      [{ fact: 'amount', op: 'exists' }, 'amount has a value'],
      [{ fact: 'urgent', op: 'eq', value: true }, 'urgent is true'],
      [{ fact: 'x', op: 'eq', value: null }, 'x is null'],
    ];
    for (const [condition, sentence] of cases)
      expect(conditionSentence(condition, t)).toBe(sentence);
  });

  it('has an opWord for every test the contract has', () => {
    for (const op of ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'exists'])
      expect(PERMISSIONS_DEFAULT_LABELS).toHaveProperty(`opWord_${op}`);
    for (const outcome of ['always_allow', 'ask', 'deny'])
      expect(PERMISSIONS_DEFAULT_LABELS).toHaveProperty(`ruleOutcome_${outcome}`);
  });

  it('joins the conditions of a when with "and", and reads what is not chosen yet as an ellipsis', () => {
    expect(
      whenSentence(
        [
          { fact: 'amount', op: 'gt', value: 5000 },
          { fact: 'env', op: 'eq', value: 'prod' },
        ],
        t
      )
    ).toBe('amount is greater than 5000 and env is prod');
    expect(whenSentence([], t)).toBe('…');
    expect(conditionSentence({ fact: '', op: 'eq' }, t)).toBe('… is …');
    expect(conditionSentence({ fact: 'a', op: 'eq', value: '' }, t)).toBe('a is …');
    expect(conditionSentence({ fact: 'a', op: 'in', value: [] }, t)).toBe('a is one of …');
    expect(conditionSentence({ fact: 'a', op: 'in' }, t)).toBe('a is one of …');
    expect(conditionSentence({ fact: 'a', op: 'eq', value: [1] }, t)).toBe('a is …');
  });

  it('names the outcome and, for an asking rule with approvers, who answers', () => {
    const rule: PolicyRule = { when: [{ fact: 'amount', op: 'gt', value: 5000 }], then: 'deny' };
    expect(ruleSentence(rule, t)).toBe('If amount is greater than 5000, deny');
    expect(ruleSentence({ ...rule, then: 'always_allow' }, t)).toBe(
      'If amount is greater than 5000, allow'
    );
    expect(ruleSentence({ ...rule, then: 'ask' }, t)).toBe('If amount is greater than 5000, ask');
    expect(
      ruleSentence({ ...rule, then: 'ask', approvers: [{ role: 'lead' }, { user: 'u-1' }] }, t)
    ).toBe('If amount is greater than 5000, ask (role lead, user u-1)');
    expect(ruleSentence({ ...rule, then: 'ask', approvers: [] }, t)).toBe(
      'If amount is greater than 5000, ask'
    );
  });

  it('names an approver by kind and id', () => {
    expect(approverSentence({ role: 'finance' }, t)).toBe('role finance');
    expect(approverSentence({ user: 'u-1' }, t)).toBe('user u-1');
  });

  it('uses the host’s words where it gives them', () => {
    const german = createPermissionsTranslate({
      ruleSentence: 'Wenn {when}: {outcome}',
      opWord_gt: 'ist größer als',
      ruleOutcome_deny: 'ablehnen',
    });
    expect(
      ruleSentence({ when: [{ fact: 'betrag', op: 'gt', value: 5 }], then: 'deny' }, german)
    ).toBe('Wenn betrag ist größer als 5: ablehnen');
  });
});
