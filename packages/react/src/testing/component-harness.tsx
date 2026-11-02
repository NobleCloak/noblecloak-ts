/**
 * Test support for the `<Approvals/>` component: a host that holds the open detail the way a store would,
 * on top of `fakeController()`, so a click on a row opens a detail. Not part of the published package.
 */
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { useState } from 'react';

import type { ApprovalsProps } from '../components/Approvals.js';
import { Approvals } from '../components/Approvals.js';
import type {
  ApprovalDetailState,
  ApprovalSummary,
  ApprovalsController,
} from '../approvals-types.js';
import { approvalSummary, fakeController } from './fake-controller.js';
import type { FakeCall } from './fake-controller.js';

/** A string no real value contains, put in arguments to find out whether the page shows them. */
export const MARKER = 'ARG-MARKER-7f3a91';

/** The item at `index`; a missing one fails the test with a clear message instead of a `!`. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${String(index)}`);
  return item;
}

/** `count` pending approvals with distinct ids (`apr_1`, `apr_2`, ...). */
export function queueRows(count: number, extra: Partial<ApprovalSummary> = {}): ApprovalSummary[] {
  return Array.from({ length: count }, (_, index) =>
    approvalSummary({
      id: `apr_${String(index + 1)}`,
      tool_ref: `ext:billing:tool_${String(index + 1)}`,
      ...extra,
    })
  );
}

export interface HostOptions {
  readonly approvals?: readonly ApprovalSummary[];
  /** The detail a row opens; without it, `openDetail` leaves no detail open. */
  readonly detailFor?: (id: string) => ApprovalDetailState;
  /** Members of the controller to replace (an override of an action is not recorded by `fakeController`). */
  readonly overrides?: Partial<ApprovalsController>;
  readonly props?: Partial<ApprovalsProps>;
  /** A detail that is open from the start. */
  readonly initialDetail?: ApprovalDetailState;
}

interface HostProps extends HostOptions {
  readonly calls: FakeCall[];
}

function Host({ approvals, detailFor, overrides, props, initialDetail, calls }: HostProps) {
  const [detail, setDetail] = useState<ApprovalDetailState | undefined>(initialDetail);
  const base = fakeController({
    approvals: approvals ?? [],
    ...(detail === undefined ? {} : { detail }),
    ...overrides,
  });
  const controller: ApprovalsController = {
    ...base,
    openDetail: (id) => {
      calls.push({ method: 'openDetail', args: [id] });
      setDetail(detailFor?.(id));
    },
    closeDetail: () => {
      calls.push({ method: 'closeDetail', args: [] });
      setDetail(undefined);
    },
    retryDetail: () => {
      calls.push({ method: 'retryDetail', args: [] });
    },
    refresh: () => {
      calls.push({ method: 'refresh', args: [] });
      return Promise.resolve();
    },
    approve: (id, options) => {
      calls.push({ method: 'approve', args: options === undefined ? [id] : [id, options] });
      return base.approve(id, options);
    },
    deny: (id, options) => {
      calls.push({ method: 'deny', args: options === undefined ? [id] : [id, options] });
      return base.deny(id, options);
    },
  };
  return <Approvals controller={controller} {...props} />;
}

export type RenderedHost = RenderResult & { readonly calls: readonly FakeCall[] };

/** Renders the component in a host that records every call the component makes. */
export function renderHost(options: HostOptions = {}): RenderedHost {
  const calls: FakeCall[] = [];
  const result = render(<Host {...options} calls={calls} />);
  return Object.assign(result, { calls });
}

/** Renders the component on a controller as it is, for a test that fixes the snapshot itself. */
export function renderController(
  controller: ApprovalsController,
  props: Partial<ApprovalsProps> = {}
): RenderResult {
  return render(<Approvals controller={controller} {...props} />);
}
