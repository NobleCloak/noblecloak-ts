import { useEffect, useRef, useState } from 'react';

import type { ApprovalsController, ManyResult } from '../approvals-types.js';
import { ErrorMessage } from './error-message.js';
import type { Translate } from './labels.js';
import { useNc } from './slots.js';

export interface BatchBarProps {
  readonly controller: ApprovalsController;
  readonly t: Translate;
  /** The ids chosen in the queue, in the order the queue lists them. */
  readonly selected: readonly string[];
  /** The digest each queue row has now, by id; the one a row has when the person confirms is what the batch sends. */
  readonly digests: ReadonlyMap<string, string>;
  /** Called once the call has ended, with what to say in the live region; the chosen ids are then dropped. */
  readonly onDone: (message: string) => void;
  readonly onSignIn: () => void;
}

/** What the live region says of a finished batch: how many were approved, and that the rest were not. */
export function batchMessage(result: ManyResult, t: Translate): string {
  if (!result.ok) return t('batchFailed');
  const approved = result.results.filter((r) => r.ok).length;
  const failed = result.results.length - approved;
  if (approved === 0) return t('batchFailed');
  return failed === 0 ? t('batchAllApproved', { approved }) : t('batchDone', { approved, failed });
}

/**
 * "Approve selected": a button that names the count, then a confirmation that says the requests are approved as
 * listed and without being opened, then the call. The component holds only the confirm step and the error of the
 * call; the queue, the digests and the results are the controller's.
 */
export function BatchBar({ controller, t, selected, digests, onDone, onSignIn }: BatchBarProps) {
  const { Button } = useNc();
  const canApproveMany = controller.approveMany !== undefined;
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Extract<ManyResult, { ok: false }>['error'] | undefined>(
    undefined
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A selection that empties or changes leaves the confirmation behind: it names a count that is no longer true.
  const count = selected.length;
  // The digests of the rows as they were when the confirmation opened: a row that changes after is not approved.
  const shown = useRef<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    setConfirming(false);
  }, [count]);
  if (!canApproveMany || (count === 0 && failure === undefined)) return null;

  const send = (): void => {
    setSending(true);
    setFailure(undefined);
    void controller.approveMany?.(selected, shown.current).then((result) => {
      if (!mounted.current) return;
      setSending(false);
      setConfirming(false);
      if (!result.ok) setFailure(result.error);
      onDone(batchMessage(result, t));
    });
  };

  return (
    <div className="nc-batch">
      {failure === undefined ? null : (
        <ErrorMessage error={failure} t={t} context="decision" onSignIn={onSignIn} />
      )}
      {count === 0 ? null : sending ? (
        <p role="status" aria-busy="true">
          {t('batchSending')}
        </p>
      ) : confirming ? (
        <div role="group" aria-label={t('batchApproveSelected', { count })}>
          <p>{t('batchPrompt', { count })}</p>
          <Button type="button" onClick={send}>
            {t('batchConfirm', { count })}
          </Button>{' '}
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setConfirming(false);
            }}
          >
            {t('batchCancel')}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            shown.current = new Map(selected.map((id) => [id, digests.get(id) ?? '']));
            setConfirming(true);
          }}
        >
          {t('batchApproveSelected', { count })}
        </Button>
      )}
    </div>
  );
}
