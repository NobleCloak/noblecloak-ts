/**
 * Capability families: the groups of routes a deployment may or may not serve, and how a deployment
 * advertises them on `GET /v1/capabilities`.
 *
 * `approvals` is advertised iff `resolutions` is non-empty. Every other family is advertised iff its
 * name appears in `features`. What a deployment cannot opt out of (the floor) has no family:
 * capabilities, decisions, records (create, list, get), tools, AuthZEN, the well-known documents and
 * every authentication negative.
 */

export const FAMILIES = [
  'approvals',
  'runs',
  'webhooks',
  'origins',
  'policies',
  'agents',
  'principals',
  'connections',
  'records.checkpoints',
  'records.chain',
  'evidence',
] as const;

export type Family = (typeof FAMILIES)[number];

export const isFamily = (value: unknown): value is Family =>
  typeof value === 'string' && (FAMILIES as readonly string[]).includes(value);

/**
 * The features a scenario may require (`Scenario.features`): names in `Capabilities.features` that are not
 * families. A feature is advertised iff its name appears in `features`. Closed, so a misspelt name fails
 * like an unknown family instead of being skipped as a feature the deployment lacks.
 */
export const FEATURES = [
  'policies.author',
  'policies.publish',
  'policies.import_export',
  // Rev 11: retiring a policy and discarding its draft (hosted only).
  'policies.retire',
  'records.verify',
  'evidence.export',
  'approvals.rejected_duplicate',
  // Rev 11: the OAuth authorize step of a connection, and each user's own credential link (hosted only).
  'connections.oauth',
  'connections.user_links',
  // Rev 11: the deployment composes tool_invocation policies tightest-wins (either kind).
  'policies.tightest_wins',
  // Rev 15: the single read of a pending approval lists what the reader may do (either kind).
  'approvals.available_actions',
  // Rev 16: the facts of a call read through a tool's fact bindings, policy rules over them, and the
  // requirements of an approval with the approvers who may meet each.
  'tools.facts',
  'policies.rules',
  'approvals.requirements',
  // Rev 17: the deployment accepts the `claude_agent_sdk` continuation kind (pull only).
  'continuations.claude_agent_sdk',
] as const;

export type Feature = (typeof FEATURES)[number];

export const isFeature = (value: unknown): value is Feature =>
  typeof value === 'string' && (FEATURES as readonly string[]).includes(value);

/** The `x-noblecloak-feature` extension of an operation: the feature that serves it, when it has one. */
export const featureOf = (operation: Record<string, unknown>): Feature | undefined => {
  const value = operation['x-noblecloak-feature'];
  return isFeature(value) ? value : undefined;
};

/**
 * Names `nc-mock --advertise` accepts besides the families: the floor, which is always served, so
 * naming it changes nothing.
 */
export const FLOOR_NAMES = ['capabilities', 'decisions', 'records', 'tools', 'authzen'] as const;

/** The part of the capabilities answer that says which families are served. */
export interface CapabilityAdvert {
  readonly resolutions: readonly string[];
  readonly features: readonly string[];
}

/** The families a capabilities answer advertises. */
export function advertisedFamilies(capabilities: CapabilityAdvert): ReadonlySet<Family> {
  const out = new Set<Family>();
  if (capabilities.resolutions.length > 0) out.add('approvals');
  for (const family of FAMILIES)
    if (family !== 'approvals' && capabilities.features.includes(family)) out.add(family);
  return out;
}

/** The `x-noblecloak-family` extension of an operation, when it is one of the families. */
export const familyOf = (operation: Record<string, unknown>): Family | undefined => {
  const value = operation['x-noblecloak-family'];
  return isFamily(value) ? value : undefined;
};
