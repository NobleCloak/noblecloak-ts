/**
 * The effective view of the permissions module: for a (role or organisation, tool) cell, what a hypothetical holder of
 * exactly that subject would get, as `POST /v1/policies/{id}/simulate` with `subject` answers it (contract revision 11).
 * Pure state and scheduling; the request is the policies store's. No React.
 *
 * What the wire allows, and so all this claims:
 * - Simulate is a route of one policy: the policy `anchor` names stands in at the version it names, and every other
 *   policy is taken as it is in force. On the published basis the anchor is a published policy at its published version,
 *   so the answer is what the published policies give. On a draft basis it is that draft, as if it were published.
 * - Only an administrator simulates as a subject (403 `forbidden` otherwise). The first request is sent alone; a 403
 *   stops the view for the life of the store, so a non-administrator causes one refused request, never one per cell. A
 *   host that knows its user is not an administrator passes `readOnly`, and no request is sent at all.
 * - A subject type the service cannot simulate is 422 `unsupported_policy_form`: that column is marked and no further
 *   request names that type.
 * - Which entries determined a decision (`contributed`) is shown only where the service advertises how it composes
 *   (`policies.tightest_wins`); otherwise the view lists what matched and the decision, and says nothing about which
 *   entry set it.
 *
 * Requests are bounded: at most `EFFECTIVE_CONCURRENCY` in flight, asked for cell by cell (the component asks for the
 * rows on screen), cached per (cell, basis, published versions and tools), and aborted on dispose or when the basis or
 * the published policies change.
 */
import type {
  ConsideredEntry,
  PermissionsError,
  PolicyCapabilityFacts,
  PolicyInfo,
  PolicySubject,
  SimulationResult,
  ToolInfo,
} from './permissions-types.js';

/** Simulations in flight at once, at most. */
export const EFFECTIVE_CONCURRENCY = 4;

/** What the effective cells are computed against. */
export type EffectiveBasis =
  /** The published policies, as they are in force. */
  | { readonly kind: 'published' }
  /** The published policies with the draft `version` of `policyId` standing in for that policy, as if published. */
  | { readonly kind: 'draft'; readonly policyId: string; readonly version: number };

/** One entry of what the simulation considered, as the effective cell shows it. */
export interface EffectiveEntry {
  readonly kind: string;
  /** The policy; null for a default of the deployment. */
  readonly policyId: string | null;
  readonly name?: string;
  readonly version: number | null;
  readonly subject?: PolicySubject;
  readonly result: string;
  /** On a default: which one. */
  readonly source?: string;
}

/** What a hypothetical holder of the cell's subject would get. */
export interface EffectiveResult {
  readonly decision: string;
  readonly reason?: string;
  /** Every entry the service considered: what matched, the deployment's default when nothing did. */
  readonly matched: readonly EffectiveEntry[];
  /**
   * The entries the service marked as having determined the decision (`contributed`). Present only where the service
   * advertises how it composes (`policies.tightest_wins`); absent, the view makes no claim about which entry set it.
   * Empty when the service advertises the rule but marked no entry.
   */
  readonly setBy?: readonly EffectiveEntry[];
  /** The policy and version the simulation ran against. */
  readonly anchor: { readonly policyId: string; readonly version: number };
}

export type EffectiveCell =
  | { readonly state: 'loading' }
  | { readonly state: 'done'; readonly result: EffectiveResult }
  | { readonly state: 'error'; readonly error: PermissionsError }
  /** The service cannot simulate as this subject type (422 `unsupported_policy_form`). */
  | { readonly state: 'unsupported' };

/**
 * `off`: the policies are not read yet, or not served. `not_offered`: the host said the user is not an administrator,
 * or a write was refused with 403; nothing is sent. `not_permitted`: the service refused a simulation as a subject with
 * 403; nothing more is sent. `no_anchor`: no published policy exists to simulate against (every cell gets the
 * deployment's default, whose value only a simulation could tell). `paused`: a request failed in a way that would fail
 * the rest too (an expired session, too many requests, the service unreachable); `retry` resumes. `ready`: cells are
 * computed as they are asked for.
 */
export type EffectiveStatus =
  'off' | 'not_offered' | 'not_permitted' | 'no_anchor' | 'paused' | 'ready';

export interface EffectiveSnapshot {
  readonly status: EffectiveStatus;
  /** With `paused` or `not_permitted`: the failure. */
  readonly error?: PermissionsError;
  readonly basis: EffectiveBasis;
  /** Whether the service advertises how it composes (`policies.tightest_wins`), so `setBy` is shown. */
  readonly composition: boolean;
  /** The cells asked for under the current basis, by `effectiveCellKey`. */
  readonly cells: ReadonlyMap<string, EffectiveCell>;
  /** The subject types the service said it cannot simulate. */
  readonly unsupportedSubjects: ReadonlySet<string>;
  /** Counts the rounds: a new one (another basis, or the published policies or tools changed) drops every cell. */
  readonly round: number;
}

/** A cell to compute: the column's subject and key, and the tool. */
export interface EffectiveRequest {
  readonly columnKey: string;
  readonly subject: PolicySubject;
  readonly toolRef: string;
}

export interface EffectiveStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): EffectiveSnapshot;
  /** Asks for cells; those cached, queued or in flight under the current basis are not asked again. */
  request(cells: readonly EffectiveRequest[]): void;
  /** Sets the basis; the cells of another basis are computed again when asked for. */
  setBasis(basis: EffectiveBasis): void;
  /** Resumes after `paused`, asking again for the cells that failed. */
  retry(): void;
}

/** The key of a cell in `EffectiveSnapshot.cells`. */
export const effectiveCellKey = (columnKey: string, toolRef: string): string =>
  `${columnKey}|${toolRef}`;

export type EffectiveSendResult =
  | { readonly ok: true; readonly value: SimulationResult }
  | { readonly ok: false; readonly error: PermissionsError }
  | { readonly ok: false; readonly aborted: true };

/** What the effective store needs from the policies store. */
export interface EffectiveDeps {
  facts(): PolicyCapabilityFacts | undefined;
  /** True once the lists are read. */
  loaded(): boolean;
  /** The `tool_invocation` policies the list returned. */
  policies(): readonly PolicyInfo[];
  /** The draft of `policyId` the store knows, as last read or written: a draft basis is computed again when it changes. */
  draft(policyId: string): PolicyInfo | undefined;
  tools(): readonly ToolInfo[];
  /** `host` or `forbidden` when authoring is off for a reason that says the user is not an administrator. */
  notAdministrator(): boolean;
  /** One simulation of `policyId` with `body`, its answer read for `policyId`. */
  send(
    policyId: string,
    body: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<EffectiveSendResult>;
  /** Called when the policies store changes (its lists, its facts, its authoring state). */
  onChange(listener: () => void): () => void;
  reportFault(fault: unknown): void;
}

/** The kinds of failure after which every other request would fail the same way: the queue stops. */
const STOPPING: ReadonlySet<PermissionsError['kind']> = new Set([
  'unauthorized',
  'rate_limited',
  'unavailable',
  'network',
]);

const entryOf = (e: ConsideredEntry): EffectiveEntry => ({
  kind: e.kind,
  policyId: e.id,
  ...(e.name === undefined ? {} : { name: e.name }),
  version: e.version,
  ...(e.subject === undefined ? {} : { subject: e.subject }),
  result: e.result,
  ...(e.source === undefined ? {} : { source: e.source }),
});

/** The effective result of a simulation; `setBy` only when the service advertises how it composes. */
export function effectiveResultOf(
  result: SimulationResult,
  anchor: EffectiveResult['anchor'],
  composition: boolean
): EffectiveResult {
  const considered = result.considered?.policies ?? [];
  return {
    decision: result.decision,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    matched: considered.map(entryOf),
    ...(composition
      ? { setBy: considered.filter((e) => e.contributed === true).map(entryOf) }
      : {}),
    anchor,
  };
}

/** The anchor of a cell on the published basis: the published policy that governs it, else the first published one. */
function publishedAnchor(
  policies: readonly PolicyInfo[],
  request: EffectiveRequest
): { policyId: string; version: number } | undefined {
  const published = policies
    .filter((p) => p.state === 'published')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const governs = (p: PolicyInfo): boolean =>
    (p.targets === 'all' || (p.targets?.includes(request.toolRef) ?? false)) &&
    p.subjects.some(
      (s) =>
        s.type === request.subject.type &&
        (request.subject.type === 'organization' || s.id === request.subject.id)
    );
  const chosen = published.find(governs) ?? published[0];
  return chosen === undefined ? undefined : { policyId: chosen.id, version: chosen.version };
}

export function createEffectiveStore(deps: EffectiveDeps): EffectiveStore & { dispose(): void } {
  const listeners = new Set<() => void>();
  let disposed = false;
  let basis: EffectiveBasis = { kind: 'published' };
  /** Aborted when the basis or the published policies change, and on dispose. */
  let round = new AbortController();
  /** The fingerprint the cells belong to. */
  let fingerprint = '';
  let rounds = 0;
  let cells = new Map<string, EffectiveCell>();
  const queue: EffectiveRequest[] = [];
  /** What each cell of the round was asked as, so a retry can ask again. */
  const asked = new Map<string, EffectiveRequest>();
  const queued = new Set<string>();
  let inFlight = 0;
  /** The subject types a request has been answered for (the first of each type is sent alone). */
  const probed = new Set<string>();
  /**
   * The subject types whose first request is on the wire, with the signal it went under. It outlives a round: a request
   * a new round aborted still holds its type until it settles, so a new round never sends a second one beside it.
   */
  const probing = new Map<string, AbortSignal>();
  const unsupported = new Set<string>();
  let latched: { status: 'not_permitted' | 'paused'; error: PermissionsError } | undefined;
  let snapshot: EffectiveSnapshot;

  const composition = (): boolean => deps.facts()?.tightestWins === true;

  function status(): EffectiveStatus {
    const facts = deps.facts();
    if (facts?.served !== true || !deps.loaded()) return 'off';
    if (deps.notAdministrator()) return 'not_offered';
    if (latched !== undefined) return latched.status;
    if (basis.kind === 'published' && !deps.policies().some((p) => p.state === 'published'))
      return 'no_anchor';
    return 'ready';
  }

  function build(): EffectiveSnapshot {
    const s = status();
    return Object.freeze({
      status: s,
      ...(latched?.status === s ? { error: latched.error } : {}),
      basis,
      composition: composition(),
      cells: new Map(cells),
      unsupportedSubjects: new Set(unsupported),
      round: rounds,
    });
  }

  function notify(): void {
    if (disposed) return;
    snapshot = build();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (fault) {
        deps.reportFault(fault);
      }
    }
  }

  /** What the cells depend on besides the cell: the basis, the published versions, the tools and their status. */
  function fingerprintOf(): string {
    const published = deps
      .policies()
      .filter((p) => p.state === 'published')
      .map((p) => `${p.id}@${String(p.version)}`)
      .sort();
    const tools = deps
      .tools()
      .map((t) => `${t.toolRef}:${t.status}`)
      .sort();
    // A draft rewritten in place keeps its version: its content and `updated_at` tell the rewrite apart.
    const draft = basis.kind === 'draft' ? deps.draft(basis.policyId) : undefined;
    const drafted =
      draft === undefined
        ? null
        : [
            draft.version,
            draft.updatedAt ?? null,
            draft.subjects,
            draft.targets ?? null,
            draft.config,
          ];
    return JSON.stringify([basis, published, tools, drafted]);
  }

  /** Starts a new round when what the cells depend on changed: the old cells, queue and requests are dropped. */
  function sync(): boolean {
    const next = fingerprintOf();
    if (next === fingerprint) return false;
    fingerprint = next;
    rounds += 1;
    round.abort();
    round = new AbortController();
    cells = new Map();
    asked.clear();
    queue.length = 0;
    queued.clear();
    inFlight = 0;
    return true;
  }

  function anchorOf(request: EffectiveRequest): { policyId: string; version: number } | undefined {
    return basis.kind === 'draft'
      ? { policyId: basis.policyId, version: basis.version }
      : publishedAnchor(deps.policies(), request);
  }

  function mayStart(request: EffectiveRequest): boolean {
    if (unsupported.has(request.subject.type)) return false;
    // The first request of a subject type goes alone: a refusal of the type, or of simulating as a subject at all,
    // then costs one request.
    if (probed.size === 0) return inFlight === 0 && probing.size === 0;
    if (!probed.has(request.subject.type)) return !probing.has(request.subject.type);
    return true;
  }

  function pump(): void {
    if (disposed || status() !== 'ready') return;
    for (let i = 0; i < queue.length && inFlight < EFFECTIVE_CONCURRENCY;) {
      const next = queue[i];
      if (next === undefined) break;
      if (unsupported.has(next.subject.type)) {
        queue.splice(i, 1);
        queued.delete(effectiveCellKey(next.columnKey, next.toolRef));
        cells.set(effectiveCellKey(next.columnKey, next.toolRef), { state: 'unsupported' });
        continue;
      }
      if (!mayStart(next)) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      start(next);
    }
  }

  function start(request: EffectiveRequest): void {
    const key = effectiveCellKey(request.columnKey, request.toolRef);
    queued.delete(key);
    const anchor = anchorOf(request);
    if (anchor === undefined) return;
    inFlight += 1;
    const signal = round.signal;
    const probe = !probed.has(request.subject.type);
    if (probe) probing.set(request.subject.type, signal);
    cells.set(key, { state: 'loading' });
    const body = {
      draft_version: anchor.version,
      subject:
        request.subject.type === 'organization'
          ? { type: 'organization' }
          : { type: request.subject.type, id: request.subject.id },
      action: { tool_ref: request.toolRef, arguments: {} },
    };
    void deps
      .send(anchor.policyId, body, signal)
      .then((answer) => {
        if (disposed) return;
        if (probe && probing.get(request.subject.type) === signal)
          probing.delete(request.subject.type);
        if (signal.aborted || 'aborted' in answer) {
          // A request of an earlier round: it frees its type for this round's first request.
          if (probe) {
            pump();
            notify();
          }
          return;
        }
        inFlight -= 1;
        if (answer.ok) {
          probed.add(request.subject.type);
          cells.set(key, {
            state: 'done',
            result: effectiveResultOf(answer.value, anchor, composition()),
          });
        } else settleError(request, key, answer.error);
        pump();
        notify();
      })
      .catch((fault: unknown) => {
        deps.reportFault(fault);
      });
  }

  function settleError(request: EffectiveRequest, key: string, error: PermissionsError): void {
    if (error.kind === 'forbidden') {
      // Simulating as a subject is an administrator's: one refusal ends the view.
      latched = { status: 'not_permitted', error };
      cells.delete(key);
      dropQueue();
      return;
    }
    // A refusal of the subject names `subject` (the contract's 422 `detail`); any other 422 is this cell's alone.
    if (error.kind === 'unprocessable' && /\bsubject\b/.test(error.detail ?? '')) {
      unsupported.add(request.subject.type);
      cells.set(key, { state: 'unsupported' });
      return;
    }
    // Only an answer tells that the type may be simulated: after any failure its next request still goes alone.
    cells.set(key, { state: 'error', error });
    if (STOPPING.has(error.kind)) latched = { status: 'paused', error };
  }

  function dropQueue(): void {
    queue.length = 0;
    queued.clear();
  }

  function enqueue(cell: EffectiveRequest, key: string): void {
    asked.set(key, cell);
    queued.add(key);
    queue.push(cell);
  }

  function request(cellsAsked: readonly EffectiveRequest[]): void {
    if (disposed) return;
    // Only a change notifies: a request for cells already known changes nothing, so asking again is free.
    let changed = sync();
    if (status() === 'ready')
      for (const cell of cellsAsked) {
        const key = effectiveCellKey(cell.columnKey, cell.toolRef);
        if (cells.has(key) || queued.has(key)) continue;
        changed = true;
        if (unsupported.has(cell.subject.type)) {
          cells.set(key, { state: 'unsupported' });
          continue;
        }
        enqueue(cell, key);
      }
    // Whatever changed, a queue left waiting (by a reload that paused the view) is sent now.
    if (!changed && (queue.length === 0 || status() !== 'ready')) return;
    pump();
    notify();
  }

  const offChange = deps.onChange(() => {
    if (disposed) return;
    // A change of the published policies or the tools makes every cell out of date; a reload that ends resumes the
    // queue it held.
    sync();
    pump();
    notify();
  });

  snapshot = build();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    request,
    setBasis(next) {
      if (disposed || JSON.stringify(next) === JSON.stringify(basis)) return;
      basis = next;
      sync();
      notify();
    },
    retry() {
      if (disposed || latched?.status !== 'paused') return;
      latched = undefined;
      // Every cell that failed is asked again, ahead of those still queued.
      const again: EffectiveRequest[] = [];
      for (const [key, cell] of [...cells])
        if (cell.state === 'error') {
          cells.delete(key);
          const original = asked.get(key);
          if (original !== undefined) {
            queued.add(key);
            again.push(original);
          }
        }
      queue.unshift(...again);
      pump();
      notify();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      round.abort();
      offChange();
      listeners.clear();
    },
  };
}
