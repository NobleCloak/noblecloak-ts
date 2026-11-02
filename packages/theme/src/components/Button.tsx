import type { ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button, marks it busy and shows a spinner before its content. */
  loading?: boolean;
}

/**
 * A native `<button>`. `type` defaults to "button", not the browser's "submit", so a module button inside a
 * host's form never submits it.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn('nc-ui', 'nc-btn', className)}
      data-variant={variant}
      data-size={size}
      disabled={disabled === true || loading}
      aria-busy={loading ? true : undefined}
      {...props}
    >
      {loading ? <span className="nc-ui nc-spinner" data-size="sm" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
