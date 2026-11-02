import { describe, expect, it } from 'vitest';

import { loadScenarios } from './scenarios.js';

describe('the scenario files', () => {
  it('take their public callback base from one variable; only the schema-refusal case spells a host', () => {
    const spelled = loadScenarios()
      .flatMap((s) => JSON.stringify(s).match(/https?:\/\/hooks\.example\.com[^"]*/g) ?? [])
      .sort();
    expect(spelled).toEqual(['http://hooks.example.com/noblecloak']);
  });

  it('every deliveries step names the url its webhook registered', () => {
    const steps = loadScenarios().flatMap((s) =>
      s.steps.flatMap((step) =>
        'control' in step && step.control.deliveries !== undefined ? [step.control.deliveries] : []
      )
    );
    expect(steps.length).toBe(5);
    for (const deliveries of steps) expect(deliveries.url).toBe('${webhook_url}');
  });
});
