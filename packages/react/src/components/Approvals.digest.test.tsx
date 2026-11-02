// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { Approvals } from './Approvals.js';
import { queueRows } from '../testing/component-harness.js';
import { detailStates, fakeController } from '../testing/fake-controller.js';
import type { FakeController } from '../testing/fake-controller.js';

afterEach(cleanup);

const DIGEST_B = 'b7e2'.repeat(16);

function loadedWith(
  digest: string | undefined,
  level: 'write' | 'delete' = 'write'
): FakeController {
  const states = detailStates('apr_1', {
    approval: {
      side_effect_level: level,
      ...(digest === undefined ? {} : { action_digest: digest }),
    },
  });
  return fakeController({ approvals: queueRows(1), detail: states.loaded });
}

const approve = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' });

describe('c1-4 a digest that changes under the person is announced', () => {
  it('shows the changed-request copy, keeps Approve off until acknowledged, then decides', async () => {
    const user = userEvent.setup();
    const first = loadedWith(undefined);
    const view = render(<Approvals controller={first} />);
    expect(approve().disabled).toBe(false);
    expect(screen.queryByText(/changed while you were looking/)).toBeNull();

    const second = loadedWith(DIGEST_B);
    view.rerender(<Approvals controller={second} />);
    expect(screen.getByText(/changed while you were looking/)).toBeDefined();
    expect(approve().disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Deny' }).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'I have read the changed request' }));
    expect(screen.queryByText(/changed while you were looking/)).toBeNull();
    expect(approve().disabled).toBe(false);
    await user.click(approve());
    expect(second.calls.map((c) => c.method)).toContain('approve');
  });

  it('keeps the reason typed before the change, and re-arms the confirm step', async () => {
    const user = userEvent.setup();
    const view = render(<Approvals controller={loadedWith(undefined, 'delete')} />);
    await user.type(screen.getByRole('textbox'), 'because');
    await user.click(approve());
    expect(screen.getByRole('button', { name: 'Confirm approval' })).toBeDefined();

    view.rerender(<Approvals controller={loadedWith(DIGEST_B, 'delete')} />);
    expect(screen.queryByRole('button', { name: 'Confirm approval' })).toBeNull();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('because');

    await user.click(screen.getByRole('button', { name: 'I have read the changed request' }));
    await user.click(approve());
    expect(screen.getByRole('button', { name: 'Confirm approval' })).toBeDefined();
  });
});
