/** The nc-conform command, as functions: the exit decision is pure, the run takes its output sinks. */
import {
  formatReport,
  formatSkipWarning,
  runConformance,
  unconfiguredSkips,
} from '../conformance/run.js';
import type { Report } from '../conformance/types.js';
import type { JsonObject } from '../spec/load.js';
import { parseConformArgs } from './nc-conform-options.js';

/** Where a command writes. The bin passes the console; a test passes buffers. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/**
 * The exit code of a finished run: 0 only when no scenario failed and none was skipped for lack of
 * configuration (those verified nothing); `allowSkips` accepts the skips, never a failure.
 */
export function conformExitCode(report: Report, allowSkips: boolean): 0 | 1 {
  if (report.failed > 0) return 1;
  return unconfiguredSkips(report).length > 0 && !allowSkips ? 1 : 0;
}

/** Runs nc-conform for `argv` (without the executable and script) and returns the exit code: 0, 1, or 2 for a usage error. */
export async function runConformCli(
  argv: readonly string[],
  io: CliIo,
  /** The document to check against; defaults to the published one. */
  spec?: JsonObject
): Promise<number> {
  let args: ReturnType<typeof parseConformArgs>;
  try {
    args = parseConformArgs(argv);
  } catch (error) {
    io.err(`nc-conform: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  for (const line of args.deprecations) io.err(line);
  const report = await runConformance({
    target: args.target,
    ...(spec === undefined ? {} : { spec }),
  });
  io.out(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
  const warning = formatSkipWarning(report);
  if (warning !== '') io.err(warning);
  const code = conformExitCode(report, args.allowSkips);
  if (code === 1 && report.failed === 0)
    io.err('nc-conform: failing because of the skips above; pass --allow-skips to accept them.');
  return code;
}
