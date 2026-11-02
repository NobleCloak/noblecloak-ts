// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { ApprovalDetailState, ApprovalSummary, JsonObject } from '../approvals-types.js';
import { MARKER, queueRows, renderController, renderHost } from '../testing/component-harness.js';
import { axe } from '../testing/axe.js';
import { approvalSummary, detailStates, fakeController } from '../testing/fake-controller.js';

afterEach(cleanup);

/** The "tool that shows its arguments" of the brief: a loaded detail that holds them. */
function toolShowingArguments(args: JsonObject, id = 'apr_1'): ApprovalDetailState {
  return detailStates(id, { arguments: args }).loaded;
}

/** The "tool that does not show them": a loaded detail without. */
function toolHidingArguments(id = 'apr_1'): ApprovalDetailState {
  return detailStates(id).loaded;
}

function pre(): HTMLElement {
  const node = document.querySelector('pre');
  if (node === null) throw new Error('no <pre> rendered');
  return node;
}

describe('T17: detail rendering of arguments', () => {
  it('a tool that shows arguments gets the full-call wording and the arguments', () => {
    renderController(
      fakeController({
        approvals: queueRows(1),
        detail: toolShowingArguments({ amount: 12, currency: 'USD' }),
      })
    );
    expect(
      screen.getByRole('heading', { name: 'The full call, as returned for this request' })
    ).toBeDefined();
    expect(pre().textContent).toBe('{\n  "amount": 12,\n  "currency": "USD"\n}');
  });

  it('a tool that does not gets the digest-only wording and no arguments', () => {
    renderController(fakeController({ approvals: queueRows(1), detail: toolHidingArguments() }));
    expect(screen.getByText(/The arguments of this call are not shown to you\./)).toBeDefined();
    expect(document.querySelector('pre')).toBeNull();
  });

  it('renders <img onerror>, markdown, links and HTML as inert text', () => {
    const args = {
      html: '<img src=x onerror="window.__pwned = true">',
      script: '<script>window.__pwned = true</script>',
      md: '# heading\n[link](https://example.test) **bold**',
      url: 'https://example.test/path',
    };
    renderController(
      fakeController({ approvals: queueRows(1), detail: toolShowingArguments(args) })
    );
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    expect(pre().children).toHaveLength(0);
    expect(pre().textContent).toContain('<img src=x onerror=\\"window.__pwned = true\\">');
    expect(pre().textContent).toContain('[link](https://example.test) **bold**');
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('cuts a 10 000 character string, says how much is cut, and Show all raises the cut', async () => {
    const user = userEvent.setup();
    renderController(
      fakeController({
        approvals: queueRows(1),
        detail: toolShowingArguments({ s: 'x'.repeat(10_000) }),
      })
    );
    expect(pre().textContent).toHaveLength(4000);
    const more = screen.getByText(/more characters/);
    expect(more.textContent).toMatch(/^\d+ more characters/);
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(pre().textContent.length).toBeGreaterThan(10_000);
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    expect(screen.queryByText(/characters not shown/)).toBeNull();
  });

  it('Show all renders a 150 000 character string whole, with no ceiling at 100 000', async () => {
    const user = userEvent.setup();
    renderController(
      fakeController({
        approvals: queueRows(1),
        detail: toolShowingArguments({ s: 'x'.repeat(150_000) }),
      })
    );
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(pre().textContent.length).toBeGreaterThan(150_000);
    expect(screen.queryByText(/not shown/)).toBeNull();
  });

  it('shows depth 12 as a count beyond depth 8', () => {
    let nested: JsonObject = { deepest: MARKER };
    for (let level = 0; level < 12; level += 1) nested = { next: nested };
    renderController(
      fakeController({ approvals: queueRows(1), detail: toolShowingArguments(nested) })
    );
    expect(pre().textContent).toContain('{… 1 members}');
    expect(pre().textContent).not.toContain(MARKER);
  });

  it('shows bidirectional and zero-width characters as escapes', () => {
    renderController(
      fakeController({
        approvals: queueRows(1),
        detail: toolShowingArguments({ s: 'pay\u202Eevil\u200Bdone\u2066' }),
      })
    );
    const text = pre().textContent;
    expect(text).toContain('pay\\u202Eevil\\u200Bdone\\u2066');
    expect(text).not.toMatch(/[\u202E\u200B\u2066]/);
  });

  it('an unknown extra member changes nothing', () => {
    const plain = detailStates('apr_1', { arguments: { a: 1 } }).loaded;
    const { container, unmount } = renderController(
      fakeController({ approvals: queueRows(1), detail: plain })
    );
    // `useId` ids differ from one render to the next; the rest of the markup must be identical.
    const markup = (html: string): string => html.replace(/_r_\w+_/g, 'id');
    const before = markup(container.innerHTML);
    unmount();
    const extra = {
      ...plain,
      approval: {
        ...plain.approval,
        rev5_only_member: { note: MARKER },
        continuation: { note: MARKER },
        outcome_record_id: MARKER,
      },
    } as unknown as ApprovalDetailState;
    const again = renderController(fakeController({ approvals: queueRows(1), detail: extra }));
    expect(markup(again.container.innerHTML)).toBe(before);
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('renders an approval whose policy is absent', () => {
    const summary = approvalSummary({ id: 'apr_1' });
    delete summary.policy;
    renderController(
      fakeController({
        approvals: [summary],
        detail: { id: 'apr_1', status: 'loaded', approval: summary },
      })
    );
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('ext:billing:issue_refund');
    expect(screen.queryByText('Policy')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined();
  });

  it('shows the policy when it is present', () => {
    renderController(fakeController({ approvals: queueRows(1), detail: toolHidingArguments() }));
    expect(screen.getByText('Policy').nextElementSibling?.textContent).toBe(
      'policy_default (Version 1)'
    );
  });

  it.each(['consumed', 'rejected', 'expired', 'withdrawn'] as const)(
    'a resolved detail of a final state (%s) is digest-only and says so in words',
    (state) => {
      // The harness builds `resolved` with state `approved`; the state under test is set here.
      const base = detailStates('apr_1').resolved;
      if (!('approval' in base)) throw new Error('resolved detail has no approval');
      const detail = { ...base, approval: { ...base.approval, state, resolution: state } };
      renderController(fakeController({ approvals: queueRows(1), detail }));
      expect(screen.getByText(/The arguments of this call are not shown\./)).toBeDefined();
      expect(document.querySelector('pre')).toBeNull();
    }
  );

  it('a resolved approved detail without arguments does not claim digest-only', () => {
    const detail = detailStates('apr_1').resolved;
    renderController(fakeController({ approvals: queueRows(1), detail }));
    expect(screen.getByText(/No arguments were returned for this request\./)).toBeDefined();
    expect(screen.queryByText(/are not shown/)).toBeNull();
    expect(document.querySelector('pre')).toBeNull();
  });

  it('a resolved approved detail that still holds arguments shows them', () => {
    const detail = detailStates('apr_1', { arguments: { a: 1 } }).resolved;
    renderController(fakeController({ approvals: queueRows(1), detail }));
    expect(pre().textContent).toContain('"a": 1');
  });

  it('has no axe violations with a long, hostile call open', async () => {
    const { container } = renderController(
      fakeController({
        approvals: queueRows(1),
        detail: toolShowingArguments({ s: 'x'.repeat(10_000), h: '<img onerror=x>' }),
      })
    );
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('T33: no arguments remain in the DOM once the detail is gone', () => {
  const marked = (id: string): ApprovalDetailState => toolShowingArguments({ note: MARKER }, id);

  it('while the detail is open the marker is shown (so the other checks mean something)', () => {
    renderController(fakeController({ approvals: queueRows(1), detail: marked('apr_1') }));
    expect(document.body.textContent).toContain(MARKER);
  });

  it('after the detail closes', async () => {
    const user = userEvent.setup();
    renderHost({ approvals: queueRows(1), detailFor: marked });
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
    expect(document.body.textContent).toContain(MARKER);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('after a different row is opened', async () => {
    const user = userEvent.setup();
    renderHost({
      approvals: queueRows(2),
      detailFor: (id) => (id === 'apr_1' ? marked(id) : toolHidingArguments(id)),
    });
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_2/ }));
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('after a successful resolve, even when the controller still holds the detail', async () => {
    const user = userEvent.setup();
    const host = renderHost({ approvals: queueRows(1), detailFor: marked });
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
    expect(document.body.textContent).toContain(MARKER);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(host.calls.map((call) => call.method)).toEqual(['openDetail', 'approve', 'closeDetail']);
    expect(document.body.textContent).toContain('Approved. The request has left your queue.');
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('after a successful resolve, when the controller keeps holding the detail', async () => {
    const user = userEvent.setup();
    renderController(fakeController({ approvals: queueRows(1), detail: marked('apr_1') }));
    expect(document.body.textContent).toContain(MARKER);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved. The request has left your queue.');
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('after the component unmounts', () => {
    const { unmount } = renderController(
      fakeController({ approvals: queueRows(1), detail: marked('apr_1') })
    );
    unmount();
    expect(document.body.textContent).not.toContain(MARKER);
    expect(document.body.querySelector('.nc-root')).toBeNull();
  });

  it('the Show all state is not kept for the next detail', async () => {
    const user = userEvent.setup();
    renderHost({
      approvals: queueRows(2),
      detailFor: (id) => toolShowingArguments({ s: 'x'.repeat(10_000) }, id),
    });
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_2/ }));
    expect(pre().textContent).toHaveLength(4000);
  });
});

describe('T37: the DOM shows no arguments the controller did not return in the detail', () => {
  it('ignores arguments carried by a queue row', () => {
    const row = { ...approvalSummary(), arguments: { note: MARKER } } as unknown as ApprovalSummary;
    renderController(fakeController({ approvals: [row] }));
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('ignores arguments carried inside the detail approval rather than in the detail', () => {
    const approval = {
      ...approvalSummary(),
      arguments: { note: MARKER },
    } as unknown as ApprovalSummary;
    renderController(
      fakeController({
        approvals: [approval],
        detail: { id: 'apr_1', status: 'loaded', approval },
      })
    );
    expect(document.body.textContent).not.toContain(MARKER);
    expect(screen.getByText(/not shown to you/)).toBeDefined();
  });

  it('ignores arguments carried by the current approval of a conflict error', async () => {
    const user = userEvent.setup();
    const current = {
      ...approvalSummary(),
      state: 'approved',
      arguments: { note: MARKER },
    } as unknown as ApprovalSummary;
    renderHost({
      approvals: queueRows(1),
      detailFor: (id) => toolHidingArguments(id),
      overrides: {
        approve: () =>
          Promise.resolve({
            ok: false,
            error: { kind: 'conflict', code: 'already_resolved', title: 'Conflict', current },
          }),
      },
    });
    await user.click(screen.getByRole('button', { name: /ext:billing:tool_1/ }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Its state now: approved.')).toBeDefined();
    expect(document.body.textContent).not.toContain(MARKER);
  });
});

function approveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' });
}

function deepArguments(levels: number): JsonObject {
  let nested: JsonObject = { deepest: MARKER };
  for (let level = 1; level < levels; level += 1) nested = { next: nested };
  return nested;
}

describe('c1-3 nothing is omitted while Approve is enabled', () => {
  it('a 9-level-deep call disables Approve and Deny until Show all, which prints every level', async () => {
    const user = userEvent.setup();
    renderController(
      fakeController({ approvals: queueRows(1), detail: toolShowingArguments(deepArguments(9)) })
    );
    expect(pre().textContent).not.toContain(MARKER);
    expect(approveButton().disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Deny' }).disabled).toBe(true);
    expect(screen.getByText(/nested parts are shown only as counts/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(pre().textContent).toContain(MARKER);
    expect(approveButton().disabled).toBe(false);
  });

  it('an 8-level-deep call shows everything and Approve is enabled at once', () => {
    renderController(
      fakeController({ approvals: queueRows(1), detail: toolShowingArguments(deepArguments(8)) })
    );
    expect(pre().textContent).toContain(MARKER);
    expect(approveButton().disabled).toBe(false);
  });

  it('a call longer than 100 000 characters disables Approve until Show all, then shows all of it', async () => {
    const user = userEvent.setup();
    renderController(
      fakeController({
        approvals: queueRows(1),
        detail: toolShowingArguments({ s: 'x'.repeat(150_000), tail: MARKER }),
      })
    );
    expect(approveButton().disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(pre().textContent).toContain(MARKER);
    expect(approveButton().disabled).toBe(false);
  });

  it('a call over 2 MiB is too large to display: nothing is printed and the actions stay disabled', () => {
    renderController(
      fakeController({
        approvals: queueRows(1),
        detail: toolShowingArguments({ s: 'x'.repeat(2 * 1024 * 1024 + 1) }),
      })
    );
    expect(screen.getByText(/too large to display/)).toBeDefined();
    expect(document.querySelector('pre')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    expect(approveButton().disabled).toBe(true);
  });
});

describe('c2-3 a call that cannot be shown as sent keeps the actions off', () => {
  it('a key named twice is announced and Approve stays disabled', () => {
    const loaded = detailStates('apr_1', { arguments: { a: 2 } }).loaded;
    renderController(
      fakeController({
        approvals: queueRows(1),
        detail: { ...loaded, argumentsSource: '{"a":1,"a":2}' },
      })
    );
    expect(screen.getByText(/names the key "a" more than once/)).toBeDefined();
    expect(approveButton().disabled).toBe(true);
  });

  it('numbers this browser cannot show exactly are counted and Approve stays disabled', () => {
    // No source to read from: the parsed value is judged, and 2^64 is past what a double holds exactly.
    renderController(
      fakeController({
        approvals: queueRows(1),
        detail: toolShowingArguments({ n: 18446744073709551616 }),
      })
    );
    expect(screen.getByText(/1 numbers in this call cannot be shown exactly/)).toBeDefined();
    expect(approveButton().disabled).toBe(true);
  });
});
