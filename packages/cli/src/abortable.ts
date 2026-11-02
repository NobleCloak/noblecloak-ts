import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';

/** How long a single request may take when `Io.requestTimeoutMs` is not set. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The abort signal for one request: the user's interrupt or a timeout, whichever comes first. */
export function requestSignal(io: Io): AbortSignal {
  return AbortSignal.any([io.signal, timeoutOnlySignal(io)]);
}

/** The signal for work that must still run after an interrupt (ending the session): a timeout only. */
export function timeoutOnlySignal(io: Io): AbortSignal {
  return AbortSignal.timeout(io.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
}

export const interrupted = (io: Io): boolean => io.signal.aborted;

/** Exit 3, like a cancelled sign-in. `detail` says what state the interrupt left behind. */
export function interruptedError(detail: string): CliError {
  return new CliError(EXIT.unauthenticated, `Interrupted. ${detail}`);
}

/**
 * Settles with `work`, or rejects as soon as the user interrupts. The rejection lets `withSession` run its
 * `finally` (the refresh token is revoked) instead of waiting on something that will never answer.
 */
export function unlessInterrupted<T>(io: Io, work: Promise<T>, detail: string): Promise<T> {
  const signal = io.signal;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(interruptedError(detail));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('unexpected failure'));
      }
    );
  });
}
