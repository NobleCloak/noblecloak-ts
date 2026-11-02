// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataTable } from './DataTable.js';
import type { DataTableColumn } from './DataTable.js';

afterEach(cleanup);

interface Row {
  id: string;
  name: string;
  confidence: number;
  extra?: unknown;
}

const rows: Row[] = [
  { id: 'r1', name: 'refund_customer', confidence: 0.92 },
  { id: 'r2', name: 'delete_contact', confidence: 0.71 },
  { id: 'r3', name: 'grant_admin', confidence: 0.55 },
];

const columns: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Tool', sortable: true },
  {
    key: 'confidence',
    header: 'Confidence',
    align: 'right',
    width: '8rem',
    render: (row) => <span data-testid={`conf-${row.id}`}>{row.confidence.toFixed(2)}</span>,
  },
];

const rowKey = (row: Row) => row.id;
const checkbox = (name: string) => screen.getByRole<HTMLInputElement>('checkbox', { name });

describe('DataTable', () => {
  it('renders headers and rows with default and custom cells', () => {
    render(<DataTable columns={columns} data={rows} rowKey={rowKey} aria-label="Requests" />);
    expect(screen.getByRole('table', { name: 'Requests' })).toBeDefined();
    expect(screen.getByText('refund_customer')).toBeDefined();
    expect(screen.getByTestId('conf-r2').textContent).toBe('0.71');
    expect(
      screen.getByRole('columnheader', { name: 'Confidence' }).getAttribute('style')
    ).toContain('width: 8rem');
  });

  it('renders a missing value as nothing and an object as JSON', () => {
    const data: Row[] = [
      { id: 'a', name: 'x', confidence: 1, extra: { level: 'write' } },
      { id: 'b', name: 'y', confidence: 1 },
    ];
    render(<DataTable columns={[{ key: 'extra', header: 'Extra' }]} data={data} rowKey={rowKey} />);
    const cells = screen.getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual(['{"level":"write"}', '']);
  });

  it('a value JSON cannot encode renders as text or nothing instead of throwing', () => {
    const circular: Record<string, unknown> = { level: 'write' };
    circular.self = circular;
    const data: Row[] = [
      { id: 'a', name: 'x', confidence: 1, extra: circular },
      { id: 'b', name: 'y', confidence: 1, extra: 10n },
      { id: 'c', name: 'z', confidence: 1, extra: () => 1 },
    ];
    render(<DataTable columns={[{ key: 'extra', header: 'Extra' }]} data={data} rowKey={rowKey} />);
    expect(screen.getAllByRole('cell').map((c) => c.textContent)).toEqual([
      '[object Object]',
      '10',
      '',
    ]);
  });

  describe('controlled sorting', () => {
    it('reports asc on the first click and desc on the second, and never reorders the rows', () => {
      const onSortChange = vi.fn();
      const { rerender } = render(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          sort={null}
          onSortChange={onSortChange}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /tool/i }));
      expect(onSortChange).toHaveBeenCalledWith({ key: 'name', direction: 'asc' });
      rerender(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          sort={{ key: 'name', direction: 'asc' }}
          onSortChange={onSortChange}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /tool/i }));
      expect(onSortChange).toHaveBeenLastCalledWith({ key: 'name', direction: 'desc' });
      const [, first] = screen.getAllByRole('row');
      if (first === undefined) throw new Error('no body row');
      expect(within(first).getByText('refund_customer')).toBeDefined();
    });

    it('shows the state with aria-sort; a column that cannot sort has none', () => {
      render(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          sort={{ key: 'name', direction: 'desc' }}
          onSortChange={vi.fn()}
        />
      );
      expect(screen.getByRole('columnheader', { name: /tool/i }).getAttribute('aria-sort')).toBe(
        'descending'
      );
      expect(
        screen.getByRole('columnheader', { name: /confidence/i }).getAttribute('aria-sort')
      ).toBeNull();
    });

    it('two-state cycle: desc goes back to asc, and another column starts at asc', () => {
      const both: DataTableColumn<Row>[] = [
        { key: 'name', header: 'Tool', sortable: true },
        { key: 'confidence', header: 'Confidence', sortable: true },
      ];
      const onSortChange = vi.fn();
      render(
        <DataTable
          columns={both}
          data={rows}
          rowKey={rowKey}
          sort={{ key: 'name', direction: 'desc' }}
          onSortChange={onSortChange}
        />
      );
      expect(
        screen.getByRole('columnheader', { name: /confidence/i }).getAttribute('aria-sort')
      ).toBe('none');
      fireEvent.click(screen.getByRole('button', { name: /tool/i }));
      expect(onSortChange).toHaveBeenLastCalledWith({ key: 'name', direction: 'asc' });
      fireEvent.click(screen.getByRole('button', { name: /confidence/i }));
      expect(onSortChange).toHaveBeenLastCalledWith({ key: 'confidence', direction: 'asc' });
    });

    it('a sortable column without onSortChange shows its state but renders no inert button', () => {
      render(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          sort={{ key: 'name', direction: 'asc' }}
        />
      );
      expect(screen.queryByRole('button')).toBeNull();
      const header = screen.getByRole('columnheader', { name: 'Tool' });
      expect(header.getAttribute('aria-sort')).toBe('ascending');
    });
  });

  describe('controlled selection', () => {
    it('has no checkbox column unless both selection props are given', () => {
      render(<DataTable columns={columns} data={rows} rowKey={rowKey} selectedKeys={new Set()} />);
      expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('toggles one row by its key, and an already selected one off', () => {
      const onSelectionChange = vi.fn();
      const { rerender } = render(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          selectedKeys={new Set()}
          onSelectionChange={onSelectionChange}
        />
      );
      fireEvent.click(checkbox('Select row r2'));
      expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['r2']));
      rerender(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          selectedKeys={new Set(['r2'])}
          onSelectionChange={onSelectionChange}
        />
      );
      fireEvent.click(checkbox('Select row r2'));
      expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
    });

    it('the header box adds this page to the selection and removes only this page', () => {
      const onSelectionChange = vi.fn();
      const { rerender } = render(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          selectedKeys={new Set(['off-page'])}
          onSelectionChange={onSelectionChange}
        />
      );
      fireEvent.click(checkbox('Select all rows'));
      expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['off-page', 'r1', 'r2', 'r3']));
      rerender(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          selectedKeys={new Set(['r1', 'r2', 'r3', 'off-page'])}
          onSelectionChange={onSelectionChange}
        />
      );
      fireEvent.click(checkbox('Deselect all rows'));
      expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['off-page']));
    });

    it('a partial page shows a mixed header box that selects the rest', () => {
      const onSelectionChange = vi.fn();
      render(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          selectedKeys={new Set(['r1'])}
          onSelectionChange={onSelectionChange}
        />
      );
      const header = checkbox('Select all rows');
      expect(header.indeterminate).toBe(true);
      expect(header.hasAttribute('aria-checked')).toBe(false);
      fireEvent.click(header);
      expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['r1', 'r2', 'r3']));
    });

    it('shows the controlled state on the box and the row', () => {
      render(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          selectedKeys={new Set(['r2'])}
          onSelectionChange={vi.fn()}
        />
      );
      expect(checkbox('Select row r2').checked).toBe(true);
      expect(checkbox('Select row r2').closest('tr')?.dataset.selected).toBe('true');
      expect(checkbox('Select row r1').checked).toBe(false);
    });

    it('takes other words for the boxes', () => {
      render(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          selectedKeys={new Set(['r1', 'r2', 'r3'])}
          onSelectionChange={vi.fn()}
          labels={{ deselectAll: 'None', selectAll: 'All', selectRow: (key) => `Pick ${key}` }}
        />
      );
      expect(checkbox('None')).toBeDefined();
      expect(checkbox('Pick r1')).toBeDefined();
    });

    it('selection clicks do not open the row', () => {
      const onRowClick = vi.fn();
      render(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          selectedKeys={new Set()}
          onSelectionChange={vi.fn()}
          onRowClick={onRowClick}
        />
      );
      fireEvent.click(checkbox('Select row r1'));
      expect(onRowClick).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('refund_customer'));
      expect(onRowClick).toHaveBeenCalledWith(rows[0]);
    });
  });

  it('a click on a button or link in a cell runs only that control, not onRowClick', () => {
    const onRowClick = vi.fn();
    const onDelete = vi.fn();
    render(
      <DataTable
        columns={[
          ...columns,
          {
            key: 'actions',
            header: 'Actions',
            render: (row: Row) => (
              <>
                <button type="button" onClick={onDelete}>
                  <span>Delete {row.id}</span>
                </button>
                <a href={`#open-${row.id}`}>Open {row.id}</a>
              </>
            ),
          },
        ]}
        data={rows}
        rowKey={rowKey}
        onRowClick={onRowClick}
      />
    );
    // The click lands on the button's inner span, as a real click on its label would.
    fireEvent.click(screen.getByText('Delete r1'));
    fireEvent.click(screen.getByRole('link', { name: 'Open r1' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('refund_customer'));
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });

  describe('keyboard access for the row action', () => {
    it('Enter and Space on a focused row open it; keys from inner controls and other keys do not', () => {
      const onRowClick = vi.fn();
      render(
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          selectedKeys={new Set()}
          onSelectionChange={vi.fn()}
          onRowClick={onRowClick}
        />
      );
      const row = screen.getByText('refund_customer').closest('tr') as HTMLElement;
      expect(row.getAttribute('tabindex')).toBe('0');
      fireEvent.keyDown(row, { key: 'Enter' });
      fireEvent.keyDown(row, { key: ' ' });
      fireEvent.keyDown(row, { key: 'a' });
      expect(onRowClick).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(checkbox('Select row r1'), { key: 'Enter' });
      expect(onRowClick).toHaveBeenCalledTimes(2);
    });

    it('rows are not focusable without onRowClick', () => {
      render(<DataTable columns={columns} data={rows} rowKey={rowKey} />);
      expect(
        screen.getByText('refund_customer').closest('tr')?.getAttribute('tabindex')
      ).toBeNull();
    });
  });

  describe('loading and empty', () => {
    it('renders skeleton rows while loading, with a disabled header box', () => {
      const { container } = render(
        <DataTable
          columns={columns}
          data={[]}
          rowKey={rowKey}
          loading
          loadingRowCount={3}
          selectedKeys={new Set()}
          onSelectionChange={vi.fn()}
        />
      );
      expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
      expect(container.querySelectorAll('tbody .nc-skeleton')).toHaveLength(9);
      expect(checkbox('Select all rows').disabled).toBe(true);
      expect(screen.queryByText('No results.')).toBeNull();
    });

    it('renders five skeleton rows by default', () => {
      const { container } = render(
        <DataTable columns={columns} data={rows} rowKey={rowKey} loading />
      );
      expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    });

    it('renders the default or a custom empty message across the table, and the toolbar', () => {
      const { rerender } = render(<DataTable columns={columns} data={[]} rowKey={rowKey} />);
      expect(screen.getByText('No results.')).toBeDefined();
      expect(screen.getByRole('cell').getAttribute('colspan')).toBe('2');
      rerender(
        <DataTable
          columns={columns}
          data={[]}
          rowKey={rowKey}
          labels={{ empty: 'Nothing here.' }}
        />
      );
      expect(screen.getByText('Nothing here.')).toBeDefined();
      rerender(
        <DataTable
          columns={columns}
          data={[]}
          rowKey={rowKey}
          empty={<div data-testid="custom-empty">Nothing to review</div>}
          toolbar={<input aria-label="Filter" />}
        />
      );
      expect(screen.getByTestId('custom-empty')).toBeDefined();
      expect(screen.getByLabelText('Filter')).toBeDefined();
    });
  });
});
