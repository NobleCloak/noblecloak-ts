import { describe, expect, it } from 'vitest';

import { BREAKS } from '../mock/breaks.js';
import { loadCommittedDocument } from '../spec/testing.js';
import { MOCK_FIXTURES } from '../conformance/against-mock.js';
import { startMock } from '../mock/serve.js';
import type { Report, ScenarioResult } from '../conformance/types.js';
import { formatSkipWarning, unconfiguredSkips } from '../conformance/run.js';
import { conformExitCode, runConformCli } from './nc-conform-main.js';
import type { CliIo } from './nc-conform-main.js';
import { parseMockArgs, startMockCli } from './nc-mock-main.js';

const result = (
  outcome: ScenarioResult['outcome'],
  skipKind?: 'unconfigured' | 'inapplicable' | 'capability'
): ScenarioResult => ({
  id: 'x',
  title: 'x',
  tags: ['both'],
  outcome,
  failures: outcome === 'failed' ? ['boom'] : [],
  ...(skipKind === undefined ? {} : { skipKind, skipReason: 'no token for entitled' }),
});
const report = (...results: ScenarioResult[]): Report => ({
  deployment: 'hosted',
  results,
  passed: results.filter((r) => r.outcome === 'passed').length,
  failed: results.filter((r) => r.outcome === 'failed').length,
  skipped: results.filter((r) => r.outcome === 'skipped').length,
  exercised: [],
});

const buffers = (): { io: CliIo; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    },
  };
};

describe('conformExitCode', () => {
  it('passes only when nothing failed and nothing went unverified', () => {
    expect(conformExitCode(report(result('passed')), false)).toBe(0);
    expect(
      conformExitCode(report(result('passed'), result('skipped', 'inapplicable')), false)
    ).toBe(0);
  });

  it("a capability skip is the deployment's declared scope: it neither fails the run nor needs --allow-skips", () => {
    const skipped = report(result('passed'), result('skipped', 'capability'));
    expect(conformExitCode(skipped, false)).toBe(0);
    expect(unconfiguredSkips(skipped)).toEqual([]);
    expect(formatSkipWarning(skipped)).toBe('');
  });

  it('fails on an unconfigured skip, unless skips are allowed', () => {
    const skipped = report(result('passed'), result('skipped', 'unconfigured'));
    expect(conformExitCode(skipped, false)).toBe(1);
    expect(conformExitCode(skipped, true)).toBe(0);
  });

  it('fails on a failure, whatever --allow-skips says', () => {
    expect(conformExitCode(report(result('failed')), false)).toBe(1);
    expect(conformExitCode(report(result('failed')), true)).toBe(1);
  });
});

describe('nc-conform against a running mock', () => {
  const run = async (
    options: {
      omit?: string[];
      extra?: string[];
      breaks?: (typeof BREAKS)[number][];
      advertise?: string[];
    } = {}
  ): Promise<{ code: number; out: string; err: string }> => {
    const mock = await startMock({
      spec: loadCommittedDocument(),
      breaks: new Set(options.breaks ?? []),
      ...(options.advertise === undefined ? {} : { advertise: options.advertise }),
      control: true,
    });
    try {
      const t = await mock.tokens();
      const flags: Record<string, string> = {
        '--base-url': mock.baseUrl,
        '--token': t.creator,
        '--approver-token': t.approver,
        '--creator-user-token': t.creator_user,
        '--other-org-token': t.other_org,
        '--entitled-token': t.entitled,
        '--wrong-audience-token': t.wrong_audience,
        '--forged-token': t.forged,
        '--expired-token': t.expired,
        '--dpop-bound-token': t.dpop_bound,
        '--no-org-token': t.no_org,
        '--no-scope-token': t.no_scope,
        '--other-service-token': t.other_service,
        '--member-token': t.member,
        '--admin-token': t.admin,
        '--approver-surface-token': t.approver_surface_token,
        '--approver-token-without-resolve-scope': t.approver_token_without_resolve_scope,
        '--clock-control': `${mock.baseUrl}/__mock/advance`,
        '--mock-control': `${mock.baseUrl}/__mock/control`,
        '--reserved-tool-ref': MOCK_FIXTURES.reserved_tool_ref,
        '--system-tool-ref': MOCK_FIXTURES.system_tool_ref,
        '--tool-ref-in-use': MOCK_FIXTURES.tool_ref_in_use,
        '--on-deny-tool-ref': MOCK_FIXTURES.on_deny_tool_ref,
        '--on-deny-silent-tool-ref': MOCK_FIXTURES.on_deny_silent_tool_ref,
        '--admin-role': MOCK_FIXTURES.admin_role,
        '--connection-server-url': MOCK_FIXTURES.connection_server_url,
        '--oauth-return-to': MOCK_FIXTURES.oauth_return_to,
      };
      for (const flag of options.omit ?? []) Reflect.deleteProperty(flags, flag);
      const argv = [...Object.entries(flags).flat(), ...(options.extra ?? [])];
      const { io, out, err } = buffers();
      return {
        code: await runConformCli(argv, io, loadCommittedDocument()),
        out: out.join('\n'),
        err: err.join('\n'),
      };
    } finally {
      await mock.stop();
    }
  };

  it('exits 0 when every scenario passes', async () => {
    const { code, out, err } = await run();
    expect(out).toContain('0 failed');
    expect(code).toBe(0);
    expect(err).toBe('');
  }, 120_000);

  it('runs as before with --face public, and says on stderr that the flag is deprecated', async () => {
    const { code, err } = await run({ extra: ['--face', 'public'] });
    expect(code).toBe(0);
    expect(err).toMatch(/^nc-conform: --face is deprecated and ignored/);
  }, 120_000);

  it('exits 1 when scenarios were skipped for lack of a token, and 0 with --allow-skips', async () => {
    const omit = ['--entitled-token', '--forged-token'];
    const strict = await run({ omit });
    expect(strict.code).toBe(1);
    expect(strict.err).toContain('did not run');
    expect(strict.err).toContain('--entitled-token');
    const allowed = await run({ omit, extra: ['--allow-skips'] });
    expect(allowed.code).toBe(0);
    expect(allowed.err).toContain('WARNING');
  }, 240_000);

  it('without --approver-token every approver scenario skips as unconfigured: exit 1, naming the flag, 0 failed; 0 with --allow-skips', async () => {
    const omit = ['--approver-token'];
    const strict = await run({ omit });
    expect(strict.out).toContain('0 failed');
    expect(strict.code).toBe(1);
    expect(strict.err).toContain('lifecycle-proxied-tool-run-scoped: no token for approver');
    expect(strict.err).toContain('(pass --approver-token)');
    const allowed = await run({ omit, extra: ['--allow-skips'] });
    expect(allowed.out).toContain('0 failed');
    expect(allowed.code).toBe(0);
    expect(allowed.err).toContain('WARNING');
  }, 240_000);

  it('exits 1 without --member-token, naming the flag', async () => {
    const noMember = await run({ omit: ['--member-token'] });
    expect(noMember.code).toBe(1);
    expect(noMember.err).toContain('approval-arguments-withheld-from-an-ineligible-user');
    expect(noMember.err).toContain('--member-token');
  }, 240_000);

  it('exits 1 without --approver-surface-token, naming the flag and the two scenarios that need it; 0 with --allow-skips', async () => {
    const noSurface = await run({ omit: ['--approver-surface-token'] });
    expect(noSurface.out).toContain('0 failed');
    expect(noSurface.code).toBe(1);
    expect(noSurface.err).toContain('creator-may-resolve-from-the-approver-surface');
    expect(noSurface.err).toContain('approver-surface-token-cannot-open');
    expect(noSurface.err).toContain('--approver-surface-token');
    const allowed = await run({
      omit: ['--approver-surface-token'],
      extra: ['--allow-skips'],
    });
    expect(allowed.code).toBe(0);
  }, 240_000);

  it('exits 1 without --approver-token-without-resolve-scope, naming the flag and the scenario that needs it; 0 with --allow-skips', async () => {
    const omit = ['--approver-token-without-resolve-scope'];
    const noScopeless = await run({ omit });
    expect(noScopeless.out).toContain('0 failed');
    expect(noScopeless.code).toBe(1);
    expect(noScopeless.err).toContain('WARNING: 2 scenario(s) did not run');
    expect(noScopeless.err).toContain('user-token-without-resolve-scope-is-insufficient-scope');
    expect(noScopeless.err).toContain('available-actions-hidden-without-resolve-scope');
    expect(noScopeless.err).toContain('--approver-token-without-resolve-scope');
    const allowed = await run({ omit, extra: ['--allow-skips'] });
    expect(allowed.code).toBe(0);
  }, 240_000);

  it("exits 1 without --admin-token, naming the flag, the scenario about an administrator's own view and (rev 10) the policy-authoring ones; 0 with --allow-skips", async () => {
    const noAdmin = await run({ omit: ['--admin-token'] });
    expect(noAdmin.out).toContain('0 failed');
    expect(noAdmin.code).toBe(1);
    expect(noAdmin.err).toMatch(/WARNING: \d+ scenario\(s\) did not run/);
    for (const id of [
      'tools-principal-owned-seen-by-administrator-users-only',
      'hosted-authoring-routes',
      'tenancy-policy-writes-isolated',
      'policy-authoring-targets-name-state-and-versions',
      'negative-policy-authoring-needs-an-administrator',
      'rejected-duplicate-ask-again-reopens-with-prior-rejections',
      // The routes only those scenarios reach are not verified, so the every-route check is a skip too.
      'every-route-responds-per-schema: no token for admin',
    ])
      expect(noAdmin.err).toContain(id);
    expect(noAdmin.err).toContain('--admin-token');
    const allowed = await run({ omit: ['--admin-token'], extra: ['--allow-skips'] });
    expect(allowed.code).toBe(0);
  }, 240_000);

  it('exits 0 without --allow-skips against a deployment that advertises decisions and records only, printing the rest as skipped: capability', async () => {
    const { code, out, err } = await run({ advertise: ['decisions', 'records'] });
    expect(out).toContain('0 failed');
    expect(out).toContain('skipped: capability lifecycle-proxied-tool-run-scoped');
    expect(out).toContain('skipped: capability lifecycle-proxied-tool-principal-scoped');
    expect(err).not.toContain('WARNING');
    expect(code).toBe(0);
  }, 120_000);

  it('exits 1 when the capabilities read fails, even with --allow-skips', async () => {
    const { code, out } = await run({
      breaks: ['capabilities_unreadable'],
      extra: ['--allow-skips'],
    });
    expect(out).toContain('capabilities-read-at-run-start');
    expect(code).toBe(1);
  }, 120_000);

  it('exits 1 on a failure, even with --allow-skips', async () => {
    const { code, out } = await run({ breaks: ['accept_missing_token'], extra: ['--allow-skips'] });
    expect(out).toMatch(/[1-9]\d* failed/);
    expect(code).toBe(1);
  }, 120_000);

  it('prints the report as JSON with --json', async () => {
    const { out } = await run({ extra: ['--json'] });
    expect((JSON.parse(out) as Report).failed).toBe(0);
  }, 120_000);

  it('exits 2 for a usage error, and says what is wrong', async () => {
    const { io, err, out } = buffers();
    expect(await runConformCli([], io)).toBe(2);
    expect(err.join()).toMatch(/nc-conform: --base-url is required/);
    expect(out).toEqual([]);
  });
});

describe('nc-mock arguments', () => {
  it('exits 2 for an unknown --break, naming the known ones', async () => {
    const { io, err } = buffers();
    expect(await startMockCli(['--break', 'nope'], io)).toEqual({ exit: 2 });
    expect(err.join()).toContain('unknown --break nope');
    expect(err.join()).toContain(BREAKS[0]);
  });

  it.each([
    ['--port', '-1'],
    ['--port', '65536'],
    ['--port', '80.5'],
    ['--port', 'abc'],
    ['--port', ''],
    ['--deployment', 'moon'],
    ['--face', 'moon'],
    ['--face', 'all'],
  ])('exits 2 for %s %s', async (flag, value) => {
    const { io, err } = buffers();
    expect(await startMockCli([flag, value], io)).toEqual({ exit: 2 });
    expect(err.join()).toMatch(/^nc-mock: /);
  });

  it('takes the rev 6 restrictions: --approval-arguments-max-bytes, --deliveries, --restrict-tool-registration, --max-body-bytes, --resolutions and --no-runs', async () => {
    const parsed = parseMockArgs([
      '--approval-arguments-max-bytes',
      '512',
      '--deliveries',
      'pull, held',
      '--restrict-tool-registration',
      '--max-body-bytes',
      '4096',
      '--resolutions',
      'approved,rejected',
      '--no-runs',
      '--restrict-connection-registration',
      '--connection-transports',
      'mcp',
    ]);
    expect(parsed).toMatchObject({
      restrictConnectionRegistration: true,
      connectionTransports: ['mcp'],
      approvalArgumentsMaxBytes: 512,
      deliveries: ['pull', 'held'],
      restrictToolRegistration: true,
      maxBodyBytes: 4096,
      resolutions: ['approved', 'rejected'],
    });
    // --no-runs is every family but runs.
    expect(parsed.advertise).toContain('approvals');
    expect(parsed.advertise).not.toContain('runs');
    const { io, err } = buffers();
    for (const [flag, value] of [
      ['--approval-arguments-max-bytes', '0'],
      ['--max-body-bytes', 'big'],
      ['--deliveries', 'smoke'],
      ['--deliveries', ''],
      ['--resolutions', ''],
      ['--connection-transports', 'grpc'],
      ['--connection-transports', ''],
    ] as const)
      expect(await startMockCli([flag, value], io)).toEqual({ exit: 2 });
    expect(err.join()).toContain('--deliveries is a comma-separated list of push, pull, held');
    expect(err.join()).toContain('--connection-transports is a comma-separated list of mcp, a2a');
    expect(await startMockCli(['--no-runs', '--advertise', 'decisions'], io)).toEqual({ exit: 2 });
  });

  it('takes --approver-surface-client: the approver_surface_token dev token is issued to that client, and an empty value is a usage error', async () => {
    expect(parseMockArgs(['--approver-surface-client', 'mod']).approverSurfaceClient).toBe('mod');
    expect(parseMockArgs([]).approverSurfaceClient).toBeUndefined();
    const { io, err } = buffers();
    expect(await startMockCli(['--approver-surface-client', ' '], io)).toEqual({ exit: 2 });
    expect(err.join()).toContain('--approver-surface-client');
    const started = await startMockCli(
      ['--port', '0', '--approver-surface-client', 'my-approvals-module'],
      io,
      loadCommittedDocument()
    );
    if (!('mock' in started)) throw new Error('expected a running mock');
    try {
      const tokens = await started.mock.tokens();
      const claims = (token: string): { sub: string; client_id?: string } =>
        JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
          sub: string;
          client_id?: string;
        };
      expect(claims(tokens.approver_surface_token)).toMatchObject({
        sub: claims(tokens.creator_user).sub,
        client_id: 'my-approvals-module',
      });
      expect(claims(tokens.creator_user).client_id).toBeUndefined();
    } finally {
      await started.mock.stop();
    }
  });

  it('a mock started with the restrictions advertises them on the capabilities', async () => {
    const { io } = buffers();
    const started = await startMockCli(
      [
        '--port',
        '0',
        '--approval-arguments-max-bytes',
        '2048',
        '--deliveries',
        'pull',
        '--restrict-tool-registration',
        '--resolutions',
        'approved,rejected',
      ],
      io,
      loadCommittedDocument()
    );
    if (!('mock' in started)) throw new Error('expected a running mock');
    try {
      const tokens = await started.mock.tokens();
      const response = await fetch(`${started.mock.baseUrl}/v1/capabilities`, {
        headers: { authorization: `Bearer ${tokens.creator}` },
      });
      const { data } = (await response.json()) as { data: Record<string, unknown> };
      expect(data).toMatchObject({
        limits: { approval_arguments_max_bytes: 2048 },
        continuation_deliveries: ['pull'],
        tool_registration: 'administrators',
        resolutions: ['approved', 'rejected'],
      });
    } finally {
      await started.mock.stop();
    }
  });

  it('takes --advertise as a list of families, and rejects a name that is neither a family nor the floor', async () => {
    expect(parseMockArgs(['--advertise', 'decisions,records']).advertise).toEqual([
      'decisions',
      'records',
    ]);
    expect(parseMockArgs(['--advertise', 'approvals, runs']).advertise).toEqual([
      'approvals',
      'runs',
    ]);
    expect(parseMockArgs(['--advertise', '']).advertise).toEqual([]);
    const { io, err } = buffers();
    expect(await startMockCli(['--advertise', 'decisions,nonsense'], io)).toEqual({ exit: 2 });
    expect(err.join()).toContain('unknown --advertise nonsense');
  });

  it('accepts the ends of the port range and the defaults', () => {
    expect(parseMockArgs(['--port', '0']).port).toBe(0);
    expect(parseMockArgs(['--port', '65535']).port).toBe(65535);
    expect(parseMockArgs([])).toEqual({
      port: 8787,
      deployment: 'hosted',
      breaks: [],
      allowedOrigins: [],
      restrictToolRegistration: false,
      restrictConnectionRegistration: false,
      deprecations: [],
    });
    expect(
      parseMockArgs(['--break', 'accept_missing_token', '--break', 'ignore_audience']).breaks
    ).toEqual(['accept_missing_token', 'ignore_audience']);
  });

  it('starts a mock on a free port and prints its tokens, and says --face public is deprecated', async () => {
    const { io, out, err } = buffers();
    const started = await startMockCli(
      ['--port', '0', '--face', 'public'],
      io,
      loadCommittedDocument()
    );
    if (!('mock' in started)) throw new Error('expected a running mock');
    try {
      const printed = JSON.parse(out.join()) as { base_url: string; tokens: { creator: string } };
      expect(printed.base_url).toBe(started.mock.baseUrl);
      expect(printed.tokens.creator).toBeTruthy();
      expect(err).toEqual([expect.stringMatching(/^nc-mock: --face is deprecated and ignored/)]);
    } finally {
      await started.mock.stop();
    }
  });
});
