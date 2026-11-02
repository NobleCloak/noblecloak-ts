// @vitest-environment jsdom
import { act, cleanup, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalDetailStatus, ApprovalsController } from '../approvals-types.js';
import {
  MARKER,
  at,
  queueRows,
  renderController,
  renderHost,
} from '../testing/component-harness.js';
import { axe } from '../testing/axe.js';
import { DETAIL_STATUSES, detailStates, fakeController } from '../testing/fake-controller.js';

afterEach(cleanup);

const ARGS = { amount: 4200, note: MARKER };

function controllerFor(status: ApprovalDetailStatus, withArguments = false): ApprovalsController {
  const detail = detailStates('apr_1', withArguments ? { arguments: ARGS } : {})[status];
  return fakeController({ approvals: queueRows(1), detail });
}

function decisionButtons(): HTMLButtonElement[] {
  return ['Approve', 'Deny'].flatMap((name) =>
    screen.queryAllByRole<HTMLButtonElement>('button', { name })
  );
}

describe('T40: every detail state renders its text', () => {
  it('loading: a status with the loading text, no buttons to decide', () => {
    renderController(controllerFor('loading'));
    expect(screen.getByRole('status', { busy: true }).textContent).toBe('Loading the request…');
    expect(decisionButtons()).toEqual([]);
  });

  it('loaded with arguments: the full-call heading and the arguments, and says which view it is', () => {
    renderController(controllerFor('loaded', true));
    expect(
      screen.getByRole('heading', { name: 'The full call, as returned for this request' })
    ).toBeDefined();
    expect(document.body.textContent).toContain(MARKER);
    expect(screen.queryByText(/not shown to you/)).toBeNull();
  });

  it('loaded without arguments: the digest-only wording and the whole digest, with a copy button', () => {
    renderController(controllerFor('loaded'));
    expect(
      screen.getByText(
        'The arguments of this call are not shown to you. You are approving the call identified by this digest.'
      )
    ).toBeDefined();
    expect(screen.getByText('a3f1c0de'.repeat(8))).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy digest' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: /full call/ })).toBeNull();
  });

  it('refreshing: says Updating, still shows the request, and turns the actions off', () => {
    renderController(controllerFor('refreshing', true));
    expect(screen.getByText('Updating…')).toBeDefined();
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('ext:billing:issue_refund');
    expect(document.body.textContent).toContain(MARKER);
  });

  it('resolved: the outcome and who decided, no actions', () => {
    const detail = detailStates('apr_1', {
      approval: {
        approver: { id: 'user_ana', kind: 'user' },
        resolved_at: '2026-10-05T12:30:00Z',
        resolution_history: [
          {
            resolution: 'approved',
            by: { id: 'user_ana', kind: 'user' },
            at: '2026-10-05T12:30:00Z',
            reason: 'Checked',
          },
          {
            resolution: 'escalated-elsewhere',
            by: { id: 'user_bo', kind: 'user' },
            at: '2026-10-05T12:10:00Z',
          },
        ],
      },
    }).resolved;
    renderController(fakeController({ approvals: queueRows(1), detail }));
    expect(screen.getByText('Outcome').nextElementSibling?.textContent).toBe('approved');
    expect(screen.getByText('Decided by').nextElementSibling?.textContent).toBe('user_ana');
    expect(screen.getByText('approved by user_ana', { exact: false })).toBeDefined();
    // An unknown resolution is shown verbatim and offers no action.
    expect(screen.getByText('escalated-elsewhere by user_bo', { exact: false })).toBeDefined();
    expect(screen.getByText('Checked')).toBeDefined();
    expect(decisionButtons()).toEqual([]);
    expect(screen.getByText(/No arguments were returned for this request\./)).toBeDefined();
  });

  it('not found: says the request is gone', () => {
    renderController(controllerFor('not_found'));
    expect(screen.getByText('This request is gone, or you can no longer see it.')).toBeDefined();
  });

  it('unavailable: says so with the countdown, and Try again calls retryDetail', async () => {
    const user = userEvent.setup();
    const controller = controllerFor('unavailable');
    renderController(controller);
    expect(
      screen.getByText(
        'The service is temporarily unavailable. This request cannot be decided until it loads.'
      )
    ).toBeDefined();
    expect(screen.getByText('Trying again in 2 seconds.')).toBeDefined();
    expect(screen.getByText('Request ID: req_fake')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect((controller as ReturnType<typeof fakeController>).calls).toEqual([
      { method: 'retryDetail', args: [] },
    ]);
  });

  it('unavailable: the countdown counts down each second and ends at "Trying again now…"', () => {
    vi.useFakeTimers();
    try {
      const detail = {
        ...detailStates('apr_1').unavailable,
        retryingInMs: 3000,
      };
      renderController(fakeController({ approvals: queueRows(1), detail }));
      expect(screen.getByText('Trying again in 3 seconds.')).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText('Trying again in 1 seconds.')).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByText('Trying again now…')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forbidden: text about access, with the request id', () => {
    renderController(controllerFor('forbidden'));
    expect(screen.getByText('You do not have access to this request.')).toBeDefined();
    expect(screen.getByText('Request ID: req_fake')).toBeDefined();
  });

  it('session expired: says so and offers Sign in again, which calls onSignIn when given', async () => {
    const user = userEvent.setup();
    let signedIn = 0;
    renderController(controllerFor('unauthorized'), {
      onSignIn: () => {
        signedIn += 1;
      },
    });
    expect(screen.getByText('Your session has expired.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(signedIn).toBe(1);
  });

  it('session expired without onSignIn: Sign in again refreshes the controller', async () => {
    const user = userEvent.setup();
    const controller = controllerFor('unauthorized') as ReturnType<typeof fakeController>;
    renderController(controller);
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(controller.calls).toEqual([{ method: 'refresh', args: [] }]);
  });

  it('error: shows the error and a Try again that calls retryDetail', async () => {
    const user = userEvent.setup();
    const controller = controllerFor('error') as ReturnType<typeof fakeController>;
    renderController(controller);
    expect(screen.getByText('The network connection failed.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(controller.calls).toEqual([{ method: 'retryDetail', args: [] }]);
  });

  it('buttons are enabled only in loaded', () => {
    for (const status of DETAIL_STATUSES) {
      const { unmount } = renderController(controllerFor(status));
      const enabled = decisionButtons().filter((button) => !button.disabled);
      expect(enabled.length, status).toBe(status === 'loaded' ? 2 : 0);
      unmount();
    }
  });

  it('moves focus to the detail heading on open and back to the row on close', async () => {
    const user = userEvent.setup();
    renderHost({ approvals: queueRows(2), detailFor: (id) => detailStates(id).loaded });
    const rows = screen.getAllByRole('button', { name: /ext:billing:tool_/ });
    await user.click(at(rows, 1));
    const heading = screen.getByRole('heading', { level: 3 });
    expect(document.activeElement).toBe(heading);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    expect(document.activeElement).toBe(rows[1]);
  });

  it('does not take focus for a detail that was already open when it mounted', () => {
    renderHost({ approvals: queueRows(1), initialDetail: detailStates('apr_1').loaded });
    expect(document.activeElement).toBe(document.body);
  });
});

describe('T32: the buttons are disabled in every state but loaded, and while a resolve is in flight', () => {
  it.each(DETAIL_STATUSES.filter((status) => status !== 'loaded'))('%s', (status) => {
    renderController(controllerFor(status));
    for (const button of decisionButtons()) expect(button.disabled).toBe(true);
  });

  it('refreshing shows both buttons, both disabled', () => {
    renderController(controllerFor('refreshing'));
    expect(decisionButtons().map((button) => button.disabled)).toEqual([true, true]);
  });

  it('while the controller reports a resolve in flight for the open approval', () => {
    const detail = detailStates('apr_1').loaded;
    renderController(
      fakeController({ approvals: queueRows(1), detail, resolving: new Set(['apr_1']) })
    );
    expect(decisionButtons().map((button) => button.disabled)).toEqual([true, true]);
    expect(screen.getByText('Sending your decision…', { selector: 'p' })).toBeDefined();
  });

  it('a loaded detail whose approval is no longer pending offers no decision', () => {
    const detail = detailStates('apr_1', { approval: { state: 'consumed' } }).loaded;
    renderController(fakeController({ approvals: queueRows(1), detail }));
    expect(decisionButtons().map((button) => button.disabled)).toEqual([true, true]);
  });
});

describe('T34: an unavailable detail never says the person is ineligible', () => {
  it('shows temporary unavailability, Approve and Deny off', () => {
    renderController(controllerFor('unavailable'));
    const text = document.body.textContent;
    expect(text).not.toMatch(/not eligible|ineligible/i);
    expect(text).toContain('temporarily unavailable');
    expect(decisionButtons().filter((button) => !button.disabled)).toEqual([]);
  });
});

describe('T36: forbidden shows text about access, not eligibility', () => {
  it('says access, never eligibility', () => {
    renderController(controllerFor('forbidden'));
    const text = document.body.textContent;
    expect(text).toContain('You do not have access to this request.');
    expect(text).not.toMatch(/eligib/i);
  });
});

describe('T21: accessibility of every detail state', () => {
  it('covers every ApprovalDetailStatus the type has (a missing one also fails to compile)', () => {
    expect([...DETAIL_STATUSES].sort()).toEqual(Object.keys(detailStates('apr_1')).sort());
  });

  // One test per state, each with its own timeout: axe is slow on a loaded machine, and one failing state names itself.
  it.each(DETAIL_STATUSES)(
    'has no axe violations (colour contrast aside) in the %s state, with and without arguments',
    async (status) => {
      for (const withArguments of [false, true]) {
        const { container, unmount } = renderController(controllerFor(status, withArguments));
        expect((await axe(container)).violations, `${status} ${String(withArguments)}`).toEqual([]);
        unmount();
      }
    },
    20_000
  );

  it('names the reason box and every button', () => {
    renderController(controllerFor('loaded'));
    expect(screen.getByRole('textbox', { name: 'Reason (optional)' })).toBeDefined();
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent.trim().length).toBeGreaterThan(0);
    }
  });

  it('keyboard order: the rows, then the reason box, Approve, Deny, Close', async () => {
    const user = userEvent.setup();
    renderController(controllerFor('loaded'));
    const order = [
      'ext:billing:tool_1',
      'Copy digest',
      'Reason (optional)',
      'Approve',
      'Deny',
      'Close',
    ];
    const names: string[] = [];
    for (let remaining = order.length; remaining > 0; remaining -= 1) {
      await user.tab();
      const active = document.activeElement;
      names.push(
        active instanceof HTMLTextAreaElement
          ? (active.labels[0]?.textContent ?? '')
          : (active?.textContent ?? '')
      );
    }
    expect(names.map((name, index) => name.includes(at(order, index)))).toEqual(
      order.map(() => true)
    );
  });
});

describe('Copy digest', () => {
  function stubClipboard(writeText: () => Promise<void>): void {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  }

  it('says so in the live region when the digest was copied', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    renderController(controllerFor('loaded'));
    stubClipboard(writeText);
    await user.click(screen.getByRole('button', { name: 'Copy digest' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Digest copied.')).toBeDefined();
  });

  it('says so when the clipboard refuses, and the digest stays on the page', async () => {
    const user = userEvent.setup();
    renderController(controllerFor('loaded'));
    stubClipboard(() => Promise.reject(new Error('denied')));
    await user.click(screen.getByRole('button', { name: 'Copy digest' }));
    expect(
      await screen.findByText('The digest could not be copied. Select it and copy it by hand.')
    ).toBeDefined();
    expect(screen.queryByText('Digest copied.')).toBeNull();
    expect(document.querySelector('.nc-digest')?.textContent).not.toBe('');
  });

  it('says so when the browser has no clipboard', async () => {
    const user = userEvent.setup();
    renderController(controllerFor('loaded'));
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Copy digest' }));
    expect(
      await screen.findByText('The digest could not be copied. Select it and copy it by hand.')
    ).toBeDefined();
  });
});

describe('adv-5: the words the page adds around values are labels', () => {
  it('the UTC suffix and the count summaries follow the labels prop', () => {
    let deep: unknown = [1, 2, 3];
    for (let level = 0; level < 10; level += 1) deep = { next: deep };
    const detail = detailStates('apr_1', { arguments: { deep } }).loaded;
    renderController(fakeController({ approvals: queueRows(1), detail }), {
      labels: {
        timeUtc: '{time} (UTC)',
        jsonMoreMembers: '<{count} elementos>',
      },
    });
    const times = document.querySelectorAll('time');
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) expect(time.textContent).toMatch(/\(UTC\)$/);
    expect(document.querySelector('pre.nc-json')?.textContent).toContain('<1 elementos>');
  });
});
