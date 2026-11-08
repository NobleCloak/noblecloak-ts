/**
 * The rev 18 scenarios against deployments that accept less: the mock started with `proposals` listing only the rows of
 * rev 14 and no member, and a deployment of rev 17 that advertises no `proposals` at all. The scenarios gated on a row
 * kind, a member or the advertisement are capability skips; the negative that needs only `proposals` advertised still
 * passes where the member is listed without `role` or `tool_grants`, since the refusal it asserts is the same, and so
 * do the two simulations as a service principal, whose proposal carries a tightening alone or which opens none.
 * Last, the entitlement scenarios against tokens of an organisation that is not the one each needs: each fails at
 * its first step, the capabilities read that names the entitlement.
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
    expect(REV18).toHaveLength(11);
    const run = await runAgainstMock({
      deployment: 'hosted',
      spec: loadCommittedDocument(),
      only: REV18,
      restrictions: { proposals: { row_kinds: ['baseline', 'tightening'], members: [] } },
    });
    const byId = new Map(run.results.map((r) => [r.id, r]));
    const skipped = (reason: string): Record<string, unknown> => ({
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: reason,
    });
    for (const id of [
      'rev18-role-rows-applied-without-an-agent',
      'rev18-role-row-not-entitled',
      'rev18-preview-names-a-shadowed-role-row',
      'rev18-preview-names-a-loosening-role-row',
      'rev18-role-row-key-rules',
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
    for (const id of [
      'rev18-no-agent-no-tightening-no-grants',
      'rev18-simulate-as-a-service-principal',
      'rev18-simulate-as-a-service-principal-own-policies',
    ])
      expect(byId.get(id)?.outcome, id).toBe('passed');
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
    const results = run.results.filter((r) => r.id.startsWith('rev18-'));
    expect(results).toHaveLength(REV18.length);
    for (const result of results)
      expect(result, result.id).toMatchObject({ outcome: 'skipped', skipKind: 'capability' });
    // The three that name no row kind or member are skipped for the advertisement alone.
    for (const id of [
      'rev18-no-agent-no-tightening-no-grants',
      'rev18-simulate-as-a-service-principal',
      'rev18-simulate-as-a-service-principal-own-policies',
    ])
      expect(
        results.find((r) => r.id === id),
        id
      ).toMatchObject({
        skipReason: 'the deployment does not advertise proposals',
      });
  });
});

describe('the rev 18 entitlement scenarios on tokens of the wrong organisation', () => {
  const ENTITLED = [
    'rev18-role-rows-applied-without-an-agent',
    'rev18-preview-names-a-shadowed-role-row',
    'rev18-preview-names-a-loosening-role-row',
  ];
  // The overlay answers every token's capabilities read with the same entitlements, as a deployment would answer
  // tokens of one organisation, so the precondition of each scenario sees the organisation it does not need.
  const run = (entitlements: string[]) =>
    runAgainstMock({
      deployment: 'hosted',
      spec: loadCommittedDocument(),
      only: [...ENTITLED, 'rev18-role-row-not-entitled'],
      capabilities: { entitlements },
    });

  it('fails the refusal at its first step when the other organisation holds policies.role_subjects', async () => {
    const result = (await run(['policies.role_subjects'])).results.find(
      (r) => r.id === 'rev18-role-row-not-entitled'
    );
    expect(result?.outcome).toBe('failed');
    expect(result?.failures.join('\n')).toMatch(
      /step 1 GET \/v1\/capabilities.*data\.entitlements should not contain "policies\.role_subjects"/
    );
  });

  it('fails the entitled scenarios at their first step when the organisation does not hold it', async () => {
    const results = (await run([])).results;
    for (const id of ENTITLED) {
      const result = results.find((r) => r.id === id);
      expect(result?.outcome, id).toBe('failed');
      expect(result?.failures.join('\n'), id).toMatch(
        /step 1 GET \/v1\/capabilities.*data\.entitlements should contain "policies\.role_subjects"/
      );
    }
  });
});
