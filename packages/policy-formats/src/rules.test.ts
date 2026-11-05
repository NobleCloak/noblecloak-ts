/**
 * Rev 16 rules, approvers and exclude in Cedar and AGT: the statement encodes the policy's tightest
 * reachable outcome, the members ride verbatim in annotations, and the import restores the policy exactly
 * or reports a conflict.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { exportAgt } from './agt/export.js';
import { canonicalPolicy, normalizePolicy } from './canonical.js';
import { diffPolicies } from './diff.js';
import { exportCedar } from './export.js';
import { asExportable, cedar } from './fixtures.test-support.js';
import { importAgt, importCedar } from './import.js';
import { canAskOnMissingFact, tightestOutcome } from './rules.js';
import { AGT_CEDAR_SCHEMA, NOBLECLOAK_CEDAR_SCHEMA } from './schemas.js';
import type { ExportablePolicy, ToolInvocationConfig } from './types.js';

type Rules = NonNullable<ToolInvocationConfig['rules']>;
type Condition = Rules[number]['when'][number];

const ORG = [{ type: 'organization' as const }];

function policy(config: ToolInvocationConfig, id = 'p'): ExportablePolicy {
  return { id, kind: 'tool_invocation', subjects: ORG, targets: { tools: ['t1'] }, config };
}

const GT: Condition = { fact: 'amount', op: 'gt', value: 100 };
const EXISTS: Condition = { fact: 'approved_by', op: 'exists' };

/** One condition per op: the mapping must carry each verbatim. */
const OPS: readonly Condition[] = [
  { fact: 'currency', op: 'eq', value: 'usd' },
  { fact: 'currency', op: 'ne', value: null },
  { fact: 'region', op: 'in', value: ['eu', 'us', 3, true] },
  { fact: 'region', op: 'not_in', value: ['cn'] },
  { fact: 'amount', op: 'gt', value: 100.5 },
  { fact: 'amount', op: 'gte', value: 100 },
  { fact: 'lines', op: 'lt', value: 3 },
  { fact: 'lines', op: 'lte', value: 0 },
  EXISTS,
];

function rulesOf(value: ExportablePolicy | undefined): Rules | undefined {
  return (value?.config as ToolInvocationConfig | undefined)?.rules;
}

function policySetOf(text: string): string {
  return (parse(text) as { policies: { noblecloak_tool_invocation: { policy_set: string } } })
    .policies.noblecloak_tool_invocation.policy_set;
}

function validationErrors(text: string, schema: string): string[] {
  const answer = cedar.validate({ schema, policies: { staticPolicies: text } });
  if (answer.type === 'failure') return answer.errors.map((error) => error.message);
  return [
    ...answer.validationErrors.map((error) => error.error.message),
    ...answer.validationWarnings.map((error) => error.error.message),
  ];
}

async function cedarBack(policies: ExportablePolicy[]): Promise<ExportablePolicy[]> {
  const imported = await importCedar(exportCedar(policies).text, { cedar });
  expect(imported.unsupported).toEqual([]);
  expect(imported.conflicts).toEqual([]);
  return imported.policies.map(asExportable);
}

async function agtBack(
  policies: ExportablePolicy[],
  opts: Parameters<typeof exportAgt>[2] = {}
): Promise<ExportablePolicy[]> {
  const imported = await importAgt(exportAgt(policies, [], opts).text, { cedar });
  expect(imported.unsupported).toEqual([]);
  expect(imported.conflicts).toEqual([]);
  return imported.policies.map(asExportable);
}

describe('canAskOnMissingFact', () => {
  it('is true only when some condition is not exists', () => {
    expect(canAskOnMissingFact(undefined)).toBe(false);
    expect(canAskOnMissingFact([{ when: [EXISTS], then: 'ask' }])).toBe(false);
    expect(canAskOnMissingFact([{ when: [EXISTS, GT], then: 'ask' }])).toBe(true);
  });
});

describe('tightestOutcome', () => {
  const rule = (then: 'always_allow' | 'ask' | 'deny', ...when: Condition[]): Rules[number] => ({
    when,
    then,
  });
  const cases: [string, ToolInvocationConfig['mode'], Rules | undefined, string][] = [
    ['no rules: the mode', 'escalate', undefined, 'escalate'],
    [
      'a rule that only loosens, on exists, leaves the mode',
      'ask',
      [rule('always_allow', EXISTS)],
      'ask',
    ],
    [
      'a looser mode with a non-exists condition: a missing fact asks',
      'always_allow',
      [rule('always_allow', GT)],
      'ask',
    ],
    [
      'exists is never unevaluable: no ask from it',
      'always_allow',
      [rule('always_allow', EXISTS)],
      'always_allow',
    ],
    [
      'any condition of the rule can be unevaluable',
      'always_allow',
      [rule('always_allow', EXISTS, GT)],
      'ask',
    ],
    ['a deny rule is the tightest', 'always_allow', [rule('deny', EXISTS)], 'deny'],
    [
      'a later deny beats an earlier ask',
      'always_allow',
      [rule('ask', EXISTS), rule('deny', EXISTS)],
      'deny',
    ],
    ['equal rank keeps the mode: escalate over ask', 'escalate', [rule('ask', EXISTS)], 'escalate'],
    [
      'equal rank keeps the mode: not_granted over deny',
      'not_granted',
      [rule('deny', EXISTS)],
      'not_granted',
    ],
    [
      'equal rank keeps the earliest: ask over escalate',
      'always_allow',
      [rule('ask', EXISTS)],
      'ask',
    ],
    ['deny mode stays deny', 'deny', [rule('ask', GT), rule('always_allow', EXISTS)], 'deny'],
  ];
  for (const [label, mode, rules, expected] of cases)
    it(label, () => {
      expect(tightestOutcome(mode, rules)).toBe(expected);
    });
});

describe('Cedar: the statement encodes the tightest outcome', () => {
  const rows: {
    label: string;
    config: ToolInvocationConfig;
    outcome: string;
    effect: 'permit' | 'forbid';
  }[] = [
    {
      label: 'always_allow with a rule over a fact asks',
      config: { mode: 'always_allow', rules: [{ when: [GT], then: 'always_allow' }] },
      outcome: 'ask',
      effect: 'forbid',
    },
    {
      label: 'always_allow with an exists-only loosening rule stays a permit',
      config: { mode: 'always_allow', rules: [{ when: [EXISTS], then: 'always_allow' }] },
      outcome: 'always_allow',
      effect: 'permit',
    },
    {
      label: 'always_allow with an exists rule that asks',
      config: { mode: 'always_allow', rules: [{ when: [EXISTS], then: 'ask' }] },
      outcome: 'ask',
      effect: 'forbid',
    },
    {
      label: 'ask with a deny rule is a deny',
      config: { mode: 'ask', rules: [{ when: [EXISTS], then: 'deny' }] },
      outcome: 'deny',
      effect: 'forbid',
    },
    {
      label: 'escalate keeps escalate against an ask rule',
      config: { mode: 'escalate', rules: [{ when: [EXISTS], then: 'ask' }] },
      outcome: 'escalate',
      effect: 'forbid',
    },
    {
      label: 'not_granted keeps not_granted against a deny rule',
      config: { mode: 'not_granted', rules: [{ when: [EXISTS], then: 'deny' }] },
      outcome: 'not_granted',
      effect: 'forbid',
    },
    {
      label: 'deny with loosening rules is still a deny',
      config: { mode: 'deny', rules: [{ when: [GT], then: 'always_allow' }] },
      outcome: 'deny',
      effect: 'forbid',
    },
  ];
  for (const { label, config, outcome, effect } of rows)
    it(`${label}: ${effect}, @id names ${outcome}, and the policy round-trips exactly`, async () => {
      const original = policy(config);
      const { text, lossy } = exportCedar([original]);
      expect(text).toContain(`${effect} (`);
      expect(text).toContain(`@id("noblecloak.${outcome}:p")`);
      expect(text).toContain(`@noblecloak_mode("${config.mode}")`);
      expect(text).toContain('@noblecloak_encoding("rules_tightest")');
      expect(text).not.toContain('fail_closed');
      expect(lossy.some((entry) => entry.path === '/0/config/rules')).toBe(true);
      const [back] = await cedarBack([original]);
      expect(back && canonicalPolicy(back)).toBe(canonicalPolicy(original));
      // Re-exporting what was imported writes the same bytes.
      expect(back).toBeDefined();
      if (back !== undefined) expect(exportCedar([back]).text).toBe(text);
    });

  it('the rules marker takes the place of fail_closed when the outcome is ask: one annotation, and the plain ask policy keeps fail_closed', async () => {
    const withRules = policy({ mode: 'ask', rules: [{ when: [EXISTS], then: 'ask' }] });
    const plain = policy({ mode: 'ask' }, 'q');
    const text = exportCedar([withRules, plain]).text;
    expect(text.match(/@noblecloak_encoding\("rules_tightest"\)/g)).toHaveLength(1);
    expect(text.match(/@noblecloak_encoding\("fail_closed"\)/g)).toHaveLength(1);
    expect(text.match(/@noblecloak_encoding/g)).toHaveLength(2);
    const back = await cedarBack([withRules, plain]);
    expect(back.map(canonicalPolicy)).toEqual([withRules, plain].map(canonicalPolicy));
  });

  for (const condition of OPS)
    it(`the ${condition.op} condition is carried verbatim, and a ${condition.op === 'exists' ? 'loosening exists rule leaves the permit' : 'missing fact makes the statement ask'}`, async () => {
      const original = policy({
        mode: 'always_allow',
        rules: [{ when: [condition], then: 'always_allow' }],
      });
      const { text } = exportCedar([original]);
      expect(text).toContain(condition.op === 'exists' ? 'permit (' : 'forbid (');
      const [back] = await cedarBack([original]);
      expect(rulesOf(back)).toEqual(rulesOf(original));
      expect(back && canonicalPolicy(back)).toBe(canonicalPolicy(original));
    });

  it('keeps rule order, rule approvers, policy approvers and exclude exactly', async () => {
    const original = policy({
      mode: 'ask',
      approver_groups: ['finance'],
      rules: [
        {
          when: [GT, { fact: 'region', op: 'in', value: ['eu', 'us'] }],
          then: 'ask',
          approvers: [{ role: 'cfo' }, { user: 'usr_1', when: [GT] }],
        },
        { when: [EXISTS], then: 'always_allow' },
        { when: [{ fact: 'amount', op: 'lte', value: 1 }], then: 'deny' },
      ],
      approvers: [{ role: 'finance', when: [EXISTS] }, { user: 'usr_2' }],
      exclude: ['requester'],
    });
    const [back] = await cedarBack([original]);
    expect(back?.config).toEqual(original.config);
    expect(rulesOf(back)?.map((rule) => rule.then)).toEqual(['ask', 'always_allow', 'deny']);
  });

  it('reports each member as lossy, with the member path and the sentence about the tightest outcome and missing facts', () => {
    const { lossy } = exportCedar([
      policy({
        mode: 'always_allow',
        rules: [{ when: [GT], then: 'always_allow' }],
        approvers: [{ role: 'finance' }],
        exclude: ['requester'],
      }),
    ]);
    const byPath = new Map(lossy.map((entry) => [entry.path, entry.reason]));
    for (const member of ['rules', 'approvers', 'exclude']) {
      const reason = byPath.get(`/0/config/${member}`);
      expect(reason, member).toContain(`@noblecloak_${member}`);
      expect(reason, member).toContain("applies only the statement's outcome (ask, the tightest");
      expect(reason, member).toContain('not the per-call rules');
      expect(reason, member).toContain('asks where a fact of the call has no value');
    }
    expect(byPath.get('/0/config/mode')).toContain(
      'the statement encodes the tightest outcome of the rules, not the configured mode'
    );
  });

  it('the missing-fact sentence is only for rules that test a fact other than by exists', () => {
    const reasons = (rules: Rules): string[] =>
      exportCedar([policy({ mode: 'always_allow', rules, approvers: [{ role: 'r' }] })])
        .lossy.map((entry) => entry.reason)
        .filter((reason) => reason.includes('not the per-call rules'));
    const existsOnly = reasons([{ when: [EXISTS], then: 'always_allow' }]);
    expect(existsOnly).toHaveLength(2);
    expect(existsOnly.some((reason) => reason.includes('no value'))).toBe(false);
    const mixed = reasons([
      { when: [EXISTS], then: 'always_allow' },
      { when: [EXISTS, GT], then: 'always_allow' },
    ]);
    expect(mixed).toHaveLength(2);
    expect(mixed.every((reason) => reason.includes('no value'))).toBe(true);
  });

  it('approvers and exclude without rules: no marker, no outcome change, a plain not-enforced entry', async () => {
    const original = policy({
      mode: 'ask',
      approvers: [{ role: 'finance' }],
      exclude: ['requester'],
    });
    const result = exportCedar([original]);
    expect(result.text).toContain('@noblecloak_approvers(');
    expect(result.text).toContain('@noblecloak_encoding("fail_closed")');
    expect(result.text).not.toContain('rules_tightest');
    const reasons = Object.fromEntries(result.lossy.map((entry) => [entry.path, entry.reason]));
    expect(reasons['/0/config/approvers']).toBe(
      'kept in @noblecloak_approvers only; a Cedar engine does not enforce it'
    );
    expect(reasons['/0/config/exclude']).toBe(
      'kept in @noblecloak_exclude only; a Cedar engine does not enforce it'
    );
    const [back] = await cedarBack([original]);
    expect(back && canonicalPolicy(back)).toBe(canonicalPolicy(original));
  });

  it('approvers and exclude on a deny policy are legal, kept and restored', async () => {
    const original = policy({ mode: 'deny', approvers: [{ user: 'u' }], exclude: ['requester'] });
    expect(exportCedar([original]).unsupported).toEqual([]);
    const [back] = await cedarBack([original]);
    expect(back?.config).toEqual(original.config);
  });

  it('the export validates against the NobleCloak schema, with no warning', () => {
    const policies = OPS.map((condition, index) =>
      policy(
        { mode: 'always_allow', rules: [{ when: [condition], then: 'deny' }] },
        `p${String(index)}`
      )
    );
    expect(validationErrors(exportCedar(policies).text, NOBLECLOAK_CEDAR_SCHEMA)).toEqual([]);
  });
});

describe('Cedar import: a body that disagrees with the rules is a conflict', () => {
  const original = policy({
    mode: 'always_allow',
    rules: [{ when: [GT], then: 'ask' }],
    approvers: [{ role: 'finance' }],
  });
  const text = exportCedar([original]).text;

  async function conflictOf(edited: string): Promise<string[]> {
    expect(edited).not.toBe(text);
    const imported = await importCedar(edited, { cedar });
    expect(imported.policies).toEqual([]);
    return imported.conflicts.map((entry) => entry.reason);
  }

  it('a body loosened to permit', async () => {
    const [reason] = await conflictOf(text.replace(/^forbid \(/m, 'permit ('));
    expect(reason).toContain('the body permits the call and the tightest outcome');
    expect(reason).toContain('is ask');
  });

  it('a rules list edited to be tighter than the body', async () => {
    const edited = text.replace(
      /@noblecloak_rules\("(?:[^"\\]|\\.)*"\)/,
      '@noblecloak_rules("[{\\"then\\":\\"deny\\",\\"when\\":[{\\"fact\\":\\"amount\\",\\"op\\":\\"exists\\"}]}]")'
    );
    const [reason] = await conflictOf(edited);
    expect(reason).toContain('@id is not "noblecloak.deny:p"');
  });

  it('a rules list edited so the recomputed outcome is always_allow but the body forbids', async () => {
    const edited = text.replace(
      /@noblecloak_rules\("(?:[^"\\]|\\.)*"\)/,
      '@noblecloak_rules("[{\\"then\\":\\"always_allow\\",\\"when\\":[{\\"fact\\":\\"amount\\",\\"op\\":\\"exists\\"}]}]")'
    );
    const [reason] = await conflictOf(edited);
    expect(reason).toContain('the body forbids the call and the tightest outcome');
    expect(reason).toContain('is always_allow');
  });

  it('the marker without rules', async () => {
    const [reason] = await conflictOf(
      exportCedar([policy({ mode: 'deny' })]).text.replace(
        '@id(',
        '@noblecloak_encoding("rules_tightest")\n@id('
      )
    );
    expect(reason).toContain('without @noblecloak_rules');
  });

  it('rules without the marker', async () => {
    const [reason] = await conflictOf(text.replace('@noblecloak_encoding("rules_tightest")\n', ''));
    expect(reason).toContain('without @noblecloak_encoding("rules_tightest")');
  });

  it('rules marked fail_closed instead', async () => {
    const [reason] = await conflictOf(text.replace('rules_tightest', 'fail_closed'));
    expect(reason).toContain('without @noblecloak_encoding("rules_tightest")');
  });

  it('rules without @noblecloak_mode', async () => {
    const [reason] = await conflictOf(text.replace('@noblecloak_mode("always_allow")\n', ''));
    expect(reason).toContain('needs @noblecloak_mode');
  });

  it('a stale @id', async () => {
    const [reason] = await conflictOf(
      text.replace('noblecloak.ask:p', 'noblecloak.always_allow:p')
    );
    expect(reason).toContain('@id is not "noblecloak.ask:p"');
  });

  it('rules that are not valid rules are unsupported, not imported', async () => {
    const edited = text.replace(
      /@noblecloak_rules\("(?:[^"\\]|\\.)*"\)/,
      '@noblecloak_rules("[{\\"then\\":\\"maybe\\",\\"when\\":[]}]")'
    );
    const imported = await importCedar(edited, { cedar });
    expect(imported.policies).toEqual([]);
    expect(imported.unsupported.map((entry) => entry.reason).join('\n')).toContain(
      '@noblecloak_rules is not valid at /0/when'
    );
  });

  it('approvers and exclude that are not JSON, or not valid, are unsupported', async () => {
    const plain = exportCedar([
      policy({ mode: 'deny', approvers: [{ role: 'r' }], exclude: ['requester'] }),
    ]).text;
    const broken = plain
      .replace(/@noblecloak_approvers\("(?:[^"\\]|\\.)*"\)/, '@noblecloak_approvers("nope")')
      .replace(
        /@noblecloak_exclude\("(?:[^"\\]|\\.)*"\)/,
        '@noblecloak_exclude("[\\"everyone\\"]")'
      );
    const imported = await importCedar(broken, { cedar });
    expect(imported.policies).toEqual([]);
    const reasons = imported.unsupported.map((entry) => entry.reason);
    expect(reasons).toContain('@noblecloak_approvers is not JSON');
    expect(reasons.some((reason) => reason.startsWith('@noblecloak_exclude is not valid'))).toBe(
      true
    );
  });
});

describe('AGT: the same encoding, under both approval encodings', () => {
  const original = policy({
    mode: 'always_allow',
    rules: [{ when: [GT], then: 'always_allow' }],
    approvers: [{ role: 'finance' }],
    exclude: ['requester'],
  });

  it('advice-aware (main): a tightest outcome of ask is a permit carrying @advice escalate named for ask, and round-trips', async () => {
    const result = exportAgt([original], [], { agtVersion: 'main' });
    const set = policySetOf(result.text);
    expect(set).toContain('permit (');
    expect(set).toContain('@advice(');
    expect(set).toContain('noblecloak.ask:p');
    expect(set).toContain('@noblecloak_encoding("rules_tightest")');
    expect(result.lossy.map((entry) => entry.path).sort()).toEqual([
      '/0/config/approvers',
      '/0/config/exclude',
      '/0/config/mode',
      '/0/config/rules',
      '/0/subjects',
    ]);
    const [back] = await agtBack([original], { agtVersion: 'main' });
    expect(back && canonicalPolicy(back)).toBe(canonicalPolicy(original));
    const imported = await importAgt(result.text, { cedar });
    expect(imported.options.adviceAwareDispatcher).toBeUndefined();
  });

  it('not advice-aware (main, adviceAwareDispatcher false): the same outcome is a fail-closed forbid, and the import still reads advice-less', async () => {
    const result = exportAgt([original], [], { agtVersion: 'main', adviceAwareDispatcher: false });
    const set = policySetOf(result.text);
    expect(set).toContain('forbid (');
    expect(set).not.toContain('@advice');
    const imported = await importAgt(result.text, { cedar });
    expect(imported.conflicts).toEqual([]);
    expect(imported.policies.map(asExportable).map(canonicalPolicy)).toEqual([
      canonicalPolicy(original),
    ]);
    // The approval encoding is read from the body: a fail-closed forbid differs from main's default.
    expect(imported.options.adviceAwareDispatcher).toBe(false);
  });

  it('a tightest outcome of always_allow stays a permit with no advice', async () => {
    const loose = policy({
      mode: 'always_allow',
      rules: [{ when: [EXISTS], then: 'always_allow' }],
    });
    const set = policySetOf(exportAgt([loose], [], { agtVersion: 'main' }).text);
    expect(set).toContain('permit (');
    expect(set).not.toContain('@advice');
    expect((await agtBack([loose], { agtVersion: 'main' }))[0]?.config).toEqual(loose.config);
  });

  it('every op round-trips through AGT', async () => {
    const policies = OPS.map((condition, index) =>
      policy(
        { mode: 'ask', rules: [{ when: [condition], then: 'always_allow' }] },
        `p${String(index)}`
      )
    );
    for (const opts of [{ agtVersion: 'main' as const }, {}]) {
      const back = await agtBack(policies, opts);
      expect(back.map(canonicalPolicy).sort()).toEqual(policies.map(canonicalPolicy).sort());
    }
  });

  it('a rules statement whose @advice names another outcome is a conflict', async () => {
    // Only the @advice reason changes: @id still names the outcome, so the advice check alone catches it.
    const text = exportAgt([original], [], { agtVersion: 'main' }).text.replace(
      /(@advice\(.*)noblecloak\.ask:p/,
      '$1noblecloak.escalate:p'
    );
    expect(text).toContain('@id("noblecloak.ask:p")');
    const imported = await importAgt(text, { cedar });
    expect(imported.policies).toEqual([]);
    expect(imported.conflicts.map((entry) => entry.reason).join('\n')).toContain(
      'the @advice reason names escalate and the tightest outcome'
    );
  });

  it('a permit with @advice whose recomputed outcome is deny is a conflict, not an import of the annotations', async () => {
    // Mode, @id and the @advice reason all say deny; only the @advice on an outcome that cannot ask differs.
    const text = exportAgt([original], [], { agtVersion: 'main' })
      .text.replace('@noblecloak_mode("always_allow")', '@noblecloak_mode("deny")')
      .replaceAll('noblecloak.ask:p', 'noblecloak.deny:p');
    const imported = await importAgt(text, { cedar });
    expect(imported.policies).toEqual([]);
    expect(imported.conflicts.map((entry) => entry.reason).join('\n')).toContain(
      '@advice escalate is on a statement whose tightest outcome'
    );
  });

  it('a rules forbid that carries @advice is a conflict', async () => {
    const text = exportAgt([original], [], {
      agtVersion: 'main',
      adviceAwareDispatcher: false,
    }).text.replace(
      '@id("noblecloak.ask:p")',
      '@id("noblecloak.ask:p")\n      @advice("{\\"reason\\":\\"noblecloak.ask:p\\",\\"verdict\\":\\"escalate\\"}")'
    );
    expect(text).toContain('@advice(');
    expect(text).toContain('forbid (');
    const imported = await importAgt(text, { cedar });
    expect(imported.policies).toEqual([]);
    expect(imported.conflicts.map((entry) => entry.reason).join('\n')).toContain(
      '@advice is on a forbid'
    );
  });

  it('the AGT export validates against the AGT schema', () => {
    const policies = OPS.map((condition, index) => ({
      ...policy(
        { mode: 'always_allow', rules: [{ when: [condition], then: 'deny' }] },
        `p${String(index)}`
      ),
      subjects: [{ type: 'agent' as const, id: 'a1' }],
    }));
    const set = policySetOf(exportAgt(policies, [], { agtVersion: 'main' }).text);
    expect(validationErrors(set, AGT_CEDAR_SCHEMA)).toEqual([]);
  });
});

describe('approval_routing and invalid rev 16 members', () => {
  it('approval_routing is unsupported with a reason that says why, in both formats', () => {
    const routing = {
      id: 'r',
      kind: 'approval_routing',
      subjects: ORG,
      config: { org_admin_break_glass: false },
    } as unknown as ExportablePolicy;
    for (const result of [exportCedar([routing]), exportAgt([routing], [])]) {
      expect(result.unsupported).toHaveLength(1);
      expect(result.unsupported[0]?.path).toBe('/0/kind');
      expect(result.unsupported[0]?.reason).toContain('organisation setting');
      expect(result.unsupported[0]?.reason).toContain('not a policy on a call');
      expect(result.text).not.toContain('@noblecloak_policy("r")');
    }
  });

  const bad: [string, unknown, string][] = [
    ['rules is empty', [], '/config/rules'],
    ['a rule has an unknown outcome', [{ when: [GT], then: 'maybe' }], '/config/rules/0/then'],
    [
      'approvers on a deny rule',
      [{ when: [GT], then: 'deny', approvers: [{ role: 'r' }] }],
      '/config/rules/0/approvers',
    ],
    ['a rule without conditions', [{ when: [], then: 'ask' }], '/config/rules/0/when'],
    [
      'nine conditions',
      [{ when: Array.from({ length: 9 }, () => GT), then: 'ask' }],
      '/config/rules/0/when',
    ],
    [
      'an unknown op',
      [{ when: [{ fact: 'a', op: 'like', value: 'x' }], then: 'ask' }],
      '/config/rules/0/when/0/op',
    ],
    [
      'a bad fact name',
      [{ when: [{ fact: 'Amount', op: 'exists' }], then: 'ask' }],
      '/config/rules/0/when/0/fact',
    ],
    [
      'exists with a value',
      [{ when: [{ fact: 'a', op: 'exists', value: 1 }], then: 'ask' }],
      '/config/rules/0/when/0/value',
    ],
    [
      'gt with a string',
      [{ when: [{ fact: 'a', op: 'gt', value: '1' }], then: 'ask' }],
      '/config/rules/0/when/0/value',
    ],
    [
      'in with an empty list',
      [{ when: [{ fact: 'a', op: 'in', value: [] }], then: 'ask' }],
      '/config/rules/0/when/0/value',
    ],
    [
      'eq with an object',
      [{ when: [{ fact: 'a', op: 'eq', value: {} }], then: 'ask' }],
      '/config/rules/0/when/0/value',
    ],
    [
      'an unpaired surrogate in a value',
      [{ when: [{ fact: 'a', op: 'eq', value: '\ud800' }], then: 'ask' }],
      '/config/rules/0/when/0/value',
    ],
    ['an unknown rule member', [{ when: [GT], then: 'ask', note: 'x' }], '/config/rules/0/note'],
  ];
  for (const [label, rules, path] of bad)
    it(`${label}: unsupported at ${path}, not exported`, () => {
      const result = exportCedar([policy({ mode: 'ask', rules: rules as Rules })]);
      expect(result.unsupported.map((entry) => entry.path)).toContain(`/0${path}`);
      expect(result.text).not.toContain('@noblecloak_policy("p")');
    });

  const ok = (value: Partial<Condition>): Condition => ({
    fact: 'a',
    op: 'eq',
    value: 1,
    ...value,
  });
  const bad2: [string, ToolInvocationConfig, string][] = [
    [
      'a condition with an extra member',
      { mode: 'ask', rules: [{ when: [{ ...GT, extra: 1 } as Condition], then: 'ask' }] },
      '/config/rules/0/when/0/extra',
    ],
    [
      'an approver with an extra member',
      { mode: 'ask', approvers: [{ role: 'r', extra: 1 } as never] },
      '/config/approvers/0/extra',
    ],
    [
      'an approver whose when is invalid',
      { mode: 'ask', approvers: [{ role: 'r', when: [{ fact: 'A', op: 'exists' }] }] },
      '/config/approvers/0/when/0/fact',
    ],
    [
      'an unpaired surrogate in an in list',
      {
        mode: 'ask',
        rules: [{ when: [ok({ op: 'in', value: ['a', '\ud800'] })], then: 'ask' }],
      },
      '/config/rules/0/when/0/value/1',
    ],
    [
      '101 values in an in list',
      {
        mode: 'ask',
        rules: [
          {
            when: [ok({ op: 'in', value: Array.from({ length: 101 }, (_, i) => i) })],
            then: 'ask',
          },
        ],
      },
      '/config/rules/0/when/0/value',
    ],
    [
      '33 rules',
      {
        mode: 'ask',
        rules: Array.from({ length: 33 }, () => ({ when: [GT], then: 'ask' as const })),
      },
      '/config/rules',
    ],
    [
      '33 approvers',
      { mode: 'ask', approvers: Array.from({ length: 33 }, (_, i) => ({ role: `r${String(i)}` })) },
      '/config/approvers',
    ],
    [
      'a 64-character fact name',
      { mode: 'ask', rules: [{ when: [ok({ fact: `a${'b'.repeat(63)}` })], then: 'ask' }] },
      '/config/rules/0/when/0/fact',
    ],
  ];
  for (const [label, config, path] of bad2)
    it(`${label}: unsupported at ${path}`, () => {
      const result = exportCedar([policy(config)]);
      expect(result.unsupported.map((entry) => entry.path)).toContain(`/0${path}`);
      expect(result.text).not.toContain('@noblecloak_policy("p")');
    });

  it('the limits themselves are accepted: 32 rules, 32 approvers, 100 in values, a 63-character fact name', () => {
    const result = exportCedar([
      policy({
        mode: 'ask',
        rules: [
          ...Array.from({ length: 31 }, () => ({ when: [GT], then: 'ask' as const })),
          {
            when: [
              ok({ op: 'in', value: Array.from({ length: 100 }, (_, i) => i) }),
              ok({ fact: `a${'b'.repeat(62)}` }),
            ],
            then: 'ask',
          },
        ],
        approvers: Array.from({ length: 32 }, (_, i) => ({ role: `r${String(i)}` })),
      }),
    ]);
    expect(result.unsupported).toEqual([]);
  });

  it('invalid approvers and exclude are unsupported at their member path', () => {
    const result = exportCedar([
      policy({
        mode: 'ask',
        approvers: [{ role: 'r', user: 'u' }] as never,
        exclude: ['approver'] as never,
      }),
    ]);
    expect(result.unsupported.map((entry) => entry.path).sort()).toEqual([
      '/0/config/approvers/0',
      '/0/config/exclude',
    ]);
  });
});

describe('canonical form and diff keep rule order', () => {
  const a: Rules[number] = { when: [GT], then: 'ask' };
  const b: Rules[number] = { when: [EXISTS], then: 'always_allow' };

  it('the canonical form keeps the rules in the given order', () => {
    expect(canonicalPolicy(policy({ mode: 'ask', rules: [a, b] }))).not.toBe(
      canonicalPolicy(policy({ mode: 'ask', rules: [b, a] }))
    );
    expect(
      (normalizePolicy(policy({ mode: 'ask', rules: [b, a] })).config as { rules: unknown }).rules
    ).toEqual([b, a]);
  });

  it('a reordering of the rules is a change, and the same order is none', () => {
    const changes = diffPolicies(
      policy({ mode: 'ask', rules: [a, b] }),
      policy({ mode: 'ask', rules: [b, a] })
    );
    expect(changes.map((change) => [change.path, change.op])).toEqual([
      ['/config/rules', 'replace'],
    ]);
    expect(
      diffPolicies(policy({ mode: 'ask', rules: [a, b] }), policy({ mode: 'ask', rules: [a, b] }))
    ).toEqual([]);
  });

  it('the export order of statements follows the rules order in @noblecloak_rules', async () => {
    const forward = exportCedar([policy({ mode: 'ask', rules: [a, b] })]).text;
    const reversed = exportCedar([policy({ mode: 'ask', rules: [b, a] })]).text;
    expect(forward).not.toBe(reversed);
    const [back] = await cedarBack([policy({ mode: 'ask', rules: [b, a] })]);
    expect(rulesOf(back)).toEqual([b, a]);
  });
});
