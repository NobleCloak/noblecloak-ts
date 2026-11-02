import { describe, expect, it } from 'vitest';

import { renderAdaptiveCard } from './adaptive-card.js';
import { APPROVALS_URL, MESSAGE_ID, OTHER_VIEWER, full, options } from './fixtures.test-support.js';
import { TEAMS_LIMITS } from './limits.js';
import type { Approval } from './model.js';
import { toApprovalCard } from './model.js';

// Real limits, no mock. Every server field is backslashes, which the markdown escape doubles and JSON doubles
// again, and the card is as wide as the limits allow: the full card is about 42,500 UTF-8 bytes and 85,000
// UTF-16 bytes, so only a count in UTF-16 sends the minimal card.
const slashes = (count: number): string => '\\'.repeat(count);

function wide(digestChars: number): Approval {
  const person = (id: string) => ({ id, kind: 'user' as const, display_name: slashes(10_000) });
  return full({
    action_digest: 'd'.repeat(digestChars),
    tool_ref: slashes(10_000),
    scope_id: slashes(10_000),
    requester: person('u-dana'),
    waiting_on: { count: 2, principals: [person('p1'), person('p2')] },
    agent: { id: 'a', name: slashes(10_000), parent: slashes(10_000) },
    run: { id: slashes(10_000), kind: 'governed' },
    policy: { id: slashes(10_000), version: 3 },
    arguments: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`key${String(i)}`, slashes(150)])
    ),
    resolution_history: Array.from({ length: 5 }, (_, i) => ({
      resolution: 'approved',
      by: person(`h${String(i)}`),
      at: '2026-10-30T10:00:00Z',
      reason: slashes(400),
    })),
    available_actions: Array.from({ length: 10 }, (_, i) => ({
      id: `act-${'x'.repeat(150)}-${String(i)}`,
      kind: 'resolve',
      resolution: 'approved',
      label: slashes(200),
      inputs: [
        {
          name: `in-${'y'.repeat(150)}-${String(i)}`,
          type: 'text',
          label: slashes(500),
          required: false,
        },
      ],
    })) as never,
  });
}

describe('Teams size cap counts UTF-16', () => {
  it('replaces a card that is under 80,000 UTF-8 bytes but over 80,000 UTF-16 bytes', () => {
    const card = toApprovalCard(wide(1800), OTHER_VIEWER, options());
    const out = renderAdaptiveCard(card, { sentMessageId: MESSAGE_ID });
    expect(out.degraded).toContain('minimal');
    expect(JSON.stringify(out.card).length * 2).toBeLessThanOrEqual(TEAMS_LIMITS.cardBytes);
    expect(out.card.actions?.map((a) => [a.type, a.url])).toEqual([
      ['Action.OpenUrl', APPROVALS_URL],
    ]);
  });

  it('keeps a card whose UTF-16 size is within the cap', () => {
    const card = toApprovalCard(full(), OTHER_VIEWER, options());
    const out = renderAdaptiveCard(card, { sentMessageId: MESSAGE_ID });
    expect(out.degraded).toEqual([]);
    expect(JSON.stringify(out.card).length * 2).toBeLessThanOrEqual(TEAMS_LIMITS.cardBytes);
  });
});
