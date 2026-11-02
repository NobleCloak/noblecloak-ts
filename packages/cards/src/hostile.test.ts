import { describe, expect, it } from 'vitest';

import { toAdaptiveCard } from './adaptive-card.js';
import { toBlockKit } from './block-kit.js';
import {
  APPROVALS_URL,
  MESSAGE_ID,
  OTHER_VIEWER,
  full,
  minimal,
  options,
} from './fixtures.test-support.js';
import { SLACK_LIMITS, TEAMS_LIMITS } from './limits.js';
import type { Approval } from './model.js';
import { toApprovalCard } from './model.js';
import { utf16Length } from './sanitize.js';

const HOSTILE = [
  '<!channel>',
  '<!here>',
  '<@U123>',
  '<!subteam^S1>',
  '@here',
  '@channel',
  '*bold*',
  '`',
  '<at>Priya</at>',
  '[x](https://evil)',
  '\u202e',
  '&',
].join(' ');

function nested(depth: number): Record<string, unknown> {
  let value: unknown = 'leaf';
  for (let i = 0; i < depth; i += 1) value = { n: value };
  return value as Record<string, unknown>;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) strings(item, out);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) strings(item, out);
  }
  return out;
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) for (const item of value as unknown[]) walk(item, visit);
  else if (typeof value === 'object' && value !== null) {
    visit(value as Record<string, unknown>);
    for (const item of Object.values(value)) walk(item, visit);
  }
}

const many = Object.fromEntries(
  Array.from({ length: 1000 }, (_, i) => [`key${String(i)}`, `value ${String(i)}`])
);

const HUGE: readonly [string, Record<string, unknown>][] = [
  ['a 200 KB string', { text: 'A'.repeat(200_000) }],
  ['1000 keys', many],
  ['nesting depth 64', nested(64)],
  ['nesting depth 100000', nested(100_000)],
  ['hostile strings', { a: HOSTILE, [HOSTILE]: HOSTILE, list: [HOSTILE] }],
];

function hostileApproval(args: Record<string, unknown>): Approval {
  const name = `${HOSTILE} ${'N'.repeat(2000)}`;
  return full({
    arguments: args,
    tool_ref: `${HOSTILE} ${'t'.repeat(500)}`,
    requester: { id: 'u-dana', kind: 'user', display_name: name },
    agent: { id: 'agent-7', name, parent: name },
    approver: { id: 'u-p', kind: 'user', display_name: name },
    waiting_on: {
      count: 5,
      principals: Array.from({ length: 5 }, (_, i) => ({
        id: `w${String(i)}`,
        kind: 'user' as const,
        display_name: name,
      })),
    },
    scope_id: HOSTILE,
    resolution_history: Array.from({ length: 12 }, (_, i) => ({
      resolution: 'rejected',
      by: { id: `h${String(i)}`, kind: 'user' as const, display_name: name },
      at: HOSTILE,
      reason: `${HOSTILE} ${'r'.repeat(5000)}`,
    })),
    available_actions: [
      {
        id: 'approve',
        kind: 'resolve',
        resolution: 'approved',
        label: `${HOSTILE}${'L'.repeat(400)}`,
        inputs: [
          {
            name: 'reason',
            type: 'text',
            label: HOSTILE + 'x'.repeat(3000),
            required: false,
            max_length: 9000,
          },
        ],
      },
      {
        id: 'deny',
        kind: 'resolve',
        resolution: 'rejected',
        label: 'Deny',
        inputs: [{ name: 'reason', type: 'text', label: 'n', required: false }],
      },
    ] as never,
  });
}

describe.each(HUGE)('hostile: %s', (_name, args) => {
  const card = toApprovalCard(hostileApproval(args), OTHER_VIEWER, options());

  it('keeps every Slack field within the documented limits and keeps the link', () => {
    const out = toBlockKit(card, { sentMessageId: MESSAGE_ID });
    expect(out.blocks.length).toBeGreaterThan(0);
    expect(out.blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.maxBlocks);
    expect(out.text.length).toBeLessThanOrEqual(SLACK_LIMITS.fallbackText);
    walk(out.blocks, (node) => {
      const text = node.text;
      if (node.type === 'header') {
        expect((text as { text: string }).text.length).toBeLessThanOrEqual(SLACK_LIMITS.headerText);
      }
      if (node.type === 'section') {
        if (typeof text === 'object' && text !== null) {
          expect((text as { text: string }).text.length).toBeLessThanOrEqual(
            SLACK_LIMITS.sectionText
          );
        }
        const fields = node.fields as { text: string }[] | undefined;
        if (fields !== undefined) {
          expect(fields.length).toBeLessThanOrEqual(SLACK_LIMITS.sectionFields);
          for (const field of fields)
            expect(field.text.length).toBeLessThanOrEqual(SLACK_LIMITS.sectionField);
        }
      }
      if (node.type === 'button') {
        expect((text as { text: string }).text.length).toBeLessThanOrEqual(SLACK_LIMITS.buttonText);
        expect(String(node.action_id).length).toBeLessThanOrEqual(SLACK_LIMITS.actionId);
        const { value, url } = node;
        if (typeof value === 'string')
          expect(value.length).toBeLessThanOrEqual(SLACK_LIMITS.buttonValue);
        if (typeof url === 'string') expect(url.length).toBeLessThanOrEqual(SLACK_LIMITS.buttonUrl);
      }
      if (node.type === 'input') {
        expect(String(node.block_id).length).toBeLessThanOrEqual(SLACK_LIMITS.blockId);
        expect((node.label as { text: string }).text.length).toBeLessThanOrEqual(
          SLACK_LIMITS.inputLabel
        );
      }
      if (node.type === 'plain_text_input') {
        expect(node.max_length).toBeLessThanOrEqual(SLACK_LIMITS.inputMaxLength);
      }
    });
    expect(JSON.stringify(out)).toContain(APPROVALS_URL);
  });

  it('never lets a server string through as live Slack syntax', () => {
    const out = toBlockKit(card, { sentMessageId: MESSAGE_ID });
    const json = JSON.stringify(out);
    expect(json).not.toContain('link_names');
    expect(json).not.toContain('\u202e');
    for (const text of strings(out)) {
      expect(text).not.toMatch(/[<>]/u);
      expect(text).not.toMatch(/&(?!amp;|lt;|gt;)/u);
    }
    walk(out.blocks, (node) => {
      if (node.type === 'mrkdwn') expect(node.verbatim).toBe(true);
    });
  });

  it('keeps the Teams card within 80 KB and keeps the link', () => {
    const out = toAdaptiveCard(card, { sentMessageId: MESSAGE_ID });
    const json = JSON.stringify(out);
    expect(utf16Length(json)).toBeLessThanOrEqual(TEAMS_LIMITS.cardBytes);
    expect(out.body.length).toBeGreaterThan(0);
    expect(json).toContain(APPROVALS_URL);
  });

  it('never lets a server string through as live Teams syntax', () => {
    const out = toAdaptiveCard(card, { sentMessageId: MESSAGE_ID });
    const json = JSON.stringify(out);
    expect(json).not.toContain('msteams');
    expect(json).not.toContain('\u202e');
    // An action title is plain text, so its brackets are look-alikes too; the title of a resolve action is the
    // deployment's label, which is hostile here.
    const titles = (out.actions ?? []).map((action) => action.title);
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(title).not.toMatch(/[<>[\]]/u);
    for (const element of out.body) {
      walk(element, (node) => {
        for (const key of ['text', 'value', 'title', 'label']) {
          const text = node[key];
          if (typeof text !== 'string') continue;
          // An input label is plain text, so its brackets are look-alikes; everything else is markdown, so each marker is escaped.
          expect(text).not.toMatch(
            node.type === 'Input.Text' ? /[<>[\]]/u : /(?<!\\)[`*_~[\]()<>#|&!]/u
          );
        }
      });
    }
  });
});

describe('hostile: the call is cut with a link, not dropped', () => {
  it('replaces an over-budget call in both renderers', () => {
    const card = toApprovalCard(full({ arguments: many }), OTHER_VIEWER, options());
    const slack = JSON.stringify(toBlockKit(card, { sentMessageId: MESSAGE_ID }));
    const teams = JSON.stringify(toAdaptiveCard(card, { sentMessageId: MESSAGE_ID }));
    for (const text of [slack, teams]) {
      expect(text).toContain('View the full call in Approvals');
      expect(text).not.toContain('key999');
    }
  });

  it('shows a call within budget in full', () => {
    const card = toApprovalCard(full({ arguments: { ok: 'yes' } }), OTHER_VIEWER, options());
    expect(JSON.stringify(toBlockKit(card, { sentMessageId: MESSAGE_ID }))).toContain(
      '\\"ok\\": \\"yes\\"'
    );
    expect(JSON.stringify(toAdaptiveCard(card, { sentMessageId: MESSAGE_ID }))).toContain(
      '\\"ok\\": \\"yes\\"'
    );
  });

  it('renders a hostile approval id, digest and link without throwing', () => {
    const card = toApprovalCard(
      minimal({ id: '<!channel>', action_digest: '`'.repeat(5000) }),
      OTHER_VIEWER,
      options({ approvalsUrl: 'https://x.test/<script>' })
    );
    const slack = toBlockKit(card, { sentMessageId: MESSAGE_ID });
    const teams = toAdaptiveCard(card, { sentMessageId: MESSAGE_ID });
    expect(slack.blocks.length).toBeGreaterThan(0);
    expect(teams.body.length).toBeGreaterThan(0);
    expect(JSON.stringify(slack)).not.toContain('<script>');
    expect(JSON.stringify(slack)).not.toContain('"value"');
    expect(JSON.stringify(teams)).not.toContain('Action.Execute');
  });
});
