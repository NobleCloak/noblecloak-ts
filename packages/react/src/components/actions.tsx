import { useEffect, useRef, useState } from 'react';

import type {
  ApprovalSummary,
  ApprovalsController,
  ApprovalsError,
  ResolveResult,
} from '../approvals-types.js';
import { reportFault } from '../fault.js';
import { ErrorMessage } from './error-message.js';
import { clipText } from './format.js';
import type { Translate } from './labels.js';
import { sha256Hex } from './sha256.js';
import { useNc } from './slots.js';
import { levelWord } from './words.js';

/** The reason box takes at most this many characters. A limit of this page, not of the contract. */
const REASON_MAX = 2000;

/** Approving a call at these levels asks for a second click. Denying never does. */
const CONFIRM_LEVELS: ReadonlySet<string> = new Set(['delete', 'admin']);

/** Unicode isolates (U+2068, U+2069): they keep a name from the service from reordering the sentence around it. */
const ISOLATE_START = String.fromCodePoint(0x2068);
const ISOLATE_END = String.fromCodePoint(0x2069);

/** A reference longer than this is shown as its start, its end, its length and a digest. COO digests names past 256. */
const EXACT_REF_MAX = 256;
const EXACT_REF_START = 120;
const EXACT_REF_END = 60;

/**
 * The tool reference for the confirm line, made of printable ASCII only: every other character (look-alikes,
 * blanks, controls) and the backslash are shown as escapes, so what is read is exactly what was sent. Over
 * `EXACT_REF_MAX` characters the start and the end are shown with the length and the first 8 hex digits of the
 * SHA-256 of the whole, so two long references that differ anywhere, the middle included, read differently; the
 * whole reference is in the details.
 */
function exactRefLine(toolRef: unknown, t: Translate): string {
  const ascii = (text: string): string =>
    Array.from(text)
      .map((char) => {
        const code = char.codePointAt(0) ?? 0;
        if (code >= 0x20 && code < 0x7f && char !== '\\') return char;
        const hex = code.toString(16).toUpperCase();
        return char === '\\'
          ? '\\\\'
          : hex.length <= 4
            ? `\\u${hex.padStart(4, '0')}`
            : `\\u{${hex}}`;
      })
      .join('');
  const isolated = (text: string): string => `${ISOLATE_START}${ascii(text)}${ISOLATE_END}`;
  const chars = Array.from(clipText(toolRef, Number.POSITIVE_INFINITY));
  if (chars.length <= EXACT_REF_MAX) return t('confirmToolRef', { ref: isolated(chars.join('')) });
  return t('confirmToolRefLong', {
    length: String(chars.length),
    digest: sha256Hex(chars.join('')).slice(0, 8),
    start: isolated(chars.slice(0, EXACT_REF_START).join('')),
    end: isolated(chars.slice(-EXACT_REF_END).join('')),
  });
}

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
  /** What the request is, in words (`requestTitle`, already escaped): the confirm dialog names it. */
  readonly title: string;
  /** True only while the detail is `loaded`. */
  readonly enabled: boolean;
  /**
   * Why the buttons are off when the detail is loaded: the call above is not on screen in full (`call`), or the request
   * changed and the change is not acknowledged (`changed`). The group says so, because the buttons are pinned below
   * and the cause is otherwise a screen away.
   */
  readonly offReason?: 'call' | 'changed' | undefined;
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
  title,
  enabled,
  offReason,
  t,
  reason,
  onReasonChange,
  onSignIn,
  onResolved,
}: ActionsProps) {
  const { Button, ConfirmDialog, Textarea } = useNc();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApprovalsError | undefined>(undefined);
  const mounted = useRef(true);
  // True from a press of Confirm until the dialog reports closed, so that close does not move focus.
  const confirmed = useRef(false);
  // Set when the dialog closed by Cancel or Escape: Approve takes focus once the dialog is off the page.
  const returnFocus = useRef(false);
  const approveRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const focusError = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (error !== undefined && focusError.current) {
      focusError.current = false;
      errorRef.current?.focus();
    }
  }, [error]);

  const inFlight = busy || controller.resolving.has(approval.id);
  const canDecide = enabled && approval.state === 'pending' && !inFlight;

  useEffect(() => {
    if (!confirming && returnFocus.current) {
      returnFocus.current = false;
      approveRef.current?.focus();
    }
  }, [confirming]);

  // The confirm step lasts only while a decision could be sent: a detail that leaves `loaded`, a changed digest, a
  // request no longer pending or a decision already on its way takes it away, so a stale confirmation is never answered.
  useEffect(() => {
    if (!canDecide) setConfirming(false);
  }, [canDecide]);

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
    // Pinned to the bottom of the detail while the call above it is longer than the screen, so a decision never
    // sits below the payload. The reason box and the buttons are one group, named for a screen reader.
    <div className="nc-actions" role="group" aria-label={t('decisionLabel')}>
      <label>
        {t('reasonLabel')}
        <Textarea
          value={reason}
          maxLength={REASON_MAX}
          rows={2}
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
      {offReason === undefined ? null : (
        <p className="nc-muted">
          {t(offReason === 'call' ? 'decisionCallNotWhole' : 'decisionDigestChanged')}
        </p>
      )}
      {/* Rendered only while confirming: a closed native dialog keeps its buttons in the tree. It is a modal
          (focus held inside, Escape cancels, the page behind is inert) that names what is being approved. */}
      {confirming ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            setConfirming(false);
            // Back to Approve after a Cancel or Escape, not after a confirm: that one has its own focus (the
            // error of a failed decision, or the queue once the request is gone). It waits for the dialog to
            // leave the page: a modal keeps everything behind it from taking focus.
            returnFocus.current = !confirmed.current;
            confirmed.current = false;
          }}
          title={t('confirmHeading')}
          description={`${t('confirmRequest', { request: `${ISOLATE_START}${title}${ISOLATE_END}` })} ${exactRefLine(approval.tool_ref, t)} ${t('confirmPrompt', { level: levelWord(approval.side_effect_level, t) })}`}
          confirmLabel={t('confirmApprove')}
          cancelLabel={t('confirmCancel')}
          onConfirm={async () => {
            confirmed.current = true;
            await decide('approved');
          }}
        />
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
