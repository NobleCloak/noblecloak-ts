// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Alert, AlertDescription, AlertTitle } from './Alert.js';
import { Avatar } from './Avatar.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './Card.js';
import { Checkbox } from './Checkbox.js';
import { EmptyState } from './EmptyState.js';
import { Input } from './Input.js';
import { Label } from './Label.js';
import { Pagination } from './Pagination.js';
import { Select } from './Select.js';
import { Separator } from './Separator.js';
import { Skeleton } from './Skeleton.js';
import { Spinner } from './Spinner.js';
import { Switch } from './Switch.js';
import { Tabs } from './Tabs.js';
import { Textarea } from './Textarea.js';
import { Tooltip } from './Tooltip.js';

afterEach(cleanup);

const classes = (element: Element): string[] => [...element.classList];

describe('Button', () => {
  it('renders its children and handles clicks', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Approve</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is type="button" unless told otherwise, so it never submits a host form', () => {
    const { rerender } = render(<Button>Go</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
    rerender(<Button type="submit">Go</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit');
  });

  it('is disabled when disabled, and disabled and busy with a spinner while loading', () => {
    const { rerender } = render(<Button disabled>Go</Button>);
    expect(screen.getByRole<HTMLButtonElement>('button').disabled).toBe(true);
    expect(screen.getByRole('button').getAttribute('aria-busy')).toBeNull();
    rerender(<Button loading>Go</Button>);
    const button = screen.getByRole<HTMLButtonElement>('button');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.nc-spinner')).not.toBeNull();
  });

  it('carries its variant and size as data attributes, and the shared marker classes', () => {
    const { rerender } = render(<Button className="mine">Go</Button>);
    const button = screen.getByRole('button');
    expect(button.dataset).toMatchObject({ variant: 'primary', size: 'md' });
    expect(classes(button)).toEqual(['nc-ui', 'nc-btn', 'mine']);
    for (const variant of ['secondary', 'ghost', 'destructive', 'link'] as const) {
      rerender(<Button variant={variant}>Go</Button>);
      expect(screen.getByRole('button').dataset.variant).toBe(variant);
    }
    for (const size of ['sm', 'lg', 'icon'] as const) {
      rerender(<Button size={size}>Go</Button>);
      expect(screen.getByRole('button').dataset.size).toBe(size);
    }
  });

  it('forwards its ref', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Go</Button>);
    expect(ref.current?.tagName).toBe('BUTTON');
  });
});

describe('Textarea and Label', () => {
  it('render native elements that pair through htmlFor', async () => {
    const onChange = vi.fn();
    render(
      <>
        <Label htmlFor="why">Reason</Label>
        <Textarea id="why" onChange={onChange} />
      </>
    );
    const box = screen.getByRole('textbox', { name: 'Reason' });
    expect(classes(box)).toContain('nc-textarea');
    await userEvent.type(box, 'ok');
    expect(onChange).toHaveBeenCalled();
  });
});

describe('Input', () => {
  it('renders bare without a label or error', () => {
    const { container } = render(<Input placeholder="Search" />);
    expect(container.firstElementChild?.tagName).toBe('INPUT');
    expect(screen.getByPlaceholderText('Search').dataset.variant).toBe('text');
  });

  it('with a label, wraps itself in a field the label names', () => {
    render(<Input label="Tool" />);
    expect(screen.getByRole('textbox', { name: 'Tool' })).toBeDefined();
  });

  it('with an error, is invalid and described by the message, keeping a caller description', () => {
    render(<Input label="Tool" error="Required" aria-describedby="hint" id="tool" />);
    const input = screen.getByRole('textbox', { name: 'Tool' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('hint tool-error');
    expect(document.getElementById('tool-error')?.textContent).toBe('Required');
  });

  it('error alone (no label) still renders the message', () => {
    render(<Input error="Too long" />);
    expect(screen.getByText('Too long')).toBeDefined();
  });

  it('supports types and the code variant, and forwards its ref', () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(<Input type="password" variant="code" ref={ref} />);
    const input = container.querySelector('input');
    expect(input?.getAttribute('type')).toBe('password');
    expect(input?.dataset.variant).toBe('code');
    expect(ref.current).toBe(input);
  });
});

describe('Checkbox', () => {
  it('reports the new state through onCheckedChange and onChange', async () => {
    const onCheckedChange = vi.fn();
    const onChange = vi.fn();
    render(<Checkbox aria-label="Pick" onCheckedChange={onCheckedChange} onChange={onChange} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Pick' }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('can be controlled and disabled', () => {
    const { rerender } = render(
      <Checkbox aria-label="Pick" checked={false} onChange={() => undefined} />
    );
    const box = screen.getByRole<HTMLInputElement>('checkbox');
    expect(box.checked).toBe(false);
    rerender(<Checkbox aria-label="Pick" checked onChange={() => undefined} disabled />);
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
  });

  it('shows the mixed state through the native indeterminate property only, and forwards its ref', () => {
    const ref = createRef<HTMLInputElement>();
    const { rerender } = render(<Checkbox aria-label="All" indeterminate ref={ref} />);
    expect(ref.current?.indeterminate).toBe(true);
    // ARIA in HTML: no aria-checked on a native checkbox; the browser exposes `indeterminate` as mixed.
    expect(ref.current?.hasAttribute('aria-checked')).toBe(false);
    rerender(<Checkbox aria-label="All" ref={ref} />);
    expect(ref.current?.indeterminate).toBe(false);
    expect(ref.current?.hasAttribute('aria-checked')).toBe(false);
  });

  it('accepts a callback ref', () => {
    let seen: HTMLInputElement | null = null;
    render(
      <Checkbox
        aria-label="Pick"
        ref={(element) => {
          seen = element;
        }}
      />
    );
    expect(seen).toBe(screen.getByRole('checkbox'));
  });
});

describe('Switch', () => {
  it('toggles uncontrolled and reports the new state', async () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Live updates" onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch', { name: 'Live updates' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(control);
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('when controlled, shows the prop and only reports', async () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Live" checked onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch');
    await userEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
    expect(control.getAttribute('aria-checked')).toBe('true');
  });

  it('a caller onClick that prevents default stops the toggle', async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        aria-label="Live"
        onClick={(event) => {
          event.preventDefault();
        }}
        onCheckedChange={onCheckedChange}
      />
    );
    await userEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });
});

describe('Select', () => {
  it('renders options and a placeholder, and reports the chosen value', async () => {
    const onValueChange = vi.fn();
    const onChange = vi.fn();
    render(
      <Select
        aria-label="Level"
        placeholder="Any"
        options={[
          { value: 'read', label: 'Read' },
          { value: 'write', label: 'Write', disabled: true },
        ]}
        onValueChange={onValueChange}
        onChange={onChange}
      />
    );
    const select = screen.getByRole('combobox', { name: 'Level' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Any',
      'Read',
      'Write',
    ]);
    await userEvent.selectOptions(select, 'read');
    expect(onValueChange).toHaveBeenCalledWith('read');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('accepts option children', () => {
    render(
      <Select aria-label="Level">
        <option value="a">A</option>
      </Select>
    );
    expect(screen.getByRole('option').textContent).toBe('A');
  });
});

describe('Alert', () => {
  it('danger and warning are alerts; neutral and success are status', () => {
    const { rerender } = render(<Alert variant="danger">x</Alert>);
    expect(screen.getByRole('alert').dataset.variant).toBe('danger');
    rerender(<Alert variant="warning">x</Alert>);
    expect(screen.getByRole('alert')).toBeDefined();
    rerender(<Alert>x</Alert>);
    expect(screen.getByRole('status').dataset.variant).toBe('neutral');
    rerender(<Alert variant="success">x</Alert>);
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('renders its title and description, takes a role and a solid fill', () => {
    render(
      <Alert role="alert" variant="danger" solid className="mine">
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>Something went wrong.</AlertDescription>
      </Alert>
    );
    const alert = screen.getByRole('alert');
    expect(alert.dataset.solid).toBe('true');
    expect(classes(alert)).toContain('mine');
    expect(screen.getByText('Error').className).toContain('nc-alert-title');
    expect(screen.getByText('Something went wrong.').className).toContain('nc-alert-description');
  });
});

describe('Tabs (toggle-button group)', () => {
  const items = [
    { value: 'pending', label: 'Pending' },
    { value: 'recent', label: 'Recent' },
    { value: 'old', label: 'Old', disabled: true },
  ];

  it('is a named group of aria-pressed buttons with the first pressed by default', () => {
    render(<Tabs label="Which approvals" items={items} />);
    expect(screen.getByRole('group', { name: 'Which approvals' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pending' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(screen.getByRole('button', { name: 'Recent' }).getAttribute('aria-pressed')).toBe(
      'false'
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Old' }).disabled).toBe(true);
  });

  it('pressing the pressed one calls onReselect with its value, and not onValueChange', async () => {
    const onValueChange = vi.fn();
    const onReselect = vi.fn();
    render(
      <Tabs
        label="Which"
        items={items}
        value="recent"
        onValueChange={onValueChange}
        onReselect={onReselect}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Recent' }));
    expect(onReselect).toHaveBeenCalledWith('recent');
    expect(onValueChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Pending' }));
    expect(onReselect).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('pending');
  });

  it('uncontrolled: pressing another moves the selection and reports it; pressing the pressed one does nothing', async () => {
    const onValueChange = vi.fn();
    render(<Tabs label="Which" items={items} onValueChange={onValueChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Pending' }));
    expect(onValueChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Recent' }));
    expect(onValueChange).toHaveBeenCalledWith('recent');
    expect(screen.getByRole('button', { name: 'Recent' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
  });

  it('controlled: shows the value and only reports', async () => {
    const onValueChange = vi.fn();
    render(<Tabs label="Which" items={items} value="recent" onValueChange={onValueChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Pending' }));
    expect(onValueChange).toHaveBeenCalledWith('pending');
    expect(screen.getByRole('button', { name: 'Recent' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
  });

  it('honours defaultValue and an empty list', () => {
    const { rerender } = render(<Tabs label="Which" items={items} defaultValue="recent" />);
    expect(screen.getByRole('button', { name: 'Recent' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    rerender(<Tabs label="None" items={[]} />);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});

describe('Card', () => {
  it('renders the whole structure, with a title level of choice', () => {
    render(
      <Card data-testid="card" className="mine">
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardContent>Content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>
    );
    expect(classes(screen.getByTestId('card'))).toEqual(['nc-ui', 'nc-card', 'mine']);
    expect(screen.getByRole('heading', { level: 3, name: 'Title' })).toBeDefined();
    for (const text of ['Description', 'Content', 'Footer'])
      expect(screen.getByText(text)).toBeDefined();
    cleanup();
    render(<CardTitle as="h2">Two</CardTitle>);
    expect(screen.getByRole('heading', { level: 2, name: 'Two' })).toBeDefined();
  });
});

describe('Badge, Separator, Skeleton, Spinner', () => {
  it('Badge carries its variant', () => {
    const { rerender } = render(<Badge>Status</Badge>);
    expect(screen.getByText('Status').dataset.variant).toBe('neutral');
    rerender(<Badge variant="success">Status</Badge>);
    expect(screen.getByText('Status').dataset.variant).toBe('success');
  });

  it('Separator is decorative by default and a separator when not', () => {
    const { container, rerender } = render(<Separator />);
    expect(container.firstElementChild?.getAttribute('role')).toBe('none');
    rerender(<Separator decorative={false} orientation="vertical" />);
    const separator = screen.getByRole('separator');
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.dataset.orientation).toBe('vertical');
  });

  it('Skeleton is hidden from assistive technology', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('Spinner is a status with a hidden label', () => {
    render(<Spinner size="lg" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading');
    expect(status.dataset.size).toBe('lg');
    cleanup();
    render(<Spinner label="Saving" />);
    expect(screen.getByRole('status').textContent).toBe('Saving');
  });
});

describe('EmptyState', () => {
  it('renders title, description, icon and action', () => {
    render(
      <EmptyState
        title="Nothing to review"
        description="New requests appear here."
        icon="○"
        action={<Button>Refresh</Button>}
      />
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Nothing to review' })).toBeDefined();
    expect(screen.getByText('New requests appear here.')).toBeDefined();
    expect(screen.getByText('○').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDefined();
  });

  it('renders the title alone at the level asked for', () => {
    const { container } = render(<EmptyState title="Empty" titleAs="p" />);
    expect(container.querySelector('p.nc-empty-title')?.textContent).toBe('Empty');
    expect(container.querySelectorAll('.nc-empty > *')).toHaveLength(1);
  });
});

describe('Avatar', () => {
  it('shows the image, and the named fallback once it fails or when there is none', () => {
    const { container, rerender } = render(<Avatar src="/a.png" alt="Ana" fallback="A" />);
    const image = screen.getByRole('img', { name: 'Ana' });
    expect(image.tagName).toBe('IMG');
    fireEvent.error(image);
    const fallback = screen.getByRole('img', { name: 'Ana' });
    expect(fallback.tagName).toBe('SPAN');
    expect(fallback.textContent).toBe('A');
    rerender(<Avatar alt="Bo" fallback="B" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Bo' }).textContent).toBe('B');
  });
});

describe('Tooltip', () => {
  it('describes its trigger, shows on hover and focus, hides on leave, blur and Escape', async () => {
    render(
      <Tooltip content="Approve every selected request">
        <button type="button" aria-describedby="extra">
          Approve selected
        </button>
      </Tooltip>
    );
    const trigger = screen.getByRole('button', { name: 'Approve selected' });
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(trigger.getAttribute('aria-describedby')).toBe(`extra ${tip.id}`);
    expect(tip.hidden).toBe(true);
    await userEvent.hover(trigger);
    expect(tip.hidden).toBe(false);
    await userEvent.unhover(trigger);
    expect(tip.hidden).toBe(true);
    fireEvent.focus(trigger);
    expect(tip.hidden).toBe(false);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(tip.hidden).toBe(true);
    fireEvent.focus(trigger);
    fireEvent.keyDown(trigger, { key: 'a' });
    expect(tip.hidden).toBe(false);
    fireEvent.blur(trigger);
    expect(tip.hidden).toBe(true);
  });

  it('a hover-opened tip is dismissed by Escape anywhere, without moving the pointer or focus', async () => {
    render(
      <Tooltip content="Approve every selected request">
        <button type="button">Approve selected</button>
      </Tooltip>
    );
    const tip = screen.getByRole('tooltip', { hidden: true });
    await userEvent.hover(screen.getByRole('button', { name: 'Approve selected' }));
    expect(tip.hidden).toBe(false);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(tip.hidden).toBe(true);
  });

  it('listens for Escape on the document only while open', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    render(
      <Tooltip content="Tip">
        <button type="button">Go</button>
      </Tooltip>
    );
    const keydowns = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === 'keydown');
    expect(keydowns(add)).toHaveLength(0);
    fireEvent.focus(screen.getByRole('button', { name: 'Go' }));
    expect(keydowns(add)).toHaveLength(1);
    fireEvent.blur(screen.getByRole('button', { name: 'Go' }));
    expect(keydowns(remove)).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe('Pagination', () => {
  it('fires onPrev and onNext when that side is available', async () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(<Pagination hasPrev hasNext onPrev={onPrev} onNext={onNext} />);
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('disables the controls when the caller says there is no page on that side', () => {
    render(<Pagination hasPrev={false} hasNext={false} onPrev={vi.fn()} onNext={vi.fn()} />);
    for (const name of ['Previous', 'Next']) {
      expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true);
    }
  });

  it('renders the status label and takes other words', () => {
    render(
      <Pagination
        hasPrev
        hasNext={false}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        label="21–40"
        labels={{ nav: 'Pages', previous: 'Back', next: 'On' }}
      />
    );
    expect(screen.getByText('21–40')).toBeDefined();
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'On' })).toBeDefined();
  });
});
