/**
 * Registers one public OAuth client (RFC 7591 dynamic client registration) with an authorization server and
 * prints its id. Run once per environment, never on each start: a registration is permanent.
 *
 *   bun tools/register-client.ts --issuer <url> --redirect-uri http://localhost:3000/approvals/callback \
 *     [--client-name "NobleCloak Approvals (local)"]
 *
 * The issuer comes from the flag only. On success the one line on stdout is `{"issuer": ..., "client_id": ...}`
 * and nothing else is written to stdout. On failure the exit code is 1 and the server's problem body goes to
 * stderr. The tool writes no file and never prints the whole response. It belongs to `packages/react` and is
 * not published (`files` excludes `tools`).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { isSecureEndpoint, sameIssuer } from '../src/auth/issuer.js';

export const DEFAULT_CLIENT_NAME = 'NobleCloak Approvals (local)';

export interface RegisterInput {
  readonly issuer: string;
  readonly redirectUri: string;
  readonly clientName: string;
}

export interface RegisterIo {
  readonly fetch: typeof fetch;
  readonly stdout: (line: string) => void;
  readonly stderr: (text: string) => void;
}

/** Thrown for a failure whose text is meant for stderr as it stands. */
export class RegistrationError extends Error {}

const USAGE = 'usage: register-client --issuer <url> --redirect-uri <url> [--client-name <name>]';

async function bodyText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

/** Discovers the registration endpoint from the issuer's metadata and registers the client. */
export async function registerClient(input: RegisterInput, send: typeof fetch): Promise<string> {
  // RFC 8414 section 3.1 form, as in src/auth/browser-auth.ts: the well-known segment precedes the issuer's path.
  if (!isSecureEndpoint(input.issuer)) {
    throw new RegistrationError(
      `the issuer must be an absolute https URL (or http://localhost), got "${input.issuer}"`
    );
  }
  if (!isSecureEndpoint(input.redirectUri)) {
    throw new RegistrationError(
      `the redirect URI must be an absolute https URL (or http://localhost), got "${input.redirectUri}"`
    );
  }
  const issuer = new URL(input.issuer);
  const path = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/$/, '');
  const metadataUrl = `${issuer.origin}/.well-known/oauth-authorization-server${path}`;
  let metadataResponse: Response;
  try {
    metadataResponse = await send(metadataUrl, { headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new RegistrationError(
      `could not reach the issuer: ${error instanceof Error ? error.message : 'network error'}`
    );
  }
  if (!metadataResponse.ok) {
    throw new RegistrationError(
      `metadata request failed (${String(metadataResponse.status)}): ${await bodyText(metadataResponse)}`
    );
  }
  const metadata = (await metadataResponse.json()) as {
    issuer?: unknown;
    registration_endpoint?: unknown;
  };
  // RFC 8414 section 3.3: a document that names another issuer is not the issuer's.
  if (!sameIssuer(metadata.issuer, input.issuer)) {
    throw new RegistrationError('the issuer metadata names a different issuer than --issuer');
  }
  if (typeof metadata.registration_endpoint !== 'string') {
    throw new RegistrationError('the issuer metadata names no registration_endpoint');
  }
  if (!isSecureEndpoint(metadata.registration_endpoint)) {
    throw new RegistrationError(
      'the issuer metadata names a registration_endpoint that is not https (or http://localhost)'
    );
  }
  let response: Response;
  try {
    response = await send(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: input.clientName,
        redirect_uris: [input.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
  } catch (error) {
    throw new RegistrationError(
      `registration request failed: ${error instanceof Error ? error.message : 'network error'}`
    );
  }
  if (!response.ok) throw new RegistrationError(await bodyText(response));
  const registered = (await response.json()) as { client_id?: unknown };
  if (typeof registered.client_id !== 'string' || registered.client_id === '') {
    throw new RegistrationError('the registration response has no client_id');
  }
  return registered.client_id;
}

/** The command: parses the flags, registers, prints. Returns the exit code. */
export async function main(argv: readonly string[], io: RegisterIo): Promise<number> {
  let values: { issuer?: string; 'redirect-uri'?: string; 'client-name'?: string };
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        issuer: { type: 'string' },
        'redirect-uri': { type: 'string' },
        'client-name': { type: 'string' },
      },
      strict: true,
    }).values;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : 'bad arguments'}\n${USAGE}\n`);
    return 1;
  }
  const issuer = values.issuer;
  const redirectUri = values['redirect-uri'];
  if (issuer === undefined || redirectUri === undefined) {
    io.stderr(`--issuer and --redirect-uri are required\n${USAGE}\n`);
    return 1;
  }
  try {
    new URL(issuer);
    new URL(redirectUri);
  } catch {
    io.stderr(`--issuer and --redirect-uri must be absolute URLs\n${USAGE}\n`);
    return 1;
  }
  try {
    const clientId = await registerClient(
      { issuer, redirectUri, clientName: values['client-name'] ?? DEFAULT_CLIENT_NAME },
      io.fetch
    );
    io.stdout(JSON.stringify({ issuer, client_id: clientId }));
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : 'registration failed'}\n`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), {
    fetch: (input, init) => fetch(input, init),
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  });
}
