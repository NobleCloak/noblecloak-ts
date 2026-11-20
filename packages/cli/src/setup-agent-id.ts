import { createHash } from 'node:crypto';

/**
 * The namespace of the setup agents' UUIDv5 ids, as bianoble-coo 01405581 names it
 * (apps/api/src/internal-setup-proposal-routes.ts:62, `SETUP_AGENT_NAMESPACE`; the comment above it says "Never
 * change it: it names existing agents"). It is the one copy in this repo.
 */
export const SETUP_AGENT_NAMESPACE = '6f0c9a52-3b1e-4d7a-9c58-2e41b7a0d3f6';

/** RFC 9562 UUIDv5 (SHA-1) of `name` in `namespace`. */
function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The agent bianoble-coo declares when a service principal is created in the browser: a UUIDv5 of the
 * lower-cased `<org>:<principal>` (bianoble-coo 01405581 internal-setup-proposal-routes.ts:76-77,
 * `setupAgentId`). The same id on every call. coo opens a setup proposal for it only when the principal is
 * created in the browser (noblesos-team `buildCredentialFile` downloads the credential); `noblecloak sp
 * create` never has one opened, because Core skips the admin-API audience.
 */
export function setupAgentId(orgId: string, principalId: string): string {
  return uuidV5(`${orgId.toLowerCase()}:${principalId.toLowerCase()}`, SETUP_AGENT_NAMESPACE);
}

/**
 * Where a setup approval says it came from: the `correlation.source` of the continuation coo stores on the
 * approval it opens for a browser-created principal (bianoble-coo origin/main 01405581
 * apps/api/src/internal-setup-proposal-routes.ts, `SETUP_PROPOSAL_SOURCE`, passed by the route to
 * `opener.open`; apps/api/src/default-policy-open.ts `open()` stores `{ kind: 'mcp_held', delivery: 'held',
 * correlation }`).
 */
export const SETUP_PROPOSAL_SOURCE = 'internal_setup_proposal';

/**
 * The continuation coo gives the setup approval it opens for `principalId` (lower-cased, as the route
 * lower-cases it). coo opens a duplicate of an open approval only for the same proposer, the same argument
 * digest AND the same continuation (packages/services/obligations/src/continuation.ts `compareContinuation`,
 * JCS equality): any other continuation on an identical proposal is 409 `continuation_conflict`.
 */
export function setupContinuation(principalId: string): {
  readonly kind: 'mcp_held';
  readonly delivery: 'held';
  readonly correlation: { readonly source: string; readonly principal_id: string };
} {
  return {
    kind: 'mcp_held',
    delivery: 'held',
    correlation: { source: SETUP_PROPOSAL_SOURCE, principal_id: principalId.toLowerCase() },
  };
}
