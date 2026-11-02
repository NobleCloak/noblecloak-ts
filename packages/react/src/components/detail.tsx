import { useEffect, useMemo, useState } from 'react';
import type { ReactNode, Ref } from 'react';

import type {
  ApprovalDetailState,
  ApprovalSummary,
  ApprovalsController,
} from '../approvals-types.js';
import { Actions } from './actions.js';
import { CallView, callIsWhole, formatCall } from './call-view.js';
import { ErrorMessage } from './error-message.js';
import { clipText, formatTime } from './format.js';
import type { Translate } from './labels.js';
import { escapeInvisible } from './format-json.js';
import { Safe } from './safe.js';
import { useNc } from './slots.js';
import { levelWord, obligationWord, principalText } from './words.js';

export interface DetailProps {
  readonly detail: ApprovalDetailState;
  /** What the detail itself calls: the retry of a failed read. */
  readonly controller: Pick<ApprovalsController, 'retryDetail'>;
  /**
   * What decides the request. Without it the detail is read-only: no Approve, no Deny. `<Approvals />` passes
   * its controller; `<ApprovalRequest />` passes none.
   */
  readonly decide?: Pick<ApprovalsController, 'approve' | 'deny' | 'resolving'>;
  readonly t: Translate;
  readonly headingId: string;
  readonly headingRef: Ref<HTMLHeadingElement>;
  /** Without it the detail shows no Close button (a request shown on its own page has nothing to close back to). */
  readonly onClose?: () => void;
  readonly reason: string;
  readonly onReasonChange: (reason: string) => void;
  readonly onSignIn: () => void;
  readonly onCopyResult: (copied: boolean) => void;
  readonly onResolved: (id: string, decision: 'approved' | 'denied') => void;
}

/** States in which an approval is spent, so its detail is digest-only. `approved` is not one: it may still carry arguments. */
const FINAL_STATES: ReadonlySet<string> = new Set(['consumed', 'rejected', 'expired', 'withdrawn']);

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="nc-fact">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * `policy` read as optional, so a row without one renders. Remove this helper and read `approval.policy`
 * directly once the generated client types make `policy` optional.
 */
function optionalPolicy(
  approval: Omit<ApprovalSummary, 'policy'> & { readonly policy?: ApprovalSummary['policy'] }
): ApprovalSummary['policy'] | undefined {
  return approval.policy;
}

/**
 * The seconds until the store retries. The store reports `retryingInMs` once, when it enters the state, so
 * the deadline is taken then and the text counts down from it each second, to "Trying again now…" at zero.
 * `since` is the detail object: a fresh one (a new retry) restarts the count.
 */
function RetryCountdown({
  retryingInMs,
  since,
  t,
}: {
  readonly retryingInMs: number;
  readonly since: ApprovalDetailState;
  readonly t: Translate;
}) {
  const [deadline, setDeadline] = useState(() => Date.now() + retryingInMs);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setDeadline(Date.now() + retryingInMs);
    setNow(Date.now());
  }, [retryingInMs, since]);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <p>{seconds === 0 ? t('detailRetryingNow') : t('detailRetryCountdown', { seconds })}</p>;
}

function Time({ value, t }: { readonly value: string; readonly t: Translate }) {
  return <time dateTime={value}>{formatTime(value, t)}</time>;
}

/** What an approval says about itself, as text. It never reads `arguments`, `continuation` or `outcome_record_id`. */
function Facts({ approval, t }: { readonly approval: ApprovalSummary; readonly t: Translate }) {
  const { agent, run, waiting_on: waitingOn } = approval;
  const policy = optionalPolicy(approval);
  return (
    <dl className="nc-facts">
      <Fact term={t('factTool')}>
        <Safe>{approval.tool_ref}</Safe>
      </Fact>
      <Fact term={t('factLevel')}>{levelWord(approval.side_effect_level, t)}</Fact>
      <Fact term={t('factKind')}>{obligationWord(approval.obligation_kind, t)}</Fact>
      {approval.requester === undefined ? null : (
        <Fact term={t('factRequester')}>
          <Safe>{principalText(approval.requester)}</Safe>
        </Fact>
      )}
      {waitingOn === undefined ? null : (
        <Fact term={t('factWaitingOn')}>
          {String(waitingOn.count)}
          {waitingOn.principals === undefined || waitingOn.principals.length === 0 ? null : (
            <>
              {': '}
              <Safe>{waitingOn.principals.map(principalText).join(', ')}</Safe>
            </>
          )}
        </Fact>
      )}
      {agent === undefined ? null : (
        <Fact term={t('factAgent')}>
          <Safe>
            {principalText({
              id: agent.id,
              ...(agent.name === undefined ? {} : { display_name: agent.name }),
            })}
          </Safe>
          {agent.parent === undefined || agent.parent === null ? null : (
            <>
              {' ('}
              <bdi>{t('factAgentParent', { parent: escapeInvisible(agent.parent) })}</bdi>
              {')'}
            </>
          )}
        </Fact>
      )}
      {run === undefined ? null : (
        <Fact term={t('factRun')}>
          <Safe>{run.id}</Safe> (<bdi>{t('factRunKind', { kind: escapeInvisible(run.kind) })}</bdi>)
        </Fact>
      )}
      <Fact term={t('factScope')}>
        <Safe>{approval.scope_id}</Safe>
      </Fact>
      {policy === undefined ? null : (
        <Fact term={t('factPolicy')}>
          <Safe>{policy.id}</Safe> (
          <bdi>{t('factPolicyVersion', { version: escapeInvisible(String(policy.version)) })}</bdi>)
        </Fact>
      )}
      {approval.continuation_kind === undefined ? null : (
        <Fact term={t('factContinuation')}>
          <Safe>{approval.continuation_kind}</Safe>
        </Fact>
      )}
      <Fact term={t('factCreated')}>
        <Time value={approval.created_at} t={t} />
      </Fact>
      {approval.expires_at === undefined || approval.expires_at === null ? null : (
        <Fact term={t('factExpires')}>
          <Time value={approval.expires_at} t={t} />
        </Fact>
      )}
    </dl>
  );
}

function History({ approval, t }: { readonly approval: ApprovalSummary; readonly t: Translate }) {
  const history = approval.resolution_history;
  if (history === undefined || history.length === 0) return null;
  return (
    <section>
      <h4>{t('historyHeading')}</h4>
      <ol>
        {history.map((entry, index) => (
          <li key={`${String(index)}-${entry.at}`}>
            <bdi>
              {t('historyEntry', {
                resolution: escapeInvisible(entry.resolution),
                by: escapeInvisible(principalText(entry.by)),
              })}
            </bdi>{' '}
            <Time value={entry.at} t={t} />
            {entry.reason === undefined || entry.reason === '' ? null : (
              <p>
                <Safe>{entry.reason}</Safe>
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Outcome({ approval, t }: { readonly approval: ApprovalSummary; readonly t: Translate }) {
  return (
    <dl className="nc-facts">
      <Fact term={t('factState')}>
        <Safe>{approval.state}</Safe>
      </Fact>
      <Fact term={t('factOutcome')}>
        <Safe>{approval.resolution ?? approval.state}</Safe>
      </Fact>
      {approval.approver === undefined ? null : (
        <Fact term={t('factDecidedBy')}>
          <Safe>{principalText(approval.approver)}</Safe>
        </Fact>
      )}
      {approval.resolved_at === undefined || approval.resolved_at === null ? null : (
        <Fact term={t('factDecidedAt')}>
          <Time value={approval.resolved_at} t={t} />
        </Fact>
      )}
    </dl>
  );
}

/** The open detail: a heading that takes focus, then the content for the detail's status. */
export function Detail({
  detail,
  controller,
  decide,
  t,
  headingId,
  headingRef,
  onClose,
  reason,
  onReasonChange,
  onSignIn,
  onCopyResult,
  onResolved,
}: DetailProps) {
  const { Alert, Button, Card } = useNc();
  const approval = 'approval' in detail ? detail.approval : undefined;
  // Local view state, one per open detail (`Approvals` keys this component by the id). Whether the whole call
  // is on screen is decided here, so the call it shows and the actions it enables read the same result.
  const [showAll, setShowAll] = useState(false);
  const detailArguments = 'arguments' in detail ? detail.arguments : undefined;
  const argumentsSource = 'argumentsSource' in detail ? detail.argumentsSource : undefined;
  const shown = useMemo(
    () => formatCall(detailArguments, showAll, t, argumentsSource),
    [detailArguments, argumentsSource, showAll, t]
  );
  // The digest the person has been looking at. A later digest means the request changed under them: they are
  // told, and Approve and Deny stay off until they acknowledge it, so no decision rides on a glance at the old one.
  const [reviewedDigest, setReviewedDigest] = useState<string | undefined>(undefined);
  const currentDigest = approval?.action_digest;
  if (reviewedDigest === undefined && currentDigest !== undefined) setReviewedDigest(currentDigest);
  const digestChanged =
    reviewedDigest !== undefined && currentDigest !== undefined && currentDigest !== reviewedDigest;
  const heading = approval?.tool_ref ?? t('detailHeadingFallback');

  let body: ReactNode = null;
  switch (detail.status) {
    case 'loading':
      body = (
        <p role="status" aria-busy="true">
          {t('detailLoading')}
        </p>
      );
      break;
    case 'not_found':
      body = <p>{t('detailNotFound')}</p>;
      break;
    case 'unavailable':
      body = (
        <div>
          <p role="alert">{t('detailUnavailable')}</p>
          {detail.retryingInMs === undefined ? null : (
            <RetryCountdown retryingInMs={detail.retryingInMs} since={detail} t={t} />
          )}
          {detail.error.requestId === undefined ? null : (
            <p className="nc-muted">
              {t('requestId', { requestId: escapeInvisible(detail.error.requestId) })}
            </p>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              controller.retryDetail();
            }}
          >
            {t('detailRetryNow')}
          </Button>
        </div>
      );
      break;
    case 'forbidden':
      body = (
        <div role="alert">
          <p>{t('detailForbidden')}</p>
          {detail.error.requestId === undefined ? null : (
            <p className="nc-muted">
              {t('requestId', { requestId: escapeInvisible(detail.error.requestId) })}
            </p>
          )}
        </div>
      );
      break;
    case 'unauthorized':
      body = <ErrorMessage error={detail.error} t={t} onSignIn={onSignIn} />;
      break;
    case 'error':
      body = (
        <div>
          <ErrorMessage error={detail.error} t={t} onSignIn={onSignIn} />
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              controller.retryDetail();
            }}
          >
            {t('detailRetryNow')}
          </Button>
        </div>
      );
      break;
    case 'refreshing':
    case 'loaded':
    case 'resolved': {
      const resolved = detail.status === 'resolved';
      const phase = !resolved
        ? 'open'
        : FINAL_STATES.has(detail.approval.state)
          ? 'final'
          : 'unreturned';
      body = (
        <>
          {detail.status === 'refreshing' ? (
            <p role="status" aria-busy="true">
              {t('detailRefreshing')}
            </p>
          ) : null}
          {digestChanged && !resolved ? (
            <Alert variant="danger" role="alert" className="nc-error">
              <p>{t('errorConflict')}</p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setReviewedDigest(currentDigest);
                }}
              >
                {t('digestChangedAcknowledge')}
              </Button>
            </Alert>
          ) : null}
          <Facts approval={detail.approval} t={t} />
          {resolved ? <Outcome approval={detail.approval} t={t} /> : null}
          <CallView
            arguments={detail.arguments}
            shown={shown}
            showAll={showAll}
            onShowAll={() => {
              setShowAll(true);
            }}
            digest={detail.approval.action_digest}
            phase={phase}
            {...(detail.approval.arguments_state === undefined
              ? {}
              : { argumentsState: detail.approval.arguments_state })}
            t={t}
            onCopyResult={onCopyResult}
          />
          <History approval={detail.approval} t={t} />
          {resolved || decide === undefined ? null : (
            <Actions
              controller={decide}
              approval={detail.approval}
              enabled={detail.status === 'loaded' && callIsWhole(shown) && !digestChanged}
              t={t}
              reason={reason}
              onReasonChange={onReasonChange}
              onSignIn={onSignIn}
              onResolved={onResolved}
            />
          )}
        </>
      );
      break;
    }
  }

  return (
    <Card role="region" className="nc-detail" aria-labelledby={headingId}>
      <h3 id={headingId} ref={headingRef} tabIndex={-1}>
        <bdi>{escapeInvisible(clipText(heading))}</bdi>
      </h3>
      {body}
      {onClose === undefined ? null : (
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('detailClose')}
        </Button>
      )}
    </Card>
  );
}
