/**
 * The requirements of an approval (contract rev 16, `Approval.requirements`), read for display. Pure: no
 * timers, no network, no storage. A deployment that does not list the feature `approvals.requirements` never
 * sets the member, and a malformed one is treated as absent, so a reader of this module never sees a half-read
 * requirement.
 */
import type { components } from '@noblecloak/client';

import type { NamedPrincipalRef } from './approvals-types.js';

/** One approver entry of a requirement: a role by its bare key, or a user by principal id. */
export interface RequirementApprover {
  readonly kind: 'role' | 'user';
  readonly id: string;
}

/** An approval that counts toward a requirement. `basis` is as sent (`listed` or `break_glass`; another value is kept). */
export interface RequirementApproval {
  readonly by: Pick<NamedPrincipalRef, 'id' | 'display_name'>;
  readonly at: string;
  readonly basis: string;
}

export interface ApprovalRequirementView {
  readonly id: string;
  /** Empty: the organisation's administrators. */
  readonly approvers: readonly RequirementApprover[];
  readonly excludesRequester: boolean;
  readonly needed: number;
  readonly met: boolean;
  /** Oldest first, as the service sends them. */
  readonly approvals: readonly RequirementApproval[];
}

type Wire = components['schemas']['Approval'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function approverOf(value: unknown): RequirementApprover | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.role === 'string' && value.role !== '') return { kind: 'role', id: value.role };
  if (typeof value.user === 'string' && value.user !== '') return { kind: 'user', id: value.user };
  return undefined;
}

function approvalOf(value: unknown): RequirementApproval | undefined {
  if (!isRecord(value) || !isRecord(value.by) || typeof value.by.id !== 'string') return undefined;
  const name = value.by.display_name;
  return {
    by: {
      id: value.by.id,
      ...(typeof name === 'string' && name !== '' ? { display_name: name } : {}),
    },
    at: typeof value.at === 'string' ? value.at : '',
    basis: typeof value.basis === 'string' ? value.basis : '',
  };
}

function requirementOf(value: unknown): ApprovalRequirementView | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return undefined;
  if (typeof value.met !== 'boolean') return undefined;
  const list = <T>(member: unknown, read: (entry: unknown) => T | undefined): T[] =>
    Array.isArray(member)
      ? (member as unknown[]).flatMap((entry) => {
          const one = read(entry);
          return one === undefined ? [] : [one];
        })
      : [];
  return {
    id: value.id,
    approvers: list(value.approvers, approverOf),
    excludesRequester: Array.isArray(value.exclude) && value.exclude.includes('requester'),
    needed: typeof value.needed === 'number' && value.needed >= 1 ? value.needed : 1,
    met: value.met,
    approvals: list(value.approvals, approvalOf),
  };
}

/**
 * The requirements of an approval, or `undefined` when the read does not carry any that can be read (the member
 * is absent, not an array, empty, or holds no well-formed entry): the component then shows no requirements
 * block at all. An entry that is malformed, or repeats an id, is skipped.
 */
export function requirementsOf(
  approval: Pick<Wire, 'requirements'>
): readonly ApprovalRequirementView[] | undefined {
  const wire: unknown = approval.requirements;
  if (!Array.isArray(wire)) return undefined;
  const out: ApprovalRequirementView[] = [];
  for (const entry of wire as unknown[]) {
    const view = requirementOf(entry);
    if (view !== undefined && !out.some((seen) => seen.id === view.id)) out.push(view);
  }
  return out.length === 0 ? undefined : out;
}
