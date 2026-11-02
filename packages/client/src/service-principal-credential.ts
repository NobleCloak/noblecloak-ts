/**
 * The service-principal credential: its shape, its validation and the loader that reads it from a file,
 * inline JSON or `NOBLECLOAK_SP_CREDENTIALS`. Server-side only: it holds a private key.
 */
import { ServicePrincipalError } from './service-principal-error.js';

/** The environment variable the loader reads when no source is passed: a path, or inline JSON for CI secrets. */
export const CREDENTIAL_ENV = 'NOBLECLOAK_SP_CREDENTIALS';

/** A JWK, with the optional key id (`kid`) the assertion header carries. */
export type PrivateJwk = JsonWebKey & { kid?: string };

export interface ServicePrincipalCredential {
  /** `sp_<uuid>`: the principal's `client_id`, used as `iss` and `sub` of the assertion. */
  readonly client_id: string;
  /** The OAuth token endpoint the assertion is posted to. */
  readonly token_endpoint: string;
  /** The assertion's `aud`: the authorization server's issuer. */
  readonly assertion_audience: string;
  /** The private key: an EC P-256 key (ES256) or an RSA key of at least 2048 bits (RS256). */
  readonly private_jwk: PrivateJwk;
  readonly org_id?: string;
}

const CLIENT_ID = /^sp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A top-level field that looks like a secret other than the private key. */
const SECRET_NAME = /secret|passw|token|api[_-]?key|credential|bearer/i;
/** Fields this package knows; `key_file` is resolved by the loader, `private_jwk` is the key. */
const KNOWN = new Set([
  'client_id',
  'token_endpoint',
  'assertion_audience',
  'private_jwk',
  'key_file',
  'org_id',
]);

function invalid(message: string): ServicePrincipalError {
  return new ServicePrincipalError('invalid_credential', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== 'string' || value === '') {
    throw invalid(`Service-principal credential: ${name} must be a non-empty string.`);
  }
  return value;
}

/** An https URL; http only for a loopback host (local stubs). */
function endpoint(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`Service-principal credential: ${name} is not a URL.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw invalid(`Service-principal credential: ${name} must be an https URL.`);
  }
}

/** The bit length of a base64url big-endian modulus, ignoring leading zero bytes; 0 when it cannot be decoded. */
function modulusBits(n: string): number {
  let bytes: string;
  try {
    bytes = atob(n.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return 0;
  }
  let start = 0;
  while (start < bytes.length && bytes.charCodeAt(start) === 0) start += 1;
  if (start === bytes.length) return 0;
  return (bytes.length - start) * 8 - Math.clz32(bytes.charCodeAt(start)) + 24;
}

/** Throws unless the key is a private EC P-256 or RSA (>= 2048 bit) JWK. */
function checkPrivateKey(jwk: unknown): PrivateJwk {
  if (!isRecord(jwk))
    throw invalid('Service-principal credential: private_jwk must be a JWK object.');
  const key = jwk as PrivateJwk;
  if (key.kty === 'EC') {
    if (key.crv !== 'P-256') {
      throw invalid('Service-principal credential: an EC private_jwk must use curve P-256.');
    }
    if (typeof key.x !== 'string' || typeof key.y !== 'string') {
      throw invalid('Service-principal credential: private_jwk is missing its public coordinates.');
    }
  } else if (key.kty === 'RSA') {
    if (typeof key.n !== 'string' || typeof key.e !== 'string') {
      throw invalid(
        'Service-principal credential: private_jwk is missing its modulus or exponent.'
      );
    }
    if (modulusBits(key.n) < 2048) {
      throw invalid('Service-principal credential: an RSA private_jwk must be at least 2048 bits.');
    }
  } else {
    throw invalid('Service-principal credential: private_jwk must be an EC P-256 or RSA key.');
  }
  if (typeof key.d !== 'string' || key.d === '') {
    throw invalid(
      'Service-principal credential: private_jwk is a public key; the credential needs the private key (its "d" member).'
    );
  }
  return key;
}

/**
 * Validates a credential whose key is inline. Refuses a public-only key, an unsupported key, a
 * non-https token endpoint and any extra field whose name looks like a secret.
 */
export function parseServicePrincipalCredential(value: unknown): ServicePrincipalCredential {
  if (!isRecord(value)) throw invalid('Service-principal credential must be a JSON object.');
  for (const name of Object.keys(value)) {
    if (!KNOWN.has(name) && SECRET_NAME.test(name)) {
      throw invalid(
        `Service-principal credential: field "${name}" looks like a secret and is not accepted.`
      );
    }
  }
  const clientId = nonEmptyString(value, 'client_id');
  if (!CLIENT_ID.test(clientId)) {
    throw invalid('Service-principal credential: client_id must look like sp_<uuid>.');
  }
  const tokenEndpoint = nonEmptyString(value, 'token_endpoint');
  endpoint(tokenEndpoint, 'token_endpoint');
  const assertionAudience = nonEmptyString(value, 'assertion_audience');
  const orgId = value.org_id;
  if (orgId !== undefined && typeof orgId !== 'string') {
    throw invalid('Service-principal credential: org_id must be a string.');
  }
  return {
    client_id: clientId,
    token_endpoint: tokenEndpoint,
    assertion_audience: assertionAudience,
    private_jwk: checkPrivateKey(value.private_jwk),
    ...(orgId === undefined ? {} : { org_id: orgId }),
  };
}

export interface LoadOptions {
  /** The environment to read `NOBLECLOAK_SP_CREDENTIALS` from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(`${what} is not valid JSON.`);
  }
}

/**
 * Reads a file. `where` is the caller's description of the file and is the only thing the message
 * carries, so a value that was never a path (inline JSON in the wrong shape) is not echoed. The cause is
 * the fs error code, not the fs error, whose message holds the path.
 */
async function readText(path: string, where: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ServicePrincipalError('credential_unreadable', `Cannot read ${where}.`, {
      cause: typeof code === 'string' ? code : 'unknown',
    });
  }
}

/**
 * Loads a credential from `source`: inline JSON (the text starts with `{`) or the path of a JSON file.
 * Without `source` it reads `NOBLECLOAK_SP_CREDENTIALS`, which holds either. The key is either inline
 * (`private_jwk`) or in a separate JWK file (`key_file`), resolved relative to the credential file;
 * inline JSON may name only an absolute `key_file`. A credential carrying both, or neither, is refused.
 */
export async function loadServicePrincipalCredential(
  source?: string,
  options: LoadOptions = {}
): Promise<ServicePrincipalCredential> {
  // The environment is read only when no source is passed, so a runtime without `process` can pass one.
  const env = options.env ?? (typeof process === 'undefined' ? {} : process.env);
  const text = (source ?? env[CREDENTIAL_ENV] ?? '').trim();
  const origin = source === undefined ? `the path in ${CREDENTIAL_ENV}` : 'the path argument';
  if (text === '') {
    throw new ServicePrincipalError(
      'credential_missing',
      `No service-principal credential: pass a path or JSON, or set ${CREDENTIAL_ENV}.`
    );
  }
  let file: string | undefined;
  let json: string;
  if (text.startsWith('{')) {
    json = text;
  } else {
    // Text that is not a path is never echoed: a quoted .env value or a base64 CI secret holds the key.
    if (/["'\r\n{]/.test(text)) {
      throw invalid(
        `Service-principal credential: ${origin} looks like JSON but does not start with "{" (check for surrounding quotes).`
      );
    }
    file = (await import('node:path')).resolve(text);
    json = await readText(file, `the service-principal credential file named by ${origin}`);
  }
  const raw = parseJson(json, 'The service-principal credential');
  if (!isRecord(raw)) throw invalid('Service-principal credential must be a JSON object.');

  const hasInline = raw.private_jwk !== undefined;
  const keyFile = raw.key_file;
  if (hasInline === (keyFile !== undefined)) {
    throw invalid(
      'Service-principal credential must carry exactly one of private_jwk (inline key) and key_file (path to a JWK file).'
    );
  }
  if (keyFile === undefined) return parseServicePrincipalCredential(raw);
  if (typeof keyFile !== 'string' || keyFile === '') {
    throw invalid('Service-principal credential: key_file must be a path.');
  }
  // node:path is loaded only here and for a credential file, so inline JSON with an inline key needs no Node module.
  const path = await import('node:path');
  if (file === undefined && !path.isAbsolute(keyFile)) {
    throw invalid(
      'Service-principal credential: key_file must be absolute when the credential is inline JSON.'
    );
  }
  const keyPath = file === undefined ? keyFile : path.resolve(path.dirname(file), keyFile);
  const jwk = parseJson(await readText(keyPath, `the key file ${keyPath}`), 'The key file');
  return parseServicePrincipalCredential({ ...raw, key_file: undefined, private_jwk: jwk });
}
