/**
 * The `connections` module entry: `useConnections` (the hook over the headless store), `createConnectionsStore`,
 * `useConnection` (one registration's tools), the components `Connections`, `ConnectionDetail` and `AddConnection`, the
 * module's types and `MODULE_ID`. A client entry: the hooks import no component, and an import of only a hook bundles
 * none.
 */
export const MODULE_ID = 'connections';

export type {
  ConnectionActionResult,
  ConnectionAuthorizeResult,
  ConnectionController,
  ConnectionCreateInput,
  ConnectionDetailSnapshot,
  ConnectionDetailStore,
  ConnectionInfo,
  ConnectionLinkInfo,
  ConnectionLinkInput,
  ConnectionOwner,
  ConnectionRefreshCounts,
  ConnectionRefreshResult,
  ConnectionReturn,
  ConnectionReturnError,
  ConnectionToolInfo,
  ConnectionToolRow,
  ConnectionWriteResult,
  ConnectionsAdministration,
  ConnectionsCapabilityFacts,
  ConnectionsController,
  ConnectionsError,
  ConnectionsErrorKind,
  ConnectionsPreconditionCode,
  ConnectionsSnapshot,
  ConnectionsStatus,
  ConnectionsStore,
  UseConnectionsOptions,
} from './connections-types.js';

export { createConnectionsStore } from './connections-store.js';
export { useConnections } from './use-connections.js';
export { useConnection } from './use-connection.js';
export { AddConnection, ConnectionDetail, Connections } from './components/Connections.js';
export type {
  AddConnectionProps,
  ConnectionDetailProps,
  ConnectionPreset,
  ConnectionsProps,
} from './components/Connections.js';
export type { ConnectionsLabelKey, ConnectionsLabels } from './components/connections-labels.js';
export type { ModuleComponents as ConnectionsComponents } from './components/slots.js';
