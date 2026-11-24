import { stringFlag, type ParsedFlags } from './args.js';
import { ADMIN_AUDIENCE_ENV, AUTH_URL_ENV, assertSecureUrl } from './config.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import {
  DEPLOYMENT_ENV,
  DEPLOYMENTS,
  isDeployment,
  origin,
  type DeploymentName,
} from './starter-config.js';

export const APP_URL_ENV = 'NOBLECLOAK_APP_URL';

/**
 * The admin API's audience of each deployment: an identifier nothing serves, set as `CORE_ADMIN_API_AUDIENCE` in
 * bianoble-deployments origin/main environments/nc.yaml (`hosts.adminApiAudience`, line 56) and
 * environments/beta.yaml (line 70). `sp` still takes its audience from a flag or variable.
 */
export const ADMIN_AUDIENCES = {
  production: 'https://admin-api.noblecloak.com',
  beta: 'https://admin-api.beta.shared.bianoble.com',
} as const satisfies Record<DeploymentName, string>;

/** The addresses `login` and `setup` need of a deployment. */
export interface LoginHosts {
  /** The authorization server's issuer: where the person signs in, and where Core's REST routes are. */
  readonly authUrl: string;
  /** The origin of `authUrl`: the setup read lives here. */
  readonly origin: string;
  /** The audience of the admin API the sign-in is bound to. */
  readonly adminAudience: string;
  /**
   * The origin of the browser app (the shell): `/cli/signed-in` and `/setup` are served there. Absent for a
   * self-hosted deployment that did not say (`--app-url`): the tab then gets a plain-text answer, and `setup`
   * has nowhere to go.
   */
  readonly appUrl: string | undefined;
}

/**
 * The hosts for `login` and `setup`, with `starter`'s convention: each from its flag, else its variable, else
 * the deployment's default (`--deployment` or ${DEPLOYMENT_ENV}, production when neither is set); an explicit
 * `--deployment` ignores the host variables. A default belongs to the deployment's own authorization server:
 * when `--auth-url` names another one, the admin audience and the app URL are not guessed, so the person
 * gives `--admin-audience` (and `--app-url` for the browser pages).
 */
export function resolveLoginHosts(flags: ParsedFlags, io: Io): LoginHosts {
  const hosts = resolveSetupHosts(flags, io);
  if (hosts.adminAudience === undefined) {
    throw new CliError(
      EXIT.usage,
      `Missing the admin API audience: pass --admin-audience or set ${ADMIN_AUDIENCE_ENV}.`
    );
  }
  return { ...hosts, adminAudience: hosts.adminAudience };
}

/** The hosts of `setup`, which opens a page and only needs the audience to check a saved sign-in against it. */
export type SetupHosts = Omit<LoginHosts, 'adminAudience'> & {
  readonly adminAudience: string | undefined;
};

/** As {@link resolveLoginHosts}, but a self-hosted deployment without `--admin-audience` is not an error. */
export function resolveSetupHosts(flags: ParsedFlags, io: Io): SetupHosts {
  const deploymentFlag = stringFlag(flags, 'deployment');
  const name = deploymentFlag ?? io.env[DEPLOYMENT_ENV] ?? 'production';
  if (!isDeployment(name)) {
    throw new CliError(
      EXIT.usage,
      `Unknown deployment "${name}": use ${Object.keys(DEPLOYMENTS).join(' or ')}.`
    );
  }
  const defaults = DEPLOYMENTS[name];
  const pick = (flag: string, env: string): string | undefined => {
    const value =
      stringFlag(flags, flag) ?? (deploymentFlag === undefined ? io.env[env] : undefined);
    return value === undefined || value === '' ? undefined : value;
  };
  const authUrl = (pick('auth-url', AUTH_URL_ENV) ?? defaults.authUrl).replace(/\/+$/, '');
  const url = assertSecureUrl(authUrl, 'The authorization server URL');
  const isDefault = authUrl === defaults.authUrl;
  const adminAudience =
    pick('admin-audience', ADMIN_AUDIENCE_ENV) ?? (isDefault ? ADMIN_AUDIENCES[name] : undefined);
  const appUrl = pick('app-url', APP_URL_ENV) ?? (isDefault ? defaults.appUrl : undefined);
  return {
    authUrl,
    origin: url.origin,
    adminAudience,
    appUrl: appUrl === undefined ? undefined : origin(appUrl, 'The app URL'),
  };
}
