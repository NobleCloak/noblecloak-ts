/**
 * Response-shape checks for the permissions module. Everything here is pure. A reader returns `undefined` for a body
 * that is not the contract's shape, and a list with one unreadable row is unreadable as a whole: the store reports it
 * as an error and never as an empty list. A kind or a mode the module does not know is kept and flagged, never mapped.
 */
import type {
  ConsideredEntry,
  OtherPolicyView,
  PolicyAuthor,
  PolicyCapabilityFacts,
  PolicyFormsFacts,
  PolicyInfo,
  PolicySubject,
  RoleOption,
  SimulationResult,
  ToolInfo,
} from './permissions-types.js';
import { KNOWN_POLICY_KINDS, isKnownMode } from './permissions-vocabulary.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The `data` of an envelope, or the value itself when it has none. */
const unwrap = (value: unknown): unknown =>
  isRecord(value) && 'data' in value ? value.data : value;

function subjectOf(value: unknown): PolicySubject | undefined {
  if (!isRecord(value) || !isText(value.type)) return undefined;
  if (value.id === undefined) return { type: value.type };
  return isText(value.id) ? { type: value.type, id: value.id } : undefined;
}

/** `'all'`, the `tool_ref`s, `undefined` for absent targets, or `null` for targets of another shape. */
function targetsOf(value: unknown): PolicyInfo['targets'] | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  if (value.tools === 'all') return 'all';
  // The contract names 1 to 100 tools; an empty list governs nothing and is not a form it sends.
  if (Array.isArray(value.tools) && value.tools.length > 0 && value.tools.every(isText))
    return [...value.tools];
  return null;
}

function authorOf(value: unknown): PolicyAuthor | undefined {
  return isRecord(value) && isText(value.id) && isText(value.kind)
    ? { id: value.id, kind: value.kind }
    : undefined;
}

function stateOf(value: Record<string, unknown>): PolicyInfo['state'] {
  if (value.state === 'draft' || value.state === 'published') return value.state;
  // A state the contract does not document is not read from `published_at`: the policy is placed on no cell.
  if (value.state !== undefined) return 'unknown';
  if (typeof value.published_at === 'string') return 'published';
  if (value.published_at === null) return 'draft';
  return 'unknown';
}

/** One policy as the module holds it; `undefined` when the value is not a `Policy`. */
export function policyOf(value: unknown): PolicyInfo | undefined {
  if (!isRecord(value)) return undefined;
  const { id, version, source, kind, subjects, config } = value;
  if (!isText(id) || !isCount(version) || !isText(source) || !isText(kind)) return undefined;
  if (!Array.isArray(subjects) || !isRecord(config)) return undefined;
  const parsedSubjects = subjects.map(subjectOf);
  if (parsedSubjects.some((s) => s === undefined)) return undefined;
  const targets = targetsOf(value.targets);
  if (targets === null) return undefined;
  const mode =
    kind === 'tool_invocation' && typeof config.mode === 'string' ? config.mode : undefined;
  const updatedBy = authorOf(value.updated_by);
  // Once each, in the order sent.
  const unenforced = Array.isArray(value.unenforced_targets)
    ? [...new Set(value.unenforced_targets.filter(isText))]
    : [];
  return {
    id,
    version,
    source,
    kind,
    kindKnown: (KNOWN_POLICY_KINDS as readonly string[]).includes(kind),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    state: stateOf(value),
    subjects: parsedSubjects as PolicySubject[],
    ...(targets === undefined ? {} : { targets }),
    unenforcedTargets: unenforced,
    config: { ...config },
    ...(mode === undefined ? {} : { mode }),
    modeKnown: isKnownMode(mode),
    ...(value.published_at === null || typeof value.published_at === 'string'
      ? { publishedAt: value.published_at }
      : {}),
    ...(typeof value.updated_at === 'string' ? { updatedAt: value.updated_at } : {}),
    ...(updatedBy === undefined ? {} : { updatedBy }),
    ...(isCount(value.draft_version) ? { draftVersion: value.draft_version } : {}),
    ...(isRecord(value.origin) && isText(value.origin.format) && isText(value.origin.digest)
      ? { origin: { format: value.origin.format, digest: value.origin.digest } }
      : {}),
  };
}

/** A `{ data: Policy }` envelope as one policy. */
export function policyEnvelopeOf(value: unknown): PolicyInfo | undefined {
  return policyOf(unwrap(value));
}

export interface Page<T> {
  readonly rows: readonly T[];
  /** The cursor of the next page; absent on the last page. */
  readonly next?: string;
}

/** A list envelope: every row read by `rowOf`, and `meta.next`. One unreadable row makes the page unreadable. */
export function pageOf<T>(
  value: unknown,
  rowOf: (row: unknown) => T | undefined
): Page<T> | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const rows: T[] = [];
  for (const item of value.data as unknown[]) {
    const parsed = rowOf(item);
    if (parsed === undefined) return undefined;
    rows.push(parsed);
  }
  // `meta` is required on a list, and `next` is the cursor or null: anything else could cut the list short unseen.
  if (!isRecord(value.meta)) return undefined;
  const next = value.meta.next;
  if (next === null || next === undefined) return { rows };
  return isText(next) ? { rows, next } : undefined;
}

/** The tool statuses the contract documents (rev 11 `Tool.status`); the enum is open. */
export const KNOWN_TOOL_STATUSES = ['active', 'withdrawn'] as const;

export function toolOf(value: unknown): ToolInfo | undefined {
  if (!isRecord(value) || !isText(value.id) || !isText(value.tool_ref)) return undefined;
  const connection = value.connection_id;
  if (connection !== undefined && connection !== null && typeof connection !== 'string')
    return undefined;
  // Absent is `active` (a server of an earlier revision). Present, it is kept as sent; a value that is not text is kept
  // as its JSON and flagged unknown, so the row and its policies stay on the grid.
  const sent = value.status;
  const status = sent === undefined ? 'active' : isText(sent) ? sent : JSON.stringify(sent);
  return {
    status,
    statusKnown: (KNOWN_TOOL_STATUSES as readonly string[]).includes(status),
    id: value.id,
    toolRef: value.tool_ref,
    connectionId: typeof connection === 'string' ? connection : null,
    ...(typeof value.side_effect_level === 'string'
      ? { sideEffectLevel: value.side_effect_level }
      : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  };
}

/** A principal of the directory as a role column: its id, and its display name as the label. */
export function principalRoleOf(value: unknown): RoleOption | undefined {
  if (!isRecord(value) || !isText(value.id)) return undefined;
  return isText(value.display_name)
    ? { id: value.id, label: value.display_name }
    : { id: value.id };
}

/** A connection as `[id, name]`. */
export function connectionNameOf(value: unknown): readonly [string, string] | undefined {
  return isRecord(value) && isText(value.id) && typeof value.name === 'string'
    ? [value.id, value.name]
    : undefined;
}

const textsOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** `Capabilities.policy_forms`, when it is the contract's shape; a member of another shape is left unread. */
function policyFormsOf(value: unknown): { policyForms?: PolicyFormsFacts } {
  if (!isRecord(value)) return {};
  const form = value.tool_invocation;
  const list = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (
    !isRecord(form) ||
    !list(form.modes) ||
    !list(form.subject_types) ||
    typeof form.targets_all !== 'boolean' ||
    !list(form.config_members)
  )
    return { policyForms: {} };
  return {
    policyForms: {
      toolInvocation: {
        modes: [...form.modes],
        subjectTypes: [...form.subject_types],
        targetsAll: form.targets_all,
        configMembers: [...form.config_members],
      },
    },
  };
}

/** The part of `Capabilities` the module reads: what is advertised, never which deployment answered. */
export function policyCapabilitiesOf(value: unknown): PolicyCapabilityFacts | undefined {
  const body = unwrap(value);
  if (!isRecord(body) || !Array.isArray(body.features)) return undefined;
  const features = new Set(textsOf(body.features));
  const entitlements = new Set(textsOf(body.entitlements));
  return {
    served: features.has('policies'),
    author: features.has('policies.author'),
    publish: features.has('policies.publish'),
    importExport: features.has('policies.import_export'),
    principals: features.has('principals'),
    connections: features.has('connections'),
    runs: features.has('runs'),
    suggested: entitlements.has('policies.suggested'),
    approvals: textsOf(body.resolutions).length > 0,
    tightestWins: features.has('policies.tightest_wins'),
    retire: features.has('policies.retire'),
    ...policyFormsOf(body.policy_forms),
  };
}

/** How a policy of another kind is shown: only a well-formed `duplicate_requests` configuration is summarized. */
export function otherViewOf(policy: PolicyInfo): OtherPolicyView {
  const config = policy.config;
  if (policy.kind !== 'duplicate_requests' || !isText(config.after_rejection))
    return { kind: 'opaque' };
  return {
    kind: 'duplicate_requests',
    afterRejection: config.after_rejection,
    ...(isCount(config.window_seconds) ? { windowSeconds: config.window_seconds } : {}),
    ...(isCount(config.max_reasks) ? { maxReasks: config.max_reasks } : {}),
  };
}

function consideredEntryOf(
  value: unknown,
  names: ReadonlyMap<string, string>
): ConsideredEntry | undefined {
  if (!isRecord(value) || !isText(value.kind) || !isText(value.result)) return undefined;
  const id = value.id === null ? null : isText(value.id) ? value.id : undefined;
  const version =
    value.version === null ? null : isCount(value.version) ? value.version : undefined;
  if (id === undefined || version === undefined) return undefined;
  const subject = value.subject === undefined ? undefined : subjectOf(value.subject);
  if (value.subject !== undefined && subject === undefined) return undefined;
  if (value.source !== undefined && !isText(value.source)) return undefined;
  if (value.contributed !== undefined && typeof value.contributed !== 'boolean') return undefined;
  const name = id === null ? undefined : names.get(id);
  return {
    kind: value.kind,
    id,
    version,
    result: value.result,
    ...(subject === undefined ? {} : { subject }),
    ...(isText(value.source) ? { source: value.source } : {}),
    ...(name === undefined ? {} : { name }),
    ...(typeof value.contributed === 'boolean' ? { contributed: value.contributed } : {}),
  };
}

/**
 * A simulate answer. `names` maps policy ids to the names the list gave them. `appliesToCaller` says whether policy
 * `policyId` was among what the simulation considered for the caller.
 */
export function simulationOf(
  value: unknown,
  policyId: string,
  names: ReadonlyMap<string, string>
): SimulationResult | undefined {
  const body = unwrap(value);
  if (!isRecord(body) || !isText(body.decision) || !isText(body.action_digest)) return undefined;
  if (typeof body.enforced !== 'boolean') return undefined;
  // A member that is present but unreadable makes the answer unreadable: dropping it would turn "this policy decided"
  // into "the default decided", and a missing `would_be` or `rejected_approval_id` into a fact the service never sent.
  for (const member of ['reason', 'would_be', 'rejected_approval_id'] as const)
    if (body[member] !== undefined && !isText(body[member])) return undefined;
  if (
    body.policy !== undefined &&
    !(
      isRecord(body.policy) &&
      isText(body.policy.id) &&
      isCount(body.policy.version) &&
      (body.policy.side_effect_level === undefined || isText(body.policy.side_effect_level))
    )
  )
    return undefined;
  let policy: SimulationResult['policy'];
  if (isRecord(body.policy) && isText(body.policy.id) && isCount(body.policy.version)) {
    policy = {
      id: body.policy.id,
      version: body.policy.version,
      ...(isText(body.policy.side_effect_level)
        ? { sideEffectLevel: body.policy.side_effect_level }
        : {}),
    };
  }
  let considered: SimulationResult['considered'];
  if (body.considered !== undefined) {
    const c = body.considered;
    if (!isRecord(c) || !Array.isArray(c.policies) || !isRecord(c.composed)) return undefined;
    if (!isText(c.composed.decision)) return undefined;
    if (c.composed.reason !== undefined && !isText(c.composed.reason)) return undefined;
    const entries = (c.policies as unknown[]).map((e) => consideredEntryOf(e, names));
    if (entries.some((e) => e === undefined)) return undefined;
    considered = {
      policies: entries as ConsideredEntry[],
      composed: {
        decision: c.composed.decision,
        ...(isText(c.composed.reason) ? { reason: c.composed.reason } : {}),
      },
    };
  }
  const named = policy?.id === policyId;
  const appliesToCaller =
    considered !== undefined
      ? named || considered.policies.some((e) => e.id === policyId)
      : named
        ? true
        : undefined;
  return {
    decision: body.decision,
    ...(isText(body.reason) ? { reason: body.reason } : {}),
    actionDigest: body.action_digest,
    enforced: body.enforced,
    ...(isText(body.would_be) ? { wouldBe: body.would_be } : {}),
    ...(policy === undefined ? {} : { policy }),
    ...(isText(body.rejected_approval_id) ? { rejectedApprovalId: body.rejected_approval_id } : {}),
    ...(considered === undefined ? {} : { considered }),
    ...(appliesToCaller === undefined ? {} : { appliesToCaller }),
  };
}
