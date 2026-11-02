import { describe, expect, it } from 'vitest';

import { OTHER_VIEWER, REQUESTER_VIEWER, full, options } from './fixtures.test-support.js';
import type { Approval } from './model.js';
import { toApprovalCard } from './model.js';

const priya = { id: 'u-priya', kind: 'user' as const, display_name: 'Priya' };
const other = { id: 'u-other', kind: 'user' as const, display_name: 'Other' };

const decided = (history: NonNullable<Approval['resolution_history']>): Partial<Approval> => ({
  state: 'approved',
  resolution: 'approved',
  approver: priya,
  resolved_at: '2026-10-30T10:00:00Z',
  resolution_history: history,
});

const entry = (
  resolution: string,
  by: typeof priya,
  reason?: string
): NonNullable<Approval['resolution_history']>[number] => ({
  resolution,
  by,
  at: '2026-10-30T10:00:00Z',
  ...(reason === undefined ? {} : { reason }),
});

const note = (over: Partial<Approval>, viewer = REQUESTER_VIEWER): string | undefined =>
  toApprovalCard(full(over), viewer, options()).status.requirements[0]?.note;

describe("the note of a final card is the deciding entry's reason", () => {
  const misleading = decided([entry('escalated', other, 'other note'), entry('approved', priya)]);

  it('is no note when the deciding entry has no reason, though an earlier entry by someone else has one', () => {
    expect(note(misleading)).toBeUndefined();
    const line = toApprovalCard(full(misleading), { principalId: 'u-priya' }, options()).status;
    expect(line.line).toBe('You approved');
    expect(line.requirements[0]?.note).toBeUndefined();
    const bystander = toApprovalCard(full(misleading), OTHER_VIEWER, options()).status;
    expect(JSON.stringify(bystander)).not.toContain('other note');
  });

  it('is the reason of the deciding entry when it has one', () => {
    const ok = decided([entry('escalated', other, 'other note'), entry('approved', priya, 'ok')]);
    expect(note(ok)).toBe('ok');
    expect(toApprovalCard(full(ok), { principalId: 'u-priya' }, options()).status.line).toBe(
      'You approved · ok'
    );
  });

  it('is the reason of the latest entry with the final resolution', () => {
    const twice = decided([entry('approved', other, 'first'), entry('approved', priya, 'second')]);
    expect(note(twice)).toBe('second');
  });

  it('shows no note on the viewer line when the viewer escalated with one and approved without', () => {
    const own = decided([entry('escalated', priya, 'checking'), entry('approved', priya)]);
    const status = toApprovalCard(full(own), { principalId: 'u-priya' }, options()).status;
    expect(status.line).toBe('You approved');
    expect(status.requirements[0]?.note).toBeUndefined();
  });

  it("shows no note on the viewer line when the deciding entry is not the viewer's", () => {
    const swapped = decided([entry('approved', other, 'theirs')]);
    const status = toApprovalCard(full(swapped), { principalId: 'u-priya' }, options()).status;
    expect(status.line).toBe('You approved');
    expect(status.requirements[0]?.note).toBe('theirs');
  });

  it('is no note when no entry has the final resolution', () => {
    expect(note(decided([entry('escalated', other, 'x')]))).toBeUndefined();
  });
});
