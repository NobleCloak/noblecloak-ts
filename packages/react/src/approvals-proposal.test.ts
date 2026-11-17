import { describe, expect, it } from 'vitest';

import { PROPOSE_POLICY_SET_TOOL, readProposal, shortToolRef } from './approvals-proposal.js';
import type { Proposal, ProposalReading } from './approvals-proposal.js';
import type { JsonObject } from './approvals-types.js';

const assessment = { side_effect_level: 'write', blast_radius: 'one_record' };
const entry = (role: string, subject: unknown, tool: string, mode: string): unknown => ({
  role,
  rationale: 'Because.',
  assessment,
  policy: {
    kind: 'tool_invocation',
    subjects: [subject],
    targets: { tools: [tool] },
    config: { mode },
  },
});
const everyone = { type: 'role', id: 'everyone' };

const args = (extra: Record<string, unknown> = {}): JsonObject => ({
  policies: [entry('baseline', everyone, 'ext:a:one', 'ask')],
  ...extra,
});

const preview = (extra: Record<string, unknown> = {}): unknown => ({
  simulations: [],
  loosening: [],
  ...extra,
});

function proposalOf(reading: ProposalReading): Proposal {
  if (reading.status !== 'ok') throw new Error(`expected a proposal, got ${reading.status}`);
  return reading.proposal;
}

describe('readProposal', () => {
  it('is none for an approval of any other tool, whatever it carries', () => {
    expect(readProposal('ext:a:one', args(), preview())).toEqual({ status: 'none' });
  });

  it('is none for a proposal tool with neither the call nor a preview served', () => {
    expect(readProposal(PROPOSE_POLICY_SET_TOOL, undefined, undefined)).toEqual({ status: 'none' });
    expect(readProposal(PROPOSE_POLICY_SET_TOOL, undefined, null)).toEqual({ status: 'none' });
  });

  it('reads the call without a preview as a proposal with no preview', () => {
    const proposal = proposalOf(readProposal(PROPOSE_POLICY_SET_TOOL, args(), undefined));
    expect(proposal.preview).toBeUndefined();
    expect(proposal.groups).toEqual([
      {
        subject: { kind: 'everyone' },
        rows: [{ kind: 'baseline', toolRef: 'ext:a:one', mode: 'ask' }],
      },
    ]);
  });

  it('reads a null preview as none served', () => {
    expect(proposalOf(readProposal(PROPOSE_POLICY_SET_TOOL, args(), null)).preview).toBeUndefined();
  });

  it('reads a preview served without the call: the call-derived parts are absent', () => {
    const proposal = proposalOf(
      readProposal(
        PROPOSE_POLICY_SET_TOOL,
        undefined,
        preview({ grants: [{ tool_ref: 'ext:g:1' }] })
      )
    );
    expect(proposal.groups).toBeUndefined();
    expect(proposal.tools).toEqual([]);
    expect(proposal.agent).toBeUndefined();
    expect(proposal.preview?.grants).toEqual(['ext:g:1']);
  });

  it('groups rows by subject: everyone, then roles, then agents, each in first-seen order', () => {
    const proposal = proposalOf(
      readProposal(
        PROPOSE_POLICY_SET_TOOL,
        {
          policies: [
            entry('tightening', { type: 'agent', id: 'agent_1' }, 'ext:a:one', 'deny'),
            entry('role', { type: 'role', id: 'member' }, 'ext:a:one', 'ask'),
            entry('role', { type: 'role', id: 'auditor' }, 'ext:a:one', 'deny'),
            entry('baseline', everyone, 'ext:a:one', 'ask'),
            entry('baseline', everyone, 'ext:a:two', 'always_allow'),
            entry('role', { type: 'user', id: 'user_1' }, 'ext:a:one', 'deny'),
            entry('role', { type: 'organization' }, 'ext:a:one', 'deny'),
          ],
        },
        undefined
      )
    );
    expect(proposal.groups?.map((g) => g.subject)).toEqual([
      { kind: 'everyone' },
      { kind: 'role', key: 'member' },
      { kind: 'role', key: 'auditor' },
      { kind: 'organization' },
      { kind: 'agent', id: 'agent_1' },
      { kind: 'other', type: 'user', id: 'user_1' },
    ]);
    expect(proposal.groups?.[0]?.rows.map((r) => r.toolRef)).toEqual(['ext:a:one', 'ext:a:two']);
  });

  it('reads a policy with no targets, or `all`, as governing every tool', () => {
    const row = (targets: unknown): unknown => ({
      role: 'baseline',
      policy: {
        subjects: [everyone],
        config: { mode: 'deny' },
        ...(targets === undefined ? {} : { targets }),
      },
    });
    for (const targets of [undefined, { tools: 'all' }]) {
      const proposal = proposalOf(
        readProposal(PROPOSE_POLICY_SET_TOOL, { policies: [row(targets)] }, undefined)
      );
      expect(proposal.groups?.[0]?.rows).toEqual([
        { kind: 'baseline', toolRef: undefined, mode: 'deny' },
      ]);
    }
  });

  it('reads the tools, the agent with and without a principal, and the tool grants', () => {
    const proposal = proposalOf(
      readProposal(
        PROPOSE_POLICY_SET_TOOL,
        args({
          tools: [
            { tool_ref: 'ext:a:new', side_effect_level: 'write', extra: 1 },
            { tool_ref: 'ext:a:plain' },
          ],
          agent: { id: 'agent_1', principal_id: 'sp_1' },
          tool_grants: ['ext:g:1', 'ext:g:2'],
          unknown_member: true,
        }),
        undefined
      )
    );
    expect(proposal.tools).toEqual([
      { toolRef: 'ext:a:new', sideEffectLevel: 'write' },
      { toolRef: 'ext:a:plain', sideEffectLevel: undefined },
    ]);
    expect(proposal.agent).toEqual({ id: 'agent_1', principalId: 'sp_1' });
    expect(proposal.toolGrants).toEqual(['ext:g:1', 'ext:g:2']);
    expect(
      proposalOf(
        readProposal(
          PROPOSE_POLICY_SET_TOOL,
          args({ agent: { id: 'a' }, tool_grants: [] }),
          undefined
        )
      )
    ).toMatchObject({ agent: { id: 'a', principalId: undefined }, toolGrants: undefined });
  });

  it('reads the preview: loosening with and without a subject, ineffective, grants; ignores the rest', () => {
    const proposal = proposalOf(
      readProposal(
        PROPOSE_POLICY_SET_TOOL,
        args(),
        preview({
          simulations: [{ tool_ref: 'ext:a:one', result: { decision: 'allow' } }],
          loosening: [
            { tool_ref: 'ext:a:one', from: 'deny', to: 'ask' },
            {
              tool_ref: 'ext:a:two',
              from: 'ask',
              to: 'always_allow',
              subject: { type: 'role', id: 'member' },
            },
          ],
          ineffective: [{ tool_ref: 'ext:a:one', subject: { type: 'role', id: 'auditor' } }],
          grants: [{ tool_ref: 'ext:g:1' }],
          future_member: [],
        })
      )
    );
    expect(proposal.preview).toEqual({
      loosening: [
        { subject: { kind: 'everyone' }, toolRef: 'ext:a:one', from: 'deny', to: 'ask' },
        {
          subject: { kind: 'role', key: 'member' },
          toolRef: 'ext:a:two',
          from: 'ask',
          to: 'always_allow',
        },
      ],
      ineffective: [{ subject: { kind: 'role', key: 'auditor' }, toolRef: 'ext:a:one' }],
      grants: ['ext:g:1'],
    });
  });

  it.each([
    ['a preview that is not an object', 'soon'],
    ['a preview without loosening', { simulations: [] }],
    ['a loosening that is not a list', preview({ loosening: {} })],
    ['a loosening entry without a tool', preview({ loosening: [{ from: 'ask', to: 'deny' }] })],
    ['a loosening entry without a mode', preview({ loosening: [{ tool_ref: 't', from: 'ask' }] })],
    [
      'a loosening entry with a malformed subject',
      preview({
        loosening: [{ tool_ref: 't', from: 'ask', to: 'deny', subject: { type: 'role' } }],
      }),
    ],
    ['ineffective that is not a list', preview({ ineffective: 'no' })],
    ['an ineffective entry without a subject', preview({ ineffective: [{ tool_ref: 't' }] })],
    ['grants that are not a list', preview({ grants: 'no' })],
    ['a grant that is a bare string', preview({ grants: ['ext:g:1'] })],
  ])('treats %s as unreadable, with the call served', (_name, value) => {
    expect(readProposal(PROPOSE_POLICY_SET_TOOL, args(), value)).toEqual({ status: 'unreadable' });
  });

  it.each([
    ['policies missing', {}],
    ['policies not a list', { policies: 'x' }],
    ['a policy that is not an object', { policies: ['x'] }],
    [
      'a policy without a role',
      { policies: [{ policy: { subjects: [everyone], config: { mode: 'ask' } } }] },
    ],
    [
      'a policy without subjects',
      { policies: [{ role: 'baseline', policy: { subjects: [], config: { mode: 'ask' } } }] },
    ],
    [
      'a policy with a malformed subject',
      { policies: [entry('baseline', { type: 'role' }, 't', 'ask')] },
    ],
    [
      'a policy without a mode',
      {
        policies: [
          {
            role: 'baseline',
            policy: { subjects: [everyone], targets: { tools: ['t'] }, config: {} },
          },
        ],
      },
    ],
    [
      'a policy with an empty target list',
      {
        policies: [
          {
            role: 'baseline',
            policy: { subjects: [everyone], targets: { tools: [] }, config: { mode: 'ask' } },
          },
        ],
      },
    ],
    ['tools that are not a list', args({ tools: 'x' })],
    ['a tool without a reference', args({ tools: [{}] })],
    ['an agent without an id', args({ agent: { principal_id: 'sp' } })],
    ['an agent with a numeric principal', args({ agent: { id: 'a', principal_id: 1 } })],
    ['tool grants that are not strings', args({ tool_grants: [1] })],
  ])('treats %s as unreadable', (_name, value) => {
    expect(readProposal(PROPOSE_POLICY_SET_TOOL, value, undefined)).toEqual({
      status: 'unreadable',
    });
  });

  it('treats a malformed preview as unreadable even when the call was not served', () => {
    expect(readProposal(PROPOSE_POLICY_SET_TOOL, undefined, { loosening: 1 })).toEqual({
      status: 'unreadable',
    });
  });
});

describe('shortToolRef', () => {
  it('shortens an mcp reference to its tool and server, and leaves any other whole', () => {
    expect(shortToolRef('mcp:crm/main/send_email')).toEqual({ tool: 'send_email', server: 'crm' });
    expect(shortToolRef('mcp:crm/main/folder/send')).toEqual({
      tool: 'folder/send',
      server: 'crm',
    });
    expect(shortToolRef('ext:crm:send_email')).toEqual({ tool: 'ext:crm:send_email' });
    expect(shortToolRef('mcp:crm/send_email')).toEqual({ tool: 'mcp:crm/send_email' });
  });
});
