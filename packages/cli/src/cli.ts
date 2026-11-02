import { isSpCommand, parseCommandFlags, boolFlag, type SpCommand } from './args.js';
import { createCommand, listCommand, revokeCommand, rotateCommand } from './commands.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import { terminalSafe } from './terminal.js';

export const USAGE = `noblecloak: manage the service principals of an organisation

Usage:
  noblecloak sp create --org <uuid> --name <name> --audience <url> [--audience <url> ...]
                       [--scope <scope> ...] [--expires-in-days <n>] --out <path>
  noblecloak sp list   --org <uuid>
  noblecloak sp rotate --credentials <path> [--revoke-previous] [--expires-in-days <n>]
  noblecloak sp revoke --org <uuid> --sp <uuid> [--yes]

Configuration (a flag wins over the environment; there are no defaults):
  --auth-url <url>          NOBLECLOAK_AUTH_URL        the deployment's authorization server, e.g. https://auth.example.com
  --admin-audience <value>  NOBLECLOAK_ADMIN_AUDIENCE  the audience of the admin API

Options for every command:
  --user-token-file <path>  read an admin access token from a file (mode 600) instead of signing in
  --no-open                 print the sign-in URL without opening a browser
  --json                    print one JSON object on stdout
  -h, --help                show this help

Exit codes: 0 ok, 1 server or unexpected error, 2 input refused, 3 not signed in or interrupted, 4 forbidden.
`;

const RUN: Record<
  SpCommand,
  (flags: ReturnType<typeof parseCommandFlags>, io: Io) => Promise<void>
> = {
  create: createCommand,
  list: listCommand,
  rotate: rotateCommand,
  revoke: revokeCommand,
};

/** Runs the command line and returns its exit code. Writes only through `io`. */
export async function runCli(argv: readonly string[], rawIo: Io): Promise<number> {
  // Server-supplied text (names, error messages) reaches the terminal only through this.
  const io = terminalSafe(rawIo);
  try {
    const [group, command, ...rest] = argv;
    if (group === undefined || group === '--help' || group === '-h' || group === 'help') {
      io.stdout(USAGE);
      return EXIT.ok;
    }
    if (group !== 'sp') {
      throw new CliError(EXIT.usage, `Unknown command "${group}". Run noblecloak --help.`);
    }
    if (command === undefined || command === '--help' || command === '-h') {
      io.stdout(USAGE);
      return EXIT.ok;
    }
    if (!isSpCommand(command)) {
      throw new CliError(EXIT.usage, `Unknown command "sp ${command}". Run noblecloak --help.`);
    }
    const flags = parseCommandFlags(command, rest);
    if (boolFlag(flags, 'help')) {
      io.stdout(USAGE);
      return EXIT.ok;
    }
    await RUN[command](flags, io);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`error: ${error.message}\n`);
      return error.exitCode;
    }
    io.stderr('error: unexpected failure.\n');
    return EXIT.failed;
  }
}
