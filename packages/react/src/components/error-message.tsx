import { forwardRef } from 'react';

import { REASON_ELIGIBILITY_LOOKUP } from '../approvals-errors.js';
import type { ApprovalsError } from '../approvals-types.js';
import { escapeInvisible } from './format-json.js';
import type { Translate } from './labels.js';
import { useNc } from './slots.js';

/**
 * Where the error arose. `read`: loading the request, which the store retries by itself. `decision`: an
 * Approve or Deny that failed, which nothing re-sends, so the wording must not say it is being retried.
 */
export type ErrorContext = 'read' | 'decision';

/** The sentence for an error, chosen from its kind and code, never from the server's prose. */
export function errorText(
  error: ApprovalsError,
  t: Translate,
  context: ErrorContext = 'read'
): string {
  switch (error.kind) {
    case 'unauthorized':
      return t('errorUnauthorized');
    case 'forbidden':
      return error.code === 'not_eligible' ? t('errorNotEligible') : t('errorForbidden');
    case 'not_found':
      return t('errorNotFound');
    case 'invalid_request':
      return t('errorInvalidRequest');
    case 'rate_limited':
      return error.retryAfterMs === undefined
        ? t('errorRateLimited')
        : t('errorRateLimitedAfter', { seconds: Math.ceil(error.retryAfterMs / 1000) });
    case 'unavailable': {
      const seconds =
        error.retryAfterMs === undefined ? undefined : Math.ceil(error.retryAfterMs / 1000);
      // The service could not tell whether you may decide: it said so (contract rev 6), so say that, not "unavailable".
      if (error.reason === REASON_ELIGIBILITY_LOOKUP)
        return seconds === undefined
          ? t('errorEligibilityLookup')
          : t('errorEligibilityLookupAfter', { seconds });
      // A decision is not re-sent, so a wait the service named is said; a read is retried by the store.
      if (context === 'decision')
        return seconds === undefined
          ? t('errorUnavailableDecision')
          : t('errorUnavailableAfter', { seconds });
      return t('errorUnavailable');
    }
    case 'network':
      return error.code === 'token_unavailable' ? t('errorTokenUnavailable') : t('errorNetwork');
    case 'unsupported':
      return t('errorUnsupported');
    case 'malformed_response':
      return t('errorMalformed');
    case 'precondition':
      return t('errorPrecondition');
    case 'conflict':
      switch (error.code) {
        case 'already_resolved':
          return t('errorAlreadyResolved');
        case 'obligation_expired':
          return t('errorExpired');
        case 'resolve_in_flight':
          return t('errorInFlight');
        default:
          return t('errorConflict');
      }
  }
}

/**
 * A decision that failed without a clear refusal may have reached the service before it failed, so the person
 * is told to check the queue: a connection that failed mid-request (`network` code `network`; it carries
 * `local` only because no response came back), a service error, or a reply that could not be read. Not a token
 * that could not be had, an exception before the request left (`client_error`), or any other error raised
 * locally (the request was never sent).
 */
function mayHaveBeenDecided(error: ApprovalsError): boolean {
  if (error.kind === 'network') return error.code === 'network';
  return (
    (error.kind === 'unavailable' || error.kind === 'malformed_response') && error.local !== true
  );
}

/** The request id the service gave a failed request, as a muted line; nothing when it gave none. */
export function RequestIdLine({
  error,
  t,
}: {
  readonly error: ApprovalsError;
  readonly t: Translate;
}) {
  return error.requestId === undefined ? null : (
    <p className="nc-muted">{t('requestId', { requestId: escapeInvisible(error.requestId) })}</p>
  );
}

export interface ErrorMessageProps {
  readonly error: ApprovalsError;
  readonly t: Translate;
  readonly context?: ErrorContext;
  /** Called by the "Sign in again" control, shown for a `unauthorized` error. */
  readonly onSignIn: () => void;
}

/** An error as text with its request id; a session that expired offers to sign in again. */
export const ErrorMessage = /* @__PURE__ */ forwardRef<HTMLDivElement, ErrorMessageProps>(
  function ErrorMessage({ error, t, context, onSignIn }, ref) {
    const { Alert, Button } = useNc();
    return (
      <Alert variant="danger" role="alert" tabIndex={-1} ref={ref} className="nc-error">
        <p>{errorText(error, t, context)}</p>
        {context === 'decision' && mayHaveBeenDecided(error) ? (
          <p>{t('errorMayBeDecided')}</p>
        ) : null}
        {error.kind === 'conflict' && error.current !== undefined ? (
          <p>{t('errorCurrentState', { state: escapeInvisible(error.current.state) })}</p>
        ) : null}
        <RequestIdLine error={error} t={t} />
        {error.kind === 'unauthorized' ? (
          <Button type="button" variant="secondary" onClick={onSignIn}>
            {t('signInAgain')}
          </Button>
        ) : null}
      </Alert>
    );
  }
);
