import { describe, expect, it } from 'vitest';

import { toAdaptiveCard } from './adaptive-card.js';
import { toBlockKit } from './block-kit.js';
import { MESSAGE_ID, OTHER_VIEWER, full, options, priyaResolved } from './fixtures.test-support.js';
import type { Approval } from './model.js';
import { toApprovalCard } from './model.js';
import { requirementsLine } from './view.js';

type WireRequirement = NonNullable<Approval['requirements']>[number];

const LEE = { id: 'u-lee', kind: 'user', display_name: 'A. Lee' } as const;

function requirement(over: Partial<WireRequirement> = {}): WireRequirement {
  return {
    id: 'req-1',
    policies: [{ id: 'pol-1', version: 3 }],
    approvers: [{ role: 'finance' }],
    exclude: [],
    needed: 1,
    met: false,
    approvals: [],
    ...over,
  };
}

const met = requirement({
  approvals: [{ by: LEE, at: '2026-10-30T09:30:00Z', basis: 'listed' }],
  met: true,
});
const open = requirement({ id: 'req-2', approvers: [{ role: 'legal' }, { user: 'u-sam' }] });
const twoOfWhichOneMet = (): Approval => full({ requirements: [met, open] });

const card = (approval: Approval) => toApprovalCard(approval, OTHER_VIEWER, options());

describe('requirements on the card model', () => {
  it('emits one requirement per requirement of the read, with its approvers and approvals', () => {
    const { requirements } = card(twoOfWhichOneMet()).status;
    expect(requirements).toEqual([
      {
        id: 'req-1',
        state: 'approved',
        decidedBy: { id: 'u-lee', kind: 'user', displayName: 'A. Lee', text: 'A. Lee (u-lee)' },
        decidedAt: '2026-10-30T09:30:00Z',
        approvers: ['finance'],
        needed: 1,
        approvals: [
          {
            by: { id: 'u-lee', kind: 'user', displayName: 'A. Lee', text: 'A. Lee (u-lee)' },
            at: '2026-10-30T09:30:00Z',
            basis: 'listed',
          },
        ],
      },
      { id: 'req-2', state: 'pending', approvers: ['legal', 'u-sam'], needed: 1, approvals: [] },
    ]);
  });

  it('maps an unmet requirement to the state of the approval', () => {
    const rejected = card(full({ ...priyaResolved('rejected', 'rejected'), requirements: [open] }));
    expect(rejected.status.requirements[0]?.state).toBe('rejected');
  });

  it('keeps the synthetic entry when the member is absent, empty or holds nothing readable', () => {
    for (const requirements of [
      undefined,
      [],
      [{ approvers: [] }],
      'nope',
      [null, 3],
    ] as unknown as Approval['requirements'][]) {
      const out = card(full({ requirements } as Partial<Approval>));
      expect(out.status.requirements).toEqual([{ id: 'approval', state: 'pending' }]);
    }
  });

  it('skips an unreadable entry and a repeated id, and reads a malformed member as absent', () => {
    const odd = {
      id: 'req-9',
      approvers: [null, { role: 'finance' }, { nope: 1 }],
      approvals: [{ at: 'x' }, { by: LEE, at: 't', basis: 'break_glass' }],
      needed: 'many',
      met: 'yes',
    } as unknown as WireRequirement;
    const { requirements } = card(full({ requirements: [null as never, odd, odd] })).status;
    expect(requirements).toHaveLength(1);
    expect(requirements[0]).toMatchObject({
      id: 'req-9',
      state: 'pending',
      approvers: ['finance'],
    });
    expect(requirements[0]?.needed).toBeUndefined();
    expect(requirements[0]?.approvals).toHaveLength(1);
  });

  it('keeps the card unchanged otherwise: the status line, actions and history do not depend on it', () => {
    const without = card(full());
    const withRequirements = card(twoOfWhichOneMet());
    expect(withRequirements.status.line).toBe(without.status.line);
    expect(withRequirements.actions).toEqual(without.actions);
    expect(withRequirements.version).toBe(3);
  });
});

describe('requirementsLine', () => {
  it('is absent for the synthetic requirement', () => {
    expect(requirementsLine(card(full()))).toBeUndefined();
  });

  it('counts the met requirements and names who satisfied each', () => {
    expect(requirementsLine(card(twoOfWhichOneMet()))).toBe(
      '1 of 2 met — finance: met by A. Lee (u-lee); legal, u-sam: pending'
    );
  });

  it('names the administrators for a requirement with no approver entries', () => {
    const line = requirementsLine(card(full({ requirements: [requirement({ approvers: [] })] })));
    expect(line).toBe('0 of 1 met — Administrators: pending');
  });

  it('says not met, not pending, once the approval is closed', () => {
    const closed = card(full({ ...priyaResolved('rejected', 'rejected'), requirements: [open] }));
    expect(requirementsLine(closed)).toBe('0 of 1 met — legal, u-sam: not met');
  });

  it('names a met requirement with no named approver by its label alone', () => {
    const anonymous = requirement({ met: true });
    expect(requirementsLine(card(full({ requirements: [anonymous] })))).toBe(
      '1 of 1 met — finance'
    );
  });
});

describe('requirements in the renderers', () => {
  const approval = twoOfWhichOneMet();
  const line = '1 of 2 met — finance: met by A. Lee (u-lee); legal, u-sam: pending';

  it('Adaptive Card shows the line before the status line, once', async () => {
    const out = toAdaptiveCard(card(approval), { sentMessageId: MESSAGE_ID });
    const texts = out.body.map((element) => element.text);
    // Teams text is Markdown, so the parentheses are escaped.
    const escaped = line.replaceAll('(', '\\(').replaceAll(')', '\\)');
    expect(texts.filter((text) => text === escaped)).toHaveLength(1);
    expect(texts.indexOf(escaped)).toBe(texts.indexOf('Waiting for a decision') - 1);
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
      './golden/adaptive-card-requirements.json'
    );
  });

  it('Block Kit shows the line in the status context, before the status line', async () => {
    const out = toBlockKit(card(approval), { sentMessageId: MESSAGE_ID });
    const context = out.blocks.filter((block) => block.type === 'context').at(-1);
    const texts = (context?.elements as { text: string }[]).map((element) => element.text);
    expect(texts).toEqual([line, 'Waiting for a decision']);
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
      './golden/block-kit-requirements.json'
    );
  });

  it('both renderers leave a read without requirements byte-identical to a read with only the synthetic one', () => {
    const plain = full();
    const synthetic = full({ requirements: [] });
    expect(toAdaptiveCard(card(synthetic), { sentMessageId: MESSAGE_ID })).toEqual(
      toAdaptiveCard(card(plain), { sentMessageId: MESSAGE_ID })
    );
    expect(toBlockKit(card(synthetic), { sentMessageId: MESSAGE_ID })).toEqual(
      toBlockKit(card(plain), { sentMessageId: MESSAGE_ID })
    );
  });

  it('escapes what a requirement carries like any other text', () => {
    const hostile = requirement({ approvers: [{ role: '<@U123>|*bold*' }] });
    const out = toBlockKit(card(full({ requirements: [hostile] })), { sentMessageId: MESSAGE_ID });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('<@U123>');
  });
});
