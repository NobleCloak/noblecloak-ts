import { describe, expect, it } from 'vitest';

import { setupProgress } from './progress.js';
import { allDone, setupState, steps } from './fixtures.test-support.js';

// Ported from noblesos-shell src/setup/__tests__/setupProgress.test.ts, on the shared rule.

describe('setupProgress (the pill)', () => {
  it('a fresh team org is 0 of 5 and opens at tools', () => {
    expect(setupProgress(setupState())).toEqual({
      finished: 0,
      total: 5,
      stepKey: 'tools',
      hidden: false,
    });
  });
  it('n counts finished steps, not the wizard position: a fresh org with no intent reads "Setup 0/4"', () => {
    const p = setupProgress(setupState({ intent: null }));
    expect(`Setup ${String(p.finished)}/${String(p.total)}`).toBe('Setup 0/4');
    // The wizard would show "Step 1 of 4" here; n stays 0.
    expect(p.stepKey).toBe('tools');
  });
  it('a fresh solo org is 0 of 4: intent changes N', () => {
    expect(setupProgress(setupState({ intent: 'solo' })).total).toBe(4);
    expect(setupProgress(setupState({ intent: null })).total).toBe(4);
  });
  it('counts done and skipped screens, and names the first unfinished one', () => {
    const s = setupState({
      steps: steps({ tools: { state: 'done' }, people: { state: 'skipped' } }),
      app_authorized: { done: true },
    });
    expect(setupProgress(s)).toEqual({ finished: 2, total: 5, stepKey: 'policy', hidden: false });
  });
  it('an unknown signal is not finished', () => {
    const s = setupState({
      steps: steps({ tools: { state: 'done' } }),
      app_authorized: { done: null },
    });
    expect(setupProgress(s)).toMatchObject({ finished: 0, stepKey: 'tools' });
  });
  it('is hidden once the first run is complete', () => {
    expect(setupProgress(allDone()).hidden).toBe(true);
  });
  it('is hidden when the checklist is dismissed, however far along', () => {
    expect(setupProgress(setupState({ dismissed: true })).hidden).toBe(true);
  });
  it('is not hidden while a required screen is unfinished and nothing is dismissed', () => {
    expect(setupProgress(setupState()).hidden).toBe(false);
  });
  it('counts Scan in n and N once Core reports discover live, and opens at scan', () => {
    const s = setupState({ steps: steps({ discover: { availability: 'live', state: 'todo' } }) });
    expect(setupProgress(s)).toEqual({ finished: 0, total: 6, stepKey: 'scan', hidden: false });
    const done = setupState({
      steps: steps({ discover: { availability: 'live', state: 'done' } }),
    });
    expect(setupProgress(done)).toMatchObject({ finished: 1, total: 6, stepKey: 'tools' });
  });
  it('reads the fork the caller passes, else the inferred one', () => {
    const own = setupState({
      steps: steps({ tools: { state: 'done' }, automation: { state: 'done' } }),
      setup_proposal_approved: { done: true },
      held_action_decided: { done: true },
    });
    // Inferred own_agent: Connect, Approve and Try it are all done.
    expect(setupProgress(own)).toMatchObject({ finished: 3, hidden: true });
    // Forced to apps: Connect needs an app grant, Approve and Try read the apps steps.
    expect(setupProgress(own, 'apps')).toMatchObject({
      finished: 0,
      stepKey: 'tools',
      hidden: false,
    });
  });
});
