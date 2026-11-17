import { describe, expect, it } from 'vitest';

import { setupProgress } from './progress.js';
import { wizardSteps } from './steps.js';
import type { SetupState } from './types.js';

// noblesos-team's zod-inferred SetupState carries more than the rule reads: extra and optional
// members. It must be assignable to `SetupState` with no cast. The required members stay required:
// a caller that cannot answer them passes `{ done: null }`.

interface RichStep {
  key: string;
  state: 'done' | 'todo' | 'skipped' | 'dismissed' | 'unknown';
  availability: 'live' | 'assisted' | 'coming_soon' | 'disabled';
  title: string;
  detail?: { reason: string } | null;
  first_done_at?: string | null;
  first_done_at_source?: 'event' | 'backfill' | null;
}

interface RichState {
  steps: RichStep[];
  intent: 'solo' | 'team' | 'company' | null;
  app_authorized: { done: boolean | null; at?: string };
  setup_proposal_approved: { done: boolean | null; proposal_id?: string };
  held_action_decided: { done: boolean | null };
  dismissed: boolean;
  lanes?: { id: string; steps: string[] }[];
  org_id: string;
}

describe('SetupState accepts a richer object', () => {
  it('takes extra and optional members without a cast', () => {
    const rich: RichState = {
      steps: [
        {
          key: 'tools',
          state: 'done',
          availability: 'live',
          title: 'Connect tools',
          detail: { reason: 'x' },
          first_done_at: '2026-11-01T00:00:00Z',
          first_done_at_source: 'event',
        },
      ],
      intent: 'solo',
      app_authorized: { done: true, at: '2026-11-01T00:00:00Z' },
      setup_proposal_approved: { done: false, proposal_id: 'p1' },
      held_action_decided: { done: false },
      dismissed: false,
      lanes: [{ id: 'a', steps: ['tools'] }],
      org_id: 'o1',
    };
    const state: SetupState = rich;
    expect(wizardSteps(state).find((s) => s.id === 'connect')?.status).toBe('done');
    expect(setupProgress(state).hidden).toBe(false);
  });

  it('does not take an object missing setup_proposal_approved', () => {
    const missing = {
      steps: [],
      intent: null,
      app_authorized: { done: null },
      held_action_decided: { done: null },
      dismissed: false,
    };
    // @ts-expect-error setup_proposal_approved is required: a caller defaults it to { done: null }
    const state: SetupState = missing;
    expect(state).toBeDefined();
  });
});
