import { describe, expect, it } from 'vitest';

import { toAdaptiveCard } from './adaptive-card.js';
import { toBlockKit } from './block-kit.js';
import { MESSAGE_ID, OTHER_VIEWER, full, options } from './fixtures.test-support.js';
import { SLACK_LIMITS, TEAMS_LIMITS } from './limits.js';
import type { Approval } from './model.js';
import { toApprovalCard } from './model.js';
import { utf8Length } from './sanitize.js';

const listed = (count: number): NonNullable<Approval['available_actions']> =>
  Array.from({ length: count }, (_, i) => ({
    id: `act-${String(i)}`,
    kind: 'resolve',
    resolution: i % 2 === 0 ? 'approved' : 'rejected',
    label: `Option ${String(i)}`,
    inputs: [],
  })) as never;

describe('a long available_actions list', () => {
  const card = toApprovalCard(full({ available_actions: listed(500) }), OTHER_VIEWER, options());

  it('renders at most maxActions Slack buttons, plus the link, as valid JSON under the cap', () => {
    const out = toBlockKit(card, { sentMessageId: MESSAGE_ID });
    const json = JSON.stringify(out);
    expect(JSON.parse(json)).toEqual(out);
    const actions = out.blocks.find((b) => b.type === 'actions');
    const resolve = (actions?.elements as { action_id: string }[]).filter(
      (e) => e.action_id !== 'nc.open'
    );
    expect(resolve).toHaveLength(SLACK_LIMITS.maxActions);
    expect(out.blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.maxBlocks);
    expect(utf8Length(json)).toBeLessThanOrEqual(SLACK_LIMITS.messageBytes);
  });

  it('renders at most maxActions Teams actions, plus the link, as valid JSON under the cap', () => {
    const out = toAdaptiveCard(card, { sentMessageId: MESSAGE_ID });
    const json = JSON.stringify(out);
    expect(JSON.parse(json)).toEqual(out);
    expect(out.actions?.filter((a) => a.type === 'Action.Execute')).toHaveLength(
      TEAMS_LIMITS.maxActions
    );
    expect(out.actions?.filter((a) => a.type === 'Action.OpenUrl')).toHaveLength(1);
    expect(json.length * 2).toBeLessThanOrEqual(TEAMS_LIMITS.cardBytes);
    // Teams shows six primary actions and moves the rest to an overflow menu: the link is on the card.
    expect(out.actions).toHaveLength(6);
    expect(out.actions?.at(-1)?.type).toBe('Action.OpenUrl');
  });

  it('keeps the first actions, in the order the server listed them', () => {
    const out = toAdaptiveCard(card, { sentMessageId: MESSAGE_ID });
    const verbs = (out.actions ?? []).flatMap((a) => (a.type === 'Action.Execute' ? [a.verb] : []));
    expect(verbs).toEqual(
      Array.from({ length: TEAMS_LIMITS.maxActions }, (_, i) => `act-${String(i)}`)
    );
  });
});
