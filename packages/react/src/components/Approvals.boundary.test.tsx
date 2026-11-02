// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useApprovals } from '../use-approvals.js';
import { canned } from '../testing/canned-api.js';
import { cannedApproval } from '../testing/approvals-harness.js';
import { queueRows, renderController } from '../testing/component-harness.js';
import { detailStates, fakeController } from '../testing/fake-controller.js';
import { Approvals } from './Approvals.js';
import type { ApprovalsLabels } from './labels.js';

const reported: unknown[] = [];
beforeEach(() => {
  reported.length = 0;
  vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
  // React logs a caught render error; the test asserts on what the page shows instead.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Live({ api }: { readonly api: ReturnType<typeof canned> }) {
  const controller = useApprovals({
    baseUrl: 'https://api.test',
    getToken: () => 'tok',
    fetch: api.fetch,
    reconcileMs: 600_000,
  });
  return <Approvals controller={controller} />;
}

describe('c2-5 a malformed reply shows an error, not a broken page', () => {
  it('a list row without tool_ref is a malformed-response error and the host tree stays', async () => {
    const api = canned();
    const row = cannedApproval('apr_1');
    delete row.tool_ref;
    api.list = [row];
    render(
      <main>
        <p>host content</p>
        <Live api={api} />
      </main>
    );
    expect(
      await screen.findByText('The service sent a reply this page could not read.')
    ).toBeDefined();
    expect(screen.getByText('host content')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });
});

describe('c2-5 a render failure is contained by an error boundary', () => {
  const throwing = (key: keyof ApprovalsLabels, state: { on: boolean }): ApprovalsLabels =>
    Object.defineProperty({}, key, {
      enumerable: true,
      get: () => {
        if (state.on) throw new Error('label override failed');
        return undefined;
      },
    });

  it('a throwing label in the queue shows the message, keeps the host, reports, and Retry remounts', async () => {
    const user = userEvent.setup();
    const state = { on: true };
    render(
      <main>
        <p>host content</p>
        <Approvals
          controller={fakeController({ approvals: queueRows(1), status: 'ready' })}
          labels={throwing('queueHeading', state)}
        />
      </main>
    );
    expect(screen.getByText('Something went wrong showing this. Try again.')).toBeDefined();
    expect(screen.getByText('host content')).toBeDefined();
    expect(reported.length).toBeGreaterThan(0);
    state.on = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Approval requests' })).toBeDefined();
    });
  });

  it('a throwing label in the detail leaves the queue and the host in place', () => {
    const state = { on: true };
    render(
      <main>
        <p>host content</p>
        <Approvals
          controller={fakeController({
            approvals: queueRows(1),
            status: 'ready',
            detail: detailStates('apr_1').loaded,
          })}
          labels={throwing('detailClose', state)}
        />
      </main>
    );
    expect(screen.getByText('Something went wrong showing this. Try again.')).toBeDefined();
    expect(screen.getByText('host content')).toBeDefined();
    expect(screen.getAllByRole('button', { name: /tool_1/ }).length).toBeGreaterThan(0);
  });

  it('renders normally through renderController when nothing throws', () => {
    renderController(fakeController({ approvals: queueRows(1), status: 'ready' }));
    expect(screen.queryByText('Something went wrong showing this. Try again.')).toBeNull();
  });
});
