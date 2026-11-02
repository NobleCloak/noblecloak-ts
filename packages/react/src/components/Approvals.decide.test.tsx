// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Approvals } from './Approvals.js';
import type {
  ApprovalDetailState,
  ApprovalSummary,
  ApprovalsError,
  ResolveResult,
} from '../approvals-types.js';
import { queueRows, renderController, renderHost } from '../testing/component-harness.js';
import { axe } from '../testing/axe.js';
import { approvalSummary, detailStates, fakeController } from '../testing/fake-controller.js';

afterEach(cleanup);

function loaded(level: ApprovalSummary['side_effect_level'] = 'external') {
  return (id: string) => detailStates(id, { approval: { side_effect_level: level } }).loaded;
}

async function openFirstRow(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
}

describe('deciding', () => {
  it('Approve on an external request calls approve with the id and no confirm step', async () => {
    const user = userEvent.setup();
    const host = renderHost({ approvals: queueRows(1), detailFor: loaded('external') });
    await openFirstRow(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(host.calls.filter((call) => call.method === 'approve')).toEqual([
      { method: 'approve', args: ['apr_1'] },
    ]);
    expect(await screen.findByText('Approved. The request has left your queue.')).toBeDefined();
  });

  it('passes the reason typed in the box, and never an expectedActionDigest', async () => {
    const user = userEvent.setup();
    const host = renderHost({ approvals: queueRows(1), detailFor: loaded('write') });
    await openFirstRow(user);
    await user.type(
      screen.getByRole('textbox', { name: 'Reason (optional)' }),
      'Checked the invoice'
    );
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(host.calls.filter((call) => call.method === 'deny')).toEqual([
      { method: 'deny', args: ['apr_1', { reason: 'Checked the invoice' }] },
    ]);
    expect(await screen.findByText('Denied. The request has left your queue.')).toBeDefined();
  });

  it('keeps the typed reason when the detail goes to loading and back', async () => {
    const user = userEvent.setup();
    const states = detailStates('apr_1');
    const withDetail = (detail: ApprovalDetailState) =>
      fakeController({ approvals: queueRows(1), detail });
    const view = renderController(withDetail(states.loaded));
    await user.type(screen.getByRole('textbox', { name: 'Reason (optional)' }), 'Checked');
    view.rerender(<Approvals controller={withDetail(states.loading)} />);
    expect(screen.queryByRole('textbox', { name: 'Reason (optional)' })).toBeNull();
    view.rerender(<Approvals controller={withDetail(states.loaded)} />);
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Reason (optional)' }).value
    ).toBe('Checked');
  });

  it('limits the reason box to 2 000 characters', async () => {
    const user = userEvent.setup();
    renderHost({ approvals: queueRows(1), detailFor: loaded() });
    await openFirstRow(user);
    expect(
      screen.getByRole('textbox', { name: 'Reason (optional)' }).getAttribute('maxlength')
    ).toBe('2000');
  });

  it('after success the detail is closed on the controller and focus returns to the row that is still listed', async () => {
    const user = userEvent.setup();
    const host = renderHost({ approvals: queueRows(1), detailFor: loaded() });
    await openFirstRow(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved. The request has left your queue.');
    expect(host.calls.at(-1)).toEqual({ method: 'closeDetail', args: [] });
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
  });

  it('after success focus lands on the queue heading when the controller keeps showing the detail', async () => {
    const user = userEvent.setup();
    const controller = fakeController({
      approvals: queueRows(1),
      detail: detailStates('apr_1').loaded,
    });
    renderController(controller);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved. The request has left your queue.');
    expect(controller.calls.map((call) => call.method)).toEqual(['approve', 'closeDetail']);
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
  });

  it('turns the buttons off while the decision is on its way', async () => {
    const user = userEvent.setup();
    let release: (result: ResolveResult) => void = () => undefined;
    renderHost({
      approvals: queueRows(1),
      detailFor: loaded(),
      overrides: {
        approve: () =>
          new Promise<ResolveResult>((resolve) => {
            release = resolve;
          }),
      },
    });
    await openFirstRow(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Deny' }).disabled).toBe(true);
    expect(screen.getByText('Sending your decision…', { selector: 'p.nc-muted' })).toBeDefined();
    release({ ok: true, approval: approvalSummary({ state: 'approved' }) });
    expect(await screen.findByText('Approved. The request has left your queue.')).toBeDefined();
  });

  it('does not touch the page after it was unmounted mid-decision', async () => {
    const user = userEvent.setup();
    let release: (result: ResolveResult) => void = () => undefined;
    const host = renderHost({
      approvals: queueRows(1),
      detailFor: loaded(),
      overrides: {
        approve: () =>
          new Promise<ResolveResult>((resolve) => {
            release = resolve;
          }),
      },
    });
    await openFirstRow(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    host.unmount();
    release({ ok: true, approval: approvalSummary({ state: 'approved' }) });
    await Promise.resolve();
    expect(host.calls.map((call) => call.method)).toEqual(['openDetail', 'approve']);
  });
});

describe('T21: the confirm step', () => {
  it.each(['delete', 'admin'] as const)(
    'Approve at the %s level asks to confirm, with focus on Confirm',
    async (level) => {
      const user = userEvent.setup();
      const host = renderHost({ approvals: queueRows(1), detailFor: loaded(level) });
      await openFirstRow(user);
      await user.click(screen.getByRole('button', { name: 'Approve' }));
      expect(host.calls.filter((call) => call.method === 'approve')).toEqual([]);
      const confirm = screen.getByRole('button', { name: 'Confirm approval' });
      expect(document.activeElement).toBe(confirm);
      expect(
        screen.getByText(
          `This request has the ${level} level. Confirm that you want to approve it.`
        )
      ).toBeDefined();
      await user.click(confirm);
      expect(host.calls.filter((call) => call.method === 'approve')).toHaveLength(1);
    }
  );

  it('Cancel closes the confirm step and returns focus to Approve without deciding', async () => {
    const user = userEvent.setup();
    const host = renderHost({ approvals: queueRows(1), detailFor: loaded('delete') });
    await openFirstRow(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Confirm approval' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Approve' }));
    expect(host.calls.filter((call) => call.method === 'approve')).toEqual([]);
  });

  it.each(['read', 'write', 'external'] as const)(
    'Approve at the %s level asks for no confirmation',
    async (level) => {
      const user = userEvent.setup();
      const host = renderHost({ approvals: queueRows(1), detailFor: loaded(level) });
      await openFirstRow(user);
      await user.click(screen.getByRole('button', { name: 'Approve' }));
      expect(screen.queryByRole('button', { name: 'Confirm approval' })).toBeNull();
      expect(host.calls.filter((call) => call.method === 'approve')).toHaveLength(1);
    }
  );

  it.each(['delete', 'admin'] as const)(
    'Deny at the %s level never asks to confirm',
    async (level) => {
      const user = userEvent.setup();
      const host = renderHost({ approvals: queueRows(1), detailFor: loaded(level) });
      await openFirstRow(user);
      await user.click(screen.getByRole('button', { name: 'Deny' }));
      expect(screen.queryByRole('button', { name: 'Confirm approval' })).toBeNull();
      expect(host.calls.filter((call) => call.method === 'deny')).toHaveLength(1);
    }
  );

  it('has no axe violations while confirming', async () => {
    const user = userEvent.setup();
    const host = renderHost({ approvals: queueRows(1), detailFor: loaded('admin') });
    await openFirstRow(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect((await axe(host.container)).violations).toEqual([]);
  });
});

const KINDS: readonly [ApprovalsError, string][] = [
  [
    { kind: 'unauthorized', code: 'unauthorized', title: 't', requestId: 'req_k' },
    'Your session has expired.',
  ],
  [
    { kind: 'forbidden', code: 'forbidden', title: 't', requestId: 'req_k' },
    'You do not have access to this request.',
  ],
  [
    { kind: 'not_found', code: 'not_found', title: 't', requestId: 'req_k' },
    'This request is gone, or you can no longer see it.',
  ],
  [
    { kind: 'invalid_request', code: 'invalid_request', title: 't', requestId: 'req_k' },
    'The service did not accept this request.',
  ],
  [
    { kind: 'rate_limited', code: 'rate_limited', title: 't', requestId: 'req_k' },
    'There have been too many requests. Wait a moment, then try again.',
  ],
  [
    {
      kind: 'rate_limited',
      code: 'rate_limited',
      title: 't',
      requestId: 'req_k',
      retryAfterMs: 2500,
    },
    'There have been too many requests. Try again in 3 seconds.',
  ],
  [
    { kind: 'unavailable', code: 'unavailable', title: 't', requestId: 'req_k' },
    'The service is temporarily unavailable. Trying again.',
  ],
  [
    { kind: 'network', code: 'network', title: 't', requestId: 'req_k' },
    'The network connection failed.',
  ],
  [
    { kind: 'unsupported', code: 'unsupported', title: 't', requestId: 'req_k' },
    'This service does not support that action.',
  ],
  [
    { kind: 'malformed_response', code: 'bad', title: 't', requestId: 'req_k' },
    'The service sent a reply this page could not read.',
  ],
  [
    { kind: 'precondition', code: 'detail_not_read', local: true, title: 't', requestId: 'req_k' },
    'Open the request and wait for it to load before deciding.',
  ],
  [
    { kind: 'conflict', code: 'approval_conflict', title: 't', requestId: 'req_k' },
    'This request changed while you were looking at it. Open it again to see the latest.',
  ],
  [
    { kind: 'conflict', code: 'already_resolved', title: 't', requestId: 'req_k' },
    'This request has already been decided.',
  ],
  [
    { kind: 'conflict', code: 'obligation_expired', title: 't', requestId: 'req_k' },
    'This request has expired.',
  ],
  [
    { kind: 'conflict', code: 'resolve_in_flight', local: true, title: 't', requestId: 'req_k' },
    'A decision for this request is already being sent.',
  ],
  [
    { kind: 'conflict', code: 'a_code_from_a_later_version', title: 't', requestId: 'req_k' },
    'This request changed while you were looking at it. Open it again to see the latest.',
  ],
];

/** A failed Approve is not retried by anything, so its 503 sentence differs from the one for a read. */
const DECISION_WORDS: ReadonlyMap<string, string> = new Map([
  [
    'The service is temporarily unavailable. Trying again.',
    'The service is temporarily unavailable. Try again in a moment.',
  ],
]);

describe('T21: every error kind renders its text and request id', () => {
  it.each(KINDS)('a failed decision: %j', async (error, readWords) => {
    const words = DECISION_WORDS.get(readWords) ?? readWords;
    const user = userEvent.setup();
    renderHost({
      approvals: queueRows(1),
      detailFor: loaded(),
      overrides: { approve: () => Promise.resolve({ ok: false, error }) },
    });
    await openFirstRow(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(words);
    expect(alert.textContent).not.toContain('Trying again');
    expect(alert.textContent).toContain('Request ID: req_k');
    // The failure stays on the page, the controller keeps the detail, and focus goes to the message.
    expect(document.activeElement).toBe(alert);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(false);
  });

  it.each(KINDS)('an error on the queue: %j', (error, words) => {
    renderController(fakeController({ status: 'error', error }));
    expect(screen.getByRole('alert').textContent).toContain(words);
    expect(screen.getByRole('alert').textContent).toContain('Request ID: req_k');
    expect(screen.queryByText('No requests are waiting for you.')).toBeNull();
  });

  it.each(['approve', 'deny'] as const)(
    'a controller that throws on %s does not leave the buttons busy: an error shows and the buttons return',
    async (action) => {
      const user = userEvent.setup();
      renderHost({
        approvals: queueRows(1),
        detailFor: loaded(),
        overrides: {
          [action]: () => Promise.reject(new Error('boom')),
        },
      });
      await openFirstRow(user);
      await user.click(
        screen.getByRole('button', { name: action === 'approve' ? 'Approve' : 'Deny' })
      );
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(
        'The service is temporarily unavailable. Try again in a moment.'
      );
      expect(screen.queryByText('Sending your decision…')).toBeNull();
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(
        false
      );
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Deny' }).disabled).toBe(false);
    }
  );

  it('a failed decision that is a session expiry offers Sign in again', async () => {
    const user = userEvent.setup();
    let signedIn = 0;
    renderHost({
      approvals: queueRows(1),
      detailFor: loaded(),
      props: {
        onSignIn: () => {
          signedIn += 1;
        },
      },
      overrides: {
        approve: () =>
          Promise.resolve({
            ok: false,
            error: { kind: 'unauthorized', code: 'unauthorized', title: 't' },
          }),
      },
    });
    await openFirstRow(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    expect(signedIn).toBe(1);
  });

  it('has no axe violations with an error shown', async () => {
    const user = userEvent.setup();
    const host = renderHost({
      approvals: queueRows(1),
      detailFor: loaded(),
      overrides: {
        approve: () =>
          Promise.resolve({
            ok: false,
            error: { kind: 'unauthorized', code: 'unauthorized', title: 't', requestId: 'r' },
          }),
      },
    });
    await openFirstRow(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('alert');
    expect((await axe(host.container)).violations).toEqual([]);
  });
});

describe('T27: not eligible, and a 503', () => {
  it('403 not_eligible shows the text that a role change can take up to a minute', async () => {
    const user = userEvent.setup();
    renderHost({
      approvals: queueRows(1),
      detailFor: loaded(),
      overrides: {
        approve: () =>
          Promise.resolve({
            ok: false,
            error: {
              kind: 'forbidden',
              code: 'not_eligible',
              status: 403,
              title: 'Forbidden',
              requestId: 'req_e',
            },
          }),
      },
    });
    await openFirstRow(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('You are not eligible to decide this request.');
    expect(alert.textContent).toContain('this can take up to a minute to take effect');
  });

  it('503 is temporarily unavailable and trying again, never not eligible, never an empty-looking queue', () => {
    renderController(
      fakeController({
        status: 'error',
        error: {
          kind: 'unavailable',
          code: 'unavailable',
          status: 503,
          title: 'Service Unavailable',
        },
      })
    );
    const text = document.body.textContent;
    expect(text).toContain('temporarily unavailable');
    expect(text).toContain('Trying again');
    expect(text).not.toMatch(/not eligible|ineligible/i);
    expect(text).not.toContain('No requests are waiting for you.');
  });
});

describe('T39', () => {
  // The rev 5 `member` reads an approval digest-only (200) and is refused on resolve (403 not_eligible):
  // proved against the mock in approvals-store.rev5.test.ts. Here: what the component shows for it.
  it('a loaded digest-only detail shows the not-shown wording, Approve is offered, and its not_eligible answer renders as such', async () => {
    const user = userEvent.setup();
    const host = renderHost({
      approvals: queueRows(1),
      detailFor: loaded(),
      overrides: {
        approve: () =>
          Promise.resolve({
            ok: false,
            error: {
              kind: 'forbidden',
              code: 'not_eligible',
              status: 403,
              title: 'Forbidden',
              requestId: 'req_m',
            },
          }),
      },
    });
    await openFirstRow(user);
    expect(document.body.textContent).toContain('The arguments of this call are not shown to you.');
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    await user.click(approve);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('You are not eligible to decide this request.');
    expect(host.calls.filter((c) => c.method === 'approve')).toEqual([
      { method: 'approve', args: ['apr_1'] },
    ]);
  });
});

describe('the ruling on the approve call', () => {
  it('a blank reason is not sent', async () => {
    const user = userEvent.setup();
    const host = renderHost({ approvals: queueRows(1), detailFor: loaded() });
    await openFirstRow(user);
    await user.type(screen.getByRole('textbox', { name: 'Reason (optional)' }), 'x');
    await user.clear(screen.getByRole('textbox', { name: 'Reason (optional)' }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(host.calls.filter((call) => call.method === 'approve')).toEqual([
        { method: 'approve', args: ['apr_1'] },
      ]);
    });
  });
});

describe('adv-6: a whitespace-only reason', () => {
  it('is not sent', async () => {
    const user = userEvent.setup();
    const host = renderHost({ approvals: queueRows(1), detailFor: loaded() });
    await openFirstRow(user);
    await user.type(screen.getByRole('textbox', { name: 'Reason (optional)' }), '   ');
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => {
      expect(host.calls.filter((call) => call.method === 'deny')).toEqual([
        { method: 'deny', args: ['apr_1'] },
      ]);
    });
  });
});

describe('adv-1: the detail turns resolved while a decision is in flight', () => {
  it('still announces the result, closes the detail and does not leave the decision unreported', async () => {
    const user = userEvent.setup();
    const states = detailStates('apr_1');
    let release: (result: ResolveResult) => void = () => undefined;
    const pending = new Promise<ResolveResult>((resolve) => {
      release = resolve;
    });
    const closed: string[] = [];
    const build = (detail: ApprovalDetailState) =>
      fakeController({
        approvals: queueRows(1),
        detail,
        approve: () => pending,
        closeDetail: () => {
          closed.push('closeDetail');
        },
      });
    const view = renderController(build(states.loaded));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    // A stream event for the open id makes the detail resolved; Actions unmounts.
    view.rerender(<Approvals controller={build(states.resolved)} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    release({ ok: true, approval: approvalSummary({ id: 'apr_1', state: 'approved' }) });
    expect(await screen.findByText('Approved. The request has left your queue.')).toBeDefined();
    expect(closed).toEqual(['closeDetail']);
  });
});

describe('c1-14 a failed decision may already have been decided', () => {
  it.each(['network', 'unavailable', 'malformed_response'] as const)(
    'a %s failure tells the person to check the queue',
    async (kind) => {
      const user = userEvent.setup();
      renderHost({
        approvals: queueRows(1),
        detailFor: loaded(),
        overrides: {
          approve: () => Promise.resolve({ ok: false, error: { kind, code: kind, title: 't' } }),
        },
      });
      await openFirstRow(user);
      await user.click(screen.getByRole('button', { name: 'Approve' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('may already have been decided: check the queue');
    }
  );

  it.each([
    ['a failed fetch (local: no response came back)', 'network', 'network', true, true],
    ['a token that could not be had', 'network', 'token_unavailable', true, false],
    ['an exception before the request left', 'network', 'client_error', true, false],
    ['a decision the controller threw on', 'unavailable', 'controller_threw', true, false],
  ] as const)(
    'c2-8 %s: says check the queue only if it may have been sent',
    async (_name, kind, code, local, says) => {
      const user = userEvent.setup();
      renderHost({
        approvals: queueRows(1),
        detailFor: loaded(),
        overrides: {
          approve: () => Promise.resolve({ ok: false, error: { kind, code, local, title: 't' } }),
        },
      });
      await openFirstRow(user);
      await user.click(screen.getByRole('button', { name: 'Approve' }));
      const text = (await screen.findByRole('alert')).textContent;
      if (says) expect(text).toContain('check the queue');
      else expect(text).not.toContain('check the queue');
      if (code === 'token_unavailable') {
        expect(text).toContain('Could not get a token for this request; it was not sent.');
      }
    }
  );

  it('a refusal that is clear does not say it', async () => {
    const user = userEvent.setup();
    renderHost({
      approvals: queueRows(1),
      detailFor: loaded(),
      overrides: {
        approve: () =>
          Promise.resolve({
            ok: false,
            error: { kind: 'forbidden', code: 'forbidden', title: 't' },
          }),
      },
    });
    await openFirstRow(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).not.toContain('check the queue');
  });

  it('an onResolved that throws is reported, and the component survives', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    const fault = new Error('host closeDetail failed');
    const user = userEvent.setup();
    renderController(
      fakeController({
        approvals: queueRows(1),
        detail: detailStates('apr_1').loaded,
        closeDetail: () => {
          throw fault;
        },
      })
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    try {
      await vi.waitFor(() => {
        expect(reported).toEqual([fault]);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
