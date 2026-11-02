import { lstat, readFile } from 'node:fs/promises';
import { unlessInterrupted } from './abortable.js';
import { SpApi, type Principal, type Registered } from './api.js';
import {
  boolFlag,
  expiryFlag,
  listFlag,
  requireString,
  requireUuid,
  stringFlag,
  type ParsedFlags,
} from './args.js';
import { resolveConfig, type Config } from './config.js';
import {
  assertDirectoryWritable,
  credentialFromRegistration,
  replaceCredential,
  writeNewCredential,
} from './credential-file.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import { generateKey } from './keys.js';
import { jsonForTerminal, oneLine } from './terminal.js';
import { withSession } from './session.js';

const NEXT_STEP_ENV = 'NOBLECLOAK_SP_CREDENTIALS';

function sessionOptions(flags: ParsedFlags): {
  userTokenFile: string | undefined;
  open: boolean;
} {
  return { userTokenFile: stringFlag(flags, 'user-token-file'), open: !boolFlag(flags, 'no-open') };
}

function emitJson(io: Io, value: unknown): void {
  io.stdout(`${jsonForTerminal(value)}\n`);
}

const revokeHint = (orgId: string, spId: string): string =>
  `noblecloak sp revoke --org ${orgId} --sp ${spId}`;

/** Throws a usage error unless `path` is free: it exists (any kind of entry), or it cannot be examined. */
async function assertOutFree(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw new CliError(EXIT.usage, `--out ${path} cannot be examined (${code ?? 'error'}).`);
  }
  throw new CliError(EXIT.usage, `--out ${path} already exists; choose a path that does not.`);
}

/**
 * The principal exists on the server but no usable file could be written. Say so, with the command that
 * retires it. Exit 1: the server side succeeded, the local side did not.
 */
function orphaned(orgId: string, spId: string, reason: string): CliError {
  return new CliError(
    EXIT.failed,
    `${reason} The service principal ${spId} was created and has no credential file: revoke it with\n  ${revokeHint(orgId, spId)}`
  );
}

export async function createCommand(flags: ParsedFlags, io: Io): Promise<void> {
  const orgId = requireUuid(flags, 'org');
  const name = requireString(flags, 'name').trim();
  if (name.length < 1 || name.length > 255) {
    throw new CliError(EXIT.usage, '--name must be 1 to 255 characters.');
  }
  const audiences = listFlag(flags, 'audience');
  if (audiences.length < 1 || audiences.length > 10) {
    throw new CliError(EXIT.usage, 'Pass --audience 1 to 10 times.');
  }
  const scopes = listFlag(flags, 'scope');
  if (scopes.length > 10) throw new CliError(EXIT.usage, 'Pass --scope at most 10 times.');
  const expiresInDays = expiryFlag(flags);
  const out = requireString(flags, 'out');
  const config = resolveConfig(flags, io);
  await assertOutFree(out);
  await assertDirectoryWritable(out, '--out');

  const key = await generateKey();
  const registered = await withSession(io, config, sessionOptions(flags), (token) =>
    new SpApi(io, config, token).create(
      orgId,
      {
        name,
        allowed_audiences: audiences,
        ...(scopes.length === 0 ? {} : { scopes }),
        public_jwk: key.publicJwk,
        ...(expiresInDays === undefined ? {} : { expires_in_days: expiresInDays }),
      },
      ` If a new "${name}" is listed, it was created and has no credential file (${out} was not written): revoke it with\n  ${revokeHint(orgId, '<its id>')}`
    )
  );

  const { principal } = registered;
  const credential = credentialFromRegistration(registered, key.privateJwk);
  if (credential === undefined) {
    throw orphaned(
      orgId,
      principal.id,
      'The server did not return a token endpoint or an assertion audience (its issuer is unset), so no credential file was written.'
    );
  }
  try {
    await writeNewCredential(out, credential);
  } catch (error) {
    const detail =
      error instanceof CliError
        ? error.message
        : `The credential file could not be written (${(error as NodeJS.ErrnoException).code ?? 'error'}).`;
    throw orphaned(orgId, principal.id, detail);
  }

  if (boolFlag(flags, 'json')) {
    emitJson(io, {
      client_id: principal.client_id,
      sp_id: principal.id,
      org_id: principal.org_id,
      name: principal.name,
      audiences: principal.allowed_audiences,
      scopes: principal.scopes,
      expires_at: principal.expires_at,
      path: out,
    });
    return;
  }
  io.stdout(
    [
      `Created service principal "${principal.name}".`,
      `  client_id  ${principal.client_id}`,
      `  sp_id      ${principal.id}`,
      `  expires_at ${principal.expires_at}`,
      `  credential ${out} (mode 0600; never commit it)`,
      '',
      'Next step:',
      `  export ${NEXT_STEP_ENV}=${out}`,
      '',
    ].join('\n')
  );
}

const short = (thumbprint: string): string => thumbprint.slice(0, 8);

function table(rows: readonly (readonly string[])[]): string {
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}

export async function listCommand(flags: ParsedFlags, io: Io): Promise<void> {
  const orgId = requireUuid(flags, 'org');
  const config = resolveConfig(flags, io);
  const principals = await withSession(io, config, sessionOptions(flags), (token) =>
    new SpApi(io, config, token).list(orgId)
  );
  if (boolFlag(flags, 'json')) {
    emitJson(io, { service_principals: principals });
    return;
  }
  if (principals.length === 0) {
    io.stdout('No service principals.\n');
    return;
  }
  const header = [
    'ID',
    'CLIENT_ID',
    'NAME',
    'AUDIENCES',
    'SCOPES',
    'EXPIRES_AT',
    'REVOKED',
    'KEYS',
  ];
  const rows = principals.map((p) =>
    [
      p.id,
      p.client_id,
      p.name,
      p.allowed_audiences.join(','),
      p.scopes.join(','),
      p.expires_at,
      p.revoked_at ?? 'no',
      p.key_thumbprints.map(short).join(','),
    ].map(oneLine)
  );
  io.stdout(`${table([header, ...rows])}\n`);
}

type Json = Record<string, unknown>;

async function readCredentialFile(path: string): Promise<Json> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new CliError(EXIT.usage, `--credentials ${path} cannot be read.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(EXIT.usage, `--credentials ${path} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(EXIT.usage, `--credentials ${path} is not a JSON object.`);
  }
  return parsed as Json;
}

export async function rotateCommand(flags: ParsedFlags, io: Io): Promise<void> {
  const path = requireString(flags, 'credentials');
  const expiresInDays = expiryFlag(flags);
  const revokePrevious = boolFlag(flags, 'revoke-previous');
  const config = resolveConfig(flags, io);
  const current = await readCredentialFile(path);
  await assertDirectoryWritable(path, '--credentials');
  const orgId = current.org_id;
  const spId = current.sp_id;
  if (typeof orgId !== 'string' || typeof spId !== 'string') {
    throw new CliError(
      EXIT.usage,
      `--credentials ${path} has no org_id or sp_id; only a file written by "noblecloak sp create" can be rotated.`
    );
  }
  requireUuidValue(orgId, 'org_id');
  requireUuidValue(spId, 'sp_id');
  if (current.key_file !== undefined) {
    throw new CliError(
      EXIT.usage,
      `--credentials ${path} names its key with key_file; sp rotate writes the new key inline. Move the key file's JWK into private_jwk, remove key_file, then rotate.`
    );
  }

  const key = await generateKey();
  const registered = await withSession(io, config, sessionOptions(flags), (token) =>
    new SpApi(io, config, token).rotate(
      orgId,
      spId,
      {
        public_jwk: key.publicJwk,
        ...(revokePrevious ? { revoke_previous: true as const } : {}),
        ...(expiresInDays === undefined ? {} : { expires_in_days: expiresInDays }),
      },
      revokePrevious
        ? ` ${path} was not changed. If the rotation was applied, the key in it was retired (its private_jwk kid is no longer among the key_thumbprints that sp list --json shows), so the service principal has no usable key: revoke it with\n  ${revokeHint(orgId, spId)}\nand create a new one.`
        : ` ${path} was not changed, and its key still works either way.`
    )
  );

  const updated = rotatedCredential(current, registered, key.privateJwk);
  if (updated === undefined) {
    throw rotationNotSaved(
      path,
      revokePrevious,
      orgId,
      spId,
      'it returned no token endpoint or assertion audience (its issuer is unset)'
    );
  }
  try {
    await replaceCredential(path, updated);
  } catch (error) {
    const detail =
      error instanceof CliError
        ? error.message
        : `the file could not be replaced (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
    throw rotationNotSaved(path, revokePrevious, orgId, spId, detail);
  }
  const { principal } = registered;
  if (boolFlag(flags, 'json')) {
    emitJson(io, {
      client_id: principal.client_id,
      sp_id: principal.id,
      org_id: principal.org_id,
      expires_at: principal.expires_at,
      revoked_previous: revokePrevious,
      path,
    });
    return;
  }
  io.stdout(
    [
      `Rotated the key of "${principal.name}" (${principal.client_id}).`,
      `  credential ${path} replaced (mode 0600)`,
      `  expires_at ${principal.expires_at}`,
      revokePrevious
        ? '  The previous keys were retired.'
        : '  The previous key stays valid until you revoke it; rotate with --revoke-previous to retire it.',
      '',
    ].join('\n')
  );
}

/**
 * The server accepted the rotation but the new file could not be written, so the new private key is gone.
 * Without --revoke-previous the old key still works and the file is unchanged: rotate again. With it, the
 * server already retired the keys the file holds, so rotating again fails and the principal is unusable.
 */
function rotationNotSaved(
  path: string,
  revokePrevious: boolean,
  orgId: string,
  spId: string,
  detail: string
): CliError {
  if (revokePrevious) {
    return new CliError(
      EXIT.failed,
      `The server rotated the key and retired the previous keys, but ${detail}. ${path} still holds a retired key and the new key was discarded, so the service principal has no usable key: revoke it with\n  ${revokeHint(orgId, spId)}\nand create a new one.`
    );
  }
  return new CliError(
    EXIT.failed,
    `The server rotated the key, but ${detail}. ${path} was left unchanged and still works; the new key was discarded. Run the rotation again.`
  );
}

function requireUuidValue(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new CliError(EXIT.usage, `The credential file's ${field} is not a UUID.`);
  }
}

function rotatedCredential(
  current: Json,
  registered: Registered,
  privateJwk: unknown
): Json | undefined {
  const { principal, registration } = registered;
  if (registration.token_endpoint === null || registration.assertion_audience === null) {
    return undefined;
  }
  return {
    ...current,
    client_id: registration.client_id,
    token_endpoint: registration.token_endpoint,
    assertion_audience: registration.assertion_audience,
    private_jwk: privateJwk,
    audiences: principal.allowed_audiences,
    scopes: principal.scopes,
    expires_at: principal.expires_at,
  };
}

async function confirm(io: Io, principal: Principal | undefined, orgId: string, spId: string) {
  const subject =
    principal === undefined
      ? spId
      : `"${oneLine(principal.name)}" (${oneLine(principal.client_id)})`;
  const answer = await unlessInterrupted(
    io,
    io.readLine(`Revoke service principal ${subject} in organisation ${orgId}? [y/N] `),
    'The service principal was not revoked.'
  );
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CliError(EXIT.usage, 'Not revoked.');
  }
}

export async function revokeCommand(flags: ParsedFlags, io: Io): Promise<void> {
  const orgId = requireUuid(flags, 'org');
  const spId = requireUuid(flags, 'sp');
  const yes = boolFlag(flags, 'yes');
  if (!yes && !io.stdinIsTTY) {
    throw new CliError(
      EXIT.usage,
      'Refusing to revoke without a terminal to confirm on; pass --yes.'
    );
  }
  const config = resolveConfig(flags, io);
  await withSession(io, config, sessionOptions(flags), async (token) => {
    const api = new SpApi(io, config, token);
    if (!yes) {
      const found = (await api.list(orgId)).find((p) => p.id === spId);
      if (found === undefined) {
        throw new CliError(EXIT.failed, `No service principal ${spId} in organisation ${orgId}.`);
      }
      await confirm(io, found, orgId, spId);
    }
    await api.revoke(orgId, spId);
  });
  if (boolFlag(flags, 'json')) {
    emitJson(io, { revoked: true, sp_id: spId, org_id: orgId });
    return;
  }
  io.stdout(
    [
      `Revoked service principal ${spId}.`,
      'Its next token request fails; an access token already issued works until it expires (at most 15 minutes).',
      'Delete the local credential file: this command does not touch it.',
      '',
    ].join('\n')
  );
}

export type { Config };
