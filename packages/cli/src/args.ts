import { parseArgs, type ParseArgsConfig } from 'node:util';
import { CliError, EXIT } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Flags every `sp` command accepts. */
const COMMON = {
  'auth-url': { type: 'string' },
  'admin-audience': { type: 'string' },
  'user-token-file': { type: 'string' },
  'no-open': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const OPTIONS = {
  create: {
    ...COMMON,
    org: { type: 'string' },
    name: { type: 'string' },
    audience: { type: 'string', multiple: true },
    scope: { type: 'string', multiple: true },
    'expires-in-days': { type: 'string' },
    out: { type: 'string' },
  },
  list: { ...COMMON, org: { type: 'string' } },
  rotate: {
    ...COMMON,
    credentials: { type: 'string' },
    'revoke-previous': { type: 'boolean' },
    'expires-in-days': { type: 'string' },
  },
  revoke: { ...COMMON, org: { type: 'string' }, sp: { type: 'string' }, yes: { type: 'boolean' } },
} as const;

/** The flags of `noblecloak starter`. */
const STARTER_OPTIONS = {
  credentials: { type: 'string' },
  agent: { type: 'string' },
  'skip-setup': { type: 'boolean' },
  wait: { type: 'string' },
  deployment: { type: 'string' },
  'auth-url': { type: 'string' },
  'govern-url': { type: 'string' },
  'mcp-url': { type: 'string' },
  'gateway-audience': { type: 'string' },
  'user-token-file': { type: 'string' },
  'no-open': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** The hosts every `login` and `setup` flag set shares. */
const HOSTS = {
  deployment: { type: 'string' },
  'auth-url': { type: 'string' },
  'admin-audience': { type: 'string' },
  'app-url': { type: 'string' },
  'no-open': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** The flags of `noblecloak login`. */
const LOGIN_OPTIONS = { ...HOSTS, email: { type: 'string' } } as const;

/** The flags of `noblecloak setup`. */
const SETUP_OPTIONS = HOSTS;

/** The flags of `noblecloak logout`. */
const LOGOUT_OPTIONS = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

export type SpCommand = keyof typeof OPTIONS;

export function isSpCommand(value: string | undefined): value is SpCommand {
  return value !== undefined && Object.hasOwn(OPTIONS, value);
}

/** The flags of one command, as `parseArgs` returns them. */
export type ParsedFlags = Readonly<
  Record<string, string | boolean | (string | boolean)[] | undefined>
>;

export function parseCommandFlags(command: SpCommand, argv: readonly string[]): ParsedFlags {
  return parseFlags(OPTIONS[command], argv);
}

export function parseStarterFlags(argv: readonly string[]): ParsedFlags {
  return parseFlags(STARTER_OPTIONS, argv);
}

export function parseLoginFlags(argv: readonly string[]): ParsedFlags {
  return parseFlags(LOGIN_OPTIONS, argv);
}

export function parseSetupFlags(argv: readonly string[]): ParsedFlags {
  return parseFlags(SETUP_OPTIONS, argv);
}

export function parseLogoutFlags(argv: readonly string[]): ParsedFlags {
  return parseFlags(LOGOUT_OPTIONS, argv);
}

function parseFlags(options: ParseArgsConfig['options'], argv: readonly string[]): ParsedFlags {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options,
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) {
      throw new CliError(EXIT.usage, `Unexpected argument "${positionals[0] ?? ''}".`);
    }
    return values;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(EXIT.usage, error instanceof Error ? error.message : 'Invalid arguments.');
  }
}

export function stringFlag(flags: ParsedFlags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function listFlag(flags: ParsedFlags, name: string): string[] {
  const value = flags[name];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function boolFlag(flags: ParsedFlags, name: string): boolean {
  return flags[name] === true;
}

export function requireString(flags: ParsedFlags, name: string): string {
  const value = stringFlag(flags, name);
  if (value === undefined || value === '') {
    throw new CliError(EXIT.usage, `Missing --${name}.`);
  }
  return value;
}

export function requireUuid(flags: ParsedFlags, name: string): string {
  const value = requireString(flags, name);
  if (!UUID.test(value)) {
    throw new CliError(EXIT.usage, `--${name} must be a UUID.`);
  }
  return value;
}

/** An integer 1..365, or undefined when the flag is absent. */
export function expiryFlag(flags: ParsedFlags): number | undefined {
  const raw = stringFlag(flags, 'expires-in-days');
  if (raw === undefined) return undefined;
  const days = Number(raw);
  if (!/^\d+$/.test(raw) || days < 1 || days > 365) {
    throw new CliError(EXIT.usage, '--expires-in-days must be a whole number from 1 to 365.');
  }
  return days;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
