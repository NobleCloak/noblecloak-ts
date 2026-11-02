import type { ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';

export interface SeparatorProps extends ComponentPropsWithRef<'div'> {
  orientation?: 'horizontal' | 'vertical';
  /** Purely visual (true): hidden from assistive technology. False makes it a `separator`. */
  decorative?: boolean;
}

export function Separator({
  orientation = 'horizontal',
  decorative = true,
  className,
  ...props
}: SeparatorProps) {
  return (
    <div
      role={decorative ? 'none' : 'separator'}
      aria-orientation={decorative ? undefined : orientation}
      data-orientation={orientation}
      className={cn('nc-ui', 'nc-separator', className)}
      {...props}
    />
  );
}
