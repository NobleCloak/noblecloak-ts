import { describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { loadScenarios } from './scenarios.js';
import { startMock } from '../mock/serve.js';
import { MOCK_FIXTURES } from './against-mock.js';
import { runConformance, formatSkipWarning } from './run.js';
import type { Report, Target } from './types.js';

const COVERAGE = 'every-route-responds-per-schema';

/** The route the resolve scenarios call: reached only by scenarios that need the approver. */
const RESOLVE = /\/resolve\b/;

async function run(options: {
  approver: boolean;
  /** Give the administrator's token too; true unless a test leaves it out. */
  admin?: boolean;
  refuseApproverRoutes?: boolean;
  /** Leave out the connection_server_url fixture (rev 11). */
  noServerUrl?: boolean;
}): Promise<Report> {
  const mock = await startMock({
    deployment: 'hosted',
    spec: loadCommittedDocument(),
    breaks: new Set(),
    control: true,
  });
  try {
    const tokens = await mock.tokens();
    const target: Target = {
      baseUrl: mock.baseUrl,
      deployment: 'hosted',
      tokens: {
        creator: tokens.creator,
        other_org: tokens.other_org,
        other_service: tokens.other_service,
        wrong_audience: tokens.wrong_audience,
        forged: tokens.forged,
        expired: tokens.expired,
        ...(options.approver ? { approver: tokens.approver } : {}),
        ...(options.admin === false ? {} : { admin: tokens.admin }),
      },
      fixtures:
        options.noServerUrl === true
          ? (Object.fromEntries(
              Object.entries(MOCK_FIXTURES).filter(([name]) => name !== 'connection_server_url')
            ) as unknown as Target['fixtures'])
          : MOCK_FIXTURES,
      clockControl: `${mock.baseUrl}/__mock/advance`,
      mockControl: `${mock.baseUrl}/__mock/control`,
      // A server that never answers an approver-only route with a 2xx.
      ...(options.refuseApproverRoutes === true
        ? {
            fetch: async (
              input: Parameters<typeof fetch>[0],
              init?: Parameters<typeof fetch>[1]
            ) => {
              const url =
                typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
              if (RESOLVE.test(new URL(url).pathname))
                return new Response(JSON.stringify({ error: { code: 'forbidden' } }), {
                  status: 403,
                  headers: { 'content-type': 'application/json' },
                });
              return fetch(input, init);
            },
          }
        : {}),
    };
    return await runConformance({
      target,
      spec: loadCommittedDocument(),
      scenarios: loadScenarios(),
    });
  } finally {
    await mock.stop();
  }
}

const coverage = (report: Report) => report.results.find((r) => r.id === COVERAGE);

describe('the every-route coverage check and the approver token', () => {
  it('is strict with an approver token: routes only approver scenarios reach, never answered 2xx, fail it', async () => {
    const report = await run({ approver: true, refuseApproverRoutes: true });
    const result = coverage(report);
    expect(result?.outcome).toBe('failed');
    expect(result?.failures.join('\n')).toMatch(RESOLVE);
  }, 120_000);

  it('without an approver token reports the unexercised approver-only routes as an unconfigured skip, not a pass', async () => {
    const report = await run({ approver: false });
    const result = coverage(report);
    expect(result?.outcome).toBe('skipped');
    expect(result?.skipKind).toBe('unconfigured');
    expect(result?.skipReason).toMatch(/^no token for approver: \d+ routes not exercised \(.+\)$/);
    expect(result?.failures).toEqual([]);
    expect(formatSkipWarning(report)).toContain(COVERAGE);
  }, 120_000);

  it('without an admin token (rev 10) reports the policy-authoring routes as an unconfigured skip, naming admin', async () => {
    const report = await run({ approver: true, admin: false });
    const result = coverage(report);
    expect(result?.outcome).toBe('skipped');
    expect(result?.skipKind).toBe('unconfigured');
    expect(result?.skipReason).toMatch(/^no token for admin: \d+ routes not exercised \(.+\)$/);
    expect(result?.skipReason).toContain('publishPolicy');
    expect(formatSkipWarning(report)).toContain('--admin-token');
    // Without either token, both are named.
    const neither = coverage(await run({ approver: false, admin: false }));
    expect(neither?.skipReason).toMatch(/^no token for approver, admin: /);
  }, 240_000);

  it('without the connection_server_url fixture (rev 11) reports refresh and discover as an unconfigured skip, naming the fixture', async () => {
    const report = await run({ approver: true, noServerUrl: true });
    const result = coverage(report);
    expect(result?.outcome).toBe('skipped');
    expect(result?.skipKind).toBe('unconfigured');
    expect(result?.skipReason).toMatch(
      /^no fixture for connection_server_url: \d+ routes not exercised \(.+\)$/
    );
    expect(result?.skipReason).toContain('refreshConnection');
    expect(result?.skipReason).toContain('discoverConnectionTools');
  }, 120_000);

  it('with an approver token and a server that answers everything, passes', async () => {
    const report = await run({ approver: true });
    expect(coverage(report)?.outcome).toBe('passed');
  }, 120_000);
});
