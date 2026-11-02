import { describe, expect, it } from 'vitest';

import { renderBlockKit } from './block-kit.js';
import { APPROVALS_URL, MESSAGE_ID, OTHER_VIEWER, full, options } from './fixtures.test-support.js';
import { SLACK_LIMITS } from './limits.js';
import type { Approval } from './model.js';
import { toApprovalCard } from './model.js';
import { utf8Length } from './sanitize.js';

// The real limits, no mock. Slack counts the message in UTF-8 bytes, so a card of three-byte characters in
// every field, with ten resolve actions, is over the 40,000-byte budget although every field is within its cut.
const wide = (n: number): string => '中'.repeat(n);
const person = (id: string) => ({ id, kind: 'user' as const, display_name: wide(3000) });

function widest(): Approval {
  return full({
    arguments: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`key${String(i)}`, wide(150)])
    ),
    tool_ref: wide(5000),
    scope_id: wide(5000),
    action_digest: 'd'.repeat(1500),
    requester: person('r'),
    agent: { id: 'a', name: wide(3000), parent: wide(3000) },
    waiting_on: { count: 5, principals: ['1', '2', '3', '4', '5'].map(person) },
    resolution_history: Array.from({ length: 5 }, (_, i) => ({
      resolution: 'approved',
      by: person(`h${String(i)}`),
      at: '2026-10-30T10:00:00Z',
      reason: wide(400),
    })),
    available_actions: Array.from({ length: 10 }, (_, i) => ({
      id: `act-${String(i)}`,
      kind: 'resolve',
      resolution: 'approved',
      label: wide(100),
      inputs: [{ name: `in${String(i)}`, type: 'text', label: wide(2000), required: false }],
    })) as never,
  });
}

describe('Block Kit at the real size budget', () => {
  it('falls back to the minimal message for the widest card the limits allow', () => {
    const card = toApprovalCard(widest(), OTHER_VIEWER, options());
    const out = renderBlockKit(card, { sentMessageId: MESSAGE_ID });
    expect(out.degraded).toContain('minimal');
    expect(out.message.blocks.map((b) => b.type)).toEqual([
      'header',
      'section',
      'context',
      'actions',
    ]);
    expect(utf8Length(JSON.stringify(out.message))).toBeLessThanOrEqual(SLACK_LIMITS.messageBytes);
    const button = out.message.blocks.find((b) => b.type === 'actions')?.elements as
      readonly { action_id?: string; url?: string }[] | undefined;
    expect(button?.map((e) => [e.action_id, e.url])).toEqual([['nc.open', APPROVALS_URL]]);
  });

  it('keeps a card of ordinary size', () => {
    const out = renderBlockKit(toApprovalCard(full(), OTHER_VIEWER, options()), {
      sentMessageId: MESSAGE_ID,
    });
    expect(out.degraded).toEqual([]);
  });
});
