import { useMemo } from 'react';
import type { AriaAttributes, ReactNode } from 'react';

import { cn } from '../cn.js';
import { useSlot } from '../slot-context.js';
import { Button as DefaultButton } from './Button.js';
import { Checkbox as DefaultCheckbox } from './Checkbox.js';
import { Skeleton as DefaultSkeleton } from './Skeleton.js';

export type DataTableSortDirection = 'asc' | 'desc';

export interface DataTableSort {
  /** The `key` of the column the data is sorted by. */
  readonly key: string;
  readonly direction: DataTableSortDirection;
}

export interface DataTableColumn<T> {
  /** Stable column id; also the `sort.key` of a sortable column. */
  readonly key: string;
  readonly header: ReactNode;
  /**
   * Shows the column's sort state (`aria-sort`) and, with `onSortChange`, makes the header a sort button.
   * Sorting itself is the caller's (the table never reorders rows).
   */
  readonly sortable?: boolean;
  /** Renders the cell; left out, the row's property named by `key` is shown as text. */
  readonly render?: (row: T) => ReactNode;
  readonly align?: 'left' | 'center' | 'right';
  /** A CSS width for the column. */
  readonly width?: string;
}

export interface DataTableLabels {
  readonly selectAll?: string;
  readonly deselectAll?: string;
  /** The checkbox name of one row, given its key. */
  readonly selectRow?: (key: string) => string;
  readonly empty?: string;
}

export interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[];
  data: readonly T[];
  /** A stable key per row; also the unit of selection. */
  rowKey: (row: T) => string;
  /** Controlled sort: the table shows it (indicator and `aria-sort`) and reports clicks through `onSortChange`. */
  sort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort) => void;
  /**
   * Controlled selection: pass both to get a checkbox column. The header box adds or removes the keys of the
   * rows on this page only; keys from other pages are kept.
   */
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  /** Shows `loadingRowCount` skeleton rows (5) instead of the data. */
  loading?: boolean;
  loadingRowCount?: number;
  /** Shown across the table when `data` is empty and not loading (an EmptyState, say). */
  empty?: ReactNode;
  /** Filters or actions above the table. */
  toolbar?: ReactNode;
  /**
   * Makes each row a pointer and keyboard shortcut: clicked, or Enter or Space while focused. Clicks and keys on
   * a control inside the row (a link, button, form field or label in a cell) are left to that control. A focusable row
   * announces no action to assistive technology (a `<tr>` has no button role), so put the same action in a
   * real link or button inside a cell too; this handler is the convenience, not the only way in.
   */
  onRowClick?: (row: T) => void;
  className?: string;
  'aria-label'?: string;
  labels?: DataTableLabels;
}

/** `JSON.stringify` as it behaves: it returns undefined for a function or a symbol (its lib type says string). */
const toJson: (value: unknown) => string | undefined = JSON.stringify;

function defaultCell(row: unknown, key: string): ReactNode {
  const value = (row as Record<string, unknown>)[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  // JSON for plain data. What JSON cannot encode renders as text or nothing, so one cell cannot throw the
  // whole table: a circular value is its tag ('[object Object]'), a function or symbol nothing.
  try {
    return toJson(value) ?? null;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

type SortState = Extract<AriaAttributes['aria-sort'], 'ascending' | 'descending' | 'none'>;

function ariaSort(
  column: { key: string; sortable?: boolean },
  sort: DataTableSort | null | undefined
): SortState | undefined {
  if (column.sortable !== true) return undefined;
  if (sort?.key !== column.key) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

const SORT_GLYPH: Record<SortState, string> = { ascending: '▲', descending: '▼', none: '↕' };

/** The interactive elements a row click leaves to themselves. */
const ROW_CONTROLS =
  'a[href], button, input, select, textarea, label, summary, [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="switch"]';

/** True when `target` is in a control between it and `row` (the row itself does not count). */
function insideControl(target: EventTarget, row: Element): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(ROW_CONTROLS);
  return control !== null && control !== row && row.contains(control);
}

/**
 * A controlled table for server-driven data: sorting, selection and paging belong to the caller, and the table
 * renders state and reports intents. Pair it with `Pagination`. Its checkboxes and skeletons are the slots of
 * the nearest `NcComponentsProvider`.
 */
export function DataTable<T>({
  columns,
  data,
  rowKey,
  sort,
  onSortChange,
  selectedKeys,
  onSelectionChange,
  loading = false,
  loadingRowCount = 5,
  empty,
  toolbar,
  onRowClick,
  className,
  'aria-label': ariaLabel,
  labels = {},
}: DataTableProps<T>) {
  const Button = useSlot('Button', DefaultButton);
  const Checkbox = useSlot('Checkbox', DefaultCheckbox);
  const Skeleton = useSlot('Skeleton', DefaultSkeleton);
  const selection =
    selectedKeys !== undefined && onSelectionChange !== undefined
      ? { selectedKeys, onSelectionChange }
      : null;
  const pageKeys = useMemo(() => data.map(rowKey), [data, rowKey]);
  const allSelected =
    selection !== null &&
    pageKeys.length > 0 &&
    pageKeys.every((k) => selection.selectedKeys.has(k));
  const someSelected = selection !== null && pageKeys.some((k) => selection.selectedKeys.has(k));

  const toggleAll = () => {
    if (selection === null) return;
    const next = new Set(selection.selectedKeys);
    for (const key of pageKeys) {
      if (allSelected) next.delete(key);
      else next.add(key);
    }
    selection.onSelectionChange(next);
  };

  const toggleRow = (key: string) => {
    if (selection === null) return;
    const next = new Set(selection.selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selection.onSelectionChange(next);
  };

  const sortBy = (column: DataTableColumn<T>) => {
    if (onSortChange === undefined) return;
    const direction: DataTableSortDirection =
      sort?.key === column.key && sort.direction === 'asc' ? 'desc' : 'asc';
    onSortChange({ key: column.key, direction });
  };

  const columnCount = columns.length + (selection !== null ? 1 : 0);
  const rowName = labels.selectRow ?? ((key: string) => `Select row ${key}`);

  let body: ReactNode;
  if (loading) {
    body = Array.from({ length: loadingRowCount }, (_, index) => (
      <tr key={`skeleton-${String(index)}`} className="nc-ui nc-tr">
        {selection !== null ? (
          <td className="nc-ui nc-td nc-td-select">
            <Skeleton style={{ width: '1em' }} />
          </td>
        ) : null}
        {columns.map((column) => (
          <td key={column.key} className="nc-ui nc-td">
            <Skeleton style={{ maxWidth: '10em' }} />
          </td>
        ))}
      </tr>
    ));
  } else if (data.length === 0) {
    body = (
      <tr className="nc-ui nc-tr">
        <td colSpan={columnCount} className="nc-ui nc-td">
          {empty ?? <p className="nc-ui nc-table-empty">{labels.empty ?? 'No results.'}</p>}
        </td>
      </tr>
    );
  } else {
    body = data.map((row) => {
      const key = rowKey(row);
      const selected = selection?.selectedKeys.has(key) === true;
      return (
        <tr
          key={key}
          className="nc-ui nc-tr"
          data-selected={selected ? 'true' : undefined}
          data-clickable={onRowClick !== undefined ? 'true' : undefined}
          tabIndex={onRowClick !== undefined ? 0 : undefined}
          onClick={
            onRowClick !== undefined
              ? (event) => {
                  // A click on a control inside the row (a link or button in a cell) is that control's.
                  if (insideControl(event.target, event.currentTarget)) return;
                  onRowClick(row);
                }
              : undefined
          }
          onKeyDown={
            onRowClick !== undefined
              ? (event) => {
                  // Keys on a control inside the row (its checkbox, a link in a cell) are that control's.
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onRowClick(row);
                  }
                }
              : undefined
          }
        >
          {selection !== null ? (
            <td
              className="nc-ui nc-td nc-td-select"
              // Selecting and opening a row are separate gestures: a click on the box does not open the row.
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <Checkbox
                aria-label={rowName(key)}
                checked={selected}
                onCheckedChange={() => {
                  toggleRow(key);
                }}
              />
            </td>
          ) : null}
          {columns.map((column) => (
            <td key={column.key} className="nc-ui nc-td" data-align={column.align}>
              {column.render !== undefined ? column.render(row) : defaultCell(row, column.key)}
            </td>
          ))}
        </tr>
      );
    });
  }

  return (
    <div className={cn('nc-ui', 'nc-table-root', className)}>
      {toolbar !== undefined ? <div className="nc-ui nc-table-toolbar">{toolbar}</div> : null}
      <div className="nc-ui nc-table-scroll">
        <table className="nc-ui nc-table" aria-label={ariaLabel}>
          <thead className="nc-ui nc-thead">
            <tr className="nc-ui nc-tr">
              {selection !== null ? (
                <th scope="col" className="nc-ui nc-th nc-th-select">
                  <Checkbox
                    aria-label={
                      allSelected
                        ? (labels.deselectAll ?? 'Deselect all rows')
                        : (labels.selectAll ?? 'Select all rows')
                    }
                    checked={allSelected}
                    indeterminate={someSelected && !allSelected}
                    disabled={loading || pageKeys.length === 0}
                    onCheckedChange={toggleAll}
                  />
                </th>
              ) : null}
              {columns.map((column) => {
                const state = ariaSort(column, sort);
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={state}
                    data-align={column.align}
                    style={column.width !== undefined ? { width: column.width } : undefined}
                    className="nc-ui nc-th"
                  >
                    {state !== undefined && onSortChange !== undefined ? (
                      <Button
                        type="button"
                        className="nc-sort"
                        onClick={() => {
                          sortBy(column);
                        }}
                      >
                        {column.header}
                        <span className="nc-ui nc-sort-glyph" aria-hidden="true">
                          {SORT_GLYPH[state]}
                        </span>
                      </Button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="nc-ui nc-tbody">{body}</tbody>
        </table>
      </div>
    </div>
  );
}
