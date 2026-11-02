import { describe, expect, it } from 'vitest';

import { exportAgt } from './agt/export.js';
import { member, yamlLines } from './agt/yaml.js';
import { cedarString } from './cedar/print.js';
import { PolicyFormatError } from './errors.js';
import { exportCedar } from './export.js';
import { HEADER_LINE_STARTS } from './report.js';
import { cedar } from './fixtures.test-support.js';
import type { ExportablePolicy } from './types.js';

const OK: ExportablePolicy = {
  id: 'ok',
  kind: 'tool_invocation',
  subjects: [{ type: 'agent', id: 'a1' }],
  config: { mode: 'deny' },
};

describe('export: input it refuses', () => {
  it('throws invalid_input for a missing, empty or ill-formed id, and for two policies with one id', () => {
    for (const id of [undefined, '', 'x\uD800']) {
      const policy = { ...OK, id } as unknown as ExportablePolicy;
      expect(() => exportCedar([policy])).toThrow(PolicyFormatError);
    }
    expect(() => exportCedar([OK, { ...OK }])).toThrow(/two policies have the id "ok"/);
  });

  it('throws invalid_input for a bad toolNames map, an ill-formed tool_ref, or two tools given one AGT name', () => {
    expect(() => exportAgt([OK], [], { toolNames: { a: '' } })).toThrow(PolicyFormatError);
    expect(() => exportAgt([OK], [{ tool_ref: '' }])).toThrow(PolicyFormatError);
    expect(() =>
      exportAgt([OK], [{ tool_ref: 'a' }, { tool_ref: 'b' }], { toolNames: { a: 'b' } })
    ).toThrow(/both have the AGT name "b"/);
    expect(() => exportAgt([OK], [], { agtVersion: '6.0' as never })).toThrow(PolicyFormatError);
  });

  it('throws invalid_input for a resolver block holding a number JSON cannot', () => {
    expect(() => exportAgt([OK], [], { resolver: { timeout_seconds: Number.NaN } })).toThrow(
      PolicyFormatError
    );
  });
});

describe('export: policies outside rev 10 are reported, not exported', () => {
  const invalid: readonly [string, Partial<ExportablePolicy> & Record<string, unknown>, string][] =
    [
      ['no subject', { subjects: [] }, '/subjects'],
      [
        'a duplicated subject',
        {
          subjects: [
            { type: 'agent', id: 'a' },
            { type: 'agent', id: 'a' },
          ],
        },
        '/subjects',
      ],
      ['a malformed subject', { subjects: [{ type: 'robot', id: 'r' }] as never }, '/subjects/0'],
      ['a subject that is no object', { subjects: ['agent'] as never }, '/subjects/0'],
      [
        'an organization subject with an id',
        { subjects: [{ type: 'organization', id: 'o' }] as never },
        '/subjects/0',
      ],
      ['an empty tool list', { targets: { tools: [] } }, '/targets/tools'],
      ['an empty tool_ref', { targets: { tools: [''] } }, '/targets/tools/0'],
      [
        'more than 100 tools',
        { targets: { tools: Array.from({ length: 101 }, (_, i) => `t${String(i)}`) } },
        '/targets/tools',
      ],
      ['an empty name', { name: '' }, '/name'],
      ['a description over 2000 characters', { description: 'x'.repeat(2001) }, '/description'],
      ['a config that is no object', { config: 'deny' as never }, '/config'],
      ['an unknown mode', { config: { mode: 'maybe' } as never }, '/config/mode'],
      [
        'an unknown config member',
        { config: { mode: 'deny', extra: 1 } as never },
        '/config/extra',
      ],
      ['on_deny with deny', { config: { mode: 'deny', on_deny: 'halt' } }, '/config/on_deny'],
      [
        'expires_after with always_allow',
        { config: { mode: 'always_allow', expires_after: 'PT1H' } },
        '/config/expires_after',
      ],
      [
        'approver_groups with not_granted',
        { config: { mode: 'not_granted', approver_groups: [] } },
        '/config/approver_groups',
      ],
      [
        'an on_deny that is no value',
        { config: { mode: 'ask', on_deny: 'later' } as never },
        '/config/on_deny',
      ],
      [
        'an expires_after that is no string',
        { config: { mode: 'ask', expires_after: 5 } as never },
        '/config/expires_after',
      ],
      [
        'approver_groups that are no strings',
        { config: { mode: 'ask', approver_groups: [1] } as never },
        '/config/approver_groups',
      ],
      ['a lone surrogate in a name', { name: 'a\uDC00' }, '/name'],
      ['a lone surrogate in a description', { description: '\uD800' }, '/description'],
      [
        'a lone surrogate in a subject id',
        { subjects: [{ type: 'agent', id: '\uD800' }] },
        '/subjects/0/id',
      ],
      ['a lone surrogate in a tool_ref', { targets: { tools: ['\uDBFF'] } }, '/targets/tools/0'],
      [
        'a lone surrogate in expires_after',
        { config: { mode: 'ask', expires_after: '\uD800' } },
        '/config/expires_after',
      ],
      [
        'a lone surrogate in an approver group',
        { config: { mode: 'ask', approver_groups: ['\uD800'] } },
        '/config/approver_groups/0',
      ],
    ];

  for (const [label, change, path] of invalid) {
    it(label, () => {
      for (const result of [
        exportCedar([{ ...OK, ...change }]),
        exportAgt([{ ...OK, ...change }], []),
      ]) {
        expect(result.unsupported.map((entry) => entry.path)).toContain(`/0${path}`);
        expect(result.unsupported.every((entry) => entry.policy === 'ok')).toBe(true);
        expect(result.text).not.toContain('@noblecloak_policy("ok")');
      }
    });
  }

  it('the comment block lists what was not exported, by policy key, with input values quoted on one line', () => {
    const { text, unsupported } = exportCedar([
      { ...OK, id: 'evil\n// injected', kind: 'spending' },
      OK,
    ]);
    expect(unsupported).toHaveLength(1);
    expect(text).toContain(
      '// Not exported: policy "evil\\n// injected" /kind: kind "spending" has no Cedar form'
    );
    expect(text.split('\n').filter((line) => line.startsWith('// injected'))).toEqual([]);
  });
});

describe('export: the text', () => {
  it('an empty Cedar export is the comment block alone, and parses as an empty policy set', () => {
    const { text } = exportCedar([]);
    expect(text.endsWith('\n\n')).toBe(true);
    expect(cedar.policySetTextToParts(text)).toEqual({
      type: 'success',
      policies: [],
      policy_templates: [],
    });
  });

  it('orders statements by policy id whatever the input order', () => {
    const b = { ...OK, id: 'b' };
    const a = { ...OK, id: 'a' };
    expect(exportCedar([b, a]).text).toBe(exportCedar([a, b]).text);
    expect(exportAgt([b, a], []).text).toBe(exportAgt([a, b], []).text);
  });

  it('lists every inventory tool in the AGT catalog, and every tool a policy names', () => {
    const { text } = exportAgt(
      [{ ...OK, targets: { tools: ['named_only'] } }],
      [{ tool_ref: 'inventory_only' }, { tool_ref: 'inventory_only' }]
    );
    expect(text).toContain(
      'tools:\n  inventory_only:\n    noblecloak_tool_ref: "inventory_only"\n  named_only:'
    );
  });

  it('writes an empty catalog as {} and no approval block without a resolver', () => {
    const { text } = exportAgt([], []);
    expect(text).toContain('\ntools: {}\n');
    expect(text).not.toContain('approval:');
  });
});

describe('cedarString', () => {
  it('escapes quotes, backslashes, line breaks and controls, and keeps printable text', () => {
    expect(cedarString('a"b\\c\nd\re\tf\u0000\u0085\u2028\ufeffé🛡')).toBe(
      '"a\\"b\\\\c\\nd\\re\\tf\\u{0}\\u{85}\\u{2028}\\u{feff}é🛡"'
    );
  });

  it('round-trips every code point of the Basic Multilingual Plane outside the surrogates through Cedar', () => {
    let text = '';
    for (let code = 0; code <= 0xffff; code += 1)
      if (code < 0xd800 || code > 0xdfff) text += String.fromCharCode(code);
    const answer = cedar.policyToJson(
      `permit (principal, action, resource == Tool::${cedarString(text)});`
    );
    expect(answer.type).toBe('success');
    if (answer.type === 'success')
      expect((answer.json.resource as { entity: { id: string } }).entity.id).toBe(text);
  });
});

describe('the YAML printer', () => {
  it('writes nested values in block style with sorted keys and every string double-quoted', () => {
    expect(member('approval', { b: [1, { y: false, x: null }, []], a: 'q"\u0085', c: {} })).toEqual(
      [
        'approval:',
        '  a: "q\\"\\u0085"',
        '  b:',
        '    - 1',
        '    - x: null',
        '      "y": false',
        '    - []',
        '  c: {}',
      ]
    );
    expect(yamlLines([['a']])).toEqual(['- - "a"']);
  });
});

describe('the comment block', () => {
  it('every note and line an export writes begins as HEADER_LINE_STARTS lists, so an import recognises the block', () => {
    const policies: ExportablePolicy[] = [
      OK,
      {
        ...OK,
        id: 'ask',
        subjects: [{ type: 'organization' }],
        config: { mode: 'ask', on_deny: 'halt' },
      },
      { ...OK, id: 'role', subjects: [{ type: 'role', id: 'r' }] },
      { ...OK, id: 'ng', config: { mode: 'not_granted' } },
      { ...OK, id: 'bad', kind: 'spending' },
    ];
    const texts = [
      exportCedar(policies).text,
      exportCedar(policies, { baseline: 'allow' }).text,
      ...[
        {},
        { agtVersion: 'main' as const },
        { adviceAwareDispatcher: true },
        { toolNames: { t: 'x' } },
      ].map(
        (opts) =>
          exportAgt([...policies, { ...OK, id: 't', targets: { tools: ['t'] } }], [], opts).text
      ),
    ];
    for (const text of texts) {
      const marker = text.startsWith('#') ? '#' : '//';
      const block = text.slice(0, text.indexOf('\n\n')).split('\n').slice(1);
      expect(block.length).toBeGreaterThan(2);
      for (const line of block)
        expect(
          HEADER_LINE_STARTS.some((start) => line.startsWith(`${marker} ${start}`)),
          line
        ).toBe(true);
    }
  });
});

describe('AGT 5.0 reports', () => {
  it('says the manifest needs a host-registered Cedar dispatcher, and that an advice-aware export relies on the host', () => {
    const ask: ExportablePolicy = { ...OK, config: { mode: 'ask' } };
    const v5 = exportAgt([ask], [], { adviceAwareDispatcher: true });
    expect(
      v5.notes.some((note) => note.startsWith('AGT 5.0 evaluates a Cedar policy only through'))
    ).toBe(true);
    expect(v5.lossy[0]?.reason).toContain('the bundled Cedar dispatcher would allow the call');
    const main = exportAgt([ask], [], { agtVersion: 'main' });
    expect(main.notes.some((note) => note.startsWith('AGT 5.0'))).toBe(false);
    expect(main.lossy[0]?.reason).not.toContain('bundled');
  });
});

describe('export: members beyond the policy content', () => {
  it('reports unenforced targets and unknown members as lossy; deployment state is not reported', () => {
    const read = {
      ...OK,
      targets: { tools: ['gone', 'wire'] },
      config: { mode: 'always_allow' },
      version: 3,
      source: 'authored',
      state: 'draft',
      published_at: null,
      origin: { format: 'cedar', digest: 'x' },
      unenforced_targets: ['gone'],
      priority: 1,
    } as unknown as ExportablePolicy;
    for (const result of [exportCedar([read]), exportAgt([read], [])]) {
      expect(result.unsupported).toEqual([]);
      expect(result.lossy.map((entry) => entry.path).sort()).toEqual([
        '/0/priority',
        '/0/unenforced_targets',
      ]);
    }
    expect(
      exportCedar([{ ...read, unenforced_targets: [] } as ExportablePolicy]).lossy.map(
        (e) => e.path
      )
    ).toEqual(['/0/priority']);
  });

  it('a targets member other than tools makes the policy unsupported', () => {
    const narrowed = {
      ...OK,
      targets: { tools: 'all', exclude: ['admin'] },
    } as unknown as ExportablePolicy;
    expect(exportCedar([narrowed]).unsupported.map((entry) => entry.path)).toEqual([
      '/0/targets/exclude',
    ]);
    expect(
      exportCedar([{ ...OK, targets: 'all' } as unknown as ExportablePolicy]).unsupported.map(
        (e) => e.path
      )
    ).toEqual(['/0/targets']);
  });

  it('counts name and description limits in code points, as the contract does', () => {
    expect(exportCedar([{ ...OK, name: '🛡'.repeat(200) }]).unsupported).toEqual([]);
    expect(exportCedar([{ ...OK, name: '🛡'.repeat(201) }]).unsupported.map((e) => e.path)).toEqual([
      '/0/name',
    ]);
    expect(exportCedar([{ ...OK, description: '🛡'.repeat(2000) }]).unsupported).toEqual([]);
  });

  it('refuses an agtVersion that is only an inherited key, and a baseline other than allow', () => {
    expect(() => exportAgt([OK], [], { agtVersion: 'toString' as never })).toThrow(
      PolicyFormatError
    );
    expect(() => exportCedar([OK], { baseline: 'deny' as never })).toThrow(PolicyFormatError);
    expect(() => exportAgt([OK], [], { baseline: 'deny' as never })).toThrow(PolicyFormatError);
  });

  it('report paths index the input array, whatever order the file writes', () => {
    const { lossy } = exportCedar([
      { ...OK, id: 'z', config: { mode: 'ask' } },
      { ...OK, id: 'a', config: { mode: 'not_granted' } },
    ]);
    expect(lossy.map((entry) => [entry.path, entry.policy]).sort()).toEqual([
      ['/0/config/mode', 'z'],
      ['/1/config/mode', 'a'],
    ]);
  });
});
