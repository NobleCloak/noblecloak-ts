import { describe, expect, it } from 'vitest';

import {
  otherViewOf,
  pageOf,
  policyCapabilitiesOf,
  policyEnvelopeOf,
  policyOf,
  simulationOf,
  toolOf,
} from './permissions-parse.js';

const row = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'pol_1',
  version: 2,
  source: 'authored',
  kind: 'tool_invocation',
  name: 'Ask first',
  state: 'published',
  subjects: [{ type: 'role', id: 'member' }],
  targets: { tools: ['mcp:a:b'] },
  config: { mode: 'ask', on_deny: 'halt' },
  published_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  updated_by: { id: 'user_admin', kind: 'user' },
  ...extra,
});

describe('policyOf', () => {
  it('reads a tool_invocation policy as sent', () => {
    expect(policyOf(row())).toEqual({
      id: 'pol_1',
      version: 2,
      source: 'authored',
      kind: 'tool_invocation',
      kindKnown: true,
      name: 'Ask first',
      state: 'published',
      subjects: [{ type: 'role', id: 'member' }],
      targets: ['mcp:a:b'],
      unenforcedTargets: [],
      config: { mode: 'ask', on_deny: 'halt' },
      mode: 'ask',
      modeKnown: true,
      publishedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      updatedBy: { id: 'user_admin', kind: 'user' },
    });
  });

  it('keeps an unknown kind and flags it, with its config opaque and no mode', () => {
    const p = policyOf(row({ kind: 'rate_window', config: { mode: 'ask', per: 'minute' } }));
    expect(p).toMatchObject({ kind: 'rate_window', kindKnown: false, modeKnown: false });
    expect(p?.mode).toBeUndefined();
    expect(p?.config).toEqual({ mode: 'ask', per: 'minute' });
  });

  it('keeps an unknown mode and flags it, never mapping it to a decision', () => {
    const p = policyOf(row({ config: { mode: 'observe' } }));
    expect(p).toMatchObject({ mode: 'observe', modeKnown: false });
    expect(JSON.stringify(p)).not.toMatch(/allow|step_up|"deny"/);
  });

  it('reads targets all, a subject without id, and the state from published_at', () => {
    const p = policyOf(
      row({
        targets: { tools: 'all' },
        subjects: [{ type: 'organization' }],
        state: undefined,
        published_at: null,
      })
    );
    expect(p).toMatchObject({
      targets: 'all',
      subjects: [{ type: 'organization' }],
      state: 'draft',
    });
    expect(policyOf(row({ state: undefined }))?.state).toBe('published');
    expect(policyOf(row({ state: undefined, published_at: undefined }))?.state).toBe('unknown');
  });

  it('reads a state it does not know as unknown, whatever published_at says', () => {
    expect(policyOf(row({ state: 'retired' }))?.state).toBe('unknown');
  });

  it('leaves targets undefined when the service did not state them', () => {
    expect(policyOf(row({ targets: undefined }))?.targets).toBeUndefined();
  });

  it.each([
    ['no id', { id: undefined }],
    ['an empty id', { id: '' }],
    ['a fractional version', { version: 1.5 }],
    ['a negative version', { version: -1 }],
    ['no source', { source: undefined }],
    ['a kind that is not a string', { kind: 3 }],
    ['subjects that are not an array', { subjects: 'role:member' }],
    ['a subject without a type', { subjects: [{ id: 'member' }] }],
    ['a subject id that is not a string', { subjects: [{ type: 'role', id: 3 }] }],
    ['no config', { config: undefined }],
    ['targets of another shape', { targets: { tools: 'some' } }],
    ['a target that is not a string', { targets: { tools: [3] } }],
    ['no targets in the list', { targets: { tools: [] } }],
    ['an empty subject id', { subjects: [{ type: 'role', id: '' }] }],
  ])('refuses a row with %s', (_name, extra) => {
    expect(policyOf(row(extra))).toBeUndefined();
  });
});

describe('pageOf', () => {
  it('reads rows and the next cursor', () => {
    const page = pageOf({ data: [row()], meta: { next: '50' } }, policyOf);
    expect(page?.rows.map((p) => p.id)).toEqual(['pol_1']);
    expect(page?.next).toBe('50');
    expect(pageOf({ data: [], meta: { next: null } }, policyOf)?.next).toBeUndefined();
  });

  it('is undefined without meta, or with a next that is not a cursor', () => {
    expect(pageOf({ data: [] }, policyOf)).toBeUndefined();
    expect(pageOf({ data: [], meta: { next: 2 } }, policyOf)).toBeUndefined();
    expect(pageOf({ data: [], meta: { next: '' } }, policyOf)).toBeUndefined();
    expect(pageOf({ data: [], meta: {} }, policyOf)?.next).toBeUndefined();
  });

  it('is undefined when one row cannot be read: a malformed list is an error, never an empty list', () => {
    expect(pageOf({ data: [row(), { id: 'x' }], meta: {} }, policyOf)).toBeUndefined();
    expect(pageOf({ data: 'nope' }, policyOf)).toBeUndefined();
    expect(pageOf(undefined, policyOf)).toBeUndefined();
  });
});

describe('policyEnvelopeOf', () => {
  it('reads the envelope', () => {
    expect(policyEnvelopeOf({ data: row() })?.id).toBe('pol_1');
    expect(policyEnvelopeOf({ data: { id: 'x' } })).toBeUndefined();
  });
});

describe('unenforced targets', () => {
  it('keeps each once, in the order sent', () => {
    expect(
      policyOf({
        id: 'p',
        version: 1,
        source: 'authored',
        kind: 'tool_invocation',
        subjects: [],
        config: { mode: 'ask' },
        unenforced_targets: ['t:b', 't:a', 't:b', 7],
      })?.unenforcedTargets
    ).toEqual(['t:b', 't:a']);
  });
});

describe('toolOf', () => {
  it('reads a tool, with a null connection', () => {
    expect(
      toolOf({
        id: 't1',
        tool_ref: 'mcp:a:b',
        connection_id: null,
        side_effect_level: 'write',
        transport: 'mcp',
        data_routing: 'org_only',
      })
    ).toEqual({
      id: 't1',
      toolRef: 'mcp:a:b',
      connectionId: null,
      sideEffectLevel: 'write',
      status: 'active',
      statusKnown: true,
    });
    expect(toolOf({ id: 't1' })).toBeUndefined();
  });

  it('reads a status: withdrawn as known, and an unknown or non-text one kept and flagged', () => {
    const row = { id: 't1', tool_ref: 'mcp:a:b' };
    expect(toolOf({ ...row, status: 'withdrawn' })).toMatchObject({
      status: 'withdrawn',
      statusKnown: true,
    });
    expect(toolOf({ ...row, status: 'active' })).toMatchObject({
      status: 'active',
      statusKnown: true,
    });
    expect(toolOf({ ...row, status: 'paused' })).toMatchObject({
      status: 'paused',
      statusKnown: false,
    });
    expect(toolOf({ ...row, status: 3 })).toMatchObject({ status: '3', statusKnown: false });
    expect(toolOf({ ...row, status: '' })).toMatchObject({ status: '""', statusKnown: false });
    expect(toolOf({ ...row, status: null })).toMatchObject({ status: 'null', statusKnown: false });
  });
});

describe('policyCapabilitiesOf', () => {
  it('reads the facts from features, entitlements and resolutions, never the deployment', () => {
    const facts = policyCapabilitiesOf({
      data: {
        deployment: 'edge',
        features: ['policies', 'policies.author', 'principals', 'runs', 'policies.tightest_wins'],
        entitlements: ['policies.suggested'],
        resolutions: ['approved'],
      },
    });
    expect(facts).toEqual({
      served: true,
      author: true,
      publish: false,
      importExport: false,
      principals: true,
      connections: false,
      runs: true,
      suggested: true,
      approvals: true,
      tightestWins: true,
      retire: false,
    });
    expect(policyCapabilitiesOf({ data: { features: ['policies'] } })?.tightestWins).toBe(false);
    expect(
      policyCapabilitiesOf({ data: { features: ['policies', 'policies.retire'] } })?.retire
    ).toBe(true);
  });

  it('is undefined without features', () => {
    expect(policyCapabilitiesOf({ data: { resolutions: [] } })).toBeUndefined();
  });
});

describe('rev 11 policy members', () => {
  it('reads draft_version, origin and the advertised policy forms', () => {
    expect(policyOf(row({ draft_version: 4 }))?.draftVersion).toBe(4);
    expect(policyOf(row({ draft_version: 'x' }))).not.toHaveProperty('draftVersion');
    expect(policyOf(row({ origin: { format: 'cedar', digest: 'ab' } }))?.origin).toEqual({
      format: 'cedar',
      digest: 'ab',
    });
    expect(policyOf(row({ origin: { format: 'cedar' } }))).not.toHaveProperty('origin');
    const forms = {
      tool_invocation: {
        modes: ['ask'],
        subject_types: ['role'],
        targets_all: false,
        config_members: ['on_deny'],
      },
    };
    expect(
      policyCapabilitiesOf({ data: { features: ['policies'], policy_forms: forms } })?.policyForms
    ).toEqual({
      toolInvocation: {
        modes: ['ask'],
        subjectTypes: ['role'],
        targetsAll: false,
        configMembers: ['on_deny'],
      },
    });
    expect(policyCapabilitiesOf({ data: { features: ['policies'] } })).not.toHaveProperty(
      'policyForms'
    );
    expect(
      policyCapabilitiesOf({
        data: { features: ['policies'], policy_forms: { tool_invocation: { modes: 'ask' } } },
      })?.policyForms
    ).toEqual({});
  });
});

describe('contributed', () => {
  const answer = (entry: Record<string, unknown>) => ({
    data: {
      decision: 'deny',
      action_digest: 'sha256:x',
      enforced: false,
      considered: {
        policies: [{ kind: 'tool_invocation', id: 'p1', version: 1, result: 'deny', ...entry }],
        composed: { decision: 'deny' },
      },
    },
  });
  it('is kept as sent, absent when not sent, and a non-boolean makes the answer unreadable', () => {
    expect(
      simulationOf(answer({ contributed: true }), 'p1', new Map())?.considered?.policies[0]
    ).toMatchObject({
      contributed: true,
    });
    expect(
      simulationOf(answer({ contributed: false }), 'p1', new Map())?.considered?.policies[0]
        ?.contributed
    ).toBe(false);
    expect(simulationOf(answer({}), 'p1', new Map())?.considered?.policies[0]).not.toHaveProperty(
      'contributed'
    );
    expect(simulationOf(answer({ contributed: 'yes' }), 'p1', new Map())).toBeUndefined();
  });
});

describe('otherViewOf', () => {
  it('summarizes a duplicate_requests policy and leaves every other kind opaque', () => {
    const dup = policyOf(
      row({
        kind: 'duplicate_requests',
        config: { after_rejection: 'ask_again', max_reasks: 2, window_seconds: 600 },
      })
    );
    const spending = policyOf(row({ kind: 'spending', config: { limit: { amount: 1 } } }));
    const unknown = policyOf(row({ kind: 'rate_window', config: {} }));
    expect(dup && otherViewOf(dup)).toEqual({
      kind: 'duplicate_requests',
      afterRejection: 'ask_again',
      maxReasks: 2,
      windowSeconds: 600,
    });
    expect(spending && otherViewOf(spending)).toEqual({ kind: 'opaque' });
    expect(unknown && otherViewOf(unknown)).toEqual({ kind: 'opaque' });
    const broken = policyOf(row({ kind: 'duplicate_requests', config: { after: 1 } }));
    expect(broken && otherViewOf(broken)).toEqual({ kind: 'opaque' });
  });
});

describe('simulationOf', () => {
  const body = (extra: Record<string, unknown> = {}): unknown => ({
    data: {
      decision: 'step_up',
      reason: 'approval_required',
      action_digest: 'a'.repeat(64),
      enforced: false,
      would_be: 'step_up',
      policy: { id: 'pol_1', version: 2, side_effect_level: 'write' },
      considered: {
        policies: [
          {
            kind: 'tool_invocation',
            id: 'pol_1',
            version: 2,
            result: 'ask',
            subject: { type: 'role', id: 'member' },
          },
          {
            kind: 'duplicate_requests',
            id: null,
            version: null,
            result: 'none',
            source: 'default',
          },
        ],
        composed: { decision: 'step_up', reason: 'approval_required' },
      },
      ...extra,
    },
  });

  it('reads the decision and considered, with names from the list and null-id defaults', () => {
    const result = simulationOf(body(), 'pol_1', new Map([['pol_1', 'Ask first']]));
    expect(result).toMatchObject({
      decision: 'step_up',
      enforced: false,
      wouldBe: 'step_up',
      policy: { id: 'pol_1', version: 2, sideEffectLevel: 'write' },
      appliesToCaller: true,
    });
    expect(result?.considered?.policies).toEqual([
      {
        kind: 'tool_invocation',
        id: 'pol_1',
        version: 2,
        result: 'ask',
        subject: { type: 'role', id: 'member' },
        name: 'Ask first',
      },
      { kind: 'duplicate_requests', id: null, version: null, result: 'none', source: 'default' },
    ]);
    expect(result?.considered?.composed).toEqual({
      decision: 'step_up',
      reason: 'approval_required',
    });
  });

  it('says the policy does not apply when no entry carries its id', () => {
    expect(simulationOf(body({ policy: undefined }), 'pol_9', new Map())?.appliesToCaller).toBe(
      false
    );
  });

  it('is still a result without considered, and then cannot tell whether the policy applied', () => {
    const result = simulationOf(
      body({ considered: undefined, policy: undefined }),
      'pol_1',
      new Map()
    );
    expect(result?.considered).toBeUndefined();
    expect(result?.appliesToCaller).toBeUndefined();
    expect(simulationOf(body({ considered: undefined }), 'pol_1', new Map())?.appliesToCaller).toBe(
      true
    );
  });

  it('keeps a decision value it does not know as sent', () => {
    expect(simulationOf(body({ decision: 'defer' }), 'pol_1', new Map())?.decision).toBe('defer');
  });

  it.each([
    ['no decision', { decision: undefined }],
    ['no digest', { action_digest: undefined }],
    ['no enforced', { enforced: undefined }],
    [
      'a considered entry without result',
      {
        considered: {
          policies: [{ kind: 'x', id: null, version: null }],
          composed: { decision: 'deny' },
        },
      },
    ],
    ['considered without composed', { considered: { policies: [] } }],
    ['a policy without a readable id', { policy: { id: 3, version: 2 } }],
    [
      'a side_effect_level that is not text',
      { policy: { id: 'pol_1', version: 2, side_effect_level: 1 } },
    ],
    [
      'a composed reason that is not text',
      { considered: { policies: [], composed: { decision: 'deny', reason: 1 } } },
    ],
    [
      'a considered source that is not text',
      {
        considered: {
          policies: [{ kind: 'x', id: null, version: null, result: 'none', source: 2 }],
          composed: { decision: 'deny' },
        },
      },
    ],
    ['a policy that is not an object', { policy: 'pol_1' }],
    ['a would_be that is not text', { would_be: 1 }],
    ['a rejected_approval_id that is not text', { rejected_approval_id: {} }],
    ['a reason that is not text', { reason: false }],
  ])('refuses a body with %s', (_name, extra) => {
    expect(simulationOf(body(extra), 'pol_1', new Map())).toBeUndefined();
  });
});
