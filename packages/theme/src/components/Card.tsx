import type { ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';

export type CardProps = ComponentPropsWithRef<'div'>;

/** A bordered panel on --nc-surface (the shape of the module's detail panel). */
export function Card({ className, ...props }: CardProps) {
  return <div className={cn('nc-ui', 'nc-card', className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('nc-ui', 'nc-card-header', className)} {...props} />;
}

/** The card's heading; an `<h3>` unless `as` names another level. */
export function CardTitle({
  as: Heading = 'h3',
  className,
  ...props
}: ComponentPropsWithRef<'h3'> & { as?: 'h2' | 'h3' | 'h4' | 'p' }) {
  return <Heading className={cn('nc-ui', 'nc-card-title', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentPropsWithRef<'p'>) {
  return <p className={cn('nc-ui', 'nc-card-description', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('nc-ui', 'nc-card-content', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('nc-ui', 'nc-card-footer', className)} {...props} />;
}
