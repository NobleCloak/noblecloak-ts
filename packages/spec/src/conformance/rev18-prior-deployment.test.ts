/**
 * The rev 18 scenarios against deployments that accept less: the mock started with `proposals` listing only the rows of
 * rev 14 and no member, and a deployment of rev 17 that advertises no `proposals` at all. The scenarios gated on a row
 * kind, a member or the advertisement are capability skips; the one negative that needs only `proposals` advertised
 * still passes where the member is listed without `role` or `tool_grants`, since the refusal it asserts is the same.
 */
import { describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { runAgainstMock } from './against-mock.js';
import { loadScenarios } from './scenarios.js';

const REV18 = loadScenarios()
  .filter((s) => s.id.startsWith('rev18-'))
  .map((s) => s.id);

describe('the rev 18 scenarios on a deployment that lists only the rows of rev 14', () => {
  it('skips every scenario that needs role rows or tool grants, and passes the rest', async () => {
    expect(REV18.length).toBeGreaterThanOrEqual(7);
    const run = await runAgainstMock({
      deployment: 'hosted',
      spec: loadCommittedDocument(),
      only: REV18,
      restrictions: { proposals: { row_kinds: ['baseline', 'tightening'], members: [] } },
    });
    const byId = new Map(run.results.map((r) => [r.id, r]));
    const skipped = (reason: string): unknown => ({
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: reason,
    });
    for (const id of [
      'rev18-role-rows-applied-without-an-agent',
      'rev18-role-row-not-entitled',
      'rev18-preview-names-a-shadowed-role-row',
    ])
      expect(byId.get(id), id).toMatchObject(
        skipped('the deployment does not accept role rows in a proposal')
      );
    for (const id of [
      'rev18-tool-grants-need-a-principal',
      'rev18-tool-grant-unknown-tool',
      'rev18-tool-grants-previewed-and-applied',
    ])
      expect(byId.get(id), id).toMatchObject(
        skipped('the deployment does not accept tool_grants in a proposal')
      );
    expect(byId.get('rev18-no-agent-no-tightening-no-grants')?.outcome).toBe('passed');
  });
});

describe('the rev 18 scenarios on a deployment of rev 17, which advertises no proposals', () => {
  it('skips every one of them as a capability skip, without a failure', async () => {
    const run = await runAgainstMock({
      deployment: 'hosted',
      spec: loadCommittedDocument(),
      only: REV18,
      // The overlay sets the member to undefined, which the JSON of the answer leaves out: the capabilities lack it.
      capabilities: { proposals: undefined },
      restrictions: { proposals: { row_kinds: ['baseline', 'tightening'], members: [] } },
    });
    for (const result of run.results.filter((r) => r.id.startsWith('rev18-')))
      expect(result, result.id).toMatchObject({ outcome: 'skipped', skipKind: 'capability' });
  });
});
