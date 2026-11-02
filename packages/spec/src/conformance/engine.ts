/**
 * Runs one scenario against a target: sends each request, checks the status and body predicates,
 * validates EVERY response against the document, and keeps the variables later steps interpolate.
 */
import { jcs, verifyResumption, ResumptionError } from '@noblecloak/client';
import type { JsonValue, Jwks } from '@noblecloak/client';

import { base64Url } from '../mock/jws.js';
import type { Family } from '../spec/families.js';
import {
  assertDpop,
  assertFeatures,
  assertLimits,
  assertRequires,
  assertRestrictions,
  excludedFamilies,
  requiredFamilies,
  requiredFeatures,
} from './scenarios.js';
import { describeErrors } from '../spec/validate.js';
import type { SpecIndex } from '../spec/validate.js';
import type {
  AdvertisedLimits,
  AdvertisedRestrictions,
  Alias,
  AuthzenStep,
  ClockStep,
  ControlStep,
  DpopMode,
  HeaderExpectation,
  HttpStep,
  Predicate,
  Scenario,
  ScenarioResult,
  Step,
  StreamStep,
  Target,
  VerifyResumptionStep,
  VerifySpec,
  VerifyStep,
} from './types.js';
import { verifyDeliverySignature } from './verify-delivery.js';

type Vars = Record<string, unknown>;

/** Where an HTTP step leaves the status it answered, for a `gate`; never a scenario variable's name. */
const STATUS_VAR = '\u0000status';
/** The problem `type`, `detail` and (rev 13) `member` an HTTP step answered, for a gate's `otherwise`. */
const PROBLEM_VAR = '\u0000problem';
const DETAIL_VAR = '\u0000detail';
const MEMBER_VAR = '\u0000member';

/** The part of the AuthZEN client library the runner uses. */
interface AuthZenClientLike {
  discover(): Promise<{ policy_decision_point: string; access_evaluation_endpoint?: string }>;
  evaluate(request: unknown): Promise<unknown>;
}

/** The public callback base scenarios use when the run was given no webhook sink. */
export const DEFAULT_CALLBACK_BASE_URL = 'https://hooks.example.com';
/** How often a `deliveries` step re-reads the sink while its expectations do not yet hold. */
const SINK_POLL_MS = 2000;
const SINK_READ_TIMEOUT_MS = 10_000;
/** How long the deciding settle read keeps retrying a transient fault, from the end of the settle sleep. */
const SINK_SETTLE_RETRY_MS = 20_000;

const TEXT = new TextDecoder();

/** The value at a dotted path, or undefined. `$` is the whole value. */
export function getPath(value: unknown, path: string): unknown {
  if (path === '$' || path === '') return value;
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Replaces `${name}` in strings: a whole-string reference keeps its type, an embedded one is
 * stringified. A name nothing bound throws, so a request is never sent with the text "undefined" in it.
 */
export function interpolate(value: unknown, vars: Vars): unknown {
  if (typeof value === 'string') {
    const resolve = (name: string): unknown => {
      const found = getPath(vars, name);
      if (found !== undefined) return found;
      // `${limit+1}`: a bound number plus a literal, so a batch can be built one over a limit.
      const sum = /^(.+)\+(\d+)$/.exec(name);
      const base = sum?.[1] === undefined ? undefined : getPath(vars, sum[1]);
      if (sum?.[2] !== undefined && typeof base === 'number') return base + Number(sum[2]);
      throw new Error(`\${${name}} is not bound: no earlier step saved it`);
    };
    const whole = /^\$\{([^}]+)\}$/.exec(value);
    if (whole?.[1] !== undefined) return resolve(whole[1]);
    return value.replace(/\$\{([^}]+)\}/g, (_m, name: string) => String(resolve(name)));
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, vars));
  if (typeof value === 'object' && value !== null && '$repeat' in value) {
    // `{ $repeat: n, item: x }` is a list of n copies of x: a body too long to write out.
    const { $repeat: rawCount, item } = value as { $repeat: unknown; item?: unknown };
    const count = interpolate(rawCount, vars);
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || item === undefined)
      throw new Error('$repeat takes a count and an item');
    return Array.from({ length: count }, () => interpolate(item, vars));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  }
  return value;
}

const isHttp = (step: Step): step is HttpStep => 'request' in step;
const isClock = (step: Step): step is ClockStep => 'advance_seconds' in step;
const isVerify = (step: Step): step is VerifyStep | VerifyResumptionStep =>
  'verify_resumption' in step || 'verify' in step;
const isAuthzen = (step: Step): step is AuthzenStep => 'authzen' in step;
const isStream = (step: Step): step is StreamStep => 'stream_events' in step;
const isControl = (step: Step): step is ControlStep => 'control' in step;
/** A control step that only reads a webhook's deliveries (no limits, failure, consent or disable to switch). */
const isDeliveriesOnly = (step: ControlStep): boolean => {
  const keys = Object.keys(step.control);
  return keys.length === 1 && keys[0] === 'deliveries';
};
/** Whether `step` is answered by the run's webhook sink rather than by mock control. */
const readsSink = (step: Step, target: Target): boolean =>
  isControl(step) && target.webhookSink !== undefined && isDeliveriesOnly(step);
/** Whether a step (or a request sent while a stream is open) authenticates as the `admin` alias. */
const usesAdmin = (step: Step): boolean =>
  isStream(step)
    ? step.stream_events.as === 'admin' || step.stream_events.during.some(usesAdmin)
    : (isHttp(step) || isAuthzen(step)) && (isHttp(step) ? step.as : step.authzen.as) === 'admin';

/**
 * Whether two values are the same JSON value, by their RFC 8785 canonical forms (the `jcs` the argument
 * digest uses): member order and number spelling do not matter. A value that is not JSON (absent, or
 * not representable) is never the same as anything, so a missing member cannot match.
 */
export function sameJson(actual: unknown, expected: unknown): boolean {
  if (actual === undefined || expected === undefined) return false;
  try {
    return jcs(actual as JsonValue) === jcs(expected as JsonValue);
  } catch {
    return false;
  }
}

export function check(
  predicate: Predicate,
  body: unknown,
  failures: string[],
  where: string
): void {
  const actual = getPath(body, predicate.path);
  const fail = (what: string): void => {
    failures.push(`${where}: ${predicate.path} ${what} (got ${JSON.stringify(actual)})`);
  };
  if (predicate.exists !== undefined && (actual !== undefined) !== predicate.exists) {
    fail(predicate.exists ? 'should exist' : 'should be absent');
  }
  if ('equals' in predicate && JSON.stringify(actual) !== JSON.stringify(predicate.equals))
    fail(`should equal ${JSON.stringify(predicate.equals)}`);
  if ('equals_canonical' in predicate && !sameJson(actual, predicate.equals_canonical))
    fail(`should be the same JSON value as ${JSON.stringify(predicate.equals_canonical)}`);
  if ('not_equals' in predicate && JSON.stringify(actual) === JSON.stringify(predicate.not_equals))
    fail(`should not equal ${JSON.stringify(predicate.not_equals)}`);
  if (
    predicate.matches !== undefined &&
    !(typeof actual === 'string' && new RegExp(predicate.matches).test(actual))
  )
    fail(`should match /${predicate.matches}/`);
  if (
    predicate.in !== undefined &&
    !predicate.in.some((option) => JSON.stringify(option) === JSON.stringify(actual))
  )
    fail(`should be one of ${JSON.stringify(predicate.in)}`);
  if (
    predicate.length !== undefined &&
    !(Array.isArray(actual) && actual.length === predicate.length)
  )
    fail(`should have length ${String(predicate.length)}`);
  if (
    'contains' in predicate &&
    !(
      Array.isArray(actual) &&
      actual.some((item) => JSON.stringify(item) === JSON.stringify(predicate.contains))
    )
  )
    fail(`should contain ${JSON.stringify(predicate.contains)}`);
  if (predicate.differs_from !== undefined) {
    const other = getPath(body, predicate.differs_from);
    if (actual !== undefined && JSON.stringify(actual) === JSON.stringify(other))
      fail(`should not repeat ${predicate.differs_from}`);
  }
  if ('lacks' in predicate && Array.isArray(actual)) {
    if (actual.some((item) => JSON.stringify(item) === JSON.stringify(predicate.lacks)))
      fail(`should not contain ${JSON.stringify(predicate.lacks)}`);
  } else if ('lacks' in predicate) {
    fail('should be an array without that element');
  }
  if (predicate.lacks_key !== undefined) {
    const wanted = predicate.lacks_key;
    const holds = (value: unknown): boolean =>
      Array.isArray(value)
        ? value.some(holds)
        : typeof value === 'object' && value !== null
          ? Object.entries(value).some(([key, inner]) => key === wanted || holds(inner))
          : false;
    if (holds(actual)) fail(`should hold no member named ${wanted} at any depth`);
  }
  if (predicate.keys_exactly !== undefined) {
    const wanted = [...predicate.keys_exactly].sort();
    const present =
      typeof actual === 'object' && actual !== null && !Array.isArray(actual)
        ? Object.keys(actual).sort()
        : undefined;
    if (present === undefined || JSON.stringify(present) !== JSON.stringify(wanted))
      fail(
        `should be an object with exactly the members ${JSON.stringify(wanted)}, found ${
          present === undefined ? 'a value that is not an object' : JSON.stringify(present)
        }`
      );
  }
  // A key may be dotted (`data.approval_id`) to reach into a nested object.
  const member = (item: unknown, key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>(
        (value, part) =>
          typeof value === 'object' && value !== null
            ? (value as Record<string, unknown>)[part]
            : undefined,
        item
      );
  if (predicate.contains_where !== undefined) {
    const { key, equals } = predicate.contains_where;
    if (!(
      Array.isArray(actual) &&
      actual.some((item) => JSON.stringify(member(item, key)) === JSON.stringify(equals))
    ))
      fail(`should have an element whose ${key} is ${JSON.stringify(equals)}`);
  }
  if (predicate.contains_members !== undefined) {
    const wanted = Object.entries(predicate.contains_members);
    if (!(
      Array.isArray(actual) &&
      actual.some((item) => wanted.every(([key, value]) => sameJson(member(item, key), value)))
    ))
      fail(`should have an element with the members ${JSON.stringify(predicate.contains_members)}`);
  }
  if (predicate.lacks_members !== undefined) {
    const unwanted = Object.entries(predicate.lacks_members);
    if (
      !Array.isArray(actual) ||
      actual.some((item) => unwanted.every(([key, value]) => sameJson(member(item, key), value)))
    )
      fail(
        `should be an array with no element with the members ${JSON.stringify(predicate.lacks_members)}`
      );
  }
  if (predicate.lacks_where !== undefined) {
    const { key, equals } = predicate.lacks_where;
    if (
      !Array.isArray(actual) ||
      actual.some((item) => JSON.stringify(member(item, key)) === JSON.stringify(equals))
    )
      fail(`should be an array with no element whose ${key} is ${JSON.stringify(equals)}`);
  }
  if (predicate.lacks_where_matches !== undefined) {
    const { key, matches, ignore_case } = predicate.lacks_where_matches;
    const pattern = new RegExp(matches, ignore_case === true ? 'i' : '');
    if (
      !Array.isArray(actual) ||
      actual.some((item) => {
        const value = member(item, key);
        return typeof value === 'string' && pattern.test(value);
      })
    )
      fail(
        `should be an array with no element whose ${key} matches /${matches}/${ignore_case === true ? 'i' : ''}`
      );
  }
}

export interface EngineDeps {
  readonly index: SpecIndex;
  /** The route families the deployment advertised on `GET /v1/capabilities`. */
  readonly advertised: ReadonlySet<Family>;
  /**
   * Every name the deployment listed in `Capabilities.features`, families and features alike, as it sent
   * them; none when the deps omit it. A scenario's `features` are looked up here.
   */
  readonly features?: ReadonlySet<string>;
  /** The DPoP mode the deployment advertised; `off` when the member is absent or the deps omit it. */
  readonly dpop?: DpopMode;
  /** The batch limits the deployment advertised; none when the member is absent or the deps omit it. */
  readonly limits?: AdvertisedLimits;
  /** What the deployment advertised beyond its families; the rev 5 behaviour when the deps omit it. */
  readonly restrictions?: AdvertisedRestrictions;
  readonly target: Target;
  /** Time source for the webhook-sink poll; real time when omitted. Tests inject a virtual one. */
  readonly clock?: {
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  /** Operation ids a successful, schema-valid response was seen for. */
  readonly exercised: Set<string>;
  readonly corpus: readonly { id: string; arguments: unknown; arg_digest: string }[];
}

/** Runs `scenario`. Never throws: every failure is a line in the result. */
export async function runScenario(scenario: Scenario, deps: EngineDeps): Promise<ScenarioResult> {
  const { target } = deps;
  const base = { id: scenario.id, title: scenario.title, tags: scenario.tags };
  // A name that is not a family (a typo) must fail here, not be skipped as a capability the deployment
  // lacks: callers of runConformance can hand in scenarios the loader never saw.
  try {
    assertRequires(scenario, 'scenario');
    assertFeatures(scenario, 'scenario');
    assertDpop(scenario, 'scenario');
    assertLimits(scenario, 'scenario');
    assertRestrictions(scenario, 'scenario');
  } catch (error) {
    return {
      ...base,
      outcome: 'failed',
      failures: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (scenario.only !== undefined && scenario.only !== target.deployment) {
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `only runs against ${scenario.only}`,
      skipKind: 'inapplicable',
    };
  }
  const dpop = deps.dpop ?? 'off';
  // A deployment's own advertisement cannot excuse the negatives that show it refuses what it cannot
  // verify: nothing here proves a deployment that says `optional` or `required` checks proofs, so those
  // scenarios are an unverified skip (they count against the exit code), not a capability skip.
  if (scenario.dpop === 'off' && dpop !== 'off')
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment advertises DPoP mode ${dpop}; that it really verifies proofs is NOT verified here`,
      skipKind: 'unconfigured',
    };
  if (scenario.dpop !== undefined && scenario.dpop !== dpop)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment's DPoP mode is ${dpop}, not ${scenario.dpop}`,
      skipKind: 'capability',
    };
  const advertisedExcluded = excludedFamilies(scenario).filter((family) =>
    deps.advertised.has(family)
  );
  if (advertisedExcluded.length > 0)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment advertises ${advertisedExcluded.join(', ')}`,
      skipKind: 'capability',
    };
  const unadvertised = requiredFamilies(scenario).filter((family) => !deps.advertised.has(family));
  if (unadvertised.length > 0)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment does not advertise ${unadvertised.join(', ')}`,
      skipKind: 'capability',
    };
  const unadvertisedFeatures = requiredFeatures(scenario).filter(
    (feature) => deps.features?.has(feature) !== true
  );
  if (unadvertisedFeatures.length > 0)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment does not advertise ${unadvertisedFeatures.join(', ')}`,
      skipKind: 'capability',
    };
  const restrictions = deps.restrictions;
  // Before the token and fixture checks: a deployment without the rule is a capability skip even when no
  // approver_surface_token was given, so a run against a rev 6 server does not exit 1 on it.
  const surfaceRule = restrictions?.self_approval_from_approver_surface ?? false;
  if (
    scenario.self_approval_from_approver_surface !== undefined &&
    scenario.self_approval_from_approver_surface !== surfaceRule
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment's self_approval_from_approver_surface is ${String(surfaceRule)}, not ${String(scenario.self_approval_from_approver_surface)}`,
      skipKind: 'capability',
    };
  // Also before the token check, for the same reason: a deployment that lacks the member is a capability skip
  // even when the run was not given the token the scenario needs.
  const unadvertisedMembers = (scenario.advertises ?? []).filter(
    (member) => restrictions?.[member] === undefined
  );
  if (unadvertisedMembers.length > 0)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment does not advertise ${unadvertisedMembers.join(', ')}`,
      skipKind: 'capability',
    };
  // Rev 11: who registers a connection and the transports served, from capabilities, before the token check.
  const connectionRegistration = restrictions?.connection_registration;
  const unservedOwner = scenario.unserved_connection_owner_kind;
  if (
    unservedOwner !== undefined &&
    (connectionRegistration === undefined ||
      connectionRegistration.owner_kinds.includes(unservedOwner))
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment registers ${unservedOwner}-owned connections`,
      skipKind: 'capability',
    };
  const servedOwner = scenario.serves_connection_owner_kind;
  if (
    servedOwner !== undefined &&
    connectionRegistration !== undefined &&
    !connectionRegistration.owner_kinds.includes(servedOwner)
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment does not register ${servedOwner}-owned connections`,
      skipKind: 'capability',
    };
  const who = connectionRegistration?.who ?? 'any';
  if (
    scenario.connection_registration_who !== undefined &&
    scenario.connection_registration_who !== who
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment's connection registration is for ${who}, not ${scenario.connection_registration_who}`,
      skipKind: 'capability',
    };
  const unservedTransport = scenario.unserved_connection_transport;
  if (
    unservedTransport !== undefined &&
    (restrictions?.connection_transports === undefined ||
      restrictions.connection_transports.includes(unservedTransport))
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment serves the ${unservedTransport} connection transport`,
      skipKind: 'capability',
    };
  const servedTransport = scenario.serves_connection_transport;
  if (
    servedTransport !== undefined &&
    restrictions?.connection_transports !== undefined &&
    !restrictions.connection_transports.includes(servedTransport)
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment does not serve the ${servedTransport} connection transport`,
      skipKind: 'capability',
    };
  const servedSubjectTypes =
    scenario.serves_policy_subject_type === undefined
      ? []
      : typeof scenario.serves_policy_subject_type === 'string'
        ? [scenario.serves_policy_subject_type]
        : scenario.serves_policy_subject_type;
  const policyForms = restrictions?.policy_forms;
  if (servedSubjectTypes.length > 0 && policyForms !== undefined) {
    // Advertised without a tool_invocation entry: no tool_invocation form is promised at all.
    const advertisedSubjectTypes = policyForms.tool_invocation?.subject_types ?? [];
    const missing = servedSubjectTypes.filter((t) => !advertisedSubjectTypes.includes(t));
    if (missing.length > 0)
      return {
        ...base,
        outcome: 'skipped',
        failures: [],
        skipReason: `the deployment does not advertise ${missing.join(', ')} subjects in policy_forms`,
        skipKind: 'capability',
      };
  }
  if (scenario.serves_on_deny === true && target.noOnDeny === true)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: 'the deployment implements no on_deny on its policies (--no-on-deny)',
      skipKind: 'capability',
    };
  // `admin` falls back to the creator token for the steps that merely register tools, so a scenario that
  // is about an administrator user's own view names it in `needs`, and runs only when a token was given.
  const missing = (scenario.needs ?? []).filter((alias) =>
    alias === 'admin' ? target.tokens.admin === undefined : tokenFor(target, alias) === undefined
  );
  if (missing.length > 0)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `no token for ${missing.map((alias) => (alias === 'admin' ? 'admin (--admin-token)' : alias)).join(', ')}`,
      skipKind: 'unconfigured',
    };
  const missingFixtures = (scenario.fixtures ?? []).filter(
    (name) => target.fixtures[name] === undefined
  );
  if (missingFixtures.length > 0)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `no fixture for ${missingFixtures.join(', ')}`,
      skipKind: 'unconfigured',
    };
  const limitNames = scenario.limits ?? [];
  const unadvertisedLimits = limitNames.filter((name) => deps.limits?.[name] === undefined);
  if (unadvertisedLimits.length > 0)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment does not advertise ${unadvertisedLimits.join(', ')}`,
      skipKind: 'capability',
    };
  const unbounded = limitNames.filter((name) => deps.limits?.[name] === 100);
  if (unbounded.length > 0)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `${unbounded.join(', ')} is 100, the most any deployment accepts: nothing above it is batch_too_large`,
      skipKind: 'capability',
    };
  const reduced = (scenario.unreduced_limits ?? []).filter((name) => {
    const advertised = deps.limits?.[name];
    return advertised !== undefined && advertised < 100;
  });
  if (reduced.length > 0)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment advertises ${reduced.map((name) => `${name} ${String(deps.limits?.[name])}`).join(', ')}, below the 100 this scenario sends`,
      skipKind: 'capability',
    };
  const argumentsBound = restrictions?.approval_arguments_max_bytes;
  if (
    scenario.arguments_bytes !== undefined &&
    argumentsBound !== undefined &&
    argumentsBound < scenario.arguments_bytes
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment advertises approval_arguments_max_bytes ${String(argumentsBound)}, below the ${String(scenario.arguments_bytes)} bytes of arguments this scenario sends`,
      skipKind: 'capability',
    };
  const registration = restrictions?.tool_registration ?? 'any';
  if (scenario.tool_registration !== undefined && scenario.tool_registration !== registration)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment's tool registration is ${registration}, not ${scenario.tool_registration}`,
      skipKind: 'capability',
    };
  if (
    scenario.unserved_delivery !== undefined &&
    (restrictions?.continuation_deliveries === undefined ||
      restrictions.continuation_deliveries.includes(scenario.unserved_delivery))
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment serves the ${scenario.unserved_delivery} delivery`,
      skipKind: 'capability',
    };
  if (
    scenario.serves_delivery !== undefined &&
    restrictions?.continuation_deliveries !== undefined &&
    !restrictions.continuation_deliveries.includes(scenario.serves_delivery)
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment does not serve the ${scenario.serves_delivery} delivery`,
      skipKind: 'capability',
    };
  if (
    scenario.serves_resolution !== undefined &&
    restrictions !== undefined &&
    restrictions.resolutions.length > 0 &&
    !restrictions.resolutions.includes(scenario.serves_resolution)
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment cannot produce the ${scenario.serves_resolution} resolution`,
      skipKind: 'capability',
    };
  if (
    scenario.unserved_resolution !== undefined &&
    (restrictions === undefined ||
      restrictions.resolutions.length === 0 ||
      restrictions.resolutions.includes(scenario.unserved_resolution))
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: `the deployment can produce the ${scenario.unserved_resolution} resolution`,
      skipKind: 'capability',
    };
  // A deployment that lets only administrators register tools is exercised by a scenario that says
  // `as: admin` with an administrator's token; with none the alias would be the creator, which that
  // deployment may refuse, so the scenario did not verify what it checks.
  if (
    registration === 'administrators' &&
    target.tokens.admin === undefined &&
    scenario.steps.some(usesAdmin)
  )
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason:
        'the deployment lets only administrators register tools and no token for admin was given',
      skipKind: 'unconfigured',
    };
  // A control step needs mock control, except a `deliveries`-only one when the run has a webhook sink to read.
  const mockControlSteps = scenario.steps.filter(
    (step): step is ControlStep => isControl(step) && !readsSink(step, target)
  );
  const usesControl = mockControlSteps.length > 0;
  if (usesControl && target.mockControl === undefined)
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: mockControlSteps.every(isDeliveriesOnly)
        ? 'needs mock control or a webhook sink'
        : 'needs a server that offers mock control',
      skipKind: 'unconfigured',
    };
  if (scenario.tags.includes('needs-mock-control') && target.clockControl === undefined) {
    return {
      ...base,
      outcome: 'skipped',
      failures: [],
      skipReason: 'needs a server that offers clock control',
      skipKind: 'unconfigured',
    };
  }
  const failures: string[] = [];
  // A scenario that checks nothing must not pass: an empty step list, or a corpus loop over no vectors.
  if (scenario.steps.length === 0)
    return { ...base, outcome: 'failed', failures: ['the scenario has no steps'] };
  if (scenario.foreach === 'corpus' && deps.corpus.length === 0)
    return { ...base, outcome: 'failed', failures: ['foreach: corpus, but the corpus is empty'] };
  const items = scenario.foreach === 'corpus' ? deps.corpus : [undefined];
  /** The reason a step's `gate` gave for not running the rest, when one did. */
  let gated: string | undefined;
  for (const item of items) {
    const vars: Vars = {
      uniq: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      base_url: target.baseUrl,
      callback_base_url: target.webhookSink?.baseUrl ?? DEFAULT_CALLBACK_BASE_URL,
      ...target.fixtures,
      ...Object.fromEntries(limitNames.map((name) => [name, deps.limits?.[name]])),
      ...(restrictions?.approval_arguments_max_bytes === undefined
        ? {}
        : { approval_arguments_max_bytes: restrictions.approval_arguments_max_bytes }),
      ...(item === undefined ? {} : { item }),
    };
    const label = item === undefined ? '' : `[${item.id}] `;
    for (const [i, step] of scenario.steps.entries()) {
      const before = failures.length;
      try {
        await runStep(step, vars, deps, failures, `${label}step ${String(i + 1)}`);
      } catch (error) {
        failures.push(
          `${label}step ${String(i + 1)}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (failures.length > before) break;
      if (isHttp(step) && step.gate !== undefined && vars[STATUS_VAR] !== step.gate.status) {
        // Only the one named refusal skips; any other answer is a failure, never read as the gate's.
        const otherwise = step.gate.otherwise;
        const where = `${label}step ${String(i + 1)}`;
        const problem = vars[PROBLEM_VAR];
        const detail = vars[DETAIL_VAR];
        if (vars[STATUS_VAR] !== otherwise.status)
          failures.push(
            `${where}: answered ${String(vars[STATUS_VAR])}, neither the gate's ${String(step.gate.status)} nor ${String(otherwise.status)}`
          );
        else if (typeof problem !== 'string' || !problem.endsWith(`/${otherwise.problem}`))
          failures.push(
            `${where}: a ${String(otherwise.status)} that skips is problem ${otherwise.problem}, got ${JSON.stringify(problem)}`
          );
        else if (
          // Absent `member` falls back to `detail`; one that is present must be a non-empty string.
          vars[MEMBER_VAR] !== undefined &&
          (typeof vars[MEMBER_VAR] !== 'string' || vars[MEMBER_VAR] === '')
        )
          failures.push(
            `${where}: the ${otherwise.problem} member should be a non-empty string (got ${JSON.stringify(vars[MEMBER_VAR])})`
          );
        else if (
          otherwise.member !== undefined &&
          typeof vars[MEMBER_VAR] === 'string' &&
          vars[MEMBER_VAR] !== otherwise.member
        )
          failures.push(
            `${where}: the ${otherwise.problem} member should be ${JSON.stringify(otherwise.member)} (got ${JSON.stringify(vars[MEMBER_VAR])})`
          );
        else if (
          // A rev 13 deployment names the member in `member`. One that sends none (rev 12) is read by `detail`.
          (otherwise.member === undefined || typeof vars[MEMBER_VAR] !== 'string') &&
          (otherwise.detail_matches !== undefined || otherwise.member !== undefined) &&
          (otherwise.detail_matches === undefined ||
            typeof detail !== 'string' ||
            !new RegExp(otherwise.detail_matches).test(detail))
        )
          failures.push(
            otherwise.detail_matches === undefined
              ? `${where}: the ${otherwise.problem} should carry member ${JSON.stringify(otherwise.member)} (got none)`
              : `${where}: the ${otherwise.problem} detail should match /${otherwise.detail_matches}/ (got ${JSON.stringify(detail)})`
          );
        else gated = step.gate.reason;
        break;
      }
    }
    // Cleanup always runs, after a failed or gated step too. Its failures are added after the scenario's own.
    for (const [i, step] of (scenario.cleanup ?? []).entries()) {
      try {
        await runStep(step, vars, deps, failures, `${label}cleanup ${String(i + 1)}`);
      } catch (error) {
        failures.push(
          `${label}cleanup ${String(i + 1)}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (gated !== undefined) break;
  }
  // What a mock-control step switched does not outlive the scenario, whether or not it passed.
  if (usesControl) {
    try {
      await sendControl({ reset: true }, deps);
    } catch (error) {
      failures.push(
        `resetting the mock control failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (gated !== undefined && failures.length === 0)
    return { ...base, outcome: 'skipped', failures: [], skipReason: gated, skipKind: 'capability' };
  return { ...base, outcome: failures.length === 0 ? 'passed' : 'failed', failures };
}

async function runStep(
  step: Step,
  vars: Vars,
  deps: EngineDeps,
  failures: string[],
  where: string
): Promise<void> {
  if (isHttp(step)) return runHttp(step, vars, deps, failures, where);
  if (isClock(step)) return advanceClock(step, deps, failures, where);
  if (isVerify(step)) return runVerify(step, vars, failures, where);
  if (isAuthzen(step)) return runAuthzen(step, vars, deps, failures, where);
  if (isStream(step)) return runStream(step, vars, deps, failures, where);
  if (isControl(step)) return runControl(step, vars, deps, failures, where);
  failures.push(`${where}: unknown step`);
}

/**
 * The token a step authenticates with for `alias`. A step with no `as` is the `creator`. `admin` falls back
 * to the `creator` token when the run was given no `--admin-token`, so a run that does not know about
 * administrators behaves as before the alias existed.
 */
export function tokenFor(target: Target, alias: Alias | undefined): string | undefined {
  const who = alias ?? 'creator';
  if (who === 'admin') return target.tokens.admin ?? target.tokens.creator;
  return target.tokens[who];
}

function headersFor(
  alias: Alias | undefined,
  target: Target,
  extra: Readonly<Record<string, string>> | undefined,
  scheme: 'Bearer' | 'DPoP' = 'Bearer'
): Headers {
  const headers = new Headers(extra);
  const who = alias ?? 'creator';
  if (who !== 'none') {
    const token = tokenFor(target, who);
    if (token === undefined) throw new Error(`no token for ${who}`);
    headers.set('authorization', `${scheme} ${token}`);
  }
  return headers;
}

async function runHttp(
  step: HttpStep,
  vars: Vars,
  deps: EngineDeps,
  failures: string[],
  where: string,
  page = 1
): Promise<void> {
  const { target, index } = deps;
  const failuresBefore = failures.length;
  const request = interpolate(step.request, vars) as HttpStep['request'];
  const headers = headersFor(step.as, target, request.headers, step.scheme);
  const hasBody = request.body !== undefined;
  const contentType = request.content_type ?? 'application/json';
  if (hasBody) headers.set('content-type', contentType);
  const [pathOnly = request.path] = request.path.split('?');
  const doFetch = target.fetch ?? fetch;
  const response = await doFetch(`${target.baseUrl}${request.path}`, {
    method: request.method,
    headers,
    redirect: 'manual',
    ...(hasBody
      ? { body: typeof request.body === 'string' ? request.body : JSON.stringify(request.body) }
      : {}),
  });
  vars[STATUS_VAR] = response.status;
  const statuses = Array.isArray(step.expect.status) ? step.expect.status : [step.expect.status];
  const label = `${where} ${request.method} ${request.path}`;
  const type = response.headers.get('content-type') ?? '';
  const stream = step.expect.stream === true || type.startsWith('text/event-stream');
  let body: unknown;
  if (stream) {
    await response.body?.cancel();
  } else {
    const text = await response.text();
    if (text !== '') {
      // Only a JSON media type carries JSON: a text body that happens to parse stays text. A body that
      // claims JSON and does not parse is a failure of its own, not plain text.
      if (type.includes('json')) {
        try {
          body = JSON.parse(text);
        } catch (error) {
          failures.push(
            `${label}: body is not valid JSON (${error instanceof Error ? error.message : String(error)}) although the content type is ${type}`
          );
          return;
        }
      } else {
        body = text;
      }
    }
  }
  if (!statuses.includes(response.status)) {
    failures.push(
      `${label}: expected status ${statuses.join(' or ')}, got ${String(response.status)} ${typeof body === 'object' ? JSON.stringify(body).slice(0, 300) : ''}`
    );
    return;
  }
  const mediaType = type.split(';')[0]?.trim() ?? '';
  const info = index.match(request.method, pathOnly);
  if (info === undefined) {
    if (step.expect.undocumented !== true)
      failures.push(`${label}: the route is not in the document`);
  } else if (!stream && response.status !== 204) {
    const { documented, validate } = index.response(info, response.status, mediaType);
    if (!documented)
      failures.push(
        `${label}: status ${String(response.status)} is not documented for ${info.operationId}`
      );
    else if (validate === undefined)
      failures.push(
        `${label}: ${info.operationId} documents no ${mediaType} body for ${String(response.status)}`
      );
    else if (!validate(body))
      failures.push(
        `${label}: the ${String(response.status)} body does not match the document: ${describeErrors(validate)}`
      );
    else if (response.status < 300) deps.exercised.add(info.operationId);
  } else if (response.status < 300) deps.exercised.add(info.operationId);

  if (step.expect.problem !== undefined) {
    const problemType = (body as { type?: unknown } | undefined)?.type;
    if (!type.startsWith('application/problem+json'))
      failures.push(`${label}: expected application/problem+json, got ${type}`);
    if (typeof problemType !== 'string' || !problemType.endsWith(`/${step.expect.problem}`)) {
      failures.push(
        `${label}: expected problem ${step.expect.problem}, got ${JSON.stringify(problemType)}`
      );
    }
  }
  for (const expected of interpolate(
    step.expect.headers ?? [],
    vars
  ) as readonly HeaderExpectation[]) {
    const value = response.headers.get(expected.name);
    if ((expected.exists ?? true) !== (value !== null))
      failures.push(
        `${label}: header ${expected.name} should ${expected.exists === false ? 'be absent' : 'be present'} (got ${JSON.stringify(value)})`
      );
    else if (
      expected.matches !== undefined &&
      !(value !== null && new RegExp(expected.matches).test(value))
    )
      failures.push(
        `${label}: header ${expected.name} should match /${expected.matches}/ (got ${JSON.stringify(value)})`
      );
  }
  for (const predicate of step.expect.body ?? [])
    check(interpolate(predicate, vars) as Predicate, body, failures, label);
  const answered: unknown = body;
  const member = (name: 'type' | 'detail' | 'member'): unknown =>
    typeof answered === 'object' && answered !== null
      ? (answered as Record<string, unknown>)[name]
      : undefined;
  vars[PROBLEM_VAR] = member('type');
  vars[DETAIL_VAR] = member('detail');
  vars[MEMBER_VAR] = member('member');
  for (const [name, path] of Object.entries(step.save ?? {})) vars[name] = getPath(body, path);
  // Rev 13: a listing is checked to its last page.
  const next = getPath(body, 'meta.next');
  if (
    step.expect.follow_pages === true &&
    failures.length === failuresBefore &&
    next !== null &&
    next !== undefined
  ) {
    if (typeof next !== 'string' || next === '')
      failures.push(`${label}: meta.next should be a cursor or null (got ${JSON.stringify(next)})`);
    else if (page >= 50)
      failures.push(`${label}: more than 50 pages; the listing was not read to its end`);
    else {
      const url = new URL(request.path, 'http://x');
      url.searchParams.set('cursor', next);
      await runHttp(
        { ...step, request: { ...request, path: `${url.pathname}${url.search}` } },
        vars,
        deps,
        failures,
        where,
        page + 1
      );
    }
  }
}

/** Sends a body to the mock's control endpoint and returns its JSON answer (undefined when it has none). */
async function sendControl(body: unknown, deps: EngineDeps): Promise<unknown> {
  const url = deps.target.mockControl;
  if (url === undefined) throw new Error('no mock control');
  const response = await (deps.target.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`mock control answered ${String(response.status)}`);
  return (await response.json().catch(() => undefined)) as unknown;
}

async function runControl(
  step: ControlStep,
  vars: Vars,
  deps: EngineDeps,
  failures: string[],
  where: string
): Promise<void> {
  if (readsSink(step, deps.target)) return runSinkDeliveries(step, vars, deps, failures, where);
  let answer: unknown;
  try {
    answer = await sendControl(interpolate(step.control, vars), deps);
  } catch (error) {
    failures.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  // Rev 12: every delivery the mock hands over must be a `WebhookDelivery`, whatever else the step checks.
  if (step.control.deliveries !== undefined) {
    const deliveries = getPath(answer, 'deliveries');
    if (!Array.isArray(deliveries)) failures.push(`${where}: the mock answered no deliveries`);
    else {
      const validate = deps.index.schema('WebhookDelivery');
      deliveries.forEach((delivery, position) => {
        if (!validate(delivery))
          failures.push(
            `${where}: delivery ${String(position)} does not match WebhookDelivery: ${describeErrors(validate)}`
          );
      });
    }
  }
  for (const [name, path] of Object.entries(step.save ?? {})) vars[name] = getPath(answer, path);
  for (const predicate of step.expect_body ?? [])
    check(interpolate(predicate, vars) as Predicate, answer, failures, where);
}

const CLOUDEVENTS_JSON = 'application/cloudevents+json';

/** One read of the sink: what the step's checks said about it, or a wire fault no later read can cure. */
interface SinkRead {
  /** Set when the sink or an item broke the wire contract: the step fails now, without polling. */
  readonly fatal?: string;
  /** Set when the sink could not be read now (unreachable, timed out, 429, 5xx): retried until the wait runs out. */
  readonly transient?: string;
  readonly problems: string[];
  readonly answer: { deliveries: unknown[] };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The time of a delivery body for ordering; a body without a readable time sorts last. */
const timeKey = (body: unknown): number => {
  const time = isRecord(body) ? body.time : undefined;
  const parsed = typeof time === 'string' ? Date.parse(time) : Number.NaN;
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
};

/**
 * The URL form of `url` when it is under the sink's base, else undefined. Both are compared in URL form, so a host the
 * deployment lower-cases or a default port it drops still matches, and `..` segments cannot climb out of the base.
 * The read then goes to exactly the URL that was checked.
 */
function urlUnderSink(url: string, baseUrl: string): string | undefined {
  try {
    const base = new URL(baseUrl);
    const target = new URL(url);
    const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
    return target.origin === base.origin &&
      target.pathname.startsWith(prefix) &&
      target.pathname.length > prefix.length
      ? target.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a webhook's deliveries from the run's sink instead of mock control. The contract lets a receiver see
 * deliveries repeated and in any order, so the stored bodies are deduped on the event `id` (first kept) and
 * ordered by `time` (stable on arrival) before the step's checks. Delivery is asynchronous: the read repeats every
 * 2 s until the checks hold or `waitSeconds` runs out, then a read after `settleSeconds` decides the step, so a
 * `length: 0` check has a window in which a leaked delivery would show. The bearer goes only to the registered
 * URL under the sink's base, and a URL outside it fails the step without a request.
 */
async function runSinkDeliveries(
  step: ControlStep,
  vars: Vars,
  deps: EngineDeps,
  failures: string[],
  where: string
): Promise<void> {
  const sink = deps.target.webhookSink;
  if (sink === undefined) {
    failures.push(`${where}: no webhook sink`);
    return;
  }
  const resolved = interpolate(step.control, vars) as {
    deliveries: { webhook_id: string; url?: string };
  };
  const { webhook_id: webhookId, url } = resolved.deliveries;
  if (typeof url !== 'string') {
    failures.push(`${where}: the step names no url, so the webhook sink cannot be read`);
    return;
  }
  const sinkUrl = urlUnderSink(url, sink.baseUrl);
  if (sinkUrl === undefined) {
    failures.push(
      `${where}: the webhook url ${JSON.stringify(url)} is not under the webhook sink ${sink.baseUrl}/, so it was not read (the sink token is sent only to the sink)`
    );
    return;
  }
  const fetchImpl = deps.target.fetch ?? fetch;
  const clock = deps.clock ?? {
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const validate = deps.index.schema('WebhookDelivery');
  const deadline = clock.now() + sink.waitSeconds * 1000;
  // Interpolated once, here: an unbound ${var} is an authoring error and fails as itself, not as a sink fault.
  let predicates: Predicate[];
  try {
    predicates = (step.expect_body ?? []).map((p) => interpolate(p, vars) as Predicate);
  } catch (error) {
    failures.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const read = async (until: number): Promise<SinkRead> => {
    const empty = { deliveries: [] };
    // A sink that accepts the connection and never answers must not outlast the wait: each read is cut off after
    // 10 s, or when the wait runs out if that is sooner (but never under 1 s).
    const budget = Math.max(1000, Math.min(SINK_READ_TIMEOUT_MS, until - clock.now()));
    let response: Response;
    try {
      response = await fetchImpl(sinkUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${sink.token}`, accept: 'application/json' },
        // Never followed: a 3xx comes back as a status and fails the step at once, naming it (fetch's own
        // redirect error would be a thrown fault, retried as transient with a generic message).
        redirect: 'manual',
        signal: AbortSignal.timeout(budget),
      });
    } catch (error) {
      return {
        transient: `reading the webhook sink failed: ${error instanceof Error ? error.message : String(error)}`,
        problems: [],
        answer: empty,
      };
    }
    // A rollout or a busy gateway answers 429 or 5xx for a moment; anything else (401, 403, 404) will not change.
    if (response.status === 429 || response.status >= 500)
      return {
        transient: `reading the webhook sink answered ${String(response.status)}`,
        problems: [],
        answer: empty,
      };
    if (response.status !== 200)
      return {
        fatal: `reading the webhook sink answered ${String(response.status)}`,
        problems: [],
        answer: empty,
      };
    // A body that cannot be read (truncated, reset, cut off by the signal) is a fault of this read, like a 5xx.
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return {
        transient: `reading the webhook sink body failed: ${error instanceof Error ? error.message : String(error)}`,
        problems: [],
        answer: empty,
      };
    }
    let stored: unknown;
    try {
      stored = JSON.parse(text);
    } catch {
      stored = undefined;
    }
    const items = isRecord(stored) ? stored.deliveries : undefined;
    if (!Array.isArray(items))
      return { fatal: 'the webhook sink answered no deliveries list', problems: [], answer: empty };
    const bodies: unknown[] = [];
    const seen = new Set<string>();
    for (const [position, item] of items.entries()) {
      const at = `stored delivery ${String(position)}`;
      if (!isRecord(item)) return { fatal: `${at} is not an object`, problems: [], answer: empty };
      if (item.webhook_id !== webhookId)
        return {
          fatal: `${at} carries NobleCloak-Webhook-Id ${JSON.stringify(item.webhook_id)}, not ${JSON.stringify(webhookId)}`,
          problems: [],
          answer: empty,
        };
      const mediaType =
        typeof item.content_type === 'string'
          ? (item.content_type.split(';')[0] ?? '').trim().toLowerCase()
          : undefined;
      if (mediaType !== CLOUDEVENTS_JSON)
        return {
          fatal: `${at} was sent as ${JSON.stringify(item.content_type)}, not ${CLOUDEVENTS_JSON}`,
          problems: [],
          answer: empty,
        };
      let body: unknown;
      try {
        body = JSON.parse(typeof item.body === 'string' ? item.body : '');
      } catch {
        return { fatal: `${at} body is not JSON`, problems: [], answer: empty };
      }
      const id = isRecord(body) ? body.id : undefined;
      if (typeof id === 'string') {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      bodies.push(body);
    }
    // Equal times keep the sink's arrival order. That is the order the sink lists them in, so two reads of an
    // unchanged sink agree; the contract gives equal-time deliveries no order, so a scenario must not assert one.
    const ordered = bodies
      .map((body, arrival) => ({ body, arrival, key: timeKey(body) }))
      .sort((a, b) => (a.key === b.key ? a.arrival - b.arrival : a.key < b.key ? -1 : 1))
      .map((entry) => entry.body);
    const answer = { deliveries: ordered };
    const problems: string[] = [];
    ordered.forEach((delivery, position) => {
      if (!validate(delivery))
        problems.push(
          `${where}: delivery ${String(position)} does not match WebhookDelivery: ${describeErrors(validate)}`
        );
    });
    for (const predicate of predicates) check(predicate, answer, problems, where);
    return { problems, answer };
  };

  const attempt = async (until: number): Promise<SinkRead | undefined> => {
    try {
      return await read(until);
    } catch (error) {
      failures.push(
        `${where}: reading the webhook sink failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  };

  const unsettled = (read: SinkRead): boolean =>
    read.fatal === undefined && (read.transient !== undefined || read.problems.length > 0);
  let current = await attempt(deadline);
  while (current !== undefined && unsettled(current)) {
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      failures.push(
        ...current.problems,
        ...(current.transient === undefined ? [] : [`${where}: ${current.transient}`]),
        `${where}: the deliveries did not match after ${String(sink.waitSeconds)} s`
      );
      return;
    }
    // The last sleep ends at the deadline, so a wait shorter than one poll still gets a second read.
    await clock.sleep(Math.min(SINK_POLL_MS, remaining));
    current = await attempt(deadline);
  }
  if (current === undefined) return;
  if (current.fatal === undefined) {
    await clock.sleep(sink.settleSeconds * 1000);
    // The settle read decides the step, so it retries a transient fault like the poll does, in a window of its own.
    const settleDeadline = clock.now() + SINK_SETTLE_RETRY_MS;
    current = await attempt(settleDeadline);
    while (current?.transient !== undefined && settleDeadline - clock.now() > 0) {
      await clock.sleep(Math.min(SINK_POLL_MS, settleDeadline - clock.now()));
      current = await attempt(settleDeadline);
    }
    if (current === undefined) return;
    if (current.transient !== undefined) {
      failures.push(
        `${where}: ${current.transient} (after ${String(sink.settleSeconds)} s settle)`
      );
      return;
    }
    if (current.fatal === undefined && current.problems.length > 0) {
      failures.push(
        ...current.problems.map(
          (problem) => `${problem} (after ${String(sink.settleSeconds)} s settle)`
        )
      );
      return;
    }
  }
  if (current.fatal !== undefined) {
    failures.push(`${where}: ${current.fatal}`);
    return;
  }
  for (const [name, path] of Object.entries(step.save ?? {}))
    vars[name] = getPath(current.answer, path);
}

/** The `approval.updated` events of an SSE text, as parsed JSON. A comment line or another event is skipped. */
function parseEvents(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split('\n\n')) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (event === 'approval.updated' && data.length > 0) out.push(JSON.parse(data.join('\n')));
  }
  return out;
}

async function runStream(
  step: StreamStep,
  vars: Vars,
  deps: EngineDeps,
  failures: string[],
  where: string
): Promise<void> {
  const spec = step.stream_events;
  const { target } = deps;
  const path = interpolate(spec.path, vars) as string;
  const label = `${where} stream ${path}`;
  const controller = new AbortController();
  const response = await (target.fetch ?? fetch)(`${target.baseUrl}${path}`, {
    headers: headersFor(spec.as, target, undefined),
    redirect: 'manual',
    signal: controller.signal,
  });
  const type = response.headers.get('content-type') ?? '';
  if (response.status !== 200 || !type.startsWith('text/event-stream')) {
    failures.push(
      `${label}: expected a 200 text/event-stream, got ${String(response.status)} ${type}`
    );
    await response.body?.cancel();
    return;
  }
  // Read in the background: the stream is open while the requests of `during` run.
  let received = '';
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  const reading = (async (): Promise<void> => {
    if (reader === undefined) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        received += decoder.decode(value, { stream: true });
      }
    } catch {
      // The read ends when the stream is aborted below.
    }
  })();
  try {
    for (const [i, sub] of spec.during.entries()) {
      const before = failures.length;
      await runHttp(sub, vars, deps, failures, `${where} during ${String(i + 1)}`);
      if (failures.length > before) return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, spec.settle_ms ?? 300));
  } finally {
    controller.abort();
    // A body that does not end with the abort is cancelled, so the read below returns.
    await reader?.cancel().catch(() => undefined);
    await reading;
  }
  let events: unknown[];
  try {
    events = parseEvents(received);
  } catch (error) {
    failures.push(
      `${label}: an event is not JSON (${error instanceof Error ? error.message : String(error)})`
    );
    return;
  }
  const validate = deps.index.schema('Approval');
  for (const event of events)
    if (!validate(event))
      failures.push(
        `${label}: an event does not match the Approval schema: ${describeErrors(validate)}`
      );
  const idOf = (event: unknown): unknown => getPath(event, 'id');
  for (const wanted of spec.expect.delivers ?? []) {
    const raw = typeof wanted === 'string' ? wanted : wanted.id;
    const id = interpolate(raw, vars);
    const mine = events.filter((event) => idOf(event) === id);
    if (mine.length === 0) {
      failures.push(`${label}: no event was delivered for ${String(id)}`);
      continue;
    }
    if (typeof wanted !== 'string')
      for (const [n, event] of mine.entries()) {
        if (wanted.every_event !== true && n !== mine.length - 1) continue;
        for (const predicate of wanted.body)
          check(
            interpolate(predicate, vars) as Predicate,
            event,
            failures,
            `${label} event ${String(id)}${wanted.every_event === true ? ` (${String(n + 1)} of ${String(mine.length)})` : ''}`
          );
      }
  }
  for (const unwanted of spec.expect.lacks ?? []) {
    const id = interpolate(unwanted, vars);
    if (events.some((event) => idOf(event) === id))
      failures.push(
        `${label}: an event was delivered for ${String(id)}, which must not be visible here`
      );
  }
}

async function advanceClock(
  step: ClockStep,
  deps: EngineDeps,
  failures: string[],
  where: string
): Promise<void> {
  const url = deps.target.clockControl;
  if (url === undefined) return void failures.push(`${where}: no clock control`);
  const response = await (deps.target.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seconds: step.advance_seconds }),
  });
  if (!response.ok) failures.push(`${where}: clock control answered ${String(response.status)}`);
}

function decodePayload(jws: string): Record<string, unknown> {
  return JSON.parse(
    TEXT.decode(
      Uint8Array.from(atob((jws.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0)
      )
    )
  ) as Record<string, unknown>;
}

/** A verify step, in either form, as one spec. The rev 11 `verify_resumption` is a `resumption` verify. */
function verifySpecOf(step: VerifyStep | VerifyResumptionStep, vars: Vars): VerifySpec {
  if ('verify_resumption' in step) {
    const spec = interpolate(
      step.verify_resumption,
      vars
    ) as VerifyResumptionStep['verify_resumption'];
    return {
      kind: 'resumption',
      object: spec.resumption,
      jwks: spec.jwks,
      expect: spec.expect,
      ...(spec.tamper === undefined ? {} : { tamper: spec.tamper }),
      result: spec.result,
    };
  }
  return interpolate(step.verify, vars) as VerifySpec;
}

async function runVerify(
  step: VerifyStep | VerifyResumptionStep,
  vars: Vars,
  failures: string[],
  where: string
): Promise<void> {
  const spec = verifySpecOf(step, vars);
  const object = spec.object as Record<string, unknown>;
  let jws = String(object.signature);
  // A tamper belongs to one kind: a resumption's two members, or a delivery's `data`.
  const tampers = spec.kind === 'webhook_delivery' ? ['data'] : ['action_digest', 'tool_ref'];
  if (spec.tamper !== undefined && !tampers.includes(spec.tamper))
    return void failures.push(
      `${where}: tamper ${spec.tamper} does not apply to a ${spec.kind} verify (it takes ${tampers.join(' or ')})`
    );
  if (spec.tamper !== undefined) {
    const [header = '', , signature = ''] = jws.split('.');
    const payload = decodePayload(jws);
    if (spec.tamper === 'data') payload.data = { tampered: true };
    else payload[spec.tamper] = spec.tamper === 'action_digest' ? '0'.repeat(64) : 'other:tool';
    jws = `${header}.${base64Url(JSON.stringify(payload))}.${signature}`;
  }
  let outcome = 'valid';
  try {
    if (spec.kind === 'webhook_delivery') await verifyDeliverySignature(jws, spec.jwks as Jwks);
    else if (spec.expect === undefined)
      return void failures.push(`${where}: a resumption verify needs expect`);
    else await verifyResumption(jws, spec.jwks as Jwks, spec.expect);
  } catch (error) {
    if (!(error instanceof ResumptionError)) throw error;
    outcome = error.code;
  }
  if (outcome !== spec.result)
    failures.push(
      `${where}: verification ${outcome === 'valid' ? 'succeeded' : `rejected with ${outcome}`}, expected ${spec.result}`
    );
  if (spec.result === 'valid' && spec.tamper === undefined && outcome === 'valid') {
    const unsigned = Object.fromEntries(
      Object.entries(object).filter(([key]) => key !== 'signature')
    );
    const signed = decodePayload(jws);
    if (JSON.stringify(sortKeys(signed)) !== JSON.stringify(sortKeys(unsigned))) {
      failures.push(
        `${where}: the signed payload is not the ${spec.kind === 'webhook_delivery' ? 'delivery' : 'Resumption'} object it travels with`
      );
    }
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}

async function runAuthzen(
  step: AuthzenStep,
  vars: Vars,
  deps: EngineDeps,
  failures: string[],
  where: string
): Promise<void> {
  const spec = interpolate(step.authzen, vars) as AuthzenStep['authzen'];
  const token = tokenFor(deps.target, spec.as);
  // The library ships a CommonJS bundle behind an ESM wrapper, so its exports sit on `default`, and
  // its declaration files do not resolve under NodeNext: the shape used here is declared locally.
  const authzen = (await import('@rocksolidknowledge/authzen-client')) as unknown as {
    default: {
      AuthZenClient: new (config: { pdpUrl: string; token?: string }) => AuthZenClientLike;
    };
  };
  const client = new authzen.default.AuthZenClient({
    pdpUrl: deps.target.baseUrl,
    ...(token === undefined ? {} : { token }),
  });
  const configuration = await client.discover();
  const response = (await client.evaluate(spec.request)) as {
    decision: boolean;
    context?: { noblecloak?: { decision?: string } & Record<string, unknown> };
  };
  for (const [name, value, schema] of [
    ['AuthzenConfiguration', configuration, 'configuration'],
    ['AuthzenEvaluationResponse', response, 'evaluation response'],
  ] as const) {
    const validate = deps.index.schema(name);
    if (!validate(value))
      failures.push(
        `${where}: the AuthZEN ${schema} does not match the document: ${describeErrors(validate)}`
      );
  }
  deps.exercised.add('authzenConfiguration');
  deps.exercised.add('authzenEvaluate');
  if (response.decision !== spec.expect.decision)
    failures.push(
      `${where}: AuthZEN decision was ${String(response.decision)}, expected ${String(spec.expect.decision)} (endpoint ${configuration.access_evaluation_endpoint ?? '?'})`
    );
  const detail = response.context?.noblecloak?.decision;
  if (spec.expect.noblecloak_decision !== undefined && detail !== spec.expect.noblecloak_decision) {
    failures.push(
      `${where}: context.noblecloak.decision was ${String(detail)}, expected ${spec.expect.noblecloak_decision}`
    );
  }
  const noblecloak = response.context?.noblecloak;
  if (
    spec.expect.noblecloak_policy_absent === true &&
    noblecloak !== undefined &&
    'policy' in noblecloak
  ) {
    failures.push(
      `${where}: context.noblecloak.policy should be absent when the default applied, got ${JSON.stringify(noblecloak.policy)}`
    );
  }
  if (spec.expect.noblecloak_policy_absent === true && noblecloak === undefined) {
    failures.push(`${where}: the response has no context.noblecloak to check`);
  }
}
