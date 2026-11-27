import { stringFlag, type ParsedFlags } from './args.js';
import { AUTH_URL_ENV, assertSecureUrl } from './config.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';

export const DEPLOYMENT_ENV = 'NOBLECLOAK_DEPLOYMENT';
export const GOVERN_URL_ENV = 'NOBLECLOAK_GOVERN_URL';
export const MCP_URL_ENV = 'NOBLECLOAK_MCP_URL';
export const GATEWAY_AUDIENCE_ENV = 'NOBLECLOAK_GATEWAY_AUDIENCE';

/** The addresses `starter` needs of a deployment. */
export interface StarterHosts {
  /** The authorization server's issuer: where the person signs in. */
  readonly authUrl: string;
  /** The origin of the governance API (`/v1`), and the audience of the person's token and the principal's `/v1` token. */
  readonly governUrl: string;
  /** The origin of the MCP gateway; the call goes to `<mcpUrl>/v1/mcp`. */
  readonly mcpUrl: string;
  /** The audience of the principal's token for the gateway. An identifier: nothing resolves it. */
  readonly gatewayAudience: string;
  /**
   * The origin of the browser app (the shell) of a named deployment, where Approvals is at `/approvals`.
   * Absent when the govern origin is not the deployment's own: nothing names the app of a custom host.
   */
  readonly appUrl?: string;
}

/**
 * The hosts of the two deployments, as bianoble-deployments origin/main (076769f1) sets them:
 * production in environments/nc.yaml (hosts.governUrl, MCP_PUBLIC_URL, hosts.gatewaySpAudience; the issuer
 * is https://auth.noblecloak.com from day one, docs/superpowers/specs/2026-07-07-nc-production-environment-design.md)
 * and beta in environments/beta.yaml (hosts.governUrl, MCP_PUBLIC_URL, hosts.gatewaySpAudience; its issuer
 * still advertises api.beta, beta.yaml:1066). A flag or a variable replaces any one of them.
 */
export const DEPLOYMENTS = {
  production: {
    authUrl: 'https://auth.noblecloak.com',
    governUrl: 'https://govern.noblecloak.com',
    mcpUrl: 'https://mcp.noblecloak.com',
    gatewayAudience: 'https://mcp-agents.noblecloak.com',
    appUrl: 'https://app.noblecloak.com',
  },
  beta: {
    authUrl: 'https://api.beta.shared.bianoble.com',
    governUrl: 'https://govern.beta.shared.bianoble.com',
    mcpUrl: 'https://mcp.beta.shared.bianoble.com',
    gatewayAudience: 'https://mcp-agents.beta.shared.bianoble.com',
    appUrl: 'https://shell.beta.shared.bianoble.com',
  },
} as const satisfies Record<string, StarterHosts>;

export type DeploymentName = keyof typeof DEPLOYMENTS;

export const isDeployment = (name: string): name is DeploymentName =>
  Object.hasOwn(DEPLOYMENTS, name);

/** An https origin (http on loopback) with no path, query or hash, without a trailing slash. */
export function origin(value: string, what: string): string {
  const url = assertSecureUrl(value, what);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new CliError(
      EXIT.usage,
      `${what} must be an origin: scheme, host and optional port only.`
    );
  }
  return url.origin;
}

/**
 * The hosts for `starter`: each one from its flag, else its variable, else the deployment's default
 * (`--deployment` or ${DEPLOYMENT_ENV}, production when neither is set). A `--deployment` flag is the
 * explicit choice of a whole deployment, so the host variables (NOBLECLOAK_AUTH_URL and the rest, often
 * exported for the `sp` commands) are not read then; the per-host flags still are.
 */
export function resolveStarterHosts(flags: ParsedFlags, io: Io): StarterHosts {
  const deploymentFlag = stringFlag(flags, 'deployment');
  const name = deploymentFlag ?? io.env[DEPLOYMENT_ENV] ?? 'production';
  if (!isDeployment(name)) {
    throw new CliError(
      EXIT.usage,
      `Unknown deployment "${name}": use ${Object.keys(DEPLOYMENTS).join(' or ')}.`
    );
  }
  const defaults = DEPLOYMENTS[name];
  const pick = (flag: string, env: string, fallback: string): string => {
    const value =
      stringFlag(flags, flag) ?? (deploymentFlag === undefined ? io.env[env] : undefined);
    return value === undefined || value === '' ? fallback : value;
  };
  const authUrl = pick('auth-url', AUTH_URL_ENV, defaults.authUrl);
  assertSecureUrl(authUrl, 'The authorization server URL');
  const governUrl = origin(
    pick('govern-url', GOVERN_URL_ENV, defaults.governUrl),
    'The govern URL'
  );
  return {
    authUrl: authUrl.replace(/\/+$/, ''),
    governUrl,
    mcpUrl: origin(pick('mcp-url', MCP_URL_ENV, defaults.mcpUrl), 'The MCP gateway URL'),
    gatewayAudience: origin(
      pick('gateway-audience', GATEWAY_AUDIENCE_ENV, defaults.gatewayAudience),
      'The gateway audience'
    ),
    // Only the deployment's own govern origin tells which browser app holds its Approvals.
    ...(governUrl === defaults.governUrl ? { appUrl: defaults.appUrl } : {}),
  };
}

/**
 * The other deployment a credential belongs to, when `hosts` is not it: the one whose govern origin and
 * gateway audience are both among the credential's declared `audiences`, or else the one whose authorization
 * server is the origin of the credential's `token_endpoint`. Undefined when no known deployment fits, or
 * when `hosts` already holds that deployment's govern origin or authorization server (a per-host override of
 * one host leaves the other still naming the deployment, so the credential is not for another one).
 */
export function deploymentOfCredential(
  hosts: StarterHosts,
  credential: { readonly tokenEndpoint: string; readonly audiences: readonly string[] | undefined }
): string | undefined {
  const held = new Set((credential.audiences ?? []).map((a) => a.replace(/\/+$/, '')));
  let endpointOrigin: string | undefined;
  try {
    endpointOrigin = new URL(credential.tokenEndpoint).origin;
  } catch {
    endpointOrigin = undefined;
  }
  for (const [name, d] of Object.entries(DEPLOYMENTS)) {
    if (d.governUrl === hosts.governUrl || d.authUrl === hosts.authUrl) continue;
    if (
      (held.has(d.governUrl) && held.has(d.gatewayAudience)) ||
      (endpointOrigin !== undefined && endpointOrigin === d.authUrl)
    ) {
      return name;
    }
  }
  return undefined;
}
