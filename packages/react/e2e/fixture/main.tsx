/**
 * The page script of the module end-to-end specs, bundled with React into one IIFE by global-setup.ts. It renders
 * the built modules (`dist/`, which import the built `@noblecloak/theme`) over fake controllers, into a fresh
 * `#nc-mount` at the end of <body>, when a spec asks. Only the test support (`src/testing`) comes from the sources.
 */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ReactElement } from 'react';

import { cn } from '@noblecloak/theme';
import type { AlertProps, ButtonProps, CardProps } from '@noblecloak/theme';

// The three entries are named by their sources so this file type-checks without a build; global-setup.ts bundles
// them from the built `dist/` instead (and fails if it did not).
import { ActionStatus } from '../../src/action-status.js';
import { ApprovalRequest, Approvals } from '../../src/approvals.js';
import { Permissions } from '../../src/permissions.js';
import { ConnectionDetail, Connections } from '../../src/connections.js';
import type { ApprovalsLabels } from '../../src/approvals.js';
import { NcProvider } from '../../src/slots.js';
import type { ApprovalsError } from '../../src/approvals-types.js';

import { queueRows } from '../../src/testing/component-harness.js';
import { detailStates, fakeController } from '../../src/testing/fake-controller.js';
import { fakePoliciesController } from '../../src/testing/permissions-fake.js';
import { fakeConnectionsController } from '../../src/testing/connections-fake.js';

export interface MountOptions {
  /**
   * `approvals`: the queue (rows with checkboxes, a failed read) and a loaded detail with the reason box and the
   * decision buttons; `request`: one request on its own, with a resolution history; `status`: an action status
   * that failed to read; `fallback`: the queue and the detail in their render-failure state (labels that throw);
   * `permissions`: the role × tool table over fixture policies, with its cell controls, drafts and other panels;
   * `connections`: the registrations over fixture ones, with the form's opener, and one registration open (its
   * changes, the caller's own credential and its tools).
   */
  readonly module: 'approvals' | 'request' | 'status' | 'fallback' | 'permissions' | 'connections';
  /**
   * Replace `Button`: `true` or `'provider'` through an `NcProvider` with a marked native button; `'prop'` through
   * the module's `components` prop; `'builder'` through an `NcProvider` with a builder's button whose label is its
   * own classed `span` (`.b-label`). Off by default.
   */
  readonly replaceButton?: boolean | 'provider' | 'prop' | 'builder';
  /**
   * Replace `Card` and `Alert` through an `NcProvider` with a builder's shadcn-style components, which merge the
   * class the module passes (`nc-detail`, `nc-error`) after their own (`b-card`, `b-alert`). Off by default.
   */
  readonly replacePanels?: boolean;
  /** A class on the mount element, an ancestor of the module root (a host's theming block). */
  readonly wrapperClass?: string;
}

declare global {
  interface Window {
    ncReact: { mount: (options: MountOptions) => void };
  }
}

/** A builder's button with its own markup: a classed button and a classed label inside it. */
function Builder({ variant, size, loading, disabled, children, ...props }: ButtonProps) {
  return (
    <button
      data-replaced={variant ?? 'primary'}
      data-size={size}
      disabled={disabled === true || loading === true}
      {...props}
      // The builder's own class, in place of the theme's.
      className="b-btn"
    >
      <span className="b-label">{children}</span>
    </button>
  );
}

/** The builder's button: their own native button, marked, ignoring the theme's variants. */
function Marker({ variant, size, loading, disabled, ...props }: ButtonProps) {
  return (
    <button
      data-replaced={variant ?? 'primary'}
      data-size={size}
      disabled={disabled === true || loading === true}
      {...props}
    />
  );
}

/** A builder's shadcn-style Card: its own classes, then the caller's, through `cn`. */
function BuilderCard({ className, ...props }: CardProps) {
  return <div className={cn('b-card', className)} {...props} />;
}

/** A builder's shadcn-style Alert: its own classes, then the caller's; the theme-only props are dropped. */
function BuilderAlert({ className, variant, solid, ...props }: AlertProps) {
  return (
    <div
      data-variant={variant}
      data-solid={solid}
      className={cn('b-alert', className)}
      {...props}
    />
  );
}

const unauthorized: ApprovalsError = {
  kind: 'unauthorized',
  code: 'unauthorized',
  status: 401,
  title: 'Session expired',
};

/** A request with a resolution history, so the module's `ol` (History) is on the page too. */
const withHistory = detailStates('apr_1', {
  approval: {
    resolution_history: [
      {
        resolution: 'escalated-elsewhere',
        by: { id: 'user_bo', kind: 'user' },
        at: '2026-10-05T12:10:00Z',
        reason: 'Needs finance',
      },
    ],
  },
});

/** Labels whose getters throw, so the queue and the detail render their boundary fallback. */
const throwingLabels = Object.defineProperties(
  {},
  Object.fromEntries(
    ['queueHeading', 'detailClose'].map((key) => [
      key,
      {
        enumerable: true,
        get: () => {
          throw new Error('label override failed');
        },
      },
    ])
  )
) as ApprovalsLabels;

function moduleFor(module: MountOptions['module'], slotted: Slotted): ReactElement {
  switch (module) {
    case 'approvals':
      return (
        <Approvals
          {...slotted}
          controller={fakeController({
            approvals: queueRows(3, { arguments_state: 'not_enabled' }),
            status: 'error',
            error: unauthorized,
            loadRecent: () => Promise.resolve(),
            approveMany: () => Promise.resolve({ ok: true, results: [] }),
            detail: detailStates('apr_1', { arguments: { amount: 4200, currency: 'USD' } }).loaded,
          })}
        />
      );
    case 'fallback':
      return (
        <Approvals
          {...slotted}
          labels={throwingLabels}
          controller={fakeController({
            approvals: queueRows(1),
            status: 'ready',
            detail: detailStates('apr_1').loaded,
          })}
        />
      );
    case 'request':
      return (
        <ApprovalRequest {...slotted} request={{ ...withHistory.loaded, retry: () => undefined }} />
      );
    case 'permissions':
      return (
        <Permissions
          {...slotted}
          controller={fakePoliciesController({ roles: [{ id: 'member' }, { id: 'admin' }] })}
        />
      );
    case 'connections': {
      const controller = fakeConnectionsController();
      return (
        <>
          <Connections {...slotted} controller={controller} />
          <ConnectionDetail {...slotted} controller={controller} connectionId="conn_tracker" />
        </>
      );
    }
    case 'status':
      return (
        <ActionStatus
          {...slotted}
          status={{ approvalId: 'apr_1', status: 'error', retry: () => undefined }}
        />
      );
  }
}

/** What a module is given: the `components` prop, or nothing. */
interface Slotted {
  readonly components?: { readonly Button: typeof Marker };
}

/** The module, with `Button` replaced as `replaceButton` says. */
function slotted(options: MountOptions): ReactElement {
  const how = options.replaceButton === true ? 'provider' : options.replaceButton;
  if (how === 'prop') return moduleFor(options.module, { components: { Button: Marker } });
  const element = moduleFor(options.module, {});
  if (how === 'provider') return <NcProvider components={{ Button: Marker }}>{element}</NcProvider>;
  if (how === 'builder') return <NcProvider components={{ Button: Builder }}>{element}</NcProvider>;
  return element;
}

/** The module as `slotted` renders it, inside the builder's Card and Alert when `replacePanels` asks. */
function rendered(options: MountOptions): ReactElement {
  const element = slotted(options);
  if (options.replacePanels !== true) return element;
  return <NcProvider components={{ Card: BuilderCard, Alert: BuilderAlert }}>{element}</NcProvider>;
}

window.ncReact = {
  mount(options) {
    const host = document.createElement('div');
    host.id = 'nc-mount';
    if (options.wrapperClass !== undefined) host.className = options.wrapperClass;
    document.body.append(host);
    flushSync(() => {
      createRoot(host).render(rendered(options));
    });
  },
};
