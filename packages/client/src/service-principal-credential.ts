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

/** A file name's extension: a dot and 1-8 letters or digits at the end, as in `.json`, in any case. */
const EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
/** What a token or a base64 secret looks like: one unbroken run of its alphabet, 16 bytes of base64 or more. */
const TOKEN_SHAPE = /^[A-Za-z0-9+/=_.-]{16,}$/;
/** The characters a token or base64 secret is made of; a file name with any other is not one. */
const TOKEN_ALPHABET = /^[A-Za-z0-9+/=_.-]*$/;
/** Text that is a connection string or a URL with credentials, not a path: `@`, `;`, `://`, or `=` and more. */
const CONNECTION_STRING = /[@;]|:\/\/|=[^=]/;
/**
 * The code point ranges of the C0 and C1 controls, DEL, and the characters that move or reorder text (line
 * and paragraph separators, bidirectional marks). Built from numbers because U+2028 and U+2029 end a line
 * inside a regular expression literal.
 */
const UNPRINTABLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const UNPRINTABLE = new RegExp(
  `[${UNPRINTABLE_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`,
  'gu'
);

/** `text` with every control or reordering character written as a `\uXXXX` escape, so it stays on one line. */
function printable(text: string): string {
  return text.replace(UNPRINTABLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Whether `given`, the text the caller passed as a path, may be echoed as `resolved`. Only text that
 * looks like a path is: a value that was never a path (a base64 CI secret, a token, a raw key, JSON) must
 * not reach a message. It does when its file name has an extension, or it has a path separator and the
 * directory it names exists. Text containing a quote, a brace, a line break, `@`, `;`, `://` or `=` followed
 * by more text never does (JSON, a connection string, a URL with credentials), and neither does text shaped
 * like a token or base64 that has no extension, nor a bare token-alphabet name directly under the
 * filesystem root or the working directory (a short base64 secret with a leading `/` or `./`).
 *
 * Accepted residual: a raw token that itself ends in an extension such as `.json` or `.pem`, and has none
 * of the characters above, is taken for a file name.
 */
async function looksLikePath(given: string, resolved: string): Promise<boolean> {
  if (/["'{}\r\n]/.test(given) || CONNECTION_STRING.test(given)) return false;
  const nodePath = await import('node:path');
  const name = nodePath.basename(resolved);
  if (EXTENSION.test(name)) return true;
  if (TOKEN_SHAPE.test(given)) return false;
  if (!/[\\/]/.test(given)) return false;
  const dir = nodePath.dirname(resolved);
  const cwd = typeof process === 'undefined' ? undefined : process.cwd();
  if ((dir === nodePath.parse(resolved).root || dir === cwd) && TOKEN_ALPHABET.test(name)) {
    return false;
  }
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

const FS_REASONS: Readonly<Record<string, string>> = {
  ENOENT: 'no such file',
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  EISDIR: 'it is a directory, not a file',
  ENOTDIR: 'a parent of that path is not a directory',
  ELOOP: 'too many symbolic links',
  ENAMETOOLONG: 'the path is too long',
  EMFILE: 'too many open files',
};

function reasonFor(code: string): string {
  return FS_REASONS[code] ?? `error ${code}`;
}

/** Levenshtein distance; the names compared are file names, so the quadratic table is small. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next.push(
        Math.min(
          (next[j - 1] ?? 0) + 1,
          (row[j] ?? 0) + 1,
          (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
        )
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

const GENERATED_NAME = /^noblecloak-.*\.json$/;
/** The most directory entries looked at when suggesting a name. */
const MAX_LISTED = 1000;
/** The most edits between a typo and the name it is suggested for. */
const MAX_EDITS = 2;

/** A generated name without its trailing `-<hex>`: the part that identifies the principal. */
function principalPart(name: string): string {
  return name.slice(0, name.lastIndexOf('-'));
}

/**
 * For a missing `noblecloak-*.json` name, the one file in the same directory that is unambiguously the
 * name meant: a file or symlink (not a directory) of the same kind, within {@link MAX_EDITS} edits, and
 * for the same principal (the part before the last `-` is identical), so it never points at another
 * principal's credential. Names only: no file is opened. Any failure to list the directory yields no
 * suggestion, and at most {@link MAX_LISTED} entries are looked at.
 */
async function nearestCredentialName(path: string): Promise<string | undefined> {
  const nodePath = await import('node:path');
  const wanted = nodePath.basename(path);
  if (!GENERATED_NAME.test(wanted)) return undefined;
  const near: { name: string; d: number }[] = [];
  try {
    const { opendir } = await import('node:fs/promises');
    let seen = 0;
    for await (const entry of await opendir(nodePath.dirname(path))) {
      seen += 1;
      if (seen > MAX_LISTED) break;
      const { name } = entry;
      if (name === wanted || !GENERATED_NAME.test(name)) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (principalPart(name) !== principalPart(wanted)) continue;
      const d = distance(wanted, name);
      if (d <= MAX_EDITS) near.push({ name, d });
    }
  } catch {
    return undefined;
  }
  near.sort((x, y) => x.d - y.d);
  const [best, second] = near;
  if (best === undefined || second?.d === best.d) return undefined;
  return best.name;
}

/**
 * Reads a file and, on failure, throws `credential_unreadable` naming `what` and the cause in words. The
 * resolved path is added only when `given`, the text the caller passed, looks like a path
 * ({@link looksLikePath}); control characters in it are escaped. The cause property is the fs error code,
 * not the fs error, whose message holds the path. File contents are never read into a message.
 */
async function readText(
  path: string,
  given: string,
  what: string,
  namedBy?: string
): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const known = typeof code === 'string' ? code : 'unknown';
    const echo = await looksLikePath(given, path);
    const named = echo ? `${what} ${printable(path)}` : what;
    const by = namedBy === undefined ? '' : ` (named by ${namedBy})`;
    const hint = known === 'ENOENT' && echo ? await nearestCredentialName(path) : undefined;
    const tail = hint === undefined ? '' : ` Did you mean ${printable(hint)}?`;
    throw new ServicePrincipalError(
      'credential_unreadable',
      `Cannot read ${named}${by}: ${reasonFor(known)}.${tail}`,
      { cause: known }
    );
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
    // Quoted or multi-line text is refused here without being echoed: a quoted .env value holds the key.
    if (/["'\r\n{]/.test(text)) {
      throw invalid(
        `Service-principal credential: ${origin} looks like JSON but does not start with "{" (check for surrounding quotes).`
      );
    }
    file = (await import('node:path')).resolve(text);
    // A failed read names the path only when `text` looks like one (see looksLikePath): a base64 CI
    // secret or a token has no quote or newline to give it away and must not reach the message.
    json = await readText(file, text, 'the service-principal credential file', origin);
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
  const jwk = parseJson(await readText(keyPath, keyFile, 'the key file'), 'The key file');
  return parseServicePrincipalCredential({ ...raw, key_file: undefined, private_jwk: jwk });
}
