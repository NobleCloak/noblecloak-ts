/**
 * An in-process stand-in for the authorization server and the service-principal routes, plus the
 * "browser" that completes the loopback sign-in. It records every request so tests can assert on what the
 * command line sent, and it holds the values a test must never see in output (the code, the verifier, both
 * tokens).
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const ORG = '11111111-2222-4333-8444-5555555555a5';
export const SP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const ADMIN_AUDIENCE = 'https://admin.example.com';
export const CODE = 'code-0123456789abcdef';
export const ACCESS_TOKEN = 'access-token-0123456789abcdef';
export const REFRESH_TOKEN = 'refresh-token-0123456789abcdef';

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly form: URLSearchParams | undefined;
  readonly json: Record<string, unknown> | undefined;
}

/** What a service-principal route answers instead of its normal success. */
export interface Override {
  readonly status: number;
  readonly body: unknown;
}

export interface Stub {
  readonly url: string;
  readonly requests: Recorded[];
  /** Routes by `"METHOD /path-suffix"`, e.g. `"POST service-principals"`, `"POST rotate"`. */
  readonly overrides: Map<string, Override>;
  /**
   * Requests that are never answered, by `"METHOD key"`: `"GET metadata"`, `"POST token"` (the code
   * exchange) or a service-principal route as in `overrides`. The callback runs when one arrives.
   */
  readonly hangs: Map<string, () => void>;
  /** Service-principal routes, keyed as in `overrides`, whose connection is dropped after the request arrives. */
  readonly resets: Set<string>;
  /** Values for the registration fields; a test sets one to null. */
  registration: { token_endpoint: string | null; assertion_audience: string | null };
  /** Metadata `issuer`; undefined serves the stub's own URL, null omits the member. */
  issuer: string | null | undefined;
  /** Metadata `scopes_supported`; undefined omits the member. */
  scopesSupported: string[] | undefined;
  /** Status the token endpoint answers a code exchange with. */
  tokenStatus: number;
  /** Public JWKs registered through create or rotate, newest last. */
  readonly registered: JsonWebKey[];
  /** The PKCE verifier the command sent at the token endpoint. */
  verifier: string | undefined;
  /** The code challenge the "browser" saw in the authorize URL; the token endpoint checks the verifier against it. */
  challenge: string | undefined;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const decode = (segment: string): Buffer => Buffer.from(segment, 'base64url');

/** Verifies an ES256 client assertion against a public JWK; returns its claims or undefined. */
async function verifyAssertion(
  assertion: string,
  jwk: JsonWebKey
): Promise<Record<string, unknown> | undefined> {
  const [header, payload, signature] = assertion.split('.');
  if (header === undefined || payload === undefined || signature === undefined) return undefined;
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new Uint8Array(decode(signature)),
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return ok ? (JSON.parse(decode(payload).toString('utf8')) as Record<string, unknown>) : undefined;
}

export function principal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SP,
    client_id: `sp_${SP}`,
    org_id: ORG,
    name: 'ci agent',
    allowed_audiences: ['https://govern.example.com'],
    scopes: ['module_api'],
    auth_method: 'private_key_jwt',
    key_thumbprints: ['0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'],
    expires_at: '2027-01-25T00:00:00.000Z',
    revoked_at: null,
    created_at: '2026-10-27T00:00:00.000Z',
    rotated_at: null,
    ...extra,
  };
}

export async function startStub(): Promise<Stub> {
  const requests: Recorded[] = [];
  const registered: JsonWebKey[] = [];
  let url = '';
  const stub: Stub = {
    get url() {
      return url;
    },
    requests,
    overrides: new Map(),
    hangs: new Map(),
    resets: new Set(),
    registration: { token_endpoint: null, assertion_audience: null },
    issuer: undefined,
    scopesSupported: ['module_api', 'service_principals:manage'],
    tokenStatus: 200,
    registered,
    verifier: undefined,
    challenge: undefined,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };

  const registrationBody = (): Record<string, unknown> => ({
    client_id: `sp_${SP}`,
    auth_method: 'private_key_jwt',
    assertion_audience: stub.registration.assertion_audience,
    token_endpoint: stub.registration.token_endpoint,
    grant_type: 'client_credentials',
  });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const text = await readBody(req);
      const path = new URL(req.url ?? '/', 'http://stub').pathname;
      const type = req.headers['content-type'] ?? '';
      const form = type.startsWith('application/x-www-form-urlencoded')
        ? new URLSearchParams(text)
        : undefined;
      const json =
        type.startsWith('application/json') && text !== ''
          ? (JSON.parse(text) as Record<string, unknown>)
          : undefined;
      requests.push({
        method: req.method ?? 'GET',
        path,
        authorization: req.headers.authorization,
        form,
        json,
      });

      const hang = (key: string): boolean => {
        const onArrival = stub.hangs.get(key);
        if (onArrival === undefined) return false;
        onArrival();
        return true;
      };
      if (path === '/.well-known/oauth-authorization-server') {
        if (hang('GET metadata')) return;
        send(res, 200, {
          ...(stub.issuer === null ? {} : { issuer: stub.issuer ?? url }),
          authorization_endpoint: `${url}/auth/oauth/authorize`,
          token_endpoint: `${url}/auth/oauth/token`,
          revocation_endpoint: `${url}/auth/oauth/revoke`,
          ...(stub.scopesSupported === undefined ? {} : { scopes_supported: stub.scopesSupported }),
        });
        return;
      }
      if (path === '/auth/oauth/token' && form !== undefined) {
        if (form.get('grant_type') === 'client_credentials') {
          const jwk = registered.at(-1);
          const claims =
            jwk === undefined
              ? undefined
              : await verifyAssertion(form.get('client_assertion') ?? '', jwk);
          if (claims?.iss !== `sp_${SP}`) {
            send(res, 401, { error: 'invalid_client' });
            return;
          }
          send(res, 200, { access_token: 'sp-access', token_type: 'Bearer', expires_in: 600 });
          return;
        }
        if (hang('POST token')) return;
        stub.verifier = form.get('code_verifier') ?? undefined;
        const challenge = createHash('sha256')
          .update(stub.verifier ?? '')
          .digest('base64url');
        const good =
          form.get('code') === CODE &&
          form.get('client_id') === 'noblecloak-cli' &&
          challenge === stub.challenge;
        if (stub.tokenStatus !== 200 || !good) {
          send(res, stub.tokenStatus === 200 ? 400 : stub.tokenStatus, { error: 'invalid_grant' });
          return;
        }
        send(res, 200, {
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: 'Bearer',
          expires_in: 900,
        });
        return;
      }
      if (path === '/auth/oauth/revoke') {
        res.writeHead(200).end();
        return;
      }

      const route =
        /^\/organizations\/([^/]+)\/service-principals(?:\/([^/]+)\/(rotate|revoke))?$/.exec(path);
      if (route === null) {
        send(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'no route' } });
        return;
      }
      if (
        req.headers.authorization !== `Bearer ${ACCESS_TOKEN}` &&
        req.headers.authorization !== 'Bearer file-token'
      ) {
        send(res, 401, { error: 'invalid_token' });
        return;
      }
      const key = `${req.method ?? 'GET'} ${route[3] ?? 'service-principals'}`;
      if (hang(key)) return;
      if (stub.resets.has(key)) {
        req.socket.destroy();
        return;
      }
      const override = stub.overrides.get(key);
      if (override !== undefined) {
        send(res, override.status, override.body);
        return;
      }
      if (key === 'POST service-principals' || key === 'POST rotate') {
        const jwk = json?.public_jwk as JsonWebKey | undefined;
        if (jwk !== undefined) registered.push(jwk);
        send(res, key === 'POST rotate' ? 200 : 201, {
          success: true,
          data: { ...principal(), registration: registrationBody() },
        });
        return;
      }
      if (key === 'GET service-principals') {
        send(res, 200, { success: true, data: { service_principals: [principal()] } });
        return;
      }
      send(res, 200, {
        success: true,
        data: principal({ revoked_at: '2026-10-27T01:00:00.000Z' }),
      });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  stub.registration = {
    token_endpoint: `${url}/auth/oauth/token`,
    assertion_audience: url,
  };
  return stub;
}
