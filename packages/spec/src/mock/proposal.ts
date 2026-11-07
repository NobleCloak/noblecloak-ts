/**
 * Deployment-applied proposals (rev 14): the parts of `tool:noblecloak:propose-policy-set` that read only the
 * proposal itself. What needs the mock's state (the checks against it, the preview, the effect on approval)
 * is in `app.ts`.
 */
import type { ErrorObject } from 'ajv/dist/2020.js';

import type { Obj } from './store.js';

/** The namespace the deployment reserves to the references it applies itself. */
export const DEPLOYMENT_APPLIED_PREFIX = 'tool:noblecloak:';
export const PROPOSE_POLICY_SET = `${DEPLOYMENT_APPLIED_PREFIX}propose-policy-set`;
/** The schema `action.arguments` of an approval for `PROPOSE_POLICY_SET` must fit. */
export const PROPOSAL_SCHEMA = 'PolicySetProposal';

export const isDeploymentApplied = (toolRef: string): boolean =>
  toolRef.startsWith(DEPLOYMENT_APPLIED_PREFIX);

/** The codes of `proposal_refused` (`Problem.code`); `policy_conflict` is only ever a refusal at approval. */
export type RefusalCode =
  | 'not_a_user'
  | 'shape'
  | 'unknown_agent'
  | 'principal_bound'
  | 'tool_ref_in_use'
  | 'target_unknown'
  | 'baseline_exists'
  | 'tightening_looser'
  | 'not_entitled';

/** The kinds of row a proposal carries (`PolicySetEntry.role`); `role` is rev 18. */
export type RowKind = 'baseline' | 'tightening' | 'role';
export const ROW_KINDS: readonly RowKind[] = ['baseline', 'tightening', 'role'];
/** The optional members of a proposal beyond those of rev 14 (`Capabilities.proposals.members`). */
export const PROPOSAL_MEMBERS: readonly string[] = ['tool_grants'];
/** Rev 18: the entitlement key a `role` row needs (`Capabilities.entitlements`). */
export const ROLE_SUBJECTS_ENTITLEMENT = 'policies.role_subjects';

export interface Refusal {
  readonly code: RefusalCode | 'policy_conflict';
  /** A path into the request body as sent, when the refusal has a part of it to name. */
  readonly member?: string;
  readonly detail: string;
}

export interface ProposedPolicy {
  readonly role: RowKind;
  readonly policy: Obj;
}

/** The members of a `PolicySetProposal` the mock reads, once it fits the schema. */
export interface Proposal {
  /** Absent on a proposal of organisation policies alone (rev 18). */
  readonly agent?: { readonly id: string; readonly principal_id?: string };
  readonly tools: readonly Obj[];
  readonly policies: readonly ProposedPolicy[];
  /** Rev 18: the tools to grant to `agent.principal_id` on approval; empty when the member is absent. */
  readonly tool_grants: readonly string[];
}

/** What a deployment accepts in a proposal (`Capabilities.proposals`). */
export interface ProposalsServed {
  readonly row_kinds: readonly string[];
  readonly members: readonly string[];
}

/**
 * Whether a role key names `everyone`, the reserved role a `baseline` is for: the bare key in any case, or a form
 * that ends in `:everyone` or `/everyone`, compared after Unicode compatibility normalisation (NFKC), so that a
 * full-width `ｅveryone` names it too.
 */
export const namesEveryone = (key: string): boolean => {
  const lower = key.normalize('NFKC').toLowerCase();
  return lower === 'everyone' || lower.endsWith(':everyone') || lower.endsWith('/everyone');
};

/**
 * Whether a role row may name `key` (rev 18): a key that is not empty, has no whitespace before or after it (a
 * deployment that trims keys would read another role, or `everyone`), and does not name `everyone`.
 */
export const isRoleRowKey = (key: string): boolean =>
  key.length > 0 && key.trim() === key && !namesEveryone(key);

/** Where `action.arguments` sits in the body of `POST /v1/approvals`. */
export const ARGUMENTS_AT = 'action.arguments';

/**
 * How tight a `tool_invocation` mode is under tightest-wins: `deny` and `not_granted` (which composes as `deny`),
 * then needing approval (`ask`, `escalate`), then `always_allow`. The lowest is the tightest.
 */
export const MODE_TIGHTNESS: Readonly<Record<string, number>> = {
  deny: 0,
  not_granted: 0,
  escalate: 1,
  ask: 1,
  always_allow: 2,
};
export const tightnessOfMode = (mode: string): number => MODE_TIGHTNESS[mode] ?? 3;

/** The tightness of a composed decision, on the same scale as a mode's. */
export const tightnessOfDecision = (decision: string): number =>
  decision === 'deny' ? 0 : decision === 'step_up' ? 1 : decision === 'allow' ? 2 : 3;

/**
 * An ajv instance path (`/policies/0/policy`) as the dotted and bracketed path a `member` is (`policies[0].policy`).
 * A name that is not an identifier (`x-foo`, an unknown property of a caller) cannot be a member, so the path stops
 * at the nearest parent that can.
 */
export const memberPath = (instancePath: string, leaf?: string): string => {
  const segments = instancePath.split('/').filter((segment) => segment !== '');
  if (leaf !== undefined) segments.push(leaf);
  let path = '';
  for (const segment of segments) {
    if (/^[0-9]+$/.test(segment)) path = `${path}[${segment}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))
      path = path === '' ? segment : `${path}.${segment}`;
    else break;
  }
  return path;
};

/** The refusal for the first schema error of a proposal: `shape`, naming the member inside `action.arguments`. */
export const schemaRefusal = (errors: readonly ErrorObject[] | null | undefined): Refusal => {
  const first = errors?.[0];
  if (first === undefined)
    return { code: 'shape', detail: 'The proposal does not fit its schema.' };
  const leaf =
    first.keyword === 'additionalProperties'
      ? (first.params as { additionalProperty: string }).additionalProperty
      : first.keyword === 'required'
        ? (first.params as { missingProperty: string }).missingProperty
        : undefined;
  const inside = memberPath(first.instancePath, leaf);
  return {
    code: 'shape',
    member: inside === '' ? ARGUMENTS_AT : `${ARGUMENTS_AT}.${inside}`,
    detail: `The proposal ${first.instancePath === '' ? '' : `at ${first.instancePath} `}${first.message ?? 'is invalid'}.`,
  };
};

const at = (path: string): string => `${ARGUMENTS_AT}.${path}`;

/** What the one subject of each kind of row is, as the refusal of a row that breaks it says. */
const SUBJECT_RULE: Readonly<Record<RowKind, string>> = {
  baseline: 'A baseline is for the subject { type: role, id: everyone }.',
  tightening: "A tightening is for the proposal's agent, { type: agent, id: <agent.id> }.",
  role: 'A role row is for one role of the organisation, { type: role, id: <key> }, with a key that is not empty and has no whitespace before or after it, and never everyone: a policy of everyone is a baseline.',
};

/** The tool a policy of the proposal targets, when it targets exactly one. */
export const targetOf = (policy: Obj): string | undefined => {
  const targets = policy.targets;
  if (typeof targets !== 'object' || targets === null) return undefined;
  const tools = (targets as Obj).tools;
  return Array.isArray(tools) && tools.length === 1 ? String(tools[0]) : undefined;
};

/**
 * The rules of `PolicySetProposal` beyond its schema: a row kind and an optional member the deployment serves
 * (`served`, rev 18); no two tools of one reference; without an agent no tightening and no tool grants (rev 18);
 * tool grants only with `agent.principal_id`, none in the deployment-applied namespace or among the proposal's own
 * tools (rev 18); a baseline is a `tool_invocation` policy on the subject `{ role, everyone }`, a tightening one on
 * `{ agent, <agent.id> }`, a role row one on `{ role, <key> }` where the key is not `everyone` (rev 18), each with
 * exactly one subject and exactly one target tool; no target is a deployment-applied reference; no two policies
 * have the same target tool and subject; a policy's `config` carries only `mode` and it has no `origin`
 * (`modeOnly: false` is the break that lets the rest through, `baselineModeOnly: false` the one that lets a baseline's
 * through; `grantsNeedPrincipal: false` the one that lets tool grants through when the agent names no principal,
 * though never when there is no agent). The first that breaks is `shape`.
 */
export const ruleRefusal = (
  proposal: Proposal,
  {
    modeOnly = true,
    baselineModeOnly = true,
    grantsNeedPrincipal = true,
    served = { row_kinds: ROW_KINDS, members: PROPOSAL_MEMBERS },
  }: {
    readonly modeOnly?: boolean;
    readonly baselineModeOnly?: boolean;
    readonly grantsNeedPrincipal?: boolean;
    readonly served?: ProposalsServed;
  } = {}
): Refusal | undefined => {
  for (const [i, { role }] of proposal.policies.entries())
    if (!served.row_kinds.includes(role))
      return {
        code: 'shape',
        member: at(`policies[${String(i)}].role`),
        detail: `This deployment does not accept ${role} rows.`,
      };
  const grants = proposal.tool_grants;
  if (grants.length > 0 && !served.members.includes('tool_grants'))
    return {
      code: 'shape',
      member: at('tool_grants'),
      detail: 'This deployment does not apply tool grants.',
    };
  if (proposal.agent === undefined) {
    const tightening = proposal.policies.findIndex((entry) => entry.role === 'tightening');
    if (tightening >= 0)
      return {
        code: 'shape',
        member: at(`policies[${String(tightening)}].role`),
        detail: 'A tightening is for the agent of the proposal, and this proposal names none.',
      };
  }
  if (
    grants.length > 0 &&
    proposal.agent?.principal_id === undefined &&
    (grantsNeedPrincipal || proposal.agent === undefined)
  )
    return {
      code: 'shape',
      member: at('tool_grants'),
      detail:
        'Tool grants are for the service principal in agent.principal_id, and this proposal names none.',
    };
  const own = new Set(proposal.tools.map((tool) => String(tool.tool_ref)));
  for (const [i, ref] of grants.entries()) {
    if (isDeploymentApplied(ref))
      return {
        code: 'shape',
        member: at(`tool_grants[${String(i)}]`),
        detail: `${ref} is a deployment-applied reference; it is granted to no one.`,
      };
    if (own.has(ref))
      return {
        code: 'shape',
        member: at(`tool_grants[${String(i)}]`),
        detail: `${ref} is a tool of this proposal; a grant names a tool the organisation already owns.`,
      };
  }
  const seen = new Set<string>();
  for (const [i, tool] of proposal.tools.entries()) {
    const ref = String(tool.tool_ref);
    if (seen.has(ref))
      return {
        code: 'shape',
        member: at(`tools[${String(i)}].tool_ref`),
        detail: `${ref} is in the proposal's tools more than once.`,
      };
    seen.add(ref);
  }
  const claimed = new Set<string>();
  for (const [i, { role, policy }] of proposal.policies.entries()) {
    const where = `policies[${String(i)}].policy`;
    if (policy.kind !== 'tool_invocation')
      return {
        code: 'shape',
        member: at(`${where}.kind`),
        detail: `A ${role} is a tool_invocation policy.`,
      };
    const subjects = policy.subjects as Obj[];
    if (subjects.length !== 1)
      return {
        code: 'shape',
        member: at(`${where}.subjects`),
        detail: `A ${role} has exactly one subject.`,
      };
    const subject = subjects[0] ?? {};
    const wanted =
      role === 'baseline'
        ? subject.type === 'role' && subject.id === 'everyone'
        : role === 'role'
          ? subject.type === 'role' && typeof subject.id === 'string' && isRoleRowKey(subject.id)
          : subject.type === 'agent' && subject.id === proposal.agent?.id;
    if (!wanted)
      return {
        code: 'shape',
        member: at(`${where}.subjects[0]`),
        detail: SUBJECT_RULE[role],
      };
    const target = targetOf(policy);
    if (target === undefined)
      return {
        code: 'shape',
        member: at(`${where}.targets.tools`),
        detail: `A ${role} targets exactly one tool, named in targets.tools.`,
      };
    if (isDeploymentApplied(target))
      return {
        code: 'shape',
        member: at(`${where}.targets.tools[0]`),
        detail: `${target} is a deployment-applied reference; no policy targets it.`,
      };
    if (modeOnly && (role !== 'baseline' || baselineModeOnly)) {
      if (policy.origin !== undefined)
        return {
          code: 'shape',
          member: at(`${where}.origin`),
          detail: `A ${role} is a new policy and carries no origin.`,
        };
      const config = policy.config;
      const extra =
        typeof config === 'object' && config !== null
          ? Object.keys(config).find((key) => key !== 'mode')
          : undefined;
      if (extra !== undefined)
        return {
          code: 'shape',
          member: at(`${where}.config.${extra}`),
          detail: `A proposed policy's config carries only mode; ${extra} is not proposed.`,
        };
    }
    const claim = `${target}|${String(subject.type)}:${String(subject.id)}`;
    if (claimed.has(claim))
      return {
        code: 'shape',
        member: at(`${where}.targets.tools[0]`),
        detail: `An earlier policy of the proposal already governs ${target} for the same subject.`,
      };
    claimed.add(claim);
  }
  return undefined;
};
