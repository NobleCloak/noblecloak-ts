import { useId } from 'react';
import type { ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';
import { Label } from './Label.js';

export interface InputProps extends ComponentPropsWithRef<'input'> {
  /** A visible label; with one, the input is wrapped in a field with the label above it. */
  label?: string;
  /** An error message: shown under the input, linked by `aria-describedby`, and marks it invalid. */
  error?: string;
  /** 'code' sets the monospace family (--nc-font-mono). */
  variant?: 'text' | 'code';
  wrapperClassName?: string;
}

/** A native `<input>`, optionally with its label and error message. */
export function Input({
  label,
  error,
  variant = 'text',
  wrapperClassName,
  className,
  id,
  'aria-describedby': describedBy,
  ...props
}: InputProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const errorId = `${inputId}-error`;
  const describedByIds = cn(describedBy, error !== undefined && errorId) || undefined;
  const input = (
    <input
      id={inputId}
      className={cn('nc-ui', 'nc-input', className)}
      data-variant={variant}
      aria-invalid={error !== undefined ? true : undefined}
      aria-describedby={describedByIds}
      {...props}
    />
  );
  if (label === undefined && error === undefined) return input;
  return (
    <div className={cn('nc-ui', 'nc-field', wrapperClassName)}>
      {label !== undefined ? <Label htmlFor={inputId}>{label}</Label> : null}
      {input}
      {error !== undefined ? (
        <span id={errorId} className="nc-ui nc-field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
