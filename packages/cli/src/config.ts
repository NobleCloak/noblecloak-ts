import { stringFlag, type ParsedFlags } from './args.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';

export const AUTH_URL_ENV = 'NOBLECLOAK_AUTH_URL';
export const ADMIN_AUDIENCE_ENV = 'NOBLECLOAK_ADMIN_AUDIENCE';

export interface Config {
  /** The authorization server's issuer, without a trailing slash. */
  readonly authUrl: string;
  /** The origin of `authUrl`: the service-principal routes live here. */
  readonly origin: string;
  readonly adminAudience: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** Throws unless `value` is an https URL, or an http URL on a loopback host. */
export function assertSecureUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(EXIT.usage, `${what} is not a URL.`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new CliError(EXIT.usage, `${what} must be an https URL (http is allowed on loopback).`);
  }
  return url;
}

/** Reads the deployment configuration: the flag, then the environment variable. No defaults. */
export function resolveConfig(flags: ParsedFlags, io: Io): Config {
  const authUrl = stringFlag(flags, 'auth-url') ?? io.env[AUTH_URL_ENV];
  const adminAudience = stringFlag(flags, 'admin-audience') ?? io.env[ADMIN_AUDIENCE_ENV];
  if (authUrl === undefined || authUrl === '') {
    throw new CliError(
      EXIT.usage,
      `Missing the authorization server URL: pass --auth-url or set ${AUTH_URL_ENV}.`
    );
  }
  if (adminAudience === undefined || adminAudience === '') {
    throw new CliError(
      EXIT.usage,
      `Missing the admin API audience: pass --admin-audience or set ${ADMIN_AUDIENCE_ENV}.`
    );
  }
  const url = assertSecureUrl(authUrl, 'The authorization server URL');
  return { authUrl: authUrl.replace(/\/+$/, ''), origin: url.origin, adminAudience };
}
