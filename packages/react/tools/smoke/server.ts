/**
 * The smoke server: a local server on `http://localhost:3000` that serves a Sign-in page and
 * `/approvals/callback` over the `./auth` source, so a person can sign in against a real issuer by hand.
 *
 *   bun tools/smoke/server.ts --issuer <url>
 *
 * The issuer is a flag. The resource and the client id come only from the gitignored `.env.smoke.local` in
 * `packages/react` (`SMOKE_RESOURCE=...`, `SMOKE_CLIENT_ID=...`; placeholders for the format are
 * `https://govern.example.test` and `bnoauth_REPLACE_ME`). No host and no client id is committed. The page
 * script is bundled at start-up with `Bun.build` from the TypeScript source (never from `dist/`, whose bare
 * `import 'react'` a browser cannot resolve). The server is `node:http`; the page decodes the access token
 * locally and sends it nowhere. This tool is not run by the unit tests against any issuer.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const ORIGIN = 'http://localhost:3000';
export const CALLBACK_PATH = '/approvals/callback';
const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_ENTRY = resolve(HERE, 'page.ts');
const ENV_FILE = resolve(HERE, '../../.env.smoke.local');

export interface SmokeConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly resource: string;
  readonly redirectUri: string;
}

/** `KEY=value` lines; blank lines and `#` comments are skipped and one pair of quotes is removed. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    const value = trimmed.slice(at + 1).trim();
    values[trimmed.slice(0, at).trim()] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return values;
}

/** The configuration from the issuer flag and the env file's text; throws with what is missing. */
export function buildConfig(issuer: string | undefined, envText: string): SmokeConfig {
  const env = parseEnv(envText);
  const missing: string[] = [];
  if (issuer === undefined) missing.push('--issuer');
  const clientId = env.SMOKE_CLIENT_ID;
  const resource = env.SMOKE_RESOURCE;
  if (clientId === undefined || clientId === '')
    missing.push('SMOKE_CLIENT_ID in .env.smoke.local');
  if (resource === undefined || resource === '') missing.push('SMOKE_RESOURCE in .env.smoke.local');
  if (
    issuer === undefined ||
    clientId === undefined ||
    resource === undefined ||
    missing.length > 0
  ) {
    throw new Error(`missing configuration: ${missing.join(', ')}`);
  }
  return { issuer, clientId, resource, redirectUri: ORIGIN + CALLBACK_PATH };
}

const escapeJson = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');

/** The one HTML page, served at `/` and at the callback path. The configuration rides in a JSON block. */
export function renderPage(config: SmokeConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NobleCloak sign-in smoke</title>
</head>
<body>
<h1>Sign-in smoke</h1>
<p>State: <strong id="state">loading</strong></p>
<p>
<button type="button" id="sign-in">Sign in</button>
<button type="button" id="refresh">Refresh now</button>
<button type="button" id="reload">Reload</button>
<button type="button" id="sign-out">Sign out</button>
</p>
<p>The access token is decoded in this page and sent nowhere. Sign out ends this app's session only, so the next sign-in may be silent.</p>
<h2>Access token claims</h2>
<pre id="claims"></pre>
<h2>Log</h2>
<pre id="log"></pre>
<script type="application/json" id="smoke-config">${escapeJson(config)}</script>
<script type="module" src="/smoke.js"></script>
</body>
</html>
`;
}

export type Bundler = (entry: string) => Promise<string>;

interface BunBuild {
  build(options: {
    entrypoints: string[];
    target: 'browser';
    format: 'esm';
  }): Promise<{ success: boolean; outputs: { text(): Promise<string> }[] }>;
}

/** Bundles the page script for the browser with `Bun.build`. */
export const bunBundler: Bundler = async (entry) => {
  const bun = (globalThis as unknown as { Bun?: BunBuild }).Bun;
  if (bun === undefined)
    throw new Error('the smoke server bundles the page with Bun.build: run it with bun');
  const result = await bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  const output = result.outputs[0];
  if (!result.success || output === undefined) throw new Error('bundling the smoke page failed');
  return output.text();
};

/** The server: the page at `/` and the callback, the bundled script at `/smoke.js`, 404 elsewhere. */
export async function createSmokeServer(config: SmokeConfig, bundle: Bundler): Promise<Server> {
  const script = await bundle(PAGE_ENTRY);
  const page = renderPage(config);
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', ORIGIN).pathname;
    const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    if (path === '/smoke.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', ...noStore });
      response.end(script);
    } else if (path === '/' || path === '/approvals' || path === CALLBACK_PATH) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noStore });
      response.end(page);
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
  });
}

async function run(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { issuer: { type: 'string' } },
  });
  let envText = '';
  try {
    envText = readFileSync(ENV_FILE, 'utf8');
  } catch {
    // The env file is optional until it is needed: buildConfig reports what is missing.
  }
  const config = buildConfig(values.issuer, envText);
  const server = await createSmokeServer(config, bunBundler);
  server.listen(3000, 'localhost', () => {
    process.stdout.write(`smoke server on ${ORIGIN}\n`);
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'smoke server failed'}\n`);
    process.exitCode = 1;
  });
}
