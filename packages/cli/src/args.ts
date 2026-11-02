import { parseArgs } from 'node:util';
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

export type SpCommand = keyof typeof OPTIONS;

export function isSpCommand(value: string | undefined): value is SpCommand {
  return value !== undefined && Object.hasOwn(OPTIONS, value);
}

/** The flags of one command, as `parseArgs` returns them. */
export type ParsedFlags = Readonly<
  Record<string, string | boolean | (string | boolean)[] | undefined>
>;

export function parseCommandFlags(command: SpCommand, argv: readonly string[]): ParsedFlags {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS[command],
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) {
      throw new CliError(EXIT.usage, `Unexpected argument "${positionals[0] ?? ''}".`);
    }
    return values as ParsedFlags;
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
