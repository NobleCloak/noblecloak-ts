/**
 * The guide's commands, run for real against the mock: each snippet is imported in the order the guide shows
 * them, and the values the guide prints are asserted.
 */
import { readFileSync } from 'node:fs';

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

describe('your first governed tool, against the mock', () => {
  it('step 3: a read is allowed', async () => {
    const { verdict, digest } = await import('./allow.js');
    expect(verdict).toBe('allow');
    // The JSON sample in the guide carries the digest of the arguments allow.ts sends.
    const guide = readFileSync(
      new URL('../how-to/first-governed-tool.md', import.meta.url),
      'utf8'
    );
    expect(guide).toContain(`"action_digest": "${digest}"`);
  });

  it('step 4: send_email needs approval; the agent cannot approve it, a person can', async () => {
    const stepUp = await import('./step-up.js');
    expect(stepUp.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    // The JSON samples in the guide carry the digest and action id these arguments produce.
    const guide = readFileSync(
      new URL('../how-to/first-governed-tool.md', import.meta.url),
      'utf8'
    );
    expect(guide).toContain(`"action_digest": "${stepUp.digest}"`);
    expect(guide).toContain(`"action_id": "act_${stepUp.digest.slice(0, 12)}"`);
    const approve = await import('./approve.js');
    expect(approve.refusal).toBe('not_eligible');
    expect(approve.state).toBe('approved');
  });

  it('step 5: the Resumption verifies for the approved arguments and not for changed ones', async () => {
    const resume = await import('./resume.js');
    expect(resume.refusal).toBe('digest_mismatch');
    expect(resume.approvedBy).toBe('user_approver');
    expect(resume.resumeToken).toMatch(/^rt_/);
  });

  it('step 6: the approval is consumed once and the record links to it', async () => {
    const { linked } = await import('./consume-and-record.js');
    expect(linked).toBe(true);
  });

  it('a tool registered with POST /v1/tools is stepped up with a resume token to come', async () => {
    const { registerTool } = await import('./register-tool.js');
    const { creator } = await import('./connect.js');
    const { argDigest } = await import('@noblecloak/client');
    await registerTool('ext:billing:issue_refund');
    const { data } = await creator.POST('/v1/decisions', {
      body: {
        action: {
          tool_ref: 'ext:billing:issue_refund',
          arg_digest: await argDigest({ order_id: 'A-7' }),
        },
        continuation: { kind: 'webhook', delivery: 'pull' },
      },
    });
    expect(data?.data.decision).toBe('step_up');
    expect(data?.data.approval?.resume_token_will_issue).toBe(true);
  });
});
