/**
 * The intermediate form between a NobleCloak policy and Cedar text: the subset of Cedar's JSON policy
 * format (EST) this package writes and reads. The exporter builds it and prints it; the importer reads
 * cedar-wasm's EST into it and lists what does not fit.
 */
import type { PolicySubject } from '../types.js';

export interface EntityRef {
  readonly type: string;
  readonly id: string;
}

export type Scope =
  { readonly op: 'All' } | { readonly op: '==' | 'in'; readonly entity: EntityRef };

export interface Statement {
  /** In print order. */
  readonly annotations: readonly (readonly [string, string])[];
  readonly effect: 'permit' | 'forbid';
  readonly principal: Scope;
  /** `All`, or `==` the dialect's action. */
  readonly action: Scope;
  /** `All`, or `==` one tool. */
  readonly resource: Scope;
  /** Two or more tools: `when { [...].contains(resource) }`, with `resource` unconstrained. */
  readonly resourceIn?: readonly EntityRef[];
}

/** A Cedar dialect: which entity types and action a NobleCloak policy is written with. */
export interface Dialect {
  readonly name: 'noblecloak' | 'agt';
  /** For reports: "Cedar (NobleCloak dialect)", "AGT". */
  readonly label: string;
  readonly action: EntityRef;
  readonly toolType: string;
  /** The principal scope of a subject, or undefined when the dialect has no principal for it. */
  subjectScope(subject: PolicySubject): Scope | undefined;
  /** The subject a principal scope stands for, or undefined when it stands for none. */
  subjectOf(scope: Scope): PolicySubject | undefined;
}

type PrincipalKind = Exclude<PolicySubject['type'], 'organization'>;

/** `==` for an entity a principal is; `in` for a group or role a principal belongs to. */
const NOBLECLOAK_PRINCIPALS: Readonly<
  Record<PrincipalKind, { readonly type: string; readonly op: '==' | 'in' }>
> = {
  user: { type: 'NobleCloak::User', op: '==' },
  agent: { type: 'NobleCloak::Agent', op: '==' },
  service: { type: 'NobleCloak::Service', op: '==' },
  group: { type: 'NobleCloak::Group', op: 'in' },
  role: { type: 'NobleCloak::Role', op: 'in' },
};

function inverse(
  table: Readonly<
    Partial<Record<PrincipalKind, { readonly type: string; readonly op: '==' | 'in' }>>
  >
): (scope: Scope) => PolicySubject | undefined {
  return (scope) => {
    if (scope.op === 'All') return { type: 'organization' };
    for (const [kind, entry] of Object.entries(table) as [
      PrincipalKind,
      { type: string; op: '==' | 'in' },
    ][]) {
      if (entry.type === scope.entity.type && entry.op === scope.op)
        return { type: kind, id: scope.entity.id };
    }
    return undefined;
  };
}

function forward(
  table: Readonly<
    Partial<Record<PrincipalKind, { readonly type: string; readonly op: '==' | 'in' }>>
  >
): (subject: PolicySubject) => Scope | undefined {
  return (subject) => {
    if (subject.type === 'organization') return { op: 'All' };
    const entry = table[subject.type];
    return entry === undefined
      ? undefined
      : { op: entry.op, entity: { type: entry.type, id: subject.id } };
  };
}

/** NobleCloak's own dialect (`schemas/noblecloak.cedarschema`): every subject type has a principal. */
export const NOBLECLOAK: Dialect = {
  name: 'noblecloak',
  label: 'Cedar (NobleCloak dialect)',
  action: { type: 'NobleCloak::Action', id: 'tool_invocation' },
  toolType: 'NobleCloak::Tool',
  subjectScope: forward(NOBLECLOAK_PRINCIPALS),
  subjectOf: inverse(NOBLECLOAK_PRINCIPALS),
};

const AGT_PRINCIPALS = { agent: { type: 'Agent', op: '==' } } as const;

/**
 * AGT's dialect, fixed by its engine's request builder: `principal = Agent::"<agent id>"`,
 * `action = Action::"pre_tool_call"`, `resource = Tool::"<tool name>"`, no namespace. It has no end-user
 * principal, so only `agent` and `organization` subjects have one (`schemas/agt.cedarschema`).
 */
export const AGT: Dialect = {
  name: 'agt',
  label: 'AGT',
  action: { type: 'Action', id: 'pre_tool_call' },
  toolType: 'Tool',
  subjectScope: forward(AGT_PRINCIPALS),
  subjectOf: inverse(AGT_PRINCIPALS),
};
