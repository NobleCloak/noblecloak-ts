/**
 * `@noblecloak/client/service-principal`: turns a service-principal credential into access tokens for
 * the client's `getToken` seam. Server-side only: it handles a private key, so the main entry never
 * imports it. Needs `fetch`, `crypto.subtle` and, to read a credential file, `node:fs`.
 */
export {
  CREDENTIAL_ENV,
  loadServicePrincipalCredential,
  parseServicePrincipalCredential,
} from './service-principal-credential.js';
export type {
  LoadOptions,
  PrivateJwk,
  ServicePrincipalCredential,
} from './service-principal-credential.js';
export { ServicePrincipalError } from './service-principal-error.js';
export type { ServicePrincipalErrorCode } from './service-principal-error.js';
export { servicePrincipalTokenSource } from './service-principal-token.js';
export type { ServicePrincipalTokenSource, TokenSourceOptions } from './service-principal-token.js';
