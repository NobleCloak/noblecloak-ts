import { createContext, useContext } from 'react';
import type { ComponentType, ReactNode } from 'react';

import type { AlertProps } from './components/Alert.js';
import type { AvatarProps } from './components/Avatar.js';
import type { BadgeProps } from './components/Badge.js';
import type { ButtonProps } from './components/Button.js';
import type { CardProps } from './components/Card.js';
import type { CheckboxProps } from './components/Checkbox.js';
import type { ConfirmDialogProps } from './components/ConfirmDialog.js';
import type { DataTableProps } from './components/DataTable.js';
import type { DialogProps } from './components/Dialog.js';
import type { EmptyStateProps } from './components/EmptyState.js';
import type { InputProps } from './components/Input.js';
import type { LabelProps } from './components/Label.js';
import type { PaginationProps } from './components/Pagination.js';
import type { SelectProps } from './components/Select.js';
import type { SeparatorProps } from './components/Separator.js';
import type { SkeletonProps } from './components/Skeleton.js';
import type { SpinnerProps } from './components/Spinner.js';
import type { SwitchProps } from './components/Switch.js';
import type { TabsProps } from './components/Tabs.js';
import type { TextareaProps } from './components/Textarea.js';
import type { TooltipProps } from './components/Tooltip.js';

/**
 * Every primitive the theme carries, named by its role. A module (or a builder) renders a primitive through
 * this map, so replacing one entry replaces that primitive everywhere it is rendered, including inside the
 * theme's own composites (`ConfirmDialog`, `Pagination` and `DataTable` render the `Button`, `Dialog`,
 * `Alert`, `Checkbox` and `Skeleton` of the map).
 */
export interface NcComponents {
  Alert: ComponentType<AlertProps>;
  Avatar: ComponentType<AvatarProps>;
  Badge: ComponentType<BadgeProps>;
  Button: ComponentType<ButtonProps>;
  Card: ComponentType<CardProps>;
  Checkbox: ComponentType<CheckboxProps>;
  ConfirmDialog: ComponentType<ConfirmDialogProps>;
  DataTable: <T>(props: DataTableProps<T>) => ReactNode;
  Dialog: ComponentType<DialogProps>;
  EmptyState: ComponentType<EmptyStateProps>;
  Input: ComponentType<InputProps>;
  Label: ComponentType<LabelProps>;
  Pagination: ComponentType<PaginationProps>;
  Select: ComponentType<SelectProps>;
  Separator: ComponentType<SeparatorProps>;
  Skeleton: ComponentType<SkeletonProps>;
  Spinner: ComponentType<SpinnerProps>;
  Switch: ComponentType<SwitchProps>;
  Tabs: ComponentType<TabsProps>;
  Textarea: ComponentType<TextareaProps>;
  Tooltip: ComponentType<TooltipProps>;
}

/** The replacements in force below an `NcComponentsProvider`; an entry left out falls back to the default. */
export const NcComponentsContext = /* @__PURE__ */ createContext<Partial<NcComponents> | null>(
  null
);

/**
 * The slot `name` of the nearest provider, or `fallback` (the theme's own primitive). The composites call this
 * rather than importing the defaults map, so the map can import them without a cycle.
 */
export function useSlot<K extends keyof NcComponents>(
  name: K,
  fallback: NcComponents[K]
): NcComponents[K] {
  return useContext(NcComponentsContext)?.[name] ?? fallback;
}
