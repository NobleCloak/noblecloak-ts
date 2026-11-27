import {
  isSpCommand,
  parseCommandFlags,
  parseLoginFlags,
  parseLogoutFlags,
  parseSetupFlags,
  parseStarterFlags,
  boolFlag,
  type SpCommand,
} from './args.js';
import { createCommand, listCommand, revokeCommand, rotateCommand } from './commands.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import { loginCommand } from './login.js';
import { logoutCommand, setupCommand } from './saved-login.js';
import { starterCommand } from './starter.js';
import { terminalSafe } from './terminal.js';

export const USAGE = `noblecloak: sign in, finish setup, manage the service principals of an organisation, and try one out

Usage:
  noblecloak login     [--email <address>] [--deployment production|beta] [--no-open]
  noblecloak setup     [--deployment production|beta] [--no-open]
  noblecloak logout
  noblecloak sp create --org <uuid> --name <name> --audience <url> [--audience <url> ...]
                       [--scope <scope> ...] [--expires-in-days <n>] --out <path>
  noblecloak sp list   --org <uuid>
  noblecloak sp rotate --credentials <path> [--revoke-previous] [--expires-in-days <n>]
  noblecloak sp revoke --org <uuid> --sp <uuid> [--yes]
  noblecloak starter   [--credentials <path>] [--agent <id> | --skip-setup] [--wait <seconds>]
                       [--deployment production|beta]

login signs you in through your browser and says what to do next. setup opens the setup wizard at the first
unfinished step. logout ends the saved sign-in. The sign-in is saved in ~/.noblecloak/cli/auth.json
(NOBLECLOAK_CLI_STATE_DIR replaces the directory). Hosts default to the --deployment (production, else
NOBLECLOAK_DEPLOYMENT); an explicit --deployment ignores the host variables; replace a host with --auth-url,
--admin-audience or --app-url (NOBLECLOAK_AUTH_URL, NOBLECLOAK_ADMIN_AUDIENCE, NOBLECLOAK_APP_URL).
--email only tells the sign-in page which company login to use.

Configuration for the sp commands (a flag wins over the environment; there are no defaults):
  --auth-url <url>          NOBLECLOAK_AUTH_URL        the deployment's authorization server, e.g. https://auth.example.com
  --admin-audience <value>  NOBLECLOAK_ADMIN_AUDIENCE  the audience of the admin API

starter proposes the setup of an agent (you approve it in Approvals), then makes one write to the sandbox (you
decide it in Approvals). It signs in as you for the setup and acts as the service principal in --credentials
(or NOBLECLOAK_SP_CREDENTIALS), which needs the govern and gateway audiences. Its hosts default to the
--deployment (production, else NOBLECLOAK_DEPLOYMENT); an explicit --deployment ignores the host variables;
replace any host with --auth-url, --govern-url, --mcp-url or
--gateway-audience (NOBLECLOAK_AUTH_URL, NOBLECLOAK_GOVERN_URL, NOBLECLOAK_MCP_URL, NOBLECLOAK_GATEWAY_AUDIENCE).
--agent reuses an agent; --skip-setup runs the write only, after a setup you already approved; --wait is how long
to wait for each approval (default 600).

Options for every command:
  --user-token-file <path>  read an access token from a file (mode 600) instead of signing in: an admin-audience
                            token for sp, a govern-audience token for starter
                            (a token that is not freshly issued may expire before the setup wait ends)
  --no-open                 print the sign-in URL without opening a browser
  --json                    print one JSON object on stdout
  -h, --help                show this help

Exit codes: 0 ok, 1 server or unexpected error, 2 input refused, 3 not signed in or interrupted, 4 forbidden.
starter also: 10 no credentials, 11 service principal lacks an audience, 12 sandbox not available, 13 setup
rejected, 14 write denied, 15 nobody decided in time, 16 approval already used.
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
    if (group === 'login' || group === 'setup' || group === 'logout') {
      const parse =
        group === 'login'
          ? parseLoginFlags
          : group === 'setup'
            ? parseSetupFlags
            : parseLogoutFlags;
      const parsed = parse([command, ...rest].filter((a) => a !== undefined));
      if (boolFlag(parsed, 'help')) {
        io.stdout(USAGE);
        return EXIT.ok;
      }
      await (group === 'login' ? loginCommand : group === 'setup' ? setupCommand : logoutCommand)(
        parsed,
        io
      );
      return EXIT.ok;
    }
    if (group === 'starter') {
      const starterFlags = parseStarterFlags([command, ...rest].filter((a) => a !== undefined));
      if (boolFlag(starterFlags, 'help')) {
        io.stdout(USAGE);
        return EXIT.ok;
      }
      await starterCommand(starterFlags, io);
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
