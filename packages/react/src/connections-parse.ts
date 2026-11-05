/**
 * Response-shape checks for the connections module. Everything here is pure. A reader returns `undefined` for a body
 * that is not the contract's shape, and a list with one unreadable row is unreadable as a whole: the store reports it
 * as an error, never as an empty list. An open value the module does not know is kept as sent. No reader keeps a
 * member the contract does not name, so a credential a service sent by mistake is never held or shown.
 */
import { toolFactsOf } from './connections-facts.js';
import { pageOf } from './permissions-parse.js';
import type {
  ConnectionInfo,
  ConnectionLinkInfo,
  ConnectionRefreshCounts,
  ConnectionReturn,
  ConnectionReturnError,
  ConnectionToolInfo,
  ConnectionsCapabilityFacts,
} from './connections-types.js';

export { pageOf };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The `data` of an envelope; `undefined` when the value is not one. */
const dataOf = (value: unknown): unknown => (isRecord(value) ? value.data : undefined);

function linkOf(value: unknown): ConnectionLinkInfo | undefined {
  if (!isRecord(value) || !isText(value.status) || !isText(value.consent)) return undefined;
  return {
    status: value.status,
    consent: value.consent,
    ...(isText(value.linked_at) ? { linkedAt: value.linked_at } : {}),
  };
}

/** One registration as the module holds it; `undefined` when the value is not a `Connection`. */
export function connectionOf(value: unknown): ConnectionInfo | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, url, transport, owner, created_at: createdAt } = value;
  if (!isText(id) || typeof name !== 'string' || !isText(url) || !isText(transport))
    return undefined;
  if (!isRecord(owner) || !isText(owner.kind) || !isText(owner.id) || !isText(createdAt))
    return undefined;
  // `my_link` is optional; one of another shape makes the row unreadable rather than hiding it.
  const myLink = value.my_link === undefined ? undefined : linkOf(value.my_link);
  if (value.my_link !== undefined && myLink === undefined) return undefined;
  const verified = value.last_verified_at;
  return {
    id,
    name,
    url,
    transport,
    owner: { kind: owner.kind, id: owner.id },
    createdAt,
    ...(isText(value.status) ? { state: value.status } : {}),
    ...(isText(value.status_detail) ? { stateDetail: value.status_detail } : {}),
    ...(verified === null || isText(verified) ? { lastVerifiedAt: verified } : {}),
    ...(isText(value.auth_kind) ? { authKind: value.auth_kind } : {}),
    ...(isText(value.credential_tier) ? { credentialTier: value.credential_tier } : {}),
    ...(myLink === undefined ? {} : { myLink }),
  };
}

/** A `{ data: Connection }` envelope as one registration. */
export function connectionEnvelopeOf(value: unknown): ConnectionInfo | undefined {
  return connectionOf(dataOf(value));
}

/** One tool, as this module shows it; `undefined` when the value is not a `Tool`. */
export function connectionToolOf(value: unknown): ConnectionToolInfo | undefined {
  if (!isRecord(value) || !isText(value.id) || !isText(value.tool_ref)) return undefined;
  if (!isText(value.transport) || !isText(value.side_effect_level)) return undefined;
  const connection = value.connection_id;
  if (connection !== undefined && connection !== null && typeof connection !== 'string')
    return undefined;
  const facts = toolFactsOf(value.facts);
  return {
    id: value.id,
    toolRef: value.tool_ref,
    connectionId: typeof connection === 'string' ? connection : null,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    transport: value.transport,
    sideEffectLevel: value.side_effect_level,
    // Absent means active (rev 11). Any other value is kept as sent (one that is not text, as its JSON) and, unless it
    // is `active`, read as not callable: never as active.
    status:
      value.status === undefined
        ? 'active'
        : isText(value.status)
          ? value.status
          : JSON.stringify(value.status),
    ...(facts === undefined
      ? {}
      : facts === 'unreadable'
        ? { factsUnreadable: true as const }
        : { facts }),
  };
}

/** A `{ data: Tool }` envelope as one tool. */
export function toolEnvelopeOf(value: unknown): ConnectionToolInfo | undefined {
  return connectionToolOf(dataOf(value));
}

/** A `{ data: ConnectionRefreshResult }` envelope. */
export function refreshCountsOf(value: unknown): ConnectionRefreshCounts | undefined {
  const data = dataOf(value);
  if (!isRecord(data)) return undefined;
  const { tool_count: toolCount, added, removed, reactivated } = data;
  if (!isCount(toolCount) || !isCount(added) || !isCount(removed) || !isCount(reactivated))
    return undefined;
  return {
    toolCount,
    added,
    removed,
    reactivated,
    emptyUpstreamSuppressed: data.empty_upstream_suppressed === true,
  };
}

/** A `{ data: ConnectionAuthorizeResult }` envelope: the URL to send the browser to. */
export function authorizationUrlOf(value: unknown): string | undefined {
  const data = dataOf(value);
  if (!isRecord(data) || !isText(data.authorization_url)) return undefined;
  return isWebUrl(data.authorization_url) ? data.authorization_url : undefined;
}

/**
 * Whether `href` is an https URL, or an http URL to this machine (a local server): never plaintext over a network,
 * and never a `javascript:` or a `data:` URL. The rule for a server's URL in the form and for an authorization URL.
 */
export function isWebUrl(href: string): boolean {
  if (!URL.canParse(href)) return false;
  const url = new URL(href);
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

const TRANSPORTS = ['mcp', 'a2a'] as const;

/** The loopback names an http authorization URL may use. */
const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The members of `GET /v1/capabilities` this module reads; `undefined` when the body is not `Capabilities`. */
export function connectionsCapabilitiesOf(value: unknown): ConnectionsCapabilityFacts | undefined {
  const data = dataOf(value);
  if (!isRecord(data) || !Array.isArray(data.features)) return undefined;
  const features = new Set(data.features.filter(isText));
  const served = features.has('connections');
  const registration = data.connection_registration;
  const transports = data.connection_transports;
  return {
    served,
    oauth: served && features.has('connections.oauth'),
    userLinks: served && features.has('connections.user_links'),
    ...(isRecord(registration) &&
    Array.isArray(registration.owner_kinds) &&
    isText(registration.who)
      ? {
          registration: {
            ownerKinds: registration.owner_kinds.filter(isText),
            who: registration.who,
          },
        }
      : {}),
    transports: Array.isArray(transports) ? transports.filter(isText) : [...TRANSPORTS],
    ...(features.has('tools.facts') ? { toolFacts: true as const } : {}),
  };
}

/**
 * The `nc_*` parameters an OAuth round trip comes back with, and `nc_state`, the nonce this module adds to the page it
 * returns to so that it knows the round trip is one this browser started.
 */
export const RETURN_PARAMETERS = ['nc_connection', 'nc_result', 'nc_error', 'nc_state'] as const;

const RETURN_ERRORS: readonly ConnectionReturnError[] = [
  'consent_denied',
  'expired',
  'exchange_failed',
  'upstream_error',
];

/** The parameters of a return, as they are in the address: untrusted until the store matches `state`. */
export interface ReturnParameters {
  readonly connectionId: string;
  readonly state?: string;
  readonly result: ConnectionReturn['result'];
  readonly error?: ConnectionReturnError;
}

/**
 * What the round trip came back with, from a page URL; `undefined` when it carries none. A result other than
 * `connected` reads as `error`, and an error code outside the closed list is left out: no text of the address is kept.
 */
export function returnOf(href: string): ReturnParameters | undefined {
  if (!URL.canParse(href)) return undefined;
  const params = new URL(href).searchParams;
  const connectionId = params.get('nc_connection');
  const result = params.get('nc_result');
  if (!isText(connectionId) || !isText(result)) return undefined;
  const state = params.get('nc_state');
  const error = params.get('nc_error');
  const known = RETURN_ERRORS.find((code) => code === error);
  return {
    connectionId,
    ...(isText(state) ? { state } : {}),
    result: result === 'connected' ? 'connected' : 'error',
    ...(result !== 'connected' && known !== undefined ? { error: known } : {}),
  };
}

/** `href` without the `nc_*` parameters: the page the round trip returns to, and the address once it is read. */
export function withoutReturn(href: string): string {
  if (!URL.canParse(href)) return href;
  const url = new URL(href);
  // An address that carries none is left exactly as it is: rewriting the query would re-encode the host's own.
  if (!RETURN_PARAMETERS.some((name) => url.searchParams.has(name))) return href;
  for (const name of RETURN_PARAMETERS) url.searchParams.delete(name);
  return url.toString();
}

/** `href` with the nonce of an authorization this browser starts (`nc_state`). */
export function withState(href: string, state: string): string {
  if (!URL.canParse(href)) return href;
  const url = new URL(href);
  url.searchParams.set('nc_state', state);
  return url.toString();
}
