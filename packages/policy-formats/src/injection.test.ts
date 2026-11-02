/**
 * Untrusted strings never escape the place they are written to: a config key, policy id, name,
 * description, tool_ref, subject id or approver group holding a line break or a comment terminator leaves
 * the exported file parsing to exactly the intended statements and manifest, and nothing is injected.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { exportAgt } from './agt/export.js';
import { canonicalPolicy } from './canonical.js';
import { exportCedar } from './export.js';
import { asExportable, cedar } from './fixtures.test-support.js';
import { importAgt, importCedar } from './import.js';
import { commentBlock, commentSafe } from './report.js';
import type { ExportablePolicy } from './types.js';

const BREAKS = ['\n', '\r', '\r\n', '\u0085', '\u2028', '\u2029', '\u000b', '\u000c'];
const TERMINATORS = ['*/', '/*', '//', '#', '# ', '": x', "'", '|', '---', '...'];
const CEDAR_PAYLOAD = 'permit (principal, action, resource);';
const YAML_PAYLOAD = 'injected: true';

function payloads(): string[] {
  const out: string[] = [];
  for (const brk of BREAKS)
    for (const tail of [CEDAR_PAYLOAD, YAML_PAYLOAD, ...TERMINATORS])
      out.push(`x${brk}${tail}${brk}`);
  for (const term of TERMINATORS) out.push(`x ${term} ${CEDAR_PAYLOAD}`);
  return out;
}

function policySetOf(text: string): string {
  return (parse(text) as { policies: { noblecloak_tool_invocation: { policy_set: string } } })
    .policies.noblecloak_tool_invocation.policy_set;
}

const MANIFEST_KEYS = [
  'agent_control_specification_version',
  'intervention_points',
  'metadata',
  'policies',
  'tools',
];

describe('untrusted strings stay where they are written', () => {
  const all = payloads();

  it('a config key with a break or terminator lands only, escaped, in the comment block', async () => {
    for (const key of all) {
      const bad = {
        id: 'bad',
        kind: 'tool_invocation',
        subjects: [{ type: 'agent', id: 'a' }],
        config: { mode: 'deny', [key]: 1 },
      } as unknown as ExportablePolicy;
      const good: ExportablePolicy = {
        id: 'good',
        kind: 'tool_invocation',
        subjects: [{ type: 'agent', id: 'a' }],
        config: { mode: 'deny' },
      };
      const cedarExport = exportCedar([bad, good]);
      expect(cedarExport.unsupported.map((entry) => entry.policy)).toEqual(['bad']);
      const parts = cedar.policySetTextToParts(cedarExport.text);
      expect(parts.type === 'success' && parts.policies.length, JSON.stringify(key)).toBe(1);
      const imported = await importCedar(cedarExport.text, { cedar });
      expect(imported.policies.map((policy) => policy.key)).toEqual(['good']);

      const agtExport = exportAgt([bad, good], []);
      const manifest = parse(agtExport.text) as Record<string, unknown>;
      expect(Object.keys(manifest).sort(), JSON.stringify(key)).toEqual(MANIFEST_KEYS);
      const agtParts = cedar.policySetTextToParts(policySetOf(agtExport.text));
      expect(agtParts.type === 'success' && agtParts.policies.length).toBe(1);
    }
  });

  it('a policy id, name, description, tool_ref, subject id and approver group keep their value and inject nothing', async () => {
    const policies: ExportablePolicy[] = all.map((text, index) => ({
      id: `${text}#${String(index)}`,
      kind: 'tool_invocation',
      name: text,
      description: text,
      subjects: [{ type: 'agent', id: text }],
      targets: { tools: [text] },
      config: { mode: 'ask', approver_groups: [text], expires_after: text },
    }));
    const unsupported = {
      ...policies[0],
      id: 'not-exported',
      kind: 'spending',
    } as ExportablePolicy;
    const cedarExport = exportCedar([...policies, unsupported]);
    const parts = cedar.policySetTextToParts(cedarExport.text);
    expect(parts.type === 'success' && parts.policies.length).toBe(policies.length);
    const fromCedar = await importCedar(cedarExport.text, { cedar });
    expect(fromCedar.conflicts).toEqual([]);
    expect(fromCedar.unsupported).toEqual([]);
    expect(fromCedar.policies.map((policy) => canonicalPolicy(policy.write)).sort()).toEqual(
      policies.map(canonicalPolicy).sort()
    );

    const tools = policies.map((policy) => ({
      tool_ref: (policy.targets?.tools as string[])[0] ?? '',
    }));
    const toolNames = Object.fromEntries(tools.map((tool) => [tool.tool_ref, `${tool.tool_ref}!`]));
    for (const opts of [{}, { toolNames }, { agtVersion: 'main' as const }]) {
      const agtExport = exportAgt([...policies, unsupported], tools, opts);
      const manifest = parse(agtExport.text) as Record<string, unknown>;
      expect(Object.keys(manifest).sort()).toEqual(MANIFEST_KEYS);
      const agtParts = cedar.policySetTextToParts(policySetOf(agtExport.text));
      expect(agtParts.type === 'success' && agtParts.policies.length).toBe(policies.length);
      const fromAgt = await importAgt(agtExport.text, { cedar });
      expect(fromAgt.conflicts).toEqual([]);
      expect(fromAgt.policies.map((policy) => canonicalPolicy(policy.write)).sort()).toEqual(
        policies.map(canonicalPolicy).sort()
      );
      expect(
        exportAgt(fromAgt.policies.map(asExportable), fromAgt.tools, fromAgt.options).text
      ).toBe(exportAgt(policies, tools, opts).text);
    }
  });

  it('commentSafe escapes every break, control, separator and unpaired surrogate', () => {
    expect(commentSafe('a\nb\rc\u0085d\u2028e\u2029f\u0000g\uD800h')).toBe(
      'a\\u000ab\\u000dc\\u0085d\\u2028e\\u2029f\\u0000g\\ud800h'
    );
    expect(commentSafe('plain é 🛡 */ # //')).toBe('plain é 🛡 */ # //');
    expect(commentBlock('#', ['one\ntwo'])).toBe('# one\\u000atwo\n\n');
  });

  it('commentSafe escapes bidirectional controls and every invisible code point (Trojan Source)', () => {
    const line = commentSafe(
      'id\u202Eevil\u2066x\u200By\u200Ez\u061Ca\u00ADb\uFEFFc\uFE0Fd\u{E0041}e\uFFF9f\u000Bg\u000Ch\uDC00i\u{1F6E1}'
    );
    expect(line).toBe(
      'id\\u202eevil\\u2066x\\u200by\\u200ez\\u061ca\\u00adb\\ufeffc\\ufe0fd\\u{e0041}e\\ufff9f\\u000bg\\u000ch\\udc00i\u{1F6E1}'
    );
    // Nothing invisible, bidirectional or line-breaking is left.
    expect(line).not.toMatch(
      /[\p{Cc}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}\u2028\u2029\p{Cs}]/u
    );
  });
});

describe('Trojan Source: bidirectional and invisible code points', () => {
  const HIDDEN = '\u202E\u2066\u200B\u200E\u061C\uFEFF\uFE0F\u{E0041}\uFFF9\u2028\r';
  const UNSAFE = /[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}\u2028\u2029\ufff9-\ufffb]/u;
  const policy = {
    id: `pol${HIDDEN}id`,
    kind: 'tool_invocation',
    name: `name${HIDDEN}`,
    description: `desc${HIDDEN}`,
    subjects: [{ type: 'agent', id: `agent${HIDDEN}` }],
    targets: { tools: [`tool${HIDDEN}`] },
    config: { mode: 'deny' },
  } as unknown as ExportablePolicy;

  it('leaves none raw in a Cedar or AGT file, header or body, and both still import exactly', async () => {
    const files = [
      { text: exportCedar([policy]).text, read: (t: string) => importCedar(t, { cedar }) },
      {
        text: exportAgt([policy], [{ tool_ref: `tool${HIDDEN}` }]).text,
        read: (t: string) => importAgt(t, { cedar }),
      },
    ];
    const write = Object.fromEntries(
      Object.entries(policy).filter(([key]) => key !== 'id')
    ) as unknown as ExportablePolicy;
    for (const { text, read } of files) {
      expect(text).not.toMatch(UNSAFE);
      const imported = await read(text);
      expect(imported.policies.map((p) => canonicalPolicy(p.write))).toEqual([
        canonicalPolicy(write),
      ]);
    }
  });

  it('commentSafe leaves none in a header line, a reason included', () => {
    const line = commentSafe(`Not exported: policy "${HIDDEN}": reason${HIDDEN}`);
    expect(line).not.toMatch(UNSAFE);
    expect(line).not.toMatch(/[\r\n\u0085]/);
  });
});
