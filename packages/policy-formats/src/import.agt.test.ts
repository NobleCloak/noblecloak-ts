import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { exportAgt } from './agt/export.js';
import { cedar, fixture } from './fixtures.test-support.js';
import { importAgt } from './import.js';
import type { ExportablePolicy } from './types.js';

const DENY_AGENT: ExportablePolicy = {
  id: 'p',
  kind: 'tool_invocation',
  subjects: [{ type: 'agent', id: 'a1' }],
  targets: { tools: ['mcp:c:s:send_email'] },
  config: { mode: 'deny' },
};

function manifest(version: string, rest: string): string {
  return `agent_control_specification_version: "${version}"\n${rest}`;
}

const INLINE = (policySet: string): string => `policies:
  main:
    type: cedar
    policy_set: |
${policySet
  .split('\n')
  .map((line) => (line === '' ? '' : `      ${line}`))
  .join('\n')}
intervention_points:
  pre_tool_call:
    policy_target: "$.tool_call.args"
    tool_name_from: "$.tool_call.name"
    policy:
      id: main
tools:
  send_email: {}
`;

async function run(text: string, toolNames?: Record<string, string>) {
  return importAgt(text, { cedar, ...(toolNames === undefined ? {} : { toolNames }) });
}

describe('importAgt: manifest versions', () => {
  for (const [version, agtVersion] of [
    ['0.3.1-beta', '5.0'],
    ['0.3.1-beta-agt', '5.0'],
    ['0.3.0-alpha', '5.0'],
    ['0.3.0-alpha-agt', '5.0'],
    ['0.4.0-alpha.1', 'main'],
    ['0.5.0-alpha.1', 'main'],
  ] as const) {
    it(`accepts ${version} as AGT ${agtVersion}`, async () => {
      const result = await run(
        manifest(version, INLINE('forbid (principal, action, resource == Tool::"send_email");'))
      );
      expect(result.manifestVersion).toBe(version);
      expect(result.options.agtVersion).toBe(agtVersion);
      expect(result.policies).toHaveLength(1);
    });
  }

  for (const version of ['0.4.0', '1.0', '', 'v0.3.1-beta']) {
    it(`refuses ${JSON.stringify(version)}: nothing imported, the version reported`, async () => {
      const result = await run(manifest(version, INLINE('forbid (principal, action, resource);')));
      expect(result.policies).toEqual([]);
      expect(result.unsupported.map((entry) => entry.path)).toEqual([
        '/agent_control_specification_version',
      ]);
    });
  }

  it('refuses a manifest without a version', async () => {
    const result = await run(INLINE('forbid (principal, action, resource);'));
    expect(result.manifestVersion).toBe('');
    expect(result.unsupported).toHaveLength(1);
  });
});

describe('importAgt: what is not a NobleCloak policy is reported, never followed', () => {
  it("AGT's README example (a Rego policy) imports nothing and says why", async () => {
    for (const pin of ['agt-v5.0.0', 'agt-main']) {
      const result = await run(fixture(`upstream/${pin}/readme-example.yaml`));
      expect(result.policies).toEqual([]);
      expect(result.unsupported.map((entry) => entry.path)).toEqual(['/policies/email_policy']);
      expect(result.unsupported[0]?.reason).toContain('"rego"');
      expect(result.tools).toEqual([{ tool_ref: 'send_email' }]);
    }
  });

  it("AGT's approval.cedar bound at pre_tool_call imports nothing and reports each statement by path", async () => {
    for (const pin of ['agt-v5.0.0', 'agt-main']) {
      const result = await run(
        manifest('0.3.1-beta', INLINE(fixture(`upstream/${pin}/approval.cedar`)))
      );
      expect(result.policies).toEqual([]);
      expect(result.unsupported.map((entry) => entry.path)).toEqual([
        '/policies/main/policy_set/policies/0/conditions/0',
        '/policies/main/policy_set/policies/1/conditions/0',
      ]);
      expect(result.notes).toContain(
        'Comments and formatting are not kept: an export writes its own layout and comment block.'
      );
    }
  });

  it("AGT's agt_default.cedar imports only its baseline permit, as an organization always_allow policy", async () => {
    const result = await run(
      manifest('0.4.0-alpha.1', INLINE(fixture('upstream/agt-main/agt_default.cedar')))
    );
    expect(result.policies.map((policy) => policy.write)).toEqual([
      {
        kind: 'tool_invocation',
        subjects: [{ type: 'organization' }],
        targets: { tools: 'all' },
        config: { mode: 'always_allow' },
      },
    ]);
    expect(result.unsupported.length).toBeGreaterThan(10);
    for (const entry of result.unsupported)
      expect(entry.path).toMatch(/^\/policies\/main\/policy_set\/policies\/\d+\//);
    expect(result.lossy.map((entry) => entry.reason)).toContain('annotation @id is not kept');
  });

  it('extends, annotators, other intervention points, unbound policies and the approval block are each reported', async () => {
    const text = manifest(
      '0.4.0-alpha.1',
      `extends: ["./base.yaml"]
annotators:
  pii: { type: classifier }
policies:
  tools:
    type: cedar
    policy_set: 'forbid (principal, action, resource);'
    entities_path: ./entities.json
    query: {}
  output_check:
    type: rego
    bundle: ./policy
  spare:
    type: test
intervention_points:
  pre_tool_call:
    tool_name_from: "$.tool_call.tool"
    annotations:
      pii: { from: "$.tool_call.args" }
    policy:
      id: tools
      data_paths: [x]
  output:
    policy:
      id: output_check
  not_a_point:
    policy:
      id: spare
approval:
  default_resolver: console
  resolvers:
    console: { type: console }
`
    );
    const result = await run(text);
    expect(result.policies).toHaveLength(1);
    expect(result.unsupported.map((entry) => entry.path)).toEqual([
      '/extends',
      '/annotators',
      '/intervention_points/output',
      '/intervention_points/not_a_point',
      '/intervention_points/pre_tool_call/annotations',
      '/intervention_points/pre_tool_call/policy/data_paths',
      '/policies/tools/entities_path',
      '/policies/tools/query',
    ]);
    expect(result.lossy.map((entry) => entry.path)).toEqual([
      '/approval',
      '/intervention_points/pre_tool_call/tool_name_from',
      '/intervention_points/pre_tool_call/policy_target',
    ]);
    expect(result.options.resolver).toEqual({
      default_resolver: 'console',
      resolvers: { console: { type: 'console' } },
    });
  });

  it('a policy defined but bound nowhere, and a binding to a missing policy, are reported', async () => {
    const result = await run(
      manifest(
        '0.3.1-beta',
        `policies:
  orphan:
    type: cedar
    policy_set: 'permit (principal, action, resource);'
intervention_points:
  pre_tool_call:
    tool_name_from: "$.tool_call.name"
    policy:
      id: missing
`
      )
    );
    expect(result.policies).toEqual([]);
    expect(result.unsupported.map((entry) => entry.path)).toEqual([
      '/intervention_points/pre_tool_call/policy/id',
      '/policies/orphan',
    ]);
  });

  it('a policy file path is not read; a missing tool_name_from is reported', async () => {
    const result = await run(
      manifest(
        '0.3.1-beta',
        `policies:
  main:
    type: cedar
    policy_path: ./policy.cedar
intervention_points:
  pre_tool_call:
    policy:
      id: main
`
      )
    );
    expect(result.policies).toEqual([]);
    expect(result.unsupported.map((entry) => entry.path)).toEqual(['/policies/main/policy_path']);
    expect(result.lossy.map((entry) => entry.path)).toEqual([
      '/intervention_points/pre_tool_call/tool_name_from',
      '/intervention_points/pre_tool_call/policy_target',
    ]);
  });

  it('no binding at pre_tool_call: nothing to import, said in a note', async () => {
    const result = await run(manifest('0.3.1-beta', 'metadata: { name: x }\n'));
    expect(result.policies).toEqual([]);
    expect(result.unsupported).toEqual([]);
    expect(result.notes).toEqual([
      'No policy is bound at pre_tool_call, so there is nothing to import.',
    ]);
  });

  it('a pre_tool_call binding with no policy id is unsupported, and so is a policy_target this package does not write', async () => {
    const result = await run(
      manifest(
        '0.4.0-alpha.1',
        'intervention_points:\n  pre_tool_call:\n    policy_target: "$.x"\n    policy_target_kind: k\n    policy: { bundle_url: "https://x" }\n'
      )
    );
    expect(result.unsupported.map((entry) => entry.path)).toEqual([
      '/intervention_points/pre_tool_call/policy',
    ]);
    expect(result.lossy.map((entry) => entry.path)).toEqual([
      '/intervention_points/pre_tool_call/tool_name_from',
      '/intervention_points/pre_tool_call/policy_target',
      '/intervention_points/pre_tool_call/policy_target_kind',
    ]);
  });

  it('members of the wrong shape are reported, never read around', async () => {
    const result = await run(
      manifest(
        '0.3.1-beta',
        'extends: "parent.yaml"\nannotators: [a]\npolicies: [ {type: cedar} ]\nintervention_points: "pre_tool_call"\ntools: [wire]\napproval: "use-slack"\n'
      )
    );
    expect(result.policies).toEqual([]);
    expect(result.unsupported.map((entry) => entry.path).sort()).toEqual(
      ['/annotators', '/approval', '/extends', '/intervention_points', '/policies', '/tools'].sort()
    );
    expect(result.options.resolver).toBeUndefined();
    const binding = await run(
      manifest('0.3.1-beta', 'intervention_points:\n  pre_tool_call: "p1"\n')
    );
    expect(binding.unsupported.map((entry) => entry.path)).toEqual([
      '/intervention_points/pre_tool_call',
    ]);
  });

  it('a policy_set that is not text is reported at policy_set', async () => {
    const result = await run(
      manifest(
        '0.3.1-beta',
        'policies:\n  m: { type: cedar, policy_set: 123 }\nintervention_points:\n  pre_tool_call: { tool_name_from: "$.tool_call.name", policy: { id: m } }\n'
      )
    );
    expect(result.unsupported.map((entry) => entry.path)).toEqual(['/policies/m/policy_set']);
  });

  it('custom and test policies at pre_tool_call are unsupported', async () => {
    for (const type of ['custom', 'test']) {
      const result = await run(
        manifest(
          '0.3.1-beta',
          `policies:\n  m: { type: ${type}, adapter: x }\nintervention_points:\n  pre_tool_call: { tool_name_from: "$.tool_call.name", policy: { id: m } }\n`
        )
      );
      expect(result.unsupported.map((entry) => [entry.path, entry.reason])).toEqual([
        ['/policies/m', `a "${type}" policy is not read; only an inline Cedar policy_set is`],
      ]);
    }
  });

  it('schema_path and a policy_path beside policy_set are unsupported members; the statements still import', async () => {
    const result = await run(
      manifest(
        '0.3.1-beta',
        INLINE('forbid (principal, action, resource);').replace(
          '    type: cedar\n',
          '    type: cedar\n    schema_path: ./s.cedarschema\n    policy_path: ./p.cedar\n'
        )
      )
    );
    expect(result.policies).toHaveLength(1);
    expect(result.unsupported.map((entry) => entry.path)).toEqual([
      '/policies/main/schema_path',
      '/policies/main/policy_path',
    ]);
  });

  it('catalog members other than noblecloak_tool_ref, and malformed entries, are reported as lossy', async () => {
    const result = await run(
      manifest(
        '0.3.1-beta',
        INLINE('forbid (principal, action, resource);').replace(
          '  send_email: {}\n',
          '  send_email: { security_labels: [a], noblecloak_tool_ref: 42 }\n  other: "x"\n'
        )
      )
    );
    expect(result.lossy.map((entry) => entry.path)).toEqual([
      '/tools/send_email/security_labels',
      '/tools/send_email/noblecloak_tool_ref',
      '/tools/other',
    ]);
  });

  it('unresolved YAML tags and an alias bomb are parse errors', async () => {
    await expect(run(manifest('0.3.1-beta', 'approval: !secret { k: v }\n'))).rejects.toMatchObject(
      { code: 'parse_error' }
    );
    const bomb = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (const letter of 'bcdef')
      bomb.push(
        `${letter}: &${letter} [${Array(10)
          .fill(`*${String.fromCharCode(letter.charCodeAt(0) - 1)}`)
          .join(', ')}]`
      );
    await expect(run(manifest('0.3.1-beta', `${bomb.join('\n')}\n`))).rejects.toMatchObject({
      name: 'PolicyFormatError',
      code: 'parse_error',
    });
  });

  it('an unpaired surrogate in the text is a parse error (no file holds one)', async () => {
    await expect(
      run(manifest('0.3.1-beta', 'metadata: { name: "x\uD800" }\n'))
    ).rejects.toMatchObject({ code: 'parse_error' });
  });

  it('notes an empty policy set', async () => {
    const result = await run(manifest('0.3.1-beta', INLINE('// nothing')));
    expect(result.notes).toContain(
      'The policy set holds no statement, so there is nothing to import.'
    );
  });

  it('a non-JSON approval block is reported and not returned', async () => {
    const result = await run(
      manifest(
        '0.3.1-beta',
        `approval:\n  stamp: !!binary aGk=\n${INLINE('forbid (principal, action, resource);').replace(/^/, '')}`
      )
    );
    expect(result.options.resolver).toBeUndefined();
    expect(result.unsupported.map((entry) => entry.path)).toContain('/approval');
    expect(result.lossy.map((entry) => entry.path)).not.toContain('/approval');
  });
});

describe('importAgt: the AGT dialect', () => {
  it.each([
    ['principal in Agent::"a"', 'action', '/principal'],
    ['principal == NobleCloak::User::"u"', 'action', '/principal'],
    ['principal', 'action == Action::"post_tool_call"', '/action'],
    ['principal', 'action == NobleCloak::Action::"tool_invocation"', '/action'],
  ])('%s, %s is unsupported at %s', async (principal, action, path) => {
    const result = await run(
      manifest('0.3.1-beta', INLINE(`forbid (${principal}, ${action}, resource);`))
    );
    expect(result.policies).toEqual([]);
    expect(result.unsupported.map((entry) => entry.path)).toEqual([
      `/policies/main/policy_set/policies/0${path}`,
    ]);
  });
});

describe('importAgt: tool names', () => {
  it('reads tool_refs back from the catalog this package writes', async () => {
    const { text } = exportAgt([DENY_AGENT], [], {
      toolNames: { 'mcp:c:s:send_email': 'send_email' },
    });
    const result = await run(text);
    expect(result.policies[0]?.write.targets).toEqual({ tools: ['mcp:c:s:send_email'] });
    expect(result.options.toolNames).toEqual({ 'mcp:c:s:send_email': 'send_email' });
    expect(result.lossy).toEqual([]);
  });

  it('inverts opts.toolNames for a manifest written elsewhere', async () => {
    const text = manifest(
      '0.3.1-beta',
      INLINE('forbid (principal == Agent::"a1", action, resource == Tool::"send_email");')
    );
    const result = await run(text, { 'mcp:c:s:send_email': 'send_email' });
    expect(result.policies[0]?.write.targets).toEqual({ tools: ['mcp:c:s:send_email'] });
    expect(result.tools).toEqual([{ tool_ref: 'mcp:c:s:send_email' }]);
    expect(result.lossy).toEqual([]);
  });

  it('a name with no mapping imports as itself, reported; a name outside the catalog is reported too', async () => {
    const text = manifest(
      '0.3.1-beta',
      INLINE(
        'forbid (principal, action, resource) when { [Tool::"send_email", Tool::"ghost"].contains(resource) };'
      )
    );
    const result = await run(text);
    expect(result.policies[0]?.write.targets).toEqual({ tools: ['send_email', 'ghost'] });
    expect(result.lossy.map((entry) => [entry.path, entry.reason])).toEqual([
      [
        '/policies/main/policy_set/policies/0/conditions/0/1',
        'the tool "ghost" is not in the manifest\'s tools catalog: AGT fails a call to it closed (tool_unknown)',
      ],
      [
        '/policies/main/policy_set/policies/0/conditions/0/0',
        'the tool name "send_email" has no tool_ref mapping; it is imported as the tool_ref "send_email"',
      ],
      [
        '/policies/main/policy_set/policies/0/conditions/0/1',
        'the tool name "ghost" has no tool_ref mapping; it is imported as the tool_ref "ghost"',
      ],
    ]);
  });

  it('a toolNames map that gives one name to several tool_refs keeps the name and says so', async () => {
    const text = manifest(
      '0.3.1-beta',
      INLINE('forbid (principal, action, resource == Tool::"send_email");')
    );
    const result = await run(text, { a: 'send_email', b: 'send_email' });
    expect(result.policies[0]?.write.targets).toEqual({ tools: ['send_email'] });
    expect(result.lossy[0]?.reason).toContain('"a", "b"');
    expect(result.tools).toEqual([{ tool_ref: 'send_email' }]);
  });
});

describe('importAgt: encodings and errors', () => {
  it('records a non-default dispatcher choice in options so a re-export writes the same encoding', async () => {
    const ask: ExportablePolicy = { ...DENY_AGENT, config: { mode: 'ask' } };
    const v5 = await run(exportAgt([ask], [], { adviceAwareDispatcher: true }).text);
    expect(v5.options).toEqual({ agtVersion: '5.0', adviceAwareDispatcher: true });
    const main = await run(
      exportAgt([ask], [], { agtVersion: 'main', adviceAwareDispatcher: false }).text
    );
    expect(main.options).toEqual({ agtVersion: 'main', adviceAwareDispatcher: false });
    const plain = await run(exportAgt([ask], [], { agtVersion: 'main' }).text);
    expect(plain.options).toEqual({ agtVersion: 'main' });
  });

  it('mixed encodings import, set no dispatcher option, and say an export writes them one way', async () => {
    const ask: ExportablePolicy = { ...DENY_AGENT, id: 'q', config: { mode: 'ask' } };
    const policySet = (text: string): string =>
      (parse(text) as { policies: { noblecloak_tool_invocation: { policy_set: string } } }).policies
        .noblecloak_tool_invocation.policy_set;
    const failClosed = policySet(exportAgt([ask], [], {}).text);
    const advised = policySet(
      exportAgt([{ ...ask, id: 'r' }], [], { adviceAwareDispatcher: true }).text
    );
    const text = stringify({
      agent_control_specification_version: '0.3.1-beta',
      policies: { m: { type: 'cedar', policy_set: `${failClosed}\n${advised}` } },
      intervention_points: {
        pre_tool_call: { tool_name_from: '$.tool_call.name', policy: { id: 'm' } },
      },
      tools: { 'mcp:c:s:send_email': {} },
    });
    const result = await run(text);
    expect(result.policies).toHaveLength(2);
    expect(result.options.adviceAwareDispatcher).toBeUndefined();
    expect(result.notes.some((note) => note.includes('an export writes them all one way'))).toBe(
      true
    );
    expect(
      result.notes.some((note) =>
        note.includes("AGT 5.0's bundled Cedar dispatcher reads no @advice")
      )
    ).toBe(true);
  });

  it('a 5.0 manifest whose ask is a permit with @advice says the bundled dispatcher allowed it; main does not', async () => {
    const ask: ExportablePolicy = { ...DENY_AGENT, config: { mode: 'ask' } };
    const v5 = await run(exportAgt([ask], [], { adviceAwareDispatcher: true }).text);
    expect(v5.notes.some((note) => note.includes('allowed those calls'))).toBe(true);
    const main = await run(exportAgt([ask], [], { agtVersion: 'main' }).text);
    expect(main.notes).toEqual([]);
  });

  it('opts.toolNames that disagrees with the catalog is followed and reported', async () => {
    const { text } = exportAgt([DENY_AGENT], [], { toolNames: { 'mcp:c:s:send_email': 'send' } });
    const result = await run(text, { other: 'send' });
    expect(result.policies[0]?.write.targets).toEqual({ tools: ['other'] });
    expect(result.lossy.map((entry) => entry.path)).toEqual(['/tools/send/noblecloak_tool_ref']);
  });

  it('notes a YAML comment of its own; the comment block this package writes is not one', async () => {
    const { text } = exportAgt([DENY_AGENT], []);
    expect((await run(text)).notes).toEqual([]);
    expect((await run(`${text}# edited by hand\n`)).notes).toHaveLength(1);
  });

  it('throws parse_error for YAML that does not parse, several documents, or a document that is no mapping', async () => {
    for (const text of ['a: [', 'a: 1\na: 2\n', 'a: 1\n---\nb: 2\n', '- a\n', 'just text']) {
      await expect(run(text)).rejects.toMatchObject({
        name: 'PolicyFormatError',
        code: 'parse_error',
      });
    }
  });

  it('throws parse_error when the inline policy set is not Cedar', async () => {
    await expect(run(manifest('0.3.1-beta', INLINE('permit (principal')))).rejects.toMatchObject({
      code: 'parse_error',
    });
  });

  it('origin carries the format agt', async () => {
    const result = await run(exportAgt([], []).text);
    expect(result.origin.format).toBe('agt');
    const text = exportAgt([], []).text;
    expect(result.origin.digest).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    expect((await importAgt(bytes, { cedar })).origin.digest).toBe(
      createHash('sha256').update(bytes).digest('hex')
    );
  });
});
