import { useState } from 'react';
import type { ComponentPropsWithRef, MouseEvent } from 'react';

import { cn } from '../cn.js';

export interface SwitchProps extends Omit<ComponentPropsWithRef<'button'>, 'onChange' | 'value'> {
  /** Controlled state. */
  checked?: boolean;
  /** Initial state when uncontrolled (false). */
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/** An on/off control: a `<button role="switch">` with `aria-checked`. Name it with `aria-label` or a label. */
export function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  onClick,
  className,
  type = 'button',
  ...props
}: SwitchProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultChecked);
  const on = checked ?? uncontrolled;
  return (
    <button
      type={type}
      role="switch"
      aria-checked={on}
      className={cn('nc-ui', 'nc-switch', className)}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (checked === undefined) setUncontrolled(!on);
        onCheckedChange?.(!on);
      }}
      {...props}
    >
      <span className="nc-ui nc-switch-thumb" aria-hidden="true" />
    </button>
  );
}
