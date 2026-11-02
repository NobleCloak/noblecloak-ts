import { describe, expect, it } from 'vitest';

import { renderAdaptiveCard } from './adaptive-card.js';
import { renderBlockKit } from './block-kit.js';
import { MESSAGE_ID, OTHER_VIEWER, full, options } from './fixtures.test-support.js';
import { toApprovalCard } from './model.js';

const FEATURE = 'approvals.available_actions';
const advertised = (): ReturnType<typeof options> =>
  options({
    capabilities: { resolutions: ['approved', 'rejected'], features: [FEATURE, 'other'] },
  });

describe('an absent available_actions member where the deployment lists the feature', () => {
  it('builds no actions, and says the actions were withheld', () => {
    const card = toApprovalCard(full(), OTHER_VIEWER, advertised());
    expect(card.actions).toEqual([]);
    expect(card.degraded).toEqual(['actions_withheld']);
    expect(card.links.open).toBe(options().approvalsUrl);
  });

  it('is a link-only card on both surfaces: the Approvals link and no resolve button or input', () => {
    const card = toApprovalCard(full(), OTHER_VIEWER, advertised());
    const slack = renderBlockKit(card, { sentMessageId: MESSAGE_ID });
    const teams = renderAdaptiveCard(card, { sentMessageId: MESSAGE_ID });
    expect(slack.degraded).toEqual(['actions_withheld']);
    expect(teams.degraded).toEqual(['actions_withheld']);
    const text = JSON.stringify([slack.message, teams.card]);
    expect(text).toContain(options().approvalsUrl);
    expect(text).not.toContain('Action.Execute');
    expect(text).not.toContain('"input"');
    expect(text).not.toContain('Input.Text');
    expect(text).not.toContain('"Approve"');
  });

  it('also holds when the member is present but is not an array', () => {
    const card = toApprovalCard(
      full({ available_actions: 'nope' as never }),
      OTHER_VIEWER,
      advertised()
    );
    expect(card.actions).toEqual([]);
    expect(card.degraded).toContain('actions_withheld');
  });

  it('does not withhold a final card, which has no actions to withhold', () => {
    const card = toApprovalCard(full({ state: 'expired' }), OTHER_VIEWER, advertised());
    expect(card.degraded).toEqual([]);
  });
});

describe('an absent available_actions member where the deployment does not list the feature', () => {
  it.each([
    ['no features member', options()],
    [
      'features without it',
      options({ capabilities: { resolutions: ['approved', 'rejected'], features: ['other'] } }),
    ],
    [
      'features that are not a list',
      options({
        capabilities: { resolutions: ['approved', 'rejected'], features: FEATURE as never },
      }),
    ],
  ])('derives approve and deny from the capabilities (%s)', (_name, withCaps) => {
    const card = toApprovalCard(full(), OTHER_VIEWER, withCaps);
    expect(card.actions.map((a) => a.id)).toEqual(['approve', 'deny']);
    expect(card.degraded).toEqual([]);
  });

  it('lists what the read lists, where the deployment lists the feature', () => {
    const card = toApprovalCard(
      full({
        available_actions: [
          { id: 'ok', kind: 'resolve', resolution: 'approved', label: 'Go', inputs: [] },
        ] as never,
      }),
      OTHER_VIEWER,
      advertised()
    );
    expect(card.actions.map((a) => a.id)).toEqual(['ok']);
    expect(card.degraded).toEqual([]);
  });
});
