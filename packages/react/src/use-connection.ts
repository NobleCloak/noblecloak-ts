/**
 * `useConnection`: binds the tools of one registration, held by the store behind `useConnections`, to React with
 * `useSyncExternalStore`. The hook imports no CSS and no component. The view reads the registered tools on its first
 * subscriber, and asks the server what it offers now only on `discover()`.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type {
  ConnectionController,
  ConnectionDetailStore,
  ConnectionsController,
} from './connections-types.js';

/** The registration `id` from the list, its registered tools, and the last live enumeration. */
export function useConnection(
  connections: ConnectionsController,
  id: string
): ConnectionController {
  const { detail: detailOf } = connections;
  const view: ConnectionDetailStore = useMemo(() => detailOf(id), [detailOf, id]);
  const subscribe = useCallback((listener: () => void) => view.subscribe(listener), [view]);
  const getSnapshot = useCallback(() => view.getSnapshot(), [view]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const connection = connections.connections.find((c) => c.id === id);

  const reload = useCallback(() => view.reload(), [view]);
  const discover = useCallback(() => view.discover(), [view]);
  return useMemo(
    () => ({ ...snapshot, ...(connection === undefined ? {} : { connection }), reload, discover }),
    [snapshot, connection, reload, discover]
  );
}
