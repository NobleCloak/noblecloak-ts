import { describe, expect, it } from 'vitest';

import {
  approvalOf,
  approvalPageOf,
  capabilitiesOf,
  createFrameReader,
  MAX_SSE_LINE,
  createSseParser,
  isApproval,
  parseJson,
} from './approvals-parse.js';

const approval = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  state: 'pending',
  action_digest: 'sha256:abc',
  tool_ref: 'mcp:tracker:create_issue',
  obligation_kind: 'tool_invocation',
  scope_id: 'scope_1',
  side_effect_level: 'write',
  created_at: '2026-10-05T00:00:00.000Z',
  ...extra,
});

describe('T16 the stream parser', () => {
  it('reads an event with LF, CRLF and CR line ends alike', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const parser = createSseParser();
      const items = parser.push(`event: approval.updated${eol}data: {"a":1}${eol}${eol}`);
      expect(items).toEqual([{ type: 'event', event: 'approval.updated', data: '{"a":1}' }]);
    }
  });

  it('reads a frame split at every position, including inside a CRLF', () => {
    const wire = ': connected\r\n\r\nevent: approval.updated\r\ndata: {"x":"y"}\r\n\r\n';
    for (let cut = 0; cut <= wire.length; cut += 1) {
      const parser = createSseParser();
      const items = [...parser.push(wire.slice(0, cut)), ...parser.push(wire.slice(cut))];
      expect(items).toEqual([
        { type: 'comment', text: 'connected' },
        { type: 'event', event: 'approval.updated', data: '{"x":"y"}' },
      ]);
    }
  });

  it('keeps a CR that ends a chunk from eating the next line', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\r')).toEqual([]);
    expect(parser.push('\ndata: b\n\n')).toEqual([
      { type: 'event', event: 'message', data: 'a\nb' },
    ]);
    expect(parser.push('')).toEqual([]);
  });

  it('survives an empty chunk right after a CR', () => {
    const parser = createSseParser();
    parser.push('data: a\r');
    expect(parser.push('')).toEqual([]);
    expect(parser.push('\n\n')).toEqual([{ type: 'event', event: 'message', data: 'a' }]);
  });

  it('keeps the blank line after a CRLF split as CR, LF, LF', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\r')).toEqual([]);
    expect(parser.push('\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ type: 'event', event: 'message', data: 'a' }]);
  });

  it('ends a bare-CR event whose last CR and the blank line arrive as separate chunks', () => {
    const parser = createSseParser();
    expect(parser.push('event: a\rdata: x\r')).toEqual([]);
    expect(parser.push('\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ type: 'event', event: 'a', data: 'x' }]);
  });

  it('dispatches each event once when every byte of a CRLF stream is its own chunk', () => {
    const wire = 'event: a\r\ndata: x\r\n\r\nevent: b\r\ndata: y\r\n\r\n';
    const parser = createSseParser();
    const items = wire.split('').flatMap((ch) => parser.push(ch));
    expect(items).toEqual([
      { type: 'event', event: 'a', data: 'x' },
      { type: 'event', event: 'b', data: 'y' },
    ]);
  });

  it('reports comments, including keepalives, without ending an event', () => {
    const parser = createSseParser();
    const items = parser.push('data: 1\n:keepalive\ndata: 2\n\n');
    expect(items).toEqual([
      { type: 'comment', text: 'keepalive' },
      { type: 'event', event: 'message', data: '1\n2' },
    ]);
  });

  it('joins several data lines with a newline, strips one leading space, ignores id and retry', () => {
    const parser = createSseParser();
    const items = parser.push('id: 7\nretry: 1000\nevent:x\ndata:  two spaces\ndata\n\n');
    expect(items).toEqual([{ type: 'event', event: 'x', data: ' two spaces\n' }]);
  });

  it('dispatches nothing for a blank line with no data, and resets the event name', () => {
    const parser = createSseParser();
    expect(parser.push('event: x\n\n')).toEqual([]);
    expect(parser.push('data: 1\n\n')).toEqual([{ type: 'event', event: 'message', data: '1' }]);
  });

  it('keeps an unfinished frame until its blank line arrives', () => {
    const parser = createSseParser();
    expect(parser.push('event: a\ndata: partial')).toEqual([]);
    expect(parser.push('ly\n\n')).toEqual([{ type: 'event', event: 'a', data: 'partially' }]);
  });
});

describe('T16 the frame reader', () => {
  it('turns approval.updated into approvals, ignores unknown events and counts bad JSON', () => {
    const reader = createFrameReader();
    const wire = [
      ': connected\n\n',
      `event: approval.updated\ndata: ${JSON.stringify(approval('a1'))}\n\n`,
      'event: something.else\ndata: {}\n\n',
      'event: approval.updated\ndata: not json\n\n',
      'event: approval.updated\ndata: {"id":"x"}\n\n',
      ':keepalive\n\n',
      `event: approval.updated\ndata: ${JSON.stringify({ data: approval('a2') })}\n\n`,
    ].join('');
    const frames = reader.push(wire);
    expect(frames.map((f) => f.type)).toEqual(['connected', 'approval', 'keepalive', 'approval']);
    expect(frames.flatMap((f) => (f.type === 'approval' ? [f.approval.id] : []))).toEqual([
      'a1',
      'a2',
    ]);
    expect(reader.invalid()).toBe(2);
  });
});

describe('response shapes', () => {
  it('knows an approval by its id, state and digest', () => {
    expect(isApproval(approval('a'))).toBe(true);
    expect(isApproval({ ...approval('a'), state: 'weird' })).toBe(false);
    expect(isApproval({ ...approval('a'), id: '' })).toBe(false);
    expect(isApproval(null)).toBe(false);
    expect(isApproval([])).toBe(false);
  });

  it('unwraps an envelope and nothing else', () => {
    expect(approvalOf({ data: approval('a') })?.id).toBe('a');
    expect(approvalOf(approval('b'))?.id).toBe('b');
    expect(approvalOf({ data: { id: 'c' } })).toBeUndefined();
  });

  it('reads a page, its cursor, and refuses a page with a bad row', () => {
    expect(approvalPageOf({ data: [approval('a')], meta: { next: 'c2' } })).toMatchObject({
      more: true,
    });
    expect(approvalPageOf({ data: [], meta: { next: null } })).toEqual({
      approvals: [],
      more: false,
    });
    expect(approvalPageOf({ data: [] })).toEqual({ approvals: [], more: false });
    expect(approvalPageOf({ data: [approval('a'), { id: 1 }] })).toBeUndefined();
    expect(approvalPageOf({ rows: [] })).toBeUndefined();
    expect(approvalPageOf('x')).toBeUndefined();
  });

  it('reads the capabilities it needs', () => {
    expect(capabilitiesOf({ data: { resolutions: ['approved'], dpop: 'off' } })).toEqual({
      resolutions: ['approved'],
      dpop: 'off',
    });
    expect(capabilitiesOf({ resolutions: [] })).toEqual({ resolutions: [], dpop: undefined });
    expect(capabilitiesOf({ resolutions: [1, 'x'] })?.resolutions).toEqual(['x']);
    expect(capabilitiesOf({})).toBeUndefined();
  });

  it('parses JSON without throwing', () => {
    expect(parseJson('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(parseJson('{')).toBeUndefined();
  });
});

describe('c1-9 a line over 1 MiB is not an approvals stream', () => {
  it('flags an unterminated line past the bound and buffers nothing more', () => {
    const parser = createSseParser();
    expect(parser.push('data: ' + 'x'.repeat(MAX_SSE_LINE / 2))).toEqual([]);
    expect(parser.overflowed()).toBe(false);
    expect(parser.push('x'.repeat(MAX_SSE_LINE / 2))).toEqual([]);
    expect(parser.overflowed()).toBe(true);
    // Nothing is emitted afterwards, even for a well-formed event.
    expect(parser.push('\n\ndata: {}\n\n')).toEqual([]);
  });

  it('flags a complete line past the bound inside one chunk', () => {
    const parser = createSseParser();
    parser.push('data: ' + 'x'.repeat(MAX_SSE_LINE + 1) + '\n\n');
    expect(parser.overflowed()).toBe(true);
  });

  it('accepts a line exactly at the bound', () => {
    const parser = createSseParser();
    parser.push(':' + 'x'.repeat(MAX_SSE_LINE - 1) + '\n');
    expect(parser.overflowed()).toBe(false);
  });

  it('c2-2 flags one event whose data lines are each small but together past the bound', () => {
    const parser = createSseParser();
    const line = 'data: ' + 'x'.repeat(900 * 1024) + '\n';
    for (let i = 0; i < 200 && !parser.overflowed(); i += 1) parser.push(line);
    expect(parser.overflowed()).toBe(true);
    expect(parser.push('\ndata: {}\n\n')).toEqual([]);
  });

  it('c2-2 the size of one event does not carry into the next', () => {
    const parser = createSseParser();
    const half = 'data: ' + 'x'.repeat(MAX_SSE_LINE / 2 - 10) + '\n';
    parser.push(half + '\n' + half + '\n');
    expect(parser.overflowed()).toBe(false);
  });
});

describe('c2-5 a row whose rendered fields are not of the contract types is not an approval', () => {
  it.each([
    ['tool_ref', undefined],
    ['tool_ref', 7],
    ['scope_id', {}],
    ['created_at', null],
    ['side_effect_level', 1],
    ['obligation_kind', undefined],
    ['expires_at', 5],
    ['agent', { id: 3 }],
    ['agent', { id: 'a', parent: 4 }],
    ['run', { id: 'r' }],
    ['policy', { id: 9 }],
    ['approver', { id: [] }],
    ['resolution_history', 'x'],
    ['resolution_history', [{ resolution: 'approved', at: 'now', by: {} }]],
    ['resolution_history', [{ resolution: 'approved', at: 4, by: { id: 'u' } }]],
  ])('refuses %s = %j', (field, bad) => {
    const row = { ...approval('a'), [field]: bad };
    expect(isApproval(row)).toBe(false);
    expect(approvalPageOf({ data: [row] })).toBeUndefined();
    expect(approvalOf({ data: row })).toBeUndefined();
  });

  it('accepts the optional members when they are well formed', () => {
    expect(
      isApproval({
        ...approval('a'),
        agent: { id: 'ag', parent: null },
        run: { id: 'r', kind: 'governed' },
        policy: { id: 'p', version: 3 },
        approver: { id: 'u' },
        expires_at: null,
        resolution_history: [{ resolution: 'approved', at: 't', by: { id: 'u' }, reason: 'ok' }],
      })
    ).toBe(true);
  });
});
