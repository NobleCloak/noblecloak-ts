// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ButtonProps } from './components/Button.js';
import type { DialogProps } from './components/Dialog.js';
import { defaultComponents, NcComponentsProvider, useNcComponents } from './defaults.js';
import * as entry from './index.js';
import type { NcComponents } from './slot-context.js';

afterEach(cleanup);

function BrandButton({ children, onClick, disabled, 'aria-pressed': pressed }: ButtonProps) {
  return (
    <button
      type="button"
      className="brand"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}

function Everything() {
  const { Button, ConfirmDialog, Pagination, DataTable } = useNcComponents();
  return (
    <>
      <Button>Direct</Button>
      <Pagination hasPrev hasNext onPrev={vi.fn()} onNext={vi.fn()} />
      <ConfirmDialog open onOpenChange={vi.fn()} title="Sure?" onConfirm={vi.fn()} />
      <DataTable
        columns={[{ key: 'id', header: 'Id' }]}
        data={[{ id: 'a' }]}
        rowKey={(row) => row.id}
        selectedKeys={new Set()}
        onSelectionChange={vi.fn()}
      />
    </>
  );
}

describe('NcComponents and defaultComponents', () => {
  const ROLES: (keyof NcComponents)[] = [
    'Alert',
    'Avatar',
    'Badge',
    'Button',
    'Card',
    'Checkbox',
    'ConfirmDialog',
    'DataTable',
    'Dialog',
    'EmptyState',
    'Input',
    'Label',
    'Pagination',
    'Select',
    'Separator',
    'Skeleton',
    'Spinner',
    'Switch',
    'Tabs',
    'Textarea',
    'Tooltip',
  ];

  it('names every carried primitive, each mapped to the exported component', () => {
    expect(Object.keys(defaultComponents).sort()).toEqual([...ROLES].sort());
    const exported = entry as unknown as Record<string, unknown>;
    for (const role of ROLES) expect(defaultComponents[role], role).toBe(exported[role]);
    expect(Object.isFrozen(defaultComponents)).toBe(true);
  });

  it('exports the context and useSlot, so a package built on the theme reads the same replacements', () => {
    expect(entry.NcComponentsContext).toBeDefined();
    let seen: unknown;
    function Probe() {
      seen = entry.useSlot('Button', defaultComponents.Button);
      return null;
    }
    render(
      <entry.NcComponentsContext.Provider value={{ Button: BrandButton }}>
        <Probe />
      </entry.NcComponentsContext.Provider>
    );
    expect(seen).toBe(BrandButton);
  });

  it('without a provider, useNcComponents is the defaults', () => {
    let seen: NcComponents | undefined;
    function Probe() {
      seen = useNcComponents();
      return null;
    }
    render(<Probe />);
    expect(seen).toBe(defaultComponents);
  });
});

describe('replacing Button through the provider', () => {
  it('changes every Button, including those inside ConfirmDialog and Pagination, and nothing else', () => {
    render(
      <NcComponentsProvider components={{ ...defaultComponents, Button: BrandButton }}>
        <Everything />
      </NcComponentsProvider>
    );
    const named = ['Direct', 'Previous', 'Next', 'Cancel', 'Confirm'];
    for (const name of named) {
      const button = screen.getByRole('button', { name, hidden: true });
      expect(button.className, name).toBe('brand');
    }
    // The table's checkboxes are still the theme's.
    expect(screen.getAllByRole('checkbox', { hidden: true })[0]?.className).toContain(
      'nc-checkbox'
    );
  });

  it('also replaces the Tabs toggles and the DataTable sort header, which are action buttons', () => {
    const onValueChange = vi.fn();
    const onSortChange = vi.fn();
    const { Tabs, DataTable } = defaultComponents;
    render(
      <NcComponentsProvider components={{ Button: BrandButton }}>
        <Tabs
          label="Which"
          items={[
            { value: 'a', label: 'Pending' },
            { value: 'b', label: 'Recent' },
          ]}
          onValueChange={onValueChange}
        />
        <DataTable
          columns={[{ key: 'id', header: 'Id', sortable: true }]}
          data={[{ id: 'a' }]}
          rowKey={(row) => row.id}
          sort={null}
          onSortChange={onSortChange}
        />
      </NcComponentsProvider>
    );
    const recent = screen.getByRole('button', { name: 'Recent' });
    expect(recent.className).toBe('brand');
    expect(screen.getByRole('button', { name: 'Pending' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(recent.getAttribute('aria-pressed')).toBe('false');
    recent.click();
    expect(onValueChange).toHaveBeenCalledWith('b');
    const sort = screen.getByRole('button', { name: /Id/ });
    expect(sort.className).toBe('brand');
    sort.click();
    expect(onSortChange).toHaveBeenCalled();
    // No native button in this tree is the theme's own.
    expect(document.querySelectorAll('button:not(.brand)')).toHaveLength(0);
  });

  it('leaves the Switch, whose button is its own role (role=switch), to the Switch', () => {
    const { Switch } = defaultComponents;
    render(
      <NcComponentsProvider components={{ Button: BrandButton }}>
        <Switch aria-label="Live" />
      </NcComponentsProvider>
    );
    expect(screen.getByRole('switch', { name: 'Live' }).className).toContain('nc-switch');
  });

  it('without a replacement, the toggles and the sort header are theme Buttons with their own class', () => {
    const { Tabs, DataTable } = defaultComponents;
    render(
      <>
        <Tabs label="Which" items={[{ value: 'a', label: 'Pending' }]} />
        <DataTable
          columns={[{ key: 'id', header: 'Id', sortable: true }]}
          data={[{ id: 'a' }]}
          rowKey={(row) => row.id}
          sort={null}
          onSortChange={vi.fn()}
        />
      </>
    );
    expect(screen.getByRole('button', { name: 'Pending' }).className).toBe(
      'nc-ui nc-btn nc-toggle'
    );
    expect(screen.getByRole('button', { name: /Id/ }).className).toBe('nc-ui nc-btn nc-sort');
  });

  it('without the replacement, the same tree renders the theme buttons', () => {
    render(<Everything />);
    for (const name of ['Direct', 'Previous', 'Cancel']) {
      expect(screen.getByRole('button', { name, hidden: true }).className).toContain('nc-btn');
    }
  });

  it('providers nest: the inner one wins per entry and the outer one still applies', () => {
    function Tagged({ children }: { children?: ReactNode }) {
      return <span data-testid="tagged">{children}</span>;
    }
    function Probe() {
      const { Badge, Button } = useNcComponents();
      return (
        <>
          <Badge>b</Badge>
          <Button>x</Button>
        </>
      );
    }
    render(
      <NcComponentsProvider components={{ Button: BrandButton }}>
        <NcComponentsProvider components={{ Badge: Tagged }}>
          <Probe />
        </NcComponentsProvider>
      </NcComponentsProvider>
    );
    expect(screen.getByTestId('tagged').textContent).toBe('b');
    expect(screen.getByRole('button', { name: 'x' }).className).toBe('brand');
  });
});

describe('the provider value', () => {
  it('is the same object across renders with the same components, so a consumer does not re-render', () => {
    const components: Partial<NcComponents> = { Button: BrandButton };
    let renders = 0;
    const Consumer = memo(function Consumer() {
      renders += 1;
      const { Button } = useNcComponents();
      return <Button>Consumer</Button>;
    });
    let bump = (): void => undefined;
    function Parent() {
      const [count, setCount] = useState(0);
      bump = () => {
        setCount((c) => c + 1);
      };
      return (
        <NcComponentsProvider components={components}>
          <span>{count}</span>
          <Consumer />
        </NcComponentsProvider>
      );
    }
    render(<Parent />);
    act(() => {
      bump();
    });
    act(() => {
      bump();
    });
    expect(screen.getByText('2')).toBeDefined();
    expect(renders).toBe(1);
  });
});

describe('replacing Dialog through the provider', () => {
  /** A builder's dialog: a plain region, named from the props it is given, with no theme context. */
  function PlainDialog({ open, children, 'aria-label': label }: DialogProps) {
    return open ? (
      <div role="dialog" aria-label={label} data-builder-dialog="">
        {children}
      </div>
    ) : null;
  }

  it('ConfirmDialog renders inside the replacement, named by its title, with its parts', () => {
    const { ConfirmDialog } = defaultComponents;
    render(
      <NcComponentsProvider components={{ Dialog: PlainDialog }}>
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          title="Sure?"
          description="It cannot be undone."
          onConfirm={vi.fn()}
        />
      </NcComponentsProvider>
    );
    expect(document.querySelector('dialog')).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Sure?' });
    expect(dialog.hasAttribute('data-builder-dialog')).toBe(true);
    expect(screen.getByRole('heading', { name: 'Sure?' })).toBeDefined();
    expect(screen.getByText('It cannot be undone.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDefined();
  });
});
