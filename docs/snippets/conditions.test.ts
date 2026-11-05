/**
 * The conditions guide's snippet, run for real against the mock: three decisions over a tool's facts and a
 * policy's rules, and the values the guide prints are asserted.
 */
import { argDigest } from '@noblecloak/client';
import { startMock } from '@noblecloak/spec';
import type { RunningMock } from '@noblecloak/spec';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let mock: RunningMock;

beforeAll(async () => {
  mock = await startMock({ control: true });
  process.env.NC_BASE_URL = mock.baseUrl;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await mock.stop();
});

describe('conditions and approvers, against the mock', () => {
  it('decides three calls by the first rule that matches', async () => {
    const run = await import('./conditions.js');
    expect(run.tooLarge.decision).toBe('deny');
    expect(run.small.decision).toBe('allow');
    expect(run.middling.decision).toBe('step_up');
    expect(run.middling.missing_facts).toBeUndefined();
  });

  it('routes the step-up to the matching rule own approvers, excluding the requester', async () => {
    const run = await import('./conditions.js');
    expect(run.requirements).toHaveLength(1);
    expect(run.requirements[0]?.approvers).toEqual([{ role: 'team_lead' }]);
    expect(run.requirements[0]?.exclude).toEqual(['requester']);
  });

  it('routes a call that matches no rule to the policy approvers', async () => {
    const { creator } = await import('./connect.js');
    const { toolRef } = await import('./conditions.js');
    const { data } = await creator.POST('/v1/decisions', {
      body: { action: { tool_ref: toolRef, arguments: { amount: 2000 } } },
    });
    expect(data?.data.decision).toBe('step_up');
    const approval = await creator.GET('/v1/approvals/{id}', {
      params: { path: { id: data?.data.approval?.id ?? '' } },
    });
    expect(approval.data?.data.requirements?.[0]?.approvers).toEqual([{ role: 'finance' }]);
  });

  it('asks, naming the fact, when the call carries only a digest', async () => {
    const { creator } = await import('./connect.js');
    const { toolRef } = await import('./conditions.js');
    const { data } = await creator.POST('/v1/decisions', {
      body: { action: { tool_ref: toolRef, arg_digest: await argDigest({ amount: 40 }) } },
    });
    expect(data?.data.decision).toBe('step_up');
    expect(data?.data.missing_facts).toEqual(['amount']);
    const approval = await creator.GET('/v1/approvals/{id}', {
      params: { path: { id: data?.data.approval?.id ?? '' } },
    });
    expect(approval.data?.data.requirements?.[0]?.approvers).toEqual([]);
    expect(approval.data?.data.requirements?.[0]?.exclude).toEqual(['requester']);
  });
});
