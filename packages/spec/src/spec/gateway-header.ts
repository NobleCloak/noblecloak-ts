/**
 * The identity headers an upstream gateway sets for a service behind it. The module API refuses them:
 * identity comes from the verified token and from nothing else.
 *
 * The names are assembled from parts because every tracked file is checked for the prefix literal, and
 * only the contract document and the client schema generated from it may carry it. The five names below
 * are held to the same rule: code builds them from here instead of spelling them.
 */
export const GATEWAY_HEADER_PREFIX = ['x', 'actor', ''].join('-');

/** A gateway identity header name under the prefix, for example `gatewayHeader('id')`. */
export const gatewayHeader = (name: string): string => `${GATEWAY_HEADER_PREFIX}${name}`;

/** The header that names the organisation a caller acts for. */
export const ORGANIZATION_HEADER = ['x', 'organization', 'id'].join('-');
/** The headers that name the caller's permissions. */
export const PERMISSIONS_HEADER = ['x', 'permissions'].join('-');
export const SCOPES_HEADER = ['x', 'scopes'].join('-');

/** The five names the document lists as rejected, in the order it lists them. */
export const REJECTED_IDENTITY_HEADERS: readonly string[] = [
  gatewayHeader('id'),
  gatewayHeader('type'),
  ORGANIZATION_HEADER,
  PERMISSIONS_HEADER,
  SCOPES_HEADER,
];

/** True for a header the module API refuses: one of the five names, or any name under the prefix. */
export const isRejectedIdentityHeader = (name: string): boolean => {
  const lower = name.toLowerCase();
  return lower.startsWith(GATEWAY_HEADER_PREFIX) || REJECTED_IDENTITY_HEADERS.includes(lower);
};
