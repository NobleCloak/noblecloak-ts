/** Runs the suite against an in-process mock: the `conformance:mock` verification. */
import {
  MOCK_MODULE_ORIGIN,
  RESERVED_TOOL_PREFIX,
  SYSTEM_TOOL_REFS,
  TOOL_REF_IN_USE,
} from '../mock/app.js';
import { startMock } from '../mock/serve.js';
import type { MockOptions } from '../mock/app.js';
import type { Break } from '../mock/breaks.js';
import { loadSpec } from '../spec/load.js';
import type { JsonObject } from '../spec/load.js';
import { PUBLIC_SOURCE } from '../spec/paths.js';
import { runConformance } from './run.js';
import { loadScenarios } from './scenarios.js';
import type { Report, Scenario, Target } from './types.js';

export interface MockRun {
  readonly deployment: 'hosted' | 'edge';
  /** The document the mock serves and the run checks against. Defaults to this package's (`openapi.public.yaml`). */
  readonly spec?: JsonObject;
  /** The scenarios to run. Defaults to this package's (`scenarios/`). */
  readonly scenarios?: readonly Scenario[];
  /** Mock options for a deployment that extends the document (see `MockOptions.extendHandle`). */
  readonly mock?: Pick<MockOptions, 'extendHandle'>;
  /**
   * Fail a response member the document does not declare (`Target.rejectUndeclared`). Defaults to true: the
   * document is the contract.
   */
  readonly rejectUndeclared?: boolean;
  readonly breaks?: readonly Break[];
  /** Serve and advertise only these families (the floor is always served). */
  readonly advertise?: readonly string[];
  /** The batch limits the mock advertises and enforces from the start (and after a control reset). */
  readonly limits?: {
    readonly decisions?: number;
    readonly records?: number;
    readonly resolutions?: number;
  };
  /**
   * What a deployment restricts, as the `nc-mock` flags say it (`--approval-arguments-max-bytes`,
   * `--deliveries`, `--restrict-tool-registration`, `--max-body-bytes`, `--resolutions`; `restrictPolicyTargets` has no flag). Every run is given the
   * administrator's token, as a real run is by `--admin-token`.
   */
  readonly restrictions?: Pick<
    MockOptions,
    | 'approvalArgumentsMaxBytes'
    | 'deliveries'
    | 'restrictToolRegistration'
    | 'maxBodyBytes'
    | 'resolutions'
    | 'approverSurfaceClient'
    | 'connectionRegistration'
    | 'connectionTransports'
    | 'restrictPolicyTargets'
  >;
  /** Serve every echoed continuation with its object members in reverse order (same value, other bytes). */
  readonly reorderContinuation?: boolean;
  /** Members merged into the `data` of every `GET /v1/capabilities` answer, to run as a deployment that says more. */
  readonly capabilities?: Readonly<Record<string, unknown>>;
  /** Run only the scenarios with these ids (see `RunOptions.only`); every scenario when absent. */
  readonly only?: readonly string[];
}

/**
 * Serialises mock start-up. `startMock` asks the OS for a free port, releases it and starts the server on it later,
 * so two starts at once could be handed the same port. Each start waits for the one before it to be listening.
 */
let startQueue: Promise<unknown> = Promise.resolve();
function serialisedStart<T>(start: () => Promise<T>): Promise<T> {
  const next = startQueue.then(start, start);
  startQueue = next.catch(() => undefined);
  return next;
}

/** The fixtures the mock exposes. */
export const MOCK_FIXTURES = {
  proxied_tool: 'mcp:tracker:create_issue',
  allow_tool: 'mcp:tracker:search',
  deny_tool: 'mcp:crm:delete_account',
  default_tool: 'mcp:tracker:list_labels',
  reserved_tool_ref: `${RESERVED_TOOL_PREFIX}conformance`,
  system_tool_ref: SYSTEM_TOOL_REFS[0] ?? 'system:whoami',
  tool_ref_in_use: TOOL_REF_IN_USE,
  // Its matching stored policy (pol_default) is `ask` and states `on_deny: resume`.
  on_deny_tool_ref: 'mcp:tracker:create_issue',
  // Its matching stored policy (pol_silent) is `ask` and states no `on_deny`.
  on_deny_silent_tool_ref: 'mcp:tracker:add_comment',
  // Rev 11: the role the mock's administrator token holds (see POLICY_ADMIN_ROLE in app.ts).
  admin_role: 'policy_admin',
  // Rev 11: every server the mock connects to offers the same two tools (see CANNED_TOOLS in app.ts).
  connection_server_url: 'https://tools.mock.test/mcp',
  // Rev 11: on the browser-module origin the mock admits as a return_to.
  oauth_return_to: `${MOCK_MODULE_ORIGIN}/connections/return`,
} as const;

/** A deployment that restricts everything the capabilities can say it restricts. */
export const RESTRICTED_RUN: MockRun = {
  deployment: 'hosted',
  restrictions: {
    approvalArgumentsMaxBytes: 512,
    deliveries: ['pull', 'held'],
    restrictToolRegistration: true,
    resolutions: ['approved', 'rejected'],
    // Rev 11: as the hosted deployment registers connections, and one transport.
    connectionRegistration: { owner_kinds: ['org'], who: 'administrators' },
    connectionTransports: ['mcp'],
  },
};

/** A deployment that serves approvals and no runs: every family but `runs`. */
export const NO_RUNS_RUN: MockRun = {
  deployment: 'hosted',
  advertise: [
    'approvals',
    'webhooks',
    'origins',
    'policies',
    'agents',
    'principals',
    'connections',
    'records.checkpoints',
    'records.chain',
    'evidence',
  ],
};

/** Starts a mock with `run.breaks` flipped, runs the suite against it and stops it. */
export async function runAgainstMock(run: MockRun): Promise<Report> {
  const spec = run.spec ?? loadSpec(PUBLIC_SOURCE());
  const mock = await serialisedStart(() =>
    startMock({
      deployment: run.deployment,
      spec,
      ...(run.mock?.extendHandle === undefined ? {} : { extendHandle: run.mock.extendHandle }),
      breaks: new Set(run.breaks ?? []),
      ...(run.advertise === undefined ? {} : { advertise: run.advertise }),
      ...(run.limits === undefined ? {} : { limits: run.limits }),
      ...(run.restrictions ?? {}),
      ...(run.reorderContinuation === true ? { reorderContinuation: true } : {}),
      control: true,
    })
  );
  try {
    const tokens = await mock.tokens();
    const target: Target = {
      baseUrl: mock.baseUrl,
      deployment: run.deployment,
      ...(run.rejectUndeclared === false ? {} : { rejectUndeclared: true }),
      tokens: {
        creator: tokens.creator,
        creator_user: tokens.creator_user,
        approver: tokens.approver,
        other_org: tokens.other_org,
        other_service: tokens.other_service,
        entitled: tokens.entitled,
        wrong_audience: tokens.wrong_audience,
        forged: tokens.forged,
        expired: tokens.expired,
        dpop_bound: tokens.dpop_bound,
        no_org: tokens.no_org,
        no_scope: tokens.no_scope,
        member: tokens.member,
        admin: tokens.admin,
        approver_surface_token: tokens.approver_surface_token,
        approver_token_without_resolve_scope: tokens.approver_token_without_resolve_scope,
      },
      fixtures: MOCK_FIXTURES,
      clockControl: `${mock.baseUrl}/__mock/advance`,
      mockControl: `${mock.baseUrl}/__mock/control`,
      ...(run.capabilities === undefined ? {} : { fetch: overlayCapabilities(run.capabilities) }),
    };
    return await runConformance({
      target,
      spec,
      scenarios: run.scenarios ?? loadScenarios(),
      ...(run.only === undefined ? {} : { only: run.only }),
    });
  } finally {
    await mock.stop();
  }
}

/** A fetch that merges `overlay` into the `data` of a capabilities answer and passes everything else through. */
function overlayCapabilities(overlay: Readonly<Record<string, unknown>>): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (response.status !== 200 || new URL(url).pathname !== '/v1/capabilities') return response;
    const body = (await response.json()) as { data: Record<string, unknown> };
    return new Response(JSON.stringify({ ...body, data: { ...body.data, ...overlay } }), {
      status: 200,
      headers: response.headers,
    });
  };
}
