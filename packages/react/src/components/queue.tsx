import { batchBlock, type BatchBlock } from '../approvals-batch.js';
import type { Ref } from 'react';

import type { ApprovalsConnection, ApprovalsController } from '../approvals-types.js';
import { ErrorMessage } from './error-message.js';
import { clipText, formatAge } from './format.js';
import type { ApprovalsLabelKey, Translate } from './labels.js';
import { requestTitle, requestVia } from './request-title.js';
import { Safe } from './safe.js';
import { useNc } from './slots.js';
import { levelWord } from './words.js';

const CONNECTION_LABEL: Readonly<Record<ApprovalsConnection, ApprovalsLabelKey>> = {
  connecting: 'connectionConnecting',
  live: 'connectionLive',
  polling: 'connectionPolling',
  offline: 'connectionOffline',
};

export interface QueueProps {
  readonly controller: ApprovalsController;
  readonly t: Translate;
  readonly now: number;
  readonly headingId: string;
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly rowRef: (id: string, element: HTMLButtonElement | null) => void;
  readonly onSelect: (id: string) => void;
  readonly onSignIn: () => void;
  /** The ids chosen for "Approve selected"; a controller with no `approveMany` shows no checkboxes. */
  readonly chosen?: ReadonlySet<string>;
  readonly onChoose?: (id: string, chosen: boolean) => void;
}

/**
 * The queue: a heading, the connection in words, the rows, and the loading and error states. The empty
 * and count text is not here: it is in the live region of `Approvals`.
 */
export function Queue({
  controller,
  t,
  now,
  headingId,
  headingRef,
  rowRef,
  onSelect,
  onSignIn,
  chosen,
  onChoose,
}: QueueProps) {
  const { Button, Checkbox } = useNc();
  const { approvals, status, error, connection, truncated, resolving, detail } = controller;
  const loading = status === 'idle' || status === 'loading';
  const choosable =
    controller.approveMany !== undefined && chosen !== undefined && onChoose !== undefined;
  return (
    <div className="nc-queue">
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>
        {t('queueHeading')}
      </h2>
      <p className="nc-muted">{t(CONNECTION_LABEL[connection])}</p>
      {/* A failure the store is retrying (a capabilities 503 leaves the status at loading) shows too. */}
      {status === 'error' || error !== undefined ? (
        <div>
          {error === undefined ? null : <ErrorMessage error={error} t={t} onSignIn={onSignIn} />}
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void controller.refresh();
            }}
          >
            {t('queueRetry')}
          </Button>
        </div>
      ) : null}
      {loading && approvals.length === 0 ? <p aria-busy="true">{t('queueLoading')}</p> : null}
      {approvals.length > 0 ? (
        <ul className="nc-rows" aria-labelledby={headingId}>
          {approvals.map((approval) => {
            const selected = detail?.id === approval.id;
            const block = batchBlock(approval);
            return (
              <li key={approval.id}>
                {choosable && block === undefined ? (
                  <label className="nc-choose">
                    <Checkbox
                      checked={chosen.has(approval.id)}
                      disabled={resolving.has(approval.id)}
                      onChange={(event) => {
                        onChoose(approval.id, event.currentTarget.checked);
                      }}
                    />
                    <span className="nc-visually-hidden">
                      {t('rowSelect', { tool: requestTitle(approval, t) })}
                    </span>
                  </label>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  className="nc-row"
                  data-approval-id={approval.id}
                  aria-current={selected ? 'true' : undefined}
                  ref={(element) => {
                    rowRef(approval.id, element);
                  }}
                  onClick={() => {
                    onSelect(approval.id);
                  }}
                >
                  <span className="nc-row-tool">
                    <bdi>{requestTitle(approval, t)}</bdi>
                  </span>{' '}
                  {/* The whole reference, so two tools that read alike are told apart in the row that can be approved. */}
                  <code className="nc-muted nc-row-ref">
                    <Safe>{clipText(approval.tool_ref)}</Safe>
                  </code>{' '}
                  <span className="nc-muted">
                    {t('rowLevel', { level: levelWord(approval.side_effect_level, t) })}
                    {' · '}
                    {formatAge(approval.created_at, now, t)}
                    {requestVia(approval, t) === undefined ? null : (
                      <>
                        {' · '}
                        <bdi>{requestVia(approval, t)}</bdi>
                      </>
                    )}
                  </span>{' '}
                  {/* Said in words, in the row, so a person who cannot see that the box is missing still learns why. */}
                  {choosable && block !== undefined ? (
                    <>
                      <span className="nc-muted">{t(noBatchKey(block))}</span>{' '}
                    </>
                  ) : null}
                  {resolving.has(approval.id) ? (
                    <>
                      <span className="nc-muted">{t('rowSending')}</span>{' '}
                    </>
                  ) : null}
                  <span className="nc-row-open">{t('rowOpen')}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {truncated ? <p>{t('queueTruncated')}</p> : null}
      {truncated && controller.loadMore !== undefined ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void controller.loadMore?.();
          }}
        >
          {t('queueShowMore')}
        </Button>
      ) : null}
    </div>
  );
}

function noBatchKey(
  block: BatchBlock | undefined
): 'rowNoBatchReadable' | 'rowNoBatchWithheld' | 'rowNoBatchUnknown' {
  if (block === 'readable') return 'rowNoBatchReadable';
  if (block === 'withheld') return 'rowNoBatchWithheld';
  return 'rowNoBatchUnknown';
}
