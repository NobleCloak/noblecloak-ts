import type { ChangeEvent, ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps extends ComponentPropsWithRef<'select'> {
  /** The options; or pass `<option>` children instead. */
  options?: readonly SelectOption[];
  /** A first, empty-valued option shown when nothing is chosen. */
  placeholder?: string;
  /** Called with the chosen value; `onChange` still fires too. */
  onValueChange?: (value: string) => void;
}

/**
 * A native `<select>`. Its list is the browser's own, drawn outside the page, so it needs no portal and
 * cannot escape the root's scope.
 */
export function Select({
  options,
  placeholder,
  onValueChange,
  onChange,
  className,
  children,
  ...props
}: SelectProps) {
  return (
    <select
      className={cn('nc-ui', 'nc-select', className)}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => {
        onChange?.(event);
        onValueChange?.(event.currentTarget.value);
      }}
      {...props}
    >
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options?.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
      {children}
    </select>
  );
}
