import { randomBytes } from 'node:crypto';
import { access, constants, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseServicePrincipalCredential } from '@noblecloak/client/service-principal';
import type { Registered } from './api.js';
import { CliError, EXIT } from './errors.js';
import type { PrivateJwk } from './keys.js';

/** The credential file: the fields the SDK loader reads, plus the ones `rotate` and the reader need. */
export interface CredentialFile {
  readonly client_id: string;
  readonly token_endpoint: string;
  readonly assertion_audience: string;
  readonly private_jwk: PrivateJwk;
  readonly org_id: string;
  readonly sp_id: string;
  readonly name: string;
  readonly audiences: readonly string[];
  readonly scopes: readonly string[];
  readonly expires_at: string;
}

/**
 * Builds the file from a registration, or returns undefined when the server left `token_endpoint` or
 * `assertion_audience` null (its issuer is unset): such a file would not load.
 */
export function credentialFromRegistration(
  registered: Registered,
  privateJwk: PrivateJwk
): CredentialFile | undefined {
  const { principal, registration } = registered;
  if (registration.token_endpoint === null || registration.assertion_audience === null) {
    return undefined;
  }
  return {
    client_id: registration.client_id,
    token_endpoint: registration.token_endpoint,
    assertion_audience: registration.assertion_audience,
    private_jwk: privateJwk,
    org_id: principal.org_id,
    sp_id: principal.id,
    name: principal.name,
    audiences: principal.allowed_audiences,
    scopes: principal.scopes,
    expires_at: principal.expires_at,
  };
}

/**
 * Throws unless the SDK loader accepts the file, so the CLI never writes one the SDK would refuse: the
 * loader's parser, plus its rule that a file carries exactly one of `private_jwk` and `key_file` (every file
 * the CLI writes has `private_jwk`, so a `key_file` is refused).
 */
export function assertLoadable(credential: object): void {
  if ((credential as Record<string, unknown>).key_file !== undefined) {
    throw new CliError(
      EXIT.failed,
      'The credential file would carry both private_jwk and key_file; the SDK loader needs exactly one of private_jwk and key_file.'
    );
  }
  try {
    parseServicePrincipalCredential(credential);
  } catch (error) {
    // The loader's message names a field, never a value.
    throw new CliError(
      EXIT.failed,
      error instanceof Error ? error.message : 'The credential file would not load.'
    );
  }
}

/**
 * Throws a usage error unless the directory that will hold `path` exists and its owner can write to it.
 * Called before any server call, so a bad path never costs a principal or a key.
 */
export async function assertDirectoryWritable(path: string, flag: string): Promise<void> {
  const directory = dirname(path);
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(directory)).isDirectory();
  } catch (error) {
    throw new CliError(
      EXIT.usage,
      `${flag} ${path}: its directory cannot be examined (${(error as NodeJS.ErrnoException).code ?? 'error'}).`
    );
  }
  if (!isDirectory) {
    throw new CliError(EXIT.usage, `${flag} ${path}: ${directory} is not a directory.`);
  }
  try {
    await access(directory, constants.W_OK);
  } catch {
    throw new CliError(EXIT.usage, `${flag} ${path}: ${directory} is not writable.`);
  }
}

const serialize = (credential: object): string => `${JSON.stringify(credential, null, 2)}\n`;

/**
 * Writes the file with mode 0600, failing if it exists (exclusive create). If the write fails after the
 * file was created, the partial file is removed (best effort), so a retry with the same path is not
 * refused and no truncated key is left behind.
 */
export async function writeNewCredential(path: string, credential: object): Promise<void> {
  assertLoadable(credential);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(serialize(credential));
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Replaces the file atomically: writes a 0600 temp file beside it, then renames it over the original.
 * The original is untouched if the write fails.
 */
export async function replaceCredential(path: string, credential: object): Promise<void> {
  assertLoadable(credential);
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(serialize(credential));
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
