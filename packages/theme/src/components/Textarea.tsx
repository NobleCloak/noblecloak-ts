import type { ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';

export type TextareaProps = ComponentPropsWithRef<'textarea'>;

/** A native `<textarea>` (the shape of the decision-reason field). */
export function Textarea({ className, ...props }: TextareaProps) {
  return <textarea className={cn('nc-ui', 'nc-textarea', className)} {...props} />;
}
