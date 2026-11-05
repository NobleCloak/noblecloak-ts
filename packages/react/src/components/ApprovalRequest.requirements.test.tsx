// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { requirementsOf } from '../approvals-requirements.js';
import type { ApprovalSummary } from '../approvals-types.js';
import { approvalSummary, detailStates } from '../testing/fake-controller.js';
import { ApprovalRequest } from './ApprovalRequest.js';

afterEach(cleanup);

type Wire = NonNullable<ApprovalSummary['requirements']>[number];

function wire(over: Partial<Wire> = {}): Wire {
  return {
    id: 'req-1',
    policies: [{ id: 'pol-1', version: 1 }],
    approvers: [{ role: 'finance' }],
    exclude: [],
    needed: 1,
    met: false,
    approvals: [],
    ...over,
  };
}

const met = wire({
  approvals: [
    {
      by: { id: 'u-lee', kind: 'user', display_name: 'A. Lee' },
      at: '2026-10-05T12:30:00Z',
      basis: 'listed',
    },
  ],
  met: true,
});
const open = wire({
  id: 'req-2',
  approvers: [{ role: 'legal' }, { user: 'u-sam' }],
  exclude: ['requester'],
});

function show(requirements: unknown): void {
  const approval = approvalSummary({ requirements } as Partial<ApprovalSummary>);
  render(
    <ApprovalRequest
      request={{ ...detailStates('apr_1', { approval }).loaded, retry: () => undefined }}
    />
  );
}

describe('the requirements block of an approval request', () => {
  it.each(['rejected', 'expired', 'withdrawn'])(
    'reads an unmet requirement as not met, not pending, on a %s approval',
    (state) => {
      const approval = approvalSummary({
        state,
        requirements: [met, open],
      } as unknown as Partial<ApprovalSummary>);
      render(
        <ApprovalRequest
          request={{ ...detailStates('apr_1', { approval }).loaded, retry: () => undefined }}
        />
      );
      const items = screen.getAllByRole('listitem');
      expect(items[0]?.textContent).toContain('Met');
      expect(items[1]?.textContent).toContain('Not met');
      expect(items[1]?.textContent).not.toContain('Pending');
    }
  );

  it('shows how many are met, who may satisfy each and who did', () => {
    show([met, open]);
    const block = screen.getByRole('heading', { name: 'Requirements' }).closest('section');
    if (block === null) throw new Error('no requirements block');
    const text = within(block);
    expect(text.getByText('1 of 2 met')).toBeDefined();
    const items = text.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Met');
    expect(items[0]?.textContent).toContain('Who may satisfy it: role finance');
    expect(items[0]?.textContent).toContain('Met by A. Lee (u-lee)');
    expect(items[1]?.textContent).toContain('Pending');
    expect(items[1]?.textContent).toContain('Who may satisfy it: role legal, user u-sam');
    expect(items[1]?.textContent).toContain("The requester can't satisfy it.");
  });

  it('names the administrators when a requirement has no approver entries, and marks a break-glass approval', () => {
    show([
      wire({
        approvers: [],
        met: true,
        approvals: [
          { by: { id: 'u-root', kind: 'user' }, at: '2026-10-05T12:30:00Z', basis: 'break_glass' },
        ],
      }),
    ]);
    const text = document.body.textContent;
    expect(text).toContain('Who may satisfy it: Administrators of the organisation');
    expect(text).toContain('Met by u-root (administrator override)');
    expect(text).toContain('1 of 1 met');
  });

  it.each([undefined, [], 'nope', [null, 4, { id: 'x' }], {}])(
    'shows no requirements block when the member is %j',
    (requirements) => {
      show(requirements);
      expect(screen.queryByRole('heading', { name: 'Requirements' })).toBeNull();
      expect(document.body.textContent).not.toContain('Who may satisfy it');
    }
  );

  it('shows the text of a requirement as inert text', () => {
    show([wire({ approvers: [{ role: 'a‮b' }] })]);
    expect(document.body.textContent).not.toContain('‮');
  });
});

describe('requirementsOf', () => {
  it('reads one view per well-formed entry and skips a repeated id', () => {
    const views = requirementsOf({ requirements: [met, met, open] });
    expect(views?.map((view) => view.id)).toEqual(['req-1', 'req-2']);
    expect(views?.[1]).toMatchObject({ excludesRequester: true, needed: 1, met: false });
  });

  it('treats a missing or non-positive needed as 1 and drops unreadable approvers and approvals', () => {
    const odd = {
      id: 'r',
      met: false,
      needed: 0,
      approvers: [{ role: '' }, 3, { user: 'u' }],
      approvals: [{ at: 'x' }, { by: { id: 'u' }, at: 7, basis: 9 }],
    };
    const [view] = requirementsOf({ requirements: [odd] as unknown as Wire[] }) ?? [];
    expect(view).toMatchObject({ needed: 1, approvers: [{ kind: 'user', id: 'u' }] });
    expect(view?.approvals).toEqual([{ by: { id: 'u' }, at: '', basis: '' }]);
  });

  it('is undefined for an entry whose met is not a boolean', () => {
    expect(
      requirementsOf({ requirements: [{ id: 'r', met: 'yes' }] as unknown as Wire[] })
    ).toBeUndefined();
  });
});
