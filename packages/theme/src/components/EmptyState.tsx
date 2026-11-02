import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '../cn.js';

export interface EmptyStateProps extends Omit<ComponentPropsWithRef<'div'>, 'title'> {
  title: string;
  description?: string;
  /** A glyph shown above the title, hidden from assistive technology. The theme ships no icons. */
  icon?: ReactNode;
  /** A call to action under the description, such as a Button. */
  action?: ReactNode;
  /** The title's element ('h3'). */
  titleAs?: 'h2' | 'h3' | 'h4' | 'p';
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  titleAs: Title = 'h3',
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div className={cn('nc-ui', 'nc-empty', className)} {...props}>
      {icon !== undefined ? (
        <span className="nc-ui nc-empty-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <Title className="nc-ui nc-empty-title">{title}</Title>
      {description !== undefined ? (
        <p className="nc-ui nc-empty-description">{description}</p>
      ) : null}
      {action !== undefined ? <div className="nc-ui nc-empty-action">{action}</div> : null}
    </div>
  );
}
