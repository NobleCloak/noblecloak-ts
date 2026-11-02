import { Alert, Button, NcComponentsContext } from '@noblecloak/theme';
import type { ButtonProps } from '@noblecloak/theme';
import { Component, Fragment } from 'react';
import type { ComponentType, ContextType, ReactNode } from 'react';

import { reportFault } from '../fault.js';
import { DEFAULT_LABELS } from './labels.js';

interface BoundaryProps {
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly failed: boolean;
  /** Changes on each retry, so the children mount afresh instead of rendering over what failed. */
  readonly attempt: number;
}

/**
 * Keeps a render failure inside one part of the component (the queue, or the open detail) from unmounting the
 * host's tree. The failure is reported with `reportFault`; the part shows a fixed message and a retry that
 * mounts it again. The message and the button use the default words, not the host's labels, because a label
 * override is one of the things that can fail. The retry is the host's `Button` when one replaces it (so "every
 * button" holds here too), inside a `RetryBoundary`: a replaced `Button` is also one of the things that can fail,
 * and when it throws the retry is the theme's own `Button` instead, so the failure still stays here. The frame
 * around the message is always the theme's own `Alert`.
 */
export class RenderBoundary extends Component<BoundaryProps, BoundaryState> {
  static override contextType = NcComponentsContext;
  declare context: ContextType<typeof NcComponentsContext>;
  override state: BoundaryState = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  override componentDidCatch(fault: unknown): void {
    reportFault(fault);
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }
    const retry = (): void => {
      this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }));
    };
    const Host = this.context?.Button;
    return (
      <Alert variant="danger" role="alert" className="nc-error">
        <p>{DEFAULT_LABELS.errorRender}</p>
        {Host === undefined ? (
          <RetryButton Retry={Button} onRetry={retry} />
        ) : (
          <RetryBoundary fallback={<RetryButton Retry={Button} onRetry={retry} />}>
            <RetryButton Retry={Host} onRetry={retry} />
          </RetryBoundary>
        )}
      </Alert>
    );
  }
}

function RetryButton({
  Retry,
  onRetry,
}: {
  readonly Retry: ComponentType<ButtonProps>;
  readonly onRetry: () => void;
}) {
  return (
    <Retry type="button" variant="secondary" onClick={onRetry}>
      {DEFAULT_LABELS.queueRetry}
    </Retry>
  );
}

/** Renders `fallback` in place of its child when the child throws (a replaced `Button`), and reports the fault. */
class RetryBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(fault: unknown): void {
    reportFault(fault);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
