/**
 * Records the exchange for one fresh approval as the fixture the parity test replays
 * (`src/testing/fixtures/approval-status.fixture.json`). It creates the approval as a service principal, so that
 * principal is the creator, then reads the list, the single read and the stream frames for it. It writes
 * the file with ids and tokens scrubbed, and a header with the capture date, the origin and the service version.
 *
 *   NC_BASE_URL=<service base url> NOBLECLOAK_SP_CREDENTIALS=<path to sp.json> NC_APPROVER_TOKEN=<approver token> \
 *     bun tools/capture-hosted-fixtures.ts --tool-ref <a tool that needs approval> \
 *       --agent-id <agent> [--service-version <deployed image tag>] \
 *       [--run-id <external run the creator owns>] [--pending-only] [--out <file>] \
 *       [--internal-host <pattern>]...
 *
 * Environment (the flag of the same meaning, where there is one, wins):
 *   NC_BASE_URL                  the service's base URL (or --base-url)
 *   NOBLECLOAK_SP_CREDENTIALS    the creator's service-principal credential: a path to sp.json, or inline JSON
 *   NC_TOKEN                     instead of the credential: a creator access token, used as it is, never renewed
 *   NC_AUDIENCE                  the token audience; default the base URL's origin
 *   NC_APPROVER_TOKEN            an eligible approver's token, to take the approval on to consumed; required
 *                                unless --pending-only is given (the parity test needs the consumed step)
 *
 * `--agent-id` is required: a service states `agent` on an approval only when the decision names one, and the
 * parity test reads it on every approval. Without `--run-id` the tool creates an external run (`POST /v1/runs`) and
 * names it in the decision, since `run` is stated only then too.
 *
 * The service reports no version, so `--service-version` is whatever the operator names (the deployed image tag);
 * without it the header says `unknown`. Against the local mock, add `--mock-tokens` (it reads the mock's
 * `/__mock/tokens`, and marks the fixture `provisional`).
 *
 * `--internal-host` (repeatable) is a regular expression, matched without regard to case, for a host the fixture
 * must not carry (a deployment's internal domain). A capture whose text matches one is refused and nothing is
 * written, so the operator learns it at capture time rather than from a later check. A hosted capture (not
 * `--mock-tokens`) written without one prints a warning on stderr and still exits 0.
 *
 * The tool names no host, reads no file but the credential the environment points to, and calls only the base URL
 * it is given. It belongs to `packages/react` and is not published (`files` excludes `tools`).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  loadServicePrincipalCredential,
  servicePrincipalTokenSource,
} from '@noblecloak/client/service-principal';

import { CaptureError, captureFixture } from '../src/testing/approval-capture.js';

export const SCRIPT_PATH = 'packages/react/tools/capture-hosted-fixtures.ts';
export const DEFAULT_OUT = fileURLToPath(
  new URL('../src/testing/fixtures/approval-status.fixture.json', import.meta.url)
);

const USAGE =
  'usage: capture-hosted-fixtures --tool-ref <tool> [--base-url <url>] [--service-version <tag>] [--out <file>] [--mock-tokens] [--run-id <id>] --agent-id <id> [--pending-only] [--stream-wait-ms <n>] [--internal-host <pattern>]...';

export interface CaptureIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly stdout: (line: string) => void;
  readonly stderr: (text: string) => void;
}

const present = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/** The command: parses the flags, captures, writes. Returns the exit code. */
export async function main(argv: readonly string[], io: CaptureIo): Promise<number> {
  let values;
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        'base-url': { type: 'string' },
        'tool-ref': { type: 'string' },
        'service-version': { type: 'string' },
        out: { type: 'string' },
        'run-id': { type: 'string' },
        'agent-id': { type: 'string' },
        'pending-only': { type: 'boolean', default: false },
        'stream-wait-ms': { type: 'string' },
        'mock-tokens': { type: 'boolean', default: false },
        'internal-host': { type: 'string', multiple: true },
      },
      strict: true,
    }).values;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : 'bad arguments'}\n${USAGE}\n`);
    return 1;
  }
  const baseUrl = values['base-url'] ?? present(io.env.NC_BASE_URL);
  const toolRef = values['tool-ref'];
  if (baseUrl === undefined || toolRef === undefined) {
    io.stderr(`--tool-ref and a base URL (--base-url or NC_BASE_URL) are required\n${USAGE}\n`);
    return 1;
  }
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    io.stderr(`the base URL must be absolute, got "${baseUrl}"\n${USAGE}\n`);
    return 1;
  }
  const agentId = present(values['agent-id']);
  if (agentId === undefined) {
    io.stderr(
      `--agent-id is required: an approval names an agent only when the decision does\n${USAGE}\n`
    );
    return 1;
  }
  const waitText = values['stream-wait-ms'];
  const streamWaitMs = waitText === undefined ? undefined : Number(waitText);
  if (streamWaitMs !== undefined && !(Number.isInteger(streamWaitMs) && streamWaitMs >= 0)) {
    io.stderr(`--stream-wait-ms is a non-negative integer\n${USAGE}\n`);
    return 1;
  }
  const internalHosts: RegExp[] = [];
  for (const source of values['internal-host'] ?? []) {
    try {
      internalHosts.push(new RegExp(source, 'i'));
    } catch {
      io.stderr(`--internal-host is a regular expression, got "${source}"\n${USAGE}\n`);
      return 1;
    }
  }

  try {
    let creatorToken: () => string | Promise<string>;
    let approverToken = present(io.env.NC_APPROVER_TOKEN);
    if (values['mock-tokens']) {
      const response = await io.fetch(`${baseUrl.replace(/\/+$/, '')}/__mock/tokens`);
      if (!response.ok)
        throw new CaptureError(`/__mock/tokens answered ${String(response.status)}`);
      const minted = (await response.json()) as { creator: string; approver: string };
      creatorToken = () => minted.creator;
      approverToken = minted.approver;
    } else {
      const pasted = present(io.env.NC_TOKEN);
      const credential = present(io.env.NOBLECLOAK_SP_CREDENTIALS);
      if (pasted !== undefined) creatorToken = () => pasted;
      else if (credential !== undefined) {
        const source = servicePrincipalTokenSource(
          await loadServicePrincipalCredential(credential, { env: io.env }),
          { audience: present(io.env.NC_AUDIENCE) ?? origin, fetch: io.fetch }
        );
        creatorToken = source.getToken;
      } else {
        throw new CaptureError(
          'set NOBLECLOAK_SP_CREDENTIALS (a service-principal credential) or NC_TOKEN (a creator access token)'
        );
      }
    }
    const { fixture, warnings } = await captureFixture({
      baseUrl,
      creatorToken,
      ...(approverToken === undefined ? {} : { approverToken }),
      toolRef,
      ...(values['run-id'] === undefined ? {} : { runId: values['run-id'] }),
      agentId,
      pendingOnly: values['pending-only'],
      source: values['mock-tokens'] ? 'mock' : 'hosted',
      ...(values['service-version'] === undefined
        ? {}
        : { serviceVersion: values['service-version'] }),
      ...(streamWaitMs === undefined ? {} : { streamWaitMs }),
      ...(internalHosts.length === 0 ? {} : { internalHosts }),
      fetch: io.fetch,
      script: SCRIPT_PATH,
    });
    const out = resolve(values.out ?? DEFAULT_OUT);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(fixture, null, 2)}\n`);
    for (const warning of warnings) io.stderr(`warning: ${warning}\n`);
    if (internalHosts.length === 0 && !values['mock-tokens']) {
      io.stderr(
        'warning: no --internal-host given, so the capture was not checked for an internal host\n'
      );
    }
    io.stdout(
      JSON.stringify({
        out,
        source: fixture.header.source,
        steps: fixture.steps.map((s) => s.name),
        provisional: fixture.header.provisional === true,
      })
    );
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : 'capture failed'}\n`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    fetch: (input, init) => fetch(input, init),
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  });
}
