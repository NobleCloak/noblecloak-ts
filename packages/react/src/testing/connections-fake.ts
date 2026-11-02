/**
 * A connections controller with no service behind it, for stories and the browser fixture: fixed registrations and
 * tools, read by the module's own parsers, and detail views that hold one snapshot each. Every change answers a fixed
 * refusal-free result and changes nothing. Not part of the published package.
 */
import { connectionOf, connectionToolOf } from '../connections-parse.js';
import { toolRowsOf } from '../connections-store.js';
import type {
  ConnectionDetailSnapshot,
  ConnectionDetailStore,
  ConnectionInfo,
  ConnectionToolInfo,
  ConnectionsController,
  ConnectionsSnapshot,
} from '../connections-types.js';

function connection(row: Record<string, unknown>): ConnectionInfo {
  const parsed = connectionOf({
    transport: 'mcp',
    owner: { kind: 'org', id: 'org_demo' },
    created_at: '2026-10-01T09:00:00.000Z',
    last_verified_at: '2026-10-22T09:00:00.000Z',
    ...row,
  });
  if (parsed === undefined)
    throw new Error(`fixture connection does not parse: ${JSON.stringify(row)}`);
  return parsed;
}

function tool(row: Record<string, unknown>): ConnectionToolInfo {
  const parsed = connectionToolOf({ transport: 'mcp', side_effect_level: 'read', ...row });
  if (parsed === undefined) throw new Error(`fixture tool does not parse: ${JSON.stringify(row)}`);
  return parsed;
}

export const FAKE_CONNECTIONS: readonly ConnectionInfo[] = [
  connection({
    id: 'conn_tracker',
    name: 'Issue tracker',
    url: 'https://tracker.example.com/mcp',
    status: 'connected',
    auth_kind: 'bearer',
    credential_tier: 'per_user',
    my_link: { status: 'linked', consent: 'given', linked_at: '2026-10-20T10:00:00.000Z' },
  }),
  connection({
    id: 'conn_crm',
    name: 'CRM',
    url: 'https://crm.example.com/mcp',
    status: 'pending_authorization',
    auth_kind: 'oauth',
    credential_tier: 'org_shared',
  }),
  connection({
    id: 'conn_docs',
    name: 'Docs search',
    url: 'https://docs.example.com/mcp',
    status: 'degraded',
    status_detail: 'unreachable',
    auth_kind: 'oauth',
    credential_tier: 'per_user',
    my_link: { status: 'none', consent: 'none' },
  }),
];

export const FAKE_TOOLS: Readonly<Record<string, readonly ConnectionToolInfo[]>> = {
  conn_tracker: [
    tool({
      id: 't1',
      tool_ref: 'tracker/search',
      connection_id: 'conn_tracker',
      description: 'Search issues',
    }),
    tool({
      id: 't2',
      tool_ref: 'tracker/create_issue',
      connection_id: 'conn_tracker',
      description: 'Create an issue',
      side_effect_level: 'write',
    }),
    tool({
      id: 't3',
      tool_ref: 'tracker/close_all',
      connection_id: 'conn_tracker',
      description: 'Close every issue',
      side_effect_level: 'delete',
      status: 'withdrawn',
    }),
  ],
};

function fixedDetail(id: string): ConnectionDetailStore {
  const tools = FAKE_TOOLS[id] ?? [];
  const snapshot: ConnectionDetailSnapshot = Object.freeze({
    status: 'ready',
    tools,
    discovery: { status: 'idle' as const, tools: [] },
    rows: toolRowsOf(tools, undefined),
  });
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    reload: () => Promise.resolve(),
    discover: () => Promise.resolve(),
  };
}

/** A controller over the fixture registrations, with every capability advertised unless `snapshot` says otherwise. */
export function fakeConnectionsController(
  snapshot: Partial<ConnectionsSnapshot> = {}
): ConnectionsController {
  const details = new Map<string, ConnectionDetailStore>();
  const ok = () => Promise.resolve({ ok: true as const });
  const unchanged = (id: string) => {
    const found = FAKE_CONNECTIONS.find((c) => c.id === id) ?? FAKE_CONNECTIONS[0];
    if (found === undefined) throw new Error('no fixture connection');
    return Promise.resolve({ ok: true as const, connection: found });
  };
  return {
    status: 'ready',
    facts: {
      served: true,
      oauth: true,
      userLinks: true,
      transports: ['mcp', 'a2a'],
    },
    connections: FAKE_CONNECTIONS,
    pending: new Set<string>(),
    administration: { readOnly: false },
    ...snapshot,
    reload: () => Promise.resolve(),
    create: () => unchanged('conn_tracker'),
    rename: (id) => unchanged(id),
    remove: ok,
    refresh: () =>
      Promise.resolve({
        ok: true as const,
        counts: {
          toolCount: 2,
          added: 0,
          removed: 0,
          reactivated: 0,
          emptyUpstreamSuppressed: false,
        },
      }),
    rotateOrgCredential: (id) => unchanged(id),
    link: (id) => unchanged(id),
    unlink: ok,
    revokeConsent: ok,
    authorize: () =>
      Promise.resolve({ ok: true as const, url: 'https://auth.example.com/authorize' }),
    detail: (id) => {
      const known = details.get(id);
      if (known !== undefined) return known;
      const made = fixedDetail(id);
      details.set(id, made);
      return made;
    },
    dismissReturn: () => undefined,
  };
}
