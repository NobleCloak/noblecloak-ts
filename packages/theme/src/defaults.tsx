import { useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

import { Alert } from './components/Alert.js';
import { Avatar } from './components/Avatar.js';
import { Badge } from './components/Badge.js';
import { Button } from './components/Button.js';
import { Card } from './components/Card.js';
import { Checkbox } from './components/Checkbox.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { DataTable } from './components/DataTable.js';
import { Dialog } from './components/Dialog.js';
import { EmptyState } from './components/EmptyState.js';
import { Input } from './components/Input.js';
import { Label } from './components/Label.js';
import { Pagination } from './components/Pagination.js';
import { Select } from './components/Select.js';
import { Separator } from './components/Separator.js';
import { Skeleton } from './components/Skeleton.js';
import { Spinner } from './components/Spinner.js';
import { Switch } from './components/Switch.js';
import { Tabs } from './components/Tabs.js';
import { Textarea } from './components/Textarea.js';
import { Tooltip } from './components/Tooltip.js';
import { NcComponentsContext } from './slot-context.js';
import type { NcComponents } from './slot-context.js';

/**
 * The theme's own primitive for every slot. Spread it and replace an entry to swap one primitive. The freeze is marked
 * pure so a bundle that never reads the map (an import of `useSlot` alone) drops it and the primitives with it.
 */
export const defaultComponents: NcComponents = /* @__PURE__ */ Object.freeze({
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  Input,
  Label,
  Pagination,
  Select,
  Separator,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  Textarea,
  Tooltip,
});

export interface NcComponentsProviderProps {
  /** Replacements; an entry left out keeps the default (or the enclosing provider's). */
  components: Partial<NcComponents>;
  children?: ReactNode;
}

/**
 * Replaces primitives for everything rendered below it. Providers nest: the inner one wins per entry. The merged
 * map is kept while `components` and the enclosing map are the same objects, so a consumer below does not
 * re-render when only the provider's parent does (pass a stable `components` for that).
 */
export function NcComponentsProvider({ components, children }: NcComponentsProviderProps) {
  const outer = useContext(NcComponentsContext);
  const value = useMemo(() => ({ ...outer, ...components }), [outer, components]);
  return <NcComponentsContext.Provider value={value}>{children}</NcComponentsContext.Provider>;
}

/** The full component map in force here: the defaults with the nearest providers' replacements applied. */
export function useNcComponents(): NcComponents {
  const replaced = useContext(NcComponentsContext);
  return replaced === null ? defaultComponents : { ...defaultComponents, ...replaced };
}
