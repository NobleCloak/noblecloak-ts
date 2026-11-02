import type { ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';

export type LabelProps = ComponentPropsWithRef<'label'>;

/** A native `<label>`; pair it with a control through `htmlFor` or by nesting. */
export function Label({ className, ...props }: LabelProps) {
  return <label className={cn('nc-ui', 'nc-label', className)} {...props} />;
}
