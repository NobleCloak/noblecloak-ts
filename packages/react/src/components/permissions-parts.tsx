/**
 * Pieces the permissions components share: the sentence for an error (chosen from its kind and code, never from the
 * server's prose, with the problem's `detail` shown verbatim where the contract says it names the refused member),
 * the name of a mode, the wire form of a mode, and how a subject is written. Every string a service sent is shown
 * with its invisible characters escaped.
 */
import type { ReactNode } from 'react';

import type { PermissionsError, PolicySubject, ToolInfo } from '../permissions-types.js';
import { MODE_ON_THE_WIRE, isKnownMode } from '../permissions-vocabulary.js';
import { escapeInvisible } from './format-json.js';
import { modeKey } from './permissions-labels.js';
import type { PermissionsTranslate } from './permissions-labels.js';
import { useNc } from './slots.js';

/**
 * Where an error arose. `write`: a create, save or publish, which needs an administrator, so a 403 says that.
 * `read`: a read or a dry run, which needs none (a simulation "needs no administrator"), so a 403 is not explained.
 */
export type ErrorContext = 'read' | 'write';

/** The sentence for an error. */
export function permissionsErrorText(
  error: PermissionsError,
  t: PermissionsTranslate,
  context: ErrorContext = 'read'
): string {
  const detail = error.detail === undefined ? undefined : escapeInvisible(error.detail);
  switch (error.kind) {
    case 'unauthorized':
      return t('errorUnauthorized');
    case 'forbidden':
      return context === 'write' ? t('errorForbidden') : t('errorForbiddenRead');
    case 'not_found':
      return t('errorNotFound');
    case 'invalid_request':
      return detail === undefined
        ? t('errorInvalidRequest')
        : t('errorInvalidRequestDetail', { detail });
    case 'unprocessable':
      return detail === undefined
        ? t('errorUnprocessableNoDetail')
        : t('errorUnprocessable', { detail });
    case 'conflict':
      return t('errorConflict');
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
export function PermissionsErrorAlert({
  error,
  t,
  onSignIn,
  onOpenPolicy,
  nameOf,
  context,
  children,
}: {
  readonly error: PermissionsError;
  readonly t: PermissionsTranslate;
  readonly context?: ErrorContext;
  readonly onSignIn?: (() => void) | undefined;
  /** Opens a policy: a 409 `policy_conflict` links the governing policy through it. */
  readonly onOpenPolicy?: ((id: string) => void) | undefined;
  /** The name of a policy by id, from the lists the host holds. */
  readonly nameOf?: ((id: string) => string | undefined) | undefined;
  readonly children?: ReactNode;
}) {
  const { Alert, Button } = useNc();
  const governing = error.kind === 'conflict' ? error.policyId : undefined;
  return (
    <Alert variant="danger" role="alert" className="nc-error">
      <p>{permissionsErrorText(error, t, context)}</p>
      {governing === undefined ? null : (
        <ConflictLine
          policyId={governing}
          name={nameOf?.(governing)}
          t={t}
          onOpenPolicy={onOpenPolicy}
        />
      )}
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

/** The policy a 409 `policy_conflict` names: a link that opens it, or its name when nothing can open it. */
export function ConflictLine({
  policyId,
  name,
  t,
  onOpenPolicy,
}: {
  readonly policyId: string;
  readonly name: string | undefined;
  readonly t: PermissionsTranslate;
  readonly onOpenPolicy?: ((id: string) => void) | undefined;
}) {
  const { Button } = useNc();
  const shown = policyName({ name, id: policyId }, t);
  return (
    <p>
      {t('conflictWith')}{' '}
      {onOpenPolicy === undefined ? (
        <strong>{shown}</strong>
      ) : (
        <Button
          type="button"
          variant="link"
          onClick={() => {
            onOpenPolicy(policyId);
          }}
        >
          {t('conflictOpen', { name: shown })}
        </Button>
      )}
    </p>
  );
}

/** A mode's name: the label of one of the five, or the value as sent for a mode the module does not know. */
export function modeName(mode: string | undefined, t: PermissionsTranslate): string {
  if (mode === undefined) return t('cellModeAbsent');
  const key = modeKey('mode_', mode);
  return key === undefined ? t('cellModeUnknown', { mode: escapeInvisible(mode) }) : t(key);
}

/** A mode as an option: its name and, for one of the five, its wire decision (D9: the mapping, not a paraphrase). */
export function modeOptionLabel(mode: string, t: PermissionsTranslate): string {
  const wire = wireText(mode, t);
  return wire === undefined
    ? modeName(mode, t)
    : t('modeOption', { mode: modeName(mode, t), wire });
}

/** A known mode as the contract writes it on the wire: the decision, and its routing or reason. */
export function wireText(mode: string, t: PermissionsTranslate): string | undefined {
  if (!isKnownMode(mode)) return undefined;
  const wire = MODE_ON_THE_WIRE[mode];
  if (wire.routing !== undefined)
    return t('wireRouting', { decision: wire.decision, routing: wire.routing });
  if (wire.reason !== undefined)
    return t('wireReason', { decision: wire.decision, reason: wire.reason });
  return t('wireDecision', { decision: wire.decision });
}

/**
 * A host's display name for a subject (a person's name for a user id, say), or `undefined` when it has none. The
 * module shows it beside the subject's type and id, never instead of them, and asks nothing of the service for it.
 */
export type SubjectLabel = (subject: PolicySubject) => string | undefined;

/**
 * How a subject is written here: `subjectText`, with the host's display name before it when the host gives one. A
 * label that throws, or is empty, is left out: the subject is still named by type and id. The label is passed down
 * as a prop: the package creates no React context of its own.
 */
export function subjectTextWith(
  t: PermissionsTranslate,
  label: SubjectLabel | undefined
): (subject: PolicySubject) => string {
  return (subject) => {
    const text = subjectText(subject, t);
    if (label === undefined) return text;
    let named: string | undefined;
    try {
      named = label(subject);
    } catch {
      named = undefined;
    }
    return typeof named !== 'string' || named.trim() === ''
      ? text
      : t('subjectLabelled', { label: escapeInvisible(named), subject: text });
  };
}

/** A subject as text: the organisation, or its type and id as sent. */
export function subjectText(subject: PolicySubject, t: PermissionsTranslate): string {
  if (subject.type === 'organization') return t('subjectOrganisation');
  return t('otherSubjectRow', {
    type: escapeInvisible(subject.type),
    id: escapeInvisible(subject.id ?? ''),
  });
}

/**
 * A tool reference as a choice is labelled: marked when the tool is not callable, withdrawn or of a status the module
 * does not know (shown as sent).
 */
export function toolRefLabel(
  ref: string,
  tools: readonly ToolInfo[],
  t: PermissionsTranslate
): string {
  const tool = escapeInvisible(ref);
  const status = tools.find((candidate) => candidate.toolRef === ref)?.status;
  if (status === undefined || status === 'active') return tool;
  return status === 'withdrawn'
    ? t('targetToolWithdrawn', { tool })
    : t('targetToolStatus', { tool, status: escapeInvisible(status) });
}

/** The name a policy is shown by: its own, else "Policy {id}". */
export function policyName(
  policy: { readonly name?: string | undefined; readonly policyId?: string; readonly id?: string },
  t: PermissionsTranslate
): string {
  if (policy.name !== undefined && policy.name !== '') return escapeInvisible(policy.name);
  return t('policyFallbackName', { id: escapeInvisible(policy.policyId ?? policy.id ?? '') });
}
