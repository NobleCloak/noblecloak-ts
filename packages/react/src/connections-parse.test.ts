import { describe, expect, it } from 'vitest';

import { connectionsErrorFromResponse, precondition } from './connections-errors.js';
import {
  authorizationUrlOf,
  connectionOf,
  connectionToolOf,
  connectionsCapabilitiesOf,
  refreshCountsOf,
  returnOf,
  withoutReturn,
} from './connections-parse.js';
import type { ConnectionsPreconditionCode } from './connections-types.js';
import { CONNECTIONS_DEFAULT_LABELS } from './components/connections-labels.js';

const row = {
  id: 'c1',
  name: 'one',
  url: 'https://one.example.com/mcp',
  transport: 'mcp',
  owner: { kind: 'org', id: 'org_1' },
  created_at: '2026-10-22T00:00:00Z',
};

describe('connectionOf', () => {
  it('reads a rev 10 registration (no rev 11 member) and keeps open values as sent', () => {
    expect(connectionOf(row)).toEqual({
      id: 'c1',
      name: 'one',
      url: 'https://one.example.com/mcp',
      transport: 'mcp',
      owner: { kind: 'org', id: 'org_1' },
      createdAt: '2026-10-22T00:00:00Z',
    });
    expect(
      connectionOf({
        ...row,
        status: 'paused',
        status_detail: 'unreachable',
        last_verified_at: null,
        auth_kind: 'oauth',
        credential_tier: 'team',
        my_link: { status: 'expired', consent: 'given', linked_at: '2026-10-22T01:00:00Z' },
      })
    ).toMatchObject({
      state: 'paused',
      stateDetail: 'unreachable',
      lastVerifiedAt: null,
      authKind: 'oauth',
      credentialTier: 'team',
      myLink: { status: 'expired', consent: 'given', linkedAt: '2026-10-22T01:00:00Z' },
    });
  });

  it('keeps no member the contract does not name: a credential sent by mistake is dropped', () => {
    const read = connectionOf({
      ...row,
      org_credential: { token: 'leak' },
      my_link: { status: 'linked', consent: 'given', token: 'leak' },
    });
    expect(JSON.stringify(read)).not.toContain('leak');
  });

  it.each([
    ['no id', { ...row, id: '' }],
    ['no owner', { ...row, owner: undefined }],
    ['an owner without an id', { ...row, owner: { kind: 'org' } }],
    ['a my_link of another shape', { ...row, my_link: { status: 'linked' } }],
    ['no created_at', { ...row, created_at: 1 }],
  ])('refuses a registration with %s', (_label, value) => {
    expect(connectionOf(value)).toBeUndefined();
  });
});

describe('connectionToolOf', () => {
  const tool = {
    id: 't1',
    tool_ref: 'mcp:x/y/z',
    transport: 'mcp',
    side_effect_level: 'read',
    connection_id: 'c1',
  };

  it('reads an absent status as active and keeps another as sent', () => {
    expect(connectionToolOf(tool)?.status).toBe('active');
    expect(connectionToolOf({ ...tool, status: 'paused' })?.status).toBe('paused');
    // Present but not text: kept as its JSON, never read as active.
    expect(connectionToolOf({ ...tool, status: null })?.status).toBe('null');
    expect(connectionToolOf({ ...tool, status: '' })?.status).toBe('""');
    expect(connectionToolOf({ ...tool, status: 3 })?.status).toBe('3');
    expect(connectionToolOf({ ...tool, connection_id: null })?.connectionId).toBeNull();
  });

  it('refuses a tool of another shape', () => {
    expect(connectionToolOf({ ...tool, connection_id: 3 })).toBeUndefined();
    expect(connectionToolOf({ ...tool, side_effect_level: undefined })).toBeUndefined();
  });
});

describe('the other bodies', () => {
  it('reads refresh counts, and refuses a count that is not one', () => {
    expect(
      refreshCountsOf({ data: { tool_count: 1, added: 1, removed: 0, reactivated: 0 } })
    ).toEqual({
      toolCount: 1,
      added: 1,
      removed: 0,
      reactivated: 0,
      emptyUpstreamSuppressed: false,
    });
    expect(
      refreshCountsOf({ data: { tool_count: -1, added: 1, removed: 0, reactivated: 0 } })
    ).toBeUndefined();
  });

  it('follows only an https authorization URL, or http to this machine', () => {
    const at = (url: unknown) => authorizationUrlOf({ data: { authorization_url: url } });
    expect(at('https://as.example.com/a')).toBe('https://as.example.com/a');
    expect(at('http://127.0.0.1:8787/consent')).toBe('http://127.0.0.1:8787/consent');
    expect(at('http://localhost/consent')).toBe('http://localhost/consent');
    // Plaintext over a network is not followed.
    expect(at('http://as.example.com/a')).toBeUndefined();
    expect(at('javascript:alert(1)')).toBeUndefined();
    expect(at('data:text/html,x')).toBeUndefined();
    expect(at('not a url')).toBeUndefined();
  });

  it('reads the capabilities: oauth and links only with the family, transports both when absent', () => {
    expect(connectionsCapabilitiesOf({ data: { features: ['connections.oauth'] } })).toEqual({
      served: false,
      oauth: false,
      userLinks: false,
      transports: ['mcp', 'a2a'],
    });
    expect(
      connectionsCapabilitiesOf({
        data: {
          features: ['connections', 'connections.user_links'],
          connection_registration: { owner_kinds: ['org'], who: 'administrators' },
          connection_transports: ['mcp'],
        },
      })
    ).toEqual({
      served: true,
      oauth: false,
      userLinks: true,
      registration: { ownerKinds: ['org'], who: 'administrators' },
      transports: ['mcp'],
    });
    expect(connectionsCapabilitiesOf({ data: {} })).toBeUndefined();
  });

  it('reads the return of a round trip and takes it out of an address', () => {
    const href =
      'https://app.example.com/c?x=1&nc_state=s&nc_connection=c1&nc_result=connected#top';
    expect(returnOf(href)).toEqual({ connectionId: 'c1', state: 's', result: 'connected' });
    expect(
      returnOf('https://a.example/c?nc_connection=c1&nc_result=error&nc_error=expired')
    ).toEqual({ connectionId: 'c1', result: 'error', error: 'expired' });
    // No text of the address is kept beyond the closed lists.
    expect(
      returnOf('https://a.example/c?nc_connection=c1&nc_result=pwned&nc_error=Call%20us')
    ).toEqual({ connectionId: 'c1', result: 'error' });
    expect(returnOf('https://app.example.com/c?nc_result=connected')).toBeUndefined();
    expect(returnOf('not a url')).toBeUndefined();
    expect(withoutReturn(href)).toBe('https://app.example.com/c?x=1#top');
    expect(withoutReturn('not a url')).toBe('not a url');
    // An address with none of them is left exactly as it is, its own encoding included.
    for (const own of [
      'https://a.test/p?tab',
      'https://a.test/p?q=a%20b',
      'https://a.test/p?q=a~b',
      'https://a.test/p?',
    ])
      expect(withoutReturn(own)).toBe(own);
  });
});

describe('connectionsErrorFromResponse', () => {
  it('carries the existing registration of connection_exists, and the detail of a 400', () => {
    expect(
      connectionsErrorFromResponse(409, {
        type: 'https://noblecloak.dev/problems/connection_exists',
        title: 'exists',
        connection_id: 'c9',
      })
    ).toMatchObject({ kind: 'conflict', code: 'connection_exists', connectionId: 'c9' });
    expect(
      connectionsErrorFromResponse(409, {
        type: 'https://noblecloak.dev/problems/connection_exists',
        title: 'exists',
      })
    ).not.toHaveProperty('connectionId');
    expect(
      connectionsErrorFromResponse(400, {
        type: 'https://noblecloak.dev/problems/invalid_request',
        title: 'bad',
        detail: 'url: refused',
      })
    ).toMatchObject({ kind: 'invalid_request', detail: 'url: refused' });
  });

  it('has words for every refusal the store gives without a request', () => {
    const codes: ConnectionsPreconditionCode[] = [
      'read_only',
      'oauth_not_offered',
      'links_not_offered',
      'nothing_to_link',
      'consent_required',
      'not_loaded',
      'write_in_flight',
      'cannot_navigate',
    ];
    for (const code of codes) {
      expect(precondition(code)).toMatchObject({ kind: 'precondition', code, local: true });
      expect(Object.hasOwn(CONNECTIONS_DEFAULT_LABELS, `error_${code}`)).toBe(true);
    }
  });
});
