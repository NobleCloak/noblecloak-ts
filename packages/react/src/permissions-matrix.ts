/**
 * The role × tool grid, built from what the lists returned. Pure: no I/O.
 *
 * A cell shows the published `tool_invocation` policy whose subjects include the column's subject and whose targets
 * include the row's tool. The contract makes that policy unique (publishing a second policy on the same pair is 409
 * `policy_conflict`), so the cell states a fact of the wire, not a composition rule; when a list returns two anyway,
 * the cell says `conflict`. A cell with no such policy says only that: what the deployment's default gives is not
 * known here, and nothing in this grid says what a person holding a role actually gets.
 */
import type {
  CellPolicy,
  DraftEntry,
  MatrixCell,
  MatrixColumn,
  MatrixGroup,
  OtherSubjectEntry,
  PendingRef,
  PermissionsMatrix,
  PolicyInfo,
  PolicySubject,
  RoleOption,
  ToolInfo,
  UnplacedPolicy,
} from './permissions-types.js';

/** What the grid is built from. */
export interface MatrixInput {
  readonly policies: readonly PolicyInfo[];
  readonly tools: readonly ToolInfo[];
  readonly drafts: readonly DraftEntry[];
  readonly directoryRoles: readonly RoleOption[];
  readonly connectionNames: Readonly<Record<string, string>>;
}

const ORGANIZATION_KEY = 'organization';

/** The column key of a role or the organisation subject; `undefined` for any other subject. */
export function subjectKey(subject: PolicySubject): string | undefined {
  if (subject.type === 'organization') return ORGANIZATION_KEY;
  if (subject.type === 'role' && subject.id !== undefined) return `role:${subject.id}`;
  return undefined;
}

/** Whether a policy's targets cover a tool. Absent targets cover nothing here (the policy is not placed). */
function covers(policy: PolicyInfo, toolRef: string): boolean {
  return policy.targets === 'all' || (policy.targets?.includes(toolRef) ?? false);
}

/** True when the policy governs exactly one pair: one subject and one named target. */
export function isSoleCell(policy: PolicyInfo): boolean {
  return (
    policy.subjects.length === 1 && Array.isArray(policy.targets) && policy.targets.length === 1
  );
}

function cellPolicyOf(policy: PolicyInfo): CellPolicy {
  return {
    policyId: policy.id,
    ...(policy.name === undefined ? {} : { name: policy.name }),
    version: policy.version,
    ...(policy.mode === undefined ? {} : { mode: policy.mode }),
    modeKnown: policy.modeKnown,
    source: policy.source,
    ...(policy.updatedBy === undefined ? {} : { updatedBy: policy.updatedBy }),
    soleCell: isSoleCell(policy),
  };
}

function pendingRefOf(policy: PolicyInfo): PendingRef {
  return {
    policyId: policy.id,
    ...(policy.name === undefined ? {} : { name: policy.name }),
    version: policy.version,
  };
}

/** The columns: the host's roles, then the directory's, then those the policies name, then the organisation. */
function columnsOf(
  roles: readonly RoleOption[],
  directory: readonly RoleOption[],
  policies: readonly PolicyInfo[]
): MatrixColumn[] {
  const labels = new Map<string, string | undefined>();
  const add = (id: string, label: string | undefined): void => {
    if (!labels.has(id)) labels.set(id, label);
    else if (labels.get(id) === undefined && label !== undefined) labels.set(id, label);
  };
  for (const role of roles) add(role.id, role.label);
  for (const role of directory) add(role.id, role.label);
  const named = new Set<string>();
  for (const policy of policies)
    for (const subject of policy.subjects)
      if (subject.type === 'role' && subject.id !== undefined) named.add(subject.id);
  for (const id of [...named].sort()) add(id, undefined);
  return [
    ...[...labels].map(([id, label]) => ({
      key: `role:${id}`,
      subject: { type: 'role', id },
      label: label ?? id,
    })),
    { key: ORGANIZATION_KEY, subject: { type: 'organization' }, label: ORGANIZATION_KEY },
  ];
}

/**
 * Builds the grid. `roles` are the host's columns. Only published policies govern a cell; drafts (never published,
 * or the pending draft of a published policy once the store has read it) are listed as pending on the pairs they
 * cover.
 */
export function buildPermissionsMatrix(
  input: MatrixInput,
  roles: readonly RoleOption[] = []
): PermissionsMatrix {
  const unplaced: UnplacedPolicy[] = [];
  const published: PolicyInfo[] = [];
  const drafts: PolicyInfo[] = [];
  for (const policy of input.policies) {
    if (policy.state === 'unknown') unplaced.push({ policy, reason: 'state_not_stated' });
    else if (policy.targets === undefined) unplaced.push({ policy, reason: 'targets_not_stated' });
    else if (policy.state === 'published') published.push(policy);
    else drafts.push(policy);
  }
  // A pending draft of a published policy is known only once read. A never-published draft is a list row, unless the
  // store wrote it after the list was read.
  const listed = new Set(input.policies.map((p) => p.id));
  for (const entry of input.drafts)
    if (
      (!entry.neverPublished || !listed.has(entry.policyId)) &&
      entry.policy.targets !== undefined
    )
      drafts.push(entry.policy);

  // A target that names no listed tool has no row to sit on (a deployment that hides a withdrawn tool, or one that
  // removed it): the policy is listed with those targets, so it is never missing from the grid without a word.
  const listedTools = new Set(input.tools.map((t) => t.toolRef));
  for (const policy of [...published, ...drafts]) {
    const targets = policy.targets;
    if (targets === undefined || targets === 'all') continue;
    const toolRefs = targets.filter((ref) => !listedTools.has(ref));
    if (toolRefs.length > 0) unplaced.push({ policy, reason: 'target_not_listed', toolRefs });
  }

  const otherSubjects: OtherSubjectEntry[] = [];
  for (const policy of [...published, ...drafts])
    for (const subject of policy.subjects)
      if (subjectKey(subject) === undefined) otherSubjects.push({ subject, policy });

  // Every listed policy names its roles as columns, a policy the grid cannot place included.
  const columns = columnsOf(roles, input.directoryRoles, [...input.policies, ...drafts]);
  const governing = (
    columnKey: string,
    toolRef: string,
    from: readonly PolicyInfo[]
  ): PolicyInfo[] =>
    from.filter((p) => covers(p, toolRef) && p.subjects.some((s) => subjectKey(s) === columnKey));

  const cellOf = (column: MatrixColumn, tool: ToolInfo): MatrixCell => {
    const pending = governing(column.key, tool.toolRef, drafts).map(pendingRefOf);
    const found = governing(column.key, tool.toolRef, published);
    const base = { columnKey: column.key, toolRef: tool.toolRef, pending };
    const [only] = found;
    if (only === undefined) return { ...base, state: 'none' };
    if (found.length === 1) return { ...base, state: 'governed', policy: cellPolicyOf(only) };
    return { ...base, state: 'conflict', policies: found.map(cellPolicyOf) };
  };

  const byConnection = new Map<string | null, ToolInfo[]>();
  for (const tool of input.tools) {
    const list = byConnection.get(tool.connectionId) ?? [];
    list.push(tool);
    byConnection.set(tool.connectionId, list);
  }
  // Connections in the order the tools list first names them; tools without a connection last.
  const order = [...byConnection.keys()].sort((a, b) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : 0
  );
  const groups: MatrixGroup[] = order.map((connectionId) => {
    const name = connectionId === null ? undefined : input.connectionNames[connectionId];
    return {
      connectionId,
      ...(name === undefined ? {} : { name }),
      rows: (byConnection.get(connectionId) ?? []).map((tool) => ({
        tool,
        cells: columns.map((column) => cellOf(column, tool)),
      })),
    };
  });
  return { columns, groups, otherSubjects, unplaced };
}

/** Every cell a published policy governs in the grid, row by row. */
export function cellsGovernedBy(
  matrix: PermissionsMatrix,
  policyId: string
): { readonly columnKey: string; readonly toolRef: string }[] {
  const out: { columnKey: string; toolRef: string }[] = [];
  for (const group of matrix.groups)
    for (const row of group.rows)
      for (const cell of row.cells) {
        const ids =
          cell.state === 'governed'
            ? [cell.policy.policyId]
            : cell.state === 'conflict'
              ? cell.policies.map((p) => p.policyId)
              : [];
        if (ids.includes(policyId)) out.push({ columnKey: cell.columnKey, toolRef: cell.toolRef });
      }
  return out;
}
