/**
 * Pieces the connections components share: the sentence for an error (chosen from its kind and code, never from the
 * server's prose, with the problem's `detail` shown verbatim where the contract says it names the refused member), and
 * the words for a registration's state, tier, kind of authentication and owner. Every string a service sent is shown
 * with its invisible characters escaped.
 */
import type { ReactNode } from 'react';

import type { ConnectionInfo, ConnectionsError } from '../connections-types.js';
import { knownKey } from './connections-labels.js';
import type { ConnectionsTranslate } from './connections-labels.js';
import { escapeInvisible } from './format-json.js';
import { useNc } from './slots.js';

/**
 * Where an error arose. `admin`: registering or changing a registration, which an administrator does, so a 403 says
 * that. `own`: a read, or the caller's own link, which needs no administrator, so a 403 is not explained.
 */
export type ErrorContext = 'own' | 'admin';

/** The sentence for an error. */
export function connectionsErrorText(
  error: ConnectionsError,
  t: ConnectionsTranslate,
  context: ErrorContext = 'own'
): string {
  const detail = error.detail === undefined ? undefined : escapeInvisible(error.detail);
  switch (error.kind) {
    case 'unauthorized':
      return t('errorUnauthorized');
    case 'forbidden':
      return context === 'admin' ? t('errorForbidden') : t('errorForbiddenRead');
    case 'not_found':
      return t('errorNotFound');
    case 'invalid_request':
      return detail === undefined
        ? t('errorInvalidRequest')
        : t('errorInvalidRequestDetail', { detail });
    case 'conflict':
      return error.code === 'connection_exists' ? t('exists') : t('errorConflict');
    case 'rate_limited':
      return t('errorRateLimited');
    case 'unavailable':
      return t('errorUnavailable');
    case 'network':
      return t('errorNetwork');
    case 'unsupported':
      return t('errorUnsupported');
    case 'malformed_response':
      return t('errorMalformed');
    case 'precondition':
      return t(`error_${error.code}`);
  }
}

/** An error as an alert, with the request id the service gave it and, for an expired session, "Sign in again". */
export function ConnectionsErrorAlert({
  error,
  t,
  context,
  onSignIn,
  children,
}: {
  readonly error: ConnectionsError;
  readonly t: ConnectionsTranslate;
  readonly context?: ErrorContext;
  readonly onSignIn?: (() => void) | undefined;
  readonly children?: ReactNode;
}) {
  const { Alert, Button } = useNc();
  return (
    <Alert variant="danger" role="alert" className="nc-error">
      <p>{connectionsErrorText(error, t, context)}</p>
      {children}
      {error.requestId === undefined ? null : (
        <p className="nc-muted">
          {t('requestId', { requestId: escapeInvisible(error.requestId) })}
        </p>
      )}
      {error.kind === 'unauthorized' && onSignIn !== undefined ? (
        <Button type="button" variant="secondary" onClick={onSignIn}>
          {t('signInAgain')}
        </Button>
      ) : null}
    </Alert>
  );
}

/** A registration's state: the words for a known one, the value as sent otherwise. */
export function stateText(connection: ConnectionInfo, t: ConnectionsTranslate): string {
  if (connection.state === undefined) return t('stateNotStated');
  const key = knownKey('state_', connection.state);
  return key === undefined
    ? t('stateUnknown', { state: escapeInvisible(connection.state) })
    : t(key);
}

/** The badge colour of a state: only `connected` reads as healthy; anything else does not. */
export function stateVariant(state: string | undefined): 'success' | 'warning' | 'neutral' {
  if (state === 'connected') return 'success';
  if (state === 'pending_authorization' || state === 'degraded') return 'warning';
  return 'neutral';
}

export function tierText(tier: string | undefined, t: ConnectionsTranslate): string {
  if (tier === undefined) return t('stateNotStated');
  const key = knownKey('tier_', tier);
  return key === undefined ? t('tierUnknown', { tier: escapeInvisible(tier) }) : t(key);
}

export function authText(kind: string | undefined, t: ConnectionsTranslate): string {
  if (kind === undefined) return t('stateNotStated');
  const key = knownKey('auth_', kind);
  return key === undefined ? t('authUnknown', { kind: escapeInvisible(kind) }) : t(key);
}

/** The owner by kind: the organisation, or a principal by id (the contract has no names for principals). */
export function ownerText(connection: ConnectionInfo, t: ConnectionsTranslate): string {
  return connection.owner.kind === 'principal'
    ? t('ownerPrincipal', { id: escapeInvisible(connection.owner.id) })
    : t('ownerOrganisation');
}

/** A timestamp as sent, in UTC (`Intl`, en-US): the layout of a date, not a word. */
export function dateText(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return escapeInvisible(iso);
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(at);
}
