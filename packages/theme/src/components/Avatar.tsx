import { useState } from 'react';
import type { ComponentPropsWithRef } from 'react';

import { cn } from '../cn.js';

export interface AvatarProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  /** The image; left out, or failing to load, the fallback shows. */
  src?: string;
  /** The person's or principal's name, for assistive technology. */
  alt: string;
  /** Shown without an image: usually initials. */
  fallback: string;
}

export function Avatar({ src, alt, fallback, className, ...props }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const showImage = src !== undefined && failedSrc !== src;
  return (
    <span
      className={cn('nc-ui', 'nc-avatar', className)}
      {...(showImage ? {} : { role: 'img', 'aria-label': alt })}
      {...props}
    >
      {showImage ? (
        <img
          className="nc-ui nc-avatar-image"
          src={src}
          alt={alt}
          onError={() => {
            setFailedSrc(src);
          }}
        />
      ) : (
        <span className="nc-ui nc-avatar-fallback" aria-hidden="true">
          {fallback}
        </span>
      )}
    </span>
  );
}
