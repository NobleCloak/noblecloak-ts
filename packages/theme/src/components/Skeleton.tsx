import type { ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';

export type SkeletonProps = ComponentPropsWithRef<'div'>;

/** A placeholder block on --nc-subtle; hidden from assistive technology (announce loading elsewhere). */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return <div aria-hidden="true" className={cn('nc-ui', 'nc-skeleton', className)} {...props} />;
}
