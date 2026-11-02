import { describe, expect, it } from 'vitest';

import { toAdaptiveCard } from './adaptive-card.js';
import type { AdaptiveCardJson } from './adaptive-card.js';
import {
  APPROVALS_URL,
  APPROVAL_ID,
  DIGEST,
  MESSAGE_ID,
  OTHER_VIEWER,
  REQUESTER_VIEWER,
  full,
  options,
  priyaResolved,
} from './fixtures.test-support.js';
import type { Approval, CardViewer } from './model.js';
import { toApprovalCard } from './model.js';
import { TEAMS_LIMITS } from './limits.js';
import { findCardAction, parseActionPayload } from './payload.js';

const render = (
  approval: Approval,
  viewer: CardViewer = OTHER_VIEWER,
  opts = options()
): AdaptiveCardJson =>
  toAdaptiveCard(toApprovalCard(approval, viewer, opts), { sentMessageId: MESSAGE_ID });
const golden = (name: string) => `./golden/adaptive-card-${name}.json`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('adaptive-card golden', () => {
  it('pending', async () => {
    await expect(json(render(full()))).toMatchFileSnapshot(golden('pending'));
  });
  it('self', async () => {
    await expect(json(render(full(), REQUESTER_VIEWER))).toMatchFileSnapshot(golden('self'));
  });
  it('final, as the approver', async () => {
    const card = render(full(priyaResolved('rejected', 'rejected', 'wrong amount')), {
      principalId: 'u-priya',
    });
    await expect(json(card)).toMatchFileSnapshot(golden('final-approver'));
  });
  it('final, expired', async () => {
    await expect(json(render(full({ state: 'expired' })))).toMatchFileSnapshot(
      golden('final-expired')
    );
  });
});

describe('adaptive-card shape', () => {
  it('is version 1.5, with a note input and an Execute action for each resolve action', () => {
    const card = render(full());
    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe('1.5');
    const input = card.body.find((e) => e.type === 'Input.Text');
    expect(input).toMatchObject({ id: 'reason', isRequired: false, maxLength: 1000 });
    const executes = (card.actions ?? []).filter((a) => a.type === 'Action.Execute');
    expect(executes.map((a) => a.verb)).toEqual(['approve', 'deny']);
    expect(executes.map((a) => a.style)).toEqual(['positive', 'destructive']);
    const open = (card.actions ?? []).find((a) => a.type === 'Action.OpenUrl');
    expect(open?.url).toBe(APPROVALS_URL);
  });

  it('carries data that round-trips through parseActionPayload, and verbs that find the card action', () => {
    const rebuilt = toApprovalCard(full(), OTHER_VIEWER, options());
    for (const action of (render(full()).actions ?? []).filter(
      (a) => a.type === 'Action.Execute'
    )) {
      expect(parseActionPayload(action.data)).toEqual({
        v: 1,
        approval_id: APPROVAL_ID,
        sent_message_id: MESSAGE_ID,
        expected_action_digest: DIGEST,
      });
      expect(findCardAction(rebuilt, action.verb as string)?.id).toBe(action.verb);
    }
  });

  it('has no actions member on a final card, and no input', () => {
    for (const state of ['approved', 'consumed', 'rejected', 'expired', 'withdrawn'] as const) {
      const card = render(full({ state }));
      expect('actions' in card).toBe(false);
      expect(card.body.some((e) => e.type === 'Input.Text')).toBe(false);
      const linked = card.body.filter((e) => e.selectAction !== undefined);
      expect(linked).toHaveLength(1);
      expect(linked[0]?.selectAction).toMatchObject({
        type: 'Action.OpenUrl',
        url: APPROVALS_URL,
      });
    }
  });

  it('has no Execute action and no input without a usable sent-message id', () => {
    const card = toAdaptiveCard(toApprovalCard(full(), OTHER_VIEWER, options()));
    expect((card.actions ?? []).map((a) => a.type)).toEqual(['Action.OpenUrl']);
    expect(card.body.some((e) => e.type === 'Input.Text')).toBe(false);
  });

  it('has no actions member at all when there is neither a button nor a link', () => {
    const card = toAdaptiveCard(
      toApprovalCard(full({ state: 'expired' }), OTHER_VIEWER, options({ approvalsUrl: 'nope' }))
    );
    expect('actions' in card).toBe(false);
  });

  it('never emits an msteams member or a mention', () => {
    const text = JSON.stringify(render(full()));
    expect(text).not.toContain('msteams');
    expect(text).not.toContain('"mention"');
    expect(text).not.toContain('entities');
  });

  it('shows the call as monospace lines, with leading spaces kept', () => {
    const card = render(full());
    const container = card.body.find((e) => e.type === 'Container');
    const lines = (container?.items as { text: string; fontType: string }[]).map((i) => i.text);
    expect(lines[0]).toBe('{');
    expect(lines[1]).toBe('\u00a0\u00a0"amount": 42,');
    expect(
      (container?.items as { fontType: string }[]).every((i) => i.fontType === 'Monospace')
    ).toBe(true);
  });

  it('replaces a call over its line budget with the Approvals sentence', () => {
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${String(i)}`, i]));
    const text = JSON.stringify(render(full({ arguments: many })));
    expect(text).toContain('View the full call in Approvals');
    expect(text).not.toContain('"k150"');
  });

  it('replaces a call over the character budget, and shows one under it', () => {
    const strings = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`k${String(i)}`, 'x'.repeat(400)])
      );
    const over = JSON.stringify(render(full({ arguments: strings(25) })));
    expect(over).toContain('View the full call in Approvals');
    expect(over).not.toContain('"Monospace"');
    expect(JSON.stringify(render(full({ arguments: strings(10) })))).toContain('"Monospace"');
  });

  it('keeps a wide-character card with two actions within the Teams cap, counted in UTF-16', () => {
    // Three-byte characters in every field, every field past its cut, the call at its largest, five inputs.
    const wide = (n: number) => '\u20ac'.repeat(n);
    const call = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${String(i)}`, wide(60)])
    );
    const input = (name: string) => ({
      name,
      type: 'text',
      label: wide(3000),
      required: true,
      max_length: 3000,
    });
    const person = (id: string) => ({ id, kind: 'user' as const, display_name: wide(3000) });
    const card = toApprovalCard(
      full({
        arguments: call,
        tool_ref: wide(5000),
        scope_id: wide(5000),
        action_digest: 'd'.repeat(1500),
        requester: person('r'.repeat(150)),
        agent: { id: 'a'.repeat(150), name: wide(3000), parent: wide(3000) },
        waiting_on: { count: 5, principals: ['1', '2', '3', '4', '5'].map(person) },
        resolution_history: Array.from({ length: 9 }, (_, i) => ({
          resolution: wide(1000),
          by: person(`h${String(i)}`),
          at: wide(1000),
          reason: wide(1000),
        })),
        available_actions: [
          {
            id: 'approve',
            kind: 'resolve',
            resolution: 'approved',
            label: wide(1000),
            inputs: ['a', 'b', 'c', 'd', 'e', 'f'].map(input),
          },
          { id: 'deny', kind: 'resolve', resolution: 'rejected', label: wide(1000), inputs: [] },
        ] as never,
      }),
      OTHER_VIEWER,
      options({ approvalsUrl: `https://approvals.example.com/${'p'.repeat(2900)}` })
    );
    const out = toAdaptiveCard(card, { sentMessageId: MESSAGE_ID });
    const json = JSON.stringify(out);
    expect(json).toContain('"Action.Execute"');
    expect(json).toContain('"Container"');
    expect(out.body.filter((e) => e.type === 'Input.Text')).toHaveLength(5);
    expect(json.length * 2).toBeLessThanOrEqual(TEAMS_LIMITS.cardBytes);
  });
});
