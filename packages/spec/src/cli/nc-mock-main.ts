/** The nc-mock command, as functions: argument parsing is pure, starting takes its output sinks. */
import { parseArgs } from 'node:util';

import { BREAKS, isBreak } from '../mock/breaks.js';
import { FAMILIES, FLOOR_NAMES, isFamily } from '../spec/families.js';
import type { Break } from '../mock/breaks.js';
import { parseAllowedOrigins } from '../mock/cors.js';
import { startMock } from '../mock/serve.js';
import type { RunningMock } from '../mock/serve.js';
import type { JsonObject } from '../spec/load.js';
import type { CliIo } from './nc-conform-main.js';
import { faceDeprecation } from './nc-conform-options.js';

export interface MockCliArgs {
  readonly port: number;
  readonly deployment: 'hosted' | 'edge';
  readonly breaks: readonly Break[];
  /** Lines to print on stderr about flags that still parse but no longer do anything. */
  readonly deprecations: readonly string[];
  /** The families to serve and advertise; absent: every family the deployment serves. */
  readonly advertise?: readonly string[];
  /** The exact origins a browser may call the mock from (`--allow-origin`, repeatable); none by default. */
  readonly allowedOrigins: readonly string[];
  /** `--approval-arguments-max-bytes`: advertised as `limits.approval_arguments_max_bytes` and enforced. */
  readonly approvalArgumentsMaxBytes?: number;
  /** `--deliveries`: the continuation deliveries served, advertised as `continuation_deliveries`. */
  readonly deliveries?: readonly Delivery[];
  /** `--restrict-tool-registration`: only administrators register or change tools. */
  readonly restrictToolRegistration: boolean;
  /** `--max-body-bytes`: a larger request body is 413 `payload_too_large`. */
  readonly maxBodyBytes?: number;
  /** `--resolutions`: the resolutions the mock can produce, advertised as `resolutions`. */
  readonly resolutions?: readonly string[];
  /** `--approver-surface-client`: the `client_id` of the approver surface; the `approver_surface_token` dev token carries it. */
  readonly approverSurfaceClient?: string;
  /** `--restrict-connection-registration` (rev 11): only administrators register connections, organisation-owned only. */
  readonly restrictConnectionRegistration: boolean;
  /** `--connection-transports` (rev 11): the connection transports served, advertised as `connection_transports`. */
  readonly connectionTransports?: readonly ('mcp' | 'a2a')[];
}

const DELIVERIES = ['push', 'pull', 'held'] as const;
type Delivery = (typeof DELIVERIES)[number];

/** A positive integer flag value, or a usage error naming the flag. */
function positiveInteger(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error(`${flag} is a positive integer, not ${JSON.stringify(value)}`);
  return n;
}

/** Parses `argv`; throws an Error whose message is the usage problem. */
export function parseMockArgs(argv: readonly string[]): MockCliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: 'string', default: '8787' },
      deployment: { type: 'string', default: 'hosted' },
      face: { type: 'string' },
      break: { type: 'string', multiple: true, default: [] },
      advertise: { type: 'string' },
      'allow-origin': { type: 'string', multiple: true, default: [] },
      'approval-arguments-max-bytes': { type: 'string' },
      deliveries: { type: 'string' },
      'restrict-tool-registration': { type: 'boolean', default: false },
      'max-body-bytes': { type: 'string' },
      resolutions: { type: 'string' },
      'approver-surface-client': { type: 'string' },
      'no-runs': { type: 'boolean', default: false },
      'restrict-connection-registration': { type: 'boolean', default: false },
      'connection-transports': { type: 'string' },
    },
  });
  const unknown = values.break.filter((flag) => !isBreak(flag));
  if (unknown.length > 0)
    throw new Error(`unknown --break ${unknown.join(', ')}. Known: ${BREAKS.join(', ')}`);
  if (values.deployment !== 'hosted' && values.deployment !== 'edge')
    throw new Error('--deployment is hosted or edge');
  const deprecations = faceDeprecation('nc-mock', values.face);
  if (values['no-runs'] && values.advertise !== undefined)
    throw new Error('--no-runs and --advertise both say which families to serve; use one');
  const deliveries =
    values.deliveries === undefined
      ? undefined
      : values.deliveries
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '');
  const badDelivery = (deliveries ?? []).filter(
    (name) => !(DELIVERIES as readonly string[]).includes(name)
  );
  if (badDelivery.length > 0 || deliveries?.length === 0)
    throw new Error(
      `--deliveries is a comma-separated list of ${DELIVERIES.join(', ')}, not ${JSON.stringify(values.deliveries)}`
    );
  const resolutions =
    values.resolutions === undefined
      ? undefined
      : values.resolutions
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '');
  if (resolutions?.length === 0)
    throw new Error('--resolutions names at least one resolution (approved, rejected, escalated)');
  const approverSurfaceClient = values['approver-surface-client'];
  if (approverSurfaceClient?.trim() === '')
    throw new Error('--approver-surface-client names a client id, not an empty value');
  const approvalArgumentsMaxBytes = positiveInteger(
    '--approval-arguments-max-bytes',
    values['approval-arguments-max-bytes']
  );
  const maxBodyBytes = positiveInteger('--max-body-bytes', values['max-body-bytes']);
  // `--no-runs`: every family the deployment serves but `runs`, so a run_id has no run to name.
  const advertiseNoRuns = FAMILIES.filter((family) => family !== 'runs');
  const advertise = values['no-runs']
    ? advertiseNoRuns
    : values.advertise === undefined
      ? undefined
      : values.advertise
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '');
  const unknownFamily = (advertise ?? []).filter(
    (name) => !isFamily(name) && !(FLOOR_NAMES as readonly string[]).includes(name)
  );
  if (unknownFamily.length > 0)
    throw new Error(
      `unknown --advertise ${unknownFamily.join(', ')}. Known: ${[...FAMILIES, ...FLOOR_NAMES].join(', ')}`
    );
  let allowedOrigins: readonly string[];
  try {
    allowedOrigins = parseAllowedOrigins(values['allow-origin']);
  } catch (error) {
    throw new Error(`--allow-origin: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const connectionTransports =
    values['connection-transports'] === undefined
      ? undefined
      : values['connection-transports']
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '');
  if (
    connectionTransports !== undefined &&
    (connectionTransports.length === 0 ||
      connectionTransports.some((name) => name !== 'mcp' && name !== 'a2a'))
  )
    throw new Error(
      `--connection-transports is a comma-separated list of mcp, a2a, not ${JSON.stringify(values['connection-transports'])}`
    );
  const port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535)
    throw new Error(`--port is an integer from 0 to 65535, not ${JSON.stringify(values.port)}`);
  return {
    port,
    deployment: values.deployment,
    breaks: values.break as Break[],
    deprecations,
    allowedOrigins,
    restrictToolRegistration: values['restrict-tool-registration'],
    restrictConnectionRegistration: values['restrict-connection-registration'],
    ...(connectionTransports === undefined
      ? {}
      : { connectionTransports: connectionTransports as ('mcp' | 'a2a')[] }),
    ...(advertise === undefined ? {} : { advertise }),
    ...(approvalArgumentsMaxBytes === undefined ? {} : { approvalArgumentsMaxBytes }),
    ...(deliveries === undefined ? {} : { deliveries: deliveries as Delivery[] }),
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    ...(resolutions === undefined ? {} : { resolutions }),
    ...(approverSurfaceClient === undefined ? {} : { approverSurfaceClient }),
  };
}

/** Starts the mock for `argv`. Resolves to the running mock, or to the exit code 2 for a usage error. */
export async function startMockCli(
  argv: readonly string[],
  io: CliIo,
  /** The document to serve; defaults to the published one. */
  spec?: JsonObject
): Promise<{ readonly exit: number } | { readonly mock: RunningMock }> {
  let args: MockCliArgs;
  try {
    args = parseMockArgs(argv);
  } catch (error) {
    io.err(`nc-mock: ${error instanceof Error ? error.message : String(error)}`);
    return { exit: 2 };
  }
  for (const line of args.deprecations) io.err(line);
  const mock = await startMock({
    ...(spec === undefined ? {} : { spec }),
    port: args.port,
    deployment: args.deployment,
    breaks: new Set(args.breaks),
    ...(args.advertise === undefined ? {} : { advertise: args.advertise }),
    allowedOrigins: args.allowedOrigins,
    ...(args.approvalArgumentsMaxBytes === undefined
      ? {}
      : { approvalArgumentsMaxBytes: args.approvalArgumentsMaxBytes }),
    ...(args.deliveries === undefined ? {} : { deliveries: args.deliveries }),
    ...(args.restrictToolRegistration ? { restrictToolRegistration: true } : {}),
    ...(args.restrictConnectionRegistration
      ? {
          connectionRegistration: { owner_kinds: ['org' as const], who: 'administrators' as const },
        }
      : {}),
    ...(args.connectionTransports === undefined
      ? {}
      : { connectionTransports: args.connectionTransports }),
    ...(args.maxBodyBytes === undefined ? {} : { maxBodyBytes: args.maxBodyBytes }),
    ...(args.resolutions === undefined ? {} : { resolutions: args.resolutions }),
    ...(args.approverSurfaceClient === undefined
      ? {}
      : { approverSurfaceClient: args.approverSurfaceClient }),
    control: true,
  });
  io.out(
    JSON.stringify(
      { base_url: mock.baseUrl, deployment: args.deployment, tokens: await mock.tokens() },
      null,
      2
    )
  );
  return { mock };
}
