// @vitest-environment jsdom
/**
 * Bring your own components: a builder's `Button` (through `NcProvider` or a module's `components` prop) replaces
 * every button of every module, in every state, and the other roles reach their elements too. Each state is
 * rendered twice with the same steps, once with the theme's primitives and once with the replacement: the
 * replacement must account for every `<button>` the default render shows, so the test cannot pass by rendering
 * fewer of them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AlertProps,
  ButtonProps,
  CardProps,
  CheckboxProps,
  NcComponents,
  TabsProps,
  TextareaProps,
} from '@noblecloak/theme';

import { ActionStatus as ActionStatusFromEntry } from '../action-status.js';
import type { ActionStatusController } from '../action-status-types.js';
import type { ApprovalsController, ApprovalsError } from '../approvals-types.js';
import { Approvals as ApprovalsFromEntry } from '../approvals.js';
import { NcProvider, useNc, useSlot } from '../slots.js';
import { queueRows } from '../testing/component-harness.js';
import { approvalSummary, detailStates, fakeController } from '../testing/fake-controller.js';
import { ActionStatus } from './ActionStatus.js';
import { ApprovalRequest } from './ApprovalRequest.js';
import { Approvals } from './Approvals.js';
import type { ApprovalsLabels } from './labels.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  // The boundary state logs the render error it catches and reports it; neither is what is asserted here.
  vi.stubGlobal('reportError', () => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/** The builder's button: a native button marked `data-replaced`, with the theme-only props dropped. */
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

const unauthorized: ApprovalsError = {
  kind: 'unauthorized',
  code: 'unauthorized',
  status: 401,
  title: 'Session expired',
};

/** Labels whose getters throw, so the parts that read them fall back to the boundary; `rest` are plain. */
const throwing = (keys: readonly (keyof ApprovalsLabels)[], rest: ApprovalsLabels = {}) =>
  Object.defineProperties(
    { ...rest },
    Object.fromEntries(
      keys.map((key) => [
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

type Mode = 'default' | 'prop' | 'provider';

/** What a scenario spreads on its module: the `components` prop, or nothing. */
interface Slotted {
  readonly components?: Partial<NcComponents>;
}

interface Scenario {
  readonly name: string;
  /** The module, given the props to spread on it (`components`, or none). */
  readonly element: (props: Slotted) => ReactElement;
  /** Steps that bring the state on screen; run the same in every mode. */
  readonly steps?: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  /** The least number of buttons the state shows (so a state that renders none proves nothing). */
  readonly atLeast: number;
}

async function show(scenario: Scenario, mode: Mode): Promise<RenderResult> {
  const user = userEvent.setup();
  const element = scenario.element(mode === 'prop' ? { components: { Button: Marker } } : {});
  const result = render(
    mode === 'provider' ? (
      <NcProvider components={{ Button: Marker }}>{element}</NcProvider>
    ) : (
      element
    )
  );
  await scenario.steps?.(user);
  return result;
}

function approvalsController(overrides: Partial<ApprovalsController>): ApprovalsController {
  // Rows that show no arguments can be chosen for "Approve selected", so the queue shows their checkboxes.
  return fakeController({
    approvals: queueRows(2, { arguments_state: 'not_enabled' }),
    status: 'ready',
    ...overrides,
  });
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'Approvals: the queue with rows, checkboxes, "show more", a failed read and sign-in',
    element: (slotted) => (
      <Approvals
        {...slotted}
        controller={approvalsController({
          status: 'error',
          error: unauthorized,
          truncated: true,
          loadMore: () => Promise.resolve(),
          approveMany: () => Promise.resolve({ ok: true, results: [] }),
        })}
      />
    ),
    atLeast: 5,
  },
  {
    name: 'Approvals: the batch bar with a selection, then its confirmation',
    element: (slotted) => (
      <Approvals
        {...slotted}
        controller={approvalsController({
          approveMany: () => Promise.resolve({ ok: true, results: [] }),
        })}
      />
    ),
    steps: async (user) => {
      await user.click(screen.getByRole('checkbox', { name: /tool_1/ }));
      await user.click(screen.getByRole('button', { name: 'Approve selected (1)' }));
    },
    atLeast: 4,
  },
  {
    name: 'Approvals: the recent tab, with an error, rows and "show older"',
    element: (slotted) => (
      <Approvals
        {...slotted}
        controller={approvalsController({
          loadRecent: () => Promise.resolve(),
          loadMoreRecent: () => Promise.resolve(),
          recent: {
            status: 'error',
            error: unauthorized,
            approvals: [
              approvalSummary({ id: 'apr_9', state: 'approved', resolution: 'approved' }),
            ],
            more: true,
            loadingMore: false,
          },
        })}
      />
    ),
    steps: async (user) => {
      await user.click(screen.getByRole('button', { name: 'Recently decided' }));
    },
    atLeast: 6,
  },
  {
    name: 'Approvals: the detail with the call shown, "show all", approve, deny, close',
    element: (slotted) => (
      <Approvals
        {...slotted}
        controller={approvalsController({
          detail: detailStates('apr_1', {
            arguments: { note: 'x'.repeat(5000) },
            approval: { side_effect_level: 'delete' },
          }).loaded,
        })}
      />
    ),
    steps: async (user) => {
      await user.click(screen.getByRole('button', { name: 'Approve' }));
    },
    atLeast: 6,
  },
  {
    name: 'Approvals: the detail with the digest only (copy) and a failed decision (sign in again)',
    element: (slotted) => (
      <Approvals
        {...slotted}
        controller={approvalsController({
          detail: detailStates('apr_1').loaded,
          approve: () => Promise.resolve({ ok: false, error: unauthorized }),
        })}
      />
    ),
    steps: async (user) => {
      await user.click(screen.getByRole('button', { name: 'Approve' }));
      await screen.findByRole('button', { name: 'Sign in again' });
    },
    atLeast: 7,
  },
  ...(['unavailable', 'error', 'unauthorized'] as const).map((status): Scenario => ({
    name: `Approvals: a detail that is ${status}`,
    element: (slotted) => (
      <Approvals
        {...slotted}
        controller={approvalsController({ detail: detailStates('apr_1')[status] })}
      />
    ),
    atLeast: 4,
  })),
  {
    name: 'Approvals: the boundary fallback of the queue and of the detail',
    element: (slotted) => (
      <Approvals
        {...slotted}
        labels={throwing(['queueHeading', 'detailClose'])}
        controller={approvalsController({ detail: detailStates('apr_1').loaded })}
      />
    ),
    atLeast: 2,
  },
  {
    name: 'ApprovalRequest: the request, its call digest and copy',
    element: (slotted) => (
      <ApprovalRequest
        {...slotted}
        request={{ ...detailStates('apr_1').loaded, retry: () => undefined }}
      />
    ),
    atLeast: 1,
  },
  {
    name: 'ApprovalRequest: a request that could not be read',
    element: (slotted) => (
      <ApprovalRequest
        {...slotted}
        request={{ ...detailStates('apr_1').error, retry: () => undefined }}
      />
    ),
    atLeast: 1,
  },
  ...(['unauthorized', 'error', 'not_found'] as const).map((status): Scenario => ({
    name: `ActionStatus: ${status} (sign in again, or try again)`,
    element: (slotted) => <ActionStatus {...slotted} status={actionStatus(status)} />,
    atLeast: 1,
  })),
  {
    name: 'ActionStatus: a consumed approval whose outcome could not be read (try again)',
    element: (slotted) => (
      <ActionStatus
        {...slotted}
        status={{
          approvalId: 'apr_1',
          status: 'ready',
          state: 'consumed',
          since: '2026-10-05T00:00:00.000Z',
          onDeny: 'not_stated',
          refreshing: false,
          settled: true,
          connection: 'live',
          stale: false,
          outcome: { status: 'unavailable', reason: 'unavailable', recordId: 'rec_1' },
          retry: () => undefined,
        }}
      />
    ),
    atLeast: 1,
  },
];

function actionStatus(status: 'unauthorized' | 'error' | 'not_found'): ActionStatusController {
  return { approvalId: 'apr_1', status, retry: () => undefined };
}

describe('one Button replaces every button', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const shown = await show(scenario, 'default');
      const native = shown.container.querySelectorAll('button').length;
      expect(native).toBeGreaterThanOrEqual(scenario.atLeast);
      expect(shown.container.querySelectorAll('[data-replaced]')).toHaveLength(0);
      cleanup();
      for (const mode of ['prop', 'provider'] as const) {
        const replaced = await show(scenario, mode);
        expect(
          [...replaced.container.querySelectorAll('button:not([data-replaced])')].map(
            (button) => button.outerHTML
          ),
          mode
        ).toEqual([]);
        expect(replaced.container.querySelectorAll('[data-replaced]'), mode).toHaveLength(native);
        cleanup();
      }
    });
  }

  it('passes the button its variant, its ref and its handlers', async () => {
    const user = userEvent.setup();
    const controller = fakeController({
      approvals: queueRows(1),
      status: 'ready',
      detail: detailStates('apr_1').loaded,
    });
    render(<Approvals controller={controller} components={{ Button: Marker }} />);
    expect(screen.getByRole('button', { name: 'Approve' }).getAttribute('data-replaced')).toBe(
      'primary'
    );
    expect(screen.getByRole('button', { name: 'Deny' }).getAttribute('data-replaced')).toBe(
      'secondary'
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(controller.calls).toContainEqual({ method: 'approve', args: ['apr_1'] });
  });
});

describe('the other roles', () => {
  it('Textarea, Checkbox, Alert, Card and Tabs reach their elements', async () => {
    const user = userEvent.setup();
    const seen = new Set<string>();
    function MyTextarea(props: TextareaProps) {
      seen.add('Textarea');
      return <textarea data-role="Textarea" {...props} />;
    }
    function MyCheckbox({ indeterminate, onCheckedChange, ...props }: CheckboxProps) {
      seen.add('Checkbox');
      return (
        <input
          type="checkbox"
          data-role="Checkbox"
          data-mixed={indeterminate}
          {...props}
          onChange={(event) => {
            props.onChange?.(event);
            onCheckedChange?.(event.currentTarget.checked);
          }}
        />
      );
    }
    function MyAlert({ variant, solid, ...props }: AlertProps) {
      seen.add('Alert');
      return (
        <div role="alert" data-role="Alert" data-variant={variant} data-solid={solid} {...props} />
      );
    }
    function MyCard(props: CardProps) {
      seen.add('Card');
      return <div data-role="Card" {...props} />;
    }
    function MyTabs({ items, label, value, onValueChange }: TabsProps) {
      seen.add('Tabs');
      return (
        <div role="group" aria-label={label} data-role="Tabs">
          {items.map((item) => (
            <Marker
              key={item.value}
              aria-pressed={item.value === value}
              onClick={() => {
                onValueChange?.(item.value);
              }}
            >
              {item.label}
            </Marker>
          ))}
        </div>
      );
    }
    const loadRecent = vi.fn(() => Promise.resolve());
    render(
      <Approvals
        components={{
          Textarea: MyTextarea,
          Checkbox: MyCheckbox,
          Alert: MyAlert,
          Card: MyCard,
          Tabs: MyTabs,
        }}
        controller={fakeController({
          approvals: queueRows(1, { arguments_state: 'not_enabled' }),
          status: 'error',
          error: unauthorized,
          loadRecent,
          approveMany: () => Promise.resolve({ ok: true, results: [] }),
          detail: detailStates('apr_1').loaded,
        })}
      />
    );
    expect([...seen].sort()).toEqual(['Alert', 'Card', 'Checkbox', 'Tabs', 'Textarea']);
    expect(document.querySelector('textarea[data-role="Textarea"]')).not.toBeNull();
    expect(document.querySelector('input[data-role="Checkbox"]')).not.toBeNull();
    expect(document.querySelector('[data-role="Card"].nc-detail')).not.toBeNull();
    expect(document.querySelector('[data-role="Alert"].nc-error')).not.toBeNull();
    expect(
      document.querySelector('.nc-ui.nc-textarea, .nc-ui.nc-checkbox, .nc-ui.nc-card')
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Recently decided' }));
    expect(loadRecent).toHaveBeenCalled();
  });

  it('the boundary keeps the theme frame and uses the host Button, with the default words', () => {
    render(
      <Approvals
        components={{ Button: Marker, Alert: () => <div data-role="Alert" /> }}
        labels={throwing(['queueHeading'], { queueRetry: 'Host words' })}
        controller={fakeController({ approvals: queueRows(1), status: 'ready' })}
      />
    );
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry.hasAttribute('data-replaced')).toBe(true);
    expect(retry.closest('.nc-alert')).not.toBeNull();
  });
});

/** The README's "Bring your own components" example button, copied; the first test keeps the two equal. */
// It drops the theme-only props by naming them, as the README's does.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function MyButton({ variant, size, loading, disabled, className, ...props }: ButtonProps) {
  return (
    <button
      className={['my-button', className].filter(Boolean).join(' ')}
      disabled={disabled === true || loading === true}
      {...props}
    />
  );
}

/** The `function MyButton` declaration in a source, through its closing brace at the start of a line. */
function myButtonSource(source: string): string | undefined {
  return /^function MyButton\b[\s\S]*?\n\}\n/m.exec(source)?.[0];
}

describe("the README's replacement Button", () => {
  it('is the one this file renders', () => {
    // Under jsdom `import.meta.url` is not a file URL; `import.meta.dirname` is this file's directory.
    const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8');
    const own = readFileSync(join(import.meta.dirname, 'slots.test.tsx'), 'utf8');
    expect(myButtonSource(own)).toBeDefined();
    expect(myButtonSource(readme)).toBe(myButtonSource(own));
  });

  it("keeps its own class and the module's on every button, the rows and the toggles included", () => {
    render(
      <NcProvider components={{ Button: MyButton }}>
        <Approvals
          controller={approvalsController({
            loadRecent: () => Promise.resolve(),
            detail: detailStates('apr_1').loaded,
          })}
        />
      </NcProvider>
    );
    const buttons = [...document.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(4);
    expect(buttons.filter((button) => !button.classList.contains('my-button'))).toEqual([]);
    expect(document.querySelectorAll('button.my-button.nc-row')).toHaveLength(2);
    expect(document.querySelectorAll('button.my-button.nc-toggle')).toHaveLength(2);
  });
});

describe('a replaced Alert that sets no role', () => {
  it('still announces every module error: the modules pass role="alert" themselves', async () => {
    const user = userEvent.setup();
    function Bare({ variant, solid, ...props }: AlertProps) {
      return <div data-role="Alert" data-variant={variant} data-solid={solid} {...props} />;
    }
    render(
      <NcProvider components={{ Alert: Bare }}>
        <Approvals
          labels={throwing(['detailClose'])}
          controller={approvalsController({
            status: 'error',
            error: unauthorized,
            detail: detailStates('apr_1').loaded,
          })}
        />
        <Approvals
          controller={approvalsController({
            detail: detailStates('apr_2').loaded,
            approve: () => Promise.resolve({ ok: false, error: unauthorized }),
          })}
        />
        <ActionStatus status={actionStatus('error')} />
      </NcProvider>
    );
    const signIns = screen.getAllByText('Sign in again', { selector: 'button' }).length;
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getAllByText('Sign in again', { selector: 'button' })).toHaveLength(
        signIns + 1
      );
    });
    // The queue's read error, the failed decision and the action status are the replacement; the boundary
    // fallback keeps the theme's own Alert. Every error block is announced either way.
    expect(document.querySelectorAll('[data-role="Alert"]')).toHaveLength(3);
    const errors = [...document.querySelectorAll('.nc-error')];
    expect(errors).toHaveLength(4);
    expect(errors.map((error) => error.getAttribute('role'))).toEqual(errors.map(() => 'alert'));
  });
});

describe('a replaced Button that throws', () => {
  function Broken(): never {
    throw new Error('host button failed');
  }

  it("is caught: the fallback's retry falls back to the theme's Button and the host tree stays", () => {
    render(
      <main>
        <p>host content</p>
        <Approvals
          components={{ Button: Broken }}
          controller={fakeController({
            approvals: queueRows(1),
            status: 'ready',
            detail: detailStates('apr_1').loaded,
          })}
        />
      </main>
    );
    expect(screen.getByText('host content')).toBeDefined();
    const retries = screen.getAllByRole('button', { name: 'Try again' });
    expect(retries.length).toBeGreaterThan(0);
    for (const retry of retries) expect(retry.classList.contains('nc-btn')).toBe(true);
  });
});

describe('toggling the components prop', () => {
  it('keeps the module mounted: the typed reason survives undefined -> a map -> undefined', async () => {
    const user = userEvent.setup();
    const controller = fakeController({
      approvals: queueRows(1),
      status: 'ready',
      detail: detailStates('apr_1').loaded,
    });
    const shown = render(<Approvals controller={controller} />);
    await user.type(screen.getByRole('textbox', { name: 'Reason (optional)' }), 'kept');
    shown.rerender(<Approvals controller={controller} components={{ Button: Marker }} />);
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('data-replaced')).toBe(
      true
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Reason (optional)' }).value
    ).toBe('kept');
    shown.rerender(<Approvals controller={controller} />);
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Reason (optional)' }).value
    ).toBe('kept');
  });
});

describe('precedence and context', () => {
  function Tagged(name: string) {
    return function Named({ variant, size, loading, ...props }: ButtonProps) {
      return (
        <button
          data-by={name}
          data-variant={variant}
          data-size={size}
          aria-busy={loading}
          {...props}
        />
      );
    };
  }

  it('the module prop wins over the provider, and the provider over the defaults, per role', () => {
    render(
      <NcProvider components={{ Button: Tagged('outer') }}>
        <NcProvider components={{ Button: Tagged('inner') }}>
          <Approvals
            components={{ Button: Tagged('prop') }}
            controller={fakeController({ approvals: queueRows(1), status: 'ready' })}
          />
          <ActionStatus status={actionStatus('error')} />
        </NcProvider>
      </NcProvider>
    );
    expect(screen.getByRole('button', { name: /tool_1/ }).getAttribute('data-by')).toBe('prop');
    expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('data-by')).toBe('inner');
  });

  it("a provider from the slots entry reaches the approvals and action-status entries' modules", () => {
    render(
      <NcProvider components={{ Button: Marker }}>
        <ApprovalsFromEntry
          controller={fakeController({ approvals: queueRows(1), status: 'ready' })}
        />
        <ActionStatusFromEntry status={actionStatus('error')} />
      </NcProvider>
    );
    expect(document.querySelectorAll('button:not([data-replaced])')).toHaveLength(0);
    expect(document.querySelectorAll('[data-replaced]')).toHaveLength(2);
  });

  it('useNc gives the merged map and useSlot one role, from the slots entry', () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useNc().Button, useSlot('Button', Marker), useNc().Card);
      return null;
    }
    render(
      <NcProvider components={{ Button: Marker }}>
        <Probe />
      </NcProvider>
    );
    expect(seen[0]).toBe(Marker);
    expect(seen[1]).toBe(Marker);
    expect(typeof seen[2]).toBe('function');
  });
});

describe('labels are unchanged by a provider', () => {
  it('renders the same text with and without NcProvider for the same labels', async () => {
    const labels: ApprovalsLabels = { queueHeading: 'Waiting', approve: 'Yes', deny: 'No' };
    const controller = (): ApprovalsController =>
      fakeController({
        approvals: queueRows(2),
        status: 'ready',
        detail: detailStates('apr_1').loaded,
      });
    const plain = render(<Approvals controller={controller()} labels={labels} />);
    const text = plain.container.textContent;
    cleanup();
    const wrapped = render(
      <NcProvider components={{ Button: Marker }}>
        <Approvals controller={controller()} labels={labels} />
      </NcProvider>
    );
    await waitFor(() => {
      expect(wrapped.container.textContent).toBe(text);
    });
    expect(text).toContain('Waiting');
  });
});
