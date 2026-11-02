// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnnouncerProvider, useAnnouncer } from './Announcer.js';
import { useArrowNavigation } from './useArrowNavigation.js';
import type { Orientation } from './useArrowNavigation.js';
import { useFocusReturn } from './useFocusReturn.js';
import { VisuallyHidden } from './VisuallyHidden.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('VisuallyHidden', () => {
  it('hides inline, keeps the content, and merges a caller style', () => {
    render(<VisuallyHidden style={{ color: 'red' }}>Hidden text</VisuallyHidden>);
    const element = screen.getByText('Hidden text');
    expect(element.style.position).toBe('absolute');
    expect(element.style.width).toBe('1px');
    expect(element.style.color).toBe('red');
    expect(element.tabIndex).toBe(-1);
  });

  it('focusable: shows itself while focused, and still calls the caller handlers', () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    render(
      <VisuallyHidden focusable onFocus={onFocus} onBlur={onBlur}>
        Skip to content
      </VisuallyHidden>
    );
    const element = screen.getByText('Skip to content');
    expect(element.tabIndex).toBe(0);
    fireEvent.focus(element);
    expect(element.style.position).toBe('');
    fireEvent.blur(element);
    expect(element.style.position).toBe('absolute');
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('not focusable: focus does not reveal it', () => {
    render(<VisuallyHidden>Quiet</VisuallyHidden>);
    const element = screen.getByText('Quiet');
    fireEvent.focus(element);
    expect(element.style.position).toBe('absolute');
    fireEvent.blur(element);
    expect(element.style.position).toBe('absolute');
  });
});

describe('Announcer', () => {
  function Buttons() {
    const { announce, clear } = useAnnouncer();
    return (
      <>
        <button
          type="button"
          onClick={() => {
            announce('Saved');
          }}
        >
          Polite
        </button>
        <button
          type="button"
          onClick={() => {
            announce('Failed', 'assertive');
          }}
        >
          Assertive
        </button>
        <button type="button" onClick={clear}>
          Clear
        </button>
      </>
    );
  }

  const status = () => document.querySelector('[role="status"]');
  const alert = () => document.querySelector('[role="alert"]');

  it('fills the polite and assertive regions and clears them', () => {
    render(
      <AnnouncerProvider>
        <Buttons />
      </AnnouncerProvider>
    );
    fireEvent.click(screen.getByText('Polite'));
    fireEvent.click(screen.getByText('Assertive'));
    expect(status()?.textContent).toBe('Saved');
    expect(alert()?.textContent).toBe('Failed');
    fireEvent.click(screen.getByText('Clear'));
    expect(status()?.textContent).toBe('');
    expect(alert()?.textContent).toBe('');
  });

  it('both live regions carry nc-ui, so the scoped reset covers them inside a root', () => {
    render(<AnnouncerProvider>{null}</AnnouncerProvider>);
    expect(status()?.className).toBe('nc-ui nc-visually-hidden');
    expect(alert()?.className).toBe('nc-ui nc-visually-hidden');
  });

  it('clears an announcement after the delay, restarting the timer on a repeat', () => {
    vi.useFakeTimers();
    render(
      <AnnouncerProvider clearDelay={100}>
        <Buttons />
      </AnnouncerProvider>
    );
    fireEvent.click(screen.getByText('Polite'));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    fireEvent.click(screen.getByText('Polite'));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(status()?.textContent).toBe('Saved');
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(status()?.textContent).toBe('');
  });

  it('throws outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Buttons />)).toThrow(
      'useAnnouncer must be used within an AnnouncerProvider'
    );
    vi.restoreAllMocks();
  });
});

describe('useFocusReturn', () => {
  function Panel({
    enabled = true,
    focusOnMount = true,
  }: {
    enabled?: boolean;
    focusOnMount?: boolean;
  }) {
    const ref = useFocusReturn<HTMLDivElement>({ enabled, focusOnMount });
    return (
      <div ref={ref} tabIndex={-1} data-testid="panel">
        Panel
      </div>
    );
  }

  it('focuses the panel on mount and gives focus back on unmount', () => {
    vi.useFakeTimers();
    render(
      <button type="button" data-testid="opener">
        Open
      </button>
    );
    const opener = screen.getByTestId('opener');
    opener.focus();
    const { unmount } = render(<Panel />);
    expect(document.activeElement).toBe(screen.getByTestId('panel'));
    unmount();
    act(() => {
      vi.runAllTimers();
    });
    expect(document.activeElement).toBe(opener);
  });

  it('does nothing when disabled, and does not take focus when focusOnMount is off', () => {
    const { unmount } = render(<Panel enabled={false} />);
    expect(document.activeElement).not.toBe(screen.getByTestId('panel'));
    unmount();
    render(<Panel focusOnMount={false} />);
    expect(document.activeElement).not.toBe(screen.getByTestId('panel'));
  });
});

describe('useArrowNavigation', () => {
  function List({
    onSelect,
    orientation,
    wrap,
    enabled,
    count = 3,
  }: {
    onSelect?: (index: number) => void;
    orientation?: Orientation;
    wrap?: boolean;
    enabled?: boolean;
    count?: number;
  }) {
    const { focusedIndex, getContainerProps, getItemProps } = useArrowNavigation({
      itemCount: count,
      ...(onSelect !== undefined ? { onSelect } : {}),
      ...(orientation !== undefined ? { orientation } : {}),
      ...(wrap !== undefined ? { wrap } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      initialIndex: 0,
    });
    return (
      <ul {...getContainerProps()} data-testid="list" data-focused={focusedIndex}>
        {Array.from({ length: count }, (_, index) => (
          <li key={index} {...getItemProps(index)}>
            Item {index}
          </li>
        ))}
      </ul>
    );
  }

  const list = () => screen.getByTestId('list');
  const press = (key: string) => {
    fireEvent.keyDown(list(), { key });
  };
  const focused = () => Number(list().dataset.focused);

  it('sets listbox and option roles with a roving tabindex', () => {
    render(<List />);
    expect(list().getAttribute('role')).toBe('listbox');
    expect(list().getAttribute('aria-orientation')).toBe('vertical');
    const [first, second] = screen.getAllByRole('option');
    expect(first?.getAttribute('tabindex')).toBe('0');
    expect(first?.getAttribute('aria-selected')).toBe('true');
    expect(second?.getAttribute('tabindex')).toBe('-1');
  });

  it('moves with arrows, wraps, and jumps with Home and End', () => {
    render(<List />);
    press('ArrowDown');
    expect(focused()).toBe(1);
    expect(document.activeElement?.textContent).toBe('Item 1');
    press('ArrowUp');
    press('ArrowUp');
    expect(focused()).toBe(2);
    press('ArrowDown');
    expect(focused()).toBe(0);
    press('End');
    expect(focused()).toBe(2);
    press('Home');
    expect(focused()).toBe(0);
    press('ArrowRight');
    expect(focused()).toBe(0);
  });

  it('without wrap, stops at the ends', () => {
    render(<List wrap={false} />);
    press('ArrowUp');
    expect(focused()).toBe(0);
    press('End');
    press('ArrowDown');
    expect(focused()).toBe(2);
  });

  it('horizontal and both orientations use the matching keys', () => {
    const { unmount } = render(<List orientation="horizontal" />);
    expect(list().getAttribute('aria-orientation')).toBe('horizontal');
    press('ArrowRight');
    expect(focused()).toBe(1);
    press('ArrowLeft');
    expect(focused()).toBe(0);
    press('ArrowDown');
    expect(focused()).toBe(0);
    unmount();
    render(<List orientation="both" />);
    expect(list().getAttribute('aria-orientation')).toBeNull();
    press('ArrowRight');
    press('ArrowDown');
    expect(focused()).toBe(2);
  });

  it('Enter and Space select the focused item', () => {
    const onSelect = vi.fn();
    render(<List onSelect={onSelect} />);
    press('ArrowDown');
    press('Enter');
    press(' ');
    expect(onSelect).toHaveBeenNthCalledWith(1, 1);
    expect(onSelect).toHaveBeenNthCalledWith(2, 1);
  });

  it('does nothing when disabled or empty, and pulls the index back when the list shrinks', () => {
    const { rerender } = render(<List enabled={false} />);
    press('ArrowDown');
    expect(focused()).toBe(0);
    rerender(<List count={0} />);
    press('ArrowDown');
    expect(focused()).toBe(0);
    rerender(<List count={3} />);
    press('End');
    rerender(<List count={2} />);
    expect(focused()).toBe(1);
  });
});
