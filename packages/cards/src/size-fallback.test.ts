import { describe, expect, it, vi } from 'vitest';

import type * as Limits from './limits.js';

// A cap small enough that a card with a long call, facts and history cannot fit, so the fallback is reached
// with realistic content. Everything else in the limits is the real value.
vi.mock('./limits.js', async (importOriginal) => {
  const real = await importOriginal<typeof Limits>();
  return {
    ...real,
    TEAMS_LIMITS: { ...real.TEAMS_LIMITS, cardBytes: 7000 },
    SLACK_LIMITS: { ...real.SLACK_LIMITS, messageBytes: 5000 },
  };
});

import { renderAdaptiveCard, toAdaptiveCard } from './adaptive-card.js';
import { renderBlockKit, toBlockKit } from './block-kit.js';
import type { SlackBlock } from './block-kit.js';
import {
  APPROVALS_URL,
  MESSAGE_ID,
  OTHER_VIEWER,
  full,
  options,
  priyaResolved,
} from './fixtures.test-support.js';
import { SLACK_LIMITS, TEAMS_LIMITS } from './limits.js';
import type { Approval } from './model.js';
import { toApprovalCard } from './model.js';
import { utf16Length, utf8Length } from './sanitize.js';

const person = (id: string, name: string) => ({ id, kind: 'user' as const, display_name: name });

const historyOf = (): NonNullable<Approval['resolution_history']> =>
  Array.from({ length: 5 }, (_, i) => ({
    resolution: 'approved',
    by: person(`h${String(i)}`, 'N'.repeat(10_000)),
    at: '2026-10-30T10:00:00Z',
    reason: 'r'.repeat(400),
  }));

/** Facts, a five-entry history, a call that fits its budget and ten resolve actions. */
function heavy(over: Partial<Approval> = {}): Approval {
  const name = 'N'.repeat(10_000);
  return full({
    arguments: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`key${String(i)}`, 'v'.repeat(150)])
    ),
    requester: person('u-dana', name),
    agent: { id: 'agent-7', name, parent: name },
    resolution_history: historyOf(),
    available_actions: Array.from({ length: 10 }, (_, i) => ({
      id: `act-${String(i)}`,
      kind: 'resolve',
      resolution: 'approved',
      label: 'Approve',
      inputs: [],
    })) as never,
    ...over,
  });
}

const card = (approval: Approval) => toApprovalCard(approval, OTHER_VIEWER, options());
const sent = { sentMessageId: MESSAGE_ID };
const types = (blocks: readonly SlackBlock[]) => blocks.map((b) => b.type);

describe('Block Kit: over the size cap', () => {
  it('falls back to the minimal card, with the link and a truncated header', () => {
    const out = toBlockKit(card(heavy()), sent);
    expect(types(out.blocks)).toEqual(['header', 'section', 'context', 'actions']);
    const json = JSON.stringify(out);
    expect(json).toContain(APPROVALS_URL);
    expect(json).toContain('…');
    expect(json).not.toContain('"fields"');
    expect(json).not.toContain('History');
    expect(json).not.toContain('"input"');
    expect(json).not.toContain('"value"');
    expect(utf8Length(json)).toBeLessThanOrEqual(SLACK_LIMITS.messageBytes);
  });

  it('keeps the link of a closed request on the section, with no actions block', () => {
    const out = toBlockKit(
      card(heavy({ ...priyaResolved('consumed', 'approved'), resolution_history: historyOf() })),
      sent
    );
    expect(types(out.blocks)).toEqual(['header', 'section', 'context']);
    expect(JSON.stringify(out.blocks[1])).toContain(APPROVALS_URL);
  });

  it('leaves a card under the cap as it was', () => {
    const out = toBlockKit(card(full()), sent);
    expect(types(out.blocks)).toContain('actions');
    expect(JSON.stringify(out)).toContain('"fields"');
    expect(utf8Length(JSON.stringify(out))).toBeLessThanOrEqual(SLACK_LIMITS.messageBytes);
  });
});

describe('Adaptive Card: over the size cap', () => {
  it('falls back to the minimal card, with the link and a truncated headline', () => {
    const out = toAdaptiveCard(card(heavy()), sent);
    const json = JSON.stringify(out);
    expect(out.body.map((e) => e.type)).toEqual(['TextBlock', 'TextBlock', 'TextBlock']);
    expect(out.actions).toMatchObject([{ type: 'Action.OpenUrl', url: APPROVALS_URL }]);
    expect(json).toContain('…');
    expect(json).not.toContain('FactSet');
    expect(json).not.toContain('Action.Execute');
    expect(json).not.toContain('Input.Text');
    expect(utf16Length(json)).toBeLessThanOrEqual(TEAMS_LIMITS.cardBytes);
  });

  it('keeps the link of a closed request on the headline, with no actions member', () => {
    const out = toAdaptiveCard(
      card(heavy({ ...priyaResolved('consumed', 'approved'), resolution_history: historyOf() })),
      sent
    );
    expect(out).not.toHaveProperty('actions');
    expect(out.body[1]).toMatchObject({
      type: 'Container',
      selectAction: { type: 'Action.OpenUrl', url: APPROVALS_URL },
    });
  });

  it('leaves a card under the cap as it was', () => {
    const out = toAdaptiveCard(card(full()), sent);
    expect(JSON.stringify(out)).toContain('FactSet');
    expect(out.actions?.some((a) => a.type === 'Action.Execute')).toBe(true);
    expect(utf16Length(JSON.stringify(out))).toBeLessThanOrEqual(TEAMS_LIMITS.cardBytes);
  });
});

describe('the size fallback is signalled to the caller', () => {
  it('lists minimal, and no_payload too when there is no sentMessageId', () => {
    expect(renderBlockKit(card(heavy()), sent).degraded).toEqual(['minimal']);
    // heavy() offers 10 resolve actions: over Teams' five, not over Slack's ten.
    expect(renderAdaptiveCard(card(heavy()), sent).degraded).toEqual(['actions_capped', 'minimal']);
    expect(renderBlockKit(card(heavy()), {}).degraded).toEqual(['no_payload', 'minimal']);
  });

  it('lists nothing for a card under the cap', () => {
    expect(renderBlockKit(card(full()), sent).degraded).toEqual([]);
    expect(renderAdaptiveCard(card(full()), sent).degraded).toEqual([]);
  });
});

describe('degradation codes on the minimal card', () => {
  const heavyShortened = (url = APPROVALS_URL) =>
    toApprovalCard(
      heavy({ arguments: { note: 'x'.repeat(600) } }),
      OTHER_VIEWER,
      options({ approvalsUrl: url })
    );

  it.each([
    ['Slack', (c: ReturnType<typeof heavyShortened>) => renderBlockKit(c, sent).degraded],
    ['Teams', (c: ReturnType<typeof heavyShortened>) => renderAdaptiveCard(c, sent).degraded],
  ])(
    '%s: leaves out the codes of a call the minimal card does not show, and ends with minimal',
    (_n, degradedOf) => {
      const degraded = degradedOf(heavyShortened());
      expect(degraded.at(-1)).toBe('minimal');
      expect(degraded).not.toContain('call_shortened');
      expect(degraded).not.toContain('call_too_large');
    }
  );

  it.each([
    ['Slack', (c: ReturnType<typeof heavyShortened>) => renderBlockKit(c, sent).degraded],
    ['Teams', (c: ReturnType<typeof heavyShortened>) => renderAdaptiveCard(c, sent).degraded],
  ])('%s: says no_link when the minimal card has no link either', (_n, degradedOf) => {
    expect(degradedOf(heavyShortened('ftp://nope')).slice(-2)).toEqual(['no_link', 'minimal']);
    expect(degradedOf(heavyShortened())).not.toContain('no_link');
  });
});
