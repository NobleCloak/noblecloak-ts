import { describe, expect, it } from 'vitest';

import { buildPermissionsMatrix, cellsGovernedBy, subjectKey } from './permissions-matrix.js';
import type { MatrixInput } from './permissions-matrix.js';
import { policyOf } from './permissions-parse.js';
import type { MatrixCell, PolicyInfo, ToolInfo } from './permissions-types.js';

const tool = (
  toolRef: string,
  connectionId: string | null = null,
  status = 'active'
): ToolInfo => ({
  id: `tool_${toolRef}`,
  toolRef,
  connectionId,
  status,
  statusKnown: status === 'active' || status === 'withdrawn',
});

function policy(id: string, extra: Record<string, unknown> = {}): PolicyInfo {
  const parsed = policyOf({
    id,
    version: 3,
    source: 'authored',
    kind: 'tool_invocation',
    name: `name of ${id}`,
    state: 'published',
    subjects: [{ type: 'role', id: 'member' }],
    targets: { tools: ['t:a'] },
    config: { mode: 'ask' },
    published_at: '2026-10-01T00:00:00.000Z',
    updated_by: { id: 'user_admin', kind: 'user' },
    ...extra,
  });
  if (parsed === undefined) throw new Error('fixture does not parse');
  return parsed;
}

const input = (extra: Partial<MatrixInput> = {}): MatrixInput => ({
  policies: [],
  tools: [tool('t:a'), tool('t:b')],
  drafts: [],
  directoryRoles: [],
  connectionNames: {},
  ...extra,
});

function cell(
  m: ReturnType<typeof buildPermissionsMatrix>,
  columnKey: string,
  toolRef: string
): MatrixCell {
  for (const group of m.groups)
    for (const row of group.rows)
      if (row.tool.toolRef === toolRef) {
        const found = row.cells.find((c) => c.columnKey === columnKey);
        if (found) return found;
      }
  throw new Error(`no cell ${columnKey} × ${toolRef}`);
}

describe('buildPermissionsMatrix', () => {
  it('shows the governing policy with its provenance, and no mode where no policy governs', () => {
    const m = buildPermissionsMatrix(input({ policies: [policy('pol_1')] }));
    expect(m.columns.map((c) => c.key)).toEqual(['role:member', 'organization']);
    const governed = cell(m, 'role:member', 't:a');
    expect(governed).toMatchObject({
      state: 'governed',
      policy: {
        policyId: 'pol_1',
        name: 'name of pol_1',
        version: 3,
        mode: 'ask',
        modeKnown: true,
        updatedBy: { id: 'user_admin', kind: 'user' },
        soleCell: true,
      },
    });
    const none = cell(m, 'role:member', 't:b');
    expect(none.state).toBe('none');
    expect(none).not.toHaveProperty('policy');
    expect(JSON.stringify(none)).not.toMatch(/mode/);
  });

  it('takes columns from the host first, then the directory, then the policies; labels default to the id', () => {
    const m = buildPermissionsMatrix(
      input({
        policies: [policy('pol_1', { subjects: [{ type: 'role', id: 'zeta' }] })],
        directoryRoles: [{ id: 'auditor', label: 'Auditors' }, { id: 'admin' }],
      }),
      [{ id: 'admin', label: 'Administrators' }, { id: 'member' }]
    );
    expect(m.columns.map((c) => [c.key, c.label])).toEqual([
      ['role:admin', 'Administrators'],
      ['role:member', 'member'],
      ['role:auditor', 'Auditors'],
      ['role:zeta', 'zeta'],
      ['organization', 'organization'],
    ]);
  });

  it('places an organization-subject policy in the Organisation column', () => {
    const m = buildPermissionsMatrix(
      input({ policies: [policy('pol_org', { subjects: [{ type: 'organization' }] })] })
    );
    expect(cell(m, 'organization', 't:a')).toMatchObject({
      state: 'governed',
      policy: { policyId: 'pol_org' },
    });
  });

  it('lists user and agent subjects under Other subjects, not as columns', () => {
    const p = policy('pol_u', {
      subjects: [
        { type: 'user', id: 'user_1' },
        { type: 'agent', id: 'agt_1' },
        { type: 'role', id: 'member' },
      ],
    });
    const m = buildPermissionsMatrix(input({ policies: [p] }));
    expect(m.otherSubjects.map((o) => [o.subject.type, o.subject.id, o.policy.id])).toEqual([
      ['user', 'user_1', 'pol_u'],
      ['agent', 'agt_1', 'pol_u'],
    ]);
    expect(m.columns.map((c) => c.key)).toEqual(['role:member', 'organization']);
    // Three subjects: editing it changes more than this cell.
    expect(cell(m, 'role:member', 't:a')).toMatchObject({ policy: { soleCell: false } });
  });

  it('shows conflict, with both policies, when two published policies govern one pair', () => {
    const m = buildPermissionsMatrix(input({ policies: [policy('pol_1'), policy('pol_2')] }));
    const c = cell(m, 'role:member', 't:a');
    expect(c.state).toBe('conflict');
    expect(c.state === 'conflict' && c.policies.map((p) => p.policyId)).toEqual(['pol_1', 'pol_2']);
  });

  it('applies targets all to every tool, and such a policy is not a sole cell', () => {
    const m = buildPermissionsMatrix(
      input({ policies: [policy('pol_all', { targets: { tools: 'all' } })] })
    );
    expect(cell(m, 'role:member', 't:b')).toMatchObject({
      state: 'governed',
      policy: { policyId: 'pol_all', soleCell: false },
    });
  });

  it('a draft governs nothing: it is pending on the pairs it covers', () => {
    const draft = policy('pol_d', { state: 'draft', published_at: null, version: 1 });
    const m = buildPermissionsMatrix(input({ policies: [draft] }));
    const c = cell(m, 'role:member', 't:a');
    expect(c.state).toBe('none');
    expect(c.pending).toEqual([{ policyId: 'pol_d', name: 'name of pol_d', version: 1 }]);
  });

  it('marks a pending draft of a published policy once it is known, on the pairs the draft covers', () => {
    const pub = policy('pol_1');
    const pendingVersion = policy('pol_1', {
      version: 4,
      state: 'draft',
      published_at: null,
      targets: { tools: ['t:a', 't:b'] },
    });
    const m = buildPermissionsMatrix(
      input({
        policies: [pub],
        drafts: [{ policyId: 'pol_1', version: 4, neverPublished: false, policy: pendingVersion }],
      })
    );
    expect(cell(m, 'role:member', 't:a')).toMatchObject({
      state: 'governed',
      policy: { version: 3 },
      pending: [{ policyId: 'pol_1', version: 4 }],
    });
    expect(cell(m, 'role:member', 't:b')).toMatchObject({
      state: 'none',
      pending: [{ policyId: 'pol_1', version: 4 }],
    });
  });

  it('keeps an unknown mode flagged, never a decision', () => {
    const m = buildPermissionsMatrix(
      input({ policies: [policy('pol_x', { config: { mode: 'observe' } })] })
    );
    expect(cell(m, 'role:member', 't:a')).toMatchObject({
      policy: { mode: 'observe', modeKnown: false },
    });
  });

  it('places no policy whose targets or state were not stated', () => {
    const m = buildPermissionsMatrix(
      input({
        policies: [
          policy('pol_nt', { targets: undefined }),
          policy('pol_ns', { state: undefined, published_at: undefined }),
        ],
      })
    );
    expect(m.unplaced.map((u) => [u.policy.id, u.reason])).toEqual([
      ['pol_nt', 'targets_not_stated'],
      ['pol_ns', 'state_not_stated'],
    ]);
    expect(cell(m, 'role:member', 't:a').state).toBe('none');
  });

  it('lists a published policy or a draft with the targets that name no listed tool, and keeps its listed cells', () => {
    const pendingDraft = policy('pol_p', {
      version: 4,
      state: 'draft',
      published_at: null,
      targets: { tools: ['t:gone_draft'] },
    });
    const m = buildPermissionsMatrix(
      input({
        policies: [
          policy('pol_part', { targets: { tools: ['t:a', 't:gone', 't:gone_too'] } }),
          policy('pol_all', { targets: { tools: 'all' } }),
          policy('pol_d', {
            state: 'draft',
            published_at: null,
            subjects: [{ type: 'user', id: 'u1' }],
            targets: { tools: ['t:b', 't:gone'] },
          }),
          policy('pol_p', { targets: { tools: ['t:b'] }, subjects: [{ type: 'role', id: 'ops' }] }),
        ],
        drafts: [
          {
            policyId: 'pol_p',
            version: 4,
            neverPublished: false,
            policy: pendingDraft,
          },
        ],
      })
    );
    expect(
      m.unplaced.map((u) => [
        u.policy.id,
        u.policy.version,
        u.reason,
        u.reason === 'target_not_listed' ? u.toolRefs : undefined,
      ])
    ).toEqual([
      ['pol_part', 3, 'target_not_listed', ['t:gone', 't:gone_too']],
      ['pol_d', 3, 'target_not_listed', ['t:gone']],
      ['pol_p', 4, 'target_not_listed', ['t:gone_draft']],
    ]);
    expect(cell(m, 'role:member', 't:a')).toMatchObject({ state: 'conflict' });
  });

  it('lists every named target of a policy when the tool list is empty', () => {
    const m = buildPermissionsMatrix(input({ tools: [], policies: [policy('pol_1')] }));
    expect(m.groups).toEqual([]);
    expect(m.unplaced).toEqual([
      expect.objectContaining({ reason: 'target_not_listed', toolRefs: ['t:a'] }),
    ]);
  });

  it('keeps a withdrawn tool as a row with its governing policy', () => {
    const m = buildPermissionsMatrix(
      input({ tools: [tool('t:a', null, 'withdrawn')], policies: [policy('pol_1')] })
    );
    expect(m.groups[0]?.rows[0]?.tool).toMatchObject({ status: 'withdrawn', statusKnown: true });
    expect(cell(m, 'role:member', 't:a')).toMatchObject({
      state: 'governed',
      policy: { policyId: 'pol_1' },
    });
    expect(m.unplaced).toEqual([]);
  });

  it('groups tools by connection, with names when they were read', () => {
    const m = buildPermissionsMatrix(
      input({
        tools: [tool('t:a', 'conn_1'), tool('t:b'), tool('t:c', 'conn_2'), tool('t:d', 'conn_1')],
        connectionNames: { conn_1: 'Tracker' },
      })
    );
    expect(
      m.groups.map((g) => [g.connectionId, g.name, g.rows.map((r) => r.tool.toolRef)])
    ).toEqual([
      ['conn_1', 'Tracker', ['t:a', 't:d']],
      ['conn_2', undefined, ['t:c']],
      [null, undefined, ['t:b']],
    ]);
  });

  it('makes no composition claim: no cell names a winner or an effective value', () => {
    const m = buildPermissionsMatrix(
      input({
        policies: [
          policy('pol_1'),
          policy('pol_org', { subjects: [{ type: 'organization' }], config: { mode: 'deny' } }),
        ],
      })
    );
    expect(JSON.stringify(m)).not.toMatch(/win|effective|precedence|overrid|reached/i);
  });
});

describe('cellsGovernedBy and subjectKey', () => {
  it('lists every cell a policy governs', () => {
    const m = buildPermissionsMatrix(
      input({
        policies: [
          policy('pol_1', {
            subjects: [{ type: 'role', id: 'member' }, { type: 'organization' }],
            targets: { tools: ['t:a', 't:b'] },
          }),
        ],
      })
    );
    expect(cellsGovernedBy(m, 'pol_1')).toEqual([
      { columnKey: 'role:member', toolRef: 't:a' },
      { columnKey: 'organization', toolRef: 't:a' },
      { columnKey: 'role:member', toolRef: 't:b' },
      { columnKey: 'organization', toolRef: 't:b' },
    ]);
  });

  it('keys a role and the organisation', () => {
    expect(subjectKey({ type: 'role', id: 'member' })).toBe('role:member');
    expect(subjectKey({ type: 'organization' })).toBe('organization');
  });
});
