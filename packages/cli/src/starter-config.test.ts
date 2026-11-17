import { describe, expect, it } from 'vitest';
import { parseStarterFlags } from './args.js';
import type { Io } from './io.js';
import { DEPLOYMENTS, deploymentOfCredential, resolveStarterHosts } from './starter-config.js';

const io = (env: Record<string, string | undefined> = {}): Io => ({ env }) as unknown as Io;
const hosts = (argv: string[] = [], env: Record<string, string | undefined> = {}) =>
  resolveStarterHosts(parseStarterFlags(argv), io(env));

describe('starter hosts', () => {
  it('default to production: the hosts of bianoble-deployments environments/nc.yaml', () => {
    expect(hosts()).toEqual({
      authUrl: 'https://auth.noblecloak.com',
      governUrl: 'https://govern.noblecloak.com',
      mcpUrl: 'https://mcp.noblecloak.com',
      gatewayAudience: 'https://mcp-agents.noblecloak.com',
    });
  });

  it('--deployment beta and NOBLECLOAK_DEPLOYMENT=beta select the beta.yaml hosts', () => {
    const beta = {
      authUrl: 'https://api.beta.shared.bianoble.com',
      governUrl: 'https://govern.beta.shared.bianoble.com',
      mcpUrl: 'https://mcp.beta.shared.bianoble.com',
      gatewayAudience: 'https://mcp-agents.beta.shared.bianoble.com',
    };
    expect(hosts(['--deployment', 'beta'])).toEqual(beta);
    expect(hosts([], { NOBLECLOAK_DEPLOYMENT: 'beta' })).toEqual(beta);
    expect(hosts(['--deployment', 'production'], { NOBLECLOAK_DEPLOYMENT: 'beta' })).toEqual(
      DEPLOYMENTS.production
    );
  });

  it('a flag wins over its variable, which wins over the deployment, one host at a time', () => {
    const resolved = hosts(['--govern-url', 'https://flag.example.com/'], {
      NOBLECLOAK_GOVERN_URL: 'https://env.example.com',
      NOBLECLOAK_MCP_URL: 'https://mcp.env.example.com',
      NOBLECLOAK_AUTH_URL: 'https://auth.env.example.com/',
      NOBLECLOAK_GATEWAY_AUDIENCE: '',
    });
    expect(resolved).toEqual({
      authUrl: 'https://auth.env.example.com',
      governUrl: 'https://flag.example.com',
      mcpUrl: 'https://mcp.env.example.com',
      gatewayAudience: DEPLOYMENTS.production.gatewayAudience,
    });
  });

  it('accept http on loopback and refuse a path on an origin', () => {
    expect(hosts(['--govern-url', 'http://127.0.0.1:8080']).governUrl).toBe(
      'http://127.0.0.1:8080'
    );
    expect(() => hosts(['--govern-url', 'https://govern.example.com/v1'])).toThrow(/origin/);
    expect(() => hosts(['--mcp-url', 'https://mcp.example.com?x=1'])).toThrow(/origin/);
    expect(() => hosts(['--gateway-audience', 'https://a.example.com#f'])).toThrow(/origin/);
  });
});

describe('an explicit --deployment and the host variables', () => {
  const leftover = {
    NOBLECLOAK_AUTH_URL: 'https://auth.noblecloak.com',
    NOBLECLOAK_GOVERN_URL: 'https://govern.noblecloak.com',
  };

  it('--deployment beta ignores variables left over from another deployment', () => {
    expect(hosts(['--deployment', 'beta'], leftover)).toEqual(DEPLOYMENTS.beta);
  });

  it('a per-host flag still wins under --deployment, and NOBLECLOAK_DEPLOYMENT does not shut the variables out', () => {
    expect(
      hosts(['--deployment', 'beta', '--mcp-url', 'https://mcp.flag.example.com'], leftover).mcpUrl
    ).toBe('https://mcp.flag.example.com');
    expect(hosts([], { ...leftover, NOBLECLOAK_DEPLOYMENT: 'beta' }).authUrl).toBe(
      'https://auth.noblecloak.com'
    );
  });
});

describe('deploymentOfCredential', () => {
  const prod = DEPLOYMENTS.production;
  it('names the deployment whose audiences the credential declares', () => {
    expect(
      deploymentOfCredential(prod, {
        tokenEndpoint: 'https://x.example.com/t',
        audiences: [DEPLOYMENTS.beta.governUrl + '/', DEPLOYMENTS.beta.gatewayAudience],
      })
    ).toBe('beta');
  });
  it('names it from the token endpoint when no audiences are declared', () => {
    expect(
      deploymentOfCredential(prod, {
        tokenEndpoint: `${DEPLOYMENTS.beta.authUrl}/auth/oauth/token`,
        audiences: undefined,
      })
    ).toBe('beta');
  });
  it('says nothing for the deployment the hosts already name, or an unknown one', () => {
    expect(
      deploymentOfCredential(prod, {
        tokenEndpoint: `${prod.authUrl}/auth/oauth/token`,
        audiences: [prod.governUrl],
      })
    ).toBeUndefined();
    expect(
      deploymentOfCredential(prod, { tokenEndpoint: 'not a url', audiences: [] })
    ).toBeUndefined();
  });
  it('says nothing when one host is overridden but the authorization server still names the deployment', () => {
    const overridden = { ...prod, governUrl: 'https://govern.override.example.com' };
    expect(
      deploymentOfCredential(overridden, {
        tokenEndpoint: `${prod.authUrl}/auth/oauth/token`,
        audiences: undefined,
      })
    ).toBeUndefined();
  });
});
