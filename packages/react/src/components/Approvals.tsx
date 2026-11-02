import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { batchBlock } from '../approvals-batch.js';
import type { ApprovalsController } from '../approvals-types.js';
import { RenderBoundary } from './boundary.js';
import { Detail } from './detail.js';
import { createTranslate } from './labels.js';
import type { ApprovalsLabels, Translate } from './labels.js';
import { BatchBar } from './batch.js';
import { Queue } from './queue.js';
import { Recent } from './recent.js';
import { useNc, WithComponents } from './slots.js';
import type { ModuleComponents } from './slots.js';

export interface ApprovalsProps {
  /** What `useApprovals` returns (or any object of the same shape). */
  readonly controller: ApprovalsController;
  readonly className?: string;
  /** Replaces any of the component's strings. A value may hold `{name}` placeholders, as the default does. */
  readonly labels?: ApprovalsLabels;
  /** Called by "Sign in again" when the session has expired. Without it, that control refreshes the controller. */
  readonly onSignIn?: () => void;
  /**
   * Replaces any of the primitives the component renders, by role (`Button`, `Textarea`, `Checkbox`, `Alert`,
   * `Card`, `Tabs`), over any `NcProvider` around it. Shaped like `labels`: give only the roles to replace.
   */
  readonly components?: ModuleComponents;
}

/** How often the ages in the queue are recomputed. */
const CLOCK_MS = 30_000;

function withoutKey(
  record: Readonly<Record<string, string>>,
  key: string
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

/** The live region: the count in words, then the message of the last action. */
function Live({
  controller,
  t,
  message,
}: {
  readonly controller: ApprovalsController;
  readonly t: Translate;
  readonly message: string;
}) {
  const count = controller.approvals.length;
  const countText =
    controller.status !== 'ready'
      ? ''
      : count === 0
        ? t('queueEmpty')
        : count === 1
          ? t('countOne')
          : t('countMany', { count });
  return (
    <div role="status" className="nc-live">
      <p>{countText}</p>
      <p>{message}</p>
    </div>
  );
}

/**
 * The approvals queue and the detail of one request. It renders the controller's snapshot and calls its
 * actions. It holds no approval data of its own. It keeps only the reason typed for each approval, the id
 * just decided (so that detail stays hidden), the live-region message and a clock for the ages; the confirm
 * step, the error of a decision and the call's show-all state live in the child that uses them.
 * Structure only: the look comes from `styles.css` and the host's custom properties.
 * Render `<Approvals/>` on the client only: the ages come from the clock.
 */
export function Approvals({ components, ...props }: ApprovalsProps) {
  return (
    <WithComponents components={components}>
      <ApprovalsView {...props} />
    </WithComponents>
  );
}

function ApprovalsView({
  controller,
  className,
  labels,
  onSignIn,
}: Omit<ApprovalsProps, 'components'>) {
  const { Tabs } = useNc();
  const t = createTranslate(labels);
  const queueHeadingId = useId();
  const detailHeadingId = useId();
  const queueHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  // Seeded from the clock at first render; on a server the first ages can differ from the client's.
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState('');
  // The reason typed for each approval, so it survives the detail reloading. Dropped on close and on a decision.
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});
  // The approval just decided: its detail stays hidden (the call is not shown again), whatever the controller still holds.
  const [decided, setDecided] = useState<string | undefined>(undefined);
  // Which list is shown, and the requests chosen for "Approve selected". Only the controller's own ids stay chosen.
  const [view, setView] = useState<'pending' | 'recent'>('pending');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const recentHeadingId = useId();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const { detail } = controller;
  const detailId = detail?.id;
  const previousId = useRef(detailId);
  const openId = useRef(detailId);
  openId.current = detailId;
  // Focus follows the detail: to its heading when one opens, back to its row (or the queue heading) when it closes.
  useEffect(() => {
    const previous = previousId.current;
    previousId.current = detailId;
    if (previous === detailId) return;
    if (detailId !== undefined) {
      detailHeadingRef.current?.focus();
    } else if (previous !== undefined) {
      (rows.current.get(previous) ?? queueHeadingRef.current)?.focus();
    }
  }, [detailId]);

  const rowRef = useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element === null) rows.current.delete(id);
    else rows.current.set(id, element);
  }, []);

  const signIn =
    onSignIn ??
    (() => {
      void controller.refresh();
    });

  const showDetail = detail !== undefined && detail.id !== decided;
  const hasRecent = controller.loadRecent !== undefined;
  // A request that left the queue, or that a refresh made not approvable from the queue (its call can be read, its state
  // is unknown or it is decided), leaves the choice, so "Approve selected" counts and confirms only what can be sent.
  const stillChosen = controller.approvals
    .filter((a) => chosen.has(a.id) && batchBlock(a) === undefined)
    .map((a) => a.id);
  const select = (next: 'pending' | 'recent'): void => {
    setView(next);
    if (next === 'recent') void controller.loadRecent?.();
  };

  return (
    <div className={['nc-root', 'nc-approvals', className].filter(Boolean).join(' ')}>
      <RenderBoundary>
        {hasRecent ? (
          <Tabs
            className="nc-tabs"
            label={t('queueHeading')}
            items={[
              { value: 'pending', label: t('tabPending') },
              { value: 'recent', label: t('tabRecent') },
            ]}
            value={view}
            onValueChange={(next) => {
              select(next === 'recent' ? 'recent' : 'pending');
            }}
            // Choosing Recent again reads it again, as the module's own toggles did.
            onReselect={(again) => {
              if (again === 'recent') select('recent');
            }}
          />
        ) : null}
        {view === 'recent' && hasRecent ? (
          <Recent
            controller={controller}
            t={t}
            now={now}
            headingId={recentHeadingId}
            onSelect={(id) => {
              setDecided(undefined);
              setMessage('');
              controller.openDetail(id);
            }}
            onSignIn={signIn}
          />
        ) : (
          <>
            <Queue
              controller={controller}
              t={t}
              now={now}
              headingId={queueHeadingId}
              headingRef={queueHeadingRef}
              rowRef={rowRef}
              onSelect={(id) => {
                setDecided(undefined);
                setMessage('');
                controller.openDetail(id);
              }}
              onSignIn={signIn}
              chosen={new Set(stillChosen)}
              onChoose={(id, on) => {
                setChosen((current) => {
                  const next = new Set(current);
                  if (on) next.add(id);
                  else next.delete(id);
                  return next;
                });
              }}
            />
            <BatchBar
              controller={controller}
              t={t}
              selected={stillChosen}
              digests={new Map(controller.approvals.map((a) => [a.id, a.action_digest]))}
              onDone={(text) => {
                if (!mounted.current) return;
                setChosen(new Set());
                setMessage(text);
              }}
              onSignIn={signIn}
            />
          </>
        )}
        <Live controller={controller} t={t} message={message} />
      </RenderBoundary>
      {showDetail ? (
        <RenderBoundary key={detail.id}>
          <Detail
            reason={reasons[detail.id] ?? ''}
            onReasonChange={(reason) => {
              setReasons((current) => ({ ...current, [detail.id]: reason }));
            }}
            detail={detail}
            controller={controller}
            decide={controller}
            t={t}
            headingId={detailHeadingId}
            headingRef={detailHeadingRef}
            onClose={() => {
              setReasons((current) => withoutKey(current, detail.id));
              controller.closeDetail();
            }}
            onSignIn={signIn}
            onCopyResult={(copied) => {
              setMessage(t(copied ? 'callCopied' : 'callCopyFailed'));
            }}
            onResolved={(id, decision) => {
              // A result that arrives after the whole component is gone touches nothing.
              if (!mounted.current) return;
              setDecided(id);
              setReasons((current) => withoutKey(current, id));
              setMessage(t(decision === 'approved' ? 'resultApproved' : 'resultDenied'));
              // The result can arrive after the person closed this detail or opened another; only close the one decided.
              if (openId.current === id) {
                controller.closeDetail();
                queueHeadingRef.current?.focus();
              }
            }}
          />
        </RenderBoundary>
      ) : null}
    </div>
  );
}
