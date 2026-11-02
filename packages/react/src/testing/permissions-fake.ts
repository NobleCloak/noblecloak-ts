/**
 * A permissions controller with no service behind it, for stories and the browser fixture: fixed policies and tools,
 * the grid built by the real `buildPermissionsMatrix`, and editors and simulations that hold one snapshot each. Not
 * part of the published package.
 */
import type { EffectiveSnapshot, EffectiveStore } from '../permissions-effective.js';
import { buildPermissionsMatrix } from '../permissions-matrix.js';
import { policyOf } from '../permissions-parse.js';
import type {
  PoliciesController,
  PoliciesSnapshot,
  PolicyEditorSnapshot,
  PolicyEditorStore,
  PolicyInfo,
  PolicySimulationSnapshot,
  PolicySimulationStore,
  RoleOption,
  ToolInfo,
} from '../permissions-types.js';

function policy(row: Record<string, unknown>): PolicyInfo {
  const parsed = policyOf({
    version: 3,
    source: 'authored',
    kind: 'tool_invocation',
    state: 'published',
    published_at: '2026-10-01T09:00:00.000Z',
    updated_at: '2026-10-01T09:00:00.000Z',
    updated_by: { id: 'user_admin', kind: 'user' },
    ...row,
  });
  if (parsed === undefined)
    throw new Error(`fixture policy does not parse: ${JSON.stringify(row)}`);
  return parsed;
}

export const FAKE_TOOLS: readonly ToolInfo[] = [
  {
    id: 't1',
    toolRef: 'mcp:tracker:search',
    connectionId: 'conn_tracker',
    status: 'active',
    statusKnown: true,
  },
  {
    id: 't2',
    toolRef: 'mcp:tracker:create_issue',
    connectionId: 'conn_tracker',
    status: 'active',
    statusKnown: true,
  },
  {
    id: 't3',
    toolRef: 'mcp:crm:delete_account',
    connectionId: 'conn_crm',
    status: 'active',
    statusKnown: true,
  },
  {
    id: 't4',
    toolRef: 'ext:local:send_email',
    connectionId: null,
    status: 'active',
    statusKnown: true,
  },
];

export const FAKE_POLICIES: readonly PolicyInfo[] = [
  policy({
    id: 'pol_ask',
    name: 'Ask before tracker writes',
    subjects: [{ type: 'role', id: 'member' }],
    targets: { tools: ['mcp:tracker:create_issue', 'ext:local:send_email'] },
    config: { mode: 'ask', on_deny: 'resume', expires_after: 'PT1H' },
  }),
  policy({
    id: 'pol_crm',
    name: 'No account deletion',
    subjects: [{ type: 'organization' }],
    targets: { tools: ['mcp:crm:delete_account'] },
    config: { mode: 'deny' },
  }),
  policy({
    id: 'pol_admin',
    name: 'Admins search freely',
    subjects: [{ type: 'role', id: 'admin' }],
    targets: { tools: ['mcp:tracker:search'] },
    config: { mode: 'always_allow' },
  }),
  policy({
    id: 'pol_bot',
    name: 'The triage agent escalates',
    subjects: [{ type: 'agent', id: 'agt_triage' }],
    targets: { tools: 'all' },
    config: { mode: 'escalate' },
  }),
  policy({
    id: 'pol_draft',
    version: 1,
    state: 'draft',
    published_at: null,
    name: 'Members search (draft)',
    subjects: [{ type: 'role', id: 'member' }],
    targets: { tools: ['mcp:tracker:search'] },
    config: { mode: 'always_allow' },
  }),
];

const subscribeNothing = (): (() => void) => () => undefined;

function editorStore(snapshot: PolicyEditorSnapshot): PolicyEditorStore {
  const failed = Promise.resolve({
    ok: false as const,
    error: {
      kind: 'precondition' as const,
      code: 'read_only' as const,
      title: 'fixture',
      local: true as const,
    },
  });
  return {
    subscribe: subscribeNothing,
    getSnapshot: () => snapshot,
    reload: () => Promise.resolve(),
    edit: () => undefined,
    setMode: () => undefined,
    setCondition: () => undefined,
    save: () => failed,
    publish: () => failed,
  };
}

function simulationStore(snapshot: PolicySimulationSnapshot): PolicySimulationStore {
  return {
    subscribe: subscribeNothing,
    getSnapshot: () => snapshot,
    run: () =>
      Promise.resolve({
        ok: false,
        error: { kind: 'precondition', code: 'not_loaded', title: 'fixture', local: true },
      }),
  };
}

/** The editor snapshot of a fixture policy: loaded, its working copy the published version. */
export function fakeEditorSnapshot(p: PolicyInfo): PolicyEditorSnapshot {
  return {
    id: p.id,
    status: 'ready',
    current: p,
    versions: [p],
    ...(p.state === 'draft' ? { pendingDraft: p } : {}),
    working: {
      kind: p.kind,
      ...(p.name === undefined ? {} : { name: p.name }),
      subjects: p.subjects,
      targets: p.targets ?? 'all',
      config: p.config,
    },
    workingFrom: { version: p.version, state: p.state },
    dirty: false,
    notes: [],
    saving: false,
    publishing: false,
    stale: false,
  };
}

export interface FakePoliciesOptions {
  readonly snapshot?: Partial<PoliciesSnapshot>;
  readonly roles?: readonly RoleOption[];
  readonly simulation?: Partial<PolicySimulationSnapshot>;
  /** The effective view's state; by default `ready` with no cell computed. */
  readonly effective?: Partial<EffectiveSnapshot>;
}

/** A controller over the fixture policies; `snapshot` replaces members of its state. */
export function fakePoliciesController(options: FakePoliciesOptions = {}): PoliciesController {
  const base: PoliciesSnapshot = {
    status: 'ready',
    facts: {
      served: true,
      author: true,
      publish: true,
      importExport: false,
      principals: false,
      connections: true,
      runs: true,
      suggested: false,
      approvals: true,
      tightestWins: true,
      retire: true,
    },
    policies: FAKE_POLICIES,
    tools: FAKE_TOOLS,
    others: {
      status: 'ready',
      policies: [
        {
          policy: policy({
            id: 'pol_dup',
            kind: 'duplicate_requests',
            name: 'Repeat after rejection',
            subjects: [{ type: 'organization' }],
            targets: { tools: 'all' },
            config: { after_rejection: 'ask_again', max_reasks: 2 },
          }),
          view: { kind: 'duplicate_requests', afterRejection: 'ask_again', maxReasks: 2 },
        },
      ],
    },
    suggested: { status: 'off', policies: [] },
    directoryRoles: [],
    connectionNames: { conn_tracker: 'Tracker' },
    sideErrors: {},
    drafts: [
      {
        policyId: 'pol_draft',
        name: 'Members search (draft)',
        version: 1,
        neverPublished: true,
        policy: FAKE_POLICIES[4] ?? policy({ id: 'x', subjects: [], config: {} }),
      },
    ],
    authoring: { readOnly: false, canPublish: true, canRetire: true },
    busy: new Set(),
    ...options.snapshot,
  };
  const matrix =
    base.status === 'ready'
      ? buildPermissionsMatrix(base, options.roles ?? [{ id: 'member' }])
      : undefined;
  const byId = new Map(base.policies.map((p) => [p.id, p]));
  const effectiveSnapshot: EffectiveSnapshot = {
    status: 'ready',
    basis: { kind: 'published' },
    composition: base.facts?.tightestWins === true,
    cells: new Map(),
    unsupportedSubjects: new Set(),
    round: 1,
    ...options.effective,
  };
  const effectiveStore: EffectiveStore = {
    subscribe: () => () => undefined,
    getSnapshot: () => effectiveSnapshot,
    request: () => undefined,
    setBasis: () => undefined,
    retry: () => undefined,
  };
  return {
    ...base,
    ...(matrix === undefined ? {} : { matrix }),
    refresh: () => Promise.resolve(),
    setCell: () =>
      Promise.resolve({
        kind: 'error',
        error: { kind: 'precondition', code: 'read_only', title: 'fixture', local: true },
      }),
    create: () =>
      Promise.resolve({
        ok: false,
        error: { kind: 'precondition', code: 'read_only', title: 'fixture', local: true },
      }),
    publish: () =>
      Promise.resolve({
        ok: false,
        error: { kind: 'precondition', code: 'read_only', title: 'fixture', local: true },
      }),
    retire: () =>
      Promise.resolve({
        ok: false,
        error: { kind: 'precondition', code: 'read_only', title: 'fixture', local: true },
      }),
    discardDraft: () =>
      Promise.resolve({
        ok: false,
        error: { kind: 'precondition', code: 'read_only', title: 'fixture', local: true },
      }),
    editor: (id) => {
      const p = byId.get(id);
      return editorStore(
        p === undefined
          ? {
              id,
              status: 'not_found',
              versions: [],
              dirty: false,
              notes: [],
              saving: false,
              publishing: false,
              stale: false,
            }
          : fakeEditorSnapshot(p)
      );
    },
    simulation: (id) => simulationStore({ id, status: 'idle', ...options.simulation }),
    effective: () => effectiveStore,
    latest: (id) => {
      const p = byId.get(id);
      return Promise.resolve(
        p === undefined
          ? { ok: false, error: { kind: 'not_found', code: 'not_found', title: 'fixture' } }
          : { ok: true, policy: p }
      );
    },
    saveImported: () =>
      Promise.resolve({
        ok: false,
        error: { kind: 'precondition', code: 'read_only', title: 'fixture', local: true },
      }),
  };
}
