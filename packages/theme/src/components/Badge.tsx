import type { ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';

export type BadgeVariant = 'neutral' | 'accent' | 'danger' | 'success' | 'warning' | 'outline';

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
  variant?: BadgeVariant;
}

/** A short inline label. Coloured variants pair the colour with a border, so it is not the only cue. */
export function Badge({ variant = 'neutral', className, ...props }: BadgeProps) {
  return <span className={cn('nc-ui', 'nc-badge', className)} data-variant={variant} {...props} />;
}
