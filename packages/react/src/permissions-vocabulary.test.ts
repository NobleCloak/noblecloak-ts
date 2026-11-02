import { loadDocument } from '@noblecloak/spec';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CONDITION_FIELDS,
  CONDITION_MODES,
  KNOWN_POLICY_KINDS,
  MODE_ON_THE_WIRE,
  POLICY_MODES,
  PROVISIONAL_MODES,
  isKnownMode,
  takesConditions,
} from './permissions-vocabulary.js';

type Json = Record<string, unknown>;

let spec: Json;
beforeAll(() => {
  spec = loadDocument();
  // Loading the contract parses a large YAML document: slow when the machine is busy.
}, 60_000);

const schema = (name: string): Json => ((spec.components as Json).schemas as Json)[name] as Json;

/** The contract's table, with a bare decision written as `{ decision }`. */
function contractTable(): Record<string, unknown> {
  const vocabulary = (spec.info as Json)['x-noblecloak-vocabulary'] as Json;
  const table = vocabulary.decision_from_policy_mode as Json;
  return Object.fromEntries(
    Object.entries(table).map(([mode, value]) => [
      mode,
      typeof value === 'string' ? { decision: value } : value,
    ])
  );
}

describe("the mode vocabulary is the contract's", () => {
  it('MODE_ON_THE_WIRE equals x-noblecloak-vocabulary.decision_from_policy_mode', () => {
    expect({ ...MODE_ON_THE_WIRE }).toEqual(contractTable());
  });

  it('the parity check sees a difference (positive control)', () => {
    const changed = { ...MODE_ON_THE_WIRE, escalate: { decision: 'step_up' } };
    expect(changed).not.toEqual(contractTable());
  });

  it('POLICY_MODES is PolicyMode, in order', () => {
    expect([...POLICY_MODES]).toEqual(schema('PolicyMode').enum);
  });

  it("KNOWN_POLICY_KINDS is PolicyKind's known values", () => {
    expect([...KNOWN_POLICY_KINDS]).toEqual(schema('PolicyKind')['x-noblecloak-known-values']);
  });

  it("CONDITION_FIELDS and CONDITION_MODES are ToolInvocationConfig's legality matrix", () => {
    const config = schema('ToolInvocationConfig');
    const forbiddenWith = (((config.if as Json).properties as Json).mode as { enum: string[] })
      .enum;
    const fields = (((config.then as Json).not as Json).anyOf as { required: string[] }[]).map(
      (clause) => clause.required[0]
    );
    expect([...CONDITION_FIELDS].sort()).toEqual([...fields].sort());
    expect([...CONDITION_MODES].sort()).toEqual(
      POLICY_MODES.filter((mode) => !forbiddenWith.includes(mode)).sort()
    );
  });

  it('marks not_granted provisional, as the contract does', () => {
    expect(PROVISIONAL_MODES).toEqual(['not_granted']);
    expect(String(schema('PolicyMode').description)).toMatch(/not_granted.*provisional/s);
  });

  it('tells a known mode from an unknown one', () => {
    expect(isKnownMode('ask')).toBe(true);
    expect(isKnownMode('observe')).toBe(false);
    expect(isKnownMode(3)).toBe(false);
    expect(takesConditions('escalate')).toBe(true);
    expect(takesConditions('deny')).toBe(false);
  });
});
