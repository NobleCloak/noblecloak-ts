import type { ComponentPropsWithRef } from 'react';

import { VisuallyHidden } from '../a11y/VisuallyHidden.js';
import { cn } from '../cn.js';

export interface SpinnerProps extends ComponentPropsWithRef<'span'> {
  size?: 'sm' | 'md' | 'lg';
  /** What a screen reader hears ('Loading'). */
  label?: string;
}

/** A busy indicator: a `status` region with a visually hidden label. The ring itself is CSS, not an icon. */
export function Spinner({ size = 'md', label = 'Loading', className, ...props }: SpinnerProps) {
  return (
    <span
      role="status"
      className={cn('nc-ui', 'nc-spinner', className)}
      data-size={size}
      {...props}
    >
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
}
