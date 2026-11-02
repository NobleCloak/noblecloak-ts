import { describe, expect, it } from 'vitest';

import type { ApprovalDetailStatus } from '../approvals-types.js';
import {
  DETAIL_STATUSES,
  approvalSummary,
  detailStates,
  fakeController,
} from './fake-controller.js';

describe('approvalSummary', () => {
  it('builds a pending approval with no arguments member', () => {
    const row = approvalSummary();
    expect(row.state).toBe('pending');
    expect('arguments' in row).toBe(false);
  });

  it('applies overrides', () => {
    expect(approvalSummary({ id: 'apr_9', tool_ref: 'ext:billing:issue_refund' })).toMatchObject({
      id: 'apr_9',
      tool_ref: 'ext:billing:issue_refund',
    });
  });
});

describe('detailStates', () => {
  it('has a builder for every ApprovalDetailState status', () => {
    const built = detailStates('apr_1');
    const statuses = Object.keys(built).sort();
    expect(statuses).toEqual([...DETAIL_STATUSES].sort());
    for (const status of DETAIL_STATUSES) {
      const state = built[status];
      expect(state.status).toBe(status);
      expect(state.id).toBe('apr_1');
    }
  });

  it('keeps the arguments only where a detail can hold them', () => {
    const built = detailStates('apr_1', { arguments: { amount: 12 } });
    for (const status of ['loaded', 'refreshing', 'resolved'] as const) {
      expect(built[status]).toMatchObject({ arguments: { amount: 12 } });
    }
    for (const status of [
      'loading',
      'not_found',
      'unavailable',
      'forbidden',
      'unauthorized',
      'error',
    ] as const) {
      expect('arguments' in built[status]).toBe(false);
    }
  });

  it('omits arguments from the digest-only states when none are given', () => {
    expect('arguments' in detailStates('apr_1').loaded).toBe(false);
  });

  it('gives a network error no status, as it has no response, and an API problem its status', () => {
    const built = detailStates('apr_1');
    expect('status' in built.error.error).toBe(false);
    expect(built.forbidden.error.status).toBe(403);
  });

  it('carries an error of the matching kind on the failure states', () => {
    const built = detailStates('apr_1');
    expect(built.unavailable.error.kind).toBe('unavailable');
    expect(built.forbidden.error.kind).toBe('forbidden');
    expect(built.unauthorized.error.kind).toBe('unauthorized');
    expect(built.error.error.kind).toBe('network');
  });
});

describe('fakeController', () => {
  it('starts ready and empty, with no detail', () => {
    const controller = fakeController();
    expect(controller.status).toBe('ready');
    expect(controller.approvals).toEqual([]);
    expect(controller.connection).toBe('live');
    expect(controller.truncated).toBe(false);
    expect(controller.resolving.size).toBe(0);
    expect('detail' in controller).toBe(false);
  });

  it('takes any snapshot member as an override', () => {
    const detail = detailStates('apr_1').loaded;
    const controller = fakeController({ status: 'loading', detail });
    expect(controller.status).toBe('loading');
    expect(controller.detail).toBe(detail);
  });

  it('records every action and answers a resolve with the open detail resolved', async () => {
    const row = approvalSummary({ id: 'apr_1' });
    const controller = fakeController({
      approvals: [row],
      detail: detailStates('apr_1').loaded,
    });
    await controller.refresh();
    controller.openDetail('apr_1');
    controller.retryDetail();
    controller.closeDetail();
    const approved = await controller.approve('apr_1', { reason: 'ok' });
    const denied = await controller.deny('apr_1');
    expect(controller.calls).toEqual([
      { method: 'refresh', args: [] },
      { method: 'openDetail', args: ['apr_1'] },
      { method: 'retryDetail', args: [] },
      { method: 'closeDetail', args: [] },
      { method: 'approve', args: ['apr_1', { reason: 'ok' }] },
      { method: 'deny', args: ['apr_1'] },
    ]);
    expect(approved).toEqual({
      ok: true,
      approval: { ...row, state: 'approved', resolution: 'approved' },
    });
    expect(denied).toEqual({
      ok: true,
      approval: { ...row, state: 'rejected', resolution: 'rejected' },
    });
  });

  it('refuses a resolve from a queue row alone, with no detail open', async () => {
    const controller = fakeController({ approvals: [approvalSummary()] });
    for (const result of [await controller.approve('apr_1'), await controller.deny('apr_1')]) {
      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'precondition', code: 'detail_not_read', local: true },
      });
    }
  });

  it('refuses a resolve for a different id than the open detail', async () => {
    const controller = fakeController({ detail: detailStates('apr_2').loaded });
    expect(await controller.approve('apr_1')).toMatchObject({
      ok: false,
      error: { kind: 'precondition' },
    });
  });

  it.each(DETAIL_STATUSES.filter((status) => status !== 'loaded'))(
    'refuses a resolve while the open detail is %s',
    async (status) => {
      const controller = fakeController({
        approvals: [approvalSummary()],
        detail: detailStates('apr_1')[status],
      });
      expect(await controller.approve('apr_1')).toMatchObject({
        ok: false,
        error: { kind: 'precondition', code: 'detail_not_read' },
      });
    }
  );

  it('refuses a resolve while the detail is refreshing, though it holds a pending approval', async () => {
    const detail = detailStates('apr_1').refreshing;
    expect(detail.approval.state).toBe('pending');
    const controller = fakeController({ approvals: [approvalSummary()], detail });
    for (const result of [await controller.approve('apr_1'), await controller.deny('apr_1')]) {
      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'precondition', code: 'detail_not_read', local: true },
      });
    }
  });

  it('refuses a resolve when the loaded detail is no longer pending', async () => {
    const detail = detailStates('apr_1', { approval: { state: 'expired' } }).loaded;
    expect(await fakeController({ detail }).deny('apr_1')).toMatchObject({
      ok: false,
      error: { kind: 'precondition' },
    });
  });

  it('answers with the detail approval, not the queue row', async () => {
    const detail = detailStates('apr_1', { approval: { tool_ref: 'ext:billing:detail' } }).loaded;
    const controller = fakeController({ approvals: [approvalSummary()], detail });
    const result = await controller.approve('apr_1');
    expect(result.ok && result.approval.tool_ref).toBe('ext:billing:detail');
  });

  it('lets a test replace an action', async () => {
    const controller = fakeController({
      approve: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'precondition', code: 'detail_not_read', local: true, title: 'x' },
        }),
    });
    const result = await controller.approve('apr_1');
    expect(result.ok).toBe(false);
    expect(controller.calls).toEqual([]);
  });

  it('types every status key', () => {
    const status: ApprovalDetailStatus = 'loaded';
    expect(DETAIL_STATUSES).toContain(status);
  });
});
