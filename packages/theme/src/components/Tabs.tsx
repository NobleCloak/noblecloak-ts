import { useState } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '../cn.js';
import { useSlot } from '../slot-context.js';
import { Button as DefaultButton } from './Button.js';

export interface TabsItem {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

export interface TabsProps extends Omit<ComponentPropsWithRef<'div'>, 'defaultValue' | 'onChange'> {
  items: readonly TabsItem[];
  /** The group's accessible name (`aria-label`). */
  label: string;
  /** Controlled selection. */
  value?: string;
  /** Initial selection when uncontrolled (the first item). */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Called with the pressed item's value when it is pressed again (the selection does not change). */
  onReselect?: (value: string) => void;
}

/**
 * A toggle-button group: one `aria-pressed` button per item in a `role="group"`, exactly one pressed. This is
 * the shape of the module's Pending/Recent switch (it shows one list or the other), not an ARIA tablist, so it
 * renders no tab panels and each button is its own tab stop. Each item is rendered by the `Button` slot (with the
 * class `nc-toggle`), so a replaced `Button` replaces the toggles too.
 */
export function Tabs({
  items,
  label,
  value,
  defaultValue,
  onValueChange,
  onReselect,
  className,
  ...props
}: TabsProps) {
  const Button = useSlot('Button', DefaultButton);
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? items[0]?.value);
  const selected = value ?? uncontrolled;
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('nc-ui', 'nc-toggle-group', className)}
      {...props}
    >
      {items.map((item) => (
        <Button
          key={item.value}
          type="button"
          className="nc-toggle"
          aria-pressed={item.value === selected}
          disabled={item.disabled}
          onClick={() => {
            if (item.value === selected) {
              onReselect?.(item.value);
              return;
            }
            if (value === undefined) setUncontrolled(item.value);
            onValueChange?.(item.value);
          }}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}
