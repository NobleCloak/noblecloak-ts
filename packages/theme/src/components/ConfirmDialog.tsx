import { useEffect, useRef, useState } from 'react';

import { useSlot } from '../slot-context.js';
import { Alert as DefaultAlert } from './Alert.js';
import { Button as DefaultButton } from './Button.js';
import {
  Dialog as DefaultDialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './Dialog.js';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'destructive' renders the confirm button in the danger colour. */
  variant?: 'default' | 'destructive';
  /**
   * Runs on confirm; the dialog closes when it resolves and shows the message when it throws. If the dialog was
   * closed (or opened again) while it ran, the result reaches only `onError`: nothing is closed or shown.
   */
  onConfirm: () => void | Promise<void>;
  /** Called with the error when `onConfirm` throws, whether or not the dialog is still showing that attempt. */
  onError?: (error: Error) => void;
  /**
   * Busy from outside (the confirm button shows a spinner, both buttons are disabled, Escape is prevented). A
   * close the browser forces (Chromium, after repeated Escapes) still closes the dialog.
   */
  loading?: boolean;
}

/**
 * A two-button confirmation on `Dialog`. Its dialog, buttons and error alert are the slots of the nearest
 * `NcComponentsProvider`, so replacing `Button` there replaces these buttons too. A replacement `Dialog` gets
 * `open`, `onOpenChange`, `aria-label` (the title), `onCancel` and the content as children; it renders them,
 * names itself from `aria-label`, and on Escape calls `onCancel` and keeps itself open if that prevented it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onError,
  loading = false,
}: ConfirmDialogProps) {
  const Dialog = useSlot('Dialog', DefaultDialog);
  const Button = useSlot('Button', DefaultButton);
  const Alert = useSlot('Alert', DefaultAlert);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Counts confirm attempts; opening or closing the dialog bumps it, so a confirm that settles late is stale.
  const attempt = useRef(0);

  useEffect(() => {
    attempt.current += 1;
    if (open) {
      setError(null);
      setConfirming(false);
    }
  }, [open]);

  const confirm = async () => {
    attempt.current += 1;
    const mine = attempt.current;
    setConfirming(true);
    setError(null);
    try {
      await onConfirm();
      if (mine === attempt.current) onOpenChange(false);
    } catch (caught) {
      const failure = caught instanceof Error ? caught : new Error('Confirmation failed');
      if (mine === attempt.current) setError(failure);
      onError?.(failure);
    } finally {
      if (mine === attempt.current) setConfirming(false);
    }
  };

  const busy = loading || confirming;
  return (
    <Dialog
      open={open}
      // The theme's Dialog is named by DialogTitle (aria-labelledby wins); a replacement Dialog gets the name here.
      aria-label={title}
      // While busy, Escape is prevented, as the disabled Cancel button is: the confirm settles first. A close the
      // browser forces is not preventable, so it is reported like any other.
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onOpenChange={onOpenChange}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description !== undefined ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      {error !== null ? <Alert variant="danger">{error.message}</Alert> : null}
      <DialogFooter>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {cancelLabel}
        </Button>
        <Button
          variant={variant === 'destructive' ? 'destructive' : 'primary'}
          loading={busy}
          onClick={() => {
            void confirm();
          }}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
