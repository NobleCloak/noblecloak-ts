/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
   each line under a `@ts-expect-error` is deliberately a type error: the call is on an error type */
import { describe, expect, it } from 'vitest';

import { GITHUB_ERROR_CODES, NO_ARRIVAL } from './arrival.js';
import { WIZARD_EVENT_STEP_KEYS, WIZARD_STEPS, WIZARD_STEP_IDS } from './steps.js';

// The shared exports are one rule for every consumer: none of them can be changed by a caller. The
// `@ts-expect-error` lines are the type-level half (typecheck fails if an assignment compiles); the
// throws are the runtime half. This file is an ES module, so it runs in strict mode.

describe('shared exports are read-only', () => {
  it('WIZARD_STEPS cannot be changed, at the top or in a screen', () => {
    // @ts-expect-error a screen's definition is readonly
    expect(() => (WIZARD_STEPS.connect.required = false)).toThrow(TypeError);
    // @ts-expect-error the record is readonly
    expect(() => (WIZARD_STEPS.connect = WIZARD_STEPS.try)).toThrow(TypeError);
    // @ts-expect-error a screen's keys are a readonly array
    expect(() => WIZARD_STEPS.connect.keys.push('admin')).toThrow(TypeError);
    expect(WIZARD_STEPS.connect.required).toBe(true);
    expect(WIZARD_STEPS.connect.keys).toEqual(['tools', 'github']);
    expect(Object.isFrozen(WIZARD_STEPS)).toBe(true);
    for (const def of Object.values(WIZARD_STEPS)) {
      expect(Object.isFrozen(def)).toBe(true);
      expect(Object.isFrozen(def.keys)).toBe(true);
    }
  });

  it('WIZARD_STEP_IDS and WIZARD_EVENT_STEP_KEYS cannot be changed', () => {
    // @ts-expect-error a readonly array has no push
    expect(() => WIZARD_STEP_IDS.push('scan')).toThrow(TypeError);
    // @ts-expect-error an element of a readonly array is not assignable
    expect(() => (WIZARD_STEP_IDS[0] = 'proof')).toThrow(TypeError);
    // @ts-expect-error a readonly array has no push
    expect(() => WIZARD_EVENT_STEP_KEYS.push('scan')).toThrow(TypeError);
    expect(WIZARD_STEP_IDS).toHaveLength(6);
    expect(WIZARD_STEP_IDS[0]).toBe('scan');
    expect(WIZARD_EVENT_STEP_KEYS[0]).toBe('tools');
  });

  it('NO_ARRIVAL cannot be changed', () => {
    // @ts-expect-error its members are readonly
    expect(() => (NO_ARRIVAL.step = 'tools')).toThrow(TypeError);
    expect(NO_ARRIVAL.step).toBeNull();
    expect(Object.isFrozen(NO_ARRIVAL)).toBe(true);
  });

  it('GITHUB_ERROR_CODES cannot be changed', () => {
    // @ts-expect-error a ReadonlySet has no add
    expect(() => GITHUB_ERROR_CODES.add('x')).toThrow(TypeError);
    // @ts-expect-error a ReadonlySet has no delete
    expect(() => GITHUB_ERROR_CODES.delete('installation_suspended')).toThrow(TypeError);
    // @ts-expect-error a ReadonlySet has no clear
    expect(() => GITHUB_ERROR_CODES.clear()).toThrow(TypeError);
    expect(Object.isFrozen(GITHUB_ERROR_CODES)).toBe(true);
    expect(GITHUB_ERROR_CODES.size).toBe(12);
    expect(GITHUB_ERROR_CODES.has('x')).toBe(false);
  });
});
