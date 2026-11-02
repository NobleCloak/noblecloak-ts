import { useId, useRef, useState } from 'react';

import type { ApprovalRequestController, UseApprovalRequestOptions } from '../approvals-types.js';
import { useApprovalRequest } from '../use-approval-request.js';
import { RenderBoundary } from './boundary.js';
import { Detail } from './detail.js';
import { createTranslate } from './labels.js';
import type { ApprovalsLabels } from './labels.js';
import { WithComponents } from './slots.js';
import type { ModuleComponents } from './slots.js';

interface ApprovalRequestCommonProps {
  readonly className?: string;
  /** Replaces any of the component's strings. A value may hold `{name}` placeholders, as the default does. */
  readonly labels?: ApprovalsLabels;
  /** Called by "Sign in again" when the session has expired. Without it, that control reads the request again. */
  readonly onSignIn?: () => void;
  /**
   * Replaces any of the primitives the component renders, by role (`Button`, `Alert`, `Card`), over any
   * `NcProvider` around it. Shaped like `labels`: give only the roles to replace.
   */
  readonly components?: ModuleComponents;
}

/** Shows a request the host already reads with `useApprovalRequest`. */
export interface ApprovalRequestWithRequestProps extends ApprovalRequestCommonProps {
  /** What `useApprovalRequest` returns. */
  readonly request: ApprovalRequestController;
  /** Not with `request`: pass one form or the other. */
  readonly id?: never;
}

/** Reads the request itself: `id` plus the options `useApprovalRequest` takes. */
export interface ApprovalRequestWithIdProps
  extends ApprovalRequestCommonProps, UseApprovalRequestOptions {
  readonly id: string;
  /** Not with `id`: pass one form or the other. */
  readonly request?: never;
}

export type ApprovalRequestProps = ApprovalRequestWithRequestProps | ApprovalRequestWithIdProps;

/**
 * One approval request on its own: the detail `<Approvals />` shows for an open request (tool, digest, the
 * call when the service allows it, requester, agent and its parent, run, policy, timing, what it waits on and
 * its history), with no queue around it. It is read-only: it offers no Approve or Deny and no Close.
 * It renders the state `useApprovalRequest` holds and keeps only the live-region message of a copy.
 * Structure only: the look comes from `styles.css` and the host's custom properties.
 * Give it `id` and the `useApprovalRequest` options, or `request` from a hook the host already runs.
 * Render `<ApprovalRequest/>` on the client only, as `<Approvals/>`.
 */
export function ApprovalRequest({ components, ...props }: ApprovalRequestProps) {
  return (
    <WithComponents components={components}>
      {props.request !== undefined ? <RequestView {...props} /> : <OwnedRequest {...props} />}
    </WithComponents>
  );
}

/** `<ApprovalRequest id baseUrl getToken />`: the hook is called here so the choice above never changes the hooks a component runs. */
function OwnedRequest(props: Omit<ApprovalRequestWithIdProps, 'components'>) {
  const { id, className, labels, onSignIn, ...options } = props;
  const request = useApprovalRequest(id, options);
  return (
    <RequestView
      request={request}
      {...(className === undefined ? {} : { className })}
      {...(labels === undefined ? {} : { labels })}
      {...(onSignIn === undefined ? {} : { onSignIn })}
    />
  );
}

function RequestView({
  request,
  className,
  labels,
  onSignIn,
}: Omit<ApprovalRequestWithRequestProps, 'components'>) {
  const t = createTranslate(labels);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [message, setMessage] = useState('');
  return (
    <div className={['nc-root', 'nc-approvals', className].filter(Boolean).join(' ')}>
      <RenderBoundary key={request.id}>
        <Detail
          detail={request}
          controller={{
            retryDetail: () => {
              request.retry();
            },
          }}
          t={t}
          headingId={headingId}
          headingRef={headingRef}
          reason=""
          onReasonChange={() => undefined}
          onSignIn={
            onSignIn ??
            (() => {
              request.retry();
            })
          }
          onCopyResult={(copied) => {
            setMessage(t(copied ? 'callCopied' : 'callCopyFailed'));
          }}
          onResolved={() => undefined}
        />
        <div role="status" className="nc-live">
          <p>{message}</p>
        </div>
      </RenderBoundary>
    </div>
  );
}
