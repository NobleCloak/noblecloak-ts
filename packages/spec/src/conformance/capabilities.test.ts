/**
 * Capability-driven skipping: what a run reads at the start, how it skips a family the deployment
 * does not advertise, and what it never skips.
 */
import { describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { loadScenarios } from './scenarios.js';
import { advertisedFamilies, FAMILIES } from '../spec/families.js';
import { runAgainstMock } from './against-mock.js';
import { assertLimits, assertRestrictions } from './scenarios.js';
import { conformExitCode } from '../cli/nc-conform-main.js';
import {
  CAPABILITIES_READ,
  PLACEHOLDER_PRINCIPAL_ID,
  formatReport,
  formatSkipWarning,
  policyFormsScenario,
  runConformance,
  unconfiguredSkips,
} from './run.js';
import type { HttpStep, Target } from './types.js';

describe('advertisedFamilies', () => {
  it('advertises approvals iff resolutions is non-empty and every other family iff its name is in features', () => {
    expect([...advertisedFamilies({ resolutions: [], features: [] })]).toEqual([]);
    expect([...advertisedFamilies({ resolutions: ['approved'], features: [] })]).toEqual([
      'approvals',
    ]);
    // `approvals` in features does nothing: resolutions is the only signal for it.
    expect([...advertisedFamilies({ resolutions: [], features: ['approvals'] })]).toEqual([]);
    expect([
      ...advertisedFamilies({ resolutions: [], features: ['runs', 'policies.publish', 'x'] }),
    ]).toEqual(['runs']);
    expect(advertisedFamilies({ resolutions: ['approved'], features: [...FAMILIES] }).size).toBe(
      FAMILIES.length
    );
  });
});

describe('a deployment that does not advertise a feature (rev 10)', () => {
  it('skips the scenarios that need it as a capability, and the every-route check does not expect its operations', async () => {
    // Every family and hosted feature the mock advertises, but neither policy import and export nor the
    // rejected-duplicate rule.
    const features = [
      ...FAMILIES.filter((family) => family !== 'approvals'),
      'policies.author',
      'policies.publish',
      'records.verify',
      'evidence.export',
    ];
    const report = await runAgainstMock({ deployment: 'hosted', capabilities: { features } });
    expect(report.results.filter((r) => r.outcome === 'failed').map((r) => r.id)).toEqual([]);
    const byId = new Map(report.results.map((r) => [r.id, r]));
    for (const [id, feature] of [
      ['hosted-policy-import-export', 'policies.import_export'],
      ['rejected-duplicate-is-denied-by-default', 'approvals.rejected_duplicate'],
      [
        'rejected-duplicate-ask-again-reopens-with-prior-rejections',
        'approvals.rejected_duplicate',
      ],
    ] as const)
      expect(byId.get(id), id).toMatchObject({
        outcome: 'skipped',
        skipKind: 'capability',
        skipReason: `the deployment does not advertise ${feature}`,
      });
    expect(byId.get('every-route-responds-per-schema')?.outcome).toBe('passed');
    expect(report.exercised).not.toContain('importPolicies');
    expect(report.exercised).not.toContain('exportPolicy');
  }, 120_000);
});

describe('the floor', () => {
  const scenarios = loadScenarios();
  const isFloor = (s: { requires?: unknown; unless?: unknown }): boolean =>
    s.requires === undefined && s.unless === undefined;

  it('is exactly the scenarios tagged floor: none carries requires or unless, and none without them lacks the tag', () => {
    const tagged = scenarios.filter((s) => s.tags.includes('floor'));
    expect(tagged.length).toBeGreaterThan(20);
    expect(tagged.filter((s) => !isFloor(s)).map((s) => s.id)).toEqual([]);
    expect(
      scenarios.filter((s) => isFloor(s) && !s.tags.includes('floor')).map((s) => s.id)
    ).toEqual([]);
  });

  it('runs and passes under --advertise decisions,records, every floor scenario that applies to the deployment', async () => {
    const report = await runAgainstMock({
      deployment: 'hosted',
      advertise: ['decisions', 'records'],
    });
    const byId = new Map(report.results.map((r) => [r.id, r]));
    // A floor scenario may still be skipped by design: another deployment's, a DPoP mode other than off,
    // or a batch limit this mock does not advertise (`limits`).
    const applies = (s: (typeof scenarios)[number]): boolean =>
      (s.only === undefined || s.only === 'hosted') &&
      (s.dpop === undefined || s.dpop === 'off') &&
      s.limits === undefined &&
      // Nor one about a restriction this mock does not advertise (rev 6): it is a capability skip.
      s.advertises === undefined &&
      s.unserved_delivery === undefined &&
      s.unserved_resolution === undefined &&
      (s.tool_registration === undefined || s.tool_registration === 'any');
    const floor = scenarios.filter((s) => isFloor(s) && applies(s));
    expect(floor.length).toBeGreaterThan(20);
    for (const s of floor) expect(byId.get(s.id)?.outcome, s.id).toBe('passed');
  }, 120_000);
});

describe('a deployment that advertises decisions and records only', () => {
  it('is green, with every other family skipped as a capability and exit 0 without --allow-skips', async () => {
    const report = await runAgainstMock({
      deployment: 'hosted',
      advertise: ['decisions', 'records'],
    });
    expect(report.failed, formatReport(report)).toBe(0);
    const skipped = report.results.filter((r) => r.outcome === 'skipped');
    expect(skipped.length).toBeGreaterThan(20);
    // Every skip is a capability skip or a skip by design (another deployment); none is for lack of
    // configuration.
    expect(skipped.filter((r) => r.skipKind === 'unconfigured')).toEqual([]);
    expect(skipped.filter((r) => r.skipKind === 'capability').length).toBeGreaterThan(20);
    for (const id of [
      'lifecycle-proxied-tool-run-scoped',
      'lifecycle-proxied-tool-principal-scoped',
    ]) {
      expect(skipped.find((r) => r.id === id)).toMatchObject({ skipKind: 'capability' });
      expect(formatReport(report)).toContain(`skipped: capability ${id}`);
    }
    // The floor ran: a server advertising nothing does not pass on skips alone.
    for (const id of [
      'decision-allow',
      'decision-deny',
      'decision-batch',
      'routes-records',
      'routes-tools',
      'negative-no-token',
      'authzen-unmodified-client',
      'routes-capabilities-keys',
      'header-identity-without-token-401-every-route',
      'every-route-responds-per-schema',
    ])
      expect(report.results.find((r) => r.id === id)?.outcome, id).toBe('passed');
    expect(conformExitCode(report, false)).toBe(0);
  }, 120_000);

  it('answers 422 to a continuation on a step-up, and ignores one on an allow or a deny', async () => {
    const report = await runAgainstMock({
      deployment: 'hosted',
      advertise: ['decisions', 'records'],
    });
    for (const id of [
      'continuation-unsupported-without-approvals',
      'continuation-ignored-on-allow-and-deny',
    ])
      expect(report.results.find((r) => r.id === id)?.outcome, id).toBe('passed');
  }, 120_000);

  it('skips the 422 scenario on a deployment that advertises approvals, and still ignores a continuation on allow there', async () => {
    const report = await runAgainstMock({ deployment: 'hosted' });
    expect(
      report.results.find((r) => r.id === 'continuation-unsupported-without-approvals')
    ).toMatchObject({
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: 'the deployment advertises approvals',
    });
    expect(
      report.results.find((r) => r.id === 'continuation-ignored-on-allow-and-deny')?.outcome
    ).toBe('passed');
  }, 120_000);

  it('a deployment advertising no family at all still runs the floor', async () => {
    const report = await runAgainstMock({ deployment: 'hosted', advertise: [] });
    expect(report.failed, formatReport(report)).toBe(0);
    expect(report.passed).toBeGreaterThan(15);
  }, 120_000);

  it('the generated every-route steps leave out the routes of a family that is not advertised', async () => {
    const all = await runAgainstMock({ deployment: 'hosted' });
    const floor = await runAgainstMock({ deployment: 'hosted', advertise: [] });
    expect(all.results.find((r) => r.id === 'every-route-responds-per-schema')?.outcome).toBe(
      'passed'
    );
    expect(floor.exercised.length).toBeLessThan(all.exercised.length);
    expect(floor.exercised).not.toContain('createApproval');
    expect(floor.exercised).toEqual(
      expect.arrayContaining(['decide', 'appendRecord', 'listTools'])
    );
  }, 120_000);
});

describe('the capabilities read at run start', () => {
  const target = (
    fetchStub: typeof fetch,
    tokens: Target['tokens'] = { creator: 't' }
  ): Target => ({
    baseUrl: 'http://127.0.0.1:1',
    deployment: 'hosted',
    tokens,
    fixtures: { proxied_tool: 'a', allow_tool: 'b', deny_tool: 'c', default_tool: 'd' },
    fetch: fetchStub,
  });
  const run = (t: Target) =>
    runConformance({ target: t, spec: loadCommittedDocument(), scenarios: [] });

  it.each([
    [
      'a non-200 answer',
      () => Promise.resolve(new Response('no', { status: 503 })),
      /answered 503/,
    ],
    [
      'a body that is not JSON',
      () => Promise.resolve(new Response('<html>', { status: 200 })),
      /did not answer JSON/,
    ],
    [
      'a body that does not match the document',
      () => Promise.resolve(Response.json({ data: { deployment: 'hosted' }, meta: {} })),
      /does not match the document/,
    ],
    [
      'a request that cannot be made',
      () => Promise.reject(new Error('connection refused')),
      /connection refused/,
    ],
  ])('fails the run, and runs nothing else, on %s', async (_name, stub, message) => {
    const report = await run(target(stub));
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.results.map((r) => r.id)).toEqual([CAPABILITIES_READ]);
    expect(report.results[0]?.failures.join()).toMatch(message);
  });

  it('fails the run when there is no creator token to read it with', async () => {
    const report = await run(target(() => Promise.reject(new Error('unreachable')), {}));
    expect(report.results[0]?.failures.join()).toMatch(/no creator token/);
    expect(report.failed).toBe(1);
  });
});

describe('a route of a family the deployment does not advertise', () => {
  it.each([
    { deployment: 'hosted', advertise: ['decisions', 'records'] },
    { deployment: 'edge', advertise: undefined },
  ] as const)(
    'is probed with no token and may not answer 200 ($deployment)',
    async ({ deployment, advertise }) => {
      const report = await runAgainstMock({
        deployment,
        breaks: ['unadvertised_routes_open'],
        ...(advertise === undefined ? {} : { advertise }),
      });
      const failed = report.results.filter((r) => r.outcome === 'failed').map((r) => r.id);
      expect(failed).toContain(
        deployment === 'edge'
          ? 'hosted-routes-404-on-edge'
          : 'header-identity-without-token-401-every-route'
      );
    },
    120_000
  );
});

describe('a deployment that advertises one family beyond the floor', () => {
  const hostedOnly = ['records.checkpoints', 'evidence'];
  const cases = [
    ...FAMILIES.map((family) => ({ deployment: 'hosted' as const, advertise: [family] })),
    ...FAMILIES.filter((f) => !hostedOnly.includes(f)).map((family) => ({
      deployment: 'edge' as const,
      advertise: [family],
    })),
    // Every family but one: the one left out may not be a precondition of another family's routes.
    ...FAMILIES.map((left) => ({
      deployment: 'hosted' as const,
      advertise: FAMILIES.filter((f) => f !== left),
    })),
  ];
  it.each(cases)(
    'is green on $deployment advertising $advertise',
    async ({ deployment, advertise }) => {
      const report = await runAgainstMock({ deployment, advertise });
      expect(report.failed, formatReport(report)).toBe(0);
    },
    120_000
  );
});

describe('a deployment that says its DPoP mode on capabilities', () => {
  it('runs the dpop_unsupported scenarios only when the mode is off or absent', async () => {
    const off = await runAgainstMock({ deployment: 'hosted' });
    for (const id of ['negative-dpop-scheme-unsupported', 'negative-dpop-bound-token-unsupported'])
      expect(off.results.find((r) => r.id === id)?.outcome, id).toBe('passed');
    expect(conformExitCode(off, false)).toBe(0);
    expect(off.results.find((r) => r.id === 'dpop-optional-accepts-bearer')).toMatchObject({
      outcome: 'skipped',
      skipKind: 'capability',
    });
  }, 120_000);

  it.each(['optional', 'required'] as const)(
    'with the mode %s the two off scenarios are UNVERIFIED skips that fail the exit code unless skips are allowed',
    async (dpop) => {
      const report = await runAgainstMock({
        deployment: 'hosted',
        capabilities: { dpop },
      });
      expect(report.failed, formatReport(report)).toBe(0);
      for (const id of [
        'negative-dpop-scheme-unsupported',
        'negative-dpop-bound-token-unsupported',
      ])
        expect(report.results.find((r) => r.id === id)).toMatchObject({
          outcome: 'skipped',
          skipKind: 'unconfigured',
        });
      expect(unconfiguredSkips(report).map((r) => r.id)).toEqual(
        expect.arrayContaining([
          'negative-dpop-scheme-unsupported',
          'negative-dpop-bound-token-unsupported',
        ])
      );
      expect(formatSkipWarning(report)).toContain('negative-dpop-scheme-unsupported');
      expect(conformExitCode(report, false)).toBe(1);
      expect(conformExitCode(report, true)).toBe(0);
    },
    120_000
  );

  it('is green with the mode optional on failures, and the optional scenario runs', async () => {
    const report = await runAgainstMock({
      deployment: 'hosted',
      capabilities: { dpop: 'optional' },
    });
    expect(report.failed, formatReport(report)).toBe(0);
    expect(report.results.find((r) => r.id === 'dpop-optional-accepts-bearer')?.outcome).toBe(
      'passed'
    );
  }, 120_000);

  it('is green with the member present as off', async () => {
    const report = await runAgainstMock({
      deployment: 'hosted',
      capabilities: { dpop: 'off' },
    });
    expect(report.failed, formatReport(report)).toBe(0);
  }, 120_000);
});

describe('the batch of exactly 100 (D-A28: an absent limit means 100)', () => {
  const ids = [
    'batch-of-100-decisions-is-accepted-when-no-lower-limit-is-advertised',
    'batch-of-100-records-is-accepted-when-no-lower-limit-is-advertised',
  ];

  it('runs and passes when no limit is advertised, and when 100 is', async () => {
    for (const limits of [undefined, { decisions: 100, records: 100 }]) {
      const report = await runAgainstMock({
        deployment: 'hosted',
        ...(limits === undefined ? {} : { limits }),
      });
      for (const id of ids)
        expect(
          report.results.find((r) => r.id === id)?.outcome,
          `${id} ${JSON.stringify(limits)}`
        ).toBe('passed');
    }
  }, 120_000);

  it('is skipped as a capability, not failed, by a deployment that advertises a lower limit - each scenario by its own limit', async () => {
    const report = await runAgainstMock({
      deployment: 'hosted',
      limits: { decisions: 50 },
    });
    // (Other scenarios assume no initial limit and may fail here; this one is about the two above.)
    expect(report.results.find((r) => r.id === ids[0])).toMatchObject({
      outcome: 'skipped',
      skipKind: 'capability',
    });
    expect(report.results.find((r) => r.id === ids[0])?.skipReason).toContain(
      'decisions_batch_max_items 50'
    );
    expect(report.results.find((r) => r.id === ids[1])?.outcome).toBe('passed');
  }, 120_000);

  it('rejects a scenario file whose unreduced_limits names no limit', () => {
    expect(() => {
      assertLimits(
        { id: 's', title: 't', tags: ['both'], steps: [], unreduced_limits: ['x'] } as never,
        'f.yaml'
      );
    }).toThrow(/unreduced_limits/);
  });

  it('rejects a scenario file whose arguments_bytes is not a positive integer (rev 14)', () => {
    const scenario = (value: unknown): never =>
      ({ id: 's', title: 't', tags: ['both'], steps: [], arguments_bytes: value }) as never;
    for (const bad of [0, -1, 1.5, '4096', null])
      expect(() => {
        assertRestrictions(scenario(bad), 'f.yaml');
      }).toThrow(/arguments_bytes/);
    expect(() => {
      assertRestrictions(scenario(4096), 'f.yaml');
    }).not.toThrow();
  });

  it('rev 14: a proposal scenario is skipped as a capability where the advertised bound is below its size, or where nothing is applied, and runs otherwise', async () => {
    const ids = ['proposal-applied-on-approval', 'proposal-refused-bad-shape'];
    const bound = await runAgainstMock({
      deployment: 'hosted',
      only: ids,
      restrictions: { approvalArgumentsMaxBytes: 512 },
    });
    for (const id of ids) {
      expect(bound.results.find((r) => r.id === id)).toMatchObject({
        outcome: 'skipped',
        skipKind: 'capability',
      });
      expect(bound.results.find((r) => r.id === id)?.skipReason).toContain(
        'approval_arguments_max_bytes 512, below the 4096 bytes'
      );
    }
    // A bound that is big enough does not skip them.
    const roomy = await runAgainstMock({
      deployment: 'hosted',
      only: ids,
      restrictions: { approvalArgumentsMaxBytes: 32_768 },
    });
    expect(roomy.results.map((r) => r.outcome)).toEqual(['passed', 'passed']);
    // A deployment that lists no reference it applies (an empty list says what an absent one does) skips them.
    const none = await runAgainstMock({
      deployment: 'hosted',
      only: ids,
      capabilities: { deployment_applied: [] },
    });
    for (const id of ids) {
      expect(none.results.find((r) => r.id === id)).toMatchObject({
        outcome: 'skipped',
        skipKind: 'capability',
        skipReason: 'the deployment does not advertise deployment_applied',
      });
    }
  }, 120_000);

  it('rejects a scenario file whose self_approval_from_approver_surface is not a boolean, and accepts true and false', () => {
    const scenario = (value: unknown): never =>
      ({
        id: 's',
        title: 't',
        tags: ['both'],
        steps: [],
        self_approval_from_approver_surface: value,
      }) as never;
    expect(() => {
      assertRestrictions(scenario('yes'), 'f.yaml');
    }).toThrow(/self_approval_from_approver_surface/);
    expect(() => {
      assertRestrictions(scenario(true), 'f.yaml');
      assertRestrictions(scenario(false), 'f.yaml');
    }).not.toThrow();
  });

  it('reads self_approval_from_approver_surface from the capabilities: the surface scenarios run where it is true and are capability skips where it is false', async () => {
    const ids = [
      'creator-may-resolve-from-the-approver-surface',
      'approver-surface-token-cannot-open',
    ];
    const ran = await runAgainstMock({ deployment: 'hosted' });
    for (const id of ids) expect(ran.results.find((r) => r.id === id)?.outcome, id).toBe('passed');
    const off = await runAgainstMock({
      deployment: 'hosted',
      capabilities: { self_approval_from_approver_surface: false },
    });
    for (const id of ids)
      expect(
        off.results.find((r) => r.id === id),
        id
      ).toMatchObject({
        outcome: 'skipped',
        skipKind: 'capability',
        skipReason: "the deployment's self_approval_from_approver_surface is false, not true",
      });
    expect(off.failed, formatReport(off)).toBe(0);
  }, 120_000);
});

describe('a deployment that registers connections only in other forms (rev 11)', () => {
  it('skips the connection scenarios it cannot serve as a capability, and fails none', async () => {
    const report = await runAgainstMock({
      deployment: 'hosted',
      restrictions: {
        connectionRegistration: { owner_kinds: ['principal'], who: 'any' },
        connectionTransports: ['a2a'],
      },
    });
    // No connection scenario fails. The every-route check still expects the connection routes exercised, and no
    // scenario registers a principal-owned a2a server, so it is the one failure such a deployment sees.
    expect(report.results.filter((r) => r.outcome === 'failed').map((r) => r.id)).toEqual([
      'every-route-responds-per-schema',
    ]);
    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(byId.get('routes-connections')).toMatchObject({
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: 'the deployment does not register org-owned connections',
    });
    expect(byId.get('negative-principal-owned-connection-hidden')).toMatchObject({
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: 'the deployment does not serve the mcp connection transport',
    });
  }, 120_000);
});

describe('policyFormsScenario (rev 11 errata)', () => {
  const forms = (subjectTypes: readonly string[]) => ({
    tool_invocation: {
      modes: ['ask', 'deny'],
      subject_types: subjectTypes,
      targets_all: true,
      config_members: ['approver_groups'],
    },
  });
  const drafts = (scenario: ReturnType<typeof policyFormsScenario>) =>
    scenario.steps
      .filter(
        (s): s is HttpStep =>
          'request' in s && s.request.method === 'POST' && s.request.path === '/v1/policies'
      )
      .map(
        (s) =>
          s.request.body as {
            subjects: { type: string; id?: string }[];
            config: Record<string, unknown>;
          }
      );

  it('drafts only advertised subject types, role first, with a uuid-shaped id for a principal and an approver group', () => {
    const noOrg = policyFormsScenario(forms(['user', 'role']));
    const bodies = drafts(noOrg);
    expect(bodies.flatMap((b) => b.subjects.map((s) => s.type))).not.toContain('organization');
    // The drafts of the other forms name role, advertised here.
    expect(bodies[0]?.subjects).toEqual([{ type: 'role', id: 'conformance' }]);
    const user = bodies.flatMap((b) => b.subjects).find((s) => s.type === 'user');
    expect(user?.id).toBe(PLACEHOLDER_PRINCIPAL_ID);
    expect(PLACEHOLDER_PRINCIPAL_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    const groups = bodies.find((b) => 'approver_groups' in b.config)?.config.approver_groups;
    expect(groups).toEqual([PLACEHOLDER_PRINCIPAL_ID]);
    // Without role, the first advertised type.
    expect(drafts(policyFormsScenario(forms(['agent', 'organization'])))[0]?.subjects).toEqual([
      { type: 'agent', id: PLACEHOLDER_PRINCIPAL_ID },
    ]);
  });

  it('creates a real agent for its agent-subject drafts where agents are served, a placeholder where not', () => {
    const served = policyFormsScenario(forms(['agent', 'role']), true);
    const created = served.steps.filter(
      (s): s is HttpStep =>
        'request' in s && s.request.method === 'POST' && s.request.path === '/v1/agents'
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.save).toEqual({ agent: 'data.id' });
    const agentSubjects = drafts(served)
      .flatMap((b) => b.subjects)
      .filter((s) => s.type === 'agent');
    expect(agentSubjects.length).toBeGreaterThan(0);
    expect(agentSubjects.every((s) => s.id === '${agent}')).toBe(true);
    const unserved = policyFormsScenario(forms(['agent', 'role']), false);
    expect(unserved.steps.some((s) => 'request' in s && s.request.path === '/v1/agents')).toBe(
      false
    );
    expect(
      drafts(unserved)
        .flatMap((b) => b.subjects)
        .find((s) => s.type === 'agent')?.id
    ).toBe(PLACEHOLDER_PRINCIPAL_ID);
    // No agent row is made where agent is not an advertised subject type.
    expect(
      policyFormsScenario(forms(['role']), true).steps.some(
        (s) => 'request' in s && s.request.path === '/v1/agents'
      )
    ).toBe(false);
  });

  it('is gated to a capability skip when no subject type is advertised', () => {
    const empty = policyFormsScenario(forms([]));
    expect(empty.serves_policy_subject_type).toBe('role');
    expect(drafts(empty)).toEqual([]);
  });
});
