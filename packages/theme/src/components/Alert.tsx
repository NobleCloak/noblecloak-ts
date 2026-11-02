import type { ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';

export type AlertVariant = 'neutral' | 'danger' | 'success' | 'warning';

export interface AlertProps extends ComponentPropsWithRef<'div'> {
  variant?: AlertVariant;
  /** Fills a danger alert with the danger colour (text in --nc-danger-fg). */
  solid?: boolean;
}

/**
 * A bordered message block, the shape of the module's `role="alert"` error. Danger and warning alerts are
 * `alert` (assertive); neutral and success are `status` (polite). Pass `role` to override.
 */
export function Alert({ variant = 'neutral', solid = false, className, ...props }: AlertProps) {
  return (
    <div
      role={variant === 'danger' || variant === 'warning' ? 'alert' : 'status'}
      className={cn('nc-ui', 'nc-alert', className)}
      data-variant={variant}
      data-solid={solid ? 'true' : undefined}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: ComponentPropsWithRef<'p'>) {
  return <p className={cn('nc-ui', 'nc-alert-title', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('nc-ui', 'nc-alert-description', className)} {...props} />;
}
