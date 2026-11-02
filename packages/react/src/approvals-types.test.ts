import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  Approval,
  ApprovalDetailState,
  ApprovalSummary,
  ApprovalsController,
  ApprovalsError,
  ApprovalsSnapshot,
  ApprovalsStore,
  ConflictCode,
  ResolveResult,
} from './approvals-types.js';

// These are compile-time checks: `bun run typecheck` fails when a `@ts-expect-error` below stops
// erroring (the type was loosened) or when an `expectTypeOf` assertion stops holding.
describe('ApprovalSummary', () => {
  it('rejects an Approval, which may still carry arguments', () => {
    const wide = {} as Approval;
    // @ts-expect-error an un-stripped Approval must not be assignable to a summary
    const summary: ApprovalSummary = wide;
    expect(summary).toBeDefined();
  });

  it('rejects a literal that sets arguments', () => {
    const base = {} as ApprovalSummary;
    // @ts-expect-error arguments is `never` on a summary
    const withArguments: ApprovalSummary = { ...base, arguments: {} };
    expect(withArguments).toBeDefined();
  });

  it('accepts a summary where the arguments are absent', () => {
    expectTypeOf<ApprovalSummary['arguments']>().toEqualTypeOf<undefined>();
  });

  it('is what a resolve result and a conflict hold', () => {
    type Ok = Extract<ResolveResult, { ok: true }>;
    expectTypeOf<Ok['approval']>().toEqualTypeOf<ApprovalSummary>();
    type Conflict = Extract<ApprovalsError, { kind: 'conflict' }>;
    expectTypeOf<NonNullable<Conflict['current']>>().toEqualTypeOf<ApprovalSummary>();
  });
});

describe('ApprovalsError conflict code', () => {
  type Conflict = Extract<ApprovalsError, { kind: 'conflict' }>;

  it('accepts the known codes and an unknown 409 code', () => {
    const known: ConflictCode = 'already_resolved';
    const fromKnown: Conflict = { kind: 'conflict', code: known, title: 'Conflict' };
    const fromUnknown: Conflict = { kind: 'conflict', code: 'a_new_code', title: 'Conflict' };
    expect(fromKnown.code).toBe('already_resolved');
    expect(fromUnknown.code).toBe('a_new_code');
  });

  it('keeps the known codes distinguishable in the type', () => {
    expectTypeOf<'already_resolved'>().toExtend<Conflict['code']>();
    expectTypeOf<ConflictCode>().toEqualTypeOf<
      'approval_conflict' | 'already_resolved' | 'obligation_expired' | 'resolve_in_flight'
    >();
  });

  it('is not a bare string for the other error kinds', () => {
    // @ts-expect-error a precondition error has the single code detail_not_read
    const wrong: ApprovalsError = { kind: 'precondition', code: 'other', title: 't', local: true };
    expect(wrong).toBeDefined();
  });
});

describe('snapshot and store shapes', () => {
  it('holds summaries in the queue', () => {
    expectTypeOf<ApprovalsSnapshot['approvals'][number]>().toEqualTypeOf<ApprovalSummary>();
  });

  it('yields the snapshot from the controller and the store', () => {
    expectTypeOf<ApprovalsController['approvals']>().toEqualTypeOf<
      ApprovalsSnapshot['approvals']
    >();
    expectTypeOf<ReturnType<ApprovalsStore['getSnapshot']>>().toEqualTypeOf<ApprovalsSnapshot>();
    expectTypeOf<
      ReturnType<ApprovalsStore['getServerSnapshot']>
    >().toEqualTypeOf<ApprovalsSnapshot>();
  });

  it('offers only approved and rejected to resolve', () => {
    type Resolution = Parameters<ApprovalsStore['resolve']>[1]['resolution'];
    expectTypeOf<Resolution>().toEqualTypeOf<'approved' | 'rejected'>();
  });
});

describe('ApprovalDetailState', () => {
  type Member<S extends ApprovalDetailState['status']> = Extract<
    ApprovalDetailState,
    { status: S }
  >;

  it('has no arguments key where the approval is not held', () => {
    expectTypeOf<Member<'not_found'>>().not.toHaveProperty('arguments');
    expectTypeOf<Member<'loading'>>().not.toHaveProperty('arguments');
    expectTypeOf<Member<'unavailable'>>().not.toHaveProperty('arguments');
  });

  it('narrows the error of the states that imply a kind', () => {
    expectTypeOf<Member<'unavailable'>['error']['kind']>().toEqualTypeOf<'unavailable'>();
    expectTypeOf<Member<'forbidden'>['error']['kind']>().toEqualTypeOf<'forbidden'>();
    expectTypeOf<Member<'unauthorized'>['error']['kind']>().toEqualTypeOf<'unauthorized'>();
  });
});
