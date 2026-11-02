/**
 * Hostile and unusual input from the adversarial review: inputs that crashed the parser, merged tools,
 * lost keys, or threw something other than PolicyFormatError. Every case here must end in a report entry
 * or a PolicyFormatError, and the parser must stay usable afterwards.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { exportAgt } from './agt/export.js';
import { canonicalPolicy } from './canonical.js';
import { MAX_NESTING, MAX_TOKENS } from './cedar/parse.js';
import { MAX_INPUT_BYTES } from './digest.js';
import { PolicyFormatError } from './errors.js';
import { exportCedar } from './export.js';
import { asExportable, cedar } from './fixtures.test-support.js';
import { importAgt, importCedar } from './import.js';
import type { ExportablePolicy } from './types.js';

const DENY: ExportablePolicy = {
  id: 'p',
  kind: 'tool_invocation',
  subjects: [{ type: 'agent', id: 'a' }],
  targets: { tools: ['t'] },
  config: { mode: 'deny' },
};

const forbidWhen = (condition: string): string =>
  `forbid (principal, action, resource) when { ${condition} };`;

describe('statements the Cedar parser would crash on are refused before it sees them', () => {
  const deep: readonly [string, string][] = [
    ['150 nested parentheses', forbidWhen(`${'('.repeat(150)}true${')'.repeat(150)}`)],
    ['150 nested sets', forbidWhen(`${'['.repeat(150)}1${']'.repeat(150)}.isEmpty()`)],
    ['150 nested records', forbidWhen(`${'{a:'.repeat(150)}1${'}'.repeat(150)} == 1`)],
    ['3000 conjuncts', forbidWhen(Array(3000).fill('true').join(' && '))],
    ['3000 member accesses', forbidWhen(`context${'.a'.repeat(3000)}`)],
    [
      '1000 nested ifs',
      forbidWhen(`${'if true then '.repeat(1000)}true${' else true'.repeat(1000)}`),
    ],
    ...(['+', '-', '*', '||', '==', '<', '!=', '>='] as const).map((op): [string, string] => [
      `3000 ${op} operators`,
      forbidWhen(Array(3000).fill('1').join(` ${op} `)),
    ]),
    ['3000 negations', forbidWhen(`${'-'.repeat(3000)}1 == 1`)],
    ['1000 nested !( )', forbidWhen(`${'!('.repeat(1000)}true${')'.repeat(1000)}`)],
    ['3000 has tests', forbidWhen(`context${' has a'.repeat(3000)}`)],
    ['3000 calls', forbidWhen(`context${'.contains(1)'.repeat(3000)}`)],
  ];

  for (const [label, text] of deep) {
    it(`${label}: parse_error, and the parser still works afterwards`, async () => {
      await expect(importCedar(text, { cedar })).rejects.toMatchObject({
        name: 'PolicyFormatError',
        code: 'parse_error',
      });
      const manifest = `agent_control_specification_version: "0.3.1-beta"\npolicies:\n  m: { type: cedar, policy_set: ${JSON.stringify(text)} }\nintervention_points:\n  pre_tool_call: { policy_target: "$.tool_call.args", tool_name_from: "$.tool_call.name", policy: { id: m } }\n`;
      await expect(importAgt(manifest, { cedar })).rejects.toMatchObject({ code: 'parse_error' });
      const after = await importCedar(exportCedar([DENY]).text, { cedar });
      expect(after.policies).toHaveLength(1);
    });
  }

  it('just inside the limits, a statement parses and is reported as unsupported', async () => {
    const nested = await importCedar(
      forbidWhen(`${'('.repeat(MAX_NESTING - 1)}true${')'.repeat(MAX_NESTING - 1)}`),
      { cedar }
    );
    expect(nested.unsupported.map((entry) => entry.path)).toEqual(['/policies/0/conditions/0']);
    // forbid ( principal , action , resource ) when { … } is 11 tokens; n terms joined by + are 2n - 1,
    // so these terms make exactly MAX_TOKENS, and one more term is two over.
    const terms = (MAX_TOKENS - 10) / 2;
    const atLimit = forbidWhen(Array(terms).fill('1').join(' + '));
    const chain = await importCedar(atLimit, { cedar });
    await expect(
      importCedar(
        forbidWhen(
          Array(terms + 1)
            .fill('1')
            .join(' + ')
        ),
        { cedar }
      )
    ).rejects.toMatchObject({ code: 'parse_error' });
    expect(chain.unsupported).toHaveLength(1);
  });

  it('brackets and operators inside strings and comments do not count; a file of many statements is fine', async () => {
    const text = `// ${'('.repeat(500)}\n@noblecloak_description(${JSON.stringify('['.repeat(500) + '&&'.repeat(600))})\n@noblecloak_policy("p")\nforbid (principal, action, resource);\n`;
    expect((await importCedar(text, { cedar })).policies).toHaveLength(1);
    const many = exportCedar(
      Array.from({ length: 600 }, (_, index) => ({ ...DENY, id: `p${String(index)}` }))
    ).text;
    expect((await importCedar(many, { cedar })).policies).toHaveLength(600);
  });

  it('refuses quickly, without the parser, and refuses a file over the size cap', async () => {
    const start = Date.now();
    await expect(
      importCedar(forbidWhen(Array(200_000).fill('1').join(' + ')), { cedar })
    ).rejects.toMatchObject({ code: 'parse_error' });
    expect(Date.now() - start).toBeLessThan(2000);
    await expect(importCedar('x'.repeat(MAX_INPUT_BYTES + 1), { cedar })).rejects.toMatchObject({
      code: 'parse_error',
    });
    await expect(importCedar(new Uint8Array(MAX_INPUT_BYTES + 1), { cedar })).rejects.toMatchObject(
      { code: 'parse_error' }
    );
  });

  it('reads comments as Cedar does: a comment ends at \r, so a chain after it still counts', async () => {
    const chain = Array(3000).fill('1').join(' + ');
    for (const end of ['\r', '\n', '\r\n']) {
      const text = `forbid (principal, action, resource) when { // note${end}${chain} == 1 };`;
      await expect(importCedar(text, { cedar })).rejects.toMatchObject({ code: 'parse_error' });
    }
    expect(
      (await importCedar(exportCedar([DENY]).text.replaceAll('\n', '\r'), { cedar })).policies
    ).toHaveLength(1);
    expect(
      (await importCedar(exportCedar([DENY]).text.replaceAll('\n', '\r\n'), { cedar })).policies
    ).toHaveLength(1);
  });

  it("fails closed on what Cedar's lexer would not read the same way", async () => {
    const bad = [
      'forbid (principal, action, resource) when { "unterminated };',
      'forbid (principal, action, resource) when { "ends in an escape\\',
      'forbid (principal, action, resource) when { "escaped\\\nbreak" };',
      'forbid (principal, action, resource) when { # };',
      'forbid (principal, action, resource) when { $x };',
      'forbid (principal, action, resource) when { é };',
      'forbid\u00a0(principal, action, resource);',
      'forbid (principal, action, resource) when { \\ };',
      'forbid (principal, action, resource) when { ? };',
      '\u2028forbid (principal, action, resource);',
    ];
    for (const text of bad)
      await expect(importCedar(text, { cedar }), JSON.stringify(text)).rejects.toMatchObject({
        name: 'PolicyFormatError',
        code: 'parse_error',
      });
    const after = await importCedar(exportCedar([DENY]).text, { cedar });
    expect(after.policies).toHaveLength(1);
  });

  it('reads slots, numbers, every operator and non-ASCII text inside strings and comments', async () => {
    const text = `// é ☃ # $\n@id("é ☃ # $ \\" \\\\ \\u{1F600}")\npermit (principal == ?principal, action, resource) when { 1 + 2 * 3 - 5 <= 6 && !(7 >= 8) || 9 != 10 && 11 < 12 && 13 > 14 && context has a && context.a like "*" && resource is Tool && principal in resource };`;
    const result = await importCedar(text, { cedar });
    expect(result.unsupported.map((entry) => entry.path)).toEqual(['/templates/0']);
    // `%` and `/` are Cedar tokens the parser then refuses: the lexer passes them on, the parser says why.
    await expect(
      importCedar('forbid (principal, action, resource) when { 1 % 2 / 3 == 0 };', { cedar })
    ).rejects.toThrow(/remainder|division|not supported/);
  });

  it('anything the parser throws becomes parse_error', async () => {
    const throwing = {
      policySetTextToParts: (): never => {
        throw new Error('boom');
      },
      policyToJson: (): never => {
        throw new Error('boom');
      },
    };
    await expect(importCedar('x', { cedar: throwing })).rejects.toMatchObject({
      code: 'parse_error',
    });
  });

  it('a caller-supplied loader that fails is cedar_unavailable', async () => {
    await expect(
      importCedar('x', { cedar: () => Promise.reject(new Error('nope')) })
    ).rejects.toMatchObject({ name: 'PolicyFormatError', code: 'cedar_unavailable' });
  });
});

describe('AGT tool names that cannot be read back to one tool_ref', () => {
  it('two catalog names recording one tool_ref keep their own names and are reported', async () => {
    const manifest = `agent_control_specification_version: "0.3.1-beta"
policies:
  m:
    type: cedar
    policy_set: |
      forbid (principal == Agent::"a", action, resource == Tool::"send");
      permit (principal == Agent::"a", action, resource == Tool::"other");
intervention_points:
  pre_tool_call: { policy_target: "$.tool_call.args", tool_name_from: "$.tool_call.name", policy: { id: m } }
tools:
  send: { noblecloak_tool_ref: X }
  other: { noblecloak_tool_ref: X }
`;
    const result = await importAgt(manifest, { cedar });
    expect(result.policies.map((policy) => policy.write.targets)).toEqual([
      { tools: ['send'] },
      { tools: ['other'] },
    ]);
    expect(result.tools).toEqual([{ tool_ref: 'send' }, { tool_ref: 'other' }]);
    expect(result.options.toolNames).toBeUndefined();
    expect(result.lossy.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        '/tools/send/noblecloak_tool_ref',
        '/tools/other/noblecloak_tool_ref',
      ])
    );
  });

  it('a recorded tool_ref that is another catalog name used as itself is not followed', async () => {
    const manifest = `agent_control_specification_version: "0.3.1-beta"
policies:
  m: { type: cedar, policy_set: 'forbid (principal, action, resource == Tool::"send");' }
intervention_points:
  pre_tool_call: { policy_target: "$.tool_call.args", tool_name_from: "$.tool_call.name", policy: { id: m } }
tools:
  X: {}
  send: { noblecloak_tool_ref: X }
`;
    const result = await importAgt(manifest, { cedar });
    expect(result.policies[0]?.write.targets).toEqual({ tools: ['send'] });
    expect(result.lossy.map((entry) => entry.path)).toContain('/tools/send/noblecloak_tool_ref');
  });

  it('__proto__ as a tool_ref and as a resolver key round-trips as data', async () => {
    const toolNames = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
    const resolver = JSON.parse('{"__proto__":{"a":"b"},"default_resolver":"x"}') as Record<
      string,
      never
    >;
    const policy: ExportablePolicy = { ...DENY, targets: { tools: ['__proto__'] } };
    const exported = exportAgt([policy], [], { toolNames, resolver });
    const imported = await importAgt(exported.text, { cedar });
    expect(Object.hasOwn(imported.options.toolNames ?? {}, '__proto__')).toBe(true);
    expect(Object.hasOwn(imported.options.resolver ?? {}, '__proto__')).toBe(true);
    expect(
      exportAgt(imported.policies.map(asExportable), imported.tools, imported.options).text
    ).toBe(exported.text);
  });
});

describe('YAML keys longer than an implicit key may be', () => {
  it('a tool_ref and a resolver key over 1024 written characters use an explicit key and round-trip', async () => {
    const long = 'x'.repeat(1030);
    const escaped = '\u0085'.repeat(200);
    const policy: ExportablePolicy = { ...DENY, targets: { tools: [long, escaped] } };
    const resolver = { [long]: { type: 'webhook' } };
    for (const agtVersion of ['5.0', 'main'] as const) {
      const exported = exportAgt([policy], [], { agtVersion, resolver });
      expect(exported.text).toContain(`\n  ? ${long}\n  :\n`);
      const document = parse(exported.text) as { tools: Record<string, unknown> };
      expect(Object.keys(document.tools).sort()).toEqual([escaped, long].sort());
      const imported = await importAgt(exported.text, { cedar });
      expect(imported.policies.map((p) => canonicalPolicy(p.write))).toEqual([
        canonicalPolicy(policy),
      ]);
      expect(
        exportAgt(imported.policies.map(asExportable), imported.tools, imported.options).text
      ).toBe(exported.text);
    }
  });
});

describe('statements and notes the review found unreported', () => {
  it('a baseline marker on a statement of a policy holds the whole policy back', async () => {
    const text = `@noblecloak_policy("k")
forbid (principal == NobleCloak::Agent::"a", action, resource);
@noblecloak_policy("k")
@noblecloak_baseline("allow")
forbid (principal == NobleCloak::Agent::"b", action, resource);
`;
    const result = await importCedar(text, { cedar });
    expect(result.policies).toEqual([]);
    expect(result.unsupported.map((entry) => [entry.policy, entry.path])).toEqual([
      ['k', '/policies/1/annotations/noblecloak_baseline'],
      ['k', '/policies/0'],
    ]);
  });

  it('a NobleCloak-dialect permit with @advice imports as ask with a note that a Cedar engine allows it', async () => {
    const text = `@noblecloak_policy("k")
@noblecloak_mode("ask")
@advice("{\\"reason\\":\\"noblecloak.ask:k\\",\\"verdict\\":\\"escalate\\"}")
permit (principal == NobleCloak::Agent::"a", action, resource);
`;
    const result = await importCedar(text, { cedar });
    expect(result.policies[0]?.write.config).toEqual({ mode: 'ask' });
    expect(
      result.notes.some((note) => note.includes('a Cedar engine that reads no @advice allows'))
    ).toBe(true);
  });

  it('a pre_tool_call binding without policy_target and foreign metadata are reported', async () => {
    const manifest = `agent_control_specification_version: "0.3.1-beta"
metadata: { name: mine, owner: me }
policies:
  m: { type: cedar, policy_set: 'forbid (principal, action, resource);' }
intervention_points:
  pre_tool_call: { tool_name_from: "$.tool_call.name", policy: { id: m } }
`;
    const result = await importAgt(manifest, { cedar });
    expect(result.policies).toHaveLength(1);
    expect(result.lossy.map((entry) => entry.path)).toEqual([
      '/metadata/name',
      '/metadata/owner',
      '/intervention_points/pre_tool_call/policy_target',
    ]);
    const ours = await importAgt(exportAgt([DENY], []).text, { cedar });
    expect(ours.lossy).toEqual([]);
  });
});

describe('arguments that are not what the API takes', () => {
  it('non-object policies and tools, a cyclic or too-deep resolver, and an unpaired surrogate in a resolver are invalid_input', () => {
    expect(() => exportCedar([null as never])).toThrow(PolicyFormatError);
    expect(() => exportAgt([DENY], [null as never])).toThrow(PolicyFormatError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => exportAgt([DENY], [], { resolver: cyclic as never })).toThrow(PolicyFormatError);
    expect(() => exportAgt([DENY], [], { resolver: { a: 'x\uD800' } })).toThrow(PolicyFormatError);
    expect(() => exportAgt([DENY], [], { resolver: { ['\uDC00']: 'x' } })).toThrow(
      PolicyFormatError
    );
  });
});
