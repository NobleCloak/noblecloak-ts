// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ApprovalSummary, ApprovalsController } from '../approvals-types.js';
import { useApprovals } from '../use-approvals.js';
import {
  openApproval,
  problemResponse,
  startHarness,
  toolHidingArguments,
} from '../testing/approvals-harness.js';
import type { Harness } from '../testing/approvals-harness.js';
import { DEFAULT_LABELS } from './labels.js';
import { Approvals } from './Approvals.js';

/**
 * Against a service that answers as rev 5 (no rev 6 member, no rev 6 route), nothing of rev 6 reaches the
 * snapshot or the page: no queue row, open request or recent item carries a rev 6 member, and the rendered
 * text has none of the labels that exist only for one.
 */
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});
afterEach(cleanup);

const REV6_MEMBERS = ['requester', 'arguments_state', 'waiting_on', 'display_name'];
const strip = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(strip);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !REV6_MEMBERS.includes(key))
      .map(([key, member]) => [key, strip(member)])
  );
};

const rev5Fetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  if (url.pathname === '/v1/approvals/resolve/batch') return problemResponse(404, 'not_found');
  if (url.pathname === '/v1/approvals/stream' && url.searchParams.has('approver'))
    return problemResponse(400, 'invalid_request');
  if (url.pathname === '/v1/approvals' && (url.searchParams.has('order') || state.includes(',')))
    return problemResponse(400, 'invalid_request');
  const response = await globalThis.fetch(request);
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  const body: unknown = await response.json();
  return new Response(JSON.stringify(strip(body)), {
    status: response.status,
    headers: response.headers,
  });
};

const carried = (row: ApprovalSummary): string[] =>
  Object.keys(row).filter((key) => REV6_MEMBERS.includes(key));

// Words that only a rev 6 member can put on the page, read from the module's own words.
const REV6_WORDS = [
  DEFAULT_LABELS.factRequester,
  DEFAULT_LABELS.factWaitingOn,
  DEFAULT_LABELS.callNotEnabled,
  DEFAULT_LABELS.callNotSent,
  DEFAULT_LABELS.callWithheld,
];

describe('the rev 5 wrapper', () => {
  it('has no rev 6 member in the queue, the open request or the recent items, and none of the rev 6 labels on the page', async () => {
    const user = userEvent.setup();
    const tool = await toolHidingArguments(h.baseUrl);
    const opened = await openApproval(h.baseUrl, h.tokens.creator, { tool });
    let controller: ApprovalsController | undefined;
    function Probe() {
      controller = useApprovals({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.approver,
        fetch: rev5Fetch,
        reconcileMs: 600_000,
      });
      return <Approvals controller={controller} />;
    }
    render(<Probe />);
    const rowButton = await screen.findByRole('button', {
      name: new RegExp(opened.digest.slice(0, 12)),
    });
    const row = controller?.approvals.find((a) => a.id === opened.id);
    expect(row).toBeDefined();
    for (const r of controller?.approvals ?? []) expect(carried(r)).toEqual([]);
    await user.click(rowButton);
    await waitFor(() => {
      expect(controller?.detail).toMatchObject({ id: opened.id, status: 'loaded' });
    });
    const detail = controller?.detail;
    expect(
      JSON.stringify(detail, (key, v: unknown) => (REV6_MEMBERS.includes(key) ? '<<REV6>>' : v))
    ).not.toContain('<<REV6>>');
    for (const r of controller?.recent?.approvals ?? []) expect(carried(r)).toEqual([]);
    const text = document.body.textContent;
    for (const word of REV6_WORDS) expect(text).not.toContain(word);
  });
});
