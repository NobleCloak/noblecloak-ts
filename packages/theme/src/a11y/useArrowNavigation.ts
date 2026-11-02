import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';

export type Orientation = 'horizontal' | 'vertical' | 'both';

export interface UseArrowNavigationOptions {
  itemCount: number;
  /** Which arrow keys move ('vertical'). */
  orientation?: Orientation;
  /** Past the last item, go to the first, and back (true). */
  wrap?: boolean;
  /** Called with the focused index on Enter or Space. */
  onSelect?: (index: number) => void;
  /** Off, keys do nothing (true). */
  enabled?: boolean;
  initialIndex?: number;
}

export interface ArrowContainerProps {
  onKeyDown: (event: KeyboardEvent) => void;
  role: 'listbox';
  'aria-orientation'?: 'horizontal' | 'vertical';
  tabIndex: number;
}

export interface ArrowItemProps {
  role: 'option';
  tabIndex: number;
  'aria-selected': boolean;
  ref: (element: HTMLElement | null) => void;
}

export interface UseArrowNavigationReturn {
  focusedIndex: number;
  setFocusedIndex: Dispatch<SetStateAction<number>>;
  getContainerProps: () => ArrowContainerProps;
  getItemProps: (index: number) => ArrowItemProps;
  focusIndex: (index: number) => void;
}

const FORWARD: Record<Orientation, readonly string[]> = {
  vertical: ['ArrowDown'],
  horizontal: ['ArrowRight'],
  both: ['ArrowDown', 'ArrowRight'],
};
const BACKWARD: Record<Orientation, readonly string[]> = {
  vertical: ['ArrowUp'],
  horizontal: ['ArrowLeft'],
  both: ['ArrowUp', 'ArrowLeft'],
};

/** Roving focus over a listbox: arrow keys, Home and End move; Enter and Space select. */
export function useArrowNavigation(options: UseArrowNavigationOptions): UseArrowNavigationReturn {
  const { itemCount, orientation = 'vertical', wrap = true, onSelect, enabled = true } = options;
  const [focusedIndex, setFocusedIndex] = useState(options.initialIndex ?? 0);
  const items = useRef(new Map<number, HTMLElement>());

  useEffect(() => {
    if (itemCount > 0 && focusedIndex >= itemCount) setFocusedIndex(itemCount - 1);
  }, [itemCount, focusedIndex]);

  const focusIndex = useCallback((index: number) => {
    setFocusedIndex(index);
    items.current.get(index)?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled || itemCount === 0) return;
      const { key } = event;
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        onSelect?.(focusedIndex);
        return;
      }
      const last = itemCount - 1;
      let next: number | undefined;
      if (FORWARD[orientation].includes(key)) {
        next = wrap ? (focusedIndex + 1) % itemCount : Math.min(focusedIndex + 1, last);
      } else if (BACKWARD[orientation].includes(key)) {
        next = wrap ? (focusedIndex - 1 + itemCount) % itemCount : Math.max(focusedIndex - 1, 0);
      } else if (key === 'Home') next = 0;
      else if (key === 'End') next = last;
      if (next === undefined) return;
      event.preventDefault();
      focusIndex(next);
    },
    [enabled, itemCount, orientation, wrap, focusedIndex, focusIndex, onSelect]
  );

  const getContainerProps = useCallback(
    (): ArrowContainerProps => ({
      onKeyDown,
      role: 'listbox',
      tabIndex: -1,
      ...(orientation === 'both' ? {} : { 'aria-orientation': orientation }),
    }),
    [onKeyDown, orientation]
  );

  const getItemProps = useCallback(
    (index: number): ArrowItemProps => ({
      role: 'option',
      tabIndex: index === focusedIndex ? 0 : -1,
      'aria-selected': index === focusedIndex,
      ref: (element) => {
        if (element === null) items.current.delete(index);
        else items.current.set(index, element);
      },
    }),
    [focusedIndex]
  );

  return { focusedIndex, setFocusedIndex, getContainerProps, getItemProps, focusIndex };
}
