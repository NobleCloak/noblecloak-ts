import { describe, expect, it } from 'vitest';

import {
  addRule,
  approverId,
  checkRules,
  factCatalogOf,
  moveAt,
  newCondition,
  newRule,
  opShape,
  opsFor,
  parseScalar,
  parseScalarLines,
  readApprovers,
  readExclude,
  readRules,
  removeAt,
  replaceAt,
  scalarText,
  setRequesterExcluded,
  withApprover,
  withFact,
  withOp,
  withOutcome,
} from './permissions-rules.js';
import type { FactCatalog, PolicyRule, RuleCondition } from './permissions-rules.js';

const amountGt = (value: number): RuleCondition => ({ fact: 'amount', op: 'gt', value });
const rule = (over: Partial<PolicyRule> = {}): PolicyRule => ({
  when: [amountGt(5000)],
  then: 'deny',
  ...over,
});

const catalog = (facts: Record<string, 'number' | 'string' | 'boolean' | 'count' | undefined>) =>
  ({
    known: true,
    facts: new Map(
      Object.entries(facts).map(([name, type]) => [name, type === undefined ? {} : { type }])
    ),
  }) satisfies FactCatalog;

const AMOUNTS = catalog({ amount: 'number', env: 'string', urgent: 'boolean' });

const codes = (config: Record<string, unknown>, facts: FactCatalog = AMOUNTS) => {
  const { problems, warnings } = checkRules(config, facts);
  return {
    problems: problems.map((p) => `${p.path}:${p.code}`),
    warnings: warnings.map((w) => `${w.path}:${w.code}`),
  };
};

describe('reading the members', () => {
  it('reads rules, approvers and exclude as the contract gives them', () => {
    const config = {
      mode: 'ask',
      rules: [
        {
          when: [amountGt(5000), { fact: 'env', op: 'in', value: ['prod', 'dr'] }],
          then: 'ask',
          approvers: [{ role: 'lead', when: [{ fact: 'urgent', op: 'exists' }] }, { user: 'u-1' }],
        },
      ],
      approvers: [{ role: 'finance' }],
      exclude: ['requester'],
    };
    expect(readRules(config)).toEqual({ state: 'ok', value: config.rules });
    expect(readApprovers(config)).toEqual({ state: 'ok', value: config.approvers });
    expect(readExclude(config)).toEqual({ state: 'ok', value: ['requester'] });
  });

  it('says absent for a missing member', () => {
    expect(readRules({})).toEqual({ state: 'absent' });
    expect(readApprovers({})).toEqual({ state: 'absent' });
    expect(readExclude({})).toEqual({ state: 'absent' });
  });

  it.each([
    ['a rules member that is no list', { rules: 'x' }],
    ['a rule that is no object', { rules: [3] }],
    ['an outcome it does not know', { rules: [{ when: [], then: 'escalate' }] }],
    ['a when that is no list', { rules: [{ when: 'x', then: 'deny' }] }],
    ['a condition without a fact', { rules: [{ when: [{ op: 'eq', value: 1 }], then: 'deny' }] }],
    [
      'a test it does not know',
      { rules: [{ when: [{ fact: 'a', op: 'near', value: 1 }], then: 'deny' }] },
    ],
    [
      'a value that is an object',
      { rules: [{ when: [{ fact: 'a', op: 'eq', value: {} }], then: 'deny' }] },
    ],
    [
      'a list with an object in it',
      { rules: [{ when: [{ fact: 'a', op: 'in', value: [{}] }], then: 'deny' }] },
    ],
    ['approvers that are no list', { rules: [{ when: [], then: 'ask', approvers: 'x' }] }],
  ])('says unreadable for %s', (_why, config) => {
    expect(readRules(config).state).toBe('unreadable');
  });

  it('says unreadable for approvers that are neither a role nor a user, or both', () => {
    expect(readApprovers({ approvers: [{}] }).state).toBe('unreadable');
    expect(readApprovers({ approvers: [{ role: 'a', user: 'b' }] }).state).toBe('unreadable');
    expect(readApprovers({ approvers: [{ role: 'a', when: 'x' }] }).state).toBe('unreadable');
    expect(readApprovers({ approvers: 'x' }).state).toBe('unreadable');
  });

  it('says unreadable for a rule, condition or approver with a member the contract does not give', () => {
    const cond = { fact: 'amount', op: 'gt', value: 5 };
    expect(readRules({ rules: [{ when: [cond], then: 'ask', escalate_to: 'cfo' }] }).state).toBe(
      'unreadable'
    );
    expect(readRules({ rules: [{ when: [{ ...cond, note: 'x' }], then: 'deny' }] }).state).toBe(
      'unreadable'
    );
    expect(
      readRules({
        rules: [{ when: [cond], then: 'ask', approvers: [{ role: 'a', extra: 1 }] }],
      }).state
    ).toBe('unreadable');
    expect(readApprovers({ approvers: [{ role: 'finance', extra: 'x' }] }).state).toBe(
      'unreadable'
    );
    expect(
      readApprovers({ approvers: [{ role: 'a', when: [{ ...cond, note: 'x' }] }] }).state
    ).toBe('unreadable');
    expect(readRules({ rules: [{ when: [cond], then: 'ask' }] }).state).toBe('ok');
  });

  it('says unreadable for an exclude that is not a list of text', () => {
    expect(readExclude({ exclude: 'requester' }).state).toBe('unreadable');
    expect(readExclude({ exclude: [1] }).state).toBe('unreadable');
    expect(readExclude({ exclude: ['requester', 'other'] })).toEqual({
      state: 'ok',
      value: ['requester', 'other'],
    });
  });
});

describe('editing a list of rules', () => {
  const a = rule();
  const b = rule({ then: 'ask' });
  const c = rule({ then: 'always_allow' });

  it('adds at the end, removes by index, replaces by index, and never changes its argument', () => {
    const list = [a, b];
    expect(addRule(list, c)).toEqual([a, b, c]);
    expect(removeAt(list, 0)).toEqual([b]);
    expect(replaceAt(list, 1, c)).toEqual([a, c]);
    expect(list).toEqual([a, b]);
  });

  it('moves an item up or down, and leaves the ends and the out of range as they are', () => {
    const list = [a, b, c];
    expect(moveAt(list, 1, -1)).toEqual([b, a, c]);
    expect(moveAt(list, 1, 1)).toEqual([a, c, b]);
    expect(moveAt(list, 0, -1)).toEqual([a, b, c]);
    expect(moveAt(list, 2, 1)).toEqual([a, b, c]);
    expect(moveAt(list, 5, -1)).toEqual([a, b, c]);
    expect(moveAt(list, -1, 1)).toEqual([a, b, c]);
    expect(moveAt(list, 1, -1)).not.toBe(list);
  });

  it('starts a rule on a fact with the outcome ask, and a true-or-false fact at true', () => {
    expect(newRule({ name: 'amount', type: 'number' })).toEqual({
      when: [{ fact: 'amount', op: 'eq' }],
      then: 'ask',
    });
    expect(newCondition({ name: 'urgent', type: 'boolean' })).toEqual({
      fact: 'urgent',
      op: 'eq',
      value: true,
    });
    expect(newRule()).toEqual({ when: [{ fact: '', op: 'eq' }], then: 'ask' });
  });

  it('drops the approvers of a rule that stops asking, and keeps them while it asks', () => {
    const asking = rule({ then: 'ask', approvers: [{ role: 'lead' }] });
    expect(withOutcome(asking, 'deny')).toEqual({ when: asking.when, then: 'deny' });
    expect(withOutcome(asking, 'always_allow')).not.toHaveProperty('approvers');
    expect(withOutcome(asking, 'ask')).toEqual(asking);
    expect(withOutcome(rule(), 'ask')).toEqual({ ...rule(), then: 'ask' });
  });
});

describe('conditions: the test and the fact', () => {
  it('offers the tests of each fact type, and keeps a test the list would drop', () => {
    expect(opsFor('string')).toEqual(['eq', 'ne', 'in', 'not_in', 'exists']);
    expect(opsFor('boolean')).toEqual(['eq', 'ne', 'exists']);
    expect(opsFor('number')).toContain('gte');
    expect(opsFor('count')).toContain('lt');
    expect(opsFor('string')).not.toContain('gt');
    expect(opsFor(undefined)).toHaveLength(9);
    expect(opsFor('string', 'gt')).toEqual(['eq', 'ne', 'in', 'not_in', 'exists', 'gt']);
    expect(opsFor('string', 'eq')).toEqual(['eq', 'ne', 'in', 'not_in', 'exists']);
  });

  it('knows which tests take a list, none or one value', () => {
    expect(opShape('in')).toBe('list');
    expect(opShape('not_in')).toBe('list');
    expect(opShape('exists')).toBe('none');
    for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const)
      expect(opShape(op)).toBe('one');
  });

  it('keeps the value across tests that can use it, and shapes it for those that cannot', () => {
    expect(withOp({ fact: 'a', op: 'eq', value: 5 }, 'gt')).toEqual({
      fact: 'a',
      op: 'gt',
      value: 5,
    });
    expect(withOp({ fact: 'a', op: 'eq', value: 5 }, 'in')).toEqual({
      fact: 'a',
      op: 'in',
      value: [5],
    });
    expect(withOp({ fact: 'a', op: 'eq' }, 'in')).toEqual({ fact: 'a', op: 'in', value: [] });
    expect(withOp({ fact: 'a', op: 'in', value: [1, 2] }, 'not_in')).toEqual({
      fact: 'a',
      op: 'not_in',
      value: [1, 2],
    });
    expect(withOp({ fact: 'a', op: 'in', value: [1, 2] }, 'eq')).toEqual({
      fact: 'a',
      op: 'eq',
      value: 1,
    });
    expect(withOp({ fact: 'a', op: 'in', value: [] }, 'eq')).toEqual({ fact: 'a', op: 'eq' });
    expect(withOp({ fact: 'a', op: 'eq', value: 5 }, 'exists')).toEqual({
      fact: 'a',
      op: 'exists',
    });
    expect(withOp({ fact: 'a', op: 'exists' }, 'eq')).toEqual({ fact: 'a', op: 'eq' });
  });

  it('moves a condition to another fact: the test stays if the type offers it, and the value starts again', () => {
    expect(
      withFact({ fact: 'amount', op: 'gt', value: 5 }, { name: 'total', type: 'number' })
    ).toEqual({
      fact: 'total',
      op: 'gt',
    });
    expect(
      withFact({ fact: 'amount', op: 'gt', value: 5 }, { name: 'env', type: 'string' })
    ).toEqual({
      fact: 'env',
      op: 'eq',
    });
    expect(
      withFact({ fact: 'a', op: 'eq', value: 'x' }, { name: 'urgent', type: 'boolean' })
    ).toEqual({
      fact: 'urgent',
      op: 'eq',
      value: true,
    });
    expect(withFact({ fact: 'a', op: 'in', value: [1] }, { name: 'b', type: 'number' })).toEqual({
      fact: 'b',
      op: 'in',
      value: [],
    });
    expect(withFact({ fact: 'a', op: 'exists' }, { name: 'b', type: 'string' })).toEqual({
      fact: 'b',
      op: 'exists',
    });
    expect(withFact({ fact: 'a', op: 'gt', value: 1 }, { name: 'b' })).toEqual({
      fact: 'b',
      op: 'gt',
    });
  });
});

describe('approver entries and exclude', () => {
  it('reads the id of either kind, and changes the kind or the id keeping the entry’s when', () => {
    const when = [{ fact: 'env', op: 'eq', value: 'prod' } as const];
    expect(approverId({ role: 'lead' })).toBe('lead');
    expect(approverId({ user: 'u-1' })).toBe('u-1');
    expect(withApprover({ role: 'lead', when }, 'user', 'u-1')).toEqual({ user: 'u-1', when });
    expect(withApprover({ user: 'u-1' }, 'role', 'lead')).toEqual({ role: 'lead' });
    expect(withApprover({ role: 'lead' }, 'role', 'ops')).toEqual({ role: 'ops' });
  });

  it('puts requester in or out of exclude and leaves any other value', () => {
    expect(setRequesterExcluded([], true)).toEqual(['requester']);
    expect(setRequesterExcluded(['requester'], true)).toEqual(['requester']);
    expect(setRequesterExcluded(['requester', 'other'], false)).toEqual(['other']);
    expect(setRequesterExcluded(['other'], true)).toEqual(['other', 'requester']);
    expect(setRequesterExcluded([], false)).toEqual([]);
  });
});

describe('the facts a condition may name', () => {
  const tool = (
    toolRef: string,
    facts: Record<string, 'number' | 'string' | 'boolean' | 'count'>
  ) => ({
    toolRef,
    facts: Object.fromEntries(
      Object.entries(facts).map(([n, type]) => [n, { path: `.${n}`, type }])
    ),
  });
  const tools = [
    tool('a', { amount: 'number', env: 'string' }),
    tool('b', { amount: 'number', region: 'string' }),
    tool('c', { amount: 'string' }),
    { toolRef: 'd' },
  ];

  it('for named targets offers the facts every target declares, typed when the targets agree', () => {
    const named = factCatalogOf(tools, ['a', 'b']);
    expect(named.known).toBe(true);
    expect([...named.facts]).toEqual([['amount', { type: 'number' }]]);
    expect([...factCatalogOf(tools, ['a']).facts.keys()]).toEqual(['amount', 'env']);
  });

  it('gives a fact whose targets disagree on its type no type', () => {
    expect([...factCatalogOf(tools, ['a', 'c']).facts]).toEqual([['amount', { nonNumeric: true }]]);
  });

  it('for every tool offers the facts any declares', () => {
    expect([...factCatalogOf(tools, 'all').facts.keys()].sort()).toEqual([
      'amount',
      'env',
      'region',
    ]);
    expect([...factCatalogOf(tools, undefined).facts.keys()].sort()).toEqual([
      'amount',
      'env',
      'region',
    ]);
  });

  it('knows nothing when no target is a listed tool', () => {
    expect(factCatalogOf(tools, ['zzz'])).toEqual({ known: false, facts: new Map() });
    expect(factCatalogOf([], 'all').known).toBe(false);
  });

  it('is not registered when a target has facts it could not read, so nothing is refused for them', () => {
    const unreadable = { toolRef: 'u', factsUnreadable: true as const };
    expect(factCatalogOf([unreadable], ['u']).registered).toBeUndefined();
    expect(factCatalogOf([...tools, unreadable], ['a', 'u']).registered).toBeUndefined();
    const catalog = factCatalogOf([unreadable], ['u']);
    const checked = checkRules(
      { mode: 'ask', rules: [{ when: [{ fact: 'amount', op: 'gt', value: 5 }], then: 'deny' }] },
      catalog
    );
    expect(checked.problems).toEqual([]);
    expect(checked.warnings.map((w) => w.code)).toContain('fact_not_declared');
  });

  it('a target with no facts makes the intersection empty', () => {
    expect([...factCatalogOf(tools, ['a', 'd']).facts]).toEqual([]);
  });
});

describe('values typed into a condition', () => {
  it('reads a number for number and count facts, and for the ordering tests of any type', () => {
    expect(parseScalar('5000', 'number', 'eq')).toBe(5000);
    expect(parseScalar(' -1.5 ', 'count', 'ne')).toBe(-1.5);
    expect(parseScalar('7', 'string', 'gt')).toBe(7);
    expect(parseScalar('', 'number', 'eq')).toBeUndefined();
    expect(parseScalar('abc', 'number', 'eq')).toBeUndefined();
    expect(parseScalar('Infinity', 'number', 'eq')).toBeUndefined();
  });

  it('reads true or false for a boolean fact, and the text as it is for a string fact', () => {
    expect(parseScalar('true', 'boolean', 'eq')).toBe(true);
    expect(parseScalar('false', 'boolean', 'ne')).toBe(false);
    expect(parseScalar('yes', 'boolean', 'eq')).toBeUndefined();
    expect(parseScalar('prod', 'string', 'eq')).toBe('prod');
    expect(parseScalar('42', 'string', 'eq')).toBe('42');
    expect(parseScalar('', 'string', 'eq')).toBeUndefined();
  });

  it('reads JSON for a fact of no known type, and the text when it is not JSON', () => {
    expect(parseScalar('5000', undefined, 'eq')).toBe(5000);
    expect(parseScalar('"prod"', undefined, 'eq')).toBe('prod');
    expect(parseScalar('true', undefined, 'eq')).toBe(true);
    expect(parseScalar('null', undefined, 'eq')).toBeNull();
    expect(parseScalar('prod', undefined, 'eq')).toBe('prod');
    expect(parseScalar('[1]', undefined, 'eq')).toBe('[1]');
    expect(parseScalar('', undefined, 'eq')).toBeUndefined();
  });

  it('shows a value as the text of an input', () => {
    expect(scalarText('prod')).toBe('prod');
    expect(scalarText(5)).toBe('5');
    expect(scalarText(false)).toBe('false');
    expect(scalarText(null)).toBe('null');
    expect(scalarText(undefined)).toBe('');
  });

  it('reads a value per line, dropping a line that is not one', () => {
    expect(parseScalarLines('1\n2\n\nx\n 3 ', 'number', 'in')).toEqual([1, 2, 3]);
    expect(parseScalarLines('a\n\nb', 'string', 'not_in')).toEqual(['a', 'b']);
    expect(parseScalarLines('', 'string', 'in')).toEqual([]);
  });
});

describe('checkRules: what the contract refuses', () => {
  it('finds nothing wrong with a sound configuration', () => {
    expect(
      codes({
        mode: 'ask',
        rules: [
          rule(),
          rule({
            when: [
              { fact: 'env', op: 'in', value: ['prod'] },
              { fact: 'urgent', op: 'eq', value: true },
            ],
            then: 'ask',
            approvers: [{ role: 'lead' }],
          }),
        ],
        approvers: [{ role: 'finance', when: [{ fact: 'amount', op: 'exists' }] }],
        exclude: ['requester'],
      })
    ).toEqual({ problems: [], warnings: [] });
  });

  it('flags an empty rules list, too many rules, an empty or too long when', () => {
    expect(codes({ mode: 'ask', rules: [] }).problems).toEqual(['rules:rules_empty']);
    const many = Array.from({ length: 33 }, () => rule());
    expect(codes({ mode: 'ask', rules: many }).problems).toEqual(['rules:rules_too_many']);
    expect(
      codes({ mode: 'ask', rules: Array.from({ length: 32 }, () => rule()) }).problems
    ).toEqual([]);
    expect(codes({ mode: 'ask', rules: [{ when: [], then: 'deny' }] }).problems).toEqual([
      'rules[0].when:when_empty',
    ]);
    const nine = Array.from({ length: 9 }, () => amountGt(1));
    expect(codes({ mode: 'ask', rules: [{ when: nine, then: 'deny' }] }).problems).toEqual([
      'rules[0].when:when_too_many',
    ]);
    expect(
      codes({ mode: 'ask', rules: [{ when: nine.slice(0, 8), then: 'deny' }] }).problems
    ).toEqual([]);
  });

  it('flags a condition with no fact, and one whose value does not fit its test', () => {
    const problems = (when: RuleCondition[]) =>
      codes({ mode: 'ask', rules: [{ when, then: 'deny' }] }).problems;
    expect(problems([{ fact: '', op: 'exists' }])).toEqual(['rules[0].when[0].fact:fact_missing']);
    expect(problems([{ fact: 'amount', op: 'eq' }])).toEqual([
      'rules[0].when[0].value:value_missing',
    ]);
    // The empty string is a value the contract takes, so a rule that holds one is not refused.
    expect(problems([{ fact: 'env', op: 'eq', value: '' }])).toEqual([]);
    expect(problems([{ fact: 'amount', op: 'eq', value: [1] }])).toEqual([
      'rules[0].when[0].value:value_missing',
    ]);
    expect(problems([{ fact: 'amount', op: 'gt', value: 'x' }])).toEqual([
      'rules[0].when[0].value:value_not_number',
    ]);
    expect(problems([{ fact: 'amount', op: 'exists', value: 1 }])).toEqual([
      'rules[0].when[0].value:value_unexpected',
    ]);
    expect(problems([{ fact: 'env', op: 'in' }])).toEqual(['rules[0].when[0].value:list_empty']);
    expect(problems([{ fact: 'env', op: 'in', value: [] }])).toEqual([
      'rules[0].when[0].value:list_empty',
    ]);
    expect(problems([{ fact: 'env', op: 'in', value: 'prod' }])).toEqual([
      'rules[0].when[0].value:list_empty',
    ]);
    const hundred = Array.from({ length: 100 }, (_, i) => i);
    expect(problems([{ fact: 'amount', op: 'in', value: hundred }])).toEqual([]);
    expect(problems([{ fact: 'amount', op: 'in', value: [...hundred, 100] }])).toEqual([
      'rules[0].when[0].value:list_too_long',
    ]);
    expect(problems([{ fact: 'urgent', op: 'eq', value: false }])).toEqual([]);
    expect(problems([{ fact: 'env', op: 'eq', value: null }])).toEqual([]);
    expect(problems([{ fact: 'amount', op: 'eq', value: 0 }])).toEqual([]);
  });

  it('flags approvers on a rule that does not ask, empty approvers, too many, and an entry with no id', () => {
    expect(
      codes({ mode: 'ask', rules: [rule({ then: 'deny', approvers: [{ role: 'lead' }] })] })
        .problems
    ).toEqual(['rules[0].approvers:approvers_with_outcome']);
    expect(codes({ mode: 'ask', rules: [rule({ then: 'ask', approvers: [] })] }).problems).toEqual([
      'rules[0].approvers:approvers_empty',
    ]);
    expect(codes({ mode: 'ask', approvers: [] }).problems).toEqual(['approvers:approvers_empty']);
    const thirtyThree = Array.from({ length: 33 }, (_, i) => ({ role: `r${String(i)}` }));
    expect(codes({ mode: 'ask', approvers: thirtyThree }).problems).toEqual([
      'approvers:approvers_too_many',
    ]);
    expect(codes({ mode: 'ask', approvers: thirtyThree.slice(0, 32) }).problems).toEqual([]);
    expect(codes({ mode: 'ask', approvers: [{ role: '' }] }).problems).toEqual([
      'approvers[0].role:approver_id_missing',
    ]);
    expect(codes({ mode: 'ask', approvers: [{ user: '' }] }).problems).toEqual([
      'approvers[0].user:approver_id_missing',
    ]);
  });

  it('checks the when of an approver entry like any other', () => {
    expect(
      codes({ mode: 'ask', approvers: [{ role: 'a', when: [{ fact: 'amount', op: 'gt' }] }] })
        .problems
    ).toEqual(['approvers[0].when[0].value:value_missing']);
    expect(codes({ mode: 'ask', approvers: [{ role: 'a', when: [] }] }).problems).toEqual([
      'approvers[0].when:when_empty',
    ]);
  });

  it('does not check a member it could not read', () => {
    expect(codes({ mode: 'ask', rules: 'x', approvers: [3], exclude: 'x' })).toEqual({
      problems: [],
      warnings: [],
    });
  });
});

describe('checkRules: what the contract accepts', () => {
  it('warns about a fact the targets do not declare and a test their type does not take', () => {
    expect(
      codes({ mode: 'ask', rules: [{ when: [{ fact: 'ghost', op: 'exists' }], then: 'deny' }] })
        .warnings
    ).toEqual(['rules[0].when[0].fact:fact_not_declared']);
    expect(
      codes({ mode: 'ask', rules: [{ when: [{ fact: 'env', op: 'gt', value: 1 }], then: 'deny' }] })
        .warnings
    ).toEqual(['rules[0].when[0].op:op_not_for_type']);
    // A fact whose type the targets disagree on takes any test.
    expect(
      codes(
        { mode: 'ask', rules: [{ when: [{ fact: 'x', op: 'gt', value: 1 }], then: 'deny' }] },
        catalog({ x: undefined })
      ).warnings
    ).toEqual([]);
  });

  it('treats an undeclared fact and an order test on a non-numeric fact as problems where every target is registered', () => {
    const registered = factCatalogOf(
      [
        {
          toolRef: 't',
          facts: {
            amount: { path: '.amount', type: 'number' },
            env: { path: '.env', type: 'string' },
            urgent: { path: '.urgent', type: 'boolean' },
          },
        },
      ],
      ['t']
    );
    expect(registered.registered).toBe(true);
    expect(
      codes(
        { mode: 'ask', rules: [{ when: [{ fact: 'ghost', op: 'exists' }], then: 'deny' }] },
        registered
      )
    ).toEqual({ problems: ['rules[0].when[0].fact:fact_not_declared'], warnings: [] });
    expect(
      codes(
        { mode: 'ask', rules: [{ when: [{ fact: 'env', op: 'gt', value: 1 }], then: 'deny' }] },
        registered
      )
    ).toEqual({ problems: ['rules[0].when[0].op:op_not_for_type'], warnings: [] });
    // Another mismatch the contract accepts stays a warning.
    expect(
      codes(
        {
          mode: 'ask',
          rules: [{ when: [{ fact: 'urgent', op: 'in', value: [true] }], then: 'deny' }],
        },
        registered
      )
    ).toEqual({ problems: [], warnings: ['rules[0].when[0].op:op_not_for_type'] });
    // The same in an approver's own conditions.
    expect(
      codes(
        {
          mode: 'ask',
          approvers: [{ role: 'a', when: [{ fact: 'ghost', op: 'exists' }] }],
        },
        registered
      ).problems
    ).toEqual(['approvers[0].when[0].fact:fact_not_declared']);
  });

  it('refuses an order test on a fact whose targets disagree when one declares it non-numeric', () => {
    const tool = (toolRef: string, type: 'number' | 'string') => ({
      toolRef,
      facts: { amount: { path: '.amount', type } },
    });
    const tools = [tool('a', 'number'), tool('b', 'string')];
    const mixed = factCatalogOf(tools, ['a', 'b']);
    expect(mixed.registered).toBe(true);
    expect(
      codes({ mode: 'ask', rules: [{ when: [amountGt(1)], then: 'deny' }] }, mixed).problems
    ).toEqual(['rules[0].when[0].op:op_not_for_type']);
    // Two numeric targets that disagree (number, count) are fine.
    const both = factCatalogOf(
      [
        { toolRef: 'a', facts: { n: { path: '.n', type: 'number' as const } } },
        { toolRef: 'b', facts: { n: { path: '.n', type: 'count' as const } } },
      ],
      ['a', 'b']
    );
    expect(
      codes(
        { mode: 'ask', rules: [{ when: [{ fact: 'n', op: 'gt', value: 1 }], then: 'deny' }] },
        both
      )
    ).toEqual({ problems: [], warnings: [] });
  });

  it('is registered only for named targets that are all listed tools', () => {
    const tools = [{ toolRef: 'a' }, { toolRef: 'b' }];
    expect(factCatalogOf(tools, ['a', 'b']).registered).toBe(true);
    expect(factCatalogOf(tools, ['a', 'zzz']).registered).toBeUndefined();
    expect(factCatalogOf(tools, 'all').registered).toBeUndefined();
    expect(factCatalogOf(tools, undefined).registered).toBeUndefined();
  });

  it('names no fact undeclared when no target tool is known', () => {
    expect(
      codes(
        { mode: 'ask', rules: [{ when: [{ fact: 'ghost', op: 'exists' }], then: 'deny' }] },
        { known: false, facts: new Map() }
      ).warnings
    ).toEqual([]);
  });

  it('warns that policy approvers are unreachable when no outcome can ask them', () => {
    expect(codes({ mode: 'deny', approvers: [{ role: 'a' }] }).warnings).toEqual([
      'approvers:approvers_unreachable',
    ]);
    expect(codes({ mode: 'ask', approvers: [{ role: 'a' }] }).warnings).toEqual([]);
    expect(codes({ mode: 'escalate', approvers: [{ role: 'a' }] }).warnings).toEqual([]);
    // A rule that asks, with none of its own, reaches the policy's approvers.
    expect(
      codes({ mode: 'deny', rules: [rule({ then: 'ask' })], approvers: [{ role: 'a' }] }).warnings
    ).toEqual([]);
    // A rule that asks with its own approvers does not.
    expect(
      codes({
        mode: 'deny',
        rules: [rule({ then: 'ask', approvers: [{ role: 'b' }] })],
        approvers: [{ role: 'a' }],
      }).warnings
    ).toEqual(['approvers:approvers_unreachable']);
  });

  it('warns that exclude is unreachable only when nothing can ask at all', () => {
    expect(codes({ mode: 'deny', exclude: ['requester'] }).warnings).toEqual([
      'exclude:exclude_unreachable',
    ]);
    expect(codes({ mode: 'ask', exclude: ['requester'] }).warnings).toEqual([]);
    expect(
      codes({ mode: 'deny', rules: [rule({ then: 'ask' })], exclude: ['requester'] }).warnings
    ).toEqual([]);
    // A rule that tests a fact other than by `exists` may stop the walk with an ask.
    expect(codes({ mode: 'deny', rules: [rule()], exclude: ['requester'] }).warnings).toEqual([]);
    expect(
      codes({
        mode: 'deny',
        rules: [{ when: [{ fact: 'amount', op: 'exists' }], then: 'deny' }],
        exclude: ['requester'],
      }).warnings
    ).toEqual(['exclude:exclude_unreachable']);
    expect(codes({ mode: 'deny', exclude: [] }).warnings).toEqual([]);
  });
});
