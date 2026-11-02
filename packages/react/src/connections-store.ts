/**
 * The headless store of the connections module. Constructing it does nothing; on the first `subscribe` it reads the
 * result of an OAuth round trip from the address (the `nc_*` parameters, once, and takes them out of the address),
 * then reads `GET /v1/capabilities` and learns from it alone what the service offers: without the connections family
 * the store is `unavailable` and calls no connection route; without `connections.oauth` it starts no OAuth round trip;
 * without `connections.user_links` it links nothing. Then it reads the registrations, page by page.
 *
 * Changing a registration the organisation owns (and its organisation credential) is an administrator's on every
 * deployment; registering may be too, where `connection_registration` says `who: administrators`. The store learns
 * the caller is not an administrator from the host (`readOnly`) or from a 403, and then stops offering those changes
 * for its life; a principal still changes its own registrations. A caller's own link is the caller's on every
 * registration it sees, and a 403 there changes nothing else.
 *
 * No credential is kept: a token passed to `create`, `rotateOrgCredential` or `link` goes into one request body and is
 * not stored, and no reader keeps a member the contract does not name. No React.
 */
import { createExec, jsonOf } from './approvals-exec.js';
import type { Send } from './approvals-exec.js';
import {
  CONNECTIONS_EXEC_ERRORS,
  internalFault,
  malformedBody,
  precondition,
} from './connections-errors.js';
import {
  authorizationUrlOf,
  connectionEnvelopeOf,
  connectionOf,
  connectionToolOf,
  connectionsCapabilitiesOf,
  pageOf,
  refreshCountsOf,
  returnOf,
  withState,
  withoutReturn,
} from './connections-parse.js';
import type {
  ConnectionAuthorizeResult,
  ConnectionDetailSnapshot,
  ConnectionDetailStore,
  ConnectionInfo,
  ConnectionLinkInput,
  ConnectionReturn,
  ConnectionToolInfo,
  ConnectionToolRow,
  ConnectionsAdministration,
  ConnectionsCapabilityFacts,
  ConnectionsError,
  ConnectionsSnapshot,
  ConnectionsStore,
  UseConnectionsOptions,
} from './connections-types.js';
import { reportFault as reportUnhandled } from './fault.js';

/** Rows per page: the most the contract's `limit` allows. */
export const PAGE_LIMIT = 200;
/** Pages read of one list before the store stops and reports it: 10 000 rows. */
export const MAX_PAGES = 50;

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConnectionsError }
  | { readonly ok: false; readonly aborted: true };

const aborted = { ok: false, aborted: true } as const;

/** The key of a registration being created in `pending`. */
export const NEW = 'new';

/** The error of a result that did not succeed: an aborted request (the store was disposed) reads as not loaded. */
const errorOf = (result: { readonly ok: false } & object): ConnectionsError =>
  'error' in result ? (result.error as ConnectionsError) : precondition('not_loaded');

/** Whether a registration takes the caller's own link: `per_user`, with a kind of authentication to link. */
export function takesLink(connection: ConnectionInfo): boolean {
  return (
    connection.credentialTier === 'per_user' &&
    connection.authKind !== undefined &&
    connection.authKind !== 'none'
  );
}

/** Whether only the organisation's administrators change a registration: it is the organisation's. */
export const ownedByOrganisation = (connection: ConnectionInfo): boolean =>
  connection.owner.kind !== 'principal';

/** The registered and offered tools side by side, in the order the service listed them. */
export function toolRowsOf(
  registered: readonly ConnectionToolInfo[],
  offered: readonly ConnectionToolInfo[] | undefined
): ConnectionToolRow[] {
  const offeredByRef = new Map((offered ?? []).map((tool) => [tool.toolRef, tool]));
  const rows: ConnectionToolRow[] = registered.map((tool) => {
    const now = offeredByRef.get(tool.toolRef);
    const active = tool.status === 'active';
    // A status the module does not know is said as such, never read as withdrawn or as active.
    const unknown = !active && tool.status !== 'withdrawn';
    const standing: ConnectionToolRow['standing'] =
      offered === undefined
        ? active
          ? 'registered'
          : unknown
            ? 'unknown_status'
            : 'withdrawn'
        : now === undefined
          ? 'withdrawn'
          : active
            ? 'registered'
            : unknown
              ? 'unknown_status'
              : 'offered';
    return {
      toolRef: tool.toolRef,
      registered: tool,
      ...(now === undefined ? {} : { offered: now }),
      standing,
    };
  });
  const known = new Set(registered.map((tool) => tool.toolRef));
  for (const tool of offered ?? [])
    if (!known.has(tool.toolRef))
      rows.push({ toolRef: tool.toolRef, offered: tool, standing: 'offered' });
  return rows;
}

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

interface Data {
  readonly status: ConnectionsSnapshot['status'];
  readonly error?: ConnectionsError;
  readonly facts?: ConnectionsCapabilityFacts;
  readonly connections: readonly ConnectionInfo[];
  readonly lastReturn?: ConnectionReturn;
}

const INITIAL: Data = { status: 'idle', connections: [] };

const SERVER_SNAPSHOT: ConnectionsSnapshot = Object.freeze({
  status: 'idle',
  connections: [],
  pending: new Set<string>(),
  administration: { readOnly: false },
});

interface DetailInternal extends ConnectionDetailStore {
  dispose(): void;
}

/** The browser's window, when there is one (never during a server render). */
const browser = (): (Window & typeof globalThis) | undefined =>
  typeof window === 'undefined' ? undefined : window;

/** Where the authorization this browser started waits for its return: a nonce and the registration. */
export const WAITING_KEY = 'nc.connections.authorization';

interface Waiting {
  readonly state: string;
  readonly connectionId: string;
}

/** Records the authorization this browser starts; false when the browser keeps no session storage. */
function putWaiting(w: Window, waiting: Waiting): boolean {
  try {
    w.sessionStorage.setItem(WAITING_KEY, JSON.stringify(waiting));
    return true;
  } catch {
    return false;
  }
}

/** The waiting authorization, removed as it is read (used once); `undefined` when there is none or it is unreadable. */
function takeWaiting(w: Window): Waiting | undefined {
  try {
    const text = w.sessionStorage.getItem(WAITING_KEY);
    w.sessionStorage.removeItem(WAITING_KEY);
    if (text === null) return undefined;
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null) return undefined;
    const { state, connectionId } = value as Record<string, unknown>;
    return typeof state === 'string' && typeof connectionId === 'string'
      ? { state, connectionId }
      : undefined;
  } catch {
    return undefined;
  }
}

export function createConnectionsStore(options: UseConnectionsOptions): ConnectionsStore {
  const enabled = options.enabled !== false;
  const listeners = new Set<() => void>();
  let disposed = false;
  let started = false;
  let data: Data = { ...INITIAL, status: enabled ? 'loading' : 'idle' };
  /** The read in progress, and a counter that makes a superseded read's answers stale. */
  let current: AbortController | undefined;
  let generation = 0;
  /** Aborted on dispose: changes and the detail views' requests run under it. */
  const life = new AbortController();
  let expiredFired = false;
  let forbidden = false;
  /** Changes in flight by registration id (`new` for a create). */
  const pending = new Set<string>();
  const details = new Map<string, DetailInternal>();

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

  const exec = createExec(options, reportFault, CONNECTIONS_EXEC_ERRORS);

  function notifyAll(set: Set<() => void>): void {
    for (const listener of [...set]) {
      try {
        listener();
      } catch (fault) {
        reportFault(fault);
      }
    }
  }

  function administrationOf(): ConnectionsAdministration {
    if (options.readOnly === true) return { readOnly: true, reason: 'host' };
    if (forbidden) return { readOnly: true, reason: 'forbidden' };
    return { readOnly: false };
  }

  function build(): ConnectionsSnapshot {
    return Object.freeze({
      ...data,
      pending: new Set(pending),
      administration: administrationOf(),
    });
  }

  let snapshot: ConnectionsSnapshot = build();

  function commit(patch: Patch<Data> = {}): void {
    if (disposed) return;
    data = merge(data, patch);
    snapshot = build();
    notifyAll(listeners);
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

  const listConnections = (signal: AbortSignal): Promise<Result<ConnectionInfo[]>> =>
    readAll(
      signal,
      (cursor) => (c) =>
        c.GET('/v1/connections', {
          params: { query: { limit: PAGE_LIMIT, ...cursorOf(cursor) } },
          parseAs: 'text',
          signal,
        }),
      connectionOf,
      'a connection list'
    );

  /**
   * Reads the result of an OAuth round trip from the address, once, and takes it out of the address whatever it says.
   * It is kept only when this browser started that authorization: the waiting record (`sessionStorage`) names the same
   * nonce and registration. The record is used once. A link with crafted parameters therefore shows nothing.
   */
  function consumeReturn(): void {
    const w = browser();
    if (w === undefined) return;
    const href = w.location.href;
    // Any of the parameters is taken out of the address, whole set or not, before anything is read from it.
    const stripped = withoutReturn(href);
    if (stripped !== href)
      try {
        w.history.replaceState(w.history.state, '', stripped);
      } catch (fault) {
        reportFault(fault);
      }
    const back = returnOf(href);
    if (back === undefined) return;
    const waiting = takeWaiting(w);
    if (
      waiting === undefined ||
      back.state === undefined ||
      waiting.state !== back.state ||
      waiting.connectionId !== back.connectionId
    )
      return;
    commit({
      lastReturn: {
        connectionId: back.connectionId,
        result: back.result,
        ...(back.error === undefined ? {} : { error: back.error }),
      },
    });
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
        connectionsCapabilitiesOf,
        'capabilities'
      );
      if (mine !== generation) return;
      if (!caps.ok) {
        if ('error' in caps) commit({ status: 'error', error: caps.error });
        return;
      }
      const facts = caps.value;
      if (!facts.served) {
        commit({ status: 'unavailable', facts, connections: [] });
        return;
      }
      commit({ facts });
      const changed = new Map<string, ConnectionInfo | null>();
      changedDuringLoad = changed;
      const list = await listConnections(signal);
      if (changedDuringLoad === changed) changedDuringLoad = undefined;
      if (mine !== generation) return;
      if (!list.ok) {
        if ('error' in list) commit({ status: 'error', error: list.error, connections: [] });
        return;
      }
      const rows = list.value
        .filter((c) => changed.get(c.id) !== null)
        .map((c) => changed.get(c.id) ?? c);
      for (const [id, row] of changed)
        if (row !== null && !rows.some((c) => c.id === id)) rows.push(row);
      // A return for a registration the caller does not see is not shown.
      const back = data.lastReturn;
      const unknown = back !== undefined && !rows.some((c) => c.id === back.connectionId);
      commit({
        status: 'ready',
        connections: rows,
        ...(unknown ? { lastReturn: undefined } : {}),
      });
    } catch (fault) {
      reportFault(fault);
      if (mine === generation) commit({ status: 'error', error: internalFault(fault) });
    }
  }

  /** Reads one registration again after a change and puts it in the list; a failure keeps the row shown. */
  async function reread(id: string): Promise<void> {
    const signal = life.signal;
    const result = await request(
      signal,
      (c) => c.GET('/v1/connections/{id}', { params: { path: { id } }, parseAs: 'text', signal }),
      connectionEnvelopeOf,
      'a connection'
    );
    if (result.ok) put(result.value);
    else if ('error' in result) {
      // A registration that is gone (deleted elsewhere) leaves the list; any other failure leaves it stale.
      if (result.error.kind === 'not_found') drop(id);
      else commit({ error: result.error });
    }
  }

  /**
   * The changes that finished while a list read was in flight, by id (`null`: deleted). The list that read answers
   * predates them, so they are applied over it rather than lost.
   */
  let changedDuringLoad: Map<string, ConnectionInfo | null> | undefined;

  function put(connection: ConnectionInfo): void {
    changedDuringLoad?.set(connection.id, connection);
    const at = data.connections.findIndex((c) => c.id === connection.id);
    const next = [...data.connections];
    if (at === -1) next.push(connection);
    else next[at] = connection;
    commit({ connections: next, error: undefined });
  }

  function drop(id: string): void {
    changedDuringLoad?.set(id, null);
    commit({ connections: data.connections.filter((c) => c.id !== id) });
  }

  const find = (id: string): ConnectionInfo | undefined =>
    data.connections.find((c) => c.id === id);

  /**
   * A change: refused without a request while another change to the same registration is in flight, and marked in
   * `pending` while it runs, `after` (the reads that follow it) included. `administrative` says a 403 means the caller
   * is not an administrator: the store then stops offering the administrator's changes.
   */
  async function change<T>(
    key: string,
    administrative: boolean,
    send: (signal: AbortSignal) => Send,
    read: (body: unknown) => T | undefined,
    what: string,
    after?: () => Promise<unknown>
  ): Promise<Result<T>> {
    if (disposed) return { ok: false, error: precondition('not_loaded') };
    if (pending.has(key)) return { ok: false, error: precondition('write_in_flight') };
    pending.add(key);
    commit();
    const signal = life.signal;
    try {
      const result = await request(signal, send(signal), read, what);
      if (!result.ok && 'error' in result && administrative && result.error.kind === 'forbidden')
        forbidden = true;
      // The reads that follow a change run while the change is still pending, so no second change starts on what
      // they are about to replace.
      if (result.ok && after !== undefined) await after();
      return result;
    } catch (fault) {
      reportFault(fault);
      return { ok: false, error: internalFault(fault) };
    } finally {
      pending.delete(key);
      commit();
    }
  }

  /** A 204: no body to read. */
  const empty = (): true => true;

  /**
   * The refusal of a change the store already knows would be refused. `adminOnly`: the change is an administrator's
   * whoever owns the registration (the organisation credential); otherwise only the organisation's registrations are.
   */
  function administrativeRefusal(
    connection: ConnectionInfo | undefined,
    adminOnly = false
  ): ConnectionsError | undefined {
    if (connection === undefined) return precondition('not_loaded');
    return (adminOnly || ownedByOrganisation(connection)) && administrationOf().readOnly
      ? precondition('read_only')
      : undefined;
  }

  const store: ConnectionsStore = {
    subscribe(listener) {
      listeners.add(listener);
      if (!started && enabled && !disposed) {
        started = true;
        consumeReturn();
        void load();
      }
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => SERVER_SNAPSHOT,
    reload: () => (enabled && !disposed ? load() : Promise.resolve()),

    async create(input) {
      // Not an administrator (the host says so, or a 403 did): registering is refused here only where the service
      // registers for administrators alone; the service decides the rest.
      const registration = data.facts?.registration;
      if (administrationOf().readOnly && registration?.who === 'administrators')
        return { ok: false, error: precondition('read_only') };
      // An owner kind the service does not register is refused here: its 403 would say nothing about the caller.
      if (registration !== undefined && !registration.ownerKinds.includes(input.ownerKind))
        return { ok: false, error: precondition('owner_kind_not_offered') };
      // A 403 means the caller is not an administrator only where registering, or what it sends, is theirs alone.
      const administrative =
        registration?.who === 'administrators' ||
        input.credentialTier !== undefined ||
        input.orgCredential !== undefined;
      const auth =
        input.authKind === 'oauth'
          ? {
              kind: 'oauth' as const,
              ...(input.oauth?.scopes === undefined || input.oauth.scopes.length === 0
                ? {}
                : { scopes: [...input.oauth.scopes] }),
              ...(input.oauth?.issuer === undefined ? {} : { issuer: input.oauth.issuer }),
              ...(input.oauth?.clientId === undefined ? {} : { client_id: input.oauth.clientId }),
            }
          : input.authKind === 'bearer'
            ? { kind: 'bearer' as const }
            : undefined;
      const body = {
        name: input.name,
        url: input.url,
        transport: input.transport as 'mcp' | 'a2a',
        owner_kind: input.ownerKind as 'org' | 'principal',
        ...(auth === undefined ? {} : { auth }),
        ...(input.credentialTier === undefined
          ? {}
          : { credential_tier: input.credentialTier as 'org_shared' | 'per_user' }),
        ...(input.orgCredential === undefined
          ? {}
          : { org_credential: { token: input.orgCredential } }),
      };
      const result = await change(
        NEW,
        administrative,
        (signal) => (c) => c.POST('/v1/connections', { body, parseAs: 'text', signal }),
        connectionEnvelopeOf,
        'a connection'
      );
      if (!result.ok) return { ok: false, error: errorOf(result) };
      put(result.value);
      return { ok: true, connection: result.value };
    },

    async rename(id, name) {
      const connection = find(id);
      const refused = administrativeRefusal(connection);
      if (refused !== undefined) return { ok: false, error: refused };
      const result = await change(
        id,
        connection !== undefined && ownedByOrganisation(connection),
        (signal) => (c) =>
          c.PATCH('/v1/connections/{id}', {
            params: { path: { id } },
            body: { name },
            parseAs: 'text',
            signal,
          }),
        connectionEnvelopeOf,
        'a connection'
      );
      if (!result.ok) return { ok: false, error: errorOf(result) };
      put(result.value);
      return { ok: true, connection: result.value };
    },

    async rotateOrgCredential(id, token) {
      const refused = administrativeRefusal(find(id), true);
      if (refused !== undefined) return { ok: false, error: refused };
      const result = await change(
        id,
        true,
        (signal) => (c) =>
          c.PATCH('/v1/connections/{id}', {
            params: { path: { id } },
            body: { org_credential: { token } },
            parseAs: 'text',
            signal,
          }),
        connectionEnvelopeOf,
        'a connection'
      );
      if (!result.ok) return { ok: false, error: errorOf(result) };
      put(result.value);
      return { ok: true, connection: result.value };
    },

    async remove(id) {
      const connection = find(id);
      const refused = administrativeRefusal(connection);
      if (refused !== undefined) return { ok: false, error: refused };
      const result = await change(
        id,
        connection !== undefined && ownedByOrganisation(connection),
        (signal) => (c) =>
          c.DELETE('/v1/connections/{id}', { params: { path: { id } }, parseAs: 'text', signal }),
        empty,
        'a deletion'
      );
      if (!result.ok) return { ok: false, error: errorOf(result) };
      drop(id);
      void details.get(id)?.reload();
      return { ok: true };
    },

    async refresh(id) {
      const connection = find(id);
      const refused = administrativeRefusal(connection);
      if (refused !== undefined) return { ok: false, error: refused };
      const result = await change(
        id,
        connection !== undefined && ownedByOrganisation(connection),
        (signal) => (c) =>
          c.POST('/v1/connections/{id}/refresh', {
            params: { path: { id } },
            parseAs: 'text',
            signal,
          }),
        refreshCountsOf,
        'a refresh result',
        () => Promise.all([reread(id), details.get(id)?.reload()])
      );
      if (!result.ok) return { ok: false, error: errorOf(result) };
      return { ok: true, counts: result.value };
    },

    async link(id, input: ConnectionLinkInput) {
      const connection = find(id);
      if (connection === undefined) return { ok: false, error: precondition('not_loaded') };
      if (data.facts?.userLinks !== true)
        return { ok: false, error: precondition('links_not_offered') };
      if (!takesLink(connection)) return { ok: false, error: precondition('nothing_to_link') };
      // The type says `true`; a caller that casts its way past it still sends nothing.
      if ((input.consent as unknown) !== true)
        return { ok: false, error: precondition('consent_required') };
      const result = await change(
        id,
        false,
        (signal) => (c) =>
          c.POST('/v1/connections/{id}/link', {
            params: { path: { id } },
            body: { consent: true, ...(input.token === undefined ? {} : { token: input.token }) },
            parseAs: 'text',
            signal,
          }),
        connectionEnvelopeOf,
        'a connection'
      );
      if (!result.ok) return { ok: false, error: errorOf(result) };
      put(result.value);
      return { ok: true, connection: result.value };
    },

    async unlink(id) {
      if (find(id) === undefined) return { ok: false, error: precondition('not_loaded') };
      if (data.facts?.userLinks !== true)
        return { ok: false, error: precondition('links_not_offered') };
      const result = await change(
        id,
        false,
        (signal) => (c) =>
          c.DELETE('/v1/connections/{id}/link', {
            params: { path: { id } },
            parseAs: 'text',
            signal,
          }),
        empty,
        'an unlink',
        () => reread(id)
      );
      if (!result.ok) return { ok: false, error: errorOf(result) };
      return { ok: true };
    },

    async revokeConsent(id) {
      if (find(id) === undefined) return { ok: false, error: precondition('not_loaded') };
      if (data.facts?.userLinks !== true)
        return { ok: false, error: precondition('links_not_offered') };
      const result = await change(
        id,
        false,
        (signal) => (c) =>
          c.DELETE('/v1/connections/{id}/link/consent', {
            params: { path: { id } },
            parseAs: 'text',
            signal,
          }),
        empty,
        'a consent revocation',
        () => reread(id)
      );
      if (!result.ok) return { ok: false, error: errorOf(result) };
      return { ok: true };
    },

    async authorize(id): Promise<ConnectionAuthorizeResult> {
      const connection = find(id);
      if (connection === undefined) return { ok: false, error: precondition('not_loaded') };
      if (data.facts?.oauth !== true)
        return { ok: false, error: precondition('oauth_not_offered') };
      // The organisation credential is an administrator's to authorize.
      const administrative = !takesLink(connection);
      if (administrative && administrationOf().readOnly)
        return { ok: false, error: precondition('read_only') };
      const w = browser();
      // Without the `nc_*` parameters, the host's own address included: a deployment adds them to `return_to`'s
      // query, and one left there from an earlier round trip must never be read as this one's result.
      const given = options.returnTo ?? w?.location.href;
      const returnTo = given === undefined ? undefined : withoutReturn(given);
      const navigate =
        options.onNavigate ??
        (w === undefined
          ? undefined
          : (url: string) => {
              w.location.assign(url);
            });
      if (returnTo === undefined || navigate === undefined)
        return { ok: false, error: precondition('cannot_navigate') };
      // The page it returns to carries a nonce this browser keeps, so the return is told from a crafted link.
      const state = crypto.randomUUID();
      const back = withState(returnTo, state);
      const result = await change(
        id,
        administrative,
        (signal) => (c) =>
          c.POST('/v1/connections/{id}/authorize', {
            params: { path: { id } },
            body: { return_to: back },
            parseAs: 'text',
            signal,
          }),
        authorizationUrlOf,
        'an authorization URL'
      );
      if (!result.ok) return { ok: false, error: errorOf(result) };
      // Without session storage the return is not shown, but the authorization still completes.
      if (w !== undefined) putWaiting(w, { state, connectionId: id });
      try {
        navigate(result.value);
      } catch (fault) {
        reportFault(fault);
        return { ok: false, error: internalFault(fault) };
      }
      return { ok: true, url: result.value };
    },

    detail(id) {
      const known = details.get(id);
      if (known !== undefined) return known;
      const made = createDetail(id);
      details.set(id, made);
      return made;
    },

    dismissReturn() {
      commit({ lastReturn: undefined });
    },

    noteOptions() {
      commit();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      current?.abort();
      life.abort();
      for (const d of details.values()) d.dispose();
      details.clear();
      listeners.clear();
    },
  };

  /** One registration's tools: read on the first subscriber; discover only when asked. */
  function createDetail(id: string): DetailInternal {
    const own = new Set<() => void>();
    let detailStarted = false;
    let seq = 0;
    let discoverSeq = 0;
    let state: Omit<ConnectionDetailSnapshot, 'rows'> = {
      status: 'idle',
      tools: [],
      discovery: { status: 'idle', tools: [] },
    };
    const buildDetail = (): ConnectionDetailSnapshot =>
      Object.freeze({
        ...state,
        rows: toolRowsOf(
          state.tools,
          state.discovery.status === 'ready' ? state.discovery.tools : undefined
        ),
      });
    let detailSnapshot = buildDetail();
    const set = (next: Omit<ConnectionDetailSnapshot, 'rows'>): void => {
      if (disposed) return;
      state = next;
      detailSnapshot = buildDetail();
      notifyAll(own);
    };

    async function readTools(): Promise<void> {
      seq += 1;
      const mine = seq;
      const signal = life.signal;
      set({ ...state, status: 'loading' });
      try {
        const result = await readAll(
          signal,
          (cursor) => (c) =>
            c.GET('/v1/tools', {
              params: { query: { connection: id, limit: PAGE_LIMIT, ...cursorOf(cursor) } },
              parseAs: 'text',
              signal,
            }),
          connectionToolOf,
          'a tool list'
        );
        if (mine !== seq) return;
        if (result.ok) set({ discovery: state.discovery, status: 'ready', tools: result.value });
        else if ('error' in result) set({ ...state, status: 'error', error: result.error });
      } catch (fault) {
        reportFault(fault);
        if (mine === seq) set({ ...state, status: 'error', error: internalFault(fault) });
      }
    }

    async function discover(): Promise<void> {
      discoverSeq += 1;
      const mine = discoverSeq;
      const signal = life.signal;
      set({ ...state, discovery: { status: 'loading', tools: state.discovery.tools } });
      try {
        const result = await request(
          signal,
          (c) =>
            c.POST('/v1/connections/{id}/discover', {
              params: { path: { id } },
              parseAs: 'text',
              signal,
            }),
          (body) => pageOf(body, connectionToolOf)?.rows.slice(),
          'a tool list'
        );
        if (mine !== discoverSeq) return;
        if (result.ok) set({ ...state, discovery: { status: 'ready', tools: result.value } });
        else if ('error' in result)
          set({ ...state, discovery: { status: 'error', tools: [], error: result.error } });
      } catch (fault) {
        reportFault(fault);
        if (mine === discoverSeq)
          set({ ...state, discovery: { status: 'error', tools: [], error: internalFault(fault) } });
      }
    }

    return {
      subscribe(listener) {
        own.add(listener);
        if (!detailStarted && !disposed) {
          detailStarted = true;
          void readTools();
        }
        return () => {
          own.delete(listener);
        };
      },
      getSnapshot: () => detailSnapshot,
      reload: () => (disposed ? Promise.resolve() : readTools()),
      discover: () => (disposed ? Promise.resolve() : discover()),
      dispose() {
        own.clear();
      },
    };
  }

  return store;
}
