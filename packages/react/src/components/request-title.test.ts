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
    ).toBe(`${iso('Planes CRM')} wants to use ${iso('issue_refund')} (${iso('ext:billing')})`);
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
    expect(requestTitle(approval, t)).toBe(
      `A request to use ${iso('issue_refund')} (${iso('ext:billing')})`
    );
    expect(requestVia(approval, t)).toBe(`via ${iso('Trusted Finance Agent')}`);
  });

  it('says no "via" when the agent is the requester by name', () => {
    for (const tool_ref of ['ext:b:x', 'tool:noblecloak:propose-policy-set']) {
      expect(
        requestVia(
          {
            tool_ref,
            requester: { id: 'r', kind: 'user', display_name: 'Bot' },
            agent: { id: 'a', name: 'Bot' },
          },
          t
        )
      ).toBeUndefined();
    }
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
    expect(title).toBe(`A request to use ${iso('“issue on github”')} (${iso('ext:a')})`);
  });

  /** A character as the title shows it inside quotes: an escape, never the character itself. */
  const esc = (...codes: number[]): string =>
    codes
      .map((code) => {
        const hex = code.toString(16).toUpperCase();
        return code > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
      })
      .join('');
  const chr = (code: number): string => String.fromCodePoint(code);

  it.each([
    ['a fullwidth bracket', [0xff08, 0xff09]],
    ['a small bracket', [0xfe59, 0xfe5a]],
    ['a flattened bracket', [0x27ee, 0x27ef]],
    ['a double bracket', [0x2e28, 0x2e29]],
    ['an ornate bracket', [0x2768, 0x2769]],
  ] as const)(
    'quotes a tool part with %s and shows the look-alikes as escapes',
    (_name, [open, close]) => {
      const tool_ref = `mcp:evil/tools/safe_read${chr(open)}ext:trusted${chr(close)}`;
      expect(requestTitle({ tool_ref }, t)).toBe(
        `A request to use ${iso(`“safe_read${esc(open)}ext:trusted${esc(close)}”`)} (${iso('evil')})`
      );
    }
  );

  it.each([
    ['a square bracket', 'safe_read[ext:trusted]', 'safe_read[ext:trusted]'],
    [
      'an ideographic space',
      `safe_read${chr(0x3000)}(ext:trusted)`,
      `safe_read${esc(0x3000)}(ext:trusted)`,
    ],
    ['a braille blank', `safe_read${chr(0x2800)}x`, `safe_read${esc(0x2800)}x`],
    ['a fullwidth colon', `safe_read${chr(0xff1a)}ext`, `safe_read${esc(0xff1a)}ext`],
    ['a ratio sign', `safe_read${chr(0x2236)}ext`, `safe_read${esc(0x2236)}ext`],
    ['a modifier colon', `safe_read${chr(0xa789)}ext`, `safe_read${esc(0xa789)}ext`],
    [
      'a comma and spaces',
      `safe_read,${chr(0x2800)}from${chr(0x2800)}Finance`,
      `safe_read,${esc(0x2800)}from${esc(0x2800)}Finance`,
    ],
  ])('quotes a tool part with %s', (_name, tool, shownTool) => {
    expect(requestTitle({ tool_ref: `mcp:evil/tools/${tool}` }, t)).toBe(
      `A request to use ${iso(`“${shownTool}”`)} (${iso('evil')})`
    );
  });

  it('shows the anonymous "from X" spoof as one quoted tool name', () => {
    const blank = chr(0x2800);
    const title = requestTitle(
      { tool_ref: `ext:billing:issue_refund,${blank}from${blank}Finance${blank}Lead` },
      t
    );
    expect(title).toBe(
      `A request to use ${iso(`“issue_refund,${esc(0x2800)}from${esc(0x2800)}Finance${esc(0x2800)}Lead”`)} (${iso('ext:billing')})`
    );
  });

  it('shows every character inside quotes that is not a letter, number, space or ASCII punctuation as an escape', () => {
    const title = (tool: string): string => requestTitle({ tool_ref: `mcp:s/t/${tool}` }, t);
    // The ASCII quote and the backslash are escaped by a backslash.
    expect(title('a" b')).toContain(iso('“a\\" b”'));
    expect(title('a\\ b')).toContain(iso('“a\\\\ b”'));
    // Quote look-alikes, letters among them (a modifier letter draws as a quote), are escapes.
    for (const code of [
      0x02ee, 0x02ba, 0x02dd, 0x2033, 0x05f4, 0x3003, 0x275e, 0x300d, 0xff63, 0x301e, 0xff02,
      0x201e, 0x00ab, 0x00bb, 0x2039,
    ]) {
      expect(title(`a${chr(code)} b`)).toContain(iso(`“a${esc(code)} b”`));
    }
    // Letters and numbers of any script stay as they are.
    expect(title('é 日本 7')).toContain(iso('“é 日本 7”'));
  });

  it('shows a control or format character as an escape, in a name and in a quoted part', () => {
    for (const code of [0x0007, 0x001b, 0x0085, 0x009b, 0x0605, 0x06dd, 0x13430]) {
      const name = requestTitle(
        {
          tool_ref: 'ext:b:x',
          requester: { id: 'r', kind: 'user', display_name: `Fin${chr(code)}Lead` },
        },
        t
      );
      expect(name).toContain(iso(`Fin${esc(code)}Lead`));
      expect(name).not.toContain(chr(code));
      const part = requestTitle({ tool_ref: `mcp:evil/s/a${chr(code)}b` }, t);
      expect(part).toContain(iso(`“a${esc(code)}b”`));
    }
  });

  it('shows at most two combining marks in a row in a name, and the rest as escapes', () => {
    const marks = [0x0301, 0x0302, 0x0303, 0x0304].map(chr).join('');
    const title = requestTitle(
      {
        tool_ref: 'ext:b:x',
        requester: { id: 'r', kind: 'user', display_name: `e${marks}` },
      },
      t
    );
    expect(title).toContain(iso(`e${chr(0x0301)}${chr(0x0302)}${esc(0x0303, 0x0304)}`));
  });

  it('quotes a tool segment that holds a colon or an at sign, but not a source', () => {
    expect(requestTitle({ tool_ref: 'mcp:evil/s/safe_read@ext:trusted' }, t)).toBe(
      `A request to use ${iso('“safe_read@ext:trusted”')} (${iso('evil')})`
    );
    expect(requestTitle({ tool_ref: 'mcp:evil/s/safe_read@trusted' }, t)).toBe(
      `A request to use ${iso('“safe_read@trusted”')} (${iso('evil')})`
    );
    expect(requestTitle({ tool_ref: 'ext:a@b:x' }, t)).toBe(
      `A request to use ${iso('x')} (${iso('ext:a@b')})`
    );
  });

  it('shows a blank that is neither white space nor ignorable as an escape, in a name too', () => {
    const title = requestTitle(
      {
        tool_ref: 'ext:b:x',
        requester: { id: 'r', kind: 'user', display_name: `Finance${chr(0x2800)}Lead` },
      },
      t
    );
    expect(title).not.toContain(chr(0x2800));
    expect(title).toContain(iso('Finance\\u2800Lead'));
  });

  it('names a policy-set proposal by who it is from, and never by the agent hint, which is not its target', () => {
    const tool_ref = 'tool:noblecloak:propose-policy-set';
    const requester = { id: 'sp_1', kind: 'service' as const, display_name: 'Planes CRM' };
    const hint = { id: 'a', name: 'Sales agent' };
    expect(requestTitle({ tool_ref, requester }, t)).toBe(`Policy setup from ${iso('Planes CRM')}`);
    expect(requestTitle({ tool_ref, requester, agent: hint }, t)).toBe(
      `Policy setup from ${iso('Planes CRM')}`
    );
    expect(requestTitle({ tool_ref, agent: hint }, t)).toBe('A policy setup request');
    expect(requestTitle({ tool_ref }, t)).toBe('A policy setup request');
    for (const title of [
      requestTitle({ tool_ref, requester, agent: hint }, t),
      requestTitle({ tool_ref, agent: hint }, t),
    ]) {
      expect(title).not.toContain('Sales agent');
      expect(title).not.toMatch(/\bfor\b/);
    }
  });

  it('shows the agent hint of a proposal only as "via", like any request', () => {
    const approval = {
      tool_ref: 'tool:noblecloak:propose-policy-set',
      requester: { id: 'sp_1', kind: 'service' as const, display_name: 'Planes CRM' },
      agent: { id: 'a', name: 'Sales agent' },
    };
    expect(requestVia(approval, t)).toBe(`via ${iso('Sales agent')}`);
  });

  it('isolates the tool and its source separately, and quotes a tool that could pass for a source', () => {
    expect(requestTitle({ tool_ref: 'ext:billing:issue_refund' }, t)).toBe(
      `A request to use ${iso('issue_refund')} (${iso('ext:billing')})`
    );
    // An mcp tool part that holds " (ext:x)": quoted, so the brackets read as part of the tool name.
    const spoof = requestTitle({ tool_ref: 'mcp:evil/tools/safe_read (ext:trusted)' }, t);
    expect(spoof).toBe(`A request to use ${iso('“safe_read (ext:trusted)”')} (${iso('evil')})`);
    // A quote inside it cannot close the quotes early.
    expect(requestTitle({ tool_ref: 'mcp:evil/tools/a” (ext:t) “b' }, t)).toBe(
      `A request to use ${iso(`“a${esc(0x201d)} (ext:t) ${esc(0x201c)}b”`)} (${iso('evil')})`
    );
    // The same for a source with a space or a bracket in it.
    expect(requestTitle({ tool_ref: 'ext:a (b):x' }, t)).toBe(
      `A request to use ${iso('x')} (${iso('“ext:a (b)”')})`
    );
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
      expect(title.endsWith(`wants to use ${iso('issue_refund')} (${iso('ext:billing')})`)).toBe(
        true
      );
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
    ).toBe(`${iso('Bot')}: ${iso('x')} (${iso('ext:b')})`);
  });
});
