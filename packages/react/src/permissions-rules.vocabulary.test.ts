import { loadDocument } from '@noblecloak/spec';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  FACT_NAME,
  FACT_PATH,
  FACT_TYPES,
  MAX_FACTS,
  MAX_FACT_DESCRIPTION,
  MAX_FACT_PATH,
} from './connections-facts.js';
import {
  APPROVAL_ROUTING_MEMBERS,
  CONDITION_OPS,
  EXCLUDE_VALUES,
  OPS_BY_FACT_TYPE,
  RULE_CONFIG_MEMBERS,
  RULE_LIMITS,
  RULE_OUTCOMES,
} from './permissions-vocabulary.js';

type Json = Record<string, unknown>;

let spec: Json;
beforeAll(() => {
  spec = loadDocument();
  // Loading the contract parses a large YAML document: slow when the machine is busy.
}, 60_000);

const schema = (name: string): Json => ((spec.components as Json).schemas as Json)[name] as Json;
const member = (name: string, key: string): Json => (schema(name).properties as Json)[key] as Json;

describe("the rev 16 vocabulary is the contract's", () => {
  it('CONDITION_OPS is PolicyCondition.op, in order', () => {
    expect([...CONDITION_OPS]).toEqual(member('PolicyCondition', 'op').enum);
  });

  it('RULE_OUTCOMES is PolicyRule.then, in order', () => {
    expect([...RULE_OUTCOMES]).toEqual(member('PolicyRule', 'then').enum);
  });

  it('EXCLUDE_VALUES is the one value of ToolInvocationConfig.exclude', () => {
    expect([...EXCLUDE_VALUES]).toEqual(
      (member('ToolInvocationConfig', 'exclude').items as Json).enum
    );
  });

  it('RULE_LIMITS are the limits of rules, conditions, list values and approvers', () => {
    expect(RULE_LIMITS.rules).toBe(member('ToolInvocationConfig', 'rules').maxItems);
    expect(RULE_LIMITS.approvers).toBe(member('ToolInvocationConfig', 'approvers').maxItems);
    expect(RULE_LIMITS.approvers).toBe(member('PolicyRule', 'approvers').maxItems);
    expect(RULE_LIMITS.conditions).toBe(schema('PolicyConditions').maxItems);
    const list = (schema('PolicyCondition').allOf as { then: Json }[]).find((clause) =>
      JSON.stringify(clause.then).includes('maxItems')
    );
    expect(RULE_LIMITS.listValues).toBe(((list?.then.properties as Json).value as Json).maxItems);
  });

  it('every rev 16 config member is a member of ToolInvocationConfig', () => {
    const members = Object.keys(schema('ToolInvocationConfig').properties as Json);
    for (const name of RULE_CONFIG_MEMBERS) expect(members).toContain(name);
  });

  it('APPROVAL_ROUTING_MEMBERS is the members of ApprovalRoutingConfig', () => {
    expect([...APPROVAL_ROUTING_MEMBERS]).toEqual(
      Object.keys(schema('ApprovalRoutingConfig').properties as Json)
    );
  });

  it('only number and count facts take the ordering tests, as the contract says', () => {
    const ordering = ['gt', 'gte', 'lt', 'lte'] as const;
    const clause = (schema('PolicyCondition').allOf as { if: Json }[]).find((c) =>
      JSON.stringify(c.if).includes('"gt"')
    );
    expect(((clause?.if.properties as Json).op as Json).enum).toEqual([...ordering]);
    for (const type of FACT_TYPES) {
      const offered = OPS_BY_FACT_TYPE[type] ?? [];
      const takesOrdering = type === 'number' || type === 'count';
      for (const op of ordering) expect(offered.includes(op)).toBe(takesOrdering);
      // Every test offered is one the contract has.
      for (const op of offered) expect(CONDITION_OPS).toContain(op);
    }
  });
});

describe("the fact binding rules are the contract's", () => {
  const binding = (): Json => schema('FactBinding');

  it('FACT_TYPES is FactBinding.type, in order', () => {
    expect([...FACT_TYPES]).toEqual(((binding().properties as Json).type as Json).enum);
  });

  it('FACT_NAME is the pattern of FactName', () => {
    expect(FACT_NAME.source).toBe(schema('FactName').pattern);
  });

  it('FACT_PATH is the pattern of a binding path, with its length limit', () => {
    const path = (binding().properties as Json).path as Json;
    // The module writes `\\d` where the contract writes `[0-9]`; both are the decimal digits.
    expect(FACT_PATH.source.replaceAll('\\d', '[0-9]').replaceAll('(?:', '(')).toBe(path.pattern);
    expect(MAX_FACT_PATH).toBe(path.maxLength);
  });

  it('the limits are the contract’s', () => {
    expect(MAX_FACTS).toBe(schema('ToolFacts').maxProperties);
    expect(MAX_FACT_DESCRIPTION).toBe(
      ((binding().properties as Json).description as Json).maxLength
    );
  });
});
