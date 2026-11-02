import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { exportAgt } from './agt/export.js';
import { canonicalPolicy } from './canonical.js';
import {
  asExportable,
  awkwardPolicies,
  cedar,
  fixture,
  slicesOf,
  supportedSubset,
} from './fixtures.test-support.js';
import { importAgt } from './import.js';
import { AGT_CEDAR_SCHEMA } from './schemas.js';
import type { AgtExportOptions, ExportablePolicy, InventoryTool } from './types.js';

/** AGT's own manifest schema at both pins (its `approval` reference resolved), and its advice schema. */
function upstreamValidators(pin: 'agt-v5.0.0' | 'agt-main') {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  ajv.addSchema(JSON.parse(fixture(`upstream/${pin}/approval.schema.json`)) as object);
  return {
    manifest: ajv.compile(JSON.parse(fixture(`upstream/${pin}/manifest.schema.json`)) as object),
    advice: ajv.compile(JSON.parse(fixture(`upstream/${pin}/cedar_advice.schema.json`)) as object),
  };
}

const VALIDATORS = {
  '5.0': upstreamValidators('agt-v5.0.0'),
  main: upstreamValidators('agt-main'),
};

const INVENTORY: InventoryTool[] = [
  { tool_ref: 'mcp:conn_1:main:send_email' },
  { tool_ref: 'tool_a' },
  { tool_ref: 'tool_b' },
  { tool_ref: 'tool_unused' },
];

const OPTION_SETS: readonly AgtExportOptions[] = [
  {},
  { agtVersion: '5.0', adviceAwareDispatcher: true },
  { agtVersion: 'main' },
  { agtVersion: 'main', adviceAwareDispatcher: false },
  { toolNames: { 'mcp:conn_1:main:send_email': 'send_email', tool_a: 'a' } },
  {
    agtVersion: 'main',
    baseline: 'allow',
    resolver: {
      default_resolver: 'noblecloak',
      on_timeout: 'deny',
      resolvers: {
        noblecloak: {
          type: 'webhook',
          url: 'https://example.test/approve',
          headers: [],
          tags: ['a', 'b'],
          nested: [[1, true, null]],
        },
      },
      timeout_seconds: 300,
    },
  },
];

function adviceTexts(policySet: string): string[] {
  const parts = cedar.policySetTextToParts(policySet);
  if (parts.type !== 'success') throw new Error('policy set does not parse');
  return parts.policies.flatMap((policy) => {
    const json = cedar.policyToJson(policy);
    if (json.type !== 'success') throw new Error('statement does not convert');
    const advice = json.json.annotations?.advice;
    return typeof advice === 'string' ? [advice] : [];
  });
}

async function roundTrip(
  policies: readonly ExportablePolicy[],
  opts: AgtExportOptions,
  label: string
): Promise<string> {
  const exported = exportAgt(policies, INVENTORY, opts);
  expect(exported.unsupported, label).toEqual([]);
  const imported = await importAgt(exported.text, { cedar });
  expect(imported.unsupported, label).toEqual([]);
  expect(imported.conflicts, label).toEqual([]);
  expect(
    imported.lossy.map((entry) => entry.path),
    label
  ).toEqual(opts.resolver === undefined ? [] : ['/approval']);
  // A 5.0 manifest written with @advice says the bundled dispatcher would have allowed those calls.
  const advisedOn5 =
    (opts.agtVersion ?? '5.0') === '5.0' &&
    opts.adviceAwareDispatcher === true &&
    policies.some((policy) =>
      ['ask', 'escalate'].includes((policy.config as { mode: string }).mode)
    );
  expect(
    imported.notes.map((note) => note.slice(0, 40)),
    label
  ).toEqual(advisedOn5 ? ['This AGT 5.0 manifest writes ask or esca'] : []);
  const byKey = new Map(imported.policies.map((policy) => [policy.key, policy.write]));
  expect(byKey.size, label).toBe(policies.length);
  for (const policy of policies) {
    const back = byKey.get(policy.id);
    expect(back, `${label} ${policy.id}`).toBeDefined();
    if (back !== undefined)
      expect(canonicalPolicy(back), `${label} ${policy.id}`).toBe(canonicalPolicy(policy));
  }
  const again = exportAgt(imported.policies.map(asExportable), imported.tools, imported.options);
  expect(again.text, label).toBe(exported.text);
  return exported.text;
}

describe('AGT: round trip over the supported subset', () => {
  const subset = supportedSubset('agt');

  it('covers every mode, both subject types AGT can express, every target form and optional member', () => {
    const modes = new Set(subset.map((policy) => (policy.config as { mode: string }).mode));
    const types = new Set(
      subset.flatMap((policy) => policy.subjects.map((subject) => subject.type))
    );
    expect([...modes].sort()).toEqual(['always_allow', 'ask', 'deny', 'escalate', 'not_granted']);
    expect([...types].sort()).toEqual(['agent', 'organization']);
    expect(subset.length).toBe(39 * 4 * 5 * 2 * 3);
  });

  const slices = slicesOf(subset);

  it('the slices the per-policy cases run hold every policy of the subset exactly once', () => {
    expect(slices.length).toBe(5 * 5);
    expect(slices.flatMap((slice) => slice.policies.map((policy) => policy.id)).sort()).toEqual(
      subset.map((policy) => policy.id).sort()
    );
  });

  for (const opts of OPTION_SETS) {
    const label = JSON.stringify(opts);
    // One case per slice: the whole subset in one case outran the 60 s timeout on a CI runner.
    for (const slice of slices)
      it(`(A) and (B) hold for each policy on its own, ${slice.label}, ${label}`, async () => {
        for (const policy of slice.policies)
          await roundTrip([policy], opts, `${label} ${policy.id}`);
      });

    it(`(A) and (B) hold for the whole subset in one manifest, ${label}`, async () => {
      await roundTrip([...subset].reverse(), opts, label);
    });
  }

  it('(A) and (B) hold for strings with quotes, line breaks, controls, separators and astral text', async () => {
    const policies = awkwardPolicies('agt');
    const inventory = policies.flatMap((policy) =>
      (policy.targets?.tools as string[]).map((ref) => ({ tool_ref: ref }))
    );
    const toolNames = Object.fromEntries(
      inventory.map((tool, index) => [tool.tool_ref, `${tool.tool_ref}|${String(index)}`])
    );
    for (const opts of [{}, { toolNames }, { agtVersion: 'main' as const }]) {
      const exported = exportAgt(policies, inventory, opts);
      const imported = await importAgt(exported.text, { cedar });
      expect(imported.unsupported).toEqual([]);
      expect(imported.conflicts).toEqual([]);
      for (const policy of policies) {
        const back = imported.policies.find((candidate) => candidate.key === policy.id);
        expect(back && canonicalPolicy(back.write)).toBe(canonicalPolicy(policy));
      }
      expect(
        exportAgt(imported.policies.map(asExportable), imported.tools, imported.options).text
      ).toBe(exported.text);
    }
  });

  it('tool names a YAML reader would resolve to null, a boolean or a number are written quoted and round-trip', async () => {
    const names = [
      'null',
      'true',
      'false',
      'yes',
      'no',
      'on',
      'off',
      'y',
      'n',
      '~',
      '123',
      '1e3',
      '.nan',
      'Null',
      'TRUE',
    ];
    const policy: ExportablePolicy = {
      id: 'p',
      kind: 'tool_invocation',
      subjects: [{ type: 'agent', id: 'a' }],
      targets: { tools: names },
      config: { mode: 'deny' },
    };
    for (const opts of [
      {},
      { toolNames: Object.fromEntries(names.map((name) => [`ref_${name}`, name])) },
    ]) {
      const policies =
        'toolNames' in opts
          ? [{ ...policy, targets: { tools: names.map((name) => `ref_${name}`) } }]
          : [policy];
      const exported = exportAgt(policies, [], opts);
      for (const name of names) expect(exported.text).toContain(`  ${JSON.stringify(name)}:\n`);
      const imported = await importAgt(exported.text, { cedar });
      expect(imported.lossy).toEqual([]);
      expect(imported.policies.map((p) => canonicalPolicy(p.write))).toEqual(
        policies.map(canonicalPolicy)
      );
      expect(
        exportAgt(imported.policies.map(asExportable), imported.tools, imported.options).text
      ).toBe(exported.text);
    }
  });

  // One case per option set: all of them in one case came near the timeout on a CI runner.
  for (const opts of [
    {},
    { agtVersion: '5.0' as const },
    { adviceAwareDispatcher: false },
    { agtVersion: 'main' as const, adviceAwareDispatcher: false },
    { baseline: 'allow' as const },
  ])
    it(`with agtVersion 5.0 and no advice-aware dispatcher, no ask or escalate policy is a permit, ${JSON.stringify(opts)}`, () => {
      const approval = subset.filter((policy) =>
        ['ask', 'escalate'].includes((policy.config as { mode: string }).mode)
      );
      expect(approval.length).toBeGreaterThan(0);
      const { text, lossy } = exportAgt(approval, INVENTORY, opts);
      const policySet = (
        parse(text) as { policies: { noblecloak_tool_invocation: { policy_set: string } } }
      ).policies.noblecloak_tool_invocation.policy_set;
      // The only permit is the baseline statement, when asked for.
      const parts = cedar.policySetTextToParts(policySet);
      const permits =
        parts.type === 'success' ? parts.policies.filter((part) => /^permit/m.test(part)) : [];
      expect(permits.every((part) => part.startsWith('@noblecloak_baseline("allow")'))).toBe(true);
      expect(permits).toHaveLength('baseline' in opts ? 1 : 0);
      expect(adviceTexts(policySet)).toEqual([]);
      expect(lossy.filter((entry) => entry.path.endsWith('/config/mode'))).toHaveLength(
        approval.length
      );
    });

  it('a fail-closed export denies every call an ask or escalate policy matches, by evaluation (even with the baseline permit)', () => {
    const approval = subset.filter((policy) =>
      ['ask', 'escalate'].includes((policy.config as { mode: string }).mode)
    );
    for (const policy of approval) {
      const policySet = (
        parse(exportAgt([policy], [], { baseline: 'allow' }).text) as {
          policies: { noblecloak_tool_invocation: { policy_set: string } };
        }
      ).policies.noblecloak_tool_invocation.policy_set;
      const subject = policy.subjects[0];
      const tools = policy.targets?.tools ?? 'all';
      const answer = cedar.isAuthorized({
        principal: {
          type: 'Agent',
          id: subject !== undefined && 'id' in subject ? subject.id : 'any',
        },
        action: { type: 'Action', id: 'pre_tool_call' },
        resource: { type: 'Tool', id: tools === 'all' ? 'any_tool' : (tools[0] ?? '') },
        context: {},
        policies: { staticPolicies: policySet },
        entities: [],
      });
      expect(answer.type === 'success' && answer.response.decision, policy.id).toBe('deny');
    }
  });

  it('with main, or 5.0 and adviceAwareDispatcher, ask and escalate are a permit with an @advice escalate naming the policy', () => {
    for (const opts of [{ agtVersion: 'main' as const }, { adviceAwareDispatcher: true }]) {
      const policies: ExportablePolicy[] = [
        {
          id: 'p_ask',
          kind: 'tool_invocation',
          subjects: [{ type: 'organization' }],
          config: { mode: 'ask' },
        },
        {
          id: 'p_esc',
          kind: 'tool_invocation',
          subjects: [{ type: 'organization' }],
          config: { mode: 'escalate' },
        },
      ];
      const { text } = exportAgt(policies, [], opts);
      const policySet = (
        parse(text) as { policies: { noblecloak_tool_invocation: { policy_set: string } } }
      ).policies.noblecloak_tool_invocation.policy_set;
      expect(adviceTexts(policySet).map((advice) => JSON.parse(advice) as unknown)).toEqual([
        { reason: 'noblecloak.ask:p_ask', verdict: 'escalate' },
        { reason: 'noblecloak.escalate:p_esc', verdict: 'escalate' },
      ]);
    }
  });

  for (const version of ['5.0', 'main'] as const) {
    // One case per option set: all of them in one case came near the timeout on a CI runner.
    for (const opts of OPTION_SETS)
      it(`the manifest validates against AGT's own manifest schema at the ${version} pin, and every @advice against its advice schema, ${JSON.stringify(opts)}`, () => {
        const { manifest, advice } = VALIDATORS[version];
        const { text } = exportAgt([...subset, ...awkwardPolicies('agt')], INVENTORY, {
          ...opts,
          agtVersion: version,
        });
        const document = parse(text) as {
          policies: { noblecloak_tool_invocation: { policy_set: string } };
        };
        expect(manifest(document), JSON.stringify(manifest.errors)).toBe(true);
        for (const text of adviceTexts(document.policies.noblecloak_tool_invocation.policy_set))
          expect(advice(JSON.parse(text)), JSON.stringify(advice.errors)).toBe(true);
      });

    it(`an empty export at the ${version} pin still binds a non-empty policy set (the schema wants one) and validates`, () => {
      expect(
        VALIDATORS[version].manifest(parse(exportAgt([], [], { agtVersion: version }).text))
      ).toBe(true);
    });
  }

  it('positive control: the AGT Cedar schema rejects a statement outside the dialect', () => {
    const answer = cedar.validate({
      schema: AGT_CEDAR_SCHEMA,
      policies: {
        staticPolicies:
          'permit (principal == User::"u", action == Action::"pre_tool_call", resource);',
      },
    });
    expect(answer.type === 'failure' || answer.validationErrors.length > 0).toBe(true);
  });

  it('positive control: the upstream manifest schema rejects a manifest with an unknown top-level member', () => {
    const document = parse(exportAgt(subset.slice(0, 1), INVENTORY).text) as Record<
      string,
      unknown
    >;
    expect(VALIDATORS['5.0'].manifest({ ...document, rules: [] })).toBe(false);
  });

  it('the policy set validates against schemas/agt.cedarschema, with no error', () => {
    for (const opts of OPTION_SETS) {
      const { text } = exportAgt([...subset, ...awkwardPolicies('agt')], INVENTORY, opts);
      const policySet = (
        parse(text) as { policies: { noblecloak_tool_invocation: { policy_set: string } } }
      ).policies.noblecloak_tool_invocation.policy_set;
      const answer = cedar.validate({
        schema: AGT_CEDAR_SCHEMA,
        policies: { staticPolicies: policySet },
      });
      expect(answer.type).toBe('success');
      if (answer.type === 'success') {
        expect(answer.validationErrors).toEqual([]);
        for (const warning of answer.validationWarnings)
          expect(warning.error.message).toContain('General Security Profile for Identifiers');
      }
    }
  });
});
