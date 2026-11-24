// @vitest-environment jsdom
/**
 * Issues 33 and 34: a row and a detail say in words what is asked and by whom (the verified requester, the tool and
 * where it comes from), the digest and the ids are in the detail, the decision is one labelled group that says why it
 * is off, and a proposal's raw call is collapsible but open.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PROPOSE_POLICY_SET_TOOL } from '../approvals-proposal.js';
import type { ApprovalDetailState, JsonObject } from '../approvals-types.js';
import { axe } from '../testing/axe.js';
import { toolWithSource } from '../testing/isolates.js';
import { queueRows, renderController } from '../testing/component-harness.js';
import { approvalSummary, detailStates, fakeController } from '../testing/fake-controller.js';
import { Approvals } from './Approvals.js';

afterEach(cleanup);

const I = String.fromCodePoint(0x2068);
const J = String.fromCodePoint(0x2069);
const PLANES = { id: 'sp_7d1e', kind: 'service' as const, display_name: 'Planes CRM' };

const policy = (config: unknown): unknown => ({
  role: 'baseline',
  rationale: 'Because.',
  assessment: { side_effect_level: 'write', blast_radius: 'one_record' },
  policy: {
    kind: 'tool_invocation',
    subjects: [{ type: 'role', id: 'everyone' }],
    targets: { tools: ['mcp:crm/main/send_email'] },
    config,
  },
});
const PROPOSAL = {
  agent: { id: 'agent_1', principal_id: 'sp_1' },
  tools: [],
  policies: [policy({ mode: 'ask' })],
} as unknown as JsonObject;
const PREVIEW = { simulations: [], loosening: [] };

function proposalDetail(args: JsonObject = PROPOSAL): ApprovalDetailState {
  return detailStates('apr_1', {
    arguments: args,
    approval: {
      tool_ref: PROPOSE_POLICY_SET_TOOL,
      side_effect_level: 'admin',
      requester: PLANES,
      preview: PREVIEW,
    },
  }).loaded;
}

describe('a row says what is asked and by whom', () => {
  it('names the verified requester, the tool and its source, keeps the reference, and shows no id or digest', () => {
    renderController(
      fakeController({
        approvals: [
          approvalSummary({ tool_ref: PROPOSE_POLICY_SET_TOOL, requester: PLANES }),
          approvalSummary({
            id: 'apr_2',
            tool_ref: 'ext:billing:issue_refund',
            requester: { id: 'user_ann', kind: 'user', display_name: 'Ann' },
            agent: { id: 'agent_9', name: 'Refund bot' },
          }),
        ],
      })
    );
    const [setup, refund] = within(screen.getByRole('list')).getAllByRole('button');
    expect(setup?.textContent).toContain(`Policy setup from ${I}Planes CRM${J}`);
    expect(refund?.textContent).toContain(
      `${I}Ann${J} wants to use ${I}issue_refund${J} (${I}ext:billing${J})`
    );
    // The agent is the caller's hint: secondary, and never the asker.
    expect(refund?.textContent).toContain(`via ${I}Refund bot${J}`);
    expect(refund?.textContent).not.toContain(`${I}Refund bot${J} wants`);
    expect(refund?.textContent).toContain('ext:billing:issue_refund');
    for (const row of [setup, refund]) {
      expect(row?.textContent).toContain('Review and decide');
      expect(row?.textContent).not.toMatch(/sp_7d1e|user_ann|agent_9|Digest|a3f1c0de/);
    }
  });

  it('keeps tools that read alike apart in what can be approved from the list', () => {
    const refs = [
      'ext:billing:issue_refund',
      'ext:billing:issue-refund',
      'tool:sandbox:issue_refund',
    ];
    renderController(
      fakeController({
        approvals: refs.map((tool_ref, index) =>
          approvalSummary({
            id: `apr_${String(index)}`,
            tool_ref,
            requester: { id: 'user_ann', kind: 'user', display_name: 'Ann' },
          })
        ),
      })
    );
    const rows = within(screen.getByRole('list')).getAllByRole('button');
    const names = rows.map((row) => row.textContent);
    expect(new Set(names).size).toBe(refs.length);
    refs.forEach((ref, index) => {
      expect(names[index]).toContain(ref);
    });
  });

  it('names the sentence, not the raw reference, on the checkbox of a row', () => {
    renderController(
      fakeController({
        approvals: queueRows(1, { arguments_state: 'not_enabled' }),
        approveMany: () => Promise.resolve({ ok: true, results: [] }),
      })
    );
    expect(
      screen.getByRole('checkbox', {
        name: `Select: A request to use ${toolWithSource('tool_1', 'ext:billing')}`,
      })
    ).toBeDefined();
  });

  it('puts the note on why a request is not in the batch inside its row, not in a column beside it', () => {
    renderController(
      fakeController({
        approvals: queueRows(1, { arguments_state: 'shown' }),
        approveMany: () => Promise.resolve({ ok: true, results: [] }),
      })
    );
    const row = within(screen.getByRole('list')).getByRole('button');
    expect(row.textContent).toContain('Open this request to read its call before approving.');
    expect(document.querySelector('.nc-no-choose')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = renderController(fakeController({ approvals: queueRows(2) }));
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('the detail', () => {
  it('is headed by the same sentence as the row, and keeps the ids and the tool in its facts', () => {
    renderController(
      fakeController({
        approvals: [approvalSummary({ tool_ref: PROPOSE_POLICY_SET_TOOL, requester: PLANES })],
        detail: proposalDetail(),
      })
    );
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(
      `Policy setup from ${I}Planes CRM${J}`
    );
    const facts = document.querySelector('.nc-facts')?.textContent ?? '';
    expect(facts).toContain(PROPOSE_POLICY_SET_TOOL);
    expect(facts).toContain('Planes CRM (sp_7d1e)');
  });

  it('shows the summary of a proposal first, with the raw call under it, open', () => {
    renderController(fakeController({ approvals: queueRows(1), detail: proposalDetail() }));
    const summary = screen.getByRole('region', { name: 'What approving this does' });
    const fold = document.querySelector<HTMLDetailsElement>('details.nc-call-fold');
    expect(fold).not.toBeNull();
    expect(fold?.open).toBe(true);
    expect(fold?.querySelector('pre')?.textContent).toContain('"agent"');
    expect(
      summary.compareDocumentPosition(fold as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // It can be closed, and opened again, by the approver.
    fireEvent.click(within(fold as HTMLElement).getByText('Show the full call'));
    expect(fold?.open).toBe(false);
  });

  it('shows what the summary does not read: a policy with rules and approvers is in the open call', () => {
    const args = {
      ...PROPOSAL,
      policies: [
        policy({
          mode: 'ask',
          rules: [{ when: 'amount > 1000000', then: 'always_allow' }],
          approvers: [{ type: 'user', id: 'user_unknown_approver' }],
          exclude: ['requester'],
        }),
      ],
    } as unknown as JsonObject;
    renderController(fakeController({ approvals: queueRows(1), detail: proposalDetail(args) }));
    // The summary lists the mode and nothing of the rest: a reader of the summary alone would not know of it.
    const summary = screen.getByRole('region', { name: 'What approving this does' });
    expect(summary.textContent).not.toContain('user_unknown_approver');
    expect(summary.textContent).not.toContain('1000000');
    const fold = document.querySelector<HTMLDetailsElement>('details.nc-call-fold');
    expect(fold?.open).toBe(true);
    expect(fold?.querySelector('pre')?.textContent).toContain('user_unknown_approver');
    expect(fold?.querySelector('pre')?.textContent).toContain('amount > 1000000');
  });

  it('keeps the call, open and where it was, with focus on it, after "Show all"', () => {
    const cut = { ...PROPOSAL, note: 'x'.repeat(5000) } as unknown as JsonObject;
    renderController(fakeController({ approvals: queueRows(1), detail: proposalDetail(cut) }));
    const fold = document.querySelector<HTMLDetailsElement>('details.nc-call-fold');
    const before = fold?.querySelector('pre');
    expect(fold?.open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    // The same wrapper and the same element: nothing was re-parented, so nothing was remounted.
    expect(document.querySelector('details.nc-call-fold')).toBe(fold);
    expect(fold?.querySelector('pre')).toBe(before);
    expect(fold?.open).toBe(true);
    expect(fold?.querySelector('pre')?.textContent).toContain('xxxxxxxxxx');
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'The full call, as returned for this request' })
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(false);
  });

  it('says why the buttons are off beside them: a call not shown in full', () => {
    const cut = { ...PROPOSAL, note: 'x'.repeat(5000) } as unknown as JsonObject;
    renderController(fakeController({ approvals: queueRows(1), detail: proposalDetail(cut) }));
    expect(
      within(screen.getByRole('group', { name: 'Your decision' })).getByText(
        'The call above is not shown in full, so it cannot be approved or denied here.'
      )
    ).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(true);
  });

  it('says why the buttons are off beside them: the request changed', () => {
    const states = detailStates('apr_1', {});
    const view = render(
      <Approvals controller={fakeController({ approvals: queueRows(1), detail: states.loaded })} />
    );
    const changed = detailStates('apr_1', { approval: { action_digest: 'b7e2'.repeat(16) } });
    view.rerender(
      <Approvals controller={fakeController({ approvals: queueRows(1), detail: changed.loaded })} />
    );
    expect(
      within(screen.getByRole('group', { name: 'Your decision' })).getByText(
        'This request changed. Confirm above that you have read the change to approve or deny it.'
      )
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'I have read the changed request' }));
    expect(screen.queryByText(/This request changed\. Confirm above/)).toBeNull();
  });

  it('does not wrap the call of an approval that is not a proposal', () => {
    renderController(
      fakeController({
        approvals: queueRows(1),
        detail: detailStates('apr_1', { arguments: { amount: 1 } }).loaded,
      })
    );
    expect(document.querySelector('details.nc-call-fold')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'The full call, as returned for this request' })
    ).toBeDefined();
  });

  it('keeps the reason box, Approve and Deny together in one labelled group, after the call', () => {
    renderController(fakeController({ approvals: queueRows(1), detail: proposalDetail() }));
    const group = screen.getByRole('group', { name: 'Your decision' });
    expect(group.classList.contains('nc-actions')).toBe(true);
    expect(within(group).getByRole('textbox', { name: 'Reason (optional)' })).toBeDefined();
    expect(within(group).getByRole('button', { name: 'Approve' })).toBeDefined();
    expect(within(group).getByRole('button', { name: 'Deny' })).toBeDefined();
    expect(within(group).queryByText(/not shown in full/)).toBeNull();
    const call = document.querySelector('.nc-call-fold') as Node;
    expect(call.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has no axe violations with the call open, and with the confirm dialog open', async () => {
    const { container } = renderController(
      fakeController({ approvals: queueRows(1), detail: proposalDetail() })
    );
    expect((await axe(container)).violations).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('dialog', { name: 'Approve this request?' })).toBeDefined();
    expect((await axe(container)).violations).toEqual([]);
  });
});
