/** Orchestrates a conformance run: the scenario files, then the scenarios generated from the document. */
import type { JsonObject } from '../spec/load.js';
import { loadDocument } from '../spec/default.js';
import { advertisedFamilies } from '../spec/families.js';
import type { Family } from '../spec/families.js';
import {
  ORGANIZATION_HEADER,
  PERMISSIONS_HEADER,
  REJECTED_IDENTITY_HEADERS,
  SCOPES_HEADER,
  gatewayHeader,
} from '../spec/gateway-header.js';
import { SpecIndex, describeErrors } from '../spec/validate.js';
import type { OperationInfo } from '../spec/validate.js';
import { runScenario } from './engine.js';
import type { EngineDeps } from './engine.js';
import { loadCorpusPairs, loadScenarios } from './scenarios.js';
import { LIMIT_NAMES } from './types.js';
import type {
  AdvertisedLimits,
  AdvertisedRestrictions,
  ConnectionRegistration,
  ConnectionTransport,
  DeploymentApplied,
  Delivery,
  DpopMode,
  HttpStep,
  LimitName,
  PolicyForms,
  ProposalsAccepted,
  Report,
  Scenario,
  ScenarioResult,
  Target,
} from './types.js';

export interface RunOptions {
  readonly target: Target;
  /** The document to check against. Defaults to the published document (`loadDocument`). */
  readonly spec?: JsonObject;
  readonly scenarios?: readonly Scenario[];
  /**
   * Run only the scenarios with these ids: from `scenarios` and from the ones generated here (the header, HEAD,
   * edge and policy-forms checks), and the coverage result when it is named. An id that matches none of them
   * throws, so a typo cannot pass as a check that never ran. The capabilities read always happens. Naming the
   * coverage result runs everything, because coverage is what the other scenarios exercised.
   *
   * @internal For the broken-mock matrix only. A subset report proves far less than a full run (no coverage
   * result, no other scenarios), so never pass this when judging a deployment's conformance.
   */
  readonly only?: readonly string[];
}

/** The id of the coverage result `coverage` returns. */
export const COVERAGE_RESULT = 'every-route-responds-per-schema';

const fill = (path: string): string => path.replace(/\{[^}]+\}/g, 'x');

/** Whether the deployment serves `op`: the floor always, a family only when it advertised it. */
const served = (op: OperationInfo, advertised: ReadonlySet<Family>): boolean =>
  op.family === undefined || advertised.has(op.family);

/** One value per rejected name: a server that reads any of them takes a value it was never given. */
const SPOOFED_VALUE: Readonly<Record<string, string>> = {
  [gatewayHeader('id')]: 'user_spoofed',
  [gatewayHeader('type')]: 'service',
  [ORGANIZATION_HEADER]: 'org_spoofed',
  [PERMISSIONS_HEADER]: 'admin',
  [SCOPES_HEADER]: 'module_api admin',
};

/** A name under the prefix that the document does not list: the prefix rule rejects it all the same. */
const UNLISTED_PREFIXED_HEADER = gatewayHeader('on-behalf-of');

/**
 * Every rejected name together, each one alone (the rejection may not depend on a single name), then
 * one unlisted name under the prefix (the rejection is by prefix, not by the list of five).
 */
const headerSets = (): readonly Readonly<Record<string, string>>[] => [
  SPOOFED_VALUE,
  ...REJECTED_IDENTITY_HEADERS.map((name) => ({ [name]: SPOOFED_VALUE[name] ?? 'spoofed' })),
  { [UNLISTED_PREFIXED_HEADER]: 'spoofed' },
];

/**
 * What an authenticated route answers to a request that must not be served. A route the deployment
 * serves answers `served`; a route of a family it does not advertise may answer 404 instead (it is
 * not served) but never a 2xx: an unadvertised route that is open to an anonymous caller is a defect.
 */
const refusal = (
  op: OperationInfo,
  advertised: ReadonlySet<Family>,
  served_: HttpStep['expect']
): HttpStep['expect'] =>
  served(op, advertised) ? served_ : { status: [401, 404], undocumented: true };

function identityHeaderScenario(
  operations: readonly OperationInfo[],
  as: 'none' | 'creator',
  advertised: ReadonlySet<Family>
): Scenario {
  const steps: HttpStep[] = operations
    .filter((op) => op.authenticated)
    .flatMap((op) =>
      headerSets().map((headers) => ({
        name: `${op.method.toUpperCase()} ${op.path} with ${Object.keys(headers).join(' + ')}`,
        as,
        request: { method: op.method.toUpperCase(), path: fill(op.path), headers },
        expect: refusal(op, advertised, { status: 401, problem: 'header_identity_rejected' }),
      }))
    );
  return as === 'none'
    ? {
        id: 'header-identity-without-token-401-every-route',
        title:
          'A gateway identity header with no token is 401 header_identity_rejected on every authenticated route, all five names together, each alone, and an unlisted name under the prefix (generated from the document)',
        tags: ['both', 'negative', 'generated'],
        steps,
      }
    : {
        id: 'header-identity-with-valid-token-401-every-route',
        title:
          'A gateway identity header alongside a valid token is still 401 header_identity_rejected on every authenticated route, all five names together, each alone, and an unlisted name under the prefix (generated from the document)',
        tags: ['both', 'negative', 'generated'],
        steps,
      };
}

/**
 * HEAD is not an operation of the document, but a server routes it to the GET handler. Every
 * authenticated GET route must still refuse it with no token: authentication may not depend on the
 * request matching an operation.
 */
function headWithoutTokenScenario(operations: readonly OperationInfo[]): Scenario {
  const steps: HttpStep[] = operations
    .filter((op) => op.authenticated && op.method === 'get')
    .map((op) => ({
      name: `HEAD ${op.path}`,
      as: 'none',
      request: { method: 'HEAD', path: fill(op.path) },
      expect: { status: [401, 404, 405], undocumented: true },
    }));
  return {
    id: 'head-without-token-refused-every-route',
    title:
      'HEAD with no token is refused (401, 404 or 405) on every authenticated GET route (generated from the document)',
    tags: ['both', 'negative', 'generated'],
    steps,
  };
}

/** Every hosted route, whatever the edge deployment advertises: a hosted-only family is never advertised there. */
function notAvailableOnEdgeScenario(operations: readonly OperationInfo[]): Scenario {
  const steps: HttpStep[] = operations
    .filter((op) => op.deployment === 'hosted' && op.authenticated)
    .map((op) => ({
      name: `${op.method.toUpperCase()} ${op.path}`,
      as: 'entitled',
      request: {
        method: op.method.toUpperCase(),
        path: fill(op.path),
        ...(op.method === 'get' || op.method === 'delete' ? {} : { body: {} }),
      },
      expect: { status: 404, problem: 'not_available_on_deployment' },
    }));
  return {
    id: 'hosted-routes-404-on-edge',
    title:
      'Every hosted route is 404 not_available_on_deployment on an edge deployment (generated from the document)',
    tags: ['edge', 'negative', 'generated'],
    only: 'edge',
    needs: ['entitled'],
    steps,
  };
}

/**
 * A uuid-shaped placeholder id for a principal subject (user, group, agent, service) and an approver group: a
 * deployment may refuse an id that is not uuid-shaped with 400 before it looks at the form. It names nobody: the
 * drafts are never published.
 */
export const PLACEHOLDER_PRINCIPAL_ID = '00000000-0000-4000-8000-00000000c0f0';

/**
 * A value for each `ToolInvocationConfig` member the scenario below knows how to set. Rev 16's `rules` has none: a
 * rule's condition names a fact, and the registered tool declares none, so a rule would be refused for that (400),
 * not for its form.
 */
const CONFIG_MEMBER_VALUES: Readonly<Record<string, unknown>> = {
  on_deny: 'halt',
  expires_after: 'PT1H',
  approver_groups: [PLACEHOLDER_PRINCIPAL_ID],
  // Rev 16.
  approvers: [{ user: PLACEHOLDER_PRINCIPAL_ID }],
  exclude: ['requester'],
};

/**
 * Rev 11: a deployment that advertises `policy_forms` is never to refuse an advertised form with 422. One draft
 * per advertised mode, per advertised subject type, every tool when `targets_all`, and each advertised config
 * member (with the first approval-requiring mode advertised); each must be created. Every draft names an advertised
 * subject type (`role` when advertised, else the first), a role by a bare key and any other principal by a
 * uuid-shaped placeholder; with no subject type advertised it is a capability skip. Drafts only: nothing is
 * published, so nothing conflicts and nothing is enforced. A draft whose subject is an agent names a real row of
 * `/v1/agents`, created first, where the deployment serves `agents` (`servesAgents`); a deployment that does not
 * serve them gets the placeholder id. The agent row stays after the run (there is no `DELETE /v1/agents` route), as
 * the tools and the drafts do. Generated from the deployment's own advertisement; without the member it is a
 * capability skip.
 */
export function policyFormsScenario(
  forms: PolicyForms | undefined,
  servesAgents = false
): Scenario {
  const base = {
    id: 'policy-forms-advertised-are-accepted',
    title:
      'Every policy form the deployment advertises in policy_forms is created, never refused with 422 (generated from its capabilities)',
    tags: ['hosted', 'generated'],
    only: 'hosted' as const,
    requires: 'policies' as const,
    advertises: ['policy_forms' as const],
    needs: ['admin' as const],
  };
  const tool = forms?.tool_invocation;
  if (tool === undefined)
    return {
      ...base,
      steps: [{ request: { method: 'GET', path: '/v1/capabilities' }, expect: { status: 200 } }],
    };
  const ref = 'ext:pf:${uniq}';
  const realAgent = servesAgents && tool.subject_types.includes('agent');
  const subjectOf = (type: string): Record<string, unknown> =>
    type === 'organization'
      ? { type }
      : type === 'role'
        ? { type, id: 'conformance' }
        : type === 'agent' && realAgent
          ? { type, id: '${agent}' }
          : { type, id: PLACEHOLDER_PRINCIPAL_ID };
  // The drafts of the other forms name a subject type the deployment advertises: role when it does, else the first.
  const baseType = tool.subject_types.includes('role') ? 'role' : tool.subject_types[0];
  if (baseType === undefined)
    // Nothing a draft could name: skipped by the gate (no deployment advertises an empty subject type).
    return {
      ...base,
      serves_policy_subject_type: 'role',
      steps: [{ request: { method: 'GET', path: '/v1/capabilities' }, expect: { status: 200 } }],
    };
  const firstMode = tool.modes[0] ?? 'ask';
  const asking = tool.modes.find((mode) => mode === 'ask' || mode === 'escalate');
  const draft = (name: string, body: Record<string, unknown>): HttpStep => ({
    name,
    as: 'admin',
    request: {
      method: 'POST',
      path: '/v1/policies',
      body: {
        kind: 'tool_invocation',
        subjects: [subjectOf(baseType)],
        targets: { tools: [ref] },
        config: { mode: firstMode },
        ...body,
      },
    },
    expect: { status: 201 },
  });
  const steps: HttpStep[] = [
    ...(realAgent
      ? [
          {
            name: 'an agent for the drafts that name one',
            as: 'creator',
            request: {
              method: 'POST',
              path: '/v1/agents',
              body: { name: 'policy forms agent ${uniq}' },
            },
            expect: { status: 201 },
            save: { agent: 'data.id' },
          } satisfies HttpStep,
        ]
      : []),
    {
      name: 'register the tool the drafts govern',
      as: 'admin',
      request: {
        method: 'POST',
        path: '/v1/tools',
        body: {
          tool_ref: ref,
          transport: 'external',
          input_schema: { type: 'object' },
          side_effect_level: 'write',
          owner_kind: 'org',
        },
      },
      expect: { status: 201 },
    },
    ...tool.modes.map((mode) => draft(`mode ${mode}`, { config: { mode } })),
    ...tool.subject_types.map((type) =>
      draft(`subject type ${type}`, { subjects: [subjectOf(type)] })
    ),
    ...(tool.targets_all ? [draft('every tool', { targets: { tools: 'all' } })] : []),
    ...(asking === undefined
      ? []
      : tool.config_members
          .filter((member) => member in CONFIG_MEMBER_VALUES)
          .map((member) =>
            draft(`config member ${member}`, {
              config: { mode: asking, [member]: CONFIG_MEMBER_VALUES[member] },
            })
          )),
  ];
  return { ...base, steps };
}

/** The id of the result a failed capabilities read is reported under. */
export const CAPABILITIES_READ = 'capabilities-read-at-run-start';

type Advertisement =
  | {
      readonly families: ReadonlySet<Family>;
      /** Every name of `Capabilities.features`, as the deployment sent them. */
      readonly features: ReadonlySet<string>;
      readonly dpop: DpopMode;
      readonly limits: AdvertisedLimits;
      readonly restrictions: AdvertisedRestrictions;
    }
  | { readonly failure: string };

/**
 * Reads `GET /v1/capabilities` with the creator token, the answer that says which route families the
 * deployment serves. A non-200 answer, a body that is not JSON, or one that does not match the
 * document is a failure of the run: a deployment whose scope cannot be read is never assumed to serve
 * less.
 */
async function readAdvertisement(target: Target, index: SpecIndex): Promise<Advertisement> {
  const token = target.tokens.creator;
  if (token === undefined) return { failure: 'no creator token to read the capabilities with' };
  const info = index.match('GET', '/v1/capabilities');
  if (info === undefined) return { failure: 'the document has no GET /v1/capabilities' };
  let response: Response;
  try {
    response = await (target.fetch ?? fetch)(`${target.baseUrl}/v1/capabilities`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'manual',
    });
  } catch (error) {
    return {
      failure: `GET /v1/capabilities failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status !== 200)
    return { failure: `GET /v1/capabilities answered ${String(response.status)}, expected 200` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { failure: 'GET /v1/capabilities did not answer JSON' };
  }
  const { validate } = index.response(info, 200, 'application/json');
  if (!validate?.(body))
    return {
      failure: `GET /v1/capabilities does not match the document: ${validate === undefined ? 'no schema' : describeErrors(validate)}`,
    };
  const data = (
    body as {
      data: {
        resolutions: string[];
        features: string[];
        dpop?: DpopMode;
        limits?: Partial<Record<string, number>>;
        continuation_deliveries?: Delivery[];
        continuation_kinds?: string[];
        tool_registration?: 'any' | 'administrators';
        self_approval_from_approver_surface?: boolean;
        user_resolve_scope?: string;
        policy_forms?: PolicyForms;
        connection_registration?: ConnectionRegistration;
        connection_transports?: ConnectionTransport[];
        deployment_applied?: DeploymentApplied[];
        proposals?: ProposalsAccepted;
      };
    }
  ).data;
  const limits: Partial<Record<LimitName, number>> = {};
  for (const name of LIMIT_NAMES) {
    const advertised = data.limits?.[name];
    if (advertised !== undefined) limits[name] = advertised;
  }
  const boundBytes = data.limits?.approval_arguments_max_bytes;
  return {
    families: advertisedFamilies(data),
    features: new Set(data.features),
    dpop: data.dpop ?? 'off',
    limits,
    restrictions: {
      ...(boundBytes === undefined ? {} : { approval_arguments_max_bytes: boundBytes }),
      ...(data.continuation_deliveries === undefined
        ? {}
        : { continuation_deliveries: data.continuation_deliveries }),
      ...(data.continuation_kinds === undefined
        ? {}
        : { continuation_kinds: data.continuation_kinds }),
      tool_registration: data.tool_registration ?? 'any',
      resolutions: data.resolutions,
      self_approval_from_approver_surface: data.self_approval_from_approver_surface ?? false,
      ...(data.user_resolve_scope === undefined
        ? {}
        : { user_resolve_scope: data.user_resolve_scope }),
      ...(data.policy_forms === undefined ? {} : { policy_forms: data.policy_forms }),
      ...(data.connection_registration === undefined
        ? {}
        : { connection_registration: data.connection_registration }),
      ...(data.connection_transports === undefined
        ? {}
        : { connection_transports: data.connection_transports }),
      // An empty list says what an absent one does: nothing is applied, so a scenario that needs it is skipped.
      ...(data.deployment_applied === undefined || data.deployment_applied.length === 0
        ? {}
        : { deployment_applied: data.deployment_applied }),
      ...(data.proposals === undefined ? {} : { proposals: data.proposals }),
    },
  };
}

/** Runs the conformance suite against `options.target`. */
export async function runConformance(options: RunOptions): Promise<Report> {
  const { target } = options;
  const doc = options.spec ?? loadDocument();
  const index = new SpecIndex(doc, { rejectUndeclared: target.rejectUndeclared === true });
  const advertisement = await readAdvertisement(target, index);
  if ('failure' in advertisement) {
    // The run cannot tell what the deployment serves, so it runs nothing and fails.
    return {
      deployment: target.deployment,
      results: [
        {
          id: CAPABILITIES_READ,
          title:
            'GET /v1/capabilities answers 200 and matches the document, so the run knows what the deployment serves',
          tags: ['both', 'generated'],
          outcome: 'failed',
          failures: [advertisement.failure],
        },
      ],
      passed: 0,
      failed: 1,
      skipped: 0,
      exercised: [],
    };
  }
  const advertised = advertisement.families;
  const exercised = new Set<string>();
  const deps: EngineDeps = {
    index,
    advertised,
    features: advertisement.features,
    dpop: advertisement.dpop,
    limits: advertisement.limits,
    restrictions: advertisement.restrictions,
    target,
    exercised,
    corpus: loadCorpusPairs(),
  };
  const scenarios = options.scenarios ?? loadScenarios();
  const generated = [
    identityHeaderScenario(index.operations, 'none', advertised),
    identityHeaderScenario(index.operations, 'creator', advertised),
    headWithoutTokenScenario(index.operations),
    notAvailableOnEdgeScenario(index.operations),
    policyFormsScenario(
      advertisement.restrictions.policy_forms,
      advertisement.families.has('agents')
    ),
  ];
  const only = options.only === undefined ? undefined : new Set(options.only);
  const wantsCoverage = only === undefined || only.has(COVERAGE_RESULT);
  if (only !== undefined) {
    const known = new Set([
      ...scenarios.map((s) => s.id),
      ...generated.map((s) => s.id),
      COVERAGE_RESULT,
      CAPABILITIES_READ,
    ]);
    const unknown = [...only].filter((id) => !known.has(id));
    if (unknown.length > 0)
      throw new Error(
        `no scenario is named ${unknown.join(', ')}: it is neither a scenario nor generated`
      );
  }
  // Coverage needs the exercise of every scenario, so naming it keeps the whole suite.
  const selected = only === undefined || only.has(COVERAGE_RESULT) ? undefined : only;
  const results: ScenarioResult[] = [];
  for (const scenario of [...scenarios, ...generated])
    if (selected === undefined || selected.has(scenario.id))
      results.push(await runScenario(scenario, deps));
  // The generated edge scenario proves a hosted route is refused: that is its exercise.
  if (target.deployment === 'edge') {
    const edge = results.find((r) => r.id === 'hosted-routes-404-on-edge');
    if (edge?.outcome === 'passed')
      for (const op of index.operations)
        if (op.deployment === 'hosted') exercised.add(op.operationId);
  }
  if (wantsCoverage)
    results.push(
      coverage(
        index.operations,
        exercised,
        target,
        advertised,
        advertisement.features,
        operationsBehindMissingTokens(scenarios, index, target)
      )
    );
  return {
    deployment: target.deployment,
    results,
    passed: results.filter((r) => r.outcome === 'passed').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    skipped: results.filter((r) => r.outcome === 'skipped').length,
    exercised: [...exercised].sort(),
  };
}

/** Every `{ method, path }` request line in a scenario's steps, however deeply nested (a stream step's requests too). */
function requestLines(node: unknown, out: { method: string; path: string }[] = []) {
  if (Array.isArray(node)) for (const item of node) requestLines(item, out);
  else if (node !== null && typeof node === 'object') {
    const { method, path } = node as { method?: unknown; path?: unknown };
    if (typeof method === 'string' && typeof path === 'string') out.push({ method, path });
    for (const value of Object.values(node)) requestLines(value, out);
  }
  return out;
}

/**
 * The aliases whose token a run may leave out while the scenarios that need them reach routes no other
 * scenario does: the approver, who resolves, and (rev 10) the administrator, who authors policies.
 */
const COVERAGE_ALIASES = ['approver', 'admin'] as const;

/**
 * The operations the scenarios that declare `needs: <alias>` call, for each alias of `COVERAGE_ALIASES` the
 * run has no token for, with the aliases that reach each. Run without the token those scenarios are skipped
 * as `unconfigured`, so a route only they reach is not a coverage failure; the coverage result reports the
 * ones left unexercised as an `unconfigured` skip. With every token the map is empty and coverage is as
 * strict as before.
 */
function operationsBehindMissingTokens(
  scenarios: readonly Scenario[],
  index: SpecIndex,
  target: Target
): ReadonlyMap<string, readonly string[]> {
  const behind = new Map<string, string[]>();
  const mark = (scenario: Scenario, what: string): void => {
    for (const line of requestLines(scenario.steps)) {
      const info = index.match(line.method, line.path.split('?')[0] ?? line.path);
      if (info === undefined) continue;
      const aliases = behind.get(info.operationId) ?? [];
      if (!aliases.includes(what)) aliases.push(what);
      behind.set(info.operationId, aliases);
    }
  };
  for (const alias of COVERAGE_ALIASES) {
    if (target.tokens[alias] !== undefined) continue;
    for (const scenario of scenarios.filter((s) => s.needs?.includes(alias) === true))
      mark(scenario, alias);
  }
  // Rev 11: a route only a fixture-gated scenario reaches (refresh needs a server to enumerate) is unverified
  // without the fixture, as a route behind a missing token is.
  for (const name of COVERAGE_FIXTURES) {
    if (target.fixtures[name] !== undefined) continue;
    for (const scenario of scenarios.filter((s) => s.fixtures?.includes(name) === true))
      mark(scenario, name);
  }
  return behind;
}

/** The fixtures a run may leave out while the scenarios that need them reach routes no other scenario does (rev 11). */
const COVERAGE_FIXTURES = ['connection_server_url', 'oauth_return_to'] as const;

function coverage(
  operations: readonly OperationInfo[],
  exercised: ReadonlySet<string>,
  target: Target,
  advertised: ReadonlySet<Family>,
  features: ReadonlySet<string>,
  behindMissingTokens: ReadonlyMap<string, readonly string[]>
): ScenarioResult {
  const missing = operations
    // The edge protocol is referenced, not defined, by this document.
    .filter((op) => !op.operationId.startsWith('edgeProtocol'))
    // A route of a family the deployment does not advertise is not served, so it is not expected to answer.
    .filter((op) => served(op, advertised))
    // Nor is a route of a feature it does not advertise (policy import and export, rev 10).
    .filter((op) => op.feature === undefined || features.has(op.feature))
    // Paid routes can only be exercised with an entitled token.
    .filter((op) => !(op.entitlement !== undefined && target.tokens.entitled === undefined))
    .filter((op) => !exercised.has(op.operationId))
    .map((op) => ({
      operationId: op.operationId,
      line: `${op.method.toUpperCase()} ${op.path} (${op.operationId})`,
    }));
  // Not exercised, and reached by scenarios that need a token the run was not given (--approver-token,
  // --admin-token): not a failure, but not verified either, so the result is a skip rather than a pass.
  const unverified = missing.filter((m) => behindMissingTokens.has(m.operationId));
  const failed = missing.filter((m) => !behindMissingTokens.has(m.operationId));
  const behind = (name: string): boolean =>
    unverified.some((m) => behindMissingTokens.get(m.operationId)?.includes(name) === true);
  const aliases = COVERAGE_ALIASES.filter(behind);
  const fixtures = COVERAGE_FIXTURES.filter(behind);
  const missingWhat = [
    ...(aliases.length > 0 ? [`no token for ${aliases.join(', ')}`] : []),
    ...(fixtures.length > 0 ? [`no fixture for ${fixtures.join(', ')}`] : []),
  ].join('; ');
  const base = {
    id: COVERAGE_RESULT,
    title: 'Every route the deployment serves was exercised and answered per the document',
    tags: ['both', 'generated'],
  };
  if (failed.length > 0)
    return {
      ...base,
      outcome: 'failed',
      failures: failed.map((m) => `not exercised with a schema-valid success response: ${m.line}`),
    };
  if (unverified.length > 0)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipKind: 'unconfigured',
      skipReason: `${missingWhat}: ${String(unverified.length)} routes not exercised (${unverified.map((m) => m.operationId).join(', ')})`,
    };
  return { ...base, outcome: 'passed', failures: [] };
}

/** A printable summary. */
export function formatReport(report: Report): string {
  const lines = [
    `conformance ${report.deployment}: ${String(report.passed)} passed, ${String(report.failed)} failed, ${String(report.skipped)} skipped`,
  ];
  for (const r of report.results) {
    if (r.outcome === 'failed')
      lines.push(`  FAIL ${r.id}`, ...r.failures.map((f) => `       ${f}`));
    else if (r.outcome === 'skipped' && r.skipKind === 'capability')
      lines.push(`  skipped: capability ${r.id} (${r.skipReason ?? ''})`);
    else if (r.outcome === 'skipped') lines.push(`  skip ${r.id} (${r.skipReason ?? ''})`);
  }
  return lines.join('\n');
}

const FLAG_FOR_ALIAS: Readonly<Record<string, string>> = {
  creator_user: '--creator-user-token',
  approver: '--approver-token',
  approver_surface_token: '--approver-surface-token',
  approver_token_without_resolve_scope: '--approver-token-without-resolve-scope',
  admin: '--admin-token',
  member: '--member-token',
  other_org: '--other-org-token',
  other_service: '--other-service-token',
  entitled: '--entitled-token',
  wrong_audience: '--wrong-audience-token',
  forged: '--forged-token',
  expired: '--expired-token',
  dpop_bound: '--dpop-bound-token',
  no_org: '--no-org-token',
  no_scope: '--no-scope-token',
};

/** The skipped scenarios that did not run because the run was not given what they need. */
export function unconfiguredSkips(report: Report): readonly ScenarioResult[] {
  return report.results.filter((r) => r.outcome === 'skipped' && r.skipKind === 'unconfigured');
}

/** A warning naming each unverified scenario and the flag that would enable it; empty when none. */
export function formatSkipWarning(report: Report): string {
  const skips = unconfiguredSkips(report);
  if (skips.length === 0) return '';
  const lines = [
    `WARNING: ${String(skips.length)} scenario(s) did not run, so the behaviour they check was NOT verified:`,
  ];
  for (const r of skips) {
    const flags = [
      ...(r.skipReason ?? '').matchAll(
        /\b(creator_user|approver_surface_token|approver_token_without_resolve_scope|approver|admin|member|other_org|other_service|entitled|wrong_audience|forged|expired|dpop_bound|no_org|no_scope)\b/g
      ),
    ]
      .map((m) => FLAG_FOR_ALIAS[m[1] ?? ''])
      .filter((f): f is string => f !== undefined);
    const reason = r.skipReason ?? '';
    // The fixture flags of a reason that names fixtures, wherever in the reason (rev 11: the every-route check
    // may name a missing token and a missing fixture together).
    const fixtureFlags = reason.includes('no fixture for')
      ? [
          ...reason
            .slice(reason.indexOf('no fixture for'))
            .matchAll(
              /\b(reserved_tool_ref|system_tool_ref|tool_ref_in_use|on_deny_tool_ref|on_deny_silent_tool_ref|admin_role|connection_server_url|oauth_return_to)\b/g
            ),
        ].map((m) => `--${(m[1] ?? '').replace(/_/g, '-')}`)
      : [];
    const tokenFlags = reason.startsWith('no fixture for') ? [] : flags;
    const all = [...new Set([...tokenFlags, ...fixtureFlags])];
    const hint = reason.includes('clock control')
      ? ' (pass --clock-control)'
      : reason.includes('webhook sink')
        ? ' (pass --mock-control or --webhook-sink)'
        : reason.includes('mock control')
          ? ' (pass --mock-control)'
          : all.length > 0
            ? ` (pass ${all.join(', ')})`
            : '';
    lines.push(`  - ${r.id}: ${r.skipReason ?? ''}${hint}`);
  }
  return lines.join('\n');
}
