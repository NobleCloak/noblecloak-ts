import type { ApprovalRequestProps } from './ApprovalRequest.js';
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalDetailStatus, ApprovalRequestController } from '../approvals-types.js';
import { axe } from '../testing/axe.js';
import { cannedApproval, jsonResponse, problemResponse } from '../testing/approvals-harness.js';
import { canned } from '../testing/canned-api.js';
import { MARKER } from '../testing/component-harness.js';
import { DETAIL_STATUSES, approvalSummary, detailStates } from '../testing/fake-controller.js';
import { ApprovalRequest } from './ApprovalRequest.js';

afterEach(cleanup);

function requestFor(
  status: ApprovalDetailStatus,
  extra: Parameters<typeof detailStates>[1] = {},
  retry: () => void = () => undefined
): ApprovalRequestController {
  return { ...detailStates('apr_1', extra)[status], retry };
}

const buttons = (): string[] => screen.queryAllByRole('button').map((b) => b.textContent.trim());

describe('ApprovalRequest renders one request on its own', () => {
  it.each(DETAIL_STATUSES)('%s: renders and offers no decision and no Close', (status) => {
    render(<ApprovalRequest request={requestFor(status)} />);
    for (const name of ['Approve', 'Deny', 'Close']) {
      expect(buttons()).not.toContain(name);
    }
  });

  it('shows the tool, the lineage, the policy, the timing and the digest of a loaded request', () => {
    render(<ApprovalRequest request={requestFor('loaded')} />);
    expect(screen.getByRole('heading', { name: 'ext:billing:issue_refund' })).toBeDefined();
    const text = document.body.textContent;
    expect(text).toContain('agent_refunds');
    expect(text).toContain('run_1');
    expect(text).toContain('policy_default');
    expect(text).toContain('langgraph');
  });

  it('shows the call only when the read carried arguments', () => {
    const { unmount } = render(
      <ApprovalRequest request={requestFor('loaded', { arguments: { note: MARKER } })} />
    );
    expect(document.body.textContent).toContain(MARKER);
    unmount();
    render(<ApprovalRequest request={requestFor('loaded')} />);
    expect(document.body.textContent).not.toContain(MARKER);
    expect(document.body.textContent).toContain('a3f1c0dea3f1c0de');
  });

  it('degrades when agent, run, policy and expiry are absent', () => {
    const bare = approvalSummary();
    const approval = { ...bare } as Partial<typeof bare>;
    delete approval.agent;
    delete approval.run;
    delete approval.policy;
    delete approval.expires_at;
    delete approval.continuation_kind;
    const request: ApprovalRequestController = {
      id: 'apr_1',
      status: 'loaded',
      approval: approval as typeof bare,
      retry: () => undefined,
    };
    render(<ApprovalRequest request={request} />);
    expect(screen.getByRole('heading', { name: 'ext:billing:issue_refund' })).toBeDefined();
    expect(document.body.textContent).not.toContain('agent_refunds');
    expect(document.body.textContent).not.toContain('policy_default');
  });

  it('shows an agent without a name or a parent by its id', () => {
    const request: ApprovalRequestController = {
      id: 'apr_1',
      status: 'loaded',
      approval: approvalSummary({ agent: { id: 'agent_only' } }),
      retry: () => undefined,
    };
    render(<ApprovalRequest request={request} />);
    expect(document.body.textContent).toContain('agent_only');
  });

  it('retries from the error state through the hook retry', async () => {
    const retry = vi.fn();
    render(<ApprovalRequest request={requestFor('error', {}, retry)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('"Sign in again" calls onSignIn, or reads again without it', async () => {
    const retry = vi.fn();
    const onSignIn = vi.fn();
    const { unmount } = render(
      <ApprovalRequest request={requestFor('unauthorized', {}, retry)} onSignIn={onSignIn} />
    );
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    unmount();
    render(<ApprovalRequest request={requestFor('unauthorized', {}, retry)} />);
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations when loaded', async () => {
    const { container } = render(<ApprovalRequest request={requestFor('loaded')} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('ApprovalRequest given an id reads the request itself', () => {
  it('reads the id it is given, shows it read-only, and reads the new id when it changes', async () => {
    const api = canned();
    api.read = (id) => jsonResponse({ data: cannedApproval(id) });
    const props = { baseUrl: 'https://canned.test', getToken: () => 'tok', fetch: api.fetch };
    const { rerender } = render(<ApprovalRequest id="apr_1" {...props} />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'mcp:tracker:create_issue' })).toBeDefined();
    });
    expect(buttons()).not.toContain('Approve');
    const first = api.calls.length;
    rerender(<ApprovalRequest id="apr_2" {...props} />);
    await waitFor(() => {
      expect(api.calls.length).toBeGreaterThan(first);
    });
    expect(api.calls.some((c) => c.includes('apr_2'))).toBe(true);
  });

  it('shows a refused read as a refusal, not as an empty request', async () => {
    const api = canned();
    api.read = () => problemResponse(403, 'forbidden');
    render(
      <ApprovalRequest
        id="apr_1"
        baseUrl="https://canned.test"
        getToken={() => 'tok'}
        fetch={api.fetch}
      />
    );
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/do not have access/i);
    });
  });
});

describe('ApprovalRequest props', () => {
  it('rejects passing both id and request at compile time', () => {
    const request = {} as ApprovalRequestController;
    // @ts-expect-error -- one form or the other: `id` with options, or `request` from the hook.
    const both: ApprovalRequestProps = { id: 'a', request };
    expect(both).toBeDefined();
  });
});
