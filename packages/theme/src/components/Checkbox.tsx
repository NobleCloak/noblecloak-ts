import { useEffect, useRef } from 'react';
import type { ChangeEvent, ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';
import { mergeRefs } from '../merge-refs.js';

export interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type'> {
  /**
   * Shows the mixed state (a dash) through the native `indeterminate` property, which has no attribute. The
   * browser exposes it to assistive technology as mixed, so no `aria-checked` is set (ARIA in HTML forbids it on
   * a native checkbox).
   */
  indeterminate?: boolean;
  /** Called with the new checked state; `onChange` still fires too. */
  onCheckedChange?: (checked: boolean) => void;
}

/** A native `<input type="checkbox">`, drawn by the theme so a host's checkbox styles do not reach it. */
export function Checkbox({
  indeterminate = false,
  onCheckedChange,
  onChange,
  className,
  ref,
  ...props
}: CheckboxProps) {
  const own = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (own.current !== null) own.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={mergeRefs(own, ref)}
      type="checkbox"
      className={cn('nc-ui', 'nc-checkbox', className)}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        onChange?.(event);
        onCheckedChange?.(event.currentTarget.checked);
      }}
      {...props}
    />
  );
}
