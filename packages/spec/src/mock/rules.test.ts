/**
 * The pure pieces of rev 16 the mock evaluates with: reading a fact through its binding, testing a condition, walking
 * a policy's rules, and the approver entries in force.
 */
import { describe, expect, it } from 'vitest';

import {
  approversInForce,
  conditionTruth,
  readFact,
  readFacts,
  refusedCondition,
  walkRules,
} from './rules.js';
import type { Condition, FactBindings, Rule } from './rules.js';

const bindings = {
  amount: { path: '.amount', type: 'number' },
  currency: { path: '.currency', type: 'string' },
  urgent: { path: '.flags.urgent', type: 'boolean' },
  recipients: { path: '.to', type: 'count' },
  first: { path: '.lines[0].price', type: 'number' },
  dashed: { path: '.a-b', type: 'string' },
} as const satisfies FactBindings;

describe('readFact', () => {
  it('reads a value of the binding type along a path of members and indexes', () => {
    const args = {
      amount: 42,
      currency: 'EUR',
      flags: { urgent: false },
      to: ['a', 'b', 'c'],
      lines: [{ price: 9.5 }],
      'a-b': 'x',
    };
    expect(readFact(args, bindings.amount)).toEqual({ value: 42 });
    expect(readFact(args, bindings.currency)).toEqual({ value: 'EUR' });
    expect(readFact(args, bindings.urgent)).toEqual({ value: false });
    expect(readFact(args, bindings.recipients)).toEqual({ value: 3 });
    expect(readFact(args, bindings.first)).toEqual({ value: 9.5 });
    expect(readFact(args, bindings.dashed)).toEqual({ value: 'x' });
  });

  it('gives no value for a missing path, a value of another type, no arguments, or a path outside the subset', () => {
    expect(readFact({}, bindings.amount)).toBeUndefined();
    expect(readFact({ amount: '42' }, bindings.amount)).toBeUndefined();
    expect(readFact({ amount: null }, bindings.amount)).toBeUndefined();
    expect(readFact({ amount: Number.NaN }, bindings.amount)).toBeUndefined();
    expect(readFact({ to: 'a' }, bindings.recipients)).toBeUndefined();
    expect(readFact({ flags: 'no' }, bindings.urgent)).toBeUndefined();
    expect(readFact({ lines: { 0: { price: 1 } } }, bindings.first)).toBeUndefined();
    expect(readFact({ lines: [] }, bindings.first)).toBeUndefined();
    expect(readFact([1], { path: '.amount', type: 'number' })).toBeUndefined();
    expect(readFact(undefined, bindings.amount)).toBeUndefined();
    expect(readFact({ lines: [{ price: 1 }] }, { path: '.lines[*].price', type: 'number' })).toBe(
      undefined
    );
    expect(readFact({ amount: 1 }, { path: '..amount', type: 'number' })).toBeUndefined();
    // A member inherited from the prototype is not a member of the arguments.
    expect(readFact({}, { path: '.constructor', type: 'string' })).toBeUndefined();
  });

  it('reads every binding of a tool at once, leaving out the facts with no value', () => {
    const facts = readFacts({ amount: 5, currency: 7 }, bindings);
    expect([...facts.entries()]).toEqual([['amount', 5]]);
    expect(readFacts(undefined, bindings).size).toBe(0);
    expect(readFacts({ amount: 5 }, undefined).size).toBe(0);
  });
});

describe('conditionTruth', () => {
  const facts = new Map<string, string | number | boolean>([
    ['amount', 300],
    ['currency', 'EUR'],
    ['urgent', true],
  ]);
  const truth = (condition: Condition): string => conditionTruth(condition, facts);

  it('tests each operator', () => {
    expect(truth({ fact: 'currency', op: 'eq', value: 'EUR' })).toBe('true');
    expect(truth({ fact: 'currency', op: 'eq', value: 'USD' })).toBe('false');
    expect(truth({ fact: 'amount', op: 'eq', value: '300' })).toBe('false');
    expect(truth({ fact: 'currency', op: 'ne', value: 'USD' })).toBe('true');
    expect(truth({ fact: 'urgent', op: 'ne', value: true })).toBe('false');
    expect(truth({ fact: 'currency', op: 'in', value: ['USD', 'EUR'] })).toBe('true');
    expect(truth({ fact: 'currency', op: 'in', value: ['USD'] })).toBe('false');
    expect(truth({ fact: 'currency', op: 'not_in', value: ['USD'] })).toBe('true');
    expect(truth({ fact: 'currency', op: 'not_in', value: ['EUR'] })).toBe('false');
    expect(truth({ fact: 'amount', op: 'gt', value: 299 })).toBe('true');
    expect(truth({ fact: 'amount', op: 'gt', value: 300 })).toBe('false');
    expect(truth({ fact: 'amount', op: 'gte', value: 300 })).toBe('true');
    expect(truth({ fact: 'amount', op: 'lt', value: 300 })).toBe('false');
    expect(truth({ fact: 'amount', op: 'lte', value: 300 })).toBe('true');
    expect(truth({ fact: 'amount', op: 'exists' })).toBe('true');
  });

  it('is unevaluable for a fact with no value, except under exists, where it is false', () => {
    expect(truth({ fact: 'environment', op: 'eq', value: 'production' })).toBe('unevaluable');
    expect(truth({ fact: 'environment', op: 'ne', value: 'production' })).toBe('unevaluable');
    expect(truth({ fact: 'environment', op: 'in', value: ['production'] })).toBe('unevaluable');
    expect(truth({ fact: 'environment', op: 'exists' })).toBe('false');
  });

  it('is unevaluable for a comparison of a value that is not a number', () => {
    expect(truth({ fact: 'currency', op: 'gt', value: 1 })).toBe('unevaluable');
    expect(truth({ fact: 'amount', op: 'gt', value: '1' })).toBe('unevaluable');
  });
});

describe('walkRules', () => {
  const rules: Rule[] = [
    { when: [{ fact: 'amount', op: 'gt', value: 5000 }], then: 'deny' },
    { when: [{ fact: 'amount', op: 'lte', value: 50 }], then: 'always_allow' },
    {
      when: [{ fact: 'amount', op: 'lte', value: 500 }],
      then: 'ask',
      approvers: [{ role: 'team_lead' }],
    },
  ];
  const facts = (amount?: number): Map<string, number> =>
    new Map(amount === undefined ? [] : [['amount', amount]]);

  it('gives the first rule that matches, and mode when none does', () => {
    expect(walkRules({ mode: 'ask', rules }, facts(6000))).toEqual({
      result: 'deny',
      rule: { index: 0, then: 'deny' },
    });
    expect(walkRules({ mode: 'ask', rules }, facts(20))).toEqual({
      result: 'always_allow',
      rule: { index: 1, then: 'always_allow' },
    });
    expect(walkRules({ mode: 'ask', rules }, facts(300))).toEqual({
      result: 'ask',
      rule: { index: 2, then: 'ask' },
      approvers: [{ role: 'team_lead' }],
    });
    expect(walkRules({ mode: 'escalate', rules }, facts(1000))).toEqual({ result: 'escalate' });
    expect(walkRules({ mode: 'deny' }, facts(1))).toEqual({ result: 'deny' });
  });

  it('stops at a rule with an unevaluable condition and asks, naming the facts with no value', () => {
    expect(walkRules({ mode: 'always_allow', rules }, facts())).toEqual({
      result: 'ask',
      missing_facts: ['amount'],
      approvers: [],
    });
  });

  it("routes a stopped walk to the stopping ask rule's approvers, else to none, never to the policy's", () => {
    const asking: Rule[] = [
      {
        when: [{ fact: 'amount', op: 'gt', value: 1000 }],
        then: 'ask',
        approvers: [{ role: 'cfo' }],
      },
    ];
    expect(walkRules({ mode: 'ask', rules: asking }, facts())).toEqual({
      result: 'ask',
      missing_facts: ['amount'],
      approvers: [{ role: 'cfo' }],
    });
    const bare: Rule[] = [{ when: [{ fact: 'amount', op: 'gt', value: 1000 }], then: 'ask' }];
    expect(walkRules({ mode: 'ask', rules: bare }, facts())).toMatchObject({ approvers: [] });
  });

  it('skips a rule with a false condition whatever its other conditions, before one it cannot evaluate', () => {
    const mixed: Rule[] = [
      {
        when: [
          { fact: 'amount', op: 'gt', value: 100 },
          { fact: 'currency', op: 'eq', value: 'EUR' },
        ],
        then: 'deny',
      },
      { when: [{ fact: 'amount', op: 'lte', value: 100 }], then: 'always_allow' },
      { when: [{ fact: 'region', op: 'eq', value: 'eu' }], then: 'deny' },
    ];
    // amount 50: the first rule is false (whatever currency is), the second matches.
    expect(walkRules({ mode: 'ask', rules: mixed }, facts(50))).toEqual({
      result: 'always_allow',
      rule: { index: 1, then: 'always_allow' },
    });
    // amount 500: the first rule cannot be evaluated (no currency), so the walk stops there and asks.
    expect(walkRules({ mode: 'ask', rules: mixed }, facts(500))).toEqual({
      result: 'ask',
      missing_facts: ['currency'],
      approvers: [],
    });
  });

  it('names each missing fact once, in the order the rule names them', () => {
    const rule: Rule = {
      when: [
        { fact: 'region', op: 'eq', value: 'eu' },
        { fact: 'tier', op: 'in', value: [1] },
        { fact: 'region', op: 'ne', value: 'us' },
      ],
      then: 'deny',
    };
    expect(walkRules({ mode: 'ask', rules: [rule] }, facts(1))).toEqual({
      result: 'ask',
      missing_facts: ['region', 'tier'],
      approvers: [],
    });
  });
});

describe('approversInForce', () => {
  it('keeps the entries whose when holds, dropping false and unevaluable ones, and drops when', () => {
    const facts = new Map<string, string>([['environment', 'production']]);
    expect(
      approversInForce(
        [
          { role: 'finance' },
          { user: 'u1', when: [{ fact: 'environment', op: 'eq', value: 'production' }] },
          { user: 'u2', when: [{ fact: 'environment', op: 'eq', value: 'staging' }] },
          { role: 'ops', when: [{ fact: 'region', op: 'eq', value: 'eu' }] },
        ],
        facts
      )
    ).toEqual([{ role: 'finance' }, { user: 'u1' }]);
    expect(approversInForce(undefined, facts)).toEqual([]);
  });

  it('keeps an entry listed twice once, whether or not its when differs', () => {
    const facts = new Map<string, string>([['environment', 'production']]);
    expect(
      approversInForce(
        [
          { role: 'finance' },
          { user: 'u1' },
          { role: 'finance', when: [{ fact: 'environment', op: 'eq', value: 'production' }] },
          { user: 'u1' },
        ],
        facts
      )
    ).toEqual([{ role: 'finance' }, { user: 'u1' }]);
  });
});

describe('refusedCondition', () => {
  const declared = { amount: 'number', currency: 'string', recipients: 'count' } as const;

  it('names a condition whose fact a tool does not declare, or that compares a fact that is not numeric', () => {
    expect(refusedCondition({ fact: 'amount', op: 'gt', value: 1 }, [declared])).toBeUndefined();
    expect(
      refusedCondition({ fact: 'recipients', op: 'lte', value: 1 }, [declared])
    ).toBeUndefined();
    expect(
      refusedCondition({ fact: 'currency', op: 'eq', value: 'EUR' }, [declared])
    ).toBeUndefined();
    expect(refusedCondition({ fact: 'region', op: 'eq', value: 'eu' }, [declared])).toMatch(
      /declares no fact region/
    );
    expect(refusedCondition({ fact: 'currency', op: 'gt', value: 1 }, [declared])).toMatch(
      /neither a number nor a count/
    );
    // Every targeted tool must declare it.
    expect(
      refusedCondition({ fact: 'amount', op: 'gt', value: 1 }, [declared, { currency: 'string' }])
    ).toMatch(/declares no fact amount/);
  });
});
