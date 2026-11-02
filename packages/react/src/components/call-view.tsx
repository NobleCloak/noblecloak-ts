import { useId } from 'react';

import type { JsonObject } from '../approvals-types.js';
import { escapeInvisible, formatJson, isWhole } from './format-json.js';
import type { FormattedJson } from './format-json.js';
import type { ApprovalsLabelKey, Translate } from './labels.js';
import { Safe } from './safe.js';
import { useNc } from './slots.js';

/** The first view cuts the text here and shows nesting deeper than `MAX_DEPTH` as a count; "Show all" lifts both. */
export const INITIAL_CHARS = 4000;
const MAX_DEPTH = 8;

const DIGEST_ONLY_LABEL = {
  open: 'callDigestOnlyLoaded',
  final: 'callDigestOnlyResolved',
  unreturned: 'callNoArgumentsReturned',
} as const satisfies Record<CallViewProps['phase'], ApprovalsLabelKey>;

/**
 * Why the call is not shown, when the service said so (`Approval.arguments_state`, contract rev 6): the
 * sentence for that reason, else the one for the phase. `shown` with no arguments, a state this version does
 * not know and an absent one claim no reason. A `final` approval keeps the phase's sentence, which says the
 * same, in the words for an approval that is spent.
 */
const REASON_LABEL: Readonly<Record<string, ApprovalsLabelKey>> = {
  not_enabled: 'callNotEnabled',
  not_sent: 'callNotSent',
  withheld: 'callWithheld',
};

export function digestOnlyLabel(
  phase: CallViewProps['phase'],
  argumentsState: string | undefined
): ApprovalsLabelKey {
  // Only while the person is deciding or the approval is approved but not spent: a spent one says it is spent.
  if (
    phase !== 'final' &&
    argumentsState !== undefined &&
    Object.hasOwn(REASON_LABEL, argumentsState)
  )
    return REASON_LABEL[argumentsState] ?? DIGEST_ONLY_LABEL[phase];
  return DIGEST_ONLY_LABEL[phase];
}

/**
 * The arguments as text, in the first view or (`showAll`) in full. The detail holds `showAll` and calls this,
 * so the call it shows and the actions it enables read the same result.
 */
export function formatCall(
  args: JsonObject | undefined,
  showAll: boolean,
  t: Translate,
  source?: string
): FormattedJson | undefined {
  if (args === undefined) return undefined;
  return formatJson(
    args,
    {
      maxChars: showAll ? Infinity : INITIAL_CHARS,
      maxDepth: showAll ? Infinity : MAX_DEPTH,
      summary: {
        items: (count) => t('jsonMoreItems', { count }),
        members: (count) => t('jsonMoreMembers', { count }),
      },
    },
    source
  );
}

/** Whether the approver can be shown the whole call: true for a digest-only call, which has nothing to show. */
export const callIsWhole = (shown: FormattedJson | undefined): boolean =>
  shown === undefined || isWhole(shown);

export interface CallViewProps {
  readonly arguments: JsonObject | undefined;
  /** `formatCall` of `arguments`. */
  readonly shown: FormattedJson | undefined;
  readonly showAll: boolean;
  readonly onShowAll: () => void;
  readonly digest: string;
  /**
   * Which sentence explains missing arguments. `open`: the approver is deciding. `final`: the approval is
   * consumed, rejected, expired or withdrawn, so its arguments are no longer returned. `unreturned`: it is
   * resolved but not in a final state (approved, not yet consumed), where arguments may still exist, so the
   * component says only that none came back.
   */
  readonly phase: 'open' | 'final' | 'unreturned';
  /** The service's reason the arguments are not shown (`Approval.arguments_state`); absent from a service that predates it. */
  readonly argumentsState?: string;
  readonly t: Translate;
  /** Called with whether the digest reached the clipboard. */
  readonly onCopyResult: (copied: boolean) => void;
}

/** Writes to the clipboard; false when the browser has none or refuses. The digest stays visible to copy by hand. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The call as the approver sees it: the arguments as inert text, or the digest, and which one it is. */
export function CallView({
  arguments: args,
  shown,
  showAll,
  onShowAll,
  digest,
  phase,
  argumentsState,
  t,
  onCopyResult,
}: CallViewProps) {
  const { Button } = useNc();
  const headingId = useId();

  if (args === undefined || shown === undefined) {
    return (
      <section aria-label={t('callDigestLabel')}>
        <p>{t(digestOnlyLabel(phase, argumentsState))}</p>
        <p>
          <span>{t('callDigestLabel')}: </span>
          <code className="nc-digest">
            <Safe>{digest}</Safe>
          </code>{' '}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              void copyText(digest).then(onCopyResult);
            }}
          >
            {t('callCopyDigest')}
          </Button>
        </p>
      </section>
    );
  }

  const { text, omitted, summarised, tooLarge, inexact, duplicateKey } = shown;
  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId}>{t('callFullHeading')}</h4>
      {tooLarge ? <p role="alert">{t('callTooLarge')}</p> : <pre className="nc-json">{text}</pre>}
      {inexact > 0 ? <p role="alert">{t('callInexactNumbers', { count: inexact })}</p> : null}
      {duplicateKey === undefined ? null : (
        <p role="alert">{t('callDuplicateKey', { key: escapeInvisible(duplicateKey) })}</p>
      )}
      {!tooLarge && !showAll && (omitted > 0 || summarised > 0) ? (
        <p>
          {omitted > 0 ? `${t('callMoreCharacters', { count: omitted })} ` : ''}
          {summarised > 0 ? `${t('callNestedNotShown', { count: summarised })} ` : ''}
          <Button type="button" variant="secondary" size="sm" onClick={onShowAll}>
            {t('callShowAll')}
          </Button>
        </p>
      ) : null}
    </section>
  );
}
