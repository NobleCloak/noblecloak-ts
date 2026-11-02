import { useState } from 'react';
import type { ComponentPropsWithRef, CSSProperties } from 'react';

import { cn } from '../cn.js';

/** The styles that hide content visually while leaving it in the accessibility tree. */
export const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};

export interface VisuallyHiddenProps extends ComponentPropsWithRef<'span'> {
  /** When true the content can take focus and is shown while it has it (a skip link). */
  focusable?: boolean;
}

/**
 * Content for assistive technology only. The styles are inline, so no host rule short of `!important`
 * reveals it. It carries `nc-ui` like every element the theme renders, so inside a root the scoped reset
 * covers the properties the inline styles leave alone.
 */
export function VisuallyHidden({
  focusable = false,
  className,
  style,
  onFocus,
  onBlur,
  ...props
}: VisuallyHiddenProps) {
  const [focused, setFocused] = useState(false);
  return (
    <span
      tabIndex={focusable ? 0 : undefined}
      {...props}
      className={cn('nc-ui', 'nc-visually-hidden', className)}
      style={{ ...(focusable && focused ? {} : VISUALLY_HIDDEN_STYLE), ...style }}
      onFocus={(event) => {
        if (focusable) setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        if (focusable) setFocused(false);
        onBlur?.(event);
      }}
    />
  );
}
