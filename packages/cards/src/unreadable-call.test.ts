import { describe, expect, it } from 'vitest';

import { toAdaptiveCard } from './adaptive-card.js';
import { toBlockKit } from './block-kit.js';
import { MESSAGE_ID, OTHER_VIEWER, full, options } from './fixtures.test-support.js';
import type { ApprovalCard } from './model.js';
import { toApprovalCard } from './model.js';
import { CARD_TEXT } from './text.js';

function withCall(args: Record<string, unknown>): ApprovalCard {
  const card = toApprovalCard(full(), OTHER_VIEWER, options());
  return {
    ...card,
    facts: { ...card.facts, call: { kind: 'arguments', arguments: args } },
  };
}

const hostile = {
  get boom(): string {
    throw new Error('no');
  },
};

describe('a call whose arguments cannot be read', () => {
  it('is worded as unreadable on Slack, not as too large', () => {
    const text = JSON.stringify(toBlockKit(withCall(hostile), { sentMessageId: MESSAGE_ID }));
    expect(text).toContain(CARD_TEXT.callUnreadable);
    expect(text).not.toContain(`"${CARD_TEXT.viewFullCall}"`);
  });

  it('is worded as unreadable on Teams, not as too large', () => {
    const text = JSON.stringify(toAdaptiveCard(withCall(hostile), { sentMessageId: MESSAGE_ID }));
    expect(text).toContain(CARD_TEXT.callUnreadable);
    expect(text).not.toContain(`"${CARD_TEXT.viewFullCall}"`);
  });

  it('keeps the too-large wording for an oversized call', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 1000; i += 1) wide[`key${String(i)}`] = 'v'.repeat(100);
    const text = JSON.stringify(toBlockKit(withCall(wide), { sentMessageId: MESSAGE_ID }));
    expect(text).toContain(CARD_TEXT.viewFullCall);
    expect(text).not.toContain(CARD_TEXT.callUnreadable);
  });
});
