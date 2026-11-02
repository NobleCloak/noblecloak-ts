import type { ReactNode } from 'react';

import type {
  ActionOutcome,
  ActionStatusController,
  OnDeny,
  PendingOn,
  UseActionStatusOptions,
} from '../action-status-types.js';
import { useActionStatus } from '../use-action-status.js';
import { RenderBoundary } from './boundary.js';
import { errorText, RequestIdLine } from './error-message.js';
import { formatTime } from './format.js';
import { createTranslate } from './labels.js';
import type { ApprovalsLabelKey, ApprovalsLabels, Translate } from './labels.js';
import { Safe } from './safe.js';
import { useNc, WithComponents } from './slots.js';
import type { ModuleComponents } from './slots.js';
import { principalText } from './words.js';

interface ActionStatusCommonProps {
  readonly className?: string;
  /** Replaces any of the component's strings. A value may hold `{name}` placeholders, as the default does. */
  readonly labels?: ApprovalsLabels;
  /** Called by "Sign in again" when the session has expired. Without it, that control reads the status again. */
  readonly onSignIn?: () => void;
  /**
   * Replaces any of the primitives the component renders, by role (`Button`, `Alert`), over any
   * `NcProvider` around it. Shaped like `labels`: give only the roles to replace.
   */
  readonly components?: ModuleComponents;
}

/** Shows a status the host already reads with `useActionStatus`. */
export interface ActionStatusWithStatusProps extends ActionStatusCommonProps {
  /** What `useActionStatus` returns. */
  readonly status: ActionStatusController;
  /** Not with `status`: pass one form or the other. */
  readonly approvalId?: never;
}

/** Reads the status itself: `approvalId` plus the options `useActionStatus` takes. */
export interface ActionStatusWithIdProps extends ActionStatusCommonProps, UseActionStatusOptions {
  /** The approval the caller created. */
  readonly approvalId: string;
  /** Not with `approvalId`: pass one form or the other. */
  readonly status?: never;
}

export type ActionStatusProps = ActionStatusWithStatusProps | ActionStatusWithIdProps;

/**
 * The status of one approval as its creator sees it: where it stands, who it waits on, since when, what a denial
 * does and, once it is used, what came of it. Read-only. Structure only: the look comes from `styles.css` and the
 * host's custom properties, and the component imports no stylesheet. Give it `approvalId` and the
 * `useActionStatus` options, or `status` from a hook the host already runs. Render it on the client only, as
 * `<Approvals/>`.
 */
export function ActionStatus({ components, ...props }: ActionStatusProps) {
  return (
    <WithComponents components={components}>
      {props.status !== undefined ? <StatusView {...props} /> : <OwnedStatus {...props} />}
    </WithComponents>
  );
}

/** `<ActionStatus approvalId baseUrl getToken />`: the hook is called here so the choice above never changes the hooks a component runs. */
function OwnedStatus(props: Omit<ActionStatusWithIdProps, 'components'>) {
  const { approvalId, className, labels, onSignIn, ...options } = props;
  const status = useActionStatus(approvalId, options);
  return (
    <StatusView
      status={status}
      {...(className === undefined ? {} : { className })}
      {...(labels === undefined ? {} : { labels })}
      {...(onSignIn === undefined ? {} : { onSignIn })}
    />
  );
}

const STATE_LABELS: Readonly<Record<string, ApprovalsLabelKey>> = {
  pending: 'statePending',
  approved: 'stateApproved',
  rejected: 'stateRejected',
  consumed: 'stateConsumed',
  expired: 'stateExpired',
  withdrawn: 'stateWithdrawn',
};

function stateText(state: string, t: Translate): ReactNode {
  const key = Object.hasOwn(STATE_LABELS, state) ? STATE_LABELS[state] : undefined;
  return key === undefined ? t('stateOther', { state }) : t(key);
}

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="nc-fact">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function waitingOnText(pendingOn: PendingOn, t: Translate): ReactNode {
  switch (pendingOn.kind) {
    case 'unknown':
      return t('waitingOnUnknown');
    case 'count':
      return pendingOn.count === 0
        ? t('waitingOnNone')
        : t('waitingOnCount', { count: pendingOn.count });
    case 'principals':
      return (
        <>
          {t('waitingOnCount', { count: pendingOn.count })}
          {': '}
          <Safe>{pendingOn.principals.map(principalText).join(', ')}</Safe>
        </>
      );
  }
}

function onDenyText(onDeny: OnDeny, t: Translate): string {
  if (onDeny === 'resume') return t('onDenyResume');
  if (onDeny === 'halt') return t('onDenyHalt');
  return t('onDenyNotStated');
}

function outcomeText(outcome: ActionOutcome, t: Translate): ReactNode {
  switch (outcome.status) {
    case 'loading':
      return t('outcomeLoading');
    case 'recorded': {
      const result =
        outcome.result === 'succeeded'
          ? t('outcomeSucceeded')
          : outcome.result === 'failed'
            ? t('outcomeFailed')
            : t('outcomeUnknown');
      return t('outcomeRecorded', { result, time: formatTime(outcome.recordedAt, t) });
    }
    case 'unavailable': {
      const reason =
        outcome.reason === 'no_record'
          ? t('outcomeReasonNoRecord')
          : outcome.reason === 'forbidden'
            ? t('outcomeReasonForbidden')
            : outcome.reason === 'not_found'
              ? t('outcomeReasonNotFound')
              : outcome.reason === 'no_outcome'
                ? t('outcomeReasonNoOutcome')
                : outcome.reason === 'unauthorized'
                  ? t('outcomeReasonUnauthorized')
                  : outcome.reason === 'malformed'
                    ? t('outcomeReasonMalformed')
                    : t('outcomeReasonUnavailable');
      return t('outcomeUnavailable', { reason });
    }
  }
}

function StatusView({
  status,
  className,
  labels,
  onSignIn,
}: Omit<ActionStatusWithStatusProps, 'components'>) {
  const t = createTranslate(labels);
  return (
    <div className={['nc-root', 'nc-action-status', className].filter(Boolean).join(' ')}>
      <RenderBoundary key={status.approvalId}>
        <Body status={status} t={t} onSignIn={onSignIn} />
      </RenderBoundary>
    </div>
  );
}

function Body({
  status,
  t,
  onSignIn,
}: {
  readonly status: ActionStatusController;
  readonly t: Translate;
  readonly onSignIn: (() => void) | undefined;
}) {
  const { Alert, Button } = useNc();
  const retry = (): void => {
    status.retry();
  };
  switch (status.status) {
    case 'loading':
      return <p role="status">{t('statusLoading')}</p>;
    case 'not_found':
    case 'forbidden':
    case 'unauthorized':
    case 'unavailable':
    case 'error': {
      const message = {
        not_found: t('statusNotFound'),
        forbidden: t('statusForbidden'),
        unauthorized: t('errorUnauthorized'),
        unavailable: t('statusUnavailable'),
        // A deployment that does not serve approvals to this reader: nothing a retry changes.
        error: status.error?.kind === 'unsupported' ? t('errorUnsupported') : t('statusError'),
      }[status.status];
      // A gone approval may be visible again (a lag, or access granted later): retry() reads it afresh.
      const retryless = status.status === 'error' && status.error?.kind === 'unsupported';
      const error = status.error;
      // The other statuses name their cause already; `error` covers several, so it also gives the queue's sentence.
      const cause =
        status.status === 'error' && error !== undefined && error.kind !== 'unsupported'
          ? errorText(error, t)
          : undefined;
      return (
        <Alert variant="danger" role="alert" className="nc-error">
          <p>{message}</p>
          {cause === undefined ? null : <p>{cause}</p>}
          {error === undefined ? null : <RequestIdLine error={error} t={t} />}
          {retryless ? null : status.status === 'unauthorized' ? (
            <Button type="button" variant="secondary" onClick={onSignIn ?? retry}>
              {t('signInAgain')}
            </Button>
          ) : (
            <Button type="button" variant="secondary" onClick={retry}>
              {t('statusRetry')}
            </Button>
          )}
        </Alert>
      );
    }
    case 'ready': {
      // A record is never changed, so a record that states no outcome, one this version cannot read, or no record at
      // all cannot be read into one.
      const retryable =
        status.outcome?.status === 'unavailable' &&
        status.outcome.reason !== 'no_record' &&
        status.outcome.reason !== 'no_outcome' &&
        status.outcome.reason !== 'malformed';
      // An outcome read that ended in 401 needs a new session; Try again would repeat the 401.
      const signInNeeded =
        status.outcome?.status === 'unavailable' && status.outcome.reason === 'unauthorized';
      return (
        <>
          <p role="status" className="nc-live">
            {stateText(status.state, t)}
            {status.refreshing ? ` ${t('statusUpdating')}` : ''}
          </p>
          {/* The reads that would see a change are failing, or the updates stopped: what is shown may have moved on. */}
          {status.stale ? <p className="nc-muted">{t('statusStale')}</p> : null}
          <dl className="nc-facts">
            <Fact term={t('statusFactState')}>{stateText(status.state, t)}</Fact>
            <Fact term={t('statusFactSince')}>
              <time dateTime={status.since}>{formatTime(status.since, t)}</time>
            </Fact>
            {status.pendingOn === undefined ? null : (
              <Fact term={t('statusFactWaitingOn')}>{waitingOnText(status.pendingOn, t)}</Fact>
            )}
            <Fact term={t('statusFactOnDeny')}>{onDenyText(status.onDeny, t)}</Fact>
            {status.outcome === undefined ? null : (
              <Fact term={t('statusFactOutcome')}>{outcomeText(status.outcome, t)}</Fact>
            )}
          </dl>
          {status.outcome?.status === 'unavailable' && status.outcome.error !== undefined ? (
            <RequestIdLine error={status.outcome.error} t={t} />
          ) : null}
          {retryable ? (
            <Button
              type="button"
              variant="secondary"
              onClick={signInNeeded ? (onSignIn ?? retry) : retry}
            >
              {signInNeeded ? t('signInAgain') : t('statusRetry')}
            </Button>
          ) : null}
        </>
      );
    }
  }
}
