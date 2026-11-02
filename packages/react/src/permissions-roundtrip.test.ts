import { describe, expect, it } from 'vitest';

import { policyOf } from './permissions-parse.js';
import {
  contentOf,
  exportableOf,
  matchOf,
  refusedMembers,
  workingCopyOf,
} from './permissions-roundtrip.js';
import type { PolicyFormsFacts, PolicyInfo } from './permissions-types.js';

function policy(id: string, extra: Record<string, unknown> = {}): PolicyInfo {
  const parsed = policyOf({
    id,
    version: 2,
    source: 'authored',
    kind: 'tool_invocation',
    name: `name of ${id}`,
    state: 'published',
    subjects: [{ type: 'role', id: 'member' }, { type: 'organization' }],
    targets: { tools: ['t:a', 't:b'] },
    config: { mode: 'ask', on_deny: 'halt' },
    published_at: '2026-10-01T00:00:00.000Z',
    ...extra,
  });
  if (parsed === undefined) throw new Error('fixture does not parse');
  return parsed;
}

const FORMS: PolicyFormsFacts = {
  toolInvocation: {
    modes: ['always_allow', 'ask', 'deny'],
    subjectTypes: ['role', 'user', 'organization'],
    targetsAll: false,
    configMembers: ['on_deny'],
  },
};

describe('round-trip helpers', () => {
  it('writes a version as PolicyWrite content, and as an exportable with its id', () => {
    expect(contentOf(policy('p1'))).toEqual({
      kind: 'tool_invocation',
      name: 'name of p1',
      subjects: [{ type: 'role', id: 'member' }, { type: 'organization' }],
      targets: { tools: ['t:a', 't:b'] },
      config: { mode: 'ask', on_deny: 'halt' },
    });
    expect(exportableOf(policy('p1'))).toMatchObject({ id: 'p1', kind: 'tool_invocation' });
    expect(contentOf(policy('p2', { targets: { tools: 'all' } }))?.targets).toEqual({
      tools: 'all',
    });
    expect(contentOf(policy('p3', { targets: undefined }))).toBeUndefined();
    expect(exportableOf(policy('p3', { targets: undefined }))).toBeUndefined();
  });

  it('turns content back into the working copy a save writes', () => {
    const content = contentOf(policy('p1'));
    if (content === undefined) throw new Error('no content');
    expect(workingCopyOf(content)).toEqual({
      kind: 'tool_invocation',
      name: 'name of p1',
      subjects: [{ type: 'role', id: 'member' }, { type: 'organization' }],
      targets: ['t:a', 't:b'],
      config: { mode: 'ask', on_deny: 'halt' },
    });
    expect(workingCopyOf({ ...content, targets: { tools: 'all' } }).targets).toBe('all');
  });

  it('names each member the advertised forms do not take, and nothing when none are advertised', () => {
    const ok = contentOf(policy('p1'));
    if (ok === undefined) throw new Error('no content');
    expect(refusedMembers(ok, FORMS)).toEqual([]);
    expect(refusedMembers(ok, undefined)).toEqual([]);
    expect(refusedMembers(ok, {})).toEqual([]);
    expect(
      refusedMembers(
        {
          ...ok,
          subjects: [{ type: 'agent', id: 'a1' }],
          targets: { tools: 'all' },
          config: { mode: 'escalate', on_deny: 'halt', expires_after: 'PT1H' },
        },
        FORMS
      )
    ).toEqual(['config.mode', 'subjects', 'targets', 'config.expires_after']);
    // Another kind is not judged by the tool_invocation forms.
    expect(refusedMembers({ ...ok, kind: 'duplicate_requests', config: { x: 1 } }, FORMS)).toEqual(
      []
    );
  });

  it('matches an imported policy by its key exactly, else it is new', () => {
    const listed = [policy('pol_a'), policy('pol_b')];
    expect(matchOf('pol_b', listed)?.id).toBe('pol_b');
    expect(matchOf('POL_B', listed)).toBeUndefined();
    expect(matchOf(undefined, listed)).toBeUndefined();
  });
});
