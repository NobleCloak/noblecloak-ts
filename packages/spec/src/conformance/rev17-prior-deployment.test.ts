/**
 * The rev 17 scenarios against a deployment that serves pull but whose list of kinds predates rev 17: the mock run with
 * a document whose `Continuation.kind` enum leaves out `claude_agent_sdk`, so the mock does not advertise
 * `continuations.claude_agent_sdk`. The lifecycle scenario requires that feature and is skipped; the negative scenarios are
 * ungated and still pass (an unlisted kind is refused whatever its delivery).
 */
import { describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { runAgainstMock } from './against-mock.js';

const LIFECYCLE = 'rev17-claude-agent-sdk-continuation-lifecycle';
const NEGATIVE = 'rev17-unknown-continuation-kind-is-refused';
const PULL_ONLY = 'rev17-claude-agent-sdk-is-pull-only';

const priorDocument = (): ReturnType<typeof loadCommittedDocument> => {
  const spec = loadCommittedDocument();
  const kind = (
    (
      ((spec.components as Record<string, unknown>).schemas as Record<string, unknown>)
        .Continuation as Record<string, unknown>
    ).properties as Record<string, { enum: string[] } | undefined>
  ).kind;
  if (kind === undefined) throw new Error('Continuation.kind is missing from the document');
  expect(kind.enum).toContain('claude_agent_sdk');
  kind.enum = kind.enum.filter((k) => k !== 'claude_agent_sdk');
  return spec;
};

describe('the rev 17 scenarios on a deployment whose kinds predate rev 17', () => {
  for (const deployment of ['hosted', 'edge'] as const) {
    it(`${deployment}: both negative scenarios pass and the lifecycle is skipped for the missing feature`, async () => {
      const run = await runAgainstMock({
        deployment,
        spec: priorDocument(),
        only: [LIFECYCLE, NEGATIVE, PULL_ONLY],
        restrictions: { deliveries: ['pull', 'held'] },
      });
      const byId = new Map(run.results.map((r) => [r.id, r]));
      expect(byId.get(NEGATIVE)?.outcome).toBe('passed');
      expect(byId.get(PULL_ONLY)?.outcome).toBe('passed');
      expect(byId.get(LIFECYCLE)).toMatchObject({ outcome: 'skipped', skipKind: 'capability' });
    });
  }
});
