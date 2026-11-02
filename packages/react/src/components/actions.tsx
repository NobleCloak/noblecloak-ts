import { useEffect, useRef, useState } from 'react';

import type {
  ApprovalSummary,
  ApprovalsController,
  ApprovalsError,
  ResolveResult,
} from '../approvals-types.js';
import { reportFault } from '../fault.js';
import { ErrorMessage } from './error-message.js';
import type { Translate } from './labels.js';
import { useNc } from './slots.js';
import { levelWord } from './words.js';

/** The reason box takes at most this many characters. A limit of this page, not of the contract. */
const REASON_MAX = 2000;

/** Approving a call at these levels asks for a second click. Denying never does. */
const CONFIRM_LEVELS: ReadonlySet<string> = new Set(['delete', 'admin']);

/** The error shown when `approve` or `deny` throws instead of returning a result. */
const decisionThrew = (cause: unknown): ApprovalsError => ({
  kind: 'unavailable',
  code: 'controller_threw',
  local: true,
  title: 'The decision could not be sent',
  cause,
});

export interface ActionsProps {
  readonly controller: Pick<ApprovalsController, 'approve' | 'deny' | 'resolving'>;
  readonly approval: ApprovalSummary;
  /** True only while the detail is `loaded`. */
  readonly enabled: boolean;
  readonly t: Translate;
  /** The reason typed so far. It lives above this component so a reload of the detail does not lose it. */
  readonly reason: string;
  readonly onReasonChange: (reason: string) => void;
  readonly onSignIn: () => void;
  readonly onResolved: (id: string, decision: 'approved' | 'denied') => void;
}

/**
 * The reason box, Approve and Deny, the confirm step and the error of a failed decision. The reason is
 * held by the parent; the confirm step, the error and the busy flag are local, and reset when the
 * detail leaves loaded/refreshing/resolved and comes back.
 */
export function Actions({
  controller,
  approval,
  enabled,
  t,
  reason,
  onReasonChange,
  onSignIn,
  onResolved,
}: ActionsProps) {
  const { Button, Textarea } = useNc();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApprovalsError | undefined>(undefined);
  const mounted = useRef(true);
  const approveRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const focusError = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (error !== undefined && focusError.current) {
      focusError.current = false;
      errorRef.current?.focus();
    }
  }, [error]);

  // A detail that leaves `loaded` takes the confirm step with it.
  useEffect(() => {
    if (!enabled) setConfirming(false);
  }, [enabled]);

  const inFlight = busy || controller.resolving.has(approval.id);
  const canDecide = enabled && approval.state === 'pending' && !inFlight;

  const decide = async (decision: 'approved' | 'denied'): Promise<void> => {
    if (!canDecide) return;
    setBusy(true);
    setError(undefined);
    setConfirming(false);
    const options = reason.trim() === '' ? undefined : { reason };
    let result: ResolveResult;
    try {
      result =
        decision === 'approved'
          ? await controller.approve(approval.id, options)
          : await controller.deny(approval.id, options);
    } catch (thrown) {
      // The controller's type promises a result, but a host-supplied one can throw. The person is told, and
      // the buttons come back, rather than the component staying busy with an unhandled rejection.
      result = { ok: false, error: decisionThrew(thrown) };
    }
    // The decision happened whether or not this component is still on screen (a stream event can turn the
    // detail resolved mid-flight and unmount it), so the parent is always told. Only this component's own
    // state is skipped once it is gone.
    if (result.ok) {
      try {
        onResolved(approval.id, decision);
      } catch (fault) {
        reportFault(fault);
      }
    }
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) {
      focusError.current = true;
      setError(result.error);
    }
  };

  const needsConfirm = CONFIRM_LEVELS.has(approval.side_effect_level);

  return (
    <div className="nc-actions">
      <label>
        {t('reasonLabel')}
        <Textarea
          value={reason}
          maxLength={REASON_MAX}
          rows={3}
          disabled={!canDecide}
          onChange={(event) => {
            onReasonChange(event.target.value);
          }}
        />
      </label>
      {error === undefined ? null : (
        <ErrorMessage ref={errorRef} error={error} t={t} context="decision" onSignIn={onSignIn} />
      )}
      {inFlight ? <p className="nc-muted">{t('sending')}</p> : null}
      {confirming ? (
        <div role="group" aria-label={t('confirmApprove')}>
          <p>{t('confirmPrompt', { level: levelWord(approval.side_effect_level, t) })}</p>
          <Button
            type="button"
            ref={confirmRef}
            disabled={!canDecide}
            onClick={() => {
              void decide('approved');
            }}
          >
            {t('confirmApprove')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setConfirming(false);
              approveRef.current?.focus();
            }}
          >
            {t('confirmCancel')}
          </Button>
        </div>
      ) : null}
      <div className="nc-buttons">
        <Button
          type="button"
          ref={approveRef}
          disabled={!canDecide}
          onClick={() => {
            if (needsConfirm) setConfirming(true);
            else void decide('approved');
          }}
        >
          {t('approve')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!canDecide}
          onClick={() => {
            void decide('denied');
          }}
        >
          {t('deny')}
        </Button>
      </div>
    </div>
  );
}
