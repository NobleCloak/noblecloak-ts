import { describe, expect, it } from 'vitest';

import {
  FACT_PATH,
  MAX_FACTS,
  MAX_FACT_PATH,
  checkFactRows,
  factRowOfMember,
  factRowsOf,
} from './connections-facts.js';
import type { FactRow } from './connections-facts.js';
import { connectionToolOf, connectionsCapabilitiesOf } from './connections-parse.js';

const row = (over: Partial<FactRow> = {}): FactRow => ({
  name: 'amount',
  path: '.amount',
  type: 'number',
  description: '',
  ...over,
});

const problems = (rows: FactRow[]) => {
  const checked = checkFactRows(rows);
  return checked.ok ? [] : checked.errors.map((e) => `${String(e.row)}:${e.field}:${e.problem}`);
};

describe('checkFactRows', () => {
  it('builds the map to send, leaving a blank description out', () => {
    expect(
      checkFactRows([
        row(),
        row({ name: 'to', path: '.to', type: 'count', description: 'recipients' }),
      ])
    ).toEqual({
      ok: true,
      facts: {
        amount: { path: '.amount', type: 'number' },
        to: { path: '.to', type: 'count', description: 'recipients' },
      },
    });
  });

  it('accepts no rows as an empty map', () => {
    expect(checkFactRows([])).toEqual({ ok: true, facts: {} });
  });

  it.each(['Amount', '1amount', '', 'a-b', 'a'.repeat(64)])('refuses the name %j', (name) => {
    expect(problems([row({ name })])).toEqual(['0:name:name_invalid']);
  });

  it.each(['a', 'a_1', 'a'.repeat(63)])('accepts the name %j', (name) => {
    expect(problems([row({ name })])).toEqual([]);
  });

  it('refuses a repeated name on the later row, once', () => {
    expect(problems([row(), row({ path: '.b' }), row({ path: '.c' })])).toEqual([
      '1:name:name_duplicate',
      '2:name:name_duplicate',
    ]);
  });

  it.each(['.amount', '.target.env', '.lines[0].price', '[0]', '.a-b._c', '.a[1][2]'])(
    'accepts the path %j',
    (path) => {
      expect(FACT_PATH.test(path)).toBe(true);
    }
  );

  it.each(['', 'amount', '.', '..key', '.items[*]', '.a[-1]', '.1a', '.a b', '.a.', '.a[]'])(
    'refuses the path %j',
    (path) => {
      expect(problems([row({ path })])).toEqual(['0:path:path_invalid']);
    }
  );

  it('limits a path to 512 characters', () => {
    const path = (length: number): string => `.${'a'.repeat(length - 1)}`;
    expect(problems([row({ path: path(MAX_FACT_PATH) })])).toEqual([]);
    expect(problems([row({ path: path(MAX_FACT_PATH + 1) })])).toEqual(['0:path:path_invalid']);
  });

  it('needs a known type', () => {
    expect(problems([row({ type: '' })])).toEqual(['0:type:type_missing']);
    expect(problems([row({ type: 'float' })])).toEqual(['0:type:type_missing']);
    for (const type of ['number', 'string', 'boolean', 'count'])
      expect(problems([row({ type })])).toEqual([]);
  });

  it('limits the description to 500 characters', () => {
    expect(problems([row({ description: 'x'.repeat(500) })])).toEqual([]);
    expect(problems([row({ description: 'x'.repeat(501) })])).toEqual([
      '0:description:description_too_long',
    ]);
  });

  it('allows 32 facts and marks the first row over the limit', () => {
    const rows = (count: number): FactRow[] =>
      Array.from({ length: count }, (_, i) => row({ name: `f${String(i)}` }));
    expect(problems(rows(MAX_FACTS))).toEqual([]);
    expect(problems(rows(MAX_FACTS + 1))).toEqual([`${String(MAX_FACTS)}:name:too_many`]);
  });

  it('returns every refusal, not the first', () => {
    expect(problems([row({ name: 'X', path: 'x', type: '' })])).toEqual([
      '0:name:name_invalid',
      '0:path:path_invalid',
      '0:type:type_missing',
    ]);
  });
});

describe('factRowsOf', () => {
  it('lists the rows in the order of the map, a missing description as empty', () => {
    expect(
      factRowsOf({
        b: { path: '.b', type: 'string', description: 'bee' },
        a: { path: '.a', type: 'count' },
      })
    ).toEqual([
      { name: 'b', path: '.b', type: 'string', description: 'bee' },
      { name: 'a', path: '.a', type: 'count', description: '' },
    ]);
    expect(factRowsOf(undefined)).toEqual([]);
  });
});

describe('factRowOfMember', () => {
  const rows = [row(), row({ name: 'to', path: '.to' })];
  it('names the row and the field of a refused member', () => {
    expect(factRowOfMember('facts.to.path', rows)).toEqual({ row: 1, field: 'path' });
    expect(factRowOfMember('facts.amount.type', rows)).toEqual({ row: 0, field: 'type' });
    expect(factRowOfMember('facts.amount.description', rows)).toEqual({
      row: 0,
      field: 'description',
    });
    expect(factRowOfMember('facts.amount', rows)).toEqual({ row: 0, field: 'name' });
  });
  it('names nothing for another member, a fact that is not a row, or no member', () => {
    expect(factRowOfMember('side_effect_level', rows)).toBeUndefined();
    expect(factRowOfMember('facts.gone.path', rows)).toBeUndefined();
    expect(factRowOfMember('facts.amount.path.deeper', rows)).toBeUndefined();
    expect(factRowOfMember(undefined, rows)).toBeUndefined();
  });
});

describe('reading a tool with facts', () => {
  const tool = {
    id: 't1',
    tool_ref: 'one/pay',
    transport: 'mcp',
    side_effect_level: 'write',
  };

  it('keeps the facts of a tool', () => {
    expect(
      connectionToolOf({
        ...tool,
        facts: { amount: { path: '.amount', type: 'number', description: 'how much' } },
      })
    ).toMatchObject({
      facts: { amount: { path: '.amount', type: 'number', description: 'how much' } },
    });
  });

  it('has no facts for a tool without the member, or with null', () => {
    for (const facts of [undefined, null]) {
      const read = connectionToolOf({ ...tool, facts });
      expect(read).toBeDefined();
      expect(read?.facts).toBeUndefined();
      expect(read?.factsUnreadable).toBeUndefined();
    }
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['a binding that is no object', { a: 3 }],
    ['a path that is no string', { a: { path: 1, type: 'number' } }],
    ['a type it does not know', { a: { path: '.a', type: 'float' } }],
    ['a description that is no string', { a: { path: '.a', type: 'number', description: 4 } }],
    ['one readable and one not', { a: { path: '.a', type: 'number' }, b: 7 }],
  ])('marks the facts unreadable, and keeps none, when they are %s', (_why, facts) => {
    const read = connectionToolOf({ ...tool, facts });
    expect(read).toMatchObject({ id: 't1', factsUnreadable: true });
    expect(read?.facts).toBeUndefined();
  });
});

describe('the tools.facts capability', () => {
  it('is set when advertised and absent otherwise', () => {
    expect(
      connectionsCapabilitiesOf({ data: { features: ['connections', 'tools.facts'] } })
    ).toMatchObject({ toolFacts: true });
    expect(connectionsCapabilitiesOf({ data: { features: ['connections'] } })).not.toHaveProperty(
      'toolFacts'
    );
  });
});
