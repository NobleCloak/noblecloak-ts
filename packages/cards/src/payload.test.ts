import { describe, expect, it } from 'vitest';

import {
  APPROVAL_ID,
  DIGEST,
  MESSAGE_ID,
  OTHER_VIEWER,
  full,
  options,
} from './fixtures.test-support.js';
import { toApprovalCard } from './model.js';
import { encodeActionPayload, findCardAction, parseActionPayload } from './payload.js';

const card = () => toApprovalCard(full(), OTHER_VIEWER, options());
const good = {
  v: 1,
  approval_id: APPROVAL_ID,
  sent_message_id: MESSAGE_ID,
  expected_action_digest: DIGEST,
};

describe('payload', () => {
  it('encodes exactly three references and the version, and parses back', () => {
    const raw = encodeActionPayload(card(), MESSAGE_ID);
    expect(Object.keys(JSON.parse(raw) as object)).toEqual([
      'v',
      'approval_id',
      'sent_message_id',
      'expected_action_digest',
    ]);
    expect(raw.length).toBeLessThanOrEqual(2000);
    expect(parseActionPayload(raw)).toEqual(good);
  });

  it('parses the object an Execute action carries', () => {
    expect(parseActionPayload(good)).toEqual(good);
  });

  it('refuses an extra key, a missing key, a bad id, v 2, an empty digest and a non-JSON string', () => {
    const bad: unknown[] = [
      { ...good, action_id: 'approve' },
      { ...good, token: 't' },
      { v: 1, approval_id: APPROVAL_ID, sent_message_id: MESSAGE_ID },
      { ...good, approval_id: 'not-a-uuid' },
      { ...good, sent_message_id: 'x' },
      { ...good, v: 2 },
      { ...good, expected_action_digest: '' },
      { ...good, expected_action_digest: 5 },
      'not json',
      '[]',
      '{"v":1',
      JSON.stringify({ ...good, extra: 1 }),
      'x'.repeat(2001),
      null,
      undefined,
      42,
      [],
    ];
    for (const raw of bad) expect(parseActionPayload(raw)).toBeUndefined();
  });

  it('refuses to encode what could not parse back', () => {
    expect(() => encodeActionPayload(card(), 'not-a-uuid')).toThrow(RangeError);
    expect(() =>
      encodeActionPayload(
        toApprovalCard({ ...full(), id: 'opaque' }, OTHER_VIEWER, options()),
        MESSAGE_ID
      )
    ).toThrow(RangeError);
    expect(() =>
      encodeActionPayload(
        toApprovalCard({ ...full(), action_digest: '' }, OTHER_VIEWER, options()),
        MESSAGE_ID
      )
    ).toThrow(RangeError);
    const long = toApprovalCard(
      { ...full(), action_digest: 'd'.repeat(2000) },
      OTHER_VIEWER,
      options()
    );
    expect(() => encodeActionPayload(long, MESSAGE_ID)).toThrow(RangeError);
  });

  it('finds the card action a platform identifier names', () => {
    const c = card();
    expect(findCardAction(c, 'deny')?.label).toBe('Deny');
    expect(findCardAction(c, 'approve')?.id).toBe('approve');
    expect(findCardAction(c, 'nc.open')).toBeUndefined();
    expect(findCardAction(c, 'escalate')).toBeUndefined();
    const final = toApprovalCard(full({ state: 'approved' }), OTHER_VIEWER, options());
    expect(findCardAction(final, 'approve')).toBeUndefined();
  });
});
