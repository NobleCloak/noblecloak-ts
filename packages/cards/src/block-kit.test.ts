import { describe, expect, it } from 'vitest';

import { toAdaptiveCard } from './adaptive-card.js';
import { toBlockKit } from './block-kit.js';
import type { SlackBlock } from './block-kit.js';
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
import { findCardAction, parseActionPayload } from './payload.js';

const render = (approval: Approval, viewer: CardViewer = OTHER_VIEWER, opts = options()) => {
  const card = toApprovalCard(approval, viewer, opts);
  return { card, out: toBlockKit(card, { sentMessageId: MESSAGE_ID }) };
};
const golden = (name: string) => `./golden/block-kit-${name}.json`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const actionsBlock = (blocks: readonly SlackBlock[]) => blocks.find((b) => b.type === 'actions');
const buttons = (blocks: readonly SlackBlock[]) =>
  ((actionsBlock(blocks)?.elements ?? []) as Record<string, unknown>[]).filter(
    (e) => e.type === 'button'
  );

describe('block-kit golden', () => {
  it('pending', async () => {
    await expect(json(render(full()).out)).toMatchFileSnapshot(golden('pending'));
  });
  it('self', async () => {
    await expect(json(render(full(), REQUESTER_VIEWER).out)).toMatchFileSnapshot(golden('self'));
  });
  it('final, as the approver', async () => {
    const out = render(full(priyaResolved('consumed', 'approved', 'refund matches ticket')), {
      principalId: 'u-priya',
    }).out;
    await expect(json(out)).toMatchFileSnapshot(golden('final-approver'));
  });
  it('final, as another person', async () => {
    await expect(json(render(full(priyaResolved('rejected', 'rejected'))).out)).toMatchFileSnapshot(
      golden('final-other')
    );
  });
  it('final, withdrawn', async () => {
    await expect(json(render(full({ state: 'withdrawn' })).out)).toMatchFileSnapshot(
      golden('final-withdrawn')
    );
  });
});

describe('block-kit buttons', () => {
  it('carry one payload that parses, with exactly the reference keys, and the card action id as action_id', () => {
    const { card, out } = render(full());
    const resolve = buttons(out.blocks).filter((b) => b.action_id !== 'nc.open');
    expect(resolve.map((b) => b.action_id)).toEqual(['approve', 'deny']);
    const values = new Set(resolve.map((b) => b.value));
    expect(values.size).toBe(1);
    const value = [...values][0] as string;
    expect(Object.keys(JSON.parse(value) as object).sort()).toEqual(
      ['approval_id', 'expected_action_digest', 'sent_message_id', 'v'].sort()
    );
    expect(parseActionPayload(value)).toEqual({
      v: 1,
      approval_id: APPROVAL_ID,
      sent_message_id: MESSAGE_ID,
      expected_action_digest: DIGEST,
    });
    const rebuilt = toApprovalCard(full(), OTHER_VIEWER, options());
    for (const button of resolve) {
      expect(findCardAction(rebuilt, button.action_id as string)).toEqual(
        card.actions.find((a) => a.id === button.action_id)
      );
    }
    expect(resolve.map((b) => b.style)).toEqual(['primary', 'danger']);
  });

  it('carry no token or credential member', () => {
    for (const button of buttons(render(full()).out.blocks)) {
      expect(
        Object.keys(button).filter((k) => /token|secret|credential|password|auth/iu.test(k))
      ).toEqual([]);
    }
    expect(JSON.stringify(render(full()).out)).not.toMatch(/token|secret|credential/iu);
  });

  it('end in an Open in Approvals link button that is no card action', () => {
    const open = buttons(render(full()).out.blocks).find((b) => b.action_id === 'nc.open');
    expect(open?.url).toBe(APPROVALS_URL);
    expect(open?.value).toBeUndefined();
  });

  it('are absent, with the inputs, when no sent-message id is given or it is no UUID', () => {
    for (const sentMessageId of [undefined, 'row-1']) {
      const card = toApprovalCard(full(), OTHER_VIEWER, options());
      const out = toBlockKit(card, sentMessageId === undefined ? {} : { sentMessageId });
      expect(out.blocks.some((b) => b.type === 'input')).toBe(false);
      expect(buttons(out.blocks).map((b) => b.action_id)).toEqual(['nc.open']);
    }
  });

  it('omit the link button when the link is not a web URL', () => {
    const out = render(full(), OTHER_VIEWER, options({ approvalsUrl: 'javascript:alert(1)' })).out;
    expect(buttons(out.blocks).map((b) => b.action_id)).toEqual(['approve', 'deny']);
  });
});

describe('block-kit inputs', () => {
  it('render one plain_text_input for the note the two actions share, optional, with max_length', () => {
    const inputs = render(full()).out.blocks.filter((b) => b.type === 'input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      block_id: 'nc.input.reason',
      optional: true,
      element: { type: 'plain_text_input', action_id: 'reason', max_length: 1000 },
    });
  });

  it("share one field per name, with the first action's label, optional unless every action requires it", () => {
    const action = (id: string, resolution: string, label: string, required: boolean) => ({
      id,
      kind: 'resolve',
      resolution,
      label: id,
      inputs: [{ name: 'reason', type: 'text', label, required, max_length: 50 }],
    });
    const { out } = render(
      full({
        available_actions: [
          action('a', 'approved', 'First', false),
          action('b', 'rejected', 'Second', true),
        ] as never,
      })
    );
    const inputs = out.blocks.filter((b) => b.type === 'input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ optional: true, label: { text: 'First' } });
  });

  it('are required only when every action requires them', () => {
    const input = { name: 'reason', type: 'text', label: 'Why?', required: true, max_length: 50 };
    const action = (id: string, resolution: string, required: boolean) => ({
      id,
      kind: 'resolve',
      resolution,
      label: id,
      inputs: [{ ...input, required }],
    });
    const both = render(
      full({
        available_actions: [action('a', 'approved', true), action('b', 'rejected', true)] as never,
      })
    );
    expect(both.out.blocks.find((b) => b.type === 'input')?.optional).toBe(false);
    const one = render(
      full({
        available_actions: [action('a', 'approved', true), action('b', 'rejected', false)] as never,
      })
    );
    expect(one.out.blocks.find((b) => b.type === 'input')?.optional).toBe(true);
  });

  it('are optional when an action that does not take them is shown (Teams validates every input)', () => {
    const state = full({
      available_actions: [
        {
          id: 'approve',
          kind: 'resolve',
          resolution: 'approved',
          label: 'Approve',
          inputs: [{ name: 'ticket', type: 'text', label: 'Ticket', required: true }],
        },
        { id: 'deny', kind: 'resolve', resolution: 'rejected', label: 'Deny', inputs: [] },
      ] as never,
    });
    expect(render(state).out.blocks.find((b) => b.type === 'input')?.optional).toBe(true);
    const teams = toAdaptiveCard(toApprovalCard(state, OTHER_VIEWER, options()), {
      sentMessageId: MESSAGE_ID,
    });
    expect(teams.body.find((e) => e.type === 'Input.Text')?.isRequired).toBe(false);
  });

  it('are required on Teams and on Slack when every shown action takes them and requires them', () => {
    const required = (id: string, resolution: 'approved' | 'rejected') => ({
      id,
      kind: 'resolve',
      resolution,
      label: id,
      inputs: [{ name: 'ticket', type: 'text', label: 'Ticket', required: true }],
    });
    const state = full({
      available_actions: [required('approve', 'approved'), required('deny', 'rejected')] as never,
    });
    expect(render(state).out.blocks.find((b) => b.type === 'input')?.optional).toBe(false);
    const teams = toAdaptiveCard(toApprovalCard(state, OTHER_VIEWER, options()), {
      sentMessageId: MESSAGE_ID,
    });
    expect(teams.body.find((e) => e.type === 'Input.Text')?.isRequired).toBe(true);
  });
});

describe('block-kit final', () => {
  it('has no input block, no actions block and no resolve button, only the link on the call section', () => {
    for (const state of ['approved', 'consumed', 'rejected', 'expired', 'withdrawn'] as const) {
      const { out } = render(full({ state }));
      expect(out.blocks.some((b) => b.type === 'input' || b.type === 'actions')).toBe(false);
      const linked = out.blocks.filter((b) => b.accessory !== undefined);
      expect(linked).toHaveLength(1);
      expect(linked[0]?.accessory).toMatchObject({ action_id: 'nc.open', url: APPROVALS_URL });
      expect(JSON.stringify(out)).not.toContain('"value"');
      expect(JSON.stringify(out)).not.toContain('amount');
    }
  });

  it('has no link at all when the link is not a web URL', () => {
    const { out } = render(
      full({ state: 'expired' }),
      OTHER_VIEWER,
      options({ approvalsUrl: 'nope' })
    );
    expect(JSON.stringify(out)).not.toContain('accessory');
    expect(JSON.stringify(out)).not.toContain('View the full call');
  });
});

describe('block-kit text', () => {
  it('shows the call in a verbatim code block, shortened with a note when a string was cut', () => {
    const { out } = render(full({ arguments: { note: 'x'.repeat(2000) } }));
    const code = out.blocks.find(
      (b) => (b.text as { type?: string } | undefined)?.type === 'mrkdwn'
    );
    expect(code?.text).toMatchObject({ verbatim: true });
    expect(JSON.stringify(out)).toContain('Shortened. View the full call in Approvals.');
  });

  it('says why the call is not shown, and points to Approvals', () => {
    const text = JSON.stringify(
      render(full(), OTHER_VIEWER, options({ blockCallInChat: true })).out
    );
    expect(text).toContain('The call is not shown in chat. View the full call in Approvals');
    expect(JSON.stringify(render(full({ arguments: undefined as never })).out)).toContain(
      'The call was not sent with this request.'
    );
  });

  it('carries the already_handled notice before the status line', () => {
    const { out } = render(full(), OTHER_VIEWER, options({ notice: 'already_handled' }));
    const context = out.blocks.at(-2) ?? out.blocks.at(-1);
    expect(JSON.stringify(out.blocks.filter((b) => b.type === 'context'))).toContain(
      'This request was already handled.'
    );
    expect(context).toBeDefined();
  });

  it('puts only fixed text and the tool in the notification fallback', () => {
    expect(render(full()).out.text).toBe('Approval request: payments.refund');
  });

  it('lists the latest history entries', () => {
    const history = Array.from({ length: 9 }, (_, i) => ({
      resolution: 'rejected',
      by: { id: `u${String(i)}`, kind: 'user' as const },
      at: `2026-10-30T0${String(i)}:00:00Z`,
      reason: `r${String(i)}`,
    }));
    const text = JSON.stringify(render(full({ resolution_history: history })).out);
    expect(text).toContain('rejected by u8');
    expect(text).toContain('rejected by u4');
    expect(text).not.toContain('rejected by u3');
  });
});

describe('block-kit budgets and escapes', () => {
  const longStrings = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${String(i)}`, 'x'.repeat(400)]));

  it('replaces a call whose code block would pass the section budget, and shows one that fits', () => {
    const over = JSON.stringify(render(full({ arguments: longStrings(10) })).out);
    expect(over).toContain('View the full call in Approvals');
    expect(over).not.toContain('k9');
    const fits = JSON.stringify(render(full({ arguments: longStrings(4) })).out);
    expect(fits).toContain('k3');
  });

  it('cannot have its code block ended by a backtick in the call', () => {
    const { out } = render(full({ arguments: { a: 'x```y`z' } }));
    const code = out.blocks.find(
      (b) => (b.text as { type?: string } | undefined)?.type === 'mrkdwn'
    );
    const text = (code?.text as { text: string }).text;
    expect(text.slice(4, -4)).not.toContain('`');
    expect(text.startsWith('```\n') && text.endsWith('\n```')).toBe(true);
  });

  it('turns the formatting characters of the notification text into look-alikes', () => {
    const { out } = render(full({ tool_ref: '*b* _i_ ~s~ `c` <!here> &' }));
    expect(out.text).toBe(
      'Approval request: \u2217b\u2217 \uff3fi\uff3f \u223cs\u223c \u02cbc\u02cb &lt;!here&gt; &amp;'
    );
  });
});
