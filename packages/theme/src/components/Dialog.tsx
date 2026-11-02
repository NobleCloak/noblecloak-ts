import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';
import { mergeRefs } from '../merge-refs.js';

interface DialogContextValue {
  readonly titleId: string;
  readonly descriptionId: string;
  readonly setHasDescription: (has: boolean) => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export interface DialogProps extends Omit<ComponentPropsWithRef<'dialog'>, 'open'> {
  /** Controlled: true opens the dialog as a modal. */
  open: boolean;
  /** Called with false when the user dismisses the dialog (Escape) or a form inside closes it. */
  onOpenChange: (open: boolean) => void;
  /**
   * Runs on Escape (the `cancel` event) before the dialog asks to close; call `event.preventDefault()` to keep
   * it open. A cancel the browser marks not cancelable closes the dialog regardless: `onOpenChange(false)` is
   * reported from that cancel, before the close event the browser dispatches in a later task.
   */
  onCancel?: ComponentPropsWithRef<'dialog'>['onCancel'];
  /**
   * Runs when the native dialog closes, before `onOpenChange(false)` is reported (a close that follows a cancel
   * that could not be prevented was reported from that cancel, and is not reported again). The browser can close
   * it on its own: Chromium fires a cancel that cannot be prevented after repeated Escapes. If the parent keeps
   * `open` true after that report, the dialog is shown again, so it always matches `open`.
   */
  onClose?: ComponentPropsWithRef<'dialog'>['onClose'];
}

/**
 * A modal on the native `<dialog>`, opened with `showModal()`. The element stays a DOM descendant of the
 * `.nc-root` it is rendered in (the browser draws it in the top layer), so it inherits the `--nc-*` tokens
 * and needs no portal. Focus moves into it on open, is held there, and returns on close (the browser does
 * this for a modal dialog). Name it with a `DialogTitle`.
 */
export function Dialog({
  open,
  onOpenChange,
  onCancel,
  onClose,
  className,
  children,
  ref,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  ...props
}: DialogProps) {
  const own = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [hasDescription, setHasDescription] = useState(false);
  // Bumped when the native dialog closes while `open` is still true, so the effect below re-syncs with `open`.
  const [nativeCloses, setNativeCloses] = useState(0);
  // True from a cancel that could not be prevented (reported then) until the close event that follows it.
  const forcedCloseReported = useRef(false);

  useEffect(() => {
    const dialog = own.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      forcedCloseReported.current = false;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open, nativeCloses]);

  const dismiss = useCallback(() => {
    if (open) onOpenChange(false);
  }, [open, onOpenChange]);

  const context = useMemo(
    () => ({ titleId, descriptionId, setHasDescription }),
    [titleId, descriptionId]
  );
  return (
    <DialogContext.Provider value={context}>
      <dialog
        {...props}
        ref={mergeRefs(own, ref)}
        className={cn('nc-ui', 'nc-dialog', className)}
        aria-labelledby={ariaLabelledBy ?? titleId}
        aria-describedby={ariaDescribedBy ?? (hasDescription ? descriptionId : undefined)}
        onCancel={(event) => {
          onCancel?.(event);
          // React's event reports `defaultPrevented` after `preventDefault()` even when the native cancel is not
          // cancelable, and the browser then closes the dialog whatever the handler did.
          const keepOpen = event.cancelable && event.defaultPrevented;
          // Escape: the parent owns `open`, so the browser does not close the dialog by itself.
          event.preventDefault();
          if (keepOpen) return;
          // Reported now, not on the close event: the browser has closed the dialog by the time that event's task
          // runs, and anything settling in between (a pending confirm) must already see `open` false.
          if (!event.cancelable && open) forcedCloseReported.current = true;
          dismiss();
        }}
        onClose={(event) => {
          onClose?.(event);
          const reported = forcedCloseReported.current;
          forcedCloseReported.current = false;
          if (!open) return;
          // The browser closed it (a form with method="dialog", or a cancel it would not let us prevent).
          if (!reported) onOpenChange(false);
          setNativeCloses((count) => count + 1);
        }}
      >
        {children}
      </dialog>
    </DialogContext.Provider>
  );
}

export function DialogHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('nc-ui', 'nc-dialog-header', className)} {...props} />;
}

/**
 * The dialog's accessible name: inside the theme's `Dialog` it gets the id that `aria-labelledby` points at.
 * Inside a replacement `Dialog` (an `NcComponents` slot) there is no such wiring, so it renders as a plain
 * heading and the replacement names itself (ConfirmDialog passes it `aria-label`).
 */
export function DialogTitle({ className, id, ...props }: ComponentPropsWithRef<'h2'>) {
  const context = useContext(DialogContext);
  return (
    <h2
      id={context?.titleId ?? id}
      className={cn('nc-ui', 'nc-dialog-title', className)}
      {...props}
    />
  );
}

/**
 * The dialog's description: inside the theme's `Dialog`, `aria-describedby` points at it while it is rendered.
 * Inside a replacement `Dialog` it renders as a plain paragraph.
 */
export function DialogDescription({ className, id, ...props }: ComponentPropsWithRef<'p'>) {
  const context = useContext(DialogContext);
  const setHasDescription = context?.setHasDescription;
  useLayoutEffect(() => {
    if (setHasDescription === undefined) return undefined;
    setHasDescription(true);
    return () => {
      setHasDescription(false);
    };
  }, [setHasDescription]);
  return (
    <p
      id={context?.descriptionId ?? id}
      className={cn('nc-ui', 'nc-dialog-description', className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('nc-ui', 'nc-dialog-footer', className)} {...props} />;
}
