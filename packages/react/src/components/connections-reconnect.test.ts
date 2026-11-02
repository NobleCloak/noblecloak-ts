import { describe, expect, it } from 'vitest';

import type { ConnectionInfo, ConnectionsController } from '../connections-types.js';
import { reconnectOf, sameServer } from './Connections.js';

/** Only the members `reconnectOf` reads. */
const controllerOf = (
  facts: { oauth: boolean; userLinks: boolean },
  readOnly = false
): ConnectionsController =>
  ({
    facts: { served: true, transports: ['mcp'], ...facts },
    administration: readOnly ? { readOnly: true, reason: 'host' } : { readOnly: false },
  }) as unknown as ConnectionsController;

const base: ConnectionInfo = {
  id: 'c1',
  name: 'n',
  url: 'https://s.example.com/mcp',
  transport: 'mcp',
  owner: { kind: 'org', id: 'o' },
  createdAt: '2026-10-01T00:00:00Z',
};

const perUser = (authKind: string, link?: ConnectionInfo['myLink']): ConnectionInfo => ({
  ...base,
  authKind,
  credentialTier: 'per_user',
  ...(link === undefined ? {} : { myLink: link }),
});

const orgShared = (authKind: string, state: string): ConnectionInfo => ({
  ...base,
  authKind,
  credentialTier: 'org_shared',
  state,
});

const both = controllerOf({ oauth: true, userLinks: true });

describe('reconnectOf', () => {
  it('offers nothing for a link never made, or where the link has no kind of authentication', () => {
    expect(reconnectOf(both, perUser('oauth'))).toBeUndefined();
    expect(
      reconnectOf(both, perUser('oauth', { status: 'none', consent: 'none' }))
    ).toBeUndefined();
    expect(
      reconnectOf(both, { ...base, authKind: 'none', credentialTier: 'per_user' })
    ).toBeUndefined();
  });

  it("authorizes the caller's own OAuth link in every state it has, and says when it is not in use", () => {
    expect(reconnectOf(both, perUser('oauth', { status: 'linked', consent: 'given' }))).toEqual({
      scope: 'own',
      step: 'authorize',
      attention: false,
    });
    for (const status of ['pending_authorization', 'degraded'])
      expect(reconnectOf(both, perUser('oauth', { status, consent: 'given' }))).toEqual({
        scope: 'own',
        step: 'authorize',
        attention: true,
      });
    // A state the module does not know is not authorized.
    expect(
      reconnectOf(both, perUser('oauth', { status: 'paused', consent: 'given' }))
    ).toBeUndefined();
    // Without the OAuth round trip there is nothing to start.
    expect(
      reconnectOf(
        controllerOf({ oauth: false, userLinks: true }),
        perUser('oauth', { status: 'degraded', consent: 'given' })
      )
    ).toBeUndefined();
  });

  it('asks for consent again, or a new token, through the link', () => {
    expect(reconnectOf(both, perUser('oauth', { status: 'linked', consent: 'revoked' }))).toEqual({
      scope: 'own',
      step: 'link',
      attention: true,
    });
    expect(reconnectOf(both, perUser('bearer', { status: 'linked', consent: 'given' }))).toEqual({
      scope: 'own',
      step: 'link',
      attention: false,
    });
    expect(reconnectOf(both, perUser('bearer', { status: 'degraded', consent: 'given' }))).toEqual({
      scope: 'own',
      step: 'link',
      attention: true,
    });
  });

  it('offers the organisation credential to an administrator only: authorize for OAuth, replace for bearer', () => {
    expect(reconnectOf(both, orgShared('oauth', 'connected'))).toEqual({
      scope: 'org',
      step: 'authorize',
      attention: false,
    });
    expect(reconnectOf(both, orgShared('oauth', 'degraded'))).toEqual({
      scope: 'org',
      step: 'authorize',
      attention: true,
    });
    expect(reconnectOf(both, orgShared('oauth', 'unknown'))).toBeUndefined();
    expect(
      reconnectOf(controllerOf({ oauth: false, userLinks: false }), orgShared('oauth', 'degraded'))
    ).toBeUndefined();
    expect(reconnectOf(both, orgShared('bearer', 'pending_authorization'))).toEqual({
      scope: 'org',
      step: 'rotate',
      attention: true,
    });
    expect(reconnectOf(both, orgShared('none', 'connected'))).toBeUndefined();
    expect(
      reconnectOf(
        controllerOf({ oauth: true, userLinks: true }, true),
        orgShared('oauth', 'degraded')
      )
    ).toBeUndefined();
    // Without per-user links a per_user registration is nobody's to reconnect here.
    expect(
      reconnectOf(
        controllerOf({ oauth: true, userLinks: false }),
        perUser('oauth', { status: 'degraded', consent: 'given' })
      )
    ).toBeUndefined();
  });
});

describe('sameServer', () => {
  it('ignores scheme and host case, a default port and a trailing slash, and keeps the query', () => {
    expect(sameServer('https://S.example.com:443/mcp/', 'HTTPS://s.example.com/mcp')).toBe(true);
    expect(sameServer('https://s.example.com/mcp?a=1', 'https://s.example.com/mcp')).toBe(false);
    expect(sameServer('https://s.example.com/other', 'https://s.example.com/mcp')).toBe(false);
    expect(sameServer('not a url', 'not a url')).toBe(true);
    expect(sameServer('not a url', 'https://s.example.com')).toBe(false);
  });
});
