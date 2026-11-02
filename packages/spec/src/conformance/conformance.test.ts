/**
 * The suite against the mock, in both deployments, and the broken-mock matrix: every flip must be
 * caught by the scenarios that name it.
 */
import { describe, expect, it } from 'vitest';

import { runAgainstMock } from './against-mock.js';
import { BREAKS } from '../mock/breaks.js';
import {
  formatMatrix,
  MATRIX,
  matrixConcurrency,
  negativeScenarioIds,
  runMatrix,
} from './matrix.js';
import { formatReport, unconfiguredSkips } from './run.js';

describe('conformance against the mock', () => {
  it.each(['hosted', 'edge'] as const)(
    '%s: every scenario that runs passes',
    async (deployment) => {
      const report = await runAgainstMock({ deployment });
      expect(formatReport(report)).toContain('0 failed');
      expect(report.failed).toBe(0);
      expect(report.passed).toBeGreaterThan(40);
      // The mock is handed every token and clock control, so nothing may be skipped for lack of
      // configuration: such a skip would be a scenario that silently verifies nothing.
      expect(unconfiguredSkips(report).map((r) => r.id)).toEqual([]);
    },
    120_000
  );

  it('a deployment that advertises targets_all: false passes every scenario that runs, none relying on an all-tools policy (adv-1)', async () => {
    const report = await runAgainstMock({
      deployment: 'hosted',
      restrictions: { restrictPolicyTargets: true },
    });
    expect(report.results.filter((r) => r.outcome === 'failed').map((r) => r.id)).toEqual([]);
    expect(
      report.results.find((r) => r.id === 'unsupported-policy-form-names-member')
    ).toMatchObject({ outcome: 'passed' });
  }, 120_000);

  it('holds every response to the document unless the run opts out', async () => {
    const run = {
      deployment: 'hosted',
      breaks: ['undeclared_handle_member'],
      only: ['lifecycle-external-tool'],
    } as const;
    const held = await runAgainstMock(run);
    expect(held.results.find((r) => r.id === 'lifecycle-external-tool')?.outcome).toBe('failed');
    const open = await runAgainstMock({ ...run, rejectUndeclared: false });
    expect(open.results.find((r) => r.id === 'lifecycle-external-tool')?.outcome).toBe('passed');
  }, 120_000);

  it('serves what a deployment that extends the document adds to a handle, and runs the scenarios it is given', async () => {
    const extended = await runAgainstMock({
      deployment: 'hosted',
      only: ['lifecycle-external-tool'],
      // The extension adds a member the document does not declare, so a run held to the document fails.
      mock: { extendHandle: (handle) => ({ ...handle, extended: true }) },
    });
    expect(extended.results.find((r) => r.id === 'lifecycle-external-tool')?.outcome).toBe(
      'failed'
    );
    // Given no scenarios, only the generated checks run.
    const none = await runAgainstMock({ deployment: 'hosted', scenarios: [] });
    expect(none.results.some((r) => r.id === 'lifecycle-external-tool')).toBe(false);
    expect(none.results.some((r) => r.id === 'head-without-token-refused-every-route')).toBe(true);
  }, 120_000);

  it('a deployment that advertises its batch limits is checked against them with no mock control', async () => {
    const report = await runAgainstMock({
      deployment: 'hosted',
      limits: { decisions: 50, records: 50 },
    });
    const outcome = (id: string): string | undefined =>
      report.results.find((r) => r.id === id)?.outcome;
    expect(outcome('advertised-decision-batch-limit-is-enforced')).toBe('passed');
    expect(outcome('advertised-records-batch-limit-is-enforced')).toBe('passed');
    // Without an advertisement they are a capability skip, not a pass.
    const plain = await runAgainstMock({ deployment: 'hosted' });
    expect(
      plain.results.find((r) => r.id === 'advertised-decision-batch-limit-is-enforced')
    ).toMatchObject({ outcome: 'skipped', skipKind: 'capability' });
  }, 120_000);

  it('a mock that echoes every continuation with its members reordered passes the continuation scenarios', async () => {
    const report = await runAgainstMock({ deployment: 'hosted', reorderContinuation: true });
    const outcome = (id: string): string | undefined =>
      report.results.find((r) => r.id === id)?.outcome;
    expect(outcome('continuation-echoed-to-its-creator-in-every-state')).toBe('passed');
    expect(outcome('continuation-on-the-stream-is-the-creators-alone')).toBe('passed');
    expect(outcome('lifecycle-proxied-tool-run-scoped')).toBe('passed');
    expect(outcome('lifecycle-proxied-tool-principal-scoped')).toBe('passed');
    expect(formatReport(report)).toContain('0 failed');
    expect(report.failed).toBe(0);
  }, 120_000);

  it('exercises every route the deployment serves', async () => {
    const report = await runAgainstMock({ deployment: 'hosted' });
    expect(report.results.find((r) => r.id === 'every-route-responds-per-schema')?.outcome).toBe(
      'passed'
    );
    expect(report.exercised).toEqual(
      expect.arrayContaining(['decide', 'consumeApproval', 'getResumption', 'authzenEvaluate'])
    );
  }, 120_000);
});

describe('the broken-mock matrix', () => {
  it('covers every negative scenario with a flip', () => {
    const named = new Set(MATRIX.flatMap((row) => row.fails));
    expect(negativeScenarioIds().filter((id) => !named.has(id))).toEqual([]);
  });

  it('has a row for every break flag the mock offers', () => {
    const rowed = new Set<string>(MATRIX.map((row) => row.flip));
    expect(BREAKS.filter((flag) => !rowed.has(flag))).toEqual([]);
    expect(MATRIX.filter((row) => !(BREAKS as readonly string[]).includes(row.flip))).toEqual([]);
  });

  it('names approvals-queue-and-detail among the failures of advertise_unserved', () => {
    const row = MATRIX.find((r) => r.flip === 'advertise_unserved');
    expect(row?.fails).toContain('approvals-queue-and-detail');
  });

  it('every flip is detected by the scenarios that name it', async () => {
    const report = await runMatrix();
    expect(formatMatrix(report)).toMatch(
      /broken-mock matrix: \d+\/\d+ flips detected, 0 negatives uncovered/
    );
    expect(report.flips.filter((f) => f.undetected.length > 0)).toEqual([]);
    expect(report.ok).toBe(true);
    // 160 rows, each against only the scenarios it names, four at a time, plus the two full-suite baselines. This vitest
    // test measured ~41 s at 4 lanes and ~52 s at 1 lane locally (load average ~2.5). The earlier shape ran the whole
    // suite per row, one at a time: 713 s here, 988 s in CI (~1.4x slower). 300 s leaves headroom on a 2-vCPU runner
    // under the full turbo gate.
  }, 300_000);

  it('a flip that nothing detects is reported, not hidden', async () => {
    const report = await runMatrix([
      { flip: 'idempotency_ignored', deployment: 'hosted', fails: ['negative-no-token'] },
    ]);
    expect(report.flips[0]?.undetected).toEqual(['negative-no-token']);
    expect(report.ok).toBe(false);
  }, 120_000);

  it('runs only the scenarios a flip names, including generated ones', async () => {
    const report = await runAgainstMock({
      deployment: 'hosted',
      only: ['negative-no-token', 'head-without-token-refused-every-route'],
    });
    expect(report.results.map((r) => r.id).sort()).toEqual([
      'head-without-token-refused-every-route',
      'negative-no-token',
    ]);
  }, 120_000);

  it('detects a flip that names a generated scenario, a policy-forms one and the coverage result', async () => {
    const rows = MATRIX.filter((r) =>
      [
        'unmatched_routes_open',
        'advertised_policy_form_refused',
        'response_schema_violation',
        'capabilities_unreadable',
      ].includes(r.flip)
    );
    expect(rows).toHaveLength(4);
    const report = await runMatrix(rows);
    expect(report.flips.filter((f) => f.undetected.length > 0)).toEqual([]);
    for (const f of report.flips) expect(f.failed.length).toBeGreaterThan(0);
  }, 120_000);

  it('a named id that is neither a scenario nor generated is an error, not a pass', async () => {
    await expect(
      runMatrix([
        { flip: 'idempotency_ignored', deployment: 'hosted', fails: ['no-such-scenario'] },
      ])
    ).rejects.toThrow(/no-such-scenario/);
  }, 120_000);

  it('keeps the order of the rows however many flips run at once', async () => {
    const rows = MATRIX.slice(0, 8);
    const report = await runMatrix(rows, { concurrency: 4 });
    expect(report.flips.map((f) => f.flip)).toEqual(rows.map((r) => r.flip));
    expect(report.flips.filter((f) => f.undetected.length > 0)).toEqual([]);
  }, 120_000);

  it('NC_MATRIX_CONCURRENCY overrides the default of at most four', () => {
    expect(matrixConcurrency({ NC_MATRIX_CONCURRENCY: '3' })).toBe(3);
    expect(matrixConcurrency({})).toBeGreaterThanOrEqual(1);
    expect(matrixConcurrency({})).toBeLessThanOrEqual(4);
    expect(matrixConcurrency({ NC_MATRIX_CONCURRENCY: 'x' })).toBeLessThanOrEqual(4);
  });
});
