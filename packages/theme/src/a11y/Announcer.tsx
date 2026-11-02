import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { VISUALLY_HIDDEN_STYLE } from './VisuallyHidden.js';

export type Politeness = 'polite' | 'assertive';

export interface AnnouncerContextValue {
  /** Puts `message` in the polite (default) or assertive live region. */
  announce: (message: string, politeness?: Politeness) => void;
  /** Empties both live regions. */
  clear: () => void;
}

const AnnouncerContext = createContext<AnnouncerContextValue | undefined>(undefined);

export interface AnnouncerProviderProps {
  children?: ReactNode;
  /** Milliseconds before an announcement is cleared (7000). */
  clearDelay?: number;
}

/** Two visually hidden live regions, `status` (polite) and `alert` (assertive), and the context that fills them. */
export function AnnouncerProvider({ children, clearDelay = 7000 }: AnnouncerProviderProps) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const timers = useRef<Record<Politeness, ReturnType<typeof setTimeout> | undefined>>({
    polite: undefined,
    assertive: undefined,
  });

  const stop = useCallback((politeness: Politeness) => {
    const timer = timers.current[politeness];
    if (timer !== undefined) clearTimeout(timer);
    timers.current[politeness] = undefined;
  }, []);

  const announce = useCallback(
    (message: string, politeness: Politeness = 'polite') => {
      const set = politeness === 'assertive' ? setAssertive : setPolite;
      stop(politeness);
      set(message);
      timers.current[politeness] = setTimeout(() => {
        set('');
      }, clearDelay);
    },
    [clearDelay, stop]
  );

  const clear = useCallback(() => {
    stop('polite');
    stop('assertive');
    setPolite('');
    setAssertive('');
  }, [stop]);

  useEffect(
    () => () => {
      stop('polite');
      stop('assertive');
    },
    [stop]
  );

  const value = useMemo(() => ({ announce, clear }), [announce, clear]);
  return (
    <AnnouncerContext.Provider value={value}>
      {children}
      <div
        className="nc-ui nc-visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={VISUALLY_HIDDEN_STYLE}
      >
        {polite}
      </div>
      <div
        className="nc-ui nc-visually-hidden"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        style={VISUALLY_HIDDEN_STYLE}
      >
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  );
}

/** The announcer of the nearest `AnnouncerProvider`; throws outside one. */
export function useAnnouncer(): AnnouncerContextValue {
  const context = useContext(AnnouncerContext);
  if (context === undefined)
    throw new Error('useAnnouncer must be used within an AnnouncerProvider');
  return context;
}
