/** The package name, as published. */
export const PACKAGE_NAME = '@noblecloak/theme';

/**
 * A fixed marker, always '0.0.0', kept so the entry matches @noblecloak/react's. It is not the package version:
 * changesets bump package.json and never this constant, so read the version from package.json.
 */
export const VERSION = '0.0.0';

export { cn } from './cn.js';
export type { ClassPart } from './cn.js';
export * from './a11y/index.js';

export { Alert, AlertDescription, AlertTitle } from './components/Alert.js';
export type { AlertProps, AlertVariant } from './components/Alert.js';
export { Avatar } from './components/Avatar.js';
export type { AvatarProps } from './components/Avatar.js';
export { Badge } from './components/Badge.js';
export type { BadgeProps, BadgeVariant } from './components/Badge.js';
export { Button } from './components/Button.js';
export type { ButtonProps, ButtonSize, ButtonVariant } from './components/Button.js';
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './components/Card.js';
export type { CardProps } from './components/Card.js';
export { Checkbox } from './components/Checkbox.js';
export type { CheckboxProps } from './components/Checkbox.js';
export { ConfirmDialog } from './components/ConfirmDialog.js';
export type { ConfirmDialogProps } from './components/ConfirmDialog.js';
export { DataTable } from './components/DataTable.js';
export type {
  DataTableColumn,
  DataTableLabels,
  DataTableProps,
  DataTableSort,
  DataTableSortDirection,
} from './components/DataTable.js';
export {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/Dialog.js';
export type { DialogProps } from './components/Dialog.js';
export { EmptyState } from './components/EmptyState.js';
export type { EmptyStateProps } from './components/EmptyState.js';
export { Input } from './components/Input.js';
export type { InputProps } from './components/Input.js';
export { Label } from './components/Label.js';
export type { LabelProps } from './components/Label.js';
export { Pagination } from './components/Pagination.js';
export type { PaginationLabels, PaginationProps } from './components/Pagination.js';
export { Select } from './components/Select.js';
export type { SelectOption, SelectProps } from './components/Select.js';
export { Separator } from './components/Separator.js';
export type { SeparatorProps } from './components/Separator.js';
export { Skeleton } from './components/Skeleton.js';
export type { SkeletonProps } from './components/Skeleton.js';
export { Spinner } from './components/Spinner.js';
export type { SpinnerProps } from './components/Spinner.js';
export { Switch } from './components/Switch.js';
export type { SwitchProps } from './components/Switch.js';
export { Tabs } from './components/Tabs.js';
export type { TabsItem, TabsProps } from './components/Tabs.js';
export { Textarea } from './components/Textarea.js';
export type { TextareaProps } from './components/Textarea.js';
export { Tooltip } from './components/Tooltip.js';
export type { TooltipProps } from './components/Tooltip.js';

export type { NcComponents } from './slot-context.js';
export { NcComponentsContext, useSlot } from './slot-context.js';
export { defaultComponents, NcComponentsProvider, useNcComponents } from './defaults.js';
export type { NcComponentsProviderProps } from './defaults.js';
