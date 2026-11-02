import { describe, expect, it } from 'vitest';

import { canonicalPolicy, normalizePolicy } from './canonical.js';
import { detectFormat } from './detect.js';
import { diffPolicies } from './diff.js';
import type { Policy, PolicyWrite } from './types.js';

const BASE: PolicyWrite = {
  kind: 'tool_invocation',
  name: 'n',
  subjects: [
    { type: 'user', id: 'b' },
    { type: 'role', id: 'admin' },
    { type: 'organization' },
    { type: 'user', id: 'a' },
  ],
  targets: { tools: ['z', 'a', 'z'] },
  config: { mode: 'ask', approver_groups: ['second', 'first'] },
};

describe('canonicalPolicy', () => {
  it('is RFC 8785 JSON with subjects sorted by type then id, tools sorted with duplicates kept, approver_groups in order', () => {
    expect(canonicalPolicy(BASE)).toBe(
      '{"config":{"approver_groups":["second","first"],"mode":"ask"},"kind":"tool_invocation","name":"n",' +
        '"subjects":[{"type":"organization"},{"id":"admin","type":"role"},{"id":"a","type":"user"},{"id":"b","type":"user"}],' +
        '"targets":{"tools":["a","z","z"]}}'
    );
  });

  it('makes targets explicit: absent is every tool', () => {
    const rest: PolicyWrite = { kind: BASE.kind, subjects: BASE.subjects, config: BASE.config };
    expect(normalizePolicy(rest).targets).toEqual({ tools: 'all' });
    expect(canonicalPolicy(rest)).toBe(canonicalPolicy({ ...rest, targets: { tools: 'all' } }));
  });

  it('keeps absent and empty description apart, and fills in no default', () => {
    expect(canonicalPolicy({ ...BASE, description: '' })).not.toBe(canonicalPolicy(BASE));
    expect(normalizePolicy(BASE).config).toEqual({
      mode: 'ask',
      approver_groups: ['second', 'first'],
    });
  });

  it('reads only the PolicyWrite members, so a read Policy equals the write it came from', () => {
    const read: Policy = {
      ...BASE,
      id: 'pol_1',
      version: 3,
      source: 'authored',
      state: 'published',
      published_at: null,
      unenforced_targets: ['z'],
    };
    expect(canonicalPolicy(read)).toBe(canonicalPolicy(BASE));
  });

  it('treats an undefined member as absent', () => {
    const withUndefined = { ...BASE, description: undefined } as unknown as PolicyWrite;
    expect(canonicalPolicy(withUndefined)).toBe(canonicalPolicy(BASE));
  });

  it('orders by UTF-16 code unit, as JCS does', () => {
    const policy: PolicyWrite = { ...BASE, targets: { tools: ['\u{1F600}', '～', 'a'] } };
    expect(normalizePolicy(policy).targets).toEqual({ tools: ['a', '\u{1F600}', '～'] });
  });
});

describe('diffPolicies', () => {
  it('is empty for the same policy in another order', () => {
    const reordered: PolicyWrite = {
      ...BASE,
      subjects: [...BASE.subjects].reverse(),
      targets: { tools: ['z', 'z', 'a'] },
    };
    expect(diffPolicies(BASE, reordered)).toEqual([]);
  });

  it('lists subjects and tools added and removed (tools as a multiset), config members and other members', () => {
    const incoming: PolicyWrite = {
      kind: 'tool_invocation',
      description: 'new',
      subjects: [
        { type: 'user', id: 'a' },
        { type: 'role', id: 'admin' },
        { type: 'agent', id: 'x' },
      ],
      targets: { tools: ['a', 'z', 'y'] },
      config: { mode: 'ask', approver_groups: ['first', 'second'], on_deny: 'halt' },
    };
    expect(diffPolicies(BASE, incoming)).toEqual([
      { path: '/name', op: 'remove', before: 'n' },
      { path: '/description', op: 'add', after: 'new' },
      { path: '/subjects', op: 'remove', before: { type: 'organization' } },
      { path: '/subjects', op: 'remove', before: { type: 'user', id: 'b' } },
      { path: '/subjects', op: 'add', after: { type: 'agent', id: 'x' } },
      { path: '/targets/tools', op: 'remove', before: 'z' },
      { path: '/targets/tools', op: 'add', after: 'y' },
      {
        path: '/config/approver_groups',
        op: 'replace',
        before: ['second', 'first'],
        after: ['first', 'second'],
      },
      { path: '/config/on_deny', op: 'add', after: 'halt' },
    ]);
  });

  it('replaces targets.tools when one side is every tool', () => {
    expect(diffPolicies(BASE, { ...BASE, targets: { tools: 'all' } })).toEqual([
      { path: '/targets/tools', op: 'replace', before: ['a', 'z', 'z'], after: 'all' },
    ]);
  });

  it('with no current version, adds the whole canonical policy at the root', () => {
    expect(diffPolicies(undefined, BASE)).toEqual([
      { path: '', op: 'add', after: normalizePolicy(BASE) },
    ]);
  });
});

describe('detectFormat', () => {
  it.each([
    ['agt', 'agent_control_specification_version: "0.3.1-beta"\npolicies: {}\n'],
    ['agt', '\ufeff# c\nagent_control_specification_version: x\n'],
    ['cedar', 'permit (principal, action, resource);'],
    ['cedar', '// header\n// more\n\n@id("x")\nforbid (principal, action, resource);'],
    ['cedar', '  forbid(principal, action, resource);'],
    [undefined, ''],
    [undefined, 'name: value\n'],
    [undefined, 'permitted: yes'],
    [undefined, '{ not: [valid'],
    ['agt', 'agent_control_specification_version: "0.3.1-beta"\nx: 1\nx: 2\n'],
    ['agt', 'agent_control_specification_version: "0.3.1-beta"\n---\nb: 2\n'],
    [
      'cedar',
      '// NobleCloak tool_invocation policies, written by @noblecloak/policy-formats.\n// Format: Cedar.\n\n',
    ],
  ] as const)('%s for %j', (expected, text) => {
    expect(detectFormat(text)).toBe(expected);
  });
});
