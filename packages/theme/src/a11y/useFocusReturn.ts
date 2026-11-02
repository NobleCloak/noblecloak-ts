import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

export interface UseFocusReturnOptions {
  /** Off, the hook does nothing (true). */
  enabled?: boolean;
  /** Focus the element the ref is attached to on mount (true). */
  focusOnMount?: boolean;
}

/**
 * Remembers what had focus when the component mounted, optionally focuses the component, and gives focus back
 * on unmount. Attach the returned ref to a focusable element (`tabIndex={-1}` for a container).
 */
export function useFocusReturn<T extends HTMLElement = HTMLElement>(
  options: UseFocusReturnOptions = {}
): RefObject<T | null> {
  const { enabled = true, focusOnMount = true } = options;
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const previous = document.activeElement;
    if (focusOnMount) ref.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) {
        // After the unmount's DOM changes, so the element is still there to take focus.
        setTimeout(() => {
          previous.focus();
        }, 0);
      }
    };
  }, [enabled, focusOnMount]);
  return ref;
}
