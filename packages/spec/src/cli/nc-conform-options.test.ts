import { describe, expect, it } from 'vitest';

import { runConformance } from '../conformance/run.js';
import { loadCommittedDocument } from '../spec/testing.js';
import { startMock } from '../mock/serve.js';
import { parseConformArgs } from './nc-conform-options.js';

const BASE = ['--base-url', 'https://govern.example.com/', '--token', 'c', '--approver-token', 'a'];

describe('nc-conform --webhook-sink', () => {
  const SINK = ['--webhook-sink', 'https://sink.example.com/', '--webhook-sink-token', 'tok'];

  it('is absent by default', () => {
    expect(parseConformArgs(BASE).target.webhookSink).toBeUndefined();
  });

  it('maps the base (trailing slash stripped), the token and the default wait and settle', () => {
    expect(parseConformArgs([...BASE, ...SINK]).target.webhookSink).toEqual({
      baseUrl: 'https://sink.example.com',
      token: 'tok',
      waitSeconds: 60,
      settleSeconds: 10,
    });
  });

  it('takes the wait and settle, within their ranges', () => {
    const sink = (wait: string, settle: string) =>
      parseConformArgs([
        ...BASE,
        ...SINK,
        '--webhook-sink-wait',
        wait,
        '--webhook-sink-settle',
        settle,
      ]).target.webhookSink;
    expect(sink('1', '0')).toMatchObject({ waitSeconds: 1, settleSeconds: 0 });
    expect(sink('300', '60')).toMatchObject({ waitSeconds: 300, settleSeconds: 60 });
    for (const [wait, settle] of [
      ['0', '10'],
      ['301', '10'],
      ['60', '61'],
      ['1.5', '10'],
      ['abc', '10'],
      ['60', '+5'],
    ] as const)
      expect(() => sink(wait, settle), `${wait}/${settle}`).toThrow(/whole number of seconds/);
  });

  it('wants the URL and the token together or neither', () => {
    expect(() => parseConformArgs([...BASE, '--webhook-sink', 'https://s.example.com'])).toThrow(
      /together or not at all/
    );
    expect(() => parseConformArgs([...BASE, '--webhook-sink-token', 'tok'])).toThrow(
      /together or not at all/
    );
    expect(() => parseConformArgs([...BASE, '--webhook-sink-wait', '30'])).toThrow(
      /need --webhook-sink/
    );
  });

  it('is https only, with no credentials, query or fragment, and a usable URL', () => {
    const bad = (url: string): string =>
      (() => {
        try {
          parseConformArgs([...BASE, '--webhook-sink', url, '--webhook-sink-token', 'tok']);
          return '';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })();
    expect(bad('http://sink.example.com')).toMatch(/https:\/\//);
    expect(bad('sink.example.com')).toMatch(/not a URL/);
    expect(bad('https://u:p@sink.example.com')).toMatch(/no credentials, query or fragment/);
    expect(bad('https://sink.example.com/?a=1')).toMatch(/no credentials, query or fragment/);
    expect(bad('https://sink.example.com/#x')).toMatch(/no credentials, query or fragment/);
    expect(bad('https://sink.example.com?')).toMatch(/no credentials, query or fragment/);
    expect(bad('https://sink.example.com/a#')).toMatch(/no credentials, query or fragment/);
  });

  it('stores the normalised base: lower-case host, default port dropped, trailing slashes stripped', () => {
    const base = (url: string) =>
      parseConformArgs([...BASE, '--webhook-sink', url, '--webhook-sink-token', 'tok']).target
        .webhookSink?.baseUrl;
    expect(base('HTTPS://Sink.Example.com:443/Hooks//')).toBe('https://sink.example.com/Hooks');
    expect(base('https://sink.example.com:8443')).toBe('https://sink.example.com:8443');
  });

  it('never echoes the token in an error', () => {
    expect(() =>
      parseConformArgs([
        ...BASE,
        '--webhook-sink',
        'http://s.example.com',
        '--webhook-sink-token',
        'super-secret',
      ])
    ).not.toThrow(/super-secret/);
  });
});

describe('nc-conform arguments', () => {
  it('reject undeclared fields by default, and --allow-undeclared opts out', () => {
    expect(parseConformArgs([...BASE, '--face', 'public']).target.rejectUndeclared).toBe(true);
    expect(parseConformArgs(BASE).target.rejectUndeclared).toBe(true);
    expect(
      parseConformArgs([...BASE, '--allow-undeclared']).target.rejectUndeclared
    ).toBeUndefined();
  });

  it('--allow-undeclared opts out; --reject-undeclared says what is already the default', () => {
    const allowed = parseConformArgs([...BASE, '--face', 'public', '--allow-undeclared']);
    expect(allowed.target.rejectUndeclared).toBeUndefined();
    expect(parseConformArgs([...BASE, '--reject-undeclared']).target.rejectUndeclared).toBe(true);
    expect(() =>
      parseConformArgs([...BASE, '--reject-undeclared', '--allow-undeclared', '--face', 'public'])
    ).toThrow(/contradict/);
  });

  it('maps the optional fixtures and the mock control, and leaves them unset otherwise', () => {
    const bare = parseConformArgs(BASE).target;
    expect(bare.fixtures.reserved_tool_ref).toBeUndefined();
    expect(bare.fixtures.system_tool_ref).toBeUndefined();
    expect(bare.mockControl).toBeUndefined();
    const { target } = parseConformArgs([
      ...BASE,
      '--reserved-tool-ref',
      'reserved:x',
      '--system-tool-ref',
      'system:y',
      '--mock-control',
      'http://127.0.0.1:1/__mock/control',
    ]);
    expect(target.fixtures).toMatchObject({
      reserved_tool_ref: 'reserved:x',
      system_tool_ref: 'system:y',
    });
    expect(target.mockControl).toBe('http://127.0.0.1:1/__mock/control');
  });

  it('maps every token flag to its alias and strips a trailing slash', () => {
    const { target } = parseConformArgs([
      ...BASE,
      '--face',
      'public',
      '--creator-user-token',
      'cu',
      '--entitled-token',
      'e',
      '--wrong-audience-token',
      'w',
      '--forged-token',
      'f',
      '--expired-token',
      'x',
      '--dpop-bound-token',
      'd',
      '--no-org-token',
      'n',
      '--no-scope-token',
      's',
      '--other-service-token',
      'os',
      '--approver-surface-token',
      'as',
      '--approver-token-without-resolve-scope',
      'nrs',
    ]);
    expect(target.baseUrl).toBe('https://govern.example.com');
    expect(target.tokens).toEqual({
      creator: 'c',
      approver: 'a',
      creator_user: 'cu',
      entitled: 'e',
      wrong_audience: 'w',
      forged: 'f',
      expired: 'x',
      dpop_bound: 'd',
      no_org: 'n',
      no_scope: 's',
      other_service: 'os',
      approver_surface_token: 'as',
      approver_token_without_resolve_scope: 'nrs',
    });
  });

  it('takes no approver when none is given, and the creator stays required', () => {
    const { target } = parseConformArgs(['--base-url', 'x', '--token', 'c']);
    expect(target.tokens).toEqual({ creator: 'c' });
    expect('approver' in target.tokens).toBe(false);
    expect(
      parseConformArgs(['--base-url', 'x', '--token', 'c', '--approver-token', 'a']).target.tokens
    ).toEqual({
      creator: 'c',
      approver: 'a',
    });
  });

  it('names what is missing or wrong', () => {
    expect(() => parseConformArgs([])).toThrow(/--base-url is required/);
    expect(() => parseConformArgs(['--base-url', 'x'])).toThrow(/--token is required/);
    expect(() => parseConformArgs([...BASE, '--deployment', 'moon'])).toThrow(/hosted or edge/);
    expect(() => parseConformArgs([...BASE, '--face', 'moon'])).toThrow(/--face is deprecated/);
    // --other-token was removed: nothing used it, so it is no longer a flag.
    expect(() => parseConformArgs([...BASE, '--other-token', 'o'])).toThrow(/other-token/);
  });

  it('accepts --face public for one release, with a deprecation line, and nothing else for it', () => {
    const deprecated = parseConformArgs([...BASE, '--face', 'public']);
    expect(deprecated.deprecations).toEqual([
      expect.stringMatching(/^nc-conform: --face is deprecated and ignored/),
    ]);
    expect(deprecated.target).toEqual(parseConformArgs(BASE).target);
    expect(parseConformArgs(BASE).deprecations).toEqual([]);
    expect(() => parseConformArgs([...BASE, '--face', 'all'])).toThrow(/--face is deprecated/);
  });

  it('a server that sends a member the document does not declare fails a run built from the command line alone', async () => {
    const mock = await startMock({
      deployment: 'hosted',
      spec: loadCommittedDocument(),
      breaks: new Set(['undeclared_handle_member']),
      control: true,
    });
    try {
      const t = await mock.tokens();
      const argv = [
        '--base-url',
        mock.baseUrl,
        '--token',
        t.creator,
        '--approver-token',
        t.approver,
      ];
      const spec = loadCommittedDocument();
      const failed = await runConformance({ target: parseConformArgs(argv).target, spec });
      expect(failed.failed).toBeGreaterThan(0);
      // Opting out is the explicit act the finding asked for: the same server then passes.
      const passed = await runConformance({
        target: parseConformArgs([...argv, '--allow-undeclared']).target,
        spec,
      });
      expect(passed.results.filter((r) => r.outcome === 'failed')).toEqual([]);
    } finally {
      await mock.stop();
    }
  }, 60_000);
});

describe('the rev 5 flags', () => {
  it('maps --admin-token, --member-token and --tool-ref-in-use, and leaves them unset otherwise', () => {
    const bare = parseConformArgs(BASE).target;
    expect(bare.tokens.admin).toBeUndefined();
    expect(bare.tokens.member).toBeUndefined();
    expect(bare.fixtures.tool_ref_in_use).toBeUndefined();
    expect(bare.fixtures.on_deny_tool_ref).toBeUndefined();
    expect(bare.fixtures.on_deny_silent_tool_ref).toBeUndefined();
    const { target } = parseConformArgs([
      ...BASE,
      '--admin-token',
      'adm',
      '--member-token',
      'mem',
      '--tool-ref-in-use',
      'mcp:gw:x',
      '--on-deny-tool-ref',
      'mcp:gw:od',
      '--on-deny-silent-tool-ref',
      'mcp:gw:odq',
    ]);
    expect(target.tokens).toMatchObject({ admin: 'adm', member: 'mem' });
    expect(target.fixtures.tool_ref_in_use).toBe('mcp:gw:x');
    expect(target.fixtures.on_deny_tool_ref).toBe('mcp:gw:od');
    expect(target.fixtures.on_deny_silent_tool_ref).toBe('mcp:gw:odq');
  });

  it('maps --connection-server-url to the connection_server_url fixture (rev 11)', () => {
    expect(parseConformArgs(BASE).target.fixtures.connection_server_url).toBeUndefined();
    expect(
      parseConformArgs([...BASE, '--connection-server-url', 'https://tools.example.com/mcp']).target
        .fixtures.connection_server_url
    ).toBe('https://tools.example.com/mcp');
  });

  it('maps --oauth-return-to to the oauth_return_to fixture (rev 11)', () => {
    expect(parseConformArgs(BASE).target.fixtures.oauth_return_to).toBeUndefined();
    expect(
      parseConformArgs([...BASE, '--oauth-return-to', 'https://app.example.com/back']).target
        .fixtures.oauth_return_to
    ).toBe('https://app.example.com/back');
  });

  it('maps --admin-role to the admin_role fixture (rev 11), and leaves it unset otherwise', () => {
    expect(parseConformArgs(BASE).target.fixtures.admin_role).toBeUndefined();
    expect(
      parseConformArgs([...BASE, '--admin-role', 'org_admin']).target.fixtures.admin_role
    ).toBe('org_admin');
  });

  it('maps --no-on-deny to Target.noOnDeny, and refuses it beside --on-deny-tool-ref', () => {
    expect(parseConformArgs(BASE).target.noOnDeny).toBeUndefined();
    expect(parseConformArgs([...BASE, '--no-on-deny']).target.noOnDeny).toBe(true);
    expect(() =>
      parseConformArgs([...BASE, '--no-on-deny', '--on-deny-tool-ref', 'mcp:gw:od'])
    ).toThrow(/contradict/);
  });
});
