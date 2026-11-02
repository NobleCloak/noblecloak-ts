/** Errors of the service-principal subpath. Messages never carry key material or an assertion. */

export type ServicePrincipalErrorCode =
  /** No credential source was given and `NOBLECLOAK_SP_CREDENTIALS` is unset. */
  | 'credential_missing'
  /** A credential file or key file could not be read. */
  | 'credential_unreadable'
  /** The credential is not valid JSON, has the wrong shape, or carries a key this package refuses. */
  | 'invalid_credential'
  /** The token endpoint answered `invalid_client`: the principal is revoked or expired, or the key is unknown. */
  | 'invalid_client'
  /** The token endpoint refused the request for another OAuth reason (`oauthError` names it). */
  | 'token_request_rejected'
  /** The token endpoint did not answer with a usable token response. */
  | 'invalid_response'
  /** The request never got an answer. */
  | 'network_error';

export class ServicePrincipalError extends Error {
  readonly code: ServicePrincipalErrorCode;
  /** The HTTP status of the token endpoint's answer, when there was one. */
  readonly status?: number;
  /** The OAuth `error` the token endpoint returned, when there was one. */
  readonly oauthError?: string;

  constructor(
    code: ServicePrincipalErrorCode,
    message: string,
    details: { status?: number; oauthError?: string; cause?: unknown } = {}
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ServicePrincipalError';
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
    if (details.oauthError !== undefined) this.oauthError = details.oauthError;
  }
}
