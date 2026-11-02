// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Approvals } from './Approvals.js';
import type {
  ApprovalSummary,
  ApprovalsController,
  ApprovalsError,
  ManyResult,
} from '../approvals-types.js';
import { at, queueRows, renderController, renderHost } from '../testing/component-harness.js';
import { axe } from '../testing/axe.js';
import { approvalSummary, detailStates, fakeController } from '../testing/fake-controller.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ada = { id: 'user_ada', kind: 'user', display_name: 'Ada Lovelace' } as const;
const bo = { id: 'user_bo', kind: 'user', display_name: 'Bo' } as const;

describe('who is named on a request', () => {
  it('shows the requester, the agent and the approver by name with the id beside it, and the id alone when there is no name', async () => {
    const user = userEvent.setup();
    const host = renderHost({
      approvals: queueRows(1),
      detailFor: (id) =>
        detailStates(id, {
          approval: {
            requester: ada,
            agent: { id: 'agent_ledger', name: 'Ledger agent', parent: null },
            approver: bo,
            resolution_history: [
              {
                resolution: 'escalated',
                at: '2026-10-05T12:30:00Z',
                by: { id: 'user_cy', kind: 'user' },
              },
              { resolution: 'approved', at: '2026-10-05T12:40:00Z', by: bo },
            ],
          },
        }).resolved,
    });
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
    const detail = screen.getByRole('region', { name: /issue_refund/ });
    const text = detail.textContent;
    expect(text).toContain('Requested by');
    expect(text).toContain('Ada Lovelace (user_ada)');
    expect(text).toContain('Ledger agent (agent_ledger)');
    expect(text).toContain('Bo (user_bo)');
    // The history names who decided, and a principal with no name is its id.
    expect(text).toContain('approved by Bo (user_bo)');
    expect(text).toContain('escalated by user_cy');
    expect(host.calls.map((c) => c.method)).toEqual(['openDetail']);
  });

  it('shows a name that repeats its id once, and a name the service did not send as the id', () => {
    renderController(
      fakeController({
        approvals: [
          approvalSummary({
            id: 'a1',
            requester: { id: 'user_x', kind: 'user', display_name: 'user_x' },
          }),
          approvalSummary({ id: 'a2', requester: { id: 'user_y', kind: 'user' } }),
        ],
      })
    );
    const rows = within(screen.getByRole('list')).getAllByRole('button');
    expect(at(rows, 0).textContent).toContain('From user_x');
    expect(at(rows, 0).textContent).not.toContain('(user_x)');
    expect(at(rows, 1).textContent).toContain('From user_y');
  });

  it('shows who a request is from in the queue, with a name that cannot break out of its place', () => {
    renderController(
      fakeController({
        approvals: [
          approvalSummary({
            requester: { id: 'user_z', kind: 'user', display_name: 'Eve‮)(</bdi><b>x</b>' },
          }),
        ],
      })
    );
    const row = at(within(screen.getByRole('list')).getAllByRole('button'), 0);
    // The bidirectional control is shown as an escape and the markup is text, not a tag.
    expect(row.textContent).toContain('\\u202E');
    expect(row.querySelector('b')).toBeNull();
  });
});

describe('why the call is not shown', () => {
  const loaded = (arguments_state: string | undefined) =>
    detailStates('apr_1', {
      approval:
        arguments_state === undefined
          ? {}
          : { arguments_state: arguments_state as NonNullable<ApprovalSummary['arguments_state']> },
    }).loaded;

  it.each([
    ['not_enabled', 'is not set to show its calls to approvers'],
    ['not_sent', 'did not carry the call itself'],
    ['withheld', 'The call itself is not shown to you'],
  ])('says so for %s', async (state, words) => {
    const user = userEvent.setup();
    renderHost({ approvals: queueRows(1), detailFor: () => loaded(state) });
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
    expect(screen.getByRole('region', { name: /ext:billing/ }).textContent).toContain(words);
  });

  it.each([[undefined], ['shown'], ['something_new']])(
    'claims no reason when the state is %s, and says what it said before',
    async (state) => {
      const user = userEvent.setup();
      renderHost({ approvals: queueRows(1), detailFor: () => loaded(state) });
      await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
      const text = screen.getByRole('region', { name: /ext:billing/ }).textContent;
      expect(text).toContain('The arguments of this call are not shown to you');
      expect(text).not.toContain('not set to show');
    }
  );

  it('keeps the sentence for a spent request when the state says final', async () => {
    const user = userEvent.setup();
    renderHost({
      approvals: queueRows(1),
      detailFor: () => ({
        ...detailStates('apr_1', { approval: { arguments_state: 'final', state: 'rejected' } })
          .resolved,
        approval: approvalSummary({
          state: 'rejected',
          resolution: 'rejected',
          arguments_state: 'final',
        }),
      }),
    });
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
    expect(screen.getByRole('region', { name: /ext:billing/ }).textContent).toContain(
      'The arguments of this call are not shown. The call is identified by this digest.'
    );
  });
});

describe('the queue beyond its first page', () => {
  it('offers "Show more requests" only while the queue is truncated and the controller can, and calls loadMore', async () => {
    const user = userEvent.setup();
    const loadMore = vi.fn(() => Promise.resolve());
    renderController(fakeController({ approvals: queueRows(2), truncated: true, loadMore }));
    await user.click(screen.getByRole('button', { name: 'Show more requests' }));
    expect(loadMore).toHaveBeenCalledTimes(1);
    cleanup();
    renderController(fakeController({ approvals: queueRows(2), truncated: false, loadMore }));
    expect(screen.queryByRole('button', { name: 'Show more requests' })).toBeNull();
    cleanup();
    // A controller that predates the member shows the note and no button.
    renderController(fakeController({ approvals: queueRows(2), truncated: true }));
    expect(screen.queryByRole('button', { name: 'Show more requests' })).toBeNull();
    expect(screen.getByText('Only the first requests are shown. More are waiting.')).toBeDefined();
  });
});

describe('the recently decided requests', () => {
  const decided = (
    id: string,
    by: ApprovalSummary['approver'],
    resolution = 'approved'
  ): ApprovalSummary =>
    approvalSummary({
      id,
      state: resolution === 'approved' ? 'approved' : 'rejected',
      resolution,
      resolved_at: '2026-10-05T12:30:00Z',
      ...(by === undefined ? {} : { approver: by }),
    });

  it('has no tab on a controller that cannot read them', () => {
    renderController(fakeController({ approvals: queueRows(1) }));
    expect(screen.queryByRole('button', { name: 'Recently decided' })).toBeNull();
  });

  it('reads them when the tab is chosen, lists who decided each, and reads an older page on request', async () => {
    const user = userEvent.setup();
    const loadRecent = vi.fn(() => Promise.resolve());
    const loadMoreRecent = vi.fn(() => Promise.resolve());
    renderController(
      fakeController({
        approvals: queueRows(1),
        loadRecent,
        loadMoreRecent,
        recent: {
          status: 'ready',
          approvals: [decided('r1', bo), decided('r2', undefined, 'rejected')],
          more: true,
          loadingMore: false,
        },
      })
    );
    expect(loadRecent).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Recently decided' }));
    expect(loadRecent).toHaveBeenCalledTimes(1);
    // Choosing the tab that is already chosen reads them again (a way to retry a failed read).
    await user.click(screen.getByRole('button', { name: 'Recently decided' }));
    expect(loadRecent).toHaveBeenCalledTimes(2);
    const rows = within(
      screen.getByRole('list', { name: 'Recently decided requests' })
    ).getAllByRole('button');
    expect(at(rows, 0).textContent).toContain('approved by Bo (user_bo)');
    expect(at(rows, 1).textContent).toContain('rejected');
    expect(at(rows, 1).textContent).not.toContain(' by ');
    await user.click(screen.getByRole('button', { name: 'Show older' }));
    expect(loadMoreRecent).toHaveBeenCalledTimes(1);
    // Back to the queue.
    await user.click(screen.getByRole('button', { name: 'Waiting for you' }));
    expect(screen.getByRole('heading', { name: 'Approval requests' })).toBeDefined();
  });

  it('opens a decided request in the same detail, and says nothing is there before it is read', async () => {
    const user = userEvent.setup();
    const host = renderHost({
      approvals: [],
      detailFor: (id) => detailStates(id).resolved,
      overrides: {
        loadRecent: () => Promise.resolve(),
        recent: {
          status: 'ready',
          approvals: [decided('r1', bo)],
          more: false,
          loadingMore: false,
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Recently decided' }));
    await user.click(screen.getByRole('button', { name: /ext:billing:issue_refund/ }));
    expect(host.calls.at(-1)).toEqual({ method: 'openDetail', args: ['r1'] });
  });

  it('says it is loading, that nothing was decided, or that the read failed, with a way to try again', async () => {
    const user = userEvent.setup();
    const loadRecent = vi.fn(() => Promise.resolve());
    const error: ApprovalsError = {
      kind: 'unavailable',
      code: 'service_unavailable',
      title: 'x',
      status: 503,
    };
    const states = [
      { status: 'loading', approvals: [], more: false, loadingMore: false },
      { status: 'ready', approvals: [], more: false, loadingMore: false },
      { status: 'error', approvals: [], more: false, loadingMore: false, error },
    ] as const;
    for (const recent of states) {
      renderController(fakeController({ approvals: [], loadRecent, recent }));
      await user.click(screen.getByRole('button', { name: 'Recently decided' }));
      if (recent.status === 'loading')
        expect(screen.getByText('Loading decided requests…')).toBeDefined();
      if (recent.status === 'ready')
        expect(screen.getByText('Nothing has been decided yet.')).toBeDefined();
      if (recent.status === 'error') {
        expect(screen.getByRole('alert').textContent).toContain('temporarily unavailable');
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(loadRecent).toHaveBeenCalledTimes(4);
      }
      cleanup();
    }
  });

  it('has no axe violations', async () => {
    const user = userEvent.setup();
    const { container } = renderController(
      fakeController({
        approvals: queueRows(2),
        truncated: true,
        loadMore: () => Promise.resolve(),
        approveMany: () => Promise.resolve({ ok: true, results: [] }),
        loadRecent: () => Promise.resolve(),
        recent: { status: 'ready', approvals: [decided('r1', bo)], more: true, loadingMore: false },
      })
    );
    expect((await axe(container)).violations).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Recently decided' }));
    expect((await axe(container)).violations).toEqual([]);
  });
});

// A request the batch may approve: its tool shows approvers no arguments, so there is nothing to read.
const noArguments = { arguments_state: 'not_enabled' } as const;

describe('approving several at once', () => {
  const approved = (id: string) => ({
    id,
    ok: true as const,
    approval: approvalSummary({ id, state: 'approved' }),
  });

  it('has no checkboxes on a controller that cannot', () => {
    renderController(fakeController({ approvals: queueRows(2, noArguments) }));
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('names the count on the button, asks for confirmation that says the requests are not opened, then approves exactly those chosen', async () => {
    const user = userEvent.setup();
    const approveMany = vi.fn((ids: readonly string[]) =>
      Promise.resolve<ManyResult>({ ok: true, results: ids.map(approved) })
    );
    renderController(fakeController({ approvals: queueRows(3, noArguments), approveMany }));
    expect(screen.queryByRole('button', { name: /Approve selected/ })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Select ext:billing:tool_1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select ext:billing:tool_3' }));
    await user.click(screen.getByRole('button', { name: 'Approve selected (2)' }));
    // Nothing is sent until it is confirmed.
    expect(approveMany).not.toHaveBeenCalled();
    expect(screen.getByText(/Approve 2 requests as listed, without opening them\?/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Confirm approving 2' }));
    expect(approveMany).toHaveBeenCalledWith(
      ['apr_1', 'apr_3'],
      new Map([
        ['apr_1', queueRows(1)[0]?.action_digest],
        ['apr_3', queueRows(1)[0]?.action_digest],
      ])
    );
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('2 approved.');
    });
    // The choice is dropped once the call ends.
    expect(screen.queryByRole('button', { name: /Approve selected/ })).toBeNull();
    for (const box of screen.getAllByRole('checkbox'))
      expect((box as HTMLInputElement).checked).toBe(false);
  });

  it('cancels without sending, and drops the confirmation when the choice changes', async () => {
    const user = userEvent.setup();
    const approveMany = vi.fn(() => Promise.resolve<ManyResult>({ ok: true, results: [] }));
    renderController(fakeController({ approvals: queueRows(2, noArguments), approveMany }));
    await user.click(screen.getByRole('checkbox', { name: 'Select ext:billing:tool_1' }));
    await user.click(screen.getByRole('button', { name: 'Approve selected (1)' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Approve selected (1)' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Approve selected (1)' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select ext:billing:tool_2' }));
    expect(screen.queryByRole('button', { name: /Confirm approving/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve selected (2)' })).toBeDefined();
    expect(approveMany).not.toHaveBeenCalled();
  });

  it('says how many were approved and that the rest were not, and shows a failed call whole', async () => {
    const user = userEvent.setup();
    const conflict: ApprovalsError = {
      kind: 'conflict',
      code: 'approval_conflict',
      title: 'x',
      status: 409,
    };
    const unavailable: ApprovalsError = {
      kind: 'unavailable',
      code: 'service_unavailable',
      title: 'x',
      status: 503,
      reason: 'eligibility_lookup',
    };
    let answer: ManyResult = {
      ok: true,
      results: [approved('apr_1'), { id: 'apr_2', ok: false, error: conflict }],
    };
    const approveMany = vi.fn(() => Promise.resolve(answer));
    renderController(fakeController({ approvals: queueRows(2, noArguments), approveMany }));
    for (const n of [1, 2])
      await user.click(
        screen.getByRole('checkbox', { name: `Select ext:billing:tool_${String(n)}` })
      );
    await user.click(screen.getByRole('button', { name: 'Approve selected (2)' }));
    await user.click(screen.getByRole('button', { name: 'Confirm approving 2' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('1 approved. 1 were not approved');
    });
    answer = { ok: false, error: unavailable };
    for (const n of [1, 2])
      await user.click(
        screen.getByRole('checkbox', { name: `Select ext:billing:tool_${String(n)}` })
      );
    await user.click(screen.getByRole('button', { name: 'Approve selected (2)' }));
    await user.click(screen.getByRole('button', { name: 'Confirm approving 2' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'could not check whether you may decide'
      );
    });
    expect(screen.getByRole('status').textContent).toContain(
      'None of the selected requests could be approved.'
    );
  });

  it('drops a request that left the queue from the choice, and cannot choose one with a decision on its way', async () => {
    const user = userEvent.setup();
    const approveMany = vi.fn(() => Promise.resolve<ManyResult>({ ok: true, results: [] }));
    const view = renderController(
      fakeController({ approvals: queueRows(2, noArguments), approveMany })
    );
    await user.click(screen.getByRole('checkbox', { name: 'Select ext:billing:tool_1' }));
    expect(screen.getByRole('button', { name: 'Approve selected (1)' })).toBeDefined();
    view.rerender(<div>{/* the first request left the queue */}</div>);
    cleanup();
    renderController(
      fakeController({
        approvals: queueRows(2, noArguments).slice(1),
        approveMany,
        resolving: new Set(['apr_2']),
      })
    );
    expect(screen.getByRole('checkbox', { name: 'Select ext:billing:tool_2' })).toHaveProperty(
      'disabled',
      true
    );
  });
});

describe('a ticked request that stops being selectable', () => {
  it('leaves the count and the confirmation when a refresh makes its call readable, or resolves it', async () => {
    const user = userEvent.setup();
    const approveMany = vi.fn(() => Promise.resolve<ManyResult>({ ok: true, results: [] }));
    const rows = queueRows(2, noArguments);
    const view = renderController(fakeController({ approvals: rows, approveMany }));
    await user.click(screen.getByRole('checkbox', { name: 'Select ext:billing:tool_1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select ext:billing:tool_2' }));
    expect(screen.getByRole('button', { name: 'Approve selected (2)' })).toBeDefined();
    // A refresh: the first request's call can now be read, the second was decided elsewhere; both stay in the list.
    view.rerender(
      <Approvals
        controller={fakeController({
          approvals: [
            { ...at(rows, 0), arguments_state: 'shown' },
            { ...at(rows, 1), state: 'approved' },
          ],
          approveMany,
        })}
      />
    );
    expect(screen.queryByRole('button', { name: /Approve selected/ })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('counts only the rows that can still be sent', async () => {
    const user = userEvent.setup();
    const approveMany = vi.fn(() => Promise.resolve<ManyResult>({ ok: true, results: [] }));
    const rows = queueRows(2, noArguments);
    const view = renderController(fakeController({ approvals: rows, approveMany }));
    await user.click(screen.getByRole('checkbox', { name: 'Select ext:billing:tool_1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select ext:billing:tool_2' }));
    view.rerender(
      <Approvals
        controller={fakeController({
          approvals: [{ ...at(rows, 0), arguments_state: 'shown' }, at(rows, 1)],
          approveMany,
        })}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Approve selected (1)' }));
    expect(screen.getByText(/Approve 1 request/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Confirm approving 1' }));
    expect(approveMany.mock.calls[0]).toEqual([['apr_2'], expect.any(Map)]);
  });
});

describe('what an unavailable service says', () => {
  const unavailable = (extra: Partial<ApprovalsError> = {}): ApprovalsError =>
    ({
      kind: 'unavailable',
      code: 'service_unavailable',
      title: 'x',
      status: 503,
      ...extra,
    }) as ApprovalsError;

  it('says that the lookup of who may decide failed, in place of "unavailable", with the wait the service named', () => {
    renderController(
      fakeController({ status: 'error', error: unavailable({ reason: 'eligibility_lookup' }) })
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'could not check whether you may decide this request'
    );
    expect(screen.getByRole('alert').textContent).toContain('Try again in a moment.');
    cleanup();
    renderController(
      fakeController({
        status: 'error',
        error: unavailable({ reason: 'eligibility_lookup', retryAfterMs: 4000 }),
      })
    );
    expect(screen.getByRole('alert').textContent).toContain('Try again in 4 seconds.');
  });

  it('treats a reason it does not know as a plain 503, and says the wait for a decision that is not retried', () => {
    renderController(
      fakeController({ status: 'error', error: unavailable({ reason: 'cache_cold' }) })
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'temporarily unavailable. Trying again.'
    );
  });
});

describe('which requests may be approved without opening them', () => {
  const approveMany = (): Promise<ManyResult> => Promise.resolve({ ok: true, results: [] });

  it.each([
    ['arguments the approver can read', 'shown', 'Has a call to read: open it to decide.'],
    ['a state withheld from this reader', 'withheld', 'Open this request to decide it.'],
    [
      'no state (a service or event that does not say)',
      undefined,
      'Open it to read it before approving.',
    ],
  ] as const)(
    'has no checkbox for a request with %s, and says why in words',
    (_name, state, words) => {
      renderController(
        fakeController({
          approvals: queueRows(1, state === undefined ? {} : { arguments_state: state }),
          approveMany,
        })
      );
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      expect(screen.getByText(words)).toBeDefined();
      expect(screen.queryByRole('button', { name: /Approve selected/ })).toBeNull();
    }
  );

  it('offers a checkbox for not_sent as well as not_enabled, and only for those in a mixed queue', () => {
    renderController(
      fakeController({
        approvals: [
          ...queueRows(1, { arguments_state: 'not_sent' }).map((r) => ({ ...r, id: 'apr_a' })),
          ...queueRows(1, { arguments_state: 'shown' }).map((r) => ({ ...r, id: 'apr_b' })),
        ],
        approveMany,
      })
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('sends the digest the person confirmed, not the one a row has after it changed', async () => {
    const user = userEvent.setup();
    const spy = vi.fn<NonNullable<ApprovalsController['approveMany']>>(() => approveMany());
    const rows = queueRows(1, noArguments);
    const view = renderController(fakeController({ approvals: rows, approveMany: spy }));
    await user.click(screen.getByRole('checkbox', { name: 'Select ext:billing:tool_1' }));
    await user.click(screen.getByRole('button', { name: 'Approve selected (1)' }));
    view.rerender(
      <Approvals
        controller={fakeController({
          approvals: rows.map((r) => ({ ...r, action_digest: 'b'.repeat(64) })),
          approveMany: spy,
        })}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Confirm approving 1' }));
    expect(spy.mock.calls[0]?.[1]?.get('apr_1')).toBe(rows[0]?.action_digest);
  });
});

describe('waiting_on on the open request', () => {
  const open = async (waiting?: Partial<ApprovalSummary>) => {
    const user = userEvent.setup();
    renderHost({
      approvals: queueRows(1),
      detailFor: (id) => detailStates(id, { approval: { ...waiting } }).resolved,
    });
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
    return screen.getByRole('region', { name: /issue_refund/ }).textContent;
  };

  it('shows nothing, not zero and not an error, when the read has no waiting_on', async () => {
    expect(await open()).not.toContain('Approvers who can decide');
  });

  it('shows a count of zero as zero, and a count with the names it came with', async () => {
    expect(await open({ waiting_on: { count: 0 } })).toMatch(/Approvers who can decide\s*0/);
    cleanup();
    const text = await open({
      waiting_on: { count: 2, principals: [{ id: 'user_bo', kind: 'user', display_name: 'Bo' }] },
    });
    expect(text).toContain('Approvers who can decide');
    expect(text).toContain('2: Bo (user_bo)');
  });

  it('renders a name as text, never as markup', async () => {
    const text = await open({
      waiting_on: {
        count: 1,
        principals: [{ id: 'user_bo', kind: 'user', display_name: '<img src=x onerror=alert(1)>' }],
      },
    });
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('a service that sends none of the rev 6 members', () => {
  it('shows no placeholder for a requester, a name or a waiting count, in the queue or on the open request', async () => {
    const user = userEvent.setup();
    renderHost({
      approvals: queueRows(1),
      detailFor: (id) => detailStates(id, { approval: {} }).resolved,
    });
    expect(screen.queryByText(/^From /)).toBeNull();
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
    const text = screen.getByRole('region', { name: /issue_refund/ }).textContent;
    for (const word of ['Requested by', 'Approvers who can decide', 'undefined', 'null']) {
      expect(text).not.toContain(word);
    }
  });
});
