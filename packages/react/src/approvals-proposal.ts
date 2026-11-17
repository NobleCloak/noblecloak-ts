/**
 * Reads a policy-set proposal for the approval detail: the arguments of a `tool:noblecloak:propose-policy-set`
 * approval (`PolicySetProposal`) and the `preview` the single read serves to a reader who may approve it
 * (`ApprovalPreview`), as the plain facts the detail shows. No React.
 *
 * Both inputs come from the service untrusted, so they are read defensively: a member this version does not know
 * is ignored, and one that is present but not the shape the contract gives it makes the whole reading
 * `unreadable`, so the detail shows the generic call instead of a summary that leaves a part out. A preview is
 * never made up: without one the reading has none, and it never says that approving "loosens no policy".
 */
import type { components } from '@noblecloak/client';

import type { JsonObject } from './approvals-types.js';

type Schemas = components['schemas'];

/**
 * Compile-time parity guard: the members this module reads by string name, each checked against the generated
 * contract. The reader takes untrusted JSON, so it does not use these types to read; but a rename in the contract
 * (`Pick` needs every key to exist) fails `typecheck` here instead of turning every proposal `unreadable`.
 */
export type ReadContractMembers = [
  Pick<Schemas['PolicySetProposal'], 'agent' | 'tools' | 'policies' | 'tool_grants'>,
  Pick<NonNullable<Schemas['PolicySetProposal']['agent']>, 'id' | 'principal_id'>,
  Pick<Schemas['PolicySetEntry'], 'role' | 'policy'>,
  Pick<Schemas['PolicyWrite'], 'subjects' | 'targets' | 'config'>,
  Pick<Schemas['ApprovalPreview'], 'loosening' | 'grants' | 'ineffective'>,
  Pick<Schemas['ApprovalPreview']['loosening'][number], 'tool_ref' | 'from' | 'to' | 'subject'>,
  Pick<NonNullable<Schemas['ApprovalPreview']['grants']>[number], 'tool_ref'>,
  Pick<NonNullable<Schemas['ApprovalPreview']['ineffective']>[number], 'tool_ref' | 'subject'>,
];

/** The tool of a policy-set proposal (`Capabilities.deployment_applied`). */
export const PROPOSE_POLICY_SET_TOOL = 'tool:noblecloak:propose-policy-set';

/** Who a policy row or a change is for: `PolicySubject`, with `{ role, everyone }` told apart as `everyone`. */
export type ProposalSubject =
  | { readonly kind: 'everyone' }
  | { readonly kind: 'role'; readonly key: string }
  | { readonly kind: 'agent'; readonly id: string }
  | { readonly kind: 'organization' }
  /** A subject type this version does not name (a user, a service principal, a later one). */
  | { readonly kind: 'other'; readonly type: string; readonly id: string };

/** One proposed policy, for one tool: its row kind (`baseline`, `tightening`, `role`, or one this version does not know) and mode. */
export interface ProposalRow {
  readonly kind: string;
  /** The `tool_ref` it governs; `undefined` when the policy governs every tool. */
  readonly toolRef: string | undefined;
  /** `always_allow`, `ask`, `escalate`, `deny`, `not_granted`, or a mode this version does not know. */
  readonly mode: string;
}

/** The rows of one subject, in the order they appear in the proposal. */
export interface ProposalGroup {
  readonly subject: ProposalSubject;
  readonly rows: readonly ProposalRow[];
}

export interface ProposalTool {
  readonly toolRef: string;
  readonly sideEffectLevel: string | undefined;
}

export interface ProposalAgent {
  readonly id: string;
  /** The service principal bound to the agent on approval; absent leaves the agent's binding as it is. */
  readonly principalId: string | undefined;
}

/** A `loosening` entry of the preview: what a subject gets for a tool now (`from`) and once this is approved (`to`). */
export interface ProposalChange {
  readonly subject: ProposalSubject;
  readonly toolRef: string;
  readonly from: string;
  readonly to: string;
}

/** An `ineffective` entry of the preview: a `role` row that changes nothing while a tighter policy of everyone stands. */
export interface ProposalIneffective {
  readonly subject: ProposalSubject;
  readonly toolRef: string;
}

/** What the preview says, as far as the detail shows it. The simulations are not shown. */
export interface ProposalPreview {
  readonly loosening: readonly ProposalChange[];
  readonly ineffective: readonly ProposalIneffective[];
  /** The `tool_ref`s of `grants`, in the order given. */
  readonly grants: readonly string[];
}

export interface Proposal {
  /** The proposed policies by subject; `undefined` when the call was not served to this reader. */
  readonly groups: readonly ProposalGroup[] | undefined;
  /** The tools to register on approval. */
  readonly tools: readonly ProposalTool[];
  /** The agent to bind; `undefined` when the proposal names none, or the call was not served. */
  readonly agent: ProposalAgent | undefined;
  /** The `tool_grants` of the arguments; `undefined` when there are none or the call was not served. */
  readonly toolGrants: readonly string[] | undefined;
  /** The preview; `undefined` when the reader was not served one (not eligible to approve, or the approval is final). */
  readonly preview: ProposalPreview | undefined;
}

export type ProposalReading =
  /** Not a proposal, or nothing of one was served: the generic view applies. */
  | { readonly status: 'none' }
  /** A proposal whose arguments or preview are present but not readable: the generic view applies, with a notice. */
  | { readonly status: 'unreadable' }
  | { readonly status: 'ok'; readonly proposal: Proposal };

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isOptString = (value: unknown): value is string | undefined =>
  value === undefined || isString(value);

/** `PolicySubject`: `{ type, id }`, or `{ type: organization }`. `undefined` when it is neither. */
function subjectOf(value: unknown): ProposalSubject | undefined {
  if (!isRecord(value) || !isString(value.type)) return undefined;
  if (value.type === 'organization') return { kind: 'organization' };
  if (!isString(value.id)) return undefined;
  if (value.type === 'role') {
    return value.id === 'everyone' ? { kind: 'everyone' } : { kind: 'role', key: value.id };
  }
  if (value.type === 'agent') return { kind: 'agent', id: value.id };
  return { kind: 'other', type: value.type, id: value.id };
}

/** A stable text for a subject, to group by. */
function subjectKey(subject: ProposalSubject): string {
  switch (subject.kind) {
    case 'everyone':
    case 'organization':
      return subject.kind;
    case 'role':
      return `role:${subject.key}`;
    case 'agent':
      return `agent:${subject.id}`;
    case 'other':
      return `${subject.type}:${subject.id}`;
  }
}

/** Everyone first, then roles, the organisation, agents and the rest; each kind in first-seen order. */
const SUBJECT_RANK: Readonly<Record<ProposalSubject['kind'], number>> = {
  everyone: 0,
  role: 1,
  organization: 2,
  agent: 3,
  other: 4,
};

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: unknown[] = value;
  return items.every(isString) ? items : undefined;
}

/** The tools a policy governs: a list of `tool_ref`s, or every tool (`targets` absent, or `{ tools: all }`). */
function targetsOf(policy: Json): readonly (string | undefined)[] | undefined {
  const targets = policy.targets;
  if (targets === undefined) return [undefined];
  if (!isRecord(targets)) return undefined;
  if (targets.tools === 'all') return [undefined];
  const tools = stringList(targets.tools);
  return tools === undefined || tools.length === 0 ? undefined : tools;
}

/** One `PolicySetEntry` as rows, one for each subject and each tool it names; `undefined` when it cannot be read. */
function entryRows(
  entry: unknown
): readonly { readonly subject: ProposalSubject; readonly row: ProposalRow }[] | undefined {
  if (!isRecord(entry) || !isString(entry.role) || !isRecord(entry.policy)) return undefined;
  const policy = entry.policy;
  if (!Array.isArray(policy.subjects) || policy.subjects.length === 0) return undefined;
  const subjects = (policy.subjects as unknown[]).map(subjectOf);
  const tools = targetsOf(policy);
  const mode = isRecord(policy.config) ? policy.config.mode : undefined;
  if (tools === undefined || !isString(mode) || subjects.some((s) => s === undefined)) {
    return undefined;
  }
  const kind = entry.role;
  return (subjects as ProposalSubject[]).flatMap((subject) =>
    tools.map((toolRef) => ({ subject, row: { kind, toolRef, mode } }))
  );
}

function groupRows(
  pairs: readonly { readonly subject: ProposalSubject; readonly row: ProposalRow }[]
): readonly ProposalGroup[] {
  const groups = new Map<string, { subject: ProposalSubject; rows: ProposalRow[] }>();
  for (const { subject, row } of pairs) {
    const key = subjectKey(subject);
    const held = groups.get(key);
    if (held === undefined) groups.set(key, { subject, rows: [row] });
    else held.rows.push(row);
  }
  // `sort` is stable, so within one kind the subjects keep the order they first appear in.
  return [...groups.values()].sort(
    (a, b) => SUBJECT_RANK[a.subject.kind] - SUBJECT_RANK[b.subject.kind]
  );
}

type ArgumentsReading = Omit<Proposal, 'preview'>;

/** `PolicySetProposal` as the facts the detail shows; `undefined` when a member the detail reads is not its shape. */
function readArguments(args: JsonObject): ArgumentsReading | undefined {
  if (!Array.isArray(args.policies)) return undefined;
  const pairs: { subject: ProposalSubject; row: ProposalRow }[] = [];
  for (const entry of args.policies as unknown[]) {
    const rows = entryRows(entry);
    if (rows === undefined) return undefined;
    pairs.push(...rows);
  }

  const tools: ProposalTool[] = [];
  if (args.tools !== undefined) {
    if (!Array.isArray(args.tools)) return undefined;
    for (const tool of args.tools as unknown[]) {
      if (!isRecord(tool) || !isString(tool.tool_ref) || !isOptString(tool.side_effect_level)) {
        return undefined;
      }
      tools.push({ toolRef: tool.tool_ref, sideEffectLevel: tool.side_effect_level });
    }
  }

  let agent: ProposalAgent | undefined;
  if (args.agent !== undefined) {
    if (
      !isRecord(args.agent) ||
      !isString(args.agent.id) ||
      !isOptString(args.agent.principal_id)
    ) {
      return undefined;
    }
    agent = { id: args.agent.id, principalId: args.agent.principal_id };
  }

  let toolGrants: readonly string[] | undefined;
  if (args.tool_grants !== undefined) {
    toolGrants = stringList(args.tool_grants);
    if (toolGrants === undefined) return undefined;
  }

  return {
    groups: groupRows(pairs),
    tools,
    agent,
    toolGrants: toolGrants === undefined || toolGrants.length === 0 ? undefined : toolGrants,
  };
}

/** `ApprovalPreview` as the facts the detail shows; `undefined` when a member the detail reads is not its shape. */
function readPreview(value: unknown): ProposalPreview | undefined {
  if (!isRecord(value) || !Array.isArray(value.loosening)) return undefined;
  const loosening: ProposalChange[] = [];
  for (const entry of value.loosening as unknown[]) {
    if (!isRecord(entry) || !isString(entry.tool_ref) || !isString(entry.from)) return undefined;
    if (!isString(entry.to)) return undefined;
    // `subject` is absent on the entry of a baseline, which is for every caller.
    const subject =
      entry.subject === undefined ? { kind: 'everyone' as const } : subjectOf(entry.subject);
    if (subject === undefined) return undefined;
    loosening.push({ subject, toolRef: entry.tool_ref, from: entry.from, to: entry.to });
  }

  const ineffective: ProposalIneffective[] = [];
  if (value.ineffective !== undefined) {
    if (!Array.isArray(value.ineffective)) return undefined;
    for (const entry of value.ineffective as unknown[]) {
      if (!isRecord(entry) || !isString(entry.tool_ref)) return undefined;
      const subject = subjectOf(entry.subject);
      if (subject === undefined) return undefined;
      ineffective.push({ subject, toolRef: entry.tool_ref });
    }
  }

  const grants: string[] = [];
  if (value.grants !== undefined) {
    if (!Array.isArray(value.grants)) return undefined;
    for (const entry of value.grants as unknown[]) {
      if (!isRecord(entry) || !isString(entry.tool_ref)) return undefined;
      grants.push(entry.tool_ref);
    }
  }
  return { loosening, ineffective, grants };
}

/**
 * What an approval says about the policy set it would apply. `toolRef` is the approval's; `args` the arguments
 * its single read served (absent when they were withheld or the approval is final); `preview` the member of the
 * approval of that name, read as it came.
 */
export function readProposal(
  toolRef: string,
  args: JsonObject | undefined,
  preview: unknown
): ProposalReading {
  if (toolRef !== PROPOSE_POLICY_SET_TOOL) return { status: 'none' };
  // `null` is no preview: the contract has the member absent, never null.
  const served = preview ?? undefined;
  if (args === undefined && served === undefined) return { status: 'none' };

  const fromArguments = args === undefined ? undefined : readArguments(args);
  if (args !== undefined && fromArguments === undefined) return { status: 'unreadable' };
  const fromPreview = served === undefined ? undefined : readPreview(served);
  if (served !== undefined && fromPreview === undefined) return { status: 'unreadable' };

  return {
    status: 'ok',
    proposal: {
      groups: fromArguments?.groups,
      tools: fromArguments?.tools ?? [],
      agent: fromArguments?.agent,
      toolGrants: fromArguments?.toolGrants,
      preview: fromPreview,
    },
  };
}

/** `mcp:{server_key}/{surface}/{tool}` shortened to the tool and its server; any other reference is its own short form. */
export function shortToolRef(toolRef: string): { readonly tool: string; readonly server?: string } {
  const match = /^mcp:([^/]+)\/([^/]+)\/(.+)$/.exec(toolRef);
  if (match?.[1] === undefined || match[3] === undefined) return { tool: toolRef };
  return { tool: match[3], server: match[1] };
}
