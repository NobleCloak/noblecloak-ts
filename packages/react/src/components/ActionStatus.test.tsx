// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionStatusController, ActionStatusState } from '../action-status-types.js';
import { axe } from '../testing/axe.js';
import { cannedApproval, jsonResponse } from '../testing/approvals-harness.js';
import { canned } from '../testing/canned-api.js';
import { ActionStatus } from './ActionStatus.js';

afterEach(cleanup);

const AT = '2026-10-05T00:00:00.000Z';

type Ready = Extract<ActionStatusState, { status: 'ready' }>;

function statusFor(
  state: ActionStatusState,
  retry: () => void = () => undefined
): ActionStatusController {
  return { ...state, retry };
}

const ready = (extra: Partial<Ready> = {}): ActionStatusState => ({
  approvalId: 'apr_1',
  status: 'ready',
  state: 'pending',
  since: AT,
  onDeny: 'not_stated',
  refreshing: false,
  settled: false,
  connection: 'live',
  stale: false,
  ...extra,
});

const facts = (): Record<string, string> =>
  Object.fromEntries(
    [...document.querySelectorAll('.nc-fact')].map((el) => [
      el.querySelector('dt')?.textContent ?? '',
      el.querySelector('dd')?.textContent ?? '',
    ])
  );

/** The text beside the term `term`, or an empty string. */
const fact = (term: string): string => facts()[term] ?? '';

describe('ActionStatus renders the status it is given', () => {
  it('loading', () => {
    render(<ActionStatus status={statusFor({ approvalId: 'apr_1', status: 'loading' })} />);
    expect(screen.getByRole('status').textContent).toBe('Loading the status of this request…');
  });

  it.each([
    ['not_found', 'This request is gone, or you can no longer see it.', 'Try again'],
    ['forbidden', 'You do not have access to this request.', 'Try again'],
    ['unauthorized', 'Your session has expired.', 'Sign in again'],
    [
      'unavailable',
      'The service is temporarily unavailable. The status will load when it is back.',
      'Try again',
    ],
    ['error', 'The status of this request could not be read.', 'Try again'],
  ] as const)('%s: says so, and offers %s', (status, message, button) => {
    render(<ActionStatus status={statusFor({ approvalId: 'apr_1', status })} />);
    expect(screen.getByRole('alert').textContent).toContain(message);
    expect(screen.queryAllByRole('button').map((b) => b.textContent)).toEqual([button]);
  });

  it('gives the cause and the request id of a failed read, as the approvals queue does', () => {
    render(
      <ActionStatus
        status={statusFor({
          approvalId: 'apr_1',
          status: 'error',
          error: {
            kind: 'malformed_response',
            code: 'invalid_body',
            title: 'x',
            status: 200,
            requestId: 'req_9',
          },
        })}
      />
    );
    const alert = screen.getByRole('alert').textContent;
    expect(alert).toContain('The status of this request could not be read.');
    expect(alert).toContain('The service sent a reply this page could not read.');
    expect(alert).toContain('Request ID: req_9');
  });

  it.each(['forbidden', 'unavailable', 'unauthorized'] as const)(
    '%s: gives the request id of the failed read',
    (status) => {
      render(
        <ActionStatus
          status={statusFor({
            approvalId: 'apr_1',
            status,
            error: { kind: status, code: status, title: status, requestId: 'req_7' } as never,
          })}
        />
      );
      expect(screen.getByRole('alert').textContent).toContain('Request ID: req_7');
    }
  );

  it('says an unsupported deployment does not support it, with nothing to retry', () => {
    render(
      <ActionStatus
        status={statusFor({
          approvalId: 'apr_1',
          status: 'error',
          error: { kind: 'unsupported', code: 'unsupported', title: 'unsupported' },
        })}
      />
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'This service does not support that action.'
    );
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('offers Try again on a gone approval, which reads it afresh through retry()', async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    render(
      <ActionStatus status={statusFor({ approvalId: 'apr_1', status: 'not_found' }, retry)} />
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('retry and "Sign in again" call what they should', async () => {
    const retry = vi.fn();
    const onSignIn = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <ActionStatus status={statusFor({ approvalId: 'apr_1', status: 'forbidden' }, retry)} />
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    unmount();
    render(
      <ActionStatus
        status={statusFor({ approvalId: 'apr_1', status: 'unauthorized' }, retry)}
        onSignIn={onSignIn}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['pending', 'Waiting for a decision'],
    ['approved', 'Approved, not yet used'],
    ['rejected', 'Denied'],
    ['consumed', 'Approved and used'],
    ['expired', 'Expired without a decision'],
    ['withdrawn', 'Withdrawn'],
  ] as const)('the state %s reads "%s", with when it was requested', (state, words) => {
    render(<ActionStatus status={statusFor(ready({ state }))} />);
    expect(fact('Status')).toBe(words);
    expect(fact('Requested')).toBe('Oct 5, 2026, 12:00 AM UTC');
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(AT);
    expect(screen.getByRole('status').textContent).toBe(words);
  });

  it('a state this version does not know is shown as sent', () => {
    render(<ActionStatus status={statusFor(ready({ state: 'paused' as never }))} />);
    expect(fact('Status')).toBe('Unknown status: paused');
  });

  it('says it is updating while a pending approval is read again, and keeps what it showed', () => {
    render(
      <ActionStatus
        status={statusFor(ready({ refreshing: true, pendingOn: { kind: 'count', count: 2 } }))}
      />
    );
    expect(screen.getByRole('status').textContent).toBe('Waiting for a decision Updating…');
    expect(fact('Waiting on')).toBe('2 can decide');
  });

  it.each(['pending', 'approved'] as const)(
    'says the status (%s) may be out of date while its live updates fail, and not otherwise',
    (state) => {
      const { unmount } = render(
        <ActionStatus status={statusFor(ready({ state, connection: 'offline', stale: true }))} />
      );
      expect(screen.getByText('This status may be out of date.')).toBeDefined();
      unmount();
      render(<ActionStatus status={statusFor(ready({ state }))} />);
      expect(screen.queryByText('This status may be out of date.')).toBeNull();
    }
  );
});

describe('who it waits on', () => {
  it('lists the named approvers of a user creator', () => {
    render(
      <ActionStatus
        status={statusFor(
          ready({
            pendingOn: {
              kind: 'principals',
              count: 7,
              principals: [
                { id: 'user_a', kind: 'user', display_name: 'Ann' },
                { id: 'user_b', kind: 'user' },
              ],
            },
          })
        )}
      />
    );
    expect(fact('Waiting on')).toBe('7 can decide: Ann (user_a), user_b');
  });

  it('gives the count alone for a service-principal creator', () => {
    render(<ActionStatus status={statusFor(ready({ pendingOn: { kind: 'count', count: 3 } }))} />);
    expect(fact('Waiting on')).toBe('3 can decide');
  });

  it('says no one is known when the count is zero', () => {
    render(<ActionStatus status={statusFor(ready({ pendingOn: { kind: 'count', count: 0 } }))} />);
    expect(fact('Waiting on')).toBe('No one the service knows of can decide');
  });

  it('says unknown, not nothing, when the service did not say', () => {
    render(<ActionStatus status={statusFor(ready({ pendingOn: { kind: 'unknown' } }))} />);
    expect(fact('Waiting on')).toMatch(/^Unknown/);
  });

  it('shows no waiting-on row when the approval is not pending', () => {
    render(<ActionStatus status={statusFor(ready({ state: 'approved' }))} />);
    expect(Object.keys(facts())).not.toContain('Waiting on');
  });

  it('shows a name the service controls as inert text', () => {
    render(
      <ActionStatus
        status={statusFor(
          ready({
            pendingOn: {
              kind: 'principals',
              count: 1,
              principals: [{ id: 'user_a', kind: 'user', display_name: 'Ann‮evil' }],
            },
          })
        )}
      />
    );
    expect(fact('Waiting on')).not.toContain('‮');
  });
});

describe('what happens on deny', () => {
  it.each([
    ['resume', 'The run carries on without this action'],
    ['halt', 'The run stops'],
    ['not_stated', 'Not stated: the service did not say what a denial does'],
  ] as const)('%s', (onDeny, words) => {
    render(<ActionStatus status={statusFor(ready({ onDeny }))} />);
    expect(fact('If it is denied')).toBe(words);
  });
});

describe('the outcome of a consumed approval', () => {
  const consumed = (outcome: Ready['outcome']): ActionStatusState =>
    ready({ state: 'consumed', ...(outcome === undefined ? {} : { outcome }), settled: true });

  it.each([
    ['succeeded', 'Succeeded, recorded Oct 5, 2026, 1:02 AM UTC'],
    ['failed', 'Failed, recorded Oct 5, 2026, 1:02 AM UTC'],
    ['unknown', 'Reported as unknown, recorded Oct 5, 2026, 1:02 AM UTC'],
  ] as const)('a recorded outcome that %s', (result, words) => {
    render(
      <ActionStatus
        status={statusFor(
          consumed({
            status: 'recorded',
            recordId: 'rec_1',
            result,
            recordedAt: '2026-10-05T01:02:03.000Z',
          })
        )}
      />
    );
    expect(fact('Outcome')).toBe(words);
  });

  it('loading', () => {
    render(<ActionStatus status={statusFor(consumed({ status: 'loading', recordId: 'rec_1' }))} />);
    expect(fact('Outcome')).toBe('Loading the outcome…');
  });

  it.each([
    ['no_record', 'no outcome has been recorded', false],
    ['forbidden', 'you cannot read the outcome record', true],
    ['not_found', 'the outcome record was not found', true],
    ['no_outcome', 'the record states no outcome', false],
    ['unauthorized', 'your session has expired', true],
    ['unavailable', 'the outcome record could not be read', true],
    ['malformed', 'the outcome record is not one this version can read', false],
  ] as const)('not available: %s, and a retry only where one can help', (reason, words, retry) => {
    render(<ActionStatus status={statusFor(consumed({ status: 'unavailable', reason }))} />);
    expect(fact('Outcome')).toBe(`Outcome not available: ${words}`);
    expect(screen.queryAllByRole('button').length).toBe(retry ? 1 : 0);
  });

  it('gives the request id of an outcome read that failed', () => {
    render(
      <ActionStatus
        status={statusFor(
          consumed({
            status: 'unavailable',
            reason: 'unavailable',
            recordId: 'rec_1',
            error: { kind: 'unavailable', code: 'unavailable', title: 'x', requestId: 'req_5' },
          })
        )}
      />
    );
    expect(screen.getByText('Request ID: req_5')).toBeDefined();
  });

  it('asks to sign in again, not to retry, for an outcome read that ended in 401', async () => {
    const retry = vi.fn();
    const onSignIn = vi.fn();
    const user = userEvent.setup();
    const status = statusFor(
      consumed({ status: 'unavailable', reason: 'unauthorized', recordId: 'rec_1' }),
      retry
    );
    const { unmount } = render(<ActionStatus status={status} onSignIn={onSignIn} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    unmount();
    // A host with no sign-in hook still gets a control that does something: it reads again.
    render(<ActionStatus status={status} />);
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows no outcome row for an approval that is not consumed', () => {
    render(<ActionStatus status={statusFor(ready({ state: 'rejected' }))} />);
    expect(Object.keys(facts())).not.toContain('Outcome');
  });
});

describe('theme and words', () => {
  it('is structure only: it carries the module classes and imports no stylesheet', () => {
    render(<ActionStatus status={statusFor(ready())} className="mine" />);
    const root = document.querySelector('.nc-action-status');
    expect(root?.classList.contains('nc-root')).toBe(true);
    expect(root?.classList.contains('mine')).toBe(true);
    expect(document.querySelectorAll('style, link[rel="stylesheet"]').length).toBe(0);
  });

  it("takes the host's words, with placeholders", () => {
    render(
      <ActionStatus
        status={statusFor(ready({ pendingOn: { kind: 'count', count: 4 } }))}
        labels={{
          statePending: 'Warte',
          waitingOnCount: '{count} Prüfer',
          statusFactState: 'Stand',
        }}
      />
    );
    expect(fact('Stand')).toBe('Warte');
    expect(fact('Waiting on')).toBe('4 Prüfer');
  });
});

describe('ActionStatus reads the status itself', () => {
  it('given an approval id and the hook options', async () => {
    const api = canned();
    api.read = (id) =>
      jsonResponse({ data: cannedApproval(id, { on_deny: 'halt', waiting_on: { count: 2 } }) });
    render(
      <ActionStatus
        approvalId="apr_1"
        baseUrl="https://canned.test"
        getToken={() => 'tok'}
        fetch={api.fetch}
        reconcileMs={600_000}
      />
    );
    expect(screen.getByRole('status').textContent).toContain('Loading');
    await waitFor(() => {
      expect(fact('If it is denied')).toBe('The run stops');
    });
    expect(fact('Waiting on')).toBe('2 can decide');
  });
});

describe('accessibility', () => {
  it.each([
    ['loading', { approvalId: 'apr_1', status: 'loading' }],
    ['failed', { approvalId: 'apr_1', status: 'forbidden' }],
    ['pending', ready({ pendingOn: { kind: 'count', count: 1 } })],
    [
      'consumed',
      ready({
        state: 'consumed',
        outcome: { status: 'unavailable', reason: 'forbidden', recordId: 'rec_1' },
      }),
    ],
  ] as const)('%s has no axe violations', async (_name, state) => {
    const { container } = render(<ActionStatus status={statusFor(state)} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
