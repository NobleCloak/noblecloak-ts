/**
 * One test per row of the brief's mapping tables (inputs §3.2 for Cedar, §2.4 for AGT): the statement the
 * row says, its classification (exact, lossy or unsupported) as the export reports it, and an exact model
 * round trip for every row that exports.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { exportAgt } from './agt/export.js';
import { canonicalPolicy } from './canonical.js';
import { diffPolicies } from './diff.js';
import { exportCedar } from './export.js';
import { asExportable, cedar } from './fixtures.test-support.js';
import { importAgt, importCedar } from './import.js';
import type { AgtExportOptions, ExportablePolicy, ExportResult, PolicyWrite } from './types.js';

interface Row {
  readonly row: string;
  readonly policy: Omit<ExportablePolicy, 'id' | 'kind'> & { kind?: PolicyWrite['kind'] };
  readonly opts?: AgtExportOptions;
  /** Text the statement must hold. */
  readonly writes?: readonly string[];
  /** The `lossy` paths below the policy, sorted; omitted means none. */
  readonly lossy?: readonly string[];
  /** The `unsupported` paths below the policy; set means the policy is not exported. */
  readonly unsupported?: readonly string[];
  /** A note the export must carry. */
  readonly note?: RegExp;
}

const ORG = [{ type: 'organization' as const }];
const AGENT = [{ type: 'agent' as const, id: 'a1' }];

function policyOf(row: Row): ExportablePolicy {
  return { id: 'p', kind: 'tool_invocation', ...row.policy };
}

function below(result: ExportResult, which: 'lossy' | 'unsupported'): string[] {
  return result[which].map((entry) => entry.path.replace(/^\/0/, '')).sort();
}

function policySetOf(text: string): string {
  return (parse(text) as { policies: { noblecloak_tool_invocation: { policy_set: string } } })
    .policies.noblecloak_tool_invocation.policy_set;
}

async function checkRow(row: Row, dialect: 'cedar' | 'agt'): Promise<void> {
  const policy = policyOf(row);
  const result = dialect === 'cedar' ? exportCedar([policy]) : exportAgt([policy], [], row.opts);
  expect(below(result, 'unsupported')).toEqual([...(row.unsupported ?? [])].sort());
  if (row.note !== undefined) expect(result.notes.some((note) => row.note?.test(note))).toBe(true);
  if (row.unsupported !== undefined) {
    expect(result.text).not.toContain('@noblecloak_policy("p")');
    return;
  }
  expect(below(result, 'lossy')).toEqual([...(row.lossy ?? [])].sort());
  const statements = dialect === 'cedar' ? result.text : policySetOf(result.text);
  for (const text of row.writes ?? []) expect(statements).toContain(text);
  const imported =
    dialect === 'cedar'
      ? await importCedar(result.text, { cedar })
      : await importAgt(result.text, { cedar });
  expect(imported.policies.map(asExportable).map(canonicalPolicy)).toEqual([
    canonicalPolicy(policy),
  ]);
}

const CEDAR_ROWS: readonly Row[] = [
  {
    row: 'user subject → principal == NobleCloak::User (exact)',
    policy: { subjects: [{ type: 'user', id: 'u1' }], config: { mode: 'deny' } },
    writes: ['principal == NobleCloak::User::"u1"'],
  },
  {
    row: 'agent subject → principal == NobleCloak::Agent (exact)',
    policy: { subjects: AGENT, config: { mode: 'deny' } },
    writes: ['principal == NobleCloak::Agent::"a1"'],
  },
  {
    row: 'service subject → principal == NobleCloak::Service (exact)',
    policy: { subjects: [{ type: 'service', id: 's1' }], config: { mode: 'deny' } },
    writes: ['principal == NobleCloak::Service::"s1"'],
  },
  {
    row: 'role subject → principal in NobleCloak::Role (exact as text; the evaluator needs memberships)',
    policy: { subjects: [{ type: 'role', id: 'member' }], config: { mode: 'deny' } },
    writes: ['principal in NobleCloak::Role::"member"'],
    note: /membership entities/,
  },
  {
    row: 'group subject → principal in NobleCloak::Group (exact as text)',
    policy: { subjects: [{ type: 'group', id: 'g1' }], config: { mode: 'deny' } },
    writes: ['principal in NobleCloak::Group::"g1"'],
    note: /membership entities/,
  },
  {
    row: 'organization subject → unconstrained principal (exact)',
    policy: { subjects: ORG, config: { mode: 'deny' } },
    writes: ['forbid (\n  principal,\n'],
  },
  {
    row: 'one tool → resource == NobleCloak::Tool (exact)',
    policy: { subjects: ORG, targets: { tools: ['t1'] }, config: { mode: 'deny' } },
    writes: ['resource == NobleCloak::Tool::"t1"'],
  },
  {
    row: 'several tools → [..].contains(resource) (exact)',
    policy: { subjects: ORG, targets: { tools: ['t2', 't1'] }, config: { mode: 'deny' } },
    writes: ['    NobleCloak::Tool::"t1",\n    NobleCloak::Tool::"t2"\n  ].contains(resource)'],
  },
  {
    row: 'all tools → unconstrained resource (exact)',
    policy: { subjects: ORG, targets: { tools: 'all' }, config: { mode: 'deny' } },
    writes: ['  resource\n);'],
  },
  {
    row: 'always_allow → permit (exact)',
    policy: { subjects: ORG, config: { mode: 'always_allow' } },
    writes: ['permit ('],
  },
  {
    row: 'deny → forbid (exact)',
    policy: { subjects: ORG, config: { mode: 'deny' } },
    writes: ['forbid ('],
  },
  {
    row: 'ask → forbid, fail closed (lossy on a Cedar engine; exact round trip)',
    policy: { subjects: ORG, config: { mode: 'ask' } },
    writes: ['@noblecloak_mode("ask")', '@noblecloak_encoding("fail_closed")', 'forbid ('],
    lossy: ['/config/mode'],
  },
  {
    row: 'escalate → forbid, fail closed (lossy; exact round trip)',
    policy: { subjects: ORG, config: { mode: 'escalate' } },
    writes: ['@noblecloak_mode("escalate")', '@noblecloak_encoding("fail_closed")', 'forbid ('],
    lossy: ['/config/mode'],
  },
  {
    row: 'not_granted → forbid + @noblecloak_mode (lossy; exact round trip)',
    policy: { subjects: ORG, config: { mode: 'not_granted' } },
    writes: ['@noblecloak_mode("not_granted")', 'forbid ('],
    lossy: ['/config/mode'],
  },
  {
    row: 'on_deny, expires_after, approver_groups → annotations (lossy; exact round trip)',
    policy: {
      subjects: ORG,
      config: { mode: 'ask', on_deny: 'resume', expires_after: 'P1D', approver_groups: ['b', 'a'] },
    },
    writes: [
      '@noblecloak_on_deny("resume")',
      '@noblecloak_expires_after("P1D")',
      '@noblecloak_approver_groups("[\\"b\\",\\"a\\"]")',
    ],
    lossy: ['/config/approver_groups', '/config/expires_after', '/config/mode', '/config/on_deny'],
  },
  {
    row: 'name, description → annotations (exact)',
    policy: { subjects: ORG, name: 'N', description: 'D', config: { mode: 'deny' } },
    writes: ['@noblecloak_name("N")', '@noblecloak_description("D")'],
  },
  {
    row: 'duplicate_requests → unsupported',
    policy: {
      kind: 'duplicate_requests',
      subjects: ORG,
      config: { after_rejection: 'deny', window_seconds: 86400 },
    },
    unsupported: ['/kind'],
  },
  {
    row: 'spending → unsupported',
    policy: { kind: 'spending', subjects: ORG, config: { limit: { amount: 10, currency: 'USD' } } },
    unsupported: ['/kind'],
  },
];

const AGT_ROWS: readonly Row[] = [
  {
    row: 'always_allow → permit (exact)',
    policy: { subjects: AGENT, config: { mode: 'always_allow' } },
    writes: ['permit ('],
  },
  {
    row: 'deny → forbid + @id (exact; the reason on main is the @id)',
    policy: { subjects: AGENT, config: { mode: 'deny' } },
    writes: ['@id("noblecloak.deny:p")', 'forbid ('],
  },
  {
    row: 'ask on main → permit + @advice escalate naming the policy (lossy: one approval path)',
    policy: { subjects: AGENT, config: { mode: 'ask' } },
    opts: { agtVersion: 'main' },
    writes: [
      '@advice("{\\"reason\\":\\"noblecloak.ask:p\\",\\"verdict\\":\\"escalate\\"}")',
      'permit (',
    ],
    lossy: ['/config/mode'],
  },
  {
    row: 'escalate on main → permit + @advice escalate (lossy: routing)',
    policy: { subjects: AGENT, config: { mode: 'escalate' } },
    opts: { agtVersion: 'main' },
    writes: ['"reason\\":\\"noblecloak.escalate:p', 'permit ('],
    lossy: ['/config/mode'],
  },
  {
    row: 'ask on 5.0 → forbid, fail closed (lossy)',
    policy: { subjects: AGENT, config: { mode: 'ask' } },
    writes: ['@noblecloak_encoding("fail_closed")', 'forbid ('],
    lossy: ['/config/mode'],
  },
  {
    row: 'escalate on 5.0 with an advice-aware dispatcher → permit + @advice (lossy)',
    policy: { subjects: AGENT, config: { mode: 'escalate' } },
    opts: { adviceAwareDispatcher: true },
    writes: ['@advice(', 'permit ('],
    lossy: ['/config/mode'],
  },
  {
    row: 'not_granted → forbid + @noblecloak_mode (lossy: the reason)',
    policy: { subjects: AGENT, config: { mode: 'not_granted' } },
    writes: ['@noblecloak_mode("not_granted")', 'forbid ('],
    lossy: ['/config/mode'],
  },
  {
    row: 'on_deny → annotation only (unsupported on the wire: lossy)',
    policy: { subjects: AGENT, config: { mode: 'ask', on_deny: 'halt' } },
    opts: { agtVersion: 'main' },
    writes: ['@noblecloak_on_deny("halt")'],
    lossy: ['/config/mode', '/config/on_deny'],
  },
  {
    row: 'expires_after → annotation only (approval.timeout_seconds is global: lossy)',
    policy: { subjects: AGENT, config: { mode: 'ask', expires_after: 'PT5M' } },
    opts: { agtVersion: 'main' },
    writes: ['@noblecloak_expires_after("PT5M")'],
    lossy: ['/config/expires_after', '/config/mode'],
  },
  {
    row: 'approver_groups → annotation only (lossy)',
    policy: { subjects: AGENT, config: { mode: 'ask', approver_groups: ['ops'] } },
    opts: { agtVersion: 'main' },
    writes: ['@noblecloak_approver_groups("[\\"ops\\"]")'],
    lossy: ['/config/approver_groups', '/config/mode'],
  },
  {
    row: 'agent subject → principal == Agent (exact)',
    policy: { subjects: AGENT, config: { mode: 'deny' } },
    writes: ['principal == Agent::"a1"'],
  },
  {
    row: 'organization subject → unconstrained principal (lossy on a multi-tenant host)',
    policy: { subjects: ORG, config: { mode: 'deny' } },
    writes: ['forbid (\n  principal,\n'],
    lossy: ['/subjects'],
  },
  ...(['user', 'role', 'group', 'service'] as const).map((type): Row => ({
    row: `${type} subject → unsupported (AGT has no end-user principal)`,
    policy: { subjects: [{ type, id: 'x' }], config: { mode: 'deny' } },
    unsupported: ['/subjects/0'],
  })),

  {
    row: 'one tool → resource == Tool, the tool_ref verbatim by default (with a note)',
    policy: { subjects: AGENT, targets: { tools: ['mcp:c:s:send'] }, config: { mode: 'deny' } },
    writes: ['resource == Tool::"mcp:c:s:send"'],
    note: /tool_refs verbatim/,
  },
  {
    row: 'one tool with a toolNames map → resource == Tool::"<name>"',
    policy: { subjects: AGENT, targets: { tools: ['mcp:c:s:send'] }, config: { mode: 'deny' } },
    opts: { toolNames: { 'mcp:c:s:send': 'send' } },
    writes: ['resource == Tool::"send"'],
    note: /follow the toolNames map/,
  },
  {
    row: 'several tools → [..].contains(resource) (exact)',
    policy: { subjects: AGENT, targets: { tools: ['b', 'a'] }, config: { mode: 'deny' } },
    writes: ['    Tool::"a",\n    Tool::"b"\n  ].contains(resource)'],
  },
  {
    row: 'all tools → unconstrained resource (exact)',
    policy: { subjects: AGENT, config: { mode: 'deny' } },
    writes: ['  resource\n);'],
  },
  {
    row: 'several subjects → one statement per subject, grouped by @noblecloak_policy',
    policy: {
      subjects: [
        { type: 'agent', id: 'a2' },
        { type: 'agent', id: 'a1' },
      ],
      config: { mode: 'deny' },
    },
    writes: ['principal == Agent::"a1"', 'principal == Agent::"a2"'],
  },
  {
    row: 'name, description → annotations',
    policy: { subjects: AGENT, name: 'N', description: 'D', config: { mode: 'deny' } },
    writes: ['@noblecloak_name("N")', '@noblecloak_description("D")'],
  },
  {
    row: 'no matching policy → nothing emitted; the export says the engine denies',
    policy: { subjects: AGENT, config: { mode: 'always_allow' } },
    note: /denied by the target engine/,
  },
  {
    row: 'duplicate_requests → unsupported',
    policy: {
      kind: 'duplicate_requests',
      subjects: ORG,
      config: { after_rejection: 'ask_again', window_seconds: 600 },
    },
    unsupported: ['/kind'],
  },
  {
    row: 'spending → unsupported',
    policy: { kind: 'spending', subjects: ORG, config: { limit: { amount: 1, currency: 'EUR' } } },
    unsupported: ['/kind'],
  },
];

describe('Cedar mapping (inputs §3.2)', () => {
  for (const row of CEDAR_ROWS) it(row.row, () => checkRow(row, 'cedar'));
});

describe('AGT mapping (inputs §2.4)', () => {
  for (const row of AGT_ROWS) it(row.row, () => checkRow(row, 'agt'));

  it('a policy with a subject AGT cannot express is exported for the others, each dropped subject reported', async () => {
    const deny: ExportablePolicy = {
      id: 'deny_send',
      kind: 'tool_invocation',
      subjects: [
        { type: 'agent', id: 'a' },
        { type: 'user', id: 'u' },
      ],
      targets: { tools: ['send'] },
      config: { mode: 'deny' },
    };
    const allowAll: ExportablePolicy = {
      id: 'allow_all',
      kind: 'tool_invocation',
      subjects: [{ type: 'organization' }],
      config: { mode: 'always_allow' },
    };
    const result = exportAgt([allowAll, deny], [{ tool_ref: 'send' }], { agtVersion: 'main' });
    expect(result.unsupported.map((entry) => [entry.path, entry.policy])).toEqual([
      ['/1/subjects/1', 'deny_send'],
    ]);
    expect(result.unsupported[0]?.reason).toContain('the user subject "u" is not exported');
    expect(result.text).toContain(
      '# Not exported: policy "deny_send" /subjects/1: the user subject "u"'
    );
    const policySet = policySetOf(result.text);
    expect(policySet).toContain('forbid (\n  principal == Agent::"a",');
    expect(policySet).not.toContain('"u"');
    // The org-wide allow no longer lets agent a through: the narrowed deny is there.
    const answer = cedar.isAuthorized({
      principal: { type: 'Agent', id: 'a' },
      action: { type: 'Action', id: 'pre_tool_call' },
      resource: { type: 'Tool', id: 'send' },
      context: {},
      policies: { staticPolicies: policySet },
      entities: [],
    });
    expect(answer.type === 'success' && answer.response.decision).toBe('deny');
    // Re-importing it is reported as a change against the original, never silently equal.
    const imported = await importAgt(result.text, { cedar });
    const back = imported.policies.find((policy) => policy.key === 'deny_send');
    expect(back?.write.subjects).toEqual([{ type: 'agent', id: 'a' }]);
    expect(back && canonicalPolicy(back.write)).not.toBe(canonicalPolicy(deny));
    expect(back && diffPolicies(deny, back.write)).toEqual([
      { path: '/subjects', op: 'remove', before: { type: 'user', id: 'u' } },
    ]);
  });

  it('a policy with no subject AGT can express is not exported, and every subject is reported', () => {
    const result = exportAgt(
      [
        {
          id: 'p',
          kind: 'tool_invocation',
          subjects: [
            { type: 'user', id: 'u' },
            { type: 'role', id: 'r' },
          ],
          config: { mode: 'deny' },
        },
      ],
      []
    );
    expect(result.unsupported.map((entry) => entry.path)).toEqual([
      '/0/subjects/0',
      '/0/subjects/1',
    ]);
    expect(result.unsupported[0]?.reason).toContain(
      'the policy has no other subject, so it is not exported'
    );
    expect(policySetOf(result.text)).not.toContain('@noblecloak_policy("p")');
  });

  it("tightest-wins across policies: Cedar's forbid overrides the permits of ask and always_allow", () => {
    const { text } = exportAgt(
      [
        { id: 'a', kind: 'tool_invocation', subjects: AGENT, config: { mode: 'always_allow' } },
        { id: 'b', kind: 'tool_invocation', subjects: AGENT, config: { mode: 'ask' } },
        { id: 'c', kind: 'tool_invocation', subjects: AGENT, config: { mode: 'deny' } },
      ],
      [],
      { agtVersion: 'main' }
    );
    const request = {
      principal: { type: 'Agent', id: 'a1' },
      action: { type: 'Action', id: 'pre_tool_call' },
      resource: { type: 'Tool', id: 't' },
      context: {},
    };
    const answer = cedar.isAuthorized({
      ...request,
      policies: { staticPolicies: policySetOf(text) },
      entities: [],
    });
    expect(answer.type === 'success' && answer.response.decision).toBe('deny');
    // Without the deny, the call is allowed by Cedar and the ask statement contributes, so AGT main
    // reads its @advice and escalates (needs approval beats allow).
    const { text: noDeny } = exportAgt(
      [
        { id: 'a', kind: 'tool_invocation', subjects: AGENT, config: { mode: 'always_allow' } },
        { id: 'b', kind: 'tool_invocation', subjects: AGENT, config: { mode: 'ask' } },
      ],
      [],
      { agtVersion: 'main' }
    );
    const allowed = cedar.isAuthorized({
      ...request,
      policies: { staticPolicies: policySetOf(noDeny) },
      entities: [],
    });
    expect(allowed.type === 'success' && allowed.response.decision).toBe('allow');
    expect(allowed.type === 'success' && allowed.response.diagnostics.reason).toContain('policy1');
    expect(policySetOf(noDeny).split('\n\n')[1]).toContain('@advice(');
  });

  it('every approval requirement met: with two approval policies on main the export notes that one reaches the resolver; not on 5.0', () => {
    const two: ExportablePolicy[] = [
      { id: 'x', kind: 'tool_invocation', subjects: AGENT, config: { mode: 'ask' } },
      { id: 'y', kind: 'tool_invocation', subjects: AGENT, config: { mode: 'escalate' } },
    ];
    const note = (opts: AgtExportOptions): boolean =>
      exportAgt(two, [], opts).notes.some((text) =>
        text.startsWith('AGT passes one escalate reason')
      );
    expect(note({ agtVersion: 'main' })).toBe(true);
    expect(note({})).toBe(false);
  });
});
