// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalsError } from '../approvals-types.js';
import {
  MARKER,
  at,
  queueRows,
  renderController,
  renderHost,
} from '../testing/component-harness.js';
import { axe } from '../testing/axe.js';
import { approvalSummary, detailStates, fakeController } from '../testing/fake-controller.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the queue', () => {
  it('lists each request as a button with the tool, the level word, a short digest and the age', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T12:05:00Z'));
    renderController(
      fakeController({
        approvals: [
          { ...at(queueRows(2), 0), side_effect_level: 'delete' },
          { ...at(queueRows(2), 1), created_at: '2026-10-04T09:00:00Z' },
        ],
      })
    );
    const list = screen.getByRole('list', { name: 'Approval requests' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('ext:billing:tool_1');
    expect(rows[0]?.textContent).toContain('Level: delete');
    expect(rows[0]?.textContent).toContain('Digest a3f1c0dea3f1');
    expect(rows[0]?.textContent).not.toContain('a3f1c0dea3f1c');
    expect(rows[0]?.textContent).toContain('5 min ago');
    expect(rows[1]?.textContent).toContain('1 d ago');
    expect(rows[1]?.textContent).toContain('Level: external');
  });

  it('opens the detail of a row on click and marks the open row with aria-current', async () => {
    const user = userEvent.setup();
    const host = renderHost({
      approvals: queueRows(2),
      detailFor: (id) => detailStates(id).loading,
    });
    const rows = screen.getAllByRole('button', { name: /ext:billing:tool_/ });
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, null]);
    await user.click(at(rows, 1));
    expect(host.calls).toEqual([{ method: 'openDetail', args: ['apr_2'] }]);
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true']);
  });

  it('says in words when the queue is empty', () => {
    renderController(fakeController());
    expect(screen.getByText('No requests are waiting for you.')).toBeDefined();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says in words when the queue is loading, and does not say it is empty', () => {
    renderController(fakeController({ status: 'loading', connection: 'connecting' }));
    expect(screen.getByText('Loading requests…')).toBeDefined();
    expect(screen.queryByText('No requests are waiting for you.')).toBeNull();
  });

  it('shows an error with its request id and a retry that refreshes, instead of an empty queue', async () => {
    const user = userEvent.setup();
    const error: ApprovalsError = {
      kind: 'network',
      code: 'network',
      title: 'Network error',
      requestId: 'req_q1',
    };
    const controller = fakeController({ status: 'error', error });
    renderController(controller);
    expect(screen.getByText('The network connection failed.')).toBeDefined();
    expect(screen.getByText('Request ID: req_q1')).toBeDefined();
    expect(screen.queryByText('No requests are waiting for you.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(controller.calls.map((call) => call.method)).toEqual(['refresh']);
  });

  it('says in words that the list is truncated', () => {
    renderController(fakeController({ approvals: queueRows(2), truncated: true }));
    expect(screen.getByText('Only the first requests are shown. More are waiting.')).toBeDefined();
  });

  it.each([
    ['connecting', 'Connecting. The list may be out of date.'],
    ['live', 'Live. New requests appear as they arrive.'],
    ['polling', 'Checking for new requests every few seconds.'],
    ['offline', 'Offline. The list may be out of date.'],
  ] as const)('says the connection (%s) in words', (connection, words) => {
    renderController(fakeController({ connection }));
    expect(screen.getByText(words)).toBeDefined();
  });

  it('announces the count of waiting requests in a polite live region', () => {
    const many = renderController(fakeController({ approvals: queueRows(3) }));
    expect(screen.getByRole('status').textContent).toContain('3 requests are waiting for you.');
    many.unmount();
    renderController(fakeController({ approvals: queueRows(1) }));
    expect(screen.getByRole('status').textContent).toContain('1 request is waiting for you.');
  });

  it('never carries arguments in a row', () => {
    const smuggled = { ...approvalSummary(), arguments: { note: MARKER } };
    renderController(fakeController({ approvals: [smuggled as never] }));
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('takes a className and replaces any label', () => {
    const { container } = renderController(fakeController(), {
      className: 'host-class',
      labels: { queueHeading: 'Waiting for you', queueEmpty: 'Nothing to decide.' },
    });
    expect(container.firstElementChild?.className).toBe('nc-root nc-approvals host-class');
    expect(screen.getByRole('heading', { name: 'Waiting for you' })).toBeDefined();
    expect(screen.getByText('Nothing to decide.')).toBeDefined();
  });

  it('has no axe violations in any queue state', async () => {
    const states = [
      fakeController({ approvals: queueRows(3), truncated: true, connection: 'polling' }),
      fakeController(),
      fakeController({ status: 'loading' }),
      fakeController({
        status: 'error',
        error: { kind: 'unauthorized', code: 'unauthorized', title: 'x', requestId: 'req_9' },
      }),
    ];
    for (const state of states) {
      const { container, unmount } = renderController(state);
      expect((await axe(container)).violations).toEqual([]);
      unmount();
    }
  });
});

describe('c1-10 a failure the store is retrying is not an endless Loading', () => {
  const unavailable: ApprovalsError = {
    kind: 'unavailable',
    code: 'service_unavailable',
    status: 503,
    title: 'Unavailable',
  };

  it('shows the error and Try again while the status is still loading', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    renderController(
      fakeController({
        status: 'loading',
        error: unavailable,
        refresh: () => {
          calls.push('refresh');
          return Promise.resolve();
        },
      })
    );
    expect(screen.getByText('The service is temporarily unavailable. Trying again.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(calls).toEqual(['refresh']);
  });

  it('shows neither while loading without an error', () => {
    renderController(fakeController({ status: 'loading' }));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByText('Loading requests…')).toBeDefined();
  });
});
