import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '../cn.js';
import { useSlot } from '../slot-context.js';
import { Button as DefaultButton } from './Button.js';

export interface PaginationLabels {
  /** The navigation landmark's name ('Pagination'). */
  readonly nav?: string;
  readonly previous?: string;
  readonly next?: string;
}

export interface PaginationProps extends ComponentPropsWithRef<'nav'> {
  /**
   * Cursor paging: whether there is a page on each side comes from the caller (a `next_cursor`, say).
   * Numbered pages are not modelled.
   */
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** Status text before the controls ("21–40"). */
  label?: ReactNode;
  labels?: PaginationLabels;
}

/** Previous and Next, as the `Button` slot of the nearest `NcComponentsProvider`. */
export function Pagination({
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  label,
  labels = {},
  className,
  ...props
}: PaginationProps) {
  const Button = useSlot('Button', DefaultButton);
  return (
    <nav
      aria-label={labels.nav ?? 'Pagination'}
      className={cn('nc-ui', 'nc-pagination', className)}
      {...props}
    >
      {label !== undefined ? <span className="nc-ui nc-pagination-label">{label}</span> : null}
      <Button variant="secondary" size="sm" disabled={!hasPrev} onClick={onPrev}>
        {labels.previous ?? 'Previous'}
      </Button>
      <Button variant="secondary" size="sm" disabled={!hasNext} onClick={onNext}>
        {labels.next ?? 'Next'}
      </Button>
    </nav>
  );
}
