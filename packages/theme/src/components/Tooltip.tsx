import { cloneElement, isValidElement, useEffect, useId, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { cn } from '../cn.js';

export interface TooltipProps {
  /** The tip's text. Keep it short; it is a description, not a label. */
  content: ReactNode;
  /** The one focusable element the tip describes; it gets `aria-describedby`. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  className?: string;
}

/**
 * A tip shown while its trigger is hovered or focused. For WCAG 1.4.13 (content on hover or focus) it is
 * dismissable (Escape anywhere on the page while it is open, without moving the pointer or focus), hoverable
 * (the tip is inside the hover region, and a transparent bridge spans the gap above the trigger) and persistent
 * (it stays until hover and focus leave or Escape). It is rendered beside the trigger inside the same
 * `.nc-root`, not in a portal, so it inherits the tokens. It always opens above the trigger: there is no
 * viewport collision handling, so near the top edge the tip can be cut off.
 */
export function Tooltip({ content, children, className }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const show = () => {
    setOpen(true);
  };
  const hide = () => {
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  const trigger = isValidElement(children)
    ? cloneElement(children, {
        'aria-describedby': cn(children.props['aria-describedby'], id),
      })
    : children;
  return (
    <span
      className={cn('nc-ui', 'nc-tooltip-anchor', className)}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {trigger}
      <span id={id} role="tooltip" className="nc-ui nc-tooltip" hidden={!open}>
        {content}
      </span>
    </span>
  );
}
