import { describe, expect, it } from 'vitest';

import {
  APPROVAL_ID,
  DIGEST,
  MESSAGE_ID,
  OTHER_VIEWER,
  full,
  options,
  priyaResolved,
} from './fixtures.test-support.js';
import type { ActionPayload } from './payload.js';
import { clickIntent, findCardAction, parseActionPayload } from './payload.js';
import { isResolveAction, toApprovalCard } from './model.js';
import type { Approval, ApprovalCard, FinalCard } from './model.js';

const payload: ActionPayload = {
  v: 1,
  approval_id: APPROVAL_ID,
  sent_message_id: MESSAGE_ID,
  expected_action_digest: DIGEST,
};

const listed = (
  ...actions: [string, 'approved' | 'rejected' | 'escalated'][]
): Partial<Approval> => ({
  available_actions: actions.map(([id, resolution]) => ({
    id,
    kind: 'resolve',
    resolution,
    label: id,
    inputs: [],
  })),
});

/** A card whose only action is of a kind other than `resolve`, which `toApprovalCard` does not make in v1. */
const withOtherAction = (card: ApprovalCard): ApprovalCard =>
  ({
    ...card,
    actions: [{ kind: 'ask', id: 'ask', label: 'Ask', inputs: [] }],
  }) as unknown as ApprovalCard;

const pending = (over: Partial<Approval> = {}): ApprovalCard =>
  toApprovalCard(full(over), OTHER_VIEWER, options());

describe('the card types', () => {
  it('cannot be written by hand: only toApprovalCard makes a card', () => {
    const real = pending();
    // @ts-expect-error a card carries a brand that only toApprovalCard sets
    const handmade: ApprovalCard = {
      version: real.version,
      approvalId: real.approvalId,
      viewerRole: real.viewerRole,
      header: real.header,
      details: real.details,
      facts: { call: { kind: 'link', why: 'final' } },
      actions: [],
      status: real.status,
      links: real.links,
      selfApproval: false,
      degraded: [],
    };
    expect(handmade.actions).toEqual([]);
  });

  it('gives a final card no actions and a call that is never shown', () => {
    const card = toApprovalCard(
      full(priyaResolved('approved', 'approved')),
      OTHER_VIEWER,
      options()
    );
    const final: FinalCard = card as FinalCard;
    expect(final.actions).toEqual([]);
    expect(final.facts.call).toEqual({ kind: 'link', why: 'final' });
    // @ts-expect-error a final card has no actions
    const withAction: FinalCard = { ...final, actions: pending().actions };
    // @ts-expect-error a final card's call is the link, never the arguments
    const withCall: FinalCard = { ...final, facts: { call: { kind: 'arguments', arguments: {} } } };
    expect([withAction, withCall]).toHaveLength(2);
  });

  it('exports isResolveAction, which tells a resolve action from another kind', () => {
    const [first] = pending().actions;
    expect(first !== undefined && isResolveAction(first)).toBe(true);
    expect(isResolveAction({ kind: 'ask', id: 'ask', label: 'Ask', inputs: [] })).toBe(false);
    expect(isResolveAction({ kind: 'resolve', id: 'x', label: 'x', inputs: [] })).toBe(false);
  });
});

describe('findCardAction', () => {
  it('finds a resolve action by its id and answers undefined for another', () => {
    const card = pending();
    expect(findCardAction(card, 'approve')?.resolution).toBe('approved');
    expect(findCardAction(card, 'deny')?.resolution).toBe('rejected');
    expect(findCardAction(card, 'nope')).toBeUndefined();
  });

  it('never returns an action that is not a resolve action', () => {
    const card = pending();
    const other = withOtherAction(card);
    expect(findCardAction(other, 'ask')).toBeUndefined();
  });
});

describe('findCardAction across the two sources of ids', () => {
  const fresh = (...actions: [string, 'approved' | 'rejected' | 'escalated'][]): ApprovalCard =>
    pending(listed(...actions));

  it('maps a derived id to the one listed action with that resolution', () => {
    const card = fresh(['go-ahead', 'approved'], ['no-way', 'rejected']);
    expect(findCardAction(card, 'approve')?.id).toBe('go-ahead');
    expect(findCardAction(card, 'deny')?.id).toBe('no-way');
  });

  it('prefers the exact id over a match by resolution', () => {
    const card = fresh(['approve', 'approved'], ['x', 'approved'], ['deny', 'rejected']);
    expect(findCardAction(card, 'approve')?.id).toBe('approve');
  });

  it('never lets a listed action on a derived id with the other resolution reverse a click', () => {
    const card = fresh(['deny', 'approved'], ['go', 'approved'], ['no', 'rejected']);
    expect(card.degraded).toContain('actions_dropped');
    expect(card.actions.map((a) => a.id)).toEqual(['go', 'no']);
    expect(clickIntent(card, payload, 'deny')?.resolution).toBe('rejected');
    expect(clickIntent(card, payload, 'approve')?.resolution).toBe('approved');
  });

  it('answers undefined when more than one resolve action has the resolution', () => {
    const card = fresh(['a1', 'approved'], ['a2', 'approved'], ['no', 'rejected']);
    expect(findCardAction(card, 'approve')).toBeUndefined();
    expect(findCardAction(card, 'deny')?.id).toBe('no');
  });

  it('answers undefined when no listed action has the resolution, and for an id of neither source', () => {
    const card = fresh(['go', 'approved']);
    expect(findCardAction(card, 'deny')).toBeUndefined();
    expect(findCardAction(card, 'zzz')).toBeUndefined();
  });

  it('does not guess the other way: a listed id on a card of derived ids is not found', () => {
    expect(findCardAction(pending(), 'go-ahead')).toBeUndefined();
  });
});

describe('clickIntent', () => {
  it('gives the approval, the resolution of the pressed action and the digest of the payload', () => {
    expect(clickIntent(pending(), payload, 'approve')).toEqual({
      approvalId: APPROVAL_ID,
      resolution: 'approved',
      expectedActionDigest: DIGEST,
    });
    expect(clickIntent(pending(), payload, 'deny')?.resolution).toBe('rejected');
  });

  it('takes the digest from the payload, not from the fresh card: a changed call is not approved by a stale click', () => {
    const changed = pending({ action_digest: 'sha256:changed' });
    expect(changed.details.actionDigest).toBe('sha256:changed');
    expect(clickIntent(changed, payload, 'approve')?.expectedActionDigest).toBe(DIGEST);
  });

  it('answers undefined for a payload of another approval', () => {
    const other = { ...payload, approval_id: '33333333-3333-4333-8333-33333333333c' };
    expect(clickIntent(pending(), other, 'approve')).toBeUndefined();
  });

  it('answers undefined when the card has no such action: an id it lacks, or an approval no longer pending', () => {
    expect(clickIntent(pending(), payload, 'nope')).toBeUndefined();
    const final = toApprovalCard(
      full(priyaResolved('approved', 'approved')),
      OTHER_VIEWER,
      options()
    );
    expect(clickIntent(final, payload, 'approve')).toBeUndefined();
  });

  it('answers undefined for an action that is not a resolve action', () => {
    const card = withOtherAction(pending());
    expect(clickIntent(card, payload, 'ask')).toBeUndefined();
  });

  it('works on a payload read back from the wire, and resolves a card sent before the feature was enabled', () => {
    const read = parseActionPayload(JSON.stringify(payload));
    if (read === undefined) throw new Error('the payload must read back');
    const intent = clickIntent(
      pending(listed(['listed-yes', 'approved'], ['listed-no', 'rejected'])),
      read,
      'deny'
    );
    expect(intent).toEqual({
      approvalId: APPROVAL_ID,
      resolution: 'rejected',
      expectedActionDigest: DIGEST,
    });
  });
});
