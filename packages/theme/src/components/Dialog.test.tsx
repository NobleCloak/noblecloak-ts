// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog.js';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './Dialog.js';

afterEach(cleanup);

/** What the browser does when it closes a dialog by itself (jsdom has no `close()`). */
const closeNatively = (dialog: HTMLDialogElement): void => {
  dialog.removeAttribute('open');
  dialog.dispatchEvent(new Event('close'));
};

const dialogElement = (): HTMLDialogElement => {
  const element = document.querySelector('dialog');
  if (element === null) throw new Error('no dialog');
  return element;
};

function Harness({
  description = true,
  onOpenChange,
}: {
  description?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="nc-root">
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange?.(next);
          setOpen(next);
        }}
      >
        <DialogHeader>
          <DialogTitle>Delete contact?</DialogTitle>
          {description ? <DialogDescription>This cannot be undone.</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
          >
            Close
          </button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

describe('Dialog (native <dialog>)', () => {
  it('opens and closes with the open prop, named and described by its title and description', async () => {
    render(<Harness />);
    const dialog = dialogElement();
    expect(dialog.open).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(dialog.open).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Delete contact?' })).toBe(dialog);
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('This cannot be undone.');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(dialog.open).toBe(false);
  });

  it('is a DOM descendant of the root it is rendered in (no portal)', () => {
    render(<Harness />);
    expect(dialogElement().closest('.nc-root')).not.toBeNull();
  });

  it('sets no aria-describedby without a description', async () => {
    render(<Harness description={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(dialogElement().getAttribute('aria-describedby')).toBeNull();
  });

  it('Escape (the cancel event) asks the owner to close instead of closing by itself', async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const cancel = new Event('cancel', { cancelable: true });
    act(() => {
      dialogElement().dispatchEvent(cancel);
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(dialogElement().open).toBe(false);
  });

  it('a close from inside (a method="dialog" form) is reported once; a close while already shut is not', async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    act(() => {
      dialogElement().dispatchEvent(new Event('close'));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    act(() => {
      dialogElement().dispatchEvent(new Event('close'));
    });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("a caller's onCancel runs, and Escape is still prevented and reported", () => {
    const onOpenChange = vi.fn();
    const onCancel = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} onCancel={onCancel}>
        <DialogTitle>T</DialogTitle>
      </Dialog>
    );
    const cancel = new Event('cancel', { cancelable: true });
    act(() => {
      dialogElement().dispatchEvent(cancel);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a caller's onCancel that calls preventDefault keeps the dialog open", () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog
        open
        onOpenChange={onOpenChange}
        onCancel={(event) => {
          event.preventDefault();
        }}
      >
        <DialogTitle>T</DialogTitle>
      </Dialog>
    );
    act(() => {
      dialogElement().dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialogElement().open).toBe(true);
  });

  it('a cancel the browser will not let be prevented is reported at once, before its close event', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog
        open
        onOpenChange={onOpenChange}
        onCancel={(event) => {
          event.preventDefault();
        }}
      >
        <DialogTitle>T</DialogTitle>
      </Dialog>
    );
    // Chromium's forced close: a cancel that cannot be prevented; its close event comes in a later task.
    act(() => {
      dialogElement().dispatchEvent(new Event('cancel', { cancelable: false }));
    });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a forced close the parent ignores is reported once, and the dialog is shown again', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogTitle>T</DialogTitle>
      </Dialog>
    );
    act(() => {
      dialogElement().dispatchEvent(new Event('cancel', { cancelable: false }));
    });
    act(() => {
      closeNatively(dialogElement());
    });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(dialogElement().open).toBe(true);
  });

  it("a caller's onClose runs, and the close is still reported", () => {
    const onOpenChange = vi.fn();
    const onClose = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} onClose={onClose}>
        <DialogTitle>T</DialogTitle>
      </Dialog>
    );
    act(() => {
      dialogElement().dispatchEvent(new Event('close'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a native close the parent ignores shows the dialog again, so it matches open', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogTitle>T</DialogTitle>
      </Dialog>
    );
    expect(dialogElement().open).toBe(true);
    act(() => {
      closeNatively(dialogElement());
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(dialogElement().open).toBe(true);
  });

  it("a caller's aria-labelledby replaces the title wiring", () => {
    render(
      <>
        <span id="outside">Outside name</span>
        <Dialog open onOpenChange={vi.fn()} aria-labelledby="outside">
          <DialogTitle>T</DialogTitle>
        </Dialog>
      </>
    );
    expect(dialogElement().getAttribute('aria-labelledby')).toBe('outside');
  });

  it('falls back to the open attribute where showModal and close are missing', () => {
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    const saved = { showModal: proto.showModal, close: proto.close };
    proto.showModal = undefined;
    proto.close = undefined;
    try {
      const { rerender } = render(
        <Dialog open onOpenChange={vi.fn()}>
          <DialogTitle>T</DialogTitle>
        </Dialog>
      );
      expect(dialogElement().hasAttribute('open')).toBe(true);
      rerender(
        <Dialog open={false} onOpenChange={vi.fn()}>
          <DialogTitle>T</DialogTitle>
        </Dialog>
      );
      expect(dialogElement().hasAttribute('open')).toBe(false);
    } finally {
      proto.showModal = saved.showModal;
      proto.close = saved.close;
    }
  });

  it('outside the theme Dialog its parts render plainly, with no generated id', () => {
    render(
      <>
        <DialogTitle>T</DialogTitle>
        <DialogDescription id="own">D</DialogDescription>
      </>
    );
    expect(screen.getByRole('heading', { name: 'T' }).id).toBe('');
    expect(screen.getByText('D').id).toBe('own');
  });

  it("inside the theme Dialog, a part's own id does not break the aria wiring", () => {
    render(
      <Dialog open onOpenChange={vi.fn()}>
        <DialogTitle id="mine">T</DialogTitle>
      </Dialog>
    );
    const labelledBy = dialogElement().getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(labelledBy)?.textContent).toBe('T');
  });
});

describe('ConfirmDialog', () => {
  function Confirm(
    props: Partial<Parameters<typeof ConfirmDialog>[0]> & { onConfirm: () => void | Promise<void> }
  ) {
    const [open, setOpen] = useState(true);
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Approve the refund?"
        description="The agent continues at once."
        {...props}
      />
    );
  }

  it('confirms, then closes', async () => {
    const onConfirm = vi.fn();
    render(<Confirm onConfirm={onConfirm} />);
    expect(screen.getByRole('dialog', { name: 'Approve the refund?' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(dialogElement().open).toBe(false);
    });
  });

  it('Cancel closes without confirming', async () => {
    const onConfirm = vi.fn();
    render(<Confirm onConfirm={onConfirm} cancelLabel="Keep" />);
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialogElement().open).toBe(false);
  });

  it('a throwing confirm stays open, shows the message as an alert and reports it', async () => {
    const onError = vi.fn();
    render(
      <Confirm
        onConfirm={() => Promise.reject(new Error('The approval was already decided.'))}
        onError={onError}
        variant="destructive"
        confirmLabel="Deny"
      />
    );
    const deny = screen.getByRole('button', { name: 'Deny' });
    expect(deny.dataset.variant).toBe('destructive');
    await userEvent.click(deny);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The approval was already decided.'
    );
    expect(onError).toHaveBeenCalledWith(new Error('The approval was already decided.'));
    expect(dialogElement().open).toBe(true);
  });

  it('a thrown non-Error becomes a generic message', async () => {
    render(
      <Confirm
        onConfirm={() => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
          throw 'nope';
        }}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Confirmation failed');
  });

  it('while busy, both buttons are disabled and confirm shows a spinner', () => {
    render(<Confirm onConfirm={vi.fn()} loading />);
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm' });
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true);
  });

  it('Escape while a confirm is pending is ignored; the dialog closes when the confirm resolves', async () => {
    let finish: () => void = () => undefined;
    const onOpenChange = vi.fn();
    function Pending() {
      const [open, setOpen] = useState(true);
      return (
        <ConfirmDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          title="T"
          onConfirm={() =>
            new Promise<void>((resolve) => {
              finish = resolve;
            })
          }
        />
      );
    }
    render(<Pending />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Confirm' }).getAttribute('aria-busy')).toBe(
        'true'
      );
    });
    const cancel = new Event('cancel', { cancelable: true });
    act(() => {
      dialogElement().dispatchEvent(cancel);
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialogElement().open).toBe(true);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(dialogElement().open).toBe(false);
    });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it('a close the browser forces while a confirm is pending closes it; the late result reaches onError only', async () => {
    let fail: (error: Error) => void = () => undefined;
    const onError = vi.fn();
    function Pending() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Again
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="T"
            onError={onError}
            onConfirm={() =>
              new Promise<void>((_resolve, reject) => {
                fail = reject;
              })
            }
          />
        </>
      );
    }
    render(<Pending />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Confirm' }).getAttribute('aria-busy')).toBe(
        'true'
      );
    });
    // Chromium's third Escape: a cancel that cannot be prevented, then the dialog closes.
    act(() => {
      dialogElement().dispatchEvent(new Event('cancel', { cancelable: false }));
      closeNatively(dialogElement());
    });
    await waitFor(() => {
      expect(dialogElement().open).toBe(false);
    });
    await act(async () => {
      fail(new Error('server said no'));
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledWith(new Error('server said no'));
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Again' }));
    await waitFor(() => {
      expect(dialogElement().open).toBe(true);
    });
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm' });
    expect(confirm.getAttribute('aria-busy')).not.toBe('true');
  });

  it('a confirm that fails after a forced close, before its close event arrives, reaches onError only', async () => {
    let fail: (error: Error) => void = () => undefined;
    const onError = vi.fn();
    function Pending() {
      const [open, setOpen] = useState(true);
      return (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="T"
          onError={onError}
          onConfirm={() =>
            new Promise<void>((_resolve, reject) => {
              fail = reject;
            })
          }
        />
      );
    }
    render(<Pending />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Confirm' }).getAttribute('aria-busy')).toBe(
        'true'
      );
    });
    // Chromium's third Escape: a cancel that cannot be prevented, and the dialog is closed. Its close event is
    // queued as a later task, so the confirm can fail first; it is not dispatched here.
    act(() => {
      dialogElement().dispatchEvent(new Event('cancel', { cancelable: false }));
      dialogElement().removeAttribute('open');
    });
    await act(async () => {
      fail(new Error('server said no'));
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledWith(new Error('server said no'));
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull();
  });

  it('Escape while busy from outside (loading) is ignored too', () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={onOpenChange} title="T" onConfirm={vi.fn()} loading />
    );
    act(() => {
      dialogElement().dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('an error clears when the dialog opens again', async () => {
    function Reopen() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Again
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="T"
            onConfirm={() => Promise.reject(new Error('Failed'))}
          />
        </>
      );
    }
    render(<Reopen />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Again', hidden: true }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
