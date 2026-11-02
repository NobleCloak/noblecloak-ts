import { describe, expect, it } from 'vitest';

import {
  APPROVALS_URL,
  APPROVAL_ID,
  DIGEST,
  OTHER_VIEWER,
  REQUESTER_VIEWER,
  full,
  minimal,
  options,
  priyaResolved,
} from './fixtures.test-support.js';
import type { Approval } from './model.js';
import { CARD_MODEL_VERSION, CHAT_RESOLUTIONS, isResolveAction, toApprovalCard } from './model.js';

describe('model.fields', () => {
  it('maps every row of the facts table, the outcome and the history', () => {
    const card = toApprovalCard(
      full({
        resolution_history: [
          {
            resolution: 'rejected',
            by: { id: 'u-x', kind: 'user' },
            at: '2026-10-30T09:30:00Z',
            reason: 'no',
          },
        ],
      }),
      OTHER_VIEWER,
      options()
    );
    expect(card.version).toBe(CARD_MODEL_VERSION);
    expect(card.approvalId).toBe(APPROVAL_ID);
    expect(card.header.toolRef).toBe('payments.refund');
    expect(card.details).toEqual({
      sideEffectLevel: 'write',
      obligationKind: 'tool_invocation',
      requester: {
        id: 'u-dana',
        kind: 'user',
        displayName: 'Dana Ruiz',
        text: 'Dana Ruiz (u-dana)',
      },
      agent: {
        id: 'agent-7',
        kind: 'agent',
        displayName: 'Payables Agent',
        text: 'Payables Agent (agent-7)',
        parent: 'agent-1',
      },
      run: { id: 'run-5', kind: 'governed' },
      scopeId: 'scope-1',
      policy: { id: 'pol-1', version: 3 },
      continuationKind: 'resume_run',
      createdAt: '2026-10-30T09:00:00Z',
      expiresAt: '2026-10-31T09:00:00Z',
      waitingOn: {
        count: 2,
        principals: [
          { id: 'u-priya', kind: 'user', displayName: 'Priya', text: 'Priya (u-priya)' },
          { id: 'u-sam', kind: 'user', text: 'u-sam' },
        ],
      },
      actionDigest: DIGEST,
      history: [
        {
          resolution: 'rejected',
          by: { id: 'u-x', kind: 'user', text: 'u-x' },
          at: '2026-10-30T09:30:00Z',
          reason: 'no',
        },
      ],
    });
    expect(card.links.open).toBe(APPROVALS_URL);
  });

  it('builds from a read with only the required members, and leaves absent members absent', () => {
    const card = toApprovalCard(minimal(), OTHER_VIEWER, options());
    expect(Object.keys(card.details).sort()).toEqual(
      [
        'actionDigest',
        'createdAt',
        'history',
        'obligationKind',
        'scopeId',
        'sideEffectLevel',
      ].sort()
    );
    expect(card.header.principals).toEqual([]);
    expect('owner' in card.header).toBe(false);
    expect('notice' in card).toBe(false);
    expect(card.header.headline).toBe('A request to call `payments.refund`');
  });

  it('treats a malformed optional member as absent and does not throw', () => {
    const broken = minimal({
      requester: 'nobody',
      agent: { name: 'no id' },
      run: { id: 5 },
      policy: { id: 'p' },
      waiting_on: { count: 'many' },
      expires_at: null,
      resolution_history: [
        { by: null },
        'x',
        { resolution: 'approved', by: null, at: 't' },
        { resolution: 'approved', by: { id: 'u' } },
        { by: { id: 'u' }, at: 't' },
        { resolution: 'approved', by: { id: 'u' }, at: 't' },
      ],
      arguments: 'not an object',
      available_actions: 'nope',
    } as unknown as Partial<Approval>);
    const card = toApprovalCard(broken, OTHER_VIEWER, options());
    expect(card.details.requester).toBeUndefined();
    expect(card.details.agent).toBeUndefined();
    expect(card.details.run).toBeUndefined();
    expect(card.details.policy).toBeUndefined();
    expect(card.details.waitingOn).toBeUndefined();
    expect('expiresAt' in card.details).toBe(false);
    expect(card.details.history).toHaveLength(1);
    expect(card.facts.call).toEqual({ kind: 'link', why: 'unreadable' });
    expect(card.actions.map((a) => a.id)).toEqual(['approve', 'deny']);
  });
});

describe('model.header', () => {
  it('lists the requester then the agent, with no owner, reason or references', () => {
    const card = toApprovalCard(full(), OTHER_VIEWER, options());
    expect(card.header.principals.map((p) => p.id)).toEqual(['u-dana', 'agent-7']);
    expect(card.header.principals[1]?.kind).toBe('agent');
    expect('owner' in card.header).toBe(false);
    expect('reason' in card).toBe(false);
    expect('references' in card).toBe(false);
    expect(card.header.headline).toBe(
      'Payables Agent (for Dana Ruiz) is asking to call `payments.refund`'
    );
  });

  it('words the headline for each of the known principals', () => {
    const requesterOnly = toApprovalCard(
      full({ agent: undefined as never }),
      OTHER_VIEWER,
      options()
    );
    expect(requesterOnly.header.headline).toBe('Dana Ruiz is asking to call `payments.refund`');
    const agentOnly = toApprovalCard(
      full({ requester: undefined as never }),
      OTHER_VIEWER,
      options()
    );
    expect(agentOnly.header.headline).toBe('Payables Agent is asking to call `payments.refund`');
  });

  it('reads Name (id), and the id alone when the name is missing, empty or equal to the id', () => {
    const named = (display_name?: string) =>
      toApprovalCard(
        minimal({
          requester: {
            id: 'u-1',
            kind: 'user',
            ...(display_name === undefined ? {} : { display_name }),
          },
        }),
        OTHER_VIEWER,
        options()
      ).details.requester?.text;
    expect(named('Ann')).toBe('Ann (u-1)');
    expect(named('u-1')).toBe('u-1');
    expect(named('')).toBe('u-1');
    expect(named()).toBe('u-1');
  });
});

describe('model.arguments-or-link', () => {
  const call = (over: Partial<Approval>, blockCallInChat = false) =>
    toApprovalCard(full(over), OTHER_VIEWER, options({ blockCallInChat })).facts.call;

  it('shows the arguments only when pending, present and not blocked', () => {
    expect(call({})).toEqual({ kind: 'arguments', arguments: { amount: 42, ticket: 'T-9' } });
  });

  it('gives a link with the matching reason for each failing condition', () => {
    expect(call({}, true)).toEqual({ kind: 'link', why: 'blocked' });
    expect(call({ arguments: undefined as never })).toEqual({ kind: 'link', why: 'not_on_read' });
    for (const state of ['approved', 'consumed', 'rejected', 'expired', 'withdrawn'] as const) {
      expect(call({ state })).toEqual({ kind: 'link', why: 'final' });
      expect(call({ state }, true)).toEqual({ kind: 'link', why: 'final' });
    }
  });

  it('blocks the call unless the options say false', () => {
    const open = { ...options(), blockCallInChat: undefined } as unknown as ReturnType<
      typeof options
    >;
    expect(toApprovalCard(full(), OTHER_VIEWER, open).facts.call).toEqual({
      kind: 'link',
      why: 'blocked',
    });
  });
});

describe('model.final', () => {
  const FINAL_CASES: readonly [Approval['state'], string, string | undefined, string, string][] = [
    [
      'approved',
      'approved',
      'refund matches ticket',
      'u-priya',
      'You approved · refund matches ticket',
    ],
    ['rejected', 'rejected', 'wrong amount', 'u-priya', 'You denied · wrong amount'],
    ['consumed', 'approved', undefined, 'u-priya', 'You approved'],
    ['approved', 'approved', undefined, 'someone-else', 'Handled by Priya (u-priya) · Approved'],
    ['consumed', 'approved', undefined, 'someone-else', 'Handled by Priya (u-priya) · Approved'],
    ['rejected', 'rejected', undefined, 'someone-else', 'Handled by Priya (u-priya) · Denied'],
  ];

  it.each(FINAL_CASES)(
    'renders %s (%s) as a digest-only card for the viewer',
    (state, resolution, note, viewer, line) => {
      const card = toApprovalCard(
        full(priyaResolved(state, resolution, note)),
        { principalId: viewer },
        options()
      );
      expect(card.facts.call).toEqual({ kind: 'link', why: 'final' });
      expect(card.actions).toEqual([]);
      expect(card.status.line).toBe(line);
      expect(card.selfApproval).toBe(false);
      expect(card.viewerRole).toBe(viewer === 'u-priya' ? 'decided_by_viewer' : 'other');
      expect(card.details.actionDigest).toBe(DIGEST);
    }
  );

  it('says Withdrawn and Expired', () => {
    expect(toApprovalCard(full({ state: 'withdrawn' }), OTHER_VIEWER, options()).status.line).toBe(
      'Withdrawn'
    );
    expect(toApprovalCard(full({ state: 'expired' }), OTHER_VIEWER, options()).status.line).toBe(
      'Expired'
    );
  });

  it('names no approver when the read has none, and says so of a state it does not know', () => {
    expect(
      toApprovalCard(full({ state: 'approved', resolution: 'approved' }), OTHER_VIEWER, options())
        .status.line
    ).toBe('Handled · Approved');
    expect(
      toApprovalCard(full({ state: 'rejected', resolution: 'rejected' }), OTHER_VIEWER, options())
        .status.line
    ).toBe('Handled · Denied');
    const odd = toApprovalCard(full({ state: 'archived' as never }), OTHER_VIEWER, options());
    expect(odd.status.line).toBe('Status unknown');
    expect(odd.status.requirements[0]?.state).toBe('unknown');
    expect(odd.actions).toEqual([]);
  });

  it('records the requirement', () => {
    const card = toApprovalCard(
      full(priyaResolved('consumed', 'approved', 'ok')),
      REQUESTER_VIEWER,
      options()
    );
    expect(card.status.requirements).toEqual([
      {
        id: 'approval',
        state: 'approved',
        decidedBy: { id: 'u-priya', kind: 'user', displayName: 'Priya', text: 'Priya (u-priya)' },
        decidedAt: '2026-10-30T10:00:00Z',
        note: 'ok',
      },
    ]);
  });

  it('records a pending requirement with no decision', () => {
    const card = toApprovalCard(full(), OTHER_VIEWER, options());
    expect(card.status.requirements).toEqual([{ id: 'approval', state: 'pending' }]);
    expect(card.status.line).toBe('Waiting for a decision');
    expect(card.viewerRole).toBe('approver');
  });
});

describe('model.actions', () => {
  const listed = (actions: unknown): Partial<Approval> => ({ available_actions: actions as never });
  const input = { name: 'reason', type: 'text', label: 'Why?', required: true, max_length: 200 };

  it('uses available_actions over the capabilities and keeps its label and inputs', () => {
    const card = toApprovalCard(
      full(
        listed([
          {
            id: 'decline',
            kind: 'resolve',
            resolution: 'rejected',
            label: 'Decline',
            inputs: [input],
          },
        ])
      ),
      OTHER_VIEWER,
      options()
    );
    expect(card.actions).toEqual([
      {
        kind: 'resolve',
        id: 'decline',
        resolution: 'rejected',
        label: 'Decline',
        style: 'danger',
        inputs: [{ name: 'reason', type: 'text', label: 'Why?', required: true, maxLength: 200 }],
      },
    ]);
  });

  it('derives approve and deny with the note input from the capabilities, offering only the allowlist', () => {
    const card = toApprovalCard(
      full(),
      OTHER_VIEWER,
      options({
        capabilities: { resolutions: ['approved', 'rejected', 'escalated', 'some_new_value'] },
      })
    );
    expect(card.actions).toEqual([
      {
        kind: 'resolve',
        id: 'approve',
        resolution: 'approved',
        label: 'Approve',
        style: 'primary',
        inputs: [
          {
            name: 'reason',
            type: 'text',
            label: 'Note (optional)',
            required: false,
            maxLength: 1000,
          },
        ],
      },
      {
        kind: 'resolve',
        id: 'deny',
        resolution: 'rejected',
        label: 'Deny',
        style: 'danger',
        inputs: [
          {
            name: 'reason',
            type: 'text',
            label: 'Note (optional)',
            required: false,
            maxLength: 1000,
          },
        ],
      },
    ]);
    expect(CHAT_RESOLUTIONS).toEqual(['approved', 'rejected']);
  });

  it('orders approve before deny whatever order the capabilities list', () => {
    const card = toApprovalCard(
      full(),
      OTHER_VIEWER,
      options({ capabilities: { resolutions: ['rejected', 'approved'] } })
    );
    expect(card.actions.map((a) => a.id)).toEqual(['approve', 'deny']);
  });

  it('offers approve alone, or nothing', () => {
    const only = toApprovalCard(
      full(),
      OTHER_VIEWER,
      options({ capabilities: { resolutions: ['approved'] } })
    );
    expect(only.actions.map((a) => a.id)).toEqual(['approve']);
    const none = toApprovalCard(
      full(),
      OTHER_VIEWER,
      options({ capabilities: { resolutions: [] } })
    );
    expect(none.actions).toEqual([]);
  });

  it('treats an empty available_actions as no buttons, not as the capabilities', () => {
    expect(toApprovalCard(full(listed([])), OTHER_VIEWER, options()).actions).toEqual([]);
  });

  it('drops an action of an unknown kind, a resolution outside the allowlist, an unknown input type and a malformed one', () => {
    const resolve = (over: Record<string, unknown>) => ({
      id: 'a',
      kind: 'resolve',
      resolution: 'approved',
      label: 'Go',
      inputs: [],
      ...over,
    });
    const cases: unknown[] = [
      resolve({ kind: 'ask' }),
      resolve({ resolution: 'invented_value' }),
      resolve({ inputs: [{ ...input, type: 'select' }] }),
      resolve({ inputs: 'none' }),
      resolve({ inputs: [{ ...input, name: 'n'.repeat(201) }] }),
      resolve({ inputs: [{ ...input, name: '' }] }),
      resolve({ id: '' }),
      resolve({ id: 'nc.open' }),
      resolve({ id: 'x'.repeat(201) }),
      'string',
      null,
    ];
    for (const bad of cases) {
      expect(toApprovalCard(full(listed([bad])), OTHER_VIEWER, options()).actions).toEqual([]);
    }
    const kept = toApprovalCard(
      full(listed([resolve({ kind: 'ask' }), resolve({ id: 'b' }), resolve({ id: 'b' })])),
      OTHER_VIEWER,
      options()
    );
    expect(kept.actions.map((a) => a.id)).toEqual(['b']);
  });

  it('falls back to a fixed label and a default length, and clamps a long one', () => {
    const card = toApprovalCard(
      full(
        listed([
          {
            id: 'a',
            kind: 'resolve',
            resolution: 'approved',
            label: '',
            inputs: [
              { name: 'n', type: 'text', label: '', required: false, max_length: 99999 },
              { name: 'm', type: 'text', label: 'M', required: false },
            ],
          },
        ])
      ),
      OTHER_VIEWER,
      options()
    );
    const [action] = card.actions;
    if (action === undefined) throw new Error('no action');
    expect(action.label).toBe('Approve');
    expect(action.inputs).toEqual([
      { name: 'n', type: 'text', label: 'n', required: false, maxLength: 3000 },
      { name: 'm', type: 'text', label: 'M', required: false, maxLength: 1000 },
    ]);
    expect(isResolveAction(action)).toBe(true);
  });

  it('offers nothing once the approval is not pending, even when the read lists actions', () => {
    const card = toApprovalCard(
      full({
        state: 'approved',
        ...listed([{ id: 'a', kind: 'resolve', resolution: 'approved', label: 'Go', inputs: [] }]),
      }),
      OTHER_VIEWER,
      options()
    );
    expect(card.actions).toEqual([]);
  });

  it('tells a resolve action from another kind', () => {
    expect(isResolveAction({ kind: 'ask', id: 'x', label: 'Ask', inputs: [] })).toBe(false);
  });
});

describe('model.self', () => {
  it('marks the requester as approving their own request', () => {
    const card = toApprovalCard(full(), REQUESTER_VIEWER, options());
    expect(card.selfApproval).toBe(true);
    expect(card.viewerRole).toBe('self');
    expect(card.status.line).toBe("You're approving your own agent's request");
  });

  it('does not mark another viewer, or a request with no known requester', () => {
    expect(toApprovalCard(full(), OTHER_VIEWER, options()).selfApproval).toBe(false);
    expect(toApprovalCard(minimal(), REQUESTER_VIEWER, options()).selfApproval).toBe(false);
  });

  it('carries the already_handled notice', () => {
    expect(
      toApprovalCard(full(), OTHER_VIEWER, options({ notice: 'already_handled' })).notice
    ).toBe('already_handled');
  });
});

describe('model.source', () => {
  it('never names the internal resolution (the tree scan would refuse it)', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const dir = new URL('.', import.meta.url);
    const needle = ['acted', 'as', 'self'].join('_');
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.ts')) continue;
      expect((await readFile(new URL(name, dir), 'utf8')).includes(needle)).toBe(false);
    }
  });
});
