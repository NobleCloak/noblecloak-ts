import { describe, expect, it } from 'vitest';

import { renderAdaptiveCard } from './adaptive-card.js';
import { renderBlockKit } from './block-kit.js';
import { MESSAGE_ID, OTHER_VIEWER, full, options } from './fixtures.test-support.js';
import { CARD_DEGRADATIONS, toApprovalCard } from './model.js';
import type { ApprovalCard, CardDegradation } from './model.js';

const surfaces = [
  [
    'Slack',
    (c: ApprovalCard, sent = true) =>
      renderBlockKit(c, sent ? { sentMessageId: MESSAGE_ID } : {}).degraded,
  ],
  [
    'Teams',
    (c: ApprovalCard, sent = true) =>
      renderAdaptiveCard(c, sent ? { sentMessageId: MESSAGE_ID } : {}).degraded,
  ],
] as const;

const withArguments = (args: Record<string, unknown>): ApprovalCard => {
  const card = toApprovalCard(full(), OTHER_VIEWER, options());
  return { ...card, facts: { call: { kind: 'arguments', arguments: args } } };
};

const lines = (count: number): Record<string, string> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${String(i)}`, 'v']));

describe('CARD_DEGRADATIONS', () => {
  it('lists every code at run time, once each, and the type is derived from it', () => {
    expect([...CARD_DEGRADATIONS].sort()).toEqual(
      [
        'actions_capped',
        'actions_dropped',
        'actions_withheld',
        'call_shortened',
        'call_too_large',
        'call_unreadable',
        'inputs_capped',
        'minimal',
        'no_link',
        'no_payload',
      ].sort()
    );
    expect(new Set(CARD_DEGRADATIONS).size).toBe(CARD_DEGRADATIONS.length);
    const code: CardDegradation = CARD_DEGRADATIONS[0];
    expect(CARD_DEGRADATIONS).toContain(code);
  });
});

describe.each(surfaces)('%s: every degradation has a code', (_name, degradedOf) => {
  it('actions_dropped: a listed action skipped as invalid, and the valid ones stay', () => {
    const card = toApprovalCard(
      full({
        available_actions: [
          { id: 'approve', kind: 'resolve', resolution: 'approved', label: 'Go', inputs: [] },
          { id: 'bad', kind: 'resolve', resolution: 'rejected', label: 'No', inputs: 'x' },
        ] as never,
      }),
      OTHER_VIEWER,
      options()
    );
    expect(card.actions.map((a) => a.id)).toEqual(['approve']);
    expect(degradedOf(card)).toEqual(['actions_dropped']);
  });

  it.each([
    ['an entry that is not an object', 'oops'],
    [
      'an id that is a duplicate',
      { id: 'approve', kind: 'resolve', resolution: 'rejected', label: 'Again', inputs: [] },
    ],
    [
      'an id that is the Open in Approvals id',
      { id: 'nc.open', kind: 'resolve', resolution: 'rejected', label: 'Open', inputs: [] },
    ],
    [
      'an id that is empty',
      { id: '', kind: 'resolve', resolution: 'rejected', label: 'No', inputs: [] },
    ],
    ['a resolve entry with no resolution', { id: 'no', kind: 'resolve', label: 'No', inputs: [] }],
    [
      'a resolve entry with a null resolution',
      { id: 'no', kind: 'resolve', resolution: null, label: 'No', inputs: [] },
    ],
    [
      'a resolve entry with a misspelled resolution',
      { id: 'no', kind: 'resolve', resolution: 'approve', label: 'No', inputs: [] },
    ],
    ['an entry with no kind', { id: 'no', resolution: 'rejected', label: 'No', inputs: [] }],
    [
      'an entry with a null kind',
      { id: 'no', kind: null, resolution: 'rejected', label: 'No', inputs: [] },
    ],
    [
      'an entry with a numeric kind',
      { id: 'no', kind: 7, resolution: 'rejected', label: 'No', inputs: [] },
    ],
    [
      'a resolve action on the id derived for the other resolution',
      { id: 'deny', kind: 'resolve', resolution: 'approved', label: 'No', inputs: [] },
    ],
    [
      'an input of an unknown type',
      {
        id: 'no',
        kind: 'resolve',
        resolution: 'rejected',
        label: 'No',
        inputs: [{ name: 'n', type: 'choice', label: 'N', required: false }],
      },
    ],
  ])('actions_dropped: %s', (_name, entry) => {
    const card = toApprovalCard(
      full({
        available_actions: [
          { id: 'approve', kind: 'resolve', resolution: 'approved', label: 'Go', inputs: [] },
          entry,
        ] as never,
      }),
      OTHER_VIEWER,
      options()
    );
    expect(card.actions.map((a) => a.id)).toEqual(['approve']);
    expect(degradedOf(card)).toEqual(['actions_dropped']);
  });

  it('does not count an action it leaves out by design: another kind, or a resolution not offered in chat', () => {
    const card = toApprovalCard(
      full({
        available_actions: [
          { id: 'approve', kind: 'resolve', resolution: 'approved', label: 'Go', inputs: [] },
          { id: 'esc', kind: 'resolve', resolution: 'escalated', label: 'Up', inputs: [] },
          { id: 'ask', kind: 'ask', label: 'Ask', inputs: [] },
        ] as never,
      }),
      OTHER_VIEWER,
      options()
    );
    expect(degradedOf(card)).toEqual([]);
  });

  it('actions_withheld: the feature is listed and the member is absent', () => {
    const card = toApprovalCard(
      full(),
      OTHER_VIEWER,
      options({
        capabilities: {
          resolutions: ['approved', 'rejected'],
          features: ['approvals.available_actions'],
        },
      })
    );
    expect(degradedOf(card)).toEqual(['actions_withheld']);
  });

  it('call_unreadable: arguments that are present and not an object', () => {
    const card = toApprovalCard(full({ arguments: 'a string' as never }), OTHER_VIEWER, options());
    expect(degradedOf(card)).toEqual(['call_unreadable']);
  });

  it('call_unreadable: arguments the printer cannot read', () => {
    const hostile = {
      get boom(): string {
        throw new Error('no');
      },
    };
    expect(degradedOf(withArguments(hostile))).toEqual(['call_unreadable']);
  });

  it('call_too_large: a call over the surface budget, and not a call within it', () => {
    expect(degradedOf(withArguments(lines(3)))).toEqual([]);
    expect(degradedOf(withArguments(lines(400)))).toEqual(['call_too_large']);
    const wide: Record<string, string> = {};
    for (let i = 0; i < 1000; i += 1) wide[`key${String(i)}`] = 'v'.repeat(100);
    expect(degradedOf(withArguments(wide))).toEqual(['call_too_large']);
  });

  it('call_shortened: a call shown with a part cut', () => {
    expect(degradedOf(withArguments({ note: 'x'.repeat(600) }))).toEqual(['call_shortened']);
  });

  it('no_link: the Approvals URL is refused by safeUrl, on the full message', () => {
    const card = toApprovalCard(
      full(),
      OTHER_VIEWER,
      options({ approvalsUrl: 'javascript:alert(1)' })
    );
    expect(degradedOf(card)).toEqual(['no_link']);
    const none = toApprovalCard(full(), OTHER_VIEWER, options());
    expect(degradedOf(none)).toEqual([]);
  });
});
