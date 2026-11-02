import type { ApprovalSummary, ApprovalsController } from '../approvals-types.js';
import { ErrorMessage } from './error-message.js';
import { clipText, formatAge } from './format.js';
import { escapeInvisible } from './format-json.js';
import type { Translate } from './labels.js';
import { Safe } from './safe.js';
import { useNc } from './slots.js';
import { principalText } from './words.js';

export interface RecentProps {
  readonly controller: ApprovalsController;
  readonly t: Translate;
  readonly now: number;
  readonly headingId: string;
  readonly onSelect: (id: string) => void;
  readonly onSignIn: () => void;
}

/** The outcome of a decided request as a sentence: what it was resolved as, and by whom when the service says. */
function outcomeText(approval: ApprovalSummary, t: Translate): string {
  const resolution = escapeInvisible(approval.resolution ?? approval.state);
  return approval.approver === undefined
    ? t('rowDecidedNobody', { resolution })
    : t('rowDecidedBy', { resolution, name: escapeInvisible(principalText(approval.approver)) });
}

/** The recently decided requests, newest decision first, with "Show older". Rows open the same detail as the queue's. */
export function Recent({ controller, t, now, headingId, onSelect, onSignIn }: RecentProps) {
  const { Button } = useNc();
  const recent = controller.recent;
  const loading = recent === undefined || recent.status === 'idle' || recent.status === 'loading';
  const approvals = recent?.approvals ?? [];
  return (
    <div className="nc-recent">
      <h2 id={headingId} tabIndex={-1}>
        {t('recentHeading')}
      </h2>
      {recent?.status === 'error' && recent.error !== undefined ? (
        <div>
          <ErrorMessage error={recent.error} t={t} onSignIn={onSignIn} />
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void controller.loadRecent?.();
            }}
          >
            {t('recentRetry')}
          </Button>
        </div>
      ) : null}
      {loading && approvals.length === 0 ? <p aria-busy="true">{t('recentLoading')}</p> : null}
      {recent?.status === 'ready' && approvals.length === 0 ? <p>{t('recentEmpty')}</p> : null}
      {approvals.length > 0 ? (
        <ul className="nc-rows" aria-labelledby={headingId}>
          {approvals.map((approval) => (
            <li key={approval.id}>
              <Button
                type="button"
                variant="secondary"
                className="nc-row"
                onClick={() => {
                  onSelect(approval.id);
                }}
              >
                <span className="nc-row-tool">
                  <Safe>{clipText(approval.tool_ref)}</Safe>
                </span>
                <span>
                  <bdi>{outcomeText(approval, t)}</bdi>
                </span>
                {approval.resolved_at === undefined || approval.resolved_at === null ? null : (
                  <span className="nc-muted">{formatAge(approval.resolved_at, now, t)}</span>
                )}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {recent?.more === true ? (
        <Button
          type="button"
          variant="secondary"
          disabled={recent.loadingMore}
          onClick={() => {
            void controller.loadMoreRecent?.();
          }}
        >
          {t('recentShowMore')}
        </Button>
      ) : null}
    </div>
  );
}
