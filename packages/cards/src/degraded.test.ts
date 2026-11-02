import { describe, expect, it } from 'vitest';

import { renderAdaptiveCard } from './adaptive-card.js';
import { renderBlockKit } from './block-kit.js';
import { MESSAGE_ID, OTHER_VIEWER, full, options, priyaResolved } from './fixtures.test-support.js';
import { SLACK_LIMITS, TEAMS_LIMITS } from './limits.js';
import type { Approval } from './model.js';
import { toApprovalCard } from './model.js';

const listed = (count: number): NonNullable<Approval['available_actions']> =>
  Array.from({ length: count }, (_, i) => ({
    id: `act-${String(i)}`,
    kind: 'resolve',
    resolution: i % 2 === 0 ? 'approved' : 'rejected',
    label: `Opt ${String(i)}`,
    inputs: [],
  })) as never;

const renderers = [
  ['Slack', (c: never, o: never) => renderBlockKit(c, o).degraded, SLACK_LIMITS.maxActions],
  ['Teams', (c: never, o: never) => renderAdaptiveCard(c, o).degraded, TEAMS_LIMITS.maxActions],
] as const;

describe.each(renderers)('%s degradation signal', (_name, degradedOf, maxActions) => {
  const small = () => toApprovalCard(full(), OTHER_VIEWER, options());

  it('is empty when every resolve action is on the card', () => {
    const card = toApprovalCard(full({ available_actions: listed(2) }), OTHER_VIEWER, options());
    expect(card.actions.length).toBeGreaterThan(0);
    expect(degradedOf(card as never, { sentMessageId: MESSAGE_ID } as never)).toEqual([]);
  });

  it('says no_payload without a sentMessageId, and for one that is no UUID', () => {
    const card = small();
    expect(degradedOf(card as never, {} as never)).toEqual(['no_payload']);
    expect(degradedOf(card as never, { sentMessageId: 'nope' } as never)).toEqual(['no_payload']);
  });

  it('says actions_capped past maxActions, and not at maxActions', () => {
    const atCap = toApprovalCard(
      full({ available_actions: listed(maxActions) }),
      OTHER_VIEWER,
      options()
    );
    expect(degradedOf(atCap as never, { sentMessageId: MESSAGE_ID } as never)).toEqual([]);
    const card = toApprovalCard(
      full({ available_actions: listed(maxActions + 1) }),
      OTHER_VIEWER,
      options()
    );
    expect(degradedOf(card as never, { sentMessageId: MESSAGE_ID } as never)).toEqual([
      'actions_capped',
    ]);
  });

  it('says inputs_capped when the actions take more distinct inputs than the card renders', () => {
    const inputs = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        name: `field${String(i)}`,
        type: 'text',
        label: `Field ${String(i)}`,
        required: true,
      }));
    const withInputs = (count: number) =>
      toApprovalCard(
        full({
          available_actions: [
            {
              id: 'approve',
              kind: 'resolve',
              resolution: 'approved',
              label: 'Ok',
              inputs: inputs(count),
            },
          ] as never,
        }),
        OTHER_VIEWER,
        options()
      );
    const sent = { sentMessageId: MESSAGE_ID } as never;
    expect(degradedOf(withInputs(5) as never, sent)).toEqual([]);
    expect(degradedOf(withInputs(6) as never, sent)).toEqual(['inputs_capped']);
    // Without a payload no input is rendered, and no_payload says so.
    expect(degradedOf(withInputs(6) as never, {} as never)).toEqual(['no_payload']);
  });

  it('says nothing for a closed card, which offers no resolve action anyway', () => {
    const card = toApprovalCard(
      full(priyaResolved('consumed', 'approved')),
      OTHER_VIEWER,
      options()
    );
    expect(degradedOf(card as never, {} as never)).toEqual([]);
  });

  it('does not say minimal for a card under the size cap', () => {
    const card = small();
    expect(degradedOf(card as never, { sentMessageId: MESSAGE_ID } as never)).not.toContain(
      'minimal'
    );
  });
});
