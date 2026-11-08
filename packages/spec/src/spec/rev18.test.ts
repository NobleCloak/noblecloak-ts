/**
 * What rev 18 of the document says, as assertions: a `PolicySetProposal` may carry `role` rows, may leave out `agent`
 * and may carry `tool_grants`; `proposal_refused` gains the code `not_entitled`; `ApprovalPreview` gains `grants`,
 * `ineffective` and a `subject` on the `loosening` entry of a role row; `Capabilities` gains `proposals` and documents its entitlement keys as known values. Each addition is
 * optional on the wire, so a rev 17 response that lacks it still validates. `POST /v1/policies/{id}/simulate` (and the
 * set form, which defers to it) simulates as a `service` subject, a text change only: `PolicySubject` already takes it.
 */
import { describe, expect, it } from 'vitest';

import { PROPOSAL_MEMBERS, PROPOSAL_ROW_KINDS } from '../conformance/types.js';
import { loadSpec } from './load.js';
import type { JsonObject } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';
import { obj, str } from './testing.js';
import { SpecIndex } from './validate.js';

const doc = loadSpec(PUBLIC_SOURCE());
const paths = doc.paths as JsonObject;
const schemas = (doc.components as JsonObject).schemas as Record<string, JsonObject>;
const info = obj(doc.info, 'info');
const flat = (text: unknown): string => str(text as never).replace(/\s+/g, ' ');
const props = (name: string): Record<string, JsonObject> =>
  obj(schemas[name], name).properties as Record<string, JsonObject>;
const index = new SpecIndex(doc);
const fits = (value: unknown): boolean => index.schema('PolicySetProposal')(value);
const previewFits = (value: unknown): boolean => index.schema('ApprovalPreview')(value);
const capabilitiesFit = (value: unknown): boolean => index.schema('Capabilities')(value);

const assessment = {
  side_effect_level: 'write',
  blast_radius: 'one_record',
  reversible: true,
  external_party: false,
  financial: false,
};
const row = (role: string, subject: JsonObject): JsonObject => ({
  role,
  rationale: 'Because.',
  assessment,
  policy: {
    kind: 'tool_invocation',
    subjects: [subject],
    targets: { tools: ['ext:crm:update'] },
    config: { mode: 'ask' },
  },
});
const capabilities = (extra: JsonObject = {}): JsonObject => ({
  deployment: 'hosted',
  entitlements: [],
  jwks_uri: 'https://govern.example.com/.well-known/jwks.json',
  kids: [],
  resolutions: [],
  features: [],
  authzen_configuration: 'https://govern.example.com/.well-known/authzen-configuration',
  ...extra,
});

describe('PolicySetProposal (rev 18)', () => {
  it('accepts a role row, and lists it after the two kinds of rev 14 in the order the conformance kit keeps', () => {
    const role = props('PolicySetEntry').role;
    expect(role?.enum).toEqual(['baseline', 'tightening', 'role']);
    expect(role?.enum).toEqual([...PROPOSAL_ROW_KINDS]);
    expect(
      fits({ agent: { id: 'agent_1' }, policies: [row('role', { type: 'role', id: 'member' })] })
    ).toBe(true);
    expect(fits({ policies: [row('owner', { type: 'role', id: 'member' })] })).toBe(false);
  });

  it('needs only policies: a proposal without an agent fits the schema, and the rules beyond it say what it may carry', () => {
    expect(obj(schemas.PolicySetProposal, 'PolicySetProposal').required).toEqual(['policies']);
    expect(
      fits({
        policies: [
          row('baseline', { type: 'role', id: 'everyone' }),
          row('role', { type: 'role', id: 'member' }),
        ],
      })
    ).toBe(true);
    const text = flat(schemas.PolicySetProposal?.description);
    expect(text).toContain(
      'without `agent`, the proposal has no `tightening` (`member` `action.arguments.policies[<i>].role`) and no `tool_grants` (`member` `action.arguments.tool_grants`)'
    );
    expect(text).toContain('never `everyone`');
  });

  it('says a role row key is not empty, has no surrounding whitespace, and is never everyone in any form', () => {
    expect(flat(schemas.PolicySetProposal?.description)).toContain(
      'a bare role key of the organisation as `PolicySubject` describes it, not empty and with no whitespace before or after it, and never `everyone`, nor a key ending in `:everyone` or `/everyone`, each compared case-insensitively after Unicode NFKC normalisation'
    );
  });

  it('carries tool_grants as 1 to 50 distinct references, and says they need agent.principal_id', () => {
    const grants = props('PolicySetProposal').tool_grants;
    expect(grants).toMatchObject({ type: 'array', minItems: 1, maxItems: 50, uniqueItems: true });
    const base = {
      agent: { id: 'a', principal_id: 'sp' },
      policies: [row('baseline', { type: 'role', id: 'everyone' })],
    };
    expect(fits({ ...base, tool_grants: ['ext:crm:read'] })).toBe(true);
    expect(fits({ ...base, tool_grants: [] })).toBe(false);
    expect(fits({ ...base, tool_grants: ['ext:a', 'ext:a'] })).toBe(false);
    expect(
      fits({ ...base, tool_grants: Array.from({ length: 51 }, (_, i) => `ext:${String(i)}`) })
    ).toBe(false);
    const text = flat(schemas.PolicySetProposal?.description);
    expect(text).toContain('`tool_grants` is present only when `agent.principal_id` is');
    expect(text).toContain(
      '`target_unknown` also for a reference of `tool_grants` that is no tool the organisation owns (`owner_kind` `org`: a tool a principal owns is refused as unknown'
    );
    expect(text).toContain('The visibility rule of `GET /v1/tools` (`Owner`) is unchanged');
  });

  it('documents not_entitled at open and at approval, naming the entitlement policies.role_subjects', () => {
    const text = flat(schemas.PolicySetProposal?.description);
    expect(text).toContain(
      '`not_entitled` (the organisation is not entitled to policies with a role subject, the entitlement `policies.role_subjects`'
    );
    expect(text).toContain('the reason `proposal_refused:not_entitled`');
    const code = flat(props('Problem').code?.description);
    expect(code).toContain('rev 18, `not_entitled`');
  });

  it('applies the grants between the binding and the policies, as the overview says', () => {
    expect(flat(info.description)).toContain(
      'the agent is bound to its service principal, (rev 18) its `tool_grants` are granted to that service principal, and each policy is created and published'
    );
  });
});

describe('ApprovalPreview (rev 18)', () => {
  it('adds grants and ineffective as optional members, so a rev 17 preview still validates', () => {
    const preview = obj(schemas.ApprovalPreview, 'ApprovalPreview');
    expect(preview.required).toEqual(['simulations', 'loosening']);
    expect(previewFits({ simulations: [], loosening: [] })).toBe(true);
    expect(
      previewFits({
        simulations: [],
        loosening: [],
        grants: [{ tool_ref: 'ext:crm:read' }],
        ineffective: [{ tool_ref: 'ext:crm:update', subject: { type: 'role', id: 'member' } }],
      })
    ).toBe(true);
    expect(previewFits({ simulations: [], loosening: [], grants: [{}] })).toBe(false);
    expect(
      previewFits({ simulations: [], loosening: [], ineffective: [{ tool_ref: 'ext:crm:update' }] })
    ).toBe(false);
  });

  it('gives a loosening entry an optional subject for a role row, and says that an empty list loosens nothing for any caller', () => {
    const entry = { tool_ref: 'ext:crm:update', from: 'ask', to: 'always_allow' };
    expect(previewFits({ simulations: [], loosening: [entry] })).toBe(true);
    expect(
      previewFits({
        simulations: [],
        loosening: [{ ...entry, subject: { type: 'role', id: 'member' } }],
      })
    ).toBe(true);
    expect(
      previewFits({ simulations: [], loosening: [{ ...entry, subject: { type: 'nobody' } }] })
    ).toBe(false);
    const text = flat(props('ApprovalPreview').loosening?.description);
    expect(text).toContain('one entry, with `subject`, for each `role` row that loosens');
    expect(text).toContain('an empty list says that approving loosens nothing for any caller');
    expect(flat(props('ApprovalPreview').simulations?.description)).toContain(
      '`loosening` and `ineffective` report the `role` rows'
    );
  });
});

describe('Capabilities (rev 18)', () => {
  const entitlements = obj(props('Capabilities').entitlements, 'entitlements');
  const known = (entitlements.items as JsonObject)['x-noblecloak-known-values'] as string[];

  it('documents the entitlement keys as open-ended known values, policies.role_subjects among them', () => {
    expect(known).toEqual([
      'records.verify',
      'evidence.export',
      'policies.suggested',
      'policies.role_subjects',
    ]);
    expect((entitlements.items as JsonObject).enum).toBeUndefined();
    expect(flat(entitlements.description)).toContain(
      'Known values: records.verify | evidence.export | policies.suggested | policies.role_subjects.'
    );
    expect(capabilitiesFit(capabilities({ entitlements: ['a.later.key'] }))).toBe(true);
  });

  it('lists every key a route extension names among the known values', () => {
    const named = new Set<string>();
    for (const item of Object.values(paths))
      for (const operation of Object.values(item as JsonObject)) {
        if (typeof operation !== 'object' || operation === null) continue;
        const o = operation as JsonObject;
        if (typeof o['x-noblecloak-entitlement'] === 'string')
          named.add(o['x-noblecloak-entitlement']);
        for (const parameter of (o.parameters as JsonObject[] | undefined) ?? [])
          for (const key of Object.values(
            (parameter['x-noblecloak-entitlement-for-values'] as JsonObject | undefined) ?? {}
          ))
            if (typeof key === 'string') named.add(key);
      }
    expect(named.size).toBeGreaterThan(0);
    for (const key of named) expect(known).toContain(key);
  });

  it('advertises proposals as row_kinds and members, each open-ended, and absent is the rev 14 behaviour', () => {
    const proposals = obj(props('Capabilities').proposals, 'proposals');
    expect(proposals.required).toEqual(['row_kinds', 'members']);
    const inner = proposals.properties as Record<string, JsonObject>;
    expect((inner.row_kinds?.items as JsonObject)['x-noblecloak-known-values']).toEqual([
      ...PROPOSAL_ROW_KINDS,
    ]);
    expect((inner.members?.items as JsonObject)['x-noblecloak-known-values']).toEqual([
      ...PROPOSAL_MEMBERS,
    ]);
    expect(flat(proposals.description)).toContain(
      'Absent means what a deployment of rev 14 to 17 accepts: `row_kinds` `baseline` and `tightening`, and no optional member.'
    );
    expect(capabilitiesFit(capabilities())).toBe(true);
    expect(
      capabilitiesFit(
        capabilities({ proposals: { row_kinds: ['baseline', 'a_later_kind'], members: [] } })
      )
    ).toBe(true);
    expect(capabilitiesFit(capabilities({ proposals: { row_kinds: [], members: [] } }))).toBe(
      false
    );
    expect(capabilitiesFit(capabilities({ proposals: { row_kinds: ['baseline'] } }))).toBe(false);
    const route = flat(((paths['/v1/capabilities'] as JsonObject).get as JsonObject).description);
    expect(route).toContain(
      '`proposals` (the rows and members of a policy-set proposal it accepts; absent, those of rev 14)'
    );
  });
});

describe('simulate as a service principal (rev 18)', () => {
  const simulate = flat(
    ((paths['/v1/policies/{id}/simulate'] as JsonObject).post as JsonObject).description
  );

  it('lists service among the simulated subject types, so only another in-schema type is 422', () => {
    expect(simulate).toContain(
      'The subject types are `role`, `user`, `agent`, `service` (rev 18) or `organization`; any other type, or one the deployment cannot simulate, is 422 `unsupported_policy_form`'
    );
  });

  it('composes the principal, its bound agent, everyone and the organisation, and names the id it takes', () => {
    expect(simulate).toContain(
      'the deployment composes the policies whose subject is that principal, the policies of the agent it is bound to (if any), the `everyone` role and the organisation, as its gateway would'
    );
    expect(simulate).toContain(
      'an unbound principal composes its own `service` policies, `everyone` and the organisation only'
    );
    expect(simulate).toContain('the `AgentPrincipalWrite.principal_id` string');
    expect(simulate).toContain(
      'A deployment that does not enforce `service` policies (its `policy_forms.subject_types` lacks `service`) still accepts the simulation'
    );
  });

  it('needs no schema change: a service subject and a group subject fit both simulate bodies, an unknown type does not', () => {
    const action = { tool_ref: 'mcp:a:b', arg_digest: 'a'.repeat(64) };
    const policies = [
      {
        kind: 'tool_invocation',
        subjects: [{ type: 'role', id: 'everyone' }],
        targets: { tools: ['mcp:a:b'] },
        config: { mode: 'ask' },
      },
    ];
    for (const name of ['SimulateRequest', 'SimulateSetRequest']) {
      const validate = index.schema(name);
      const body = (subject: JsonObject): JsonObject =>
        name === 'SimulateRequest' ? { action, subject } : { policies, action, subject };
      expect(validate(body({ type: 'service', id: 'svc_1' })), name).toBe(true);
      expect(validate(body({ type: 'group', id: 'g_1' })), name).toBe(true);
      expect(validate(body({ type: 'robot', id: 'r_1' })), name).toBe(false);
    }
    const set = flat(props('SimulateSetRequest').subject?.description);
    expect(set).toContain('as on `POST /v1/policies/{id}/simulate`');
  });
});
