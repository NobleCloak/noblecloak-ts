/**
 * The rev 17 scenarios against a deployment that serves pull but whose list of kinds predates rev 17: the mock run with
 * a document whose `Continuation.kind` enum leaves out `claude_agent_sdk`. The negative scenario tests only that a kind
 * outside the enum is refused, so it passes there; the lifecycle scenario fails at its second step.
 */
import { describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { runAgainstMock } from './against-mock.js';

const LIFECYCLE = 'rev17-claude-agent-sdk-continuation-lifecycle';
const NEGATIVE = 'rev17-unknown-continuation-kind-is-refused';

const priorDocument = (): ReturnType<typeof loadCommittedDocument> => {
  const spec = loadCommittedDocument();
  const kind = (
    (
      ((spec.components as Record<string, unknown>).schemas as Record<string, unknown>)
        .Continuation as Record<string, unknown>
    ).properties as Record<string, { enum: string[] }>
  ).kind;
  expect(kind.enum).toContain('claude_agent_sdk');
  kind.enum = kind.enum.filter((k) => k !== 'claude_agent_sdk');
  return spec;
};

describe('the rev 17 scenarios on a deployment whose kinds predate rev 17', () => {
  for (const deployment of ['hosted', 'edge'] as const) {
    it(`${deployment}: the negative scenario passes and the lifecycle fails at step 2 with 400 invalid_request`, async () => {
      const run = await runAgainstMock({
        deployment,
        spec: priorDocument(),
        only: [LIFECYCLE, NEGATIVE],
        restrictions: { deliveries: ['pull', 'held'] },
      });
      const byId = new Map(run.results.map((r) => [r.id, r]));
      expect(byId.get(NEGATIVE)?.outcome).toBe('passed');
      const lifecycle = byId.get(LIFECYCLE);
      expect(lifecycle?.outcome).toBe('failed');
      expect(lifecycle?.failures[0]).toMatch(
        /^step 2 POST \/v1\/decisions: expected status 200, got 400 .*invalid_request/
      );
    });
  }
});
