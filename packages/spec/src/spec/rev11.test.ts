/**
 * What rev 11 of the document says, as assertions. Policies: provenance (`contributed`, the
 * `policies.tightest_wins` rule), simulating as a subject, retiring a policy and discarding its draft, the
 * pending draft's version, the forms a deployment enforces, and where an imported policy came from. Every
 * member rev 11 adds is optional, so a rev 10 server's responses still validate.
 */
import { describe, expect, it } from 'vitest';

import { FEATURES } from './families.js';
import { loadSpec } from './load.js';
import type { JsonObject } from './load.js';
import { TENANCY_SENTENCE } from './lint.js';
import { PUBLIC_SOURCE } from './paths.js';
import { obj, str } from './testing.js';
import { SpecIndex } from './validate.js';

const doc = loadSpec(PUBLIC_SOURCE());
const paths = doc.paths as JsonObject;
const components = doc.components as JsonObject;
const schemas = components.schemas as Record<string, JsonObject>;
const responses = components.responses as Record<string, JsonObject>;
const registry = (doc.info as JsonObject)['x-noblecloak-problem-types'] as Record<
  string,
  JsonObject
>;
const flat = (text: unknown): string => str(text as never).replace(/\s+/g, ' ');
const op = (path: string, method: string): JsonObject =>
  obj((paths[path] as JsonObject)[method], `${method} ${path}`);
const props = (name: string): Record<string, JsonObject> =>
  obj(schemas[name], name).properties as Record<string, JsonObject>;
const index = new SpecIndex(doc);
const closed = new SpecIndex(doc, { rejectUndeclared: true });
const meta = { request_id: 'req_1', deployment: 'hosted' };

/** The problem types a response of `operation` lists, through its `$ref`. */
const problemTypesOf = (operation: JsonObject, status: string): string[] => {
  const ref = str(
    obj((operation.responses as JsonObject)[status], status).$ref,
    `${status} $ref`
  ).replace('#/components/responses/', '');
  return obj(responses[ref], ref)['x-noblecloak-problem-types'] as string[];
};
const featuresText = (): string => flat(props('Capabilities').features?.description);

describe('policies: what composed a decision (P-2, P-3)', () => {
  it('a considered entry may say it contributed, and ConsideredPolicies still states no order of precedence', () => {
    const entry = obj(
      props('ConsideredPolicies').policies?.items,
      'ConsideredPolicies.policies.items'
    );
    const members = entry.properties as Record<string, JsonObject>;
    expect(members.contributed).toMatchObject({ type: 'boolean' });
    expect(entry.required).toEqual(['kind', 'id', 'version', 'result']);
    const text = flat(obj(schemas.ConsideredPolicies, 'ConsideredPolicies').description);
    expect(text).toContain('never an order of precedence');
    expect(text).toContain('when no policy of its kind matched');
    expect(flat(members.contributed?.description)).toContain('used to reach `composed`');
    const validate = index.schema('ConsideredPolicies');
    expect(
      validate({
        policies: [
          { kind: 'tool_invocation', id: 'p', version: 1, result: 'deny', contributed: true },
          {
            kind: 'tool_invocation',
            id: 'q',
            version: 1,
            result: 'always_allow',
            contributed: false,
          },
        ],
        composed: { decision: 'deny' },
      })
    ).toBe(true);
  });

  it('policies.tightest_wins is a feature of either kind that states D-A89, s2 and s3, and is provisional on not_granted', () => {
    expect(FEATURES).toContain('policies.tightest_wins');
    const text = featuresText();
    expect(text).toContain('`policies.tightest_wins`');
    expect(text).toContain('`deny` over needs approval (`ask`, `escalate`) over `always_allow`');
    expect(text).toContain('`not_granted` composes as `deny`');
    expect(text).toContain('provisional');
    expect(text).toContain('exemption the deployment defines');
    expect(text).toContain('states no rule');
    // s2: the decision's policy names one contributing entry.
    for (const name of ['Decision', 'SimulateResult'])
      expect(flat(props(name).policy?.description), name).toContain(
        'one of the entries that contributed'
      );
  });
});

describe('policies: simulate as a subject (P-5)', () => {
  it('SimulateRequest takes an optional PolicySubject, and the request stays closed', () => {
    expect(props('SimulateRequest').subject).toMatchObject({
      $ref: '#/components/schemas/PolicySubject',
    });
    const validate = index.schema('SimulateRequest');
    const action = { tool_ref: 'mcp:a:b', arg_digest: 'a'.repeat(64) };
    expect(validate({ action, subject: { type: 'role', id: 'member' } })).toBe(true);
    expect(validate({ action, subject: { type: 'organization' } })).toBe(true);
    expect(validate({ action, as: 'someone' })).toBe(false);
  });

  it('simulate says who may simulate as a subject, which types, and that nothing identifying the caller is read from it', () => {
    const simulate = op('/v1/policies/{id}/simulate', 'post');
    const text = flat(simulate.description);
    expect(text).toContain('administrator');
    expect(text).toContain('`role`, `user`, `agent`, `service` (rev 18) or `organization`');
    expect(text).toContain(
      'an agent: the policies whose subjects name that agent, plus the `everyone` role (rev 13) and the organisation'
    );
    expect(text).toContain('422 `unsupported_policy_form`');
    expect(text).toContain('the caller remains the token');
    expect(text).toContain('nothing is recorded');
    expect(text).toContain(TENANCY_SENTENCE);
    expect(problemTypesOf(simulate, '403')).toContain('forbidden');
    expect(problemTypesOf(simulate, '422')).toEqual(['unsupported_policy_form']);
  });
});

describe('policies: retire and discard (P-6)', () => {
  const retire = (): JsonObject => op('/v1/policies/{id}/retire', 'post');
  const discard = (): JsonObject => op('/v1/policies/{id}/draft', 'delete');

  it('both routes are hosted, in the policies family, behind the policies.retire feature, with the tenancy sentence', () => {
    expect(FEATURES).toContain('policies.retire');
    for (const operation of [retire(), discard()]) {
      expect(operation['x-noblecloak-deployment']).toBe('hosted');
      expect(operation['x-noblecloak-family']).toBe('policies');
      expect(operation['x-noblecloak-feature']).toBe('policies.retire');
      expect(flat(operation.description)).toContain(TENANCY_SENTENCE);
      expect(flat(operation.description)).toContain('before the administrator check');
      expect(problemTypesOf(operation, '403')).toContain('forbidden');
      expect(problemTypesOf(operation, '404')).toEqual([
        'not_available_on_deployment',
        'not_found',
      ]);
    }
    expect(featuresText()).toContain('`policies.retire`');
  });

  it('retire answers the retired policy, leaves the versions, and refuses a policy never published', () => {
    const text = flat(retire().description);
    expect(text).toContain('404 `not_found`');
    expect(text).toContain('`retired_at`');
    expect(text).toContain('policy-cache interval');
    expect(text).toContain('never published is 400 `invalid_request`');
    expect(problemTypesOf(retire(), '400')).toEqual(['invalid_request']);
    expect(JSON.stringify((retire().responses as JsonObject)['200'])).toContain('PolicyEnvelope');
    expect(props('Policy').retired_at).toMatchObject({
      $ref: '#/components/schemas/Timestamp',
    });
  });

  it('discard drops a pending draft, deletes a policy never published, and is 404 with nothing to discard', () => {
    const text = flat(discard().description);
    expect(text).toContain('deletes the policy');
    expect(text).toContain('404 `not_found` when it has none');
    expect(Object.keys(discard().responses as JsonObject)).toContain('204');
  });
});

describe('policies: the pending draft, the forms enforced, provenance and approver groups (P-1, P-7, P-8, P-9)', () => {
  it('Policy.draft_version is read only, and says it is absent with no pending draft', () => {
    const member = props('Policy').draft_version;
    expect(member).toMatchObject({ type: 'integer', minimum: 0, readOnly: true });
    expect(flat(member?.description)).toContain('absent when there is none');
  });

  it('Capabilities.policy_forms names the tool_invocation forms the deployment enforces', () => {
    const forms = props('Capabilities').policy_forms;
    const tool = obj((forms?.properties as JsonObject).tool_invocation, 'tool_invocation');
    expect(tool.required).toEqual(['modes', 'subject_types', 'targets_all', 'config_members']);
    expect(flat(forms?.description)).toContain('never refused with 422');
    const validate = index.schema('Capabilities');
    const base = {
      deployment: 'hosted',
      entitlements: [],
      jwks_uri: 'https://x.test/jwks',
      kids: [],
      resolutions: [],
      features: [],
      authzen_configuration: 'https://x.test/authzen',
    };
    expect(
      validate({
        ...base,
        policy_forms: {
          tool_invocation: {
            modes: ['ask', 'deny'],
            subject_types: ['role', 'organization'],
            targets_all: true,
            config_members: ['on_deny'],
          },
        },
      })
    ).toBe(true);
    expect(
      validate({
        ...base,
        policy_forms: {
          tool_invocation: {
            modes: ['sometimes'],
            subject_types: [],
            targets_all: true,
            config_members: [],
          },
        },
      })
    ).toBe(false);
  });

  it('PolicyWrite.origin names the format and the digest; Policy.origin is read only, per version; source is fixed at create', () => {
    expect(obj(schemas.PolicyOrigin, 'PolicyOrigin')).toMatchObject({
      required: ['format', 'digest'],
      additionalProperties: false,
    });
    expect(props('PolicyWrite').origin).toMatchObject({
      $ref: '#/components/schemas/PolicyOrigin',
    });
    expect(props('Policy').origin).toMatchObject({ $ref: '#/components/schemas/PolicyOrigin' });
    const write = index.schema('PolicyWrite');
    const base = {
      kind: 'tool_invocation',
      subjects: [{ type: 'organization' }],
      config: { mode: 'ask' },
    };
    expect(write({ ...base, origin: { format: 'cedar', digest: 'a'.repeat(64) } })).toBe(true);
    expect(write({ ...base, origin: { format: 'rego', digest: 'a'.repeat(64) } })).toBe(false);
    expect(write({ ...base, origin: { format: 'agt', digest: 'A'.repeat(64) } })).toBe(false);
    expect(write({ ...base, source: 'imported' })).toBe(false);
    const text = flat(op('/v1/policies', 'post').description);
    expect(text).toContain('`source: imported`');
    expect(flat(op('/v1/policies/{id}', 'put').description)).toContain('never changes `source`');
  });

  it('approver_groups together form one requirement, any eligible member of any listed group', () => {
    const text = flat(props('ToolInvocationConfig').approver_groups?.description);
    expect(text).toContain('one approval requirement');
    expect(text).toContain('any eligible member of any listed group');
    expect(text).toContain('ADR-0049');
  });
});

describe('a rev 10 server stays valid (policies)', () => {
  it('a rev 10 policy, simulate answer and capabilities validate against the closed document', () => {
    const policy = {
      id: 'pol_1',
      version: 3,
      source: 'authored',
      kind: 'tool_invocation',
      name: 'n',
      state: 'published',
      subjects: [{ type: 'role', id: 'member' }],
      targets: { tools: 'all' },
      config: { mode: 'ask' },
      published_at: '2026-10-20T00:00:00.000Z',
    };
    expect(closed.schema('PolicyEnvelope')({ data: policy, meta })).toBe(true);
    expect(
      closed.schema('SimulateEnvelope')({
        data: {
          decision: 'deny',
          action_digest: 'a'.repeat(64),
          enforced: false,
          considered: {
            policies: [
              {
                kind: 'tool_invocation',
                id: null,
                version: null,
                result: 'deny',
                source: 'default',
              },
            ],
            composed: { decision: 'deny' },
          },
        },
        meta,
      })
    ).toBe(true);
  });
});

describe('connections: the registration (K-1, K-2, K-6)', () => {
  it('Connection gains optional status, status_detail, last_verified_at, auth_kind and credential_tier; status and tier are open', () => {
    const connection = obj(schemas.Connection, 'Connection');
    expect(connection.required).toEqual(['id', 'name', 'url', 'transport', 'owner', 'created_at']);
    const p = props('Connection');
    expect(p.status).toMatchObject({
      type: 'string',
      'x-noblecloak-known-values': ['connected', 'pending_authorization', 'degraded'],
    });
    expect(p.credential_tier).toMatchObject({
      type: 'string',
      'x-noblecloak-known-values': ['org_shared', 'per_user'],
    });
    expect(p.status_detail?.enum).toEqual([
      'unreachable',
      'credential_rejected',
      'introspection_failed',
    ]);
    expect(p.auth_kind?.enum).toEqual(['none', 'bearer', 'oauth']);
    expect(p.last_verified_at).toMatchObject({ type: ['string', 'null'], format: 'date-time' });
    expect(flat(connection.description)).toContain('No operation returns a credential');
    expect(flat(p.status?.description)).toContain('never used for a `per_user` registration');
    // An open enum is a string that names its known values.
    expect(p.status?.enum).toBeUndefined();
    expect(flat(p.status?.description)).toContain(
      'Known values: connected | pending_authorization | degraded.'
    );
  });

  it('ConnectionWrite takes auth with no credential, the tier, and a write-only organisation credential', () => {
    const write = index.schema('ConnectionWrite');
    const base = { name: 'n', url: 'https://t.example.com/mcp', transport: 'mcp' };
    expect(write(base)).toBe(true);
    expect(write({ ...base, auth: { kind: 'none' } })).toBe(true);
    expect(write({ ...base, auth: { kind: 'bearer' } })).toBe(true);
    expect(
      write({
        ...base,
        auth: {
          kind: 'oauth',
          scopes: ['read'],
          issuer: 'https://idp.example.com',
          client_id: 'c',
        },
      })
    ).toBe(true);
    expect(write({ ...base, auth: { kind: 'bearer', token: 't' } })).toBe(false);
    expect(write({ ...base, auth: { kind: 'none', scopes: ['x'] } })).toBe(false);
    expect(write({ ...base, auth: { kind: 'basic' } })).toBe(false);
    expect(write({ ...base, credential_tier: 'org_shared', org_credential: { token: 't' } })).toBe(
      true
    );
    expect(write({ ...base, credential_tier: 'team' })).toBe(false);
    expect(write({ ...base, org_credential: { token: '' } })).toBe(false);
    expect(props('OrgCredential').token).toMatchObject({ writeOnly: true });
    const create = flat(op('/v1/connections', 'post').description);
    for (const phrase of [
      '`per_user` where the deployment advertises `connections.user_links`',
      '`per_user` where the deployment does not advertise `connections.user_links` is 400',
      'legal only with `credential_tier: org_shared` and `auth.kind: bearer`',
      'is created with `status: pending_authorization`',
      'No operation returns a credential.',
      'The deployment may treat URLs that differ only in form as the same server;',
      'one with userinfo (`user:password@`) is 400 `invalid_request`',
      'A user linking a credential to an existing registration never meets this refusal.',
    ])
      expect(create, phrase).toContain(phrase);
  });

  it('no response schema declares a token: neither the organisation credential nor a link carries one back', () => {
    const declares = (node: unknown, seen = new Set<unknown>()): string[] => {
      if (node === null || typeof node !== 'object' || seen.has(node)) return [];
      seen.add(node);
      const here = node as Record<string, unknown>;
      if (typeof here.$ref === 'string') {
        const name = here.$ref.replace('#/components/schemas/', '');
        return declares(schemas[name], seen);
      }
      const props = here.properties as Record<string, unknown> | undefined;
      return [
        ...(props !== undefined && 'token' in props ? ['token'] : []),
        ...(props !== undefined && 'org_credential' in props ? ['org_credential'] : []),
        ...Object.values(here).flatMap((value) => declares(value, seen)),
      ];
    };
    for (const [path, item] of Object.entries(paths))
      for (const [method, operation] of Object.entries(item as JsonObject)) {
        const ok = Object.entries(((operation as JsonObject).responses ?? {}) as JsonObject).filter(
          ([status]) => status.startsWith('2')
        );
        for (const [status, response] of ok)
          expect(declares(response), `${method} ${path} ${status}`).toEqual([]);
      }
  });
});

describe('connections: one registration per server URL (K-11, E-1)', () => {
  it('connection_exists is a registered 409 on createConnection, with connection_id on Problem', () => {
    expect(registry.connection_exists).toMatchObject({ status: 409 });
    expect(problemTypesOf(op('/v1/connections', 'post'), '409')).toEqual(['connection_exists']);
    expect(flat(props('Problem').connection_id?.description)).toContain(
      'when the caller may read it'
    );
  });
});

describe('connections: routes (K-3 to K-10)', () => {
  it('refresh registers and is in the connections family, served on both, with the tenancy sentence', () => {
    const refresh = op('/v1/connections/{id}/refresh', 'post');
    expect(refresh['x-noblecloak-family']).toBe('connections');
    expect(refresh['x-noblecloak-deployment']).toBe('both');
    expect(refresh['x-noblecloak-feature']).toBeUndefined();
    const text = flat(refresh.description);
    expect(text).toContain(TENANCY_SENTENCE);
    expect(text).toContain('`withdrawn`');
    expect(text).toContain('never with a user');
    expect(obj(schemas.ConnectionRefreshResult, 'ConnectionRefreshResult').required).toEqual([
      'tool_count',
      'added',
      'removed',
      'reactivated',
    ]);
  });

  it('patch refuses url and rotates the organisation credential; delete withdraws and keeps the rev 10 sentence; discover registers nothing', () => {
    const patch = flat(op('/v1/connections/{id}', 'patch').description);
    expect(patch).toContain('`url` is refused with 400 `invalid_request`');
    expect(Object.keys(props('ConnectionPatch'))).toEqual(['name', 'org_credential', 'url']);
    const del = flat(op('/v1/connections/{id}', 'delete').description);
    expect(del).toContain(
      'Its tools stay addressable for existing policies but can no longer be called through it'
    );
    expect(del).toContain(
      'registering the same server URL again makes them `active` under the same `tool_ref`'
    );
    expect(del).toContain(
      "Every user's link to the registration is removed with it, and every authorization in flight."
    );
    expect(flat(op('/v1/connections/{id}/discover', 'post').description)).toContain(
      'Discovery does not register them'
    );
  });

  it('visibility is stated once on Owner and referenced from every connection route', () => {
    expect(flat(obj(schemas.Owner, 'Owner').description)).toContain(
      'A tool or a connection owned by a `principal`'
    );
    for (const [path, method] of [
      ['/v1/connections/{id}', 'get'],
      ['/v1/connections/{id}', 'patch'],
      ['/v1/connections/{id}', 'delete'],
      ['/v1/connections/{id}/discover', 'post'],
      ['/v1/connections/{id}/refresh', 'post'],
    ] as const)
      expect(flat(op(path, method).description), `${method} ${path}`).toContain(
        'Visibility follows `Owner`'
      );
    expect(flat(op('/v1/connections', 'get').description)).toContain('(see `Owner`)');
  });

  it('capabilities say who registers and which transports are served', () => {
    const p = props('Capabilities');
    expect(obj(p.connection_registration, 'connection_registration').required).toEqual([
      'owner_kinds',
      'who',
    ]);
    expect(p.connection_transports).toMatchObject({ type: 'array' });
    const text = featuresText();
    expect(text).toContain('`connections.oauth`');
    expect(text).toContain('`connections.user_links`');
    expect(FEATURES).toEqual(
      expect.arrayContaining(['connections.oauth', 'connections.user_links'])
    );
  });
});

describe('tools: status and identity (T-1 to T-3)', () => {
  it('Tool.status is an open enum, absent meaning active, and a withdrawn tool decides deny unknown_tool', () => {
    const status = props('Tool').status;
    expect(status).toMatchObject({
      type: 'string',
      'x-noblecloak-known-values': ['active', 'withdrawn'],
    });
    expect(flat(status?.description)).toContain('Absent means `active`');
    for (const [path, method] of [
      ['/v1/tools', 'get'],
      ['/v1/tools', 'post'],
      ['/v1/decisions', 'post'],
    ] as const)
      expect(flat(op(path, method).description), `${method} ${path}`).toMatch(/withdrawn/);
  });

  it('the connection filter is described, and tool_ref is opaque on Tool and on PolicyTargets', () => {
    const parameter = (op('/v1/tools', 'get').parameters as JsonObject[]).find(
      (p) => p.name === 'connection'
    );
    expect(flat(parameter?.description)).toContain(
      'Only the tools registered from this connection'
    );
    for (const text of [
      flat(props('Tool').tool_ref?.description),
      flat(obj(schemas.PolicyTargets, 'PolicyTargets').description),
    ]) {
      expect(text).toContain('compare it for equality and never parse it');
      expect(text).toContain('across disconnect and reconnect');
    }
  });
});

describe('a rev 10 server stays valid (connections and tools)', () => {
  it('a rev 10 connection and tool validate against the closed document', () => {
    const connection = {
      id: 'conn_1',
      name: 'n',
      url: 'https://t.example.com/mcp',
      transport: 'mcp',
      owner: { kind: 'org', id: 'org_1' },
      created_at: '2026-10-20T00:00:00.000Z',
    };
    const tool = {
      id: 'tool_1',
      tool_ref: 'mcp:a:b',
      connection_id: 'conn_1',
      transport: 'mcp',
      side_effect_level: 'read',
      data_routing: 'org_only',
    };
    expect(closed.schema('ConnectionEnvelope')({ data: connection, meta })).toBe(true);
    expect(closed.schema('ConnectionListEnvelope')({ data: [connection], meta })).toBe(true);
    expect(closed.schema('ToolListEnvelope')({ data: [tool], meta })).toBe(true);
    // And a rev 11 connection from a future server with a status it does not know still validates.
    expect(
      closed.schema('ConnectionEnvelope')({
        data: {
          ...connection,
          status: 'migrating',
          credential_tier: 'team_shared',
          auth_kind: 'none',
        },
        meta,
      })
    ).toBe(true);
  });
});

describe('connections: each caller links its own credential (K-12)', () => {
  const link = (): JsonObject => op('/v1/connections/{id}/link', 'post');
  const unlink = (): JsonObject => op('/v1/connections/{id}/link', 'delete');
  const revoke = (): JsonObject => op('/v1/connections/{id}/link/consent', 'delete');

  it('the link routes are hosted, behind connections.user_links, with the tenancy sentence', () => {
    for (const operation of [link(), unlink(), revoke()]) {
      expect(operation['x-noblecloak-deployment']).toBe('hosted');
      expect(operation['x-noblecloak-family']).toBe('connections');
      expect(operation['x-noblecloak-feature']).toBe('connections.user_links');
      expect(flat(operation.description)).toContain(TENANCY_SENTENCE);
      expect(flat(operation.description)).toContain('Visibility follows `Owner`');
    }
    expect(flat(link().description)).toContain('no route reads or acts on another user');
    expect(flat(unlink().description)).toContain('also when the caller had none');
    expect(flat(revoke().description)).toContain('404 `not_found` when the caller has no link');
  });

  it('consent is required and only true; the token is write only; the body is closed', () => {
    const validate = index.schema('ConnectionLinkRequest');
    expect(validate({ consent: true })).toBe(true);
    expect(validate({ consent: true, token: 't' })).toBe(true);
    expect(validate({ token: 't' })).toBe(false);
    expect(validate({ consent: false, token: 't' })).toBe(false);
    expect(validate({ consent: true, user_id: 'u' })).toBe(false);
    expect(props('ConnectionLinkRequest').token).toMatchObject({ writeOnly: true });
  });

  it('my_link is the caller’s own, with open status and consent, and never a credential', () => {
    expect(props('Connection').my_link).toMatchObject({
      $ref: '#/components/schemas/ConnectionLink',
    });
    expect(flat(props('Connection').my_link?.description)).toContain('nobody else');
    const p = props('ConnectionLink');
    expect(p.status).toMatchObject({
      type: 'string',
      'x-noblecloak-known-values': ['linked', 'pending_authorization', 'degraded', 'none'],
    });
    expect(p.consent).toMatchObject({
      type: 'string',
      'x-noblecloak-known-values': ['given', 'revoked', 'none'],
    });
    expect(Object.keys(p)).toEqual(['status', 'consent', 'linked_at']);
  });
});

/** The quarterback's ruling (adv-6/WB-3): `return_to` keeps its query. */
const KEEPS_QUERY =
  "The deployment keeps `return_to`'s own query and adds the `nc_*` parameters to it.";

describe('connections: authorize (K-3)', () => {
  it('is hosted, behind connections.oauth, single use, and names the closed nc_error codes', () => {
    const authorize = op('/v1/connections/{id}/authorize', 'post');
    expect(authorize['x-noblecloak-deployment']).toBe('hosted');
    expect(authorize['x-noblecloak-feature']).toBe('connections.oauth');
    const text = flat(authorize.description);
    for (const phrase of [
      TENANCY_SENTENCE,
      "the caller's own link",
      'Administrators only (403 `forbidden` otherwise)',
      '`nc_connection=<id>`',
      '`consent_denied`, `expired`, `exchange_failed`, `upstream_error`',
      'not on an origin the deployment admits for browser modules',
      KEEPS_QUERY,
    ])
      expect(text, phrase).toContain(phrase);
    const returnTo = (
      obj(schemas.ConnectionAuthorizeRequest, 'ConnectionAuthorizeRequest').properties as Record<
        string,
        { description?: string }
      >
    ).return_to;
    expect(flat(returnTo?.description)).toContain(KEEPS_QUERY);
    expect(obj(schemas.ConnectionAuthorizeRequest, 'ConnectionAuthorizeRequest')).toMatchObject({
      required: ['return_to'],
      additionalProperties: false,
    });
    expect(obj(schemas.ConnectionAuthorizeResult, 'ConnectionAuthorizeResult').required).toEqual([
      'authorization_url',
      'expires_at',
    ]);
  });
});

describe('approvals: blocked on a link (K-13)', () => {
  it('Approval.blocked_on names an open reason and the connection, for the creator alone, never on a stream event', () => {
    const blocked = obj(props('Approval').blocked_on, 'blocked_on');
    expect(blocked.required).toEqual(['reason', 'connection_id']);
    expect((blocked.properties as Record<string, JsonObject>).reason).toMatchObject({
      type: 'string',
      'x-noblecloak-known-values': ['credential_link_required'],
    });
    const text = flat(blocked.description);
    expect(text).toContain('absent for every other reader and on every stream event');
    expect(text).toContain('does not execute the call or issue its resume token');
    expect(text).toContain('`POST /v1/connections/{connection_id}/link`');
  });

  it('a direct call with no usable link is deny credential_link_required, in the vocabulary and on Decision.reason', () => {
    const vocabulary = (doc.info as JsonObject)['x-noblecloak-vocabulary'] as JsonObject;
    expect(vocabulary.decision_from_reason).toMatchObject({ credential_link_required: 'deny' });
    expect(flat(props('Decision').reason?.description)).toContain('`credential_link_required`');
    expect(flat(op('/v1/decisions', 'post').description)).toContain('`credential_link_required`');
  });
});

describe('a rev 10 server stays valid (approvals)', () => {
  it('a rev 10 approval validates against the closed document', () => {
    const approval = {
      id: 'ap_1',
      state: 'pending',
      tool_ref: 'mcp:a:b',
      obligation_kind: 'tool_invocation',
      action_digest: 'a'.repeat(64),
      scope_id: 's',
      side_effect_level: 'write',
      created_at: '2026-10-20T00:00:00.000Z',
    };
    expect(closed.schema('ApprovalEnvelope')({ data: approval, meta })).toBe(true);
    expect(
      closed.schema('ApprovalEnvelope')({
        data: { ...approval, blocked_on: { reason: 'a_future_reason', connection_id: 'c' } },
        meta,
      })
    ).toBe(true);
  });
});
