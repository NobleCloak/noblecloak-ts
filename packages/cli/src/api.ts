import { interrupted, interruptedError, requestSignal } from './abortable.js';
import type { Config } from './config.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import type { PublicJwk } from './keys.js';
import { oneLine } from './terminal.js';

export interface Principal {
  readonly id: string;
  readonly client_id: string;
  readonly org_id: string;
  readonly name: string;
  readonly allowed_audiences: readonly string[];
  readonly scopes: readonly string[];
  readonly key_thumbprints: readonly string[];
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

/** What the server tells the builder to put in the credential. Either field is null when the issuer is unset. */
export interface Registration {
  readonly client_id: string;
  readonly assertion_audience: string | null;
  readonly token_endpoint: string | null;
}

export interface Registered {
  readonly principal: Principal;
  readonly registration: Registration;
}

const unexpected = (what: string): CliError =>
  new CliError(EXIT.failed, `Unexpected response from the server: ${what}.`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== 'string') throw unexpected(`${name} is missing`);
  return value;
}

function strings(record: Record<string, unknown>, name: string): string[] {
  const value = record[name];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw unexpected(`${name} is missing`);
  }
  return value;
}

function nullableString(record: Record<string, unknown>, name: string): string | null {
  const value = record[name];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value === '') return null;
  return value;
}

export function parsePrincipal(value: unknown): Principal {
  if (!isRecord(value)) throw unexpected('a principal is not an object');
  return {
    id: str(value, 'id'),
    client_id: str(value, 'client_id'),
    org_id: str(value, 'org_id'),
    name: str(value, 'name'),
    allowed_audiences: strings(value, 'allowed_audiences'),
    scopes: strings(value, 'scopes'),
    key_thumbprints: strings(value, 'key_thumbprints'),
    expires_at: str(value, 'expires_at'),
    revoked_at: nullableString(value, 'revoked_at'),
  };
}

function parseRegistered(value: unknown): Registered {
  if (!isRecord(value)) throw unexpected('the data is not an object');
  const registration = value.registration;
  if (!isRecord(registration)) throw unexpected('registration is missing');
  return {
    principal: parsePrincipal(value),
    registration: {
      client_id: str(registration, 'client_id'),
      assertion_audience: nullableString(registration, 'assertion_audience'),
      token_endpoint: nullableString(registration, 'token_endpoint'),
    },
  };
}

/** Maps a non-2xx answer to an exit code. The message is the server's `error.code` and `error.message`. */
async function failure(response: Response): Promise<CliError> {
  const body: unknown = await response.json().catch(() => undefined);
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const code = typeof error.code === 'string' ? oneLine(error.code) : 'UNKNOWN';
  const message = typeof error.message === 'string' ? oneLine(error.message) : 'no message';
  const status = String(response.status);
  if (response.status === 401) {
    return new CliError(EXIT.unauthenticated, `Not signed in: the server answered 401 (${code}).`);
  }
  if (response.status === 403) {
    return new CliError(
      EXIT.forbidden,
      `Forbidden: you are not an administrator of that organisation (${code}: ${message}).`
    );
  }
  return new CliError(EXIT.failed, `The server answered ${status} ${code}: ${message}`);
}

export interface CreateBody {
  readonly name: string;
  readonly allowed_audiences: readonly string[];
  readonly scopes?: readonly string[];
  readonly public_jwk: PublicJwk;
  readonly expires_in_days?: number;
}

export interface RotateBody {
  readonly public_jwk: PublicJwk;
  readonly revoke_previous?: true;
  readonly expires_in_days?: number;
}

const MAYBE_APPLIED =
  'The server may or may not have applied the request: run noblecloak sp list to check.';

/** Error codes of a connection that never opened, so the server never saw the request. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** True when fetch failed before the request left the machine (Node puts the socket error in `cause`). */
function neverSent(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code = isRecord(cause) ? cause.code : undefined;
  return typeof code === 'string' && NEVER_SENT.has(code);
}

/** The four service-principal routes, on the authorization server's origin. */
export class SpApi {
  constructor(
    private readonly io: Io,
    private readonly config: Config,
    private readonly accessToken: string
  ) {}

  /**
   * `note` is appended when a POST may or may not have been applied (interrupted, timed out, or failed for
   * any reason but a refused connection or an unresolved host): it says what that leaves behind.
   */
  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    note = ''
  ): Promise<unknown> {
    let response: Response;
    const signal = requestSignal(this.io);
    try {
      response = await this.io.fetch(`${this.config.origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error) {
      if (method === 'GET') {
        if (interrupted(this.io)) throw interruptedError('Nothing was changed.');
        throw new CliError(EXIT.failed, `Cannot reach the server at ${this.config.origin}.`);
      }
      if (interrupted(this.io)) throw interruptedError(`${MAYBE_APPLIED}${note}`);
      if (neverSent(error)) {
        throw new CliError(
          EXIT.failed,
          `Cannot reach the server at ${this.config.origin}; the request was not sent.`
        );
      }
      const why = signal.aborted ? 'timed out' : 'failed';
      throw new CliError(
        EXIT.failed,
        `The request to ${this.config.origin} ${why} before an answer arrived. ${MAYBE_APPLIED}${note}`
      );
    }
    if (!response.ok) throw await failure(response);
    const parsed: unknown = await response.json().catch(() => undefined);
    if (parsed === undefined && interrupted(this.io)) {
      throw interruptedError(method === 'GET' ? 'Nothing was changed.' : `${MAYBE_APPLIED}${note}`);
    }
    if (!isRecord(parsed) || parsed.data === undefined) throw unexpected('the body has no data');
    return parsed.data;
  }

  async create(orgId: string, body: CreateBody, note?: string): Promise<Registered> {
    return parseRegistered(
      await this.call('POST', `/organizations/${orgId}/service-principals`, body, note)
    );
  }

  async list(orgId: string): Promise<Principal[]> {
    const data = await this.call('GET', `/organizations/${orgId}/service-principals`);
    if (!isRecord(data) || !Array.isArray(data.service_principals)) {
      throw unexpected('service_principals is missing');
    }
    return data.service_principals.map(parsePrincipal);
  }

  async rotate(orgId: string, spId: string, body: RotateBody, note?: string): Promise<Registered> {
    return parseRegistered(
      await this.call(
        'POST',
        `/organizations/${orgId}/service-principals/${spId}/rotate`,
        body,
        note
      )
    );
  }

  async revoke(orgId: string, spId: string): Promise<void> {
    await this.call('POST', `/organizations/${orgId}/service-principals/${spId}/revoke`);
  }
}
