/**
 * An in-process stand-in for the authorization server and Core's setup read, and the "browser" that completes
 * the loopback sign-in, for the `login`, `setup` and `logout` tests. It records what the command sent and
 * what the loopback answered the browser, and holds the values a test must never see in output or in a URL.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import type { Io } from './io.js';

export const ORG = '11111111-2222-4333-8444-5555555555a5';
export const ADMIN_AUDIENCE = 'https://admin.example.test';
export const APP_URL = 'https://app.example.test';
export const CODE = 'code-0123456789abcdef';
export const REFRESH_TOKEN = 'refresh-token-0123456789abcdef';
export const REFRESHED_TOKEN = 'refresh-token-rotated-0123456789';
export const EMAIL = 'maria@fernhill.example';

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsigned JWT with the claims of the CLI's admin-audience token. */
export function accessToken(claims: Record<string, unknown> = {}, tag = 'one'): string {
  return `${b64({ alg: 'none' })}.${b64({ sub: 'user-sub-1', org_id: ORG, scope: 'setup:read', tag, ...claims })}.sig`;
}

/** The setup read's `data` for an org with every screen left. */
export function freshSetup(over: Record<string, unknown> = {}): Record<string, unknown> {
  const keys = [
    'admin',
    'company',
    'github',
    'sso',
    'discover',
    'tools',
    'people',
    'policy',
    'ai_client',
    'automation',
    'first_tool',
  ];
  return {
    steps: keys.map((key) => ({
      key,
      state: 'todo',
      availability: key === 'discover' ? 'coming_soon' : key === 'sso' ? 'assisted' : 'live',
    })),
    intent: 'solo',
    fork: null,
    dismissed: false,
    app_authorized: { done: false },
    setup_proposal_approved: { done: false },
    held_action_decided: { done: false },
    ...over,
  };
}

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly form: URLSearchParams | undefined;
}

export interface LoginStub {
  readonly url: string;
  readonly requests: Recorded[];
  /** What the setup read answers: a status and a body (default 200 and `freshSetup()` in an envelope). */
  setup: { status: number; body: unknown };
  /** The access token the code grant issues. */
  issued: string;
  /** Seconds the issued token lives. */
  expiresIn: number;
  /** Refresh grant: the status it answers (200 issues REFRESHED_TOKEN and a new access token). */
  refreshStatus: number;
  /** The `error` and `error_description` of a refused refresh (default: invalid_grant, revoked). */
  refreshError: string;
  refreshDescription: string;
  /** Core's rotation rule: single-use refresh tokens, and a replay revokes the family. Overrides `refreshStatus`. */
  strictRotation: boolean;
  validRefresh: Set<string>;
  familyRevoked: boolean;
  rotations: number;
  /** Milliseconds a refresh takes, to make two concurrent commands overlap. */
  refreshDelayMs: number;
  /** Runs when a refresh arrives, before it is answered. */
  onRefresh: (() => Promise<void>) | undefined;
  /** Whether the token response carries a refresh token. */
  issueRefresh: boolean;
  /** The code challenge the "browser" saw. */
  challenge: string | undefined;
  /** The scopes the metadata advertises; undefined omits the member. */
  scopesSupported: string[] | undefined;
  /** The authorize URLs the command opened or printed. */
  readonly authorizeUrls: URL[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startLoginStub(): Promise<LoginStub> {
  const requests: Recorded[] = [];
  let url = '';
  const stub: LoginStub = {
    get url() {
      return url;
    },
    requests,
    setup: { status: 200, body: { success: true, data: freshSetup() } },
    issued: accessToken(),
    expiresIn: 900,
    refreshStatus: 200,
    refreshError: 'invalid_grant',
    refreshDescription: 'refresh token has been revoked',
    strictRotation: false,
    validRefresh: new Set([REFRESH_TOKEN]),
    familyRevoked: false,
    rotations: 0,
    refreshDelayMs: 0,
    onRefresh: undefined,
    issueRefresh: true,
    challenge: undefined,
    scopesSupported: ['mcp', 'service_principals:manage', 'setup:read'],
    authorizeUrls: [],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const text = await readBody(req);
      const path = new URL(req.url ?? '/', 'http://stub').pathname;
      const form = (req.headers['content-type'] ?? '').startsWith(
        'application/x-www-form-urlencoded'
      )
        ? new URLSearchParams(text)
        : undefined;
      requests.push({
        method: req.method ?? 'GET',
        path,
        authorization: req.headers.authorization,
        form,
      });
      if (path === '/.well-known/oauth-authorization-server') {
        send(res, 200, {
          issuer: url,
          authorization_endpoint: `${url}/auth/oauth/authorize`,
          token_endpoint: `${url}/auth/oauth/token`,
          revocation_endpoint: `${url}/auth/oauth/revoke`,
          ...(stub.scopesSupported === undefined ? {} : { scopes_supported: stub.scopesSupported }),
        });
        return;
      }
      if (path === '/auth/oauth/token' && form !== undefined) {
        if (form.get('grant_type') === 'refresh_token') {
          if (stub.onRefresh !== undefined) await stub.onRefresh();
          if (stub.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, stub.refreshDelayMs));
          if (stub.strictRotation) {
            // Core's rule: a refresh token works once; presenting a spent one revokes the whole family.
            const presented = form.get('refresh_token') ?? '';
            if (stub.familyRevoked || !stub.validRefresh.has(presented)) {
              const replay = !stub.familyRevoked;
              stub.familyRevoked = true;
              send(res, 400, {
                error: 'invalid_grant',
                error_description: replay
                  ? 'refresh token has already been used'
                  : 'refresh token has been revoked',
              });
              return;
            }
            stub.validRefresh.delete(presented);
            const next = `rotated-${String(++stub.rotations)}`;
            stub.validRefresh.add(next);
            send(res, 200, {
              access_token: accessToken({}, `refreshed-${String(stub.rotations)}`),
              refresh_token: next,
              token_type: 'Bearer',
              expires_in: 900,
              scope: 'setup:read',
            });
            return;
          }
          if (stub.refreshStatus !== 200) {
            send(res, stub.refreshStatus, {
              error: stub.refreshError,
              error_description: stub.refreshDescription,
            });
            return;
          }
          send(res, 200, {
            access_token: accessToken({}, 'refreshed'),
            refresh_token: REFRESHED_TOKEN,
            token_type: 'Bearer',
            expires_in: 900,
            scope: 'setup:read',
          });
          return;
        }
        const verifier = form.get('code_verifier') ?? '';
        const good =
          form.get('code') === CODE &&
          form.get('client_id') === 'noblecloak-cli' &&
          createHash('sha256').update(verifier).digest('base64url') === stub.challenge;
        if (!good) {
          send(res, 400, { error: 'invalid_grant' });
          return;
        }
        send(res, 200, {
          access_token: stub.issued,
          ...(stub.issueRefresh ? { refresh_token: REFRESH_TOKEN } : {}),
          token_type: 'Bearer',
          expires_in: stub.expiresIn,
          scope: 'setup:read',
        });
        return;
      }
      if (path === '/auth/oauth/revoke') {
        res.writeHead(200).end();
        return;
      }
      if (/^\/organizations\/[^/]+\/setup$/.test(path) && req.method === 'GET') {
        if (req.headers.authorization === undefined) {
          send(res, 401, { error: 'invalid_token' });
          return;
        }
        send(res, stub.setup.status, stub.setup.body);
        return;
      }
      send(res, 404, { error: 'no route' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return stub;
}

/** What the loopback answered the stand-in browser. */
export interface Answered {
  readonly status: number;
  readonly location: string | null;
  readonly contentType: string | null;
  readonly body: string;
}

export interface LoginRunOptions {
  /** What the browser does with the authorize URL. Default: complete the sign-in with a good code. */
  browser?: (authorize: URL, stub: LoginStub) => Promise<Answered | undefined>;
  env?: Record<string, string | undefined>;
  signInTimeoutMs?: number;
  openUrlThrows?: boolean;
  lockStaleMs?: number;
  lockWaitMs?: number;
  /** Drive the browser from the URL printed on stderr instead of from `openUrl`. */
  printedUrlOnly?: boolean;
  signal?: AbortSignal;
}

export interface LoginRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly opened: URL[];
  /** Every URL handed to `openUrl`, the authorize URL and a page alike. */
  readonly launched: string[];
  /** What the loopback answered, per browser visit. */
  readonly answers: Answered[];
  readonly stateDir: string;
}

/** Visits the loopback redirect URI without following redirects, so the test sees the loopback's own answer. */
export async function visit(
  authorize: URL,
  extra: Record<string, string>,
  stateParam?: string
): Promise<Answered> {
  const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
  for (const [k, v] of Object.entries(extra)) redirect.searchParams.set(k, v);
  redirect.searchParams.set('state', stateParam ?? authorize.searchParams.get('state') ?? '');
  const response = await fetch(redirect, { redirect: 'manual' });
  return {
    status: response.status,
    location: response.headers.get('location'),
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  };
}

export async function goodSignIn(authorize: URL, stub: LoginStub): Promise<Answered> {
  stub.challenge = authorize.searchParams.get('code_challenge') ?? undefined;
  return visit(authorize, { code: CODE });
}

/** Makes a state directory that the test removes with `cleanState`. */
export async function makeStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'nc-login-'));
}

export async function cleanState(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** The flags that point a command at the stub. */
export function hostFlags(stub: LoginStub): string[] {
  return ['--auth-url', stub.url, '--admin-audience', ADMIN_AUDIENCE, '--app-url', APP_URL];
}

/** Runs the command line against the stub with captured output and a private state directory. */
export async function runLogin(
  stub: LoginStub,
  argv: string[],
  stateDir: string,
  options: LoginRunOptions = {}
): Promise<LoginRun> {
  let stdout = '';
  let stderr = '';
  const opened: URL[] = [];
  const launched: string[] = [];
  const answers: Answered[] = [];
  const pending: Promise<void>[] = [];
  const browser = options.browser ?? goodSignIn;
  const drive = (href: string): void => {
    const url = new URL(href);
    if (!url.pathname.endsWith('/authorize')) return;
    opened.push(url);
    stub.authorizeUrls.push(url);
    pending.push(
      browser(url, stub).then((a) => {
        if (a !== undefined) answers.push(a);
      })
    );
  };
  const io: Io = {
    env: { NOBLECLOAK_CLI_STATE_DIR: stateDir, ...options.env },
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
      // The `--no-open` path: the URL is on a line of its own, and the person opens it.
      if (options.printedUrlOnly === true) {
        const line = t.split('\n').find((l) => l.startsWith('http'));
        if (line !== undefined) drive(line);
      }
    },
    fetch: (input, init) => fetch(input, init),
    openUrl: (href) => {
      launched.push(href);
      if (options.openUrlThrows === true) throw new Error('no opener');
      if (options.printedUrlOnly !== true) drive(href);
    },
    stdinIsTTY: false,
    readLine: () => Promise.resolve(''),
    platform: process.platform,
    signInTimeoutMs: options.signInTimeoutMs ?? 5_000,
    ...(options.lockStaleMs === undefined ? {} : { lockStaleMs: options.lockStaleMs }),
    ...(options.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs }),
    signal: options.signal ?? new AbortController().signal,
  };
  const code = await runCli(argv, io);
  await Promise.allSettled(pending);
  return { code, stdout, stderr, opened, launched, answers, stateDir };
}
