/**
 * Toolchain currency check. Dependabot moves the dependencies in package.json and the action SHAs
 * in the workflows, but three pins sit where it does not look:
 *
 * - bun, in the root package.json `packageManager` field (setup-bun reads it);
 * - Node, in `.node-version` (setup-node reads it), which should be the newest LTS release;
 * - actionlint, a `docker://` image pinned by digest in ci.yml, with its version as a comment.
 *
 * This script compares each pin with its registry and fails when one lags, so the weekly
 * toolchain-currency workflow turns a stale pin into a red run. A failed lookup also fails the run,
 * with its own message and exit code 2. Run with `bun run check:toolchain`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Pins {
  readonly bun: string;
  readonly node: string;
  readonly actionlint: string;
}

export type Tool = keyof Pins;

export interface Lag {
  readonly tool: Tool;
  readonly pinned: string;
  readonly latest: string;
  readonly where: string;
}

const WHERE: Record<Tool, string> = {
  bun: 'package.json packageManager',
  node: '.node-version',
  actionlint: '.github/workflows/ci.yml actionlint image (digest and version comment)',
};

/** Reads the three pins from the tree. Throws when one cannot be found. */
export function readPins(root: string): Pins {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const bun = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? '')?.[1];
  const node = readFileSync(join(root, '.node-version'), 'utf8').trim();
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const actionlint = /docker:\/\/rhysd\/actionlint@sha256:[0-9a-f]{64} # (\d+\.\d+\.\d+)/.exec(
    ci
  )?.[1];
  if (bun === undefined) throw new Error('package.json packageManager is not bun@x.y.z');
  if (actionlint === undefined) throw new Error('ci.yml has no versioned actionlint image pin');
  return { bun, node, actionlint };
}

/** Every pin that differs from the latest release. */
export function findLags(pins: Pins, latest: Pins): Lag[] {
  return (Object.keys(WHERE) as Tool[])
    .filter((tool) => pins[tool] !== latest[tool])
    .map((tool) => ({ tool, pinned: pins[tool], latest: latest[tool], where: WHERE[tool] }));
}

/** The newest LTS release in nodejs.org's dist index (newest first), without the leading `v`. */
export function newestLts(index: readonly { version: string; lts: string | false }[]): string {
  const release = index.find((entry) => entry.lts !== false);
  if (release === undefined) throw new Error('nodejs.org index lists no LTS release');
  return release.version.replace(/^v/, '');
}

export type FetchJson = (url: string) => Promise<unknown>;

/** A registry lookup failed (network, rate limit, bad answer): not evidence that a pin lags. */
export class LookupError extends Error {
  override readonly name = 'LookupError';
}

/**
 * Request headers for one lookup. api.github.com allows 60 unauthenticated requests an hour per IP,
 * which shared runners exhaust, so a GITHUB_TOKEN in the environment (the workflow passes its
 * read-only github.token) is sent to that host and to no other.
 */
export function requestHeaders(
  url: string,
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = env.GITHUB_TOKEN ?? '';
  if (new URL(url).hostname === 'api.github.com' && token !== '') {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

/** Builds the JSON getter. Every failure, thrown or HTTP, becomes a LookupError. */
export function makeFetchJson(
  fetchImpl: Fetch = fetch,
  env: Readonly<Record<string, string | undefined>> = process.env
): FetchJson {
  return async (url) => {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: requestHeaders(url, env) });
    } catch (error) {
      throw new LookupError(`GET ${url} failed: ${String(error)}`);
    }
    if (!response.ok) throw new LookupError(`GET ${url} failed: ${String(response.status)}`);
    return response.json();
  };
}

const fetchJson: FetchJson = makeFetchJson();

/** Looks up the latest bun, the newest Node LTS and the latest actionlint release. */
export async function fetchLatest(get: FetchJson = fetchJson): Promise<Pins> {
  const [bun, node, actionlint] = await Promise.all([
    get('https://registry.npmjs.org/bun/latest'),
    get('https://nodejs.org/dist/index.json'),
    get('https://api.github.com/repos/rhysd/actionlint/releases/latest'),
  ]);
  return {
    bun: (bun as { version: string }).version,
    node: newestLts(node as { version: string; lts: string | false }[]),
    actionlint: (actionlint as { tag_name: string }).tag_name.replace(/^v/, ''),
  };
}

/**
 * Writes one line per lagging pin. Returns the process exit code: 0 when current, 1 when a pin
 * lags, 2 when a lookup failed, with a message that says it is not a stale pin.
 */
export async function runCheck(
  root: string,
  out: (line: string) => void,
  get: FetchJson = fetchJson
): Promise<number> {
  const pins = readPins(root);
  let latest: Pins;
  try {
    latest = await fetchLatest(get);
  } catch (error) {
    if (!(error instanceof LookupError)) throw error;
    out(
      `::error::toolchain lookup failed, so no pin was checked (not a stale pin): ${error.message}`
    );
    return 2;
  }
  const lags = findLags(pins, latest);
  if (lags.length === 0) {
    out('toolchain: bun, Node LTS and actionlint pins are current');
    return 0;
  }
  for (const lag of lags) {
    out(`::error::${lag.tool} is pinned to ${lag.pinned}; latest is ${lag.latest} (${lag.where})`);
  }
  return 1;
}

if (import.meta.main) {
  process.exit(
    await runCheck(process.cwd(), (line) => {
      console.log(line);
    })
  );
}
