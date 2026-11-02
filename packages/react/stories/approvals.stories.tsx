import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { CSSProperties } from 'react';

import type { ButtonProps } from '@noblecloak/theme';

import type {
  ApprovalDetailState,
  ApprovalDetailStatus,
  ApprovalSummary,
  ApprovalsController,
  JsonObject,
} from '../src/approvals-types.js';
import { ActionStatus } from '../src/action-status.js';
import { Approvals } from '../src/approvals.js';
import { NcProvider } from '../src/slots.js';
import { approvalSummary, detailStates, fakeController } from '../src/testing/fake-controller.js';

/**
 * The states and their words, rendered with the stylesheet the package ships (`.storybook/preview.ts`), and two
 * builder stories: a builder's own Button, and a builder's palette set through the `--nc-*` names only.
 */
const meta: Meta<typeof Approvals> = {
  title: 'Approvals/Approvals',
  component: Approvals,
  parameters: { layout: 'padded' },
};

export default meta;

type Story = StoryObj<typeof Approvals>;

const REFUND_ARGUMENTS: JsonObject = {
  customer: 'cus_1042',
  amount: { value: 4200, currency: 'USD' },
  reason: 'Duplicate charge',
  note: '<img src=x onerror=alert(1)> is shown as text, not run',
};

function rows(): ApprovalSummary[] {
  return [
    approvalSummary({ id: 'apr_1', created_at: new Date(Date.now() - 4 * 60_000).toISOString() }),
    approvalSummary({
      id: 'apr_2',
      tool_ref: 'ext:crm:delete_contact',
      side_effect_level: 'delete',
      action_digest: 'b7e24d90'.repeat(8),
      created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    }),
    approvalSummary({
      id: 'apr_3',
      tool_ref: 'ext:ledger:grant_admin',
      side_effect_level: 'admin',
      action_digest: 'c91a0f3e'.repeat(8),
      created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    }),
  ];
}

function withController(overrides: Partial<ApprovalsController>): Story {
  return {
    render: () => <Approvals controller={fakeController(overrides)} />,
  };
}

// Queue states

export const QueueEmpty: Story = withController({});
export const QueueLoading: Story = withController({ status: 'loading', connection: 'connecting' });
export const QueueErrorWithRetry: Story = withController({
  status: 'error',
  error: {
    kind: 'unavailable',
    code: 'unavailable',
    status: 503,
    title: 'Service Unavailable',
    requestId: 'req_story',
  },
});
export const QueueSessionExpired: Story = withController({
  status: 'error',
  error: { kind: 'unauthorized', code: 'unauthorized', status: 401, title: 'Unauthorized' },
});
export const QueueReady: Story = withController({ approvals: rows() });
export const QueueTruncated: Story = withController({ approvals: rows(), truncated: true });
export const QueueLive: Story = withController({ approvals: rows(), connection: 'live' });
export const QueuePolling: Story = withController({ approvals: rows(), connection: 'polling' });
export const QueueOffline: Story = withController({ approvals: rows(), connection: 'offline' });

// One story per detail status

function detailStory(
  status: ApprovalDetailStatus,
  options: { arguments?: JsonObject; approval?: Partial<ApprovalSummary> } = {}
): Story {
  return withController({
    approvals: rows(),
    detail: detailStates('apr_1', options)[status],
  });
}

export const DetailLoading: Story = detailStory('loading');
export const DetailRefreshing: Story = detailStory('refreshing', { arguments: REFUND_ARGUMENTS });
export const DetailLoadedWithArguments: Story = detailStory('loaded', {
  arguments: REFUND_ARGUMENTS,
});
export const DetailLoadedDigestOnly: Story = detailStory('loaded');
export const DetailResolved: Story = detailStory('resolved', {
  approval: {
    approver: { id: 'user_ana', kind: 'user' },
    resolved_at: '2026-10-05T12:30:00Z',
    resolution_history: [
      {
        resolution: 'approved',
        by: { id: 'user_ana', kind: 'user' },
        at: '2026-10-05T12:30:00Z',
        reason: 'Checked the invoice',
      },
    ],
  },
});
export const DetailNotFound: Story = detailStory('not_found');
export const DetailUnavailable: Story = detailStory('unavailable');
export const DetailForbidden: Story = detailStory('forbidden');
export const DetailUnauthorized: Story = detailStory('unauthorized');
export const DetailError: Story = detailStory('error');

// A call long enough to need "Show all", and a level that asks for a second click

export const DetailLongCall: Story = detailStory('loaded', {
  arguments: { text: 'A long value. '.repeat(500) },
});
export const DetailConfirmLevel: Story = withController({
  approvals: rows(),
  detail: detailStates('apr_2', {
    approval: { tool_ref: 'ext:crm:delete_contact', side_effect_level: 'delete' },
    arguments: { contact: 'ct_77' },
  }).loaded,
});

// A host that holds the open detail the way a store would, so the rows can be clicked

function Interactive() {
  const [detail, setDetail] = useState<ApprovalDetailState | undefined>(undefined);
  const [list, setList] = useState(rows);
  const controller = fakeController({
    approvals: list,
    ...(detail === undefined ? {} : { detail }),
    openDetail: (id) => {
      setDetail(detailStates(id, { arguments: REFUND_ARGUMENTS }).loaded);
    },
    closeDetail: () => {
      setDetail(undefined);
    },
    approve: (id) => {
      setList((current) => current.filter((row) => row.id !== id));
      return Promise.resolve({ ok: true, approval: approvalSummary({ id, state: 'approved' }) });
    },
    deny: (id) => {
      setList((current) => current.filter((row) => row.id !== id));
      return Promise.resolve({ ok: true, approval: approvalSummary({ id, state: 'rejected' }) });
    },
  });
  return <Approvals controller={controller} />;
}

export const InteractiveQueue: Story = { render: () => <Interactive /> };

export const DarkTheme: Story = {
  render: () => (
    <div data-nc-theme="dark" style={{ padding: '1rem', background: '#121212' }}>
      <Approvals
        controller={fakeController({
          approvals: rows(),
          detail: detailStates('apr_1', { arguments: REFUND_ARGUMENTS }).loaded,
        })}
      />
    </div>
  ),
};

/** A builder's own button: their markup and inline styles, ignoring the theme's variants. */
function BuilderButton({ variant, size, loading, disabled, style, ...props }: ButtonProps) {
  return (
    <button
      data-variant={variant}
      data-size={size}
      disabled={disabled === true || loading === true}
      style={{
        background: variant === 'primary' ? '#14532d' : '#ffffff',
        color: variant === 'primary' ? '#ffffff' : '#14532d',
        border: '2px solid #14532d',
        borderRadius: '999px',
        padding: '0.25em 1.25em',
        font: 'inherit',
        fontWeight: 700,
        cursor: 'pointer',
        ...style,
      }}
      {...props}
    />
  );
}

/** Every button of both modules is the builder's, through one provider; nothing else changes. */
export const BuilderButtonEverywhere: Story = {
  render: () => (
    <NcProvider components={{ Button: BuilderButton }}>
      <Approvals
        controller={fakeController({
          approvals: rows(),
          loadRecent: () => Promise.resolve(),
          detail: detailStates('apr_1', { arguments: REFUND_ARGUMENTS }).loaded,
        })}
      />
      <ActionStatus status={{ approvalId: 'apr_1', status: 'error', retry: () => undefined }} />
    </NcProvider>
  ),
};

/** A builder's palette: only `--nc-*` names, on a wrapper; no component or markup change. */
const PALETTE = {
  '--nc-bg': '#fff7e6',
  '--nc-fg': '#2b1d0e',
  '--nc-muted': '#6b4f2a',
  '--nc-border': '#c08a3e',
  '--nc-accent': '#8a2be2',
  '--nc-danger': '#d11a6b',
  '--nc-radius': '12px',
  '--nc-font-sans': 'Georgia, serif',
  '--nc-surface': '#fdf0d5',
  '--nc-accent-fg': '#fffbe0',
} as CSSProperties;

export const BuilderPalette: Story = {
  render: () => (
    <div style={PALETTE}>
      <Approvals
        controller={fakeController({
          approvals: rows(),
          loadRecent: () => Promise.resolve(),
          detail: detailStates('apr_1', { arguments: REFUND_ARGUMENTS }).loaded,
        })}
      />
    </div>
  ),
};
