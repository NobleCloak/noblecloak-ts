import { describe, expect, it } from 'vitest';

import { createTranslate } from './labels.js';
import { requestTitle, requestVia, toolParts } from './request-title.js';

const t = createTranslate(undefined);
const I = String.fromCodePoint(0x2068);
const J = String.fromCodePoint(0x2069);
const iso = (name: string): string => `${I}${name}${J}`;

describe('toolParts', () => {
  it('splits a reference at its last colon into the tool and its source, as written', () => {
    expect(toolParts('ext:billing:issue_refund')).toEqual({
      tool: 'issue_refund',
      source: 'ext:billing',
    });
    expect(toolParts('tool:noblecloak:propose-policy-set')).toEqual({
      tool: 'propose-policy-set',
      source: 'tool:noblecloak',
    });
  });

  it('reads an mcp reference as the tool and its server, and never slices the tool again', () => {
    expect(toolParts('mcp:github/tools/search_issues')).toEqual({
      tool: 'search_issues',
      source: 'github',
    });
    expect(toolParts('mcp:github/tools/ns:get:thing')).toEqual({
      tool: 'ns:get:thing',
      source: 'github',
    });
  });

  it('has no source for a reference with no colon, or one that is all colon', () => {
    expect(toolParts('refund')).toEqual({ tool: 'refund' });
    expect(toolParts('ext:billing:')).toEqual({ tool: 'ext:billing:' });
    expect(toolParts('')).toEqual({ tool: '' });
  });
});

describe('requestTitle', () => {
  it('names a call by the verified requester, the tool and where the tool comes from', () => {
    expect(
      requestTitle(
        {
          tool_ref: 'ext:billing:issue_refund',
          requester: { id: 'sp_1', kind: 'service', display_name: 'Planes CRM' },
        },
        t
      )
    ).toBe(`${iso('Planes CRM')} wants to use issue_refund (ext:billing)`);
  });

  it('never makes the agent the asker: the requester is, and the agent is only a "via"', () => {
    const approval = {
      tool_ref: 'ext:billing:issue_refund',
      requester: { id: 'user_9', kind: 'user' as const, display_name: 'Mallory' },
      agent: { id: 'agent_1', name: 'Trusted Finance Agent' },
    };
    const title = requestTitle(approval, t);
    expect(title).toContain(iso('Mallory'));
    expect(title).not.toContain('Trusted Finance Agent');
    expect(requestVia(approval, t)).toBe(`via ${iso('Trusted Finance Agent')}`);
  });

  it('has no asker when the requester has no name, and does not put the agent in its place', () => {
    const approval = {
      tool_ref: 'ext:billing:issue_refund',
      requester: { id: 'sp_1', kind: 'service' as const },
      agent: { id: 'agent_1', name: 'Trusted Finance Agent' },
    };
    expect(requestTitle(approval, t)).toBe('A request to use issue_refund (ext:billing)');
    expect(requestVia(approval, t)).toBe(`via ${iso('Trusted Finance Agent')}`);
  });

  it('says no "via" when the agent is the requester by name, or for a proposal', () => {
    expect(
      requestVia(
        {
          tool_ref: 'ext:b:x',
          requester: { id: 'r', kind: 'user', display_name: 'Bot' },
          agent: { id: 'a', name: 'Bot' },
        },
        t
      )
    ).toBeUndefined();
    expect(
      requestVia(
        { tool_ref: 'tool:noblecloak:propose-policy-set', agent: { id: 'a', name: 'Bot' } },
        t
      )
    ).toBeUndefined();
  });

  it('tells tools that read alike apart, in the sentence and by the reference', () => {
    const refs = [
      'ext:billing:issue_refund',
      'ext:billing:issue-refund',
      'tool:sandbox:issue_refund',
      'mcp:billing/tools/issue_refund',
    ];
    const titles = refs.map((tool_ref) =>
      requestTitle({ tool_ref, requester: { id: 'r', kind: 'user', display_name: 'Ann' } }, t)
    );
    expect(new Set(titles).size).toBe(refs.length);
  });

  it('cannot fake a source with a tool name: a non-mcp reference gets no " on server"', () => {
    const title = requestTitle({ tool_ref: 'ext:a:issue on github' }, t);
    expect(title).toBe('A request to use issue on github (ext:a)');
  });

  it('names a policy-set proposal by who it is from, and for which agent when that is another name', () => {
    const tool_ref = 'tool:noblecloak:propose-policy-set';
    const requester = { id: 'sp_1', kind: 'service' as const, display_name: 'Planes CRM' };
    expect(requestTitle({ tool_ref, requester }, t)).toBe(`Policy setup from ${iso('Planes CRM')}`);
    expect(requestTitle({ tool_ref, requester, agent: { id: 'a', name: 'Planes CRM' } }, t)).toBe(
      `Policy setup from ${iso('Planes CRM')}`
    );
    expect(requestTitle({ tool_ref, requester, agent: { id: 'a', name: 'Sales agent' } }, t)).toBe(
      `Policy setup for ${iso('Sales agent')}, from ${iso('Planes CRM')}`
    );
    expect(requestTitle({ tool_ref, agent: { id: 'a', name: 'Sales agent' } }, t)).toBe(
      `Policy setup for ${iso('Sales agent')}`
    );
    expect(requestTitle({ tool_ref }, t)).toBe('A policy setup request');
  });

  it('shows hidden characters in a name as escapes, and isolates the name', () => {
    const title = requestTitle(
      {
        tool_ref: 'ext:billing:x',
        requester: { id: 'r', kind: 'user', display_name: 'Bot‮' },
      },
      t
    );
    expect(title).not.toContain('‮');
    expect(title.startsWith(I)).toBe(true);
  });

  it('cuts a long name, and a name padded with no-break spaces, so the tool stays in the sentence', () => {
    const padded = `${' '.repeat(200)}Eve${' '.repeat(200)}`;
    const long = 'N'.repeat(500);
    for (const name of [padded, long]) {
      const title = requestTitle(
        {
          tool_ref: 'ext:billing:issue_refund',
          requester: { id: 'r', kind: 'user', display_name: name },
        },
        t
      );
      expect(title.length).toBeLessThan(110);
      expect(title.endsWith('wants to use issue_refund (ext:billing)')).toBe(true);
    }
    expect(
      requestTitle(
        {
          tool_ref: 'ext:billing:x',
          requester: { id: 'r', kind: 'user', display_name: padded },
        },
        t
      )
    ).toContain(iso('Eve'));
  });

  it('still renders when a reply was malformed, with a word for the tool', () => {
    const malformed = {
      tool_ref: 42,
      agent: { id: 'a', name: 7 },
      requester: { id: 'r', kind: 'user', display_name: { not: 'a string' } },
    } as never;
    expect(requestTitle(malformed, t)).toBe('A request to use an unnamed tool');
    expect(requestTitle({ tool_ref: '' }, t)).toBe('A request to use an unnamed tool');
  });

  it('uses the host labels', () => {
    const custom = createTranslate({ rowTitleTool: '{who}: {tool}' });
    expect(
      requestTitle(
        { tool_ref: 'ext:b:x', requester: { id: 'a', kind: 'user', display_name: 'Bot' } },
        custom
      )
    ).toBe(`${iso('Bot')}: x (ext:b)`);
  });
});
