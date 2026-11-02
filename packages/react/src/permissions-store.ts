/**
 * The headless store of the permissions module. Constructing it does nothing; the read starts on the first
 * `subscribe`. A read begins with `GET /v1/capabilities` and learns from it alone what the service offers: without
 * the policies family the store is `unavailable` and calls no policy route; without `policies.author` it writes
 * nothing; without `policies.publish` it publishes nothing. Then it reads the `tool_invocation` policies, the tools,
 * the policies of every other kind, and (each only when advertised or asked for) the directory's roles, the
 * connections' names and the suggested policies. Every list is read page by page following `meta.next`.
 *
 * A pending draft of a published policy is visible only through its versions, so the store reads versions lazily: for
 * an editor, before a cell's write and before a publish. A write refused with 403 turns authoring off for the life of
 * the store. No React.
 */
import type { components } from '@noblecloak/client';

import { createExec, jsonOf } from './approvals-exec.js';
import { createEffectiveStore } from './permissions-effective.js';
import type { EffectiveStore } from './permissions-effective.js';
import type { Send } from './approvals-exec.js';
import { reportFault as reportUnhandled } from './fault.js';
import {
  PERMISSIONS_EXEC_ERRORS,
  internalFault,
  isWriteForbidden,
  malformedBody,
  precondition,
} from './permissions-errors.js';
import { isSoleCell, subjectKey } from './permissions-matrix.js';
import {
  connectionNameOf,
  otherViewOf,
  pageOf,
  policyCapabilitiesOf,
  policyEnvelopeOf,
  policyOf,
  principalRoleOf,
  simulationOf,
  toolOf,
} from './permissions-parse.js';
import type {
  AuthoringState,
  CellWriteResult,
  PolicyDiscardResult,
  DraftEntry,
  EditorNote,
  OtherPoliciesState,
  PermissionsError,
  PoliciesSnapshot,
  PoliciesStore,
  PolicyCapabilityFacts,
  PolicyEditorSnapshot,
  PolicyEditorStore,
  PolicyInfo,
  PolicyOrigin,
  PolicySimulationSnapshot,
  PolicySimulationStore,
  PolicySubject,
  PolicyWorkingCopy,
  PolicyWriteResult,
  RoleOption,
  SimulationInput,
  SimulationOutcome,
  SuggestedState,
  ToolInfo,
  UsePoliciesOptions,
} from './permissions-types.js';
import { CONDITION_FIELDS, takesConditions } from './permissions-vocabulary.js';

/** Rows per page: the most the contract's `limit` allows. */
export const PAGE_LIMIT = 200;
/** Pages read of one list before the store stops and reports it: 10 000 rows. */
export const MAX_PAGES = 50;

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PermissionsError }
  | { readonly ok: false; readonly aborted: true };

const aborted = { ok: false, aborted: true } as const;

type PolicyWrite = components['schemas']['PolicyWrite'];

/** The configuration with `mode` set; a mode that takes no conditions drops them. `cleared` says whether any was dropped. */
export function withMode(
  config: Readonly<Record<string, unknown>>,
  mode: string
): { readonly config: Record<string, unknown>; readonly cleared: boolean } {
  const next: Record<string, unknown> = { ...config, mode };
  let cleared = false;
  if (!takesConditions(mode))
    for (const field of CONDITION_FIELDS)
      if (field in next) {
        // The member is removed, never written as undefined.
        Reflect.deleteProperty(next, field);
        cleared = true;
      }
  return { config: next, cleared };
}

/** Whether two subjects are the same, as the grid places them: by column for a role or the organisation. */
const sameColumn = (a: PolicySubject, b: PolicySubject): boolean => {
  const key = subjectKey(a);
  return key !== undefined ? key === subjectKey(b) : a.type === b.type && a.id === b.id;
};

const coversTool = (policy: PolicyInfo, toolRef: string): boolean =>
  policy.targets === 'all' || (policy.targets?.includes(toolRef) ?? false);

/** A subject as the wire writes it: `{ type, id }`, or `{ type: organization }`. */
const subjectOnWire = (s: PolicySubject): PolicySubject =>
  s.id === undefined ? { type: s.type } : { type: s.type, id: s.id };

/** The body of a write. */
function writeOf(copy: PolicyWorkingCopy, origin?: PolicyOrigin): PolicyWrite {
  const body = {
    // Rev 11: where an imported version came from. A create that carries it makes an imported policy.
    ...(origin === undefined ? {} : { origin: { format: origin.format, digest: origin.digest } }),
    kind: copy.kind,
    ...(copy.name === undefined || copy.name === '' ? {} : { name: copy.name }),
    ...(copy.description === undefined ? {} : { description: copy.description }),
    subjects: copy.subjects.map(subjectOnWire),
    targets: { tools: copy.targets === 'all' ? 'all' : [...copy.targets] },
    config: { ...copy.config },
  };
  // The service validates the body; the module's own types keep open values (a subject type, a kind) as strings.
  return body as unknown as PolicyWrite;
}

/** The working copy of a version, or `undefined` when its targets were not stated (a write would mean every tool). */
function workingOf(policy: PolicyInfo): PolicyWorkingCopy | undefined {
  if (policy.targets === undefined) return undefined;
  return {
    kind: policy.kind,
    ...(policy.name === undefined ? {} : { name: policy.name }),
    ...(policy.description === undefined ? {} : { description: policy.description }),
    subjects: policy.subjects.map(subjectOnWire),
    targets: policy.targets,
    config: { ...policy.config },
  };
}

/** JSON with object keys sorted, so two equal values always give the same text. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

/**
 * Whether `found` is the version `shown` was: the same version, the same `updated_at`, and the same members a write sets.
 * The content is compared too, since a draft rewritten in place keeps its version and `updated_at` is optional.
 */
export function sameDraft(found: PolicyInfo, shown: PolicyInfo): boolean {
  const content = (p: PolicyInfo): string =>
    canonical([p.kind, p.name, p.description, p.subjects, p.targets, p.config]);
  return (
    found.version === shown.version &&
    found.updatedAt === shown.updatedAt &&
    content(found) === content(shown)
  );
}

const sameCopy = (a: PolicyWorkingCopy | undefined, b: PolicyWorkingCopy | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** A change to a state: a member set to `undefined` is removed. */
type Patch<T> = { -readonly [K in keyof T]?: T[K] | undefined };

function merge<T extends object>(state: T, patch: Patch<T>): T {
  const next = { ...state } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) Reflect.deleteProperty(next, key);
    else next[key] = value;
  }
  return next as T;
}

const EMPTY_OTHERS: OtherPoliciesState = Object.freeze({ status: 'idle', policies: [] });
const OFF_SUGGESTED: SuggestedState = Object.freeze({ status: 'off', policies: [] });

interface Data {
  readonly status: PoliciesSnapshot['status'];
  readonly error?: PermissionsError;
  readonly facts?: PolicyCapabilityFacts;
  readonly policies: readonly PolicyInfo[];
  readonly tools: readonly ToolInfo[];
  readonly others: OtherPoliciesState;
  readonly suggested: SuggestedState;
  readonly directoryRoles: readonly RoleOption[];
  readonly connectionNames: Readonly<Record<string, string>>;
  readonly sideErrors: PoliciesSnapshot['sideErrors'];
}

const INITIAL: Data = {
  status: 'idle',
  policies: [],
  tools: [],
  others: EMPTY_OTHERS,
  suggested: OFF_SUGGESTED,
  directoryRoles: [],
  connectionNames: {},
  sideErrors: {},
};

interface EditorInternal extends PolicyEditorStore {
  /** The version the working copy came from, once loaded. */
  workingVersion(): number | undefined;
  /** Another path wrote this policy: what the editor holds is no longer its newest version. */
  markStale(): void;
  dispose(): void;
}

interface SimulationInternal extends PolicySimulationStore {
  dispose(): void;
}

export function createPoliciesStore(options: UsePoliciesOptions): PoliciesStore {
  const enabled = options.enabled !== false;
  const listeners = new Set<() => void>();
  let disposed = false;
  let data: Data = { ...INITIAL, status: enabled ? 'loading' : 'idle' };
  /** The read in progress, and a counter that makes a superseded read's answers stale. */
  let current: AbortController | undefined;
  let generation = 0;
  /** Counts list reads: only the newest applies. */
  let listSeq = 0;
  let loaded = false;
  /** Aborted on dispose: writes and the sub-stores' requests run under it. */
  const life = new AbortController();
  let expiredFired = false;
  let forbidden = false;
  /** Writes in flight by policy id (`new` for creates), counted. */
  const busy = new Map<string, number>();
  /** The pending drafts of published policies, by policy id, once read. */
  const pending = new Map<string, PolicyInfo>();
  /** Policies retired or deleted through this store: the suggested list read once at load never brings one back. */
  const removed = new Set<string>();
  /**
   * The drafts of never-published policies this store wrote, until a list read shows them: a draft the store wrote is
   * one it has seen, so it may be published before the list catches up.
   */
  const written = new Map<string, PolicyInfo>();
  /**
   * Every draft this store wrote, as the service answered the write, until it is published. A cell builds only on a
   * version it listed or a draft it wrote, never on one it merely read: a versions read is not something anybody saw.
   */
  const ownWrites = new Map<string, PolicyInfo>();
  const editors = new Map<string, EditorInternal>();
  const simulations = new Map<string, SimulationInternal>();
  /** Told of every change to what the store holds (the effective view follows the lists and the facts). */
  const changeListeners = new Set<() => void>();
  let effectiveStore: (EffectiveStore & { dispose(): void }) | undefined;

  const reportFault = (fault: unknown): void => {
    if (options.onFault === undefined) reportUnhandled(fault);
    else {
      try {
        options.onFault(fault);
      } catch {
        // A fault handler that throws has nowhere further to report to.
      }
    }
  };

  const exec = createExec(options, reportFault, PERMISSIONS_EXEC_ERRORS);

  function notifyAll(set: Set<() => void>): void {
    for (const listener of [...set]) {
      try {
        listener();
      } catch (fault) {
        reportFault(fault);
      }
    }
  }

  function authoringOf(): AuthoringState {
    const facts = data.facts;
    const off = { canPublish: false, canRetire: false } as const;
    if (!facts?.served) return { readOnly: true, ...off };
    if (!facts.author) return { readOnly: true, reason: 'not_offered', ...off };
    if (options.readOnly === true) return { readOnly: true, reason: 'host', ...off };
    if (forbidden) return { readOnly: true, reason: 'forbidden', ...off };
    return { readOnly: false, canPublish: facts.publish, canRetire: facts.retire };
  }

  function draftsOf(): DraftEntry[] {
    const entries: DraftEntry[] = [];
    for (const p of data.policies)
      if (p.state === 'draft')
        entries.push({
          policyId: p.id,
          ...(p.name === undefined ? {} : { name: p.name }),
          version: p.version,
          ...(p.updatedAt === undefined ? {} : { updatedAt: p.updatedAt }),
          neverPublished: true,
          policy: p,
        });
    for (const p of written.values())
      if (!entries.some((e) => e.policyId === p.id))
        entries.push({
          policyId: p.id,
          ...(p.name === undefined ? {} : { name: p.name }),
          version: p.version,
          ...(p.updatedAt === undefined ? {} : { updatedAt: p.updatedAt }),
          neverPublished: true,
          policy: p,
        });
    for (const p of pending.values())
      entries.push({
        policyId: p.id,
        ...(p.name === undefined ? {} : { name: p.name }),
        version: p.version,
        ...(p.updatedAt === undefined ? {} : { updatedAt: p.updatedAt }),
        neverPublished: false,
        policy: p,
      });
    return entries;
  }

  let snapshot: PoliciesSnapshot = build();

  function build(): PoliciesSnapshot {
    return Object.freeze({
      ...data,
      drafts: draftsOf(),
      authoring: authoringOf(),
      busy: new Set(busy.keys()),
    });
  }

  function commit(patch: Patch<Data> = {}): void {
    if (disposed) return;
    data = merge(data, patch);
    snapshot = build();
    notifyAll(listeners);
    notifyAll(changeListeners);
  }

  function expireSession(): void {
    if (expiredFired) return;
    expiredFired = true;
    try {
      options.onSessionExpired?.();
    } catch (fault) {
      reportFault(fault);
    }
  }

  /** One request; its 200 body read by `read`. An `unauthorized` answer ends the session once. */
  async function request<T>(
    signal: AbortSignal,
    send: Send,
    read: (body: unknown) => T | undefined,
    what: string
  ): Promise<Result<T>> {
    const reply = await exec(signal, send);
    if (reply.kind === 'aborted' || signal.aborted) return aborted;
    if (reply.kind === 'error') {
      if (reply.error.kind === 'unauthorized') expireSession();
      return { ok: false, error: reply.error };
    }
    expiredFired = false;
    const value = read(jsonOf(reply));
    return value === undefined
      ? { ok: false, error: malformedBody(200, what) }
      : { ok: true, value };
  }

  /** Every page of a list, following `meta.next`. One unreadable page, or a cursor seen twice, fails the list. */
  async function readAll<T>(
    signal: AbortSignal,
    sendPage: (cursor: string | undefined) => Send,
    rowOf: (row: unknown) => T | undefined,
    what: string
  ): Promise<Result<T[]>> {
    const rows: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await request(signal, sendPage(cursor), (body) => pageOf(body, rowOf), what);
      if (!result.ok) return result;
      rows.push(...result.value.rows);
      const next = result.value.next;
      if (next === undefined) return { ok: true, value: rows };
      if (seen.has(next)) return { ok: false, error: malformedBody(200, what) };
      seen.add(next);
      cursor = next;
    }
    return {
      ok: false,
      error: {
        kind: 'unsupported',
        code: 'too_many_pages',
        title: `The service sent ${what} longer than this client reads (${String(MAX_PAGES * PAGE_LIMIT)} rows).`,
        local: true,
      },
    };
  }

  const cursorOf = (cursor: string | undefined): { cursor?: string } =>
    cursor === undefined ? {} : { cursor };

  const listPolicies = (
    signal: AbortSignal,
    query: { kind?: string; source?: 'suggested' }
  ): Promise<Result<PolicyInfo[]>> =>
    readAll(
      signal,
      (cursor) => (c) =>
        c.GET('/v1/policies', {
          params: { query: { ...query, limit: PAGE_LIMIT, ...cursorOf(cursor) } },
          parseAs: 'text',
          signal,
        }),
      policyOf,
      'a policy list'
    );

  const readVersions = (signal: AbortSignal, id: string): Promise<Result<PolicyInfo[]>> =>
    request(
      signal,
      (c) =>
        c.GET('/v1/policies/{id}/versions', {
          params: { path: { id } },
          parseAs: 'text',
          signal,
        }),
      (body) => pageOf(body, policyOf)?.rows.slice(),
      'the versions of a policy'
    );

  /** Keeps what a versions read says about the pending draft of a published policy. */
  function notePending(id: string, versions: readonly PolicyInfo[]): void {
    const newest = versions[0];
    const anyPublished = versions.some((v) => v.state === 'published');
    if (newest?.state === 'draft' && anyPublished) pending.set(id, newest);
    else pending.delete(id);
  }

  /**
   * Reads the policy lists. Only the newest read applies: one that started earlier and ends later is dropped, so an
   * older list never replaces a newer one. On a load a failure is the store's error. After a write (`afterWrite`) a
   * failure keeps the lists shown and sets `error` beside `ready`; the next read that succeeds clears it.
   */
  async function readPolicyLists(
    signal: AbortSignal,
    mine: number,
    afterWrite = false
  ): Promise<boolean> {
    listSeq += 1;
    const seq = listSeq;
    const [toolInvocation, all] = await Promise.all([
      listPolicies(signal, { kind: 'tool_invocation' }),
      listPolicies(signal, {}),
    ]);
    if (mine !== generation || seq !== listSeq || disposed) return false;
    if (!toolInvocation.ok) {
      if ('error' in toolInvocation)
        commit(
          afterWrite
            ? { error: toolInvocation.error }
            : { status: 'error', error: toolInvocation.error, policies: [] }
        );
      return false;
    }
    // A pending draft that the list now shows published is no longer pending, and the list is now the source of a
    // never-published draft this store wrote.
    // A pending draft of a policy the list showed before and no longer shows (retired or deleted elsewhere) is gone
    // with it. One the store has never seen listed is kept: a list read that started earlier may not show it yet.
    const listedIds = new Set(toolInvocation.value.map((p) => p.id));
    const listedBefore = new Set(data.policies.map((p) => p.id));
    for (const id of [...pending.keys()])
      if (listedBefore.has(id) && !listedIds.has(id)) pending.delete(id);
    for (const p of toolInvocation.value) {
      written.delete(p.id);
      const known = pending.get(p.id);
      if (known !== undefined && p.state === 'published' && p.version >= known.version)
        pending.delete(p.id);
      // A draft this store wrote that is now published (here or by someone else) is no longer what a cell builds on.
      const own = ownWrites.get(p.id);
      if (own !== undefined && p.state === 'published' && p.version >= own.version)
        ownWrites.delete(p.id);
    }
    const others: OtherPoliciesState = all.ok
      ? {
          status: 'ready',
          policies: all.value
            .filter((p) => p.kind !== 'tool_invocation')
            .map((policy) => ({ policy, view: otherViewOf(policy) })),
        }
      : 'error' in all
        ? { status: 'error', policies: [], error: all.error }
        : data.others;
    commit({
      policies: toolInvocation.value,
      others,
      ...(afterWrite ? { status: 'ready' as const, error: undefined } : {}),
    });
    return true;
  }

  async function load(): Promise<void> {
    current?.abort();
    const ac = new AbortController();
    current = ac;
    generation += 1;
    const mine = generation;
    const signal = ac.signal;
    commit({ status: 'loading', error: undefined });
    try {
      const caps = await request(
        signal,
        (c) => c.GET('/v1/capabilities', { parseAs: 'text', signal }),
        policyCapabilitiesOf,
        'capabilities'
      );
      if (mine !== generation) return;
      if (!caps.ok) {
        if ('error' in caps) commit({ status: 'error', error: caps.error });
        return;
      }
      const facts = caps.value;
      if (!facts.served) {
        loaded = true;
        commit({ ...INITIAL, status: 'unavailable', facts });
        return;
      }
      commit({ facts });
      // Started now and awaited only once the grid is ready: a fault in it is reported, never left unhandled.
      const side = sideReads(signal, mine, facts).catch(reportFault);
      const [lists, tools] = await Promise.all([
        readPolicyLists(signal, mine),
        readAll(
          signal,
          (cursor) => (c) =>
            c.GET('/v1/tools', {
              params: { query: { limit: PAGE_LIMIT, ...cursorOf(cursor) } },
              parseAs: 'text',
              signal,
            }),
          toolOf,
          'a tool list'
        ),
      ]);
      if (mine !== generation) return;
      if (!tools.ok) {
        if ('error' in tools) commit({ status: 'error', error: tools.error, tools: [] });
        return;
      }
      if (!lists) return;
      loaded = true;
      commit({ status: 'ready', tools: tools.value });
      await side;
    } catch (fault) {
      reportFault(fault);
      if (mine === generation) commit({ status: 'error', error: internalFault(fault) });
    }
  }

  /** The reads that add to the grid and never block it: roles, connection names, suggested policies. */
  async function sideReads(
    signal: AbortSignal,
    mine: number,
    facts: PolicyCapabilityFacts
  ): Promise<void> {
    const roles = facts.principals
      ? readAll(
          signal,
          (cursor) => (c) =>
            c.GET('/v1/principals', {
              params: { query: { type: 'role', limit: PAGE_LIMIT, ...cursorOf(cursor) } },
              parseAs: 'text',
              signal,
            }),
          principalRoleOf,
          'a principal list'
        )
      : undefined;
    const connections = facts.connections
      ? readAll(
          signal,
          (cursor) => (c) =>
            c.GET('/v1/connections', {
              params: { query: { limit: PAGE_LIMIT, ...cursorOf(cursor) } },
              parseAs: 'text',
              signal,
            }),
          connectionNameOf,
          'a connection list'
        )
      : undefined;
    const wantSuggested = options.suggested === true && facts.suggested;
    if (wantSuggested) commit({ suggested: { status: 'loading', policies: [] } });
    const suggested = wantSuggested ? listPolicies(signal, { source: 'suggested' }) : undefined;

    const [r, c, s] = await Promise.all([roles, connections, suggested]);
    if (mine !== generation || disposed) return;
    const patch: Patch<Data> = {};
    // A directory or a connection list that fails leaves the grid with the host's roles and the connection ids, and
    // says so in `sideErrors`.
    const sideErrors: { roles?: PermissionsError; connections?: PermissionsError } = {};
    if (r?.ok === true) patch.directoryRoles = r.value;
    else if (r !== undefined && 'error' in r) sideErrors.roles = r.error;
    if (c?.ok === true) patch.connectionNames = Object.fromEntries(c.value);
    else if (c !== undefined && 'error' in c) sideErrors.connections = c.error;
    patch.sideErrors = sideErrors;
    if (s !== undefined) {
      if (s.ok)
        patch.suggested = { status: 'ready', policies: s.value.filter((p) => !removed.has(p.id)) };
      else if ('error' in s) {
        // Only the contract's two "not offered" answers hide the panel; any other failure is shown.
        const notOffered =
          (s.error.status === 403 && s.error.code === 'entitlement_required') ||
          (s.error.status === 404 && s.error.code === 'not_available_on_deployment');
        patch.suggested = notOffered
          ? { status: 'hidden', policies: [] }
          : { status: 'error', policies: [], error: s.error };
      }
    }
    commit(patch);
  }

  /** The refusal of a write that may not be sent, or `undefined`. */
  function writeRefusal(): PermissionsError | undefined {
    // A write waits for the lists: before them the store cannot tell which policy governs a pair.
    if (data.facts === undefined || !loaded) return precondition('not_loaded');
    return authoringOf().readOnly ? precondition('read_only') : undefined;
  }

  /** A write's failure: a 403 turns authoring off for the life of the store. */
  function writeFailed(error: PermissionsError): PermissionsError {
    if (isWriteForbidden(error) && !forbidden) {
      forbidden = true;
      commit();
    }
    return error;
  }

  async function withBusy<T>(id: string, work: () => Promise<T>): Promise<T> {
    busy.set(id, (busy.get(id) ?? 0) + 1);
    commit();
    try {
      return await work();
    } finally {
      const left = (busy.get(id) ?? 1) - 1;
      if (left === 0) busy.delete(id);
      else busy.set(id, left);
      commit();
    }
  }

  /** A write to a policy waits for the one in flight: two would race on the same draft. */
  const inFlight = (id: string): PermissionsError | undefined =>
    busy.has(id) ? precondition('write_in_flight') : undefined;

  /** After a successful write: the lists are read again (the matrix keeps showing the previous ones meanwhile). */
  function afterWrite(): void {
    if (!loaded || current === undefined) return;
    void readPolicyLists(current.signal, generation, true).catch(reportFault);
  }

  /** Tells an open editor of `id`, other than `from`, that the policy was written elsewhere. */
  function staleEditor(id: string, from?: EditorInternal): void {
    const open = editors.get(id);
    if (open !== undefined && open !== from) open.markStale();
  }

  async function sendWrite(
    method: 'POST' | 'PUT',
    id: string | undefined,
    copy: PolicyWorkingCopy,
    from?: EditorInternal,
    origin?: PolicyOrigin
  ): Promise<PolicyWriteResult> {
    const signal = life.signal;
    const body = writeOf(copy, origin);
    const result = await request(
      signal,
      (c) =>
        method === 'POST' || id === undefined
          ? c.POST('/v1/policies', { body, parseAs: 'text', signal })
          : c.PUT('/v1/policies/{id}', { params: { path: { id } }, body, parseAs: 'text', signal }),
      policyEnvelopeOf,
      'a policy'
    );
    if (!result.ok)
      return 'error' in result
        ? { ok: false, error: writeFailed(result.error) }
        : { ok: false, error: precondition('not_loaded') };
    const draft = result.value;
    if (draft.state === 'draft') {
      // A draft written after a publish is the policy's pending draft; otherwise the policy was never published.
      const listed = data.policies.find((p) => p.id === draft.id);
      if (listed?.state === 'published' || pending.has(draft.id)) pending.set(draft.id, draft);
      else written.set(draft.id, draft);
      ownWrites.set(draft.id, draft);
      commit();
    }
    staleEditor(draft.id, from);
    afterWrite();
    return { ok: true, policy: draft };
  }

  async function create(copy: PolicyWorkingCopy): Promise<PolicyWriteResult> {
    const refused = writeRefusal();
    if (refused !== undefined) return { ok: false, error: refused };
    if (copy.kind !== 'tool_invocation')
      return { ok: false, error: precondition('kind_not_editable') };
    return withBusy('new', () => sendWrite('POST', undefined, copy));
  }

  /**
   * Writes the next draft of `id` from its newest version (the pending draft, else the published one) with `change`,
   * only when that version is `seen` (compared by `sameDraft`). Otherwise it answers `changed` and writes nothing.
   */
  async function writeNext(
    id: string,
    seen: PolicyInfo,
    change: (copy: PolicyWorkingCopy) => PolicyWorkingCopy,
    origin?: PolicyOrigin
  ): Promise<PolicyWriteResult | 'changed'> {
    const busyNow = inFlight(id);
    if (busyNow !== undefined) return { ok: false, error: busyNow };
    return withBusy(id, async (): Promise<PolicyWriteResult | 'changed'> => {
      const versions = await readVersions(life.signal, id);
      if (!versions.ok)
        return 'error' in versions
          ? { ok: false, error: versions.error }
          : { ok: false, error: precondition('not_loaded') };
      notePending(id, versions.value);
      const newest = versions.value[0];
      if (newest === undefined)
        return { ok: false, error: malformedBody(200, 'the versions of a policy') };
      if (!sameDraft(newest, seen)) {
        commit();
        return 'changed';
      }
      const copy = workingOf(newest);
      if (copy === undefined) return { ok: false, error: precondition('targets_not_stated') };
      return sendWrite('PUT', id, change(copy), undefined, origin);
    });
  }

  /** The newest version of `id`: its pending draft when there is one, else the published version. */
  async function latest(id: string): Promise<PolicyWriteResult> {
    const versions = await readVersions(life.signal, id);
    if (!versions.ok)
      return 'error' in versions
        ? { ok: false, error: versions.error }
        : { ok: false, error: precondition('not_loaded') };
    notePending(id, versions.value);
    commit();
    const newest = versions.value[0];
    return newest === undefined
      ? { ok: false, error: malformedBody(200, 'the versions of a policy') }
      : { ok: true, policy: newest };
  }

  async function saveImported(
    write: PolicyWorkingCopy,
    saveOptions: { readonly origin: PolicyOrigin; readonly id?: string; readonly seen?: PolicyInfo }
  ): Promise<PolicyWriteResult> {
    const refused = writeRefusal();
    if (refused !== undefined) return { ok: false, error: refused };
    if (write.kind !== 'tool_invocation')
      return { ok: false, error: precondition('kind_not_editable') };
    const { id, seen, origin } = saveOptions;
    if (id === undefined)
      return withBusy('new', () => sendWrite('POST', undefined, write, undefined, origin));
    // Written over only the version the import was compared with: another is a change nobody has seen.
    if (seen === undefined) return { ok: false, error: precondition('draft_changed') };
    const result = await writeNext(id, seen, () => write, origin);
    return result === 'changed' ? { ok: false, error: precondition('draft_changed') } : result;
  }

  async function setCell(
    subject: PolicySubject,
    toolRef: string,
    mode: string,
    cellOptions: { readonly name?: string } = {}
  ): Promise<CellWriteResult> {
    const refused = writeRefusal();
    if (refused !== undefined) return { kind: 'error', error: refused };
    // A tool that is not callable (withdrawn, or a status the contract does not document, which a client treats as
    // not callable) has read-only cells: its policies stay, and are edited as a whole in the editor.
    if (data.tools.some((t) => t.toolRef === toolRef && t.status !== 'active'))
      return { kind: 'error', error: precondition('tool_not_callable') };
    const onPair = (p: PolicyInfo): boolean =>
      p.targets !== undefined &&
      coversTool(p, toolRef) &&
      p.subjects.some((s) => sameColumn(s, subject));
    const governing = data.policies.filter((p) => p.state === 'published' && onPair(p));
    const toResult = (r: PolicyWriteResult): CellWriteResult =>
      r.ok ? { kind: 'written', policy: r.policy } : { kind: 'error', error: r.error };
    const setMode = (copy: PolicyWorkingCopy): PolicyWorkingCopy => ({
      ...copy,
      config: withMode(copy.config, mode).config,
    });
    if (governing.length > 1) return { kind: 'error', error: precondition('pair_conflict') };
    const [only] = governing;
    if (only !== undefined) {
      if (!isSoleCell(only)) return { kind: 'open_editor', policyId: only.id };
      // The cell builds on the published version it lists, or on a draft this store wrote. Any other newest version (a
      // pending draft someone else wrote) is opened in the editor, so nobody's edits ride along unseen.
      const result = await writeNext(only.id, ownWrites.get(only.id) ?? only, setMode);
      return result === 'changed' ? { kind: 'open_editor', policyId: only.id } : toResult(result);
    }
    // A draft never published that covers only this pair is written again rather than duplicated.
    const listedIds = new Set(data.policies.map((p) => p.id));
    const drafts = [
      ...data.policies,
      ...[...written.values()].filter((p) => !listedIds.has(p.id)),
    ].filter((p) => p.state === 'draft' && onPair(p));
    const [draft] = drafts;
    if (drafts.length === 1 && draft !== undefined && isSoleCell(draft)) {
      // Only a draft this store wrote is written again from a cell; any other is opened in the editor.
      const own = ownWrites.get(draft.id);
      if (own === undefined) return { kind: 'open_editor', policyId: draft.id };
      const result = await writeNext(draft.id, own, setMode);
      return result === 'changed' ? { kind: 'open_editor', policyId: draft.id } : toResult(result);
    }
    return toResult(
      await create({
        kind: 'tool_invocation',
        ...(cellOptions.name === undefined ? {} : { name: cellOptions.name }),
        subjects: [subjectOnWire(subject)],
        targets: [toolRef],
        config: { mode },
      })
    );
  }

  /** The draft the store has seen for `id`: its pending draft, or the list row of a policy never published. */
  function knownDraft(id: string): PolicyInfo | undefined {
    const listed = data.policies.find((p) => p.id === id);
    return pending.get(id) ?? written.get(id) ?? (listed?.state === 'draft' ? listed : undefined);
  }

  async function publish(id: string, shown: PolicyInfo): Promise<PolicyWriteResult> {
    const refused = writeRefusal();
    if (refused !== undefined) return { ok: false, error: refused };
    if (!authoringOf().canPublish) return { ok: false, error: precondition('publish_not_offered') };
    const busyNow = inFlight(id);
    if (busyNow !== undefined) return { ok: false, error: busyNow };
    return withBusy(id, async () => {
      const versions = await readVersions(life.signal, id);
      if (!versions.ok)
        return 'error' in versions
          ? { ok: false, error: versions.error }
          : { ok: false, error: precondition('not_loaded') };
      notePending(id, versions.value);
      const draft = versions.value.find((v) => v.state === 'draft');
      if (draft === undefined) {
        commit();
        return { ok: false, error: precondition('no_pending_draft') };
      }
      // Only the draft the caller showed is published: another version, or the same one rewritten, is refused.
      if (!sameDraft(draft, shown)) {
        commit();
        return { ok: false, error: precondition('draft_changed') };
      }
      const signal = life.signal;
      const result = await request(
        signal,
        (c) =>
          c.POST('/v1/policies/{id}/publish', {
            params: { path: { id } },
            parseAs: 'text',
            signal,
          }),
        policyEnvelopeOf,
        'a policy'
      );
      if (!result.ok)
        return 'error' in result
          ? { ok: false, error: writeFailed(result.error) }
          : { ok: false, error: precondition('not_loaded') };
      pending.delete(id);
      written.delete(id);
      ownWrites.delete(id);
      staleEditor(id);
      afterWrite();
      return { ok: true, policy: result.value };
    });
  }

  /** Forgets what the store holds of the drafts of `id`; `listed` also drops its list row (it left the lists). */
  function forget(id: string, listed: boolean): void {
    pending.delete(id);
    written.delete(id);
    ownWrites.delete(id);
    if (listed) {
      removed.add(id);
      // Out of every list the store holds: a policy of another kind, and a suggested one, too.
      commit({
        policies: data.policies.filter((p) => p.id !== id),
        others: {
          ...data.others,
          policies: data.others.policies.filter((o) => o.policy.id !== id),
        },
        suggested: {
          ...data.suggested,
          policies: data.suggested.policies.filter((p) => p.id !== id),
        },
      });
      return;
    }
    // The published policy stays, without the draft its list row named.
    commit({
      policies: data.policies.map((p) => {
        if (p.id !== id || p.draftVersion === undefined) return p;
        const rest: { -readonly [K in keyof PolicyInfo]?: PolicyInfo[K] } = { ...p };
        Reflect.deleteProperty(rest, 'draftVersion');
        return rest as PolicyInfo;
      }),
    });
  }

  /** An open editor of a policy retired or discarded here reads it again: what it held is gone. */
  function reloadEditor(id: string): void {
    const open = editors.get(id);
    if (open !== undefined) void open.reload().catch(reportFault);
  }

  /** The refusal of a retire or a discard that may not be sent, or `undefined`. */
  const retireRefusal = (id: string): PermissionsError | undefined =>
    writeRefusal() ??
    (!authoringOf().canRetire ? precondition('retire_not_offered') : undefined) ??
    inFlight(id);

  async function retire(id: string): Promise<PolicyWriteResult> {
    const refused = retireRefusal(id);
    if (refused !== undefined) return { ok: false, error: refused };
    return withBusy(id, async (): Promise<PolicyWriteResult> => {
      const signal = life.signal;
      const result = await request(
        signal,
        (c) =>
          c.POST('/v1/policies/{id}/retire', { params: { path: { id } }, parseAs: 'text', signal }),
        policyEnvelopeOf,
        'a policy'
      );
      if (!result.ok) {
        if (!('error' in result)) return { ok: false, error: precondition('not_loaded') };
        // Gone already (retired or deleted elsewhere): nothing of it stays in the store.
        if (result.error.kind === 'not_found') {
          forget(id, true);
          afterWrite();
        }
        return { ok: false, error: writeFailed(result.error) };
      }
      // Out of the lists from the answer on, its pending draft with it.
      forget(id, true);
      reloadEditor(id);
      afterWrite();
      return { ok: true, policy: result.value };
    });
  }

  async function discardDraft(id: string, shown?: PolicyInfo): Promise<PolicyDiscardResult> {
    const refused = retireRefusal(id);
    if (refused !== undefined) return { ok: false, error: refused };
    return withBusy(id, async (): Promise<PolicyDiscardResult> => {
      const signal = life.signal;
      // The versions say whether the policy was ever published (then only its draft goes) and which draft is pending.
      const versions = await readVersions(signal, id);
      if (!versions.ok) {
        if (!('error' in versions)) return { ok: false, error: precondition('not_loaded') };
        if (versions.error.kind === 'not_found') {
          forget(id, true);
          afterWrite();
        }
        return { ok: false, error: versions.error };
      }
      notePending(id, versions.value);
      const draft = versions.value.find((v) => v.state === 'draft');
      if (draft === undefined) {
        commit();
        return { ok: false, error: precondition('no_pending_draft') };
      }
      // Only the draft the caller showed is discarded: another version, or the same one rewritten, is refused.
      if (shown !== undefined && !sameDraft(draft, shown)) {
        commit();
        return { ok: false, error: precondition('draft_changed') };
      }
      const neverPublished = !versions.value.some((v) => v.state === 'published');
      const result = await request(
        signal,
        (c) =>
          c.DELETE('/v1/policies/{id}/draft', {
            params: { path: { id } },
            parseAs: 'text',
            signal,
          }),
        (): true => true,
        'a discard'
      );
      if (!result.ok) {
        if (!('error' in result)) return { ok: false, error: precondition('not_loaded') };
        if (result.error.kind === 'not_found') {
          forget(id, neverPublished);
          afterWrite();
        }
        return { ok: false, error: writeFailed(result.error) };
      }
      forget(id, neverPublished);
      reloadEditor(id);
      afterWrite();
      return { ok: true, deleted: neverPublished };
    });
  }

  /** Policy names by id, from every list the store holds. */
  function names(): Map<string, string> {
    const out = new Map<string, string>();
    for (const p of [...data.policies, ...data.others.policies.map((o) => o.policy)])
      if (p.name !== undefined) out.set(p.id, p.name);
    return out;
  }

  function createEditor(id: string): EditorInternal {
    const own = new Set<() => void>();
    const initial: PolicyEditorSnapshot = Object.freeze({
      id,
      status: 'loading',
      versions: [],
      dirty: false,
      notes: [],
      saving: false,
      publishing: false,
      stale: false,
    });
    let state: PolicyEditorSnapshot = initial;
    let ac: AbortController | undefined;
    /** The draft as loaded or last saved: what a publish expects to find. */
    let loadedDraft: PolicyInfo | undefined;
    /** The working copy as loaded or last saved. */
    let saved: PolicyWorkingCopy | undefined;
    /** Kept so a publish result outlives the reload that follows it. */
    let lastPublished: PolicyInfo | undefined;

    const set = (patch: Patch<PolicyEditorSnapshot>): void => {
      state = Object.freeze(merge(state, patch));
      notifyAll(own);
    };

    async function load(): Promise<void> {
      ac?.abort();
      const mine = new AbortController();
      ac = mine;
      const signal = mine.signal;
      set({ status: 'loading' });
      try {
        const [read, versions] = await Promise.all([
          request(
            signal,
            (c) =>
              c.GET('/v1/policies/{id}', { params: { path: { id } }, parseAs: 'text', signal }),
            policyEnvelopeOf,
            'a policy'
          ),
          readVersions(signal, id),
        ]);
        if (ac !== mine || disposed) return;
        const failed = !read.ok ? read : !versions.ok ? versions : undefined;
        if (failed !== undefined) {
          if (!('error' in failed)) return;
          set({
            status: failed.error.kind === 'not_found' ? 'not_found' : 'error',
            error: failed.error,
          });
          return;
        }
        if (!read.ok || !versions.ok) return;
        notePending(id, versions.value);
        commit();
        const draft = versions.value.find((v) => v.state === 'draft');
        const base = draft ?? read.value;
        const working = workingOf(base);
        loadedDraft = draft;
        saved = working;
        state = Object.freeze({
          id,
          status: 'ready',
          current: read.value,
          versions: versions.value,
          ...(draft === undefined ? {} : { pendingDraft: draft }),
          ...(working === undefined ? {} : { working }),
          workingFrom: { version: base.version, state: base.state },
          dirty: false,
          notes: working === undefined ? (['targets_not_stated'] as EditorNote[]) : [],
          saving: false,
          publishing: false,
          stale: false,
          ...(lastPublished === undefined ? {} : { lastPublished }),
        });
        notifyAll(own);
      } catch (fault) {
        reportFault(fault);
        if (ac === mine) set({ status: 'error', error: internalFault(fault) });
      }
    }

    function change(working: PolicyWorkingCopy, notes: readonly EditorNote[] = state.notes): void {
      set({ working, dirty: !sameCopy(working, saved), notes });
    }

    const editor: EditorInternal = {
      subscribe(listener) {
        own.add(listener);
        // Every first subscriber reads again: the policy may have been written since the editor was last open.
        if (own.size === 1 && !disposed) void load();
        return () => {
          own.delete(listener);
        };
      },
      getSnapshot: () => state,
      reload: () => load(),
      edit(patch) {
        if (state.working === undefined) return;
        change({ ...state.working, ...patch });
      },
      setMode(mode) {
        if (state.working === undefined) return;
        const next = withMode(state.working.config, mode);
        const notes: EditorNote[] =
          next.cleared && !state.notes.includes('conditions_cleared')
            ? [...state.notes, 'conditions_cleared']
            : [...state.notes];
        change({ ...state.working, config: next.config }, notes);
      },
      setCondition(field, value) {
        if (state.working === undefined) return;
        const config: Record<string, unknown> = { ...state.working.config };
        if (value === undefined) Reflect.deleteProperty(config, field);
        else config[field] = typeof value === 'string' ? value : [...value];
        change({ ...state.working, config });
      },
      async save() {
        const refused = writeRefusal();
        const working = state.working;
        const error =
          refused ??
          (state.status !== 'ready'
            ? precondition('not_loaded')
            : working === undefined
              ? precondition('targets_not_stated')
              : working.kind !== 'tool_invocation'
                ? precondition('kind_not_editable')
                : state.stale
                  ? precondition('draft_changed')
                  : inFlight(id));
        if (error !== undefined || working === undefined) {
          const e = error ?? precondition('not_loaded');
          set({ error: e });
          return { ok: false, error: e };
        }
        // A new save starts clean: the last publish and its conflict no longer describe what is shown.
        lastPublished = undefined;
        set({ saving: true, error: undefined, conflict: undefined, lastPublished: undefined });
        const result = await withBusy(id, () => sendWrite('PUT', id, working, editor));
        if (!result.ok) {
          set({ saving: false, error: result.error });
          return result;
        }
        const written = result.policy;
        loadedDraft = written;
        saved = working;
        const versions = [written, ...state.versions.filter((v) => v.version !== written.version)];
        set({
          saving: false,
          versions,
          pendingDraft: written,
          workingFrom: { version: written.version, state: written.state },
          dirty: !sameCopy(state.working, saved),
        });
        return result;
      },
      async publish() {
        const refused =
          writeRefusal() ??
          (!authoringOf().canPublish
            ? precondition('publish_not_offered')
            : state.status !== 'ready'
              ? precondition('not_loaded')
              : state.dirty
                ? precondition('unsaved_changes')
                : loadedDraft === undefined
                  ? precondition('no_pending_draft')
                  : undefined);
        if (refused !== undefined || loadedDraft === undefined) {
          const e = refused ?? precondition('no_pending_draft');
          set({ error: e });
          return { ok: false, error: e };
        }
        // A new publish starts clean: the last publish line no longer describes what is shown.
        lastPublished = undefined;
        set({ publishing: true, error: undefined, conflict: undefined, lastPublished: undefined });
        const result = await publish(id, loadedDraft);
        if (!result.ok) {
          const e = result.error;
          const conflictId = e.kind === 'conflict' ? e.policyId : undefined;
          const conflictName = conflictId === undefined ? undefined : names().get(conflictId);
          set({
            publishing: false,
            error: e,
            stale: e.kind === 'precondition' && e.code === 'draft_changed' ? true : state.stale,
            ...(conflictId === undefined
              ? {}
              : {
                  conflict: {
                    policyId: conflictId,
                    ...(conflictName === undefined ? {} : { name: conflictName }),
                  },
                }),
          });
          return result;
        }
        lastPublished = result.policy;
        set({ publishing: false, lastPublished });
        await load();
        return result;
      },
      workingVersion: () => (state.status === 'ready' ? state.workingFrom?.version : undefined),
      markStale() {
        if (state.status === 'ready') set({ stale: true });
      },
      dispose() {
        ac?.abort();
        own.clear();
      },
    };
    return editor;
  }

  function createSimulation(id: string): SimulationInternal {
    const own = new Set<() => void>();
    let state: PolicySimulationSnapshot = Object.freeze({ id, status: 'idle' });
    let latest = 0;
    const set = (next: PolicySimulationSnapshot): void => {
      state = Object.freeze(next);
      notifyAll(own);
    };

    async function run(input: SimulationInput): Promise<SimulationOutcome> {
      latest += 1;
      const mine = latest;
      // Nothing is sent before the capabilities say the policies family is served.
      const refused =
        data.facts?.served !== true
          ? precondition('not_loaded')
          : input.runId !== undefined && !data.facts.runs
            ? precondition('runs_not_offered')
            : undefined;
      if (refused !== undefined) {
        set({ id, status: 'error', error: refused, input });
        return { ok: false, error: refused };
      }
      // Always named, so the snapshot says which version answered: without an editor or a known draft, the version the
      // list shows (left out, the service would simulate its newest draft, which nobody may have seen).
      const draftVersion =
        input.draftVersion ??
        editors.get(id)?.workingVersion() ??
        knownDraft(id)?.version ??
        data.policies.find((p) => p.id === id)?.version;
      const actor = {
        ...(input.agentId === undefined ? {} : { agent_id: input.agentId }),
        ...(input.runId === undefined ? {} : { run_id: input.runId }),
      };
      const body = {
        ...(draftVersion === undefined ? {} : { draft_version: draftVersion }),
        ...(Object.keys(actor).length === 0 ? {} : { actor }),
        action: { tool_ref: input.toolRef, arguments: { ...(input.arguments ?? {}) } },
      };
      const sent = draftVersion === undefined ? {} : { draftVersion };
      set({
        id,
        status: 'running',
        input,
        ...sent,
        ...(state.result === undefined ? {} : { result: state.result }),
      });
      const signal = life.signal;
      const result = await request(
        signal,
        (c) =>
          c.POST('/v1/policies/{id}/simulate', {
            params: { path: { id } },
            body,
            parseAs: 'text',
            signal,
          }),
        (value) => simulationOf(value, id, names()),
        'a simulation'
      );
      if (!result.ok) {
        const error = 'error' in result ? result.error : precondition('not_loaded');
        if (mine === latest) set({ id, status: 'error', error, input, ...sent });
        return { ok: false, error };
      }
      if (mine === latest) set({ id, status: 'done', result: result.value, input, ...sent });
      return { ok: true, result: result.value };
    }

    return {
      subscribe(listener) {
        own.add(listener);
        return () => {
          own.delete(listener);
        };
      },
      getSnapshot: () => state,
      run,
      dispose() {
        own.clear();
      },
    };
  }

  function effective(): EffectiveStore {
    effectiveStore ??= createEffectiveStore({
      facts: () => data.facts,
      loaded: () => loaded && data.status === 'ready',
      policies: () => data.policies,
      draft: knownDraft,
      tools: () => data.tools,
      // The host saying so, or a write refused with 403, whatever else authoring depends on: a service that offers no
      // authoring still serves simulate, and a user it is not an administrator for gets no view and no request.
      notAdministrator: () => options.readOnly === true || forbidden,
      send: (policyId, body, signal) =>
        request(
          signal,
          (c) =>
            c.POST('/v1/policies/{id}/simulate', {
              params: { path: { id: policyId } },
              // The service validates the body; the subject's type is kept open here.
              body: body as unknown as components['schemas']['SimulateRequest'],
              parseAs: 'text',
              signal,
            }),
          (value) => simulationOf(value, policyId, names()),
          'a simulation'
        ),
      onChange: (listener) => {
        changeListeners.add(listener);
        return () => {
          changeListeners.delete(listener);
        };
      },
      reportFault,
    });
    return effectiveStore;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && enabled && !disposed && (current === undefined || !loaded))
        void load();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0 && !loaded) {
          // Nobody is listening to a read that has not finished: stop it, and start again on the next subscribe.
          current?.abort();
          current = undefined;
          generation += 1;
        }
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => SERVER_SNAPSHOT,
    refresh: () => (enabled && !disposed ? load() : Promise.resolve()),
    setCell,
    create,
    publish,
    retire,
    discardDraft,
    editor(id) {
      let found = editors.get(id);
      if (found === undefined) {
        found = createEditor(id);
        editors.set(id, found);
      }
      return found;
    },
    effective,
    latest,
    saveImported,
    simulation(id) {
      let found = simulations.get(id);
      if (found === undefined) {
        found = createSimulation(id);
        simulations.set(id, found);
      }
      return found;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      current?.abort();
      life.abort();
      for (const e of editors.values()) e.dispose();
      for (const s of simulations.values()) s.dispose();
      effectiveStore?.dispose();
      changeListeners.clear();
      listeners.clear();
    },
  };
}

const SERVER_SNAPSHOT: PoliciesSnapshot = Object.freeze({
  ...INITIAL,
  drafts: [],
  authoring: { readOnly: true, canPublish: false, canRetire: false },
  busy: new Set<string>(),
});
