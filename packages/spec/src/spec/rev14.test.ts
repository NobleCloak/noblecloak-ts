/**
 * What rev 14 of the document says, as assertions: a deployment-applied reference (`tool:noblecloak:`), the
 * `PolicySetProposal` that `tool:noblecloak:propose-policy-set` takes, the open-time refusal `proposal_refused`,
 * `policy_immutable`, `Approval.preview` and the way a refusal at approval is recorded. Each addition is optional
 * on the wire, so a rev 13 response that lacks it still validates.
 */
import { describe, expect, it } from 'vitest';

import { loadSpec } from './load.js';
import type { JsonObject } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';
import { obj, str } from './testing.js';
import { SpecIndex } from './validate.js';

const doc = loadSpec(PUBLIC_SOURCE());
const paths = doc.paths as JsonObject;
const schemas = (doc.components as JsonObject).schemas as Record<string, JsonObject>;
const responses = (doc.components as JsonObject).responses as Record<string, JsonObject>;
const info = obj(doc.info, 'info');
const flat = (text: unknown): string => str(text as never).replace(/\s+/g, ' ');
const op = (path: string, method: string): JsonObject =>
  obj((paths[path] as JsonObject)[method], `${method} ${path}`);
const props = (name: string): Record<string, JsonObject> =>
  obj(schemas[name], name).properties as Record<string, JsonObject>;
const index = new SpecIndex(doc);
const description = flat(info.description);
const registry = obj(info['x-noblecloak-problem-types'], 'registry');

const SIDE_EFFECT = 'write';
const proposal = (): JsonObject => ({
  agent: { id: 'agent_1' },
  tools: [
    {
      tool_ref: 'ext:crm:update',
      transport: 'external',
      input_schema: { type: 'object' },
      side_effect_level: SIDE_EFFECT,
      owner_kind: 'org',
    },
  ],
  policies: [
    {
      role: 'baseline',
      rationale: 'Ask before any change to a record.',
      assessment: {
        side_effect_level: SIDE_EFFECT,
        blast_radius: 'one_record',
        reversible: true,
        external_party: false,
        financial: false,
      },
      policy: {
        kind: 'tool_invocation',
        subjects: [{ type: 'role', id: 'everyone' }],
        targets: { tools: ['ext:crm:update'] },
        config: { mode: 'ask' },
      },
    },
  ],
});
const fits = (body: unknown): boolean => index.schema('PolicySetProposal')(body);

describe('deployment-applied proposals (rev 14)', () => {
  const at = description.indexOf('**Deployment-applied proposals (rev 14).**');
  const text = description.slice(at, at + 9000);

  it('states the namespace, the capability, the effect and who approves once, in the API description', () => {
    expect(at).toBeGreaterThan(-1);
    expect(text).toContain('namespace `tool:noblecloak:`');
    expect(text).toContain('Registering a tool under it is 422 `reserved_tool_ref`');
    expect(text).toContain('a decision on it is `deny` with reason `unknown_tool`');
    expect(text).toContain('is 422 `policy_immutable`');
    expect(text).toContain('`Capabilities.deployment_applied`');
    expect(text).toContain('answers 422 `approval_unroutable`');
    expect(text).toContain('If any step cannot be applied, nothing is applied');
    expect(text).toContain('`reason` of the form `proposal_refused:<code>`');
    expect(text).toContain('the approval is `approved` and at once `consumed`');
    expect(text).toContain('Denying applies nothing');
    expect(text).toContain('An administrator of the organisation');
    expect(text).toContain('`Capabilities.self_approval_from_approver_surface`');
  });

  it('registers the two new problem types, and widens member to the places that name one', () => {
    expect(obj(registry.proposal_refused, 'proposal_refused').status).toBe(422);
    expect(obj(registry.policy_immutable, 'policy_immutable').status).toBe(422);
    expect(flat(props('Problem').member?.description)).toContain(
      'Only on `unsupported_policy_form` (rev 13) and on `proposal_refused` (rev 14'
    );
    expect(flat(props('Problem').code?.description)).toContain(
      'Only on `proposal_refused` (rev 14)'
    );
    expect(obj(registry.reserved_tool_ref, 'reserved_tool_ref').title).toContain(
      'tool:noblecloak:'
    );
  });

  it('puts proposal_refused on createApproval and policy_immutable on the three routes that take a policy body', () => {
    expect(responses.UnprocessableCreateApproval?.['x-noblecloak-problem-types']).toContain(
      'proposal_refused'
    );
    for (const [path, method] of [
      ['/v1/policies', 'post'],
      ['/v1/policies/{id}', 'put'],
      ['/v1/policies/simulate', 'post'],
    ] as const)
      expect(obj(obj(op(path, method).responses, 'responses')['422'], '422').$ref).toBe(
        '#/components/responses/UnprocessablePolicyWrite'
      );
    expect(responses.UnprocessablePolicyWrite?.['x-noblecloak-problem-types']).toEqual([
      'unsupported_policy_form',
      'policy_immutable',
    ]);
    // Publish takes no body, so it cannot meet a deployment-applied reference.
    expect(
      obj(obj(op('/v1/policies/{id}/publish', 'post').responses, 'responses')['422']).$ref
    ).toBe('#/components/responses/UnprocessablePolicyForm');
  });

  it('advertises the references a deployment applies, each with the schema of its arguments', () => {
    const member = obj(props('Capabilities').deployment_applied, 'deployment_applied');
    expect(member.type).toBe('array');
    const item = obj(member.items, 'items');
    expect(item.required).toEqual(['tool_ref', 'arguments_schema_ref']);
    expect(item.additionalProperties).toBe(false);
    expect(flat(member.description)).toContain('answered 422 `approval_unroutable`');
    const registered = obj(info['x-noblecloak-deployment-applied'], 'deployment-applied');
    const entry = obj(registered['tool:noblecloak:propose-policy-set'], 'propose-policy-set');
    expect(obj(entry.arguments, 'arguments').$ref).toBe('#/components/schemas/PolicySetProposal');
  });

  it('documents the last history entry of a refusal at approval, on HistoryEntry and on approve', () => {
    const reason = flat(props('HistoryEntry').reason?.description);
    expect(reason).toContain('`resolution: rejected`');
    expect(reason).toContain('`proposal_refused:<code>`');
    expect(reason).toContain('`policy_conflict`');
    expect(flat(op('/v1/approvals/{id}/approve', 'post').description)).toContain(
      'the answer is still 200, and the approval is `rejected`'
    );
    // No new member records it: the existing history entry does.
    expect(props('Approval')).not.toHaveProperty('resolution_reason');
  });

  it('tells createApproval and registerTool about the namespace', () => {
    expect(flat(op('/v1/approvals', 'post').description)).toContain(
      'is 422 `proposal_refused` with `code`'
    );
    expect(flat(op('/v1/tools', 'post').description)).toContain(
      '`tool:noblecloak:` is reserved on every deployment'
    );
    expect(flat(op('/v1/policies', 'post').description)).toContain('is 422 `policy_immutable`');
  });
});

describe('PolicySetProposal (rev 14)', () => {
  it('is closed, and needs 1 to 50 policies; at most 50 tools (rev 18 makes the agent optional)', () => {
    const schema = obj(schemas.PolicySetProposal, 'PolicySetProposal');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['policies']);
    expect(fits(proposal())).toBe(true);
    expect(fits({ ...proposal(), extra: 1 })).toBe(false);
    expect(fits({ ...proposal(), policies: [] })).toBe(false);
    const one = (proposal().policies as unknown[])[0];
    expect(fits({ ...proposal(), policies: Array.from({ length: 50 }, () => one) })).toBe(true);
    expect(fits({ ...proposal(), policies: Array.from({ length: 51 }, () => one) })).toBe(false);
    const tool = (proposal().tools as unknown[])[0];
    expect(fits({ ...proposal(), tools: Array.from({ length: 51 }, () => tool) })).toBe(false);
    expect(fits({ agent: { id: 'a' }, policies: [one] })).toBe(true);
  });

  it('takes ext: tools owned by the organisation only', () => {
    const tool = (patch: JsonObject): JsonObject => ({
      ...proposal(),
      tools: [{ ...(proposal().tools as JsonObject[])[0], ...patch }],
    });
    expect(fits(tool({ tool_ref: 'mcp:crm:update' }))).toBe(false);
    expect(fits(tool({ tool_ref: 'tool:noblecloak:x' }))).toBe(false);
    expect(fits(tool({ owner_kind: 'principal' }))).toBe(false);
    const withoutOwner = Object.fromEntries(
      Object.entries((proposal().tools as JsonObject[])[0] ?? {}).filter(
        ([key]) => key !== 'owner_kind'
      )
    );
    expect(fits({ ...proposal(), tools: [withoutOwner] })).toBe(false);
  });

  it('takes a role of baseline or tightening, a rationale of 1 to 500 characters and a closed assessment', () => {
    const entry = (patch: JsonObject): JsonObject => ({
      ...proposal(),
      policies: [{ ...(proposal().policies as JsonObject[])[0], ...patch }],
    });
    expect(fits(entry({ role: 'tightening' }))).toBe(true);
    expect(fits(entry({ role: 'loosening' }))).toBe(false);
    expect(fits(entry({ rationale: '' }))).toBe(false);
    expect(fits(entry({ rationale: 'x'.repeat(501) }))).toBe(false);
    expect(fits(entry({ rationale: 'x'.repeat(500) }))).toBe(true);
    const assessment = (patch: JsonObject): JsonObject =>
      entry({
        assessment: {
          ...((proposal().policies as JsonObject[])[0]?.assessment as JsonObject),
          ...patch,
        },
      });
    expect(fits(assessment({ blast_radius: 'everything' }))).toBe(false);
    expect(fits(assessment({ blast_radius: 'org_wide' }))).toBe(true);
    expect(fits(assessment({ financial: 'no' }))).toBe(false);
    expect(fits(assessment({ extra: true }))).toBe(false);
  });

  it('names every refusal code, with the member each carries, once', () => {
    const text = flat(obj(schemas.PolicySetProposal, 'PolicySetProposal').description);
    for (const code of [
      'not_a_user',
      'shape',
      'unknown_agent',
      'principal_bound',
      'tool_ref_in_use',
      'target_unknown',
      'baseline_exists',
      'tightening_looser',
    ])
      expect(text, code).toContain(`\`${code}\``);
    expect(text).toContain('`action.arguments.agent.id`');
    expect(text).toContain('`action.arguments.tools[<i>].tool_ref`');
    expect(text).toContain('exactly one subject, `{ type: role, id: everyone }`');
    expect(text).toContain('`{ type: agent, id: <agent.id> }`');
  });
});

describe('Approval.preview (rev 14)', () => {
  const preview = {
    simulations: [
      {
        tool_ref: 'ext:crm:update',
        result: { decision: 'step_up', action_digest: 'a'.repeat(64), enforced: false },
      },
    ],
    loosening: [{ tool_ref: 'ext:crm:update', from: 'ask', to: 'always_allow' }],
  };
  const approval = {
    id: 'apr_1',
    state: 'pending',
    tool_ref: 'tool:noblecloak:propose-policy-set',
    obligation_kind: 'tool_invocation',
    action_digest: 'a'.repeat(64),
    scope_id: 'scope_1',
    side_effect_level: 'admin',
    created_at: '2026-10-28T12:00:00Z',
  };
  const fitsApproval = (body: unknown): boolean => index.schema('Approval')(body);

  it('is optional, so a rev 13 approval still validates, and is closed when present', () => {
    expect(fitsApproval(approval)).toBe(true);
    expect(fitsApproval({ ...approval, preview })).toBe(true);
    expect(fitsApproval({ ...approval, preview: { ...preview, extra: 1 } })).toBe(false);
    expect(fitsApproval({ ...approval, preview: { simulations: preview.simulations } })).toBe(
      false
    );
    expect(
      fitsApproval({
        ...approval,
        preview: { ...preview, loosening: [{ tool_ref: 'x', from: 'ask', to: 'maybe' }] },
      })
    ).toBe(false);
  });

  it('says where it is read and that it is no part of arguments', () => {
    expect(flat(props('Approval').preview?.description)).toContain(
      'Present only on `GET /v1/approvals/{id}`, only while the approval is `pending`'
    );
    expect(flat(obj(schemas.ApprovalPreview, 'ApprovalPreview').description)).toContain(
      'It is no part of `arguments`'
    );
  });
});

describe('Capabilities.deployment_applied (rev 14)', () => {
  const capabilities = (extra: JsonObject): unknown => ({
    deployment: 'hosted',
    entitlements: [],
    jwks_uri: 'https://x.test/jwks',
    kids: [],
    resolutions: ['approved'],
    features: [],
    authzen_configuration: 'https://x.test/authzen',
    ...extra,
  });
  const fitsCapabilities = (body: unknown): boolean => index.schema('Capabilities')(body);

  it('is optional, and each entry names a reference in the namespace and a schema', () => {
    expect(fitsCapabilities(capabilities({}))).toBe(true);
    const entry = {
      tool_ref: 'tool:noblecloak:propose-policy-set',
      arguments_schema_ref: 'PolicySetProposal',
    };
    expect(fitsCapabilities(capabilities({ deployment_applied: [entry] }))).toBe(true);
    expect(fitsCapabilities(capabilities({ deployment_applied: [] }))).toBe(true);
    expect(
      fitsCapabilities(capabilities({ deployment_applied: [{ ...entry, tool_ref: 'ext:x' }] }))
    ).toBe(false);
    expect(
      fitsCapabilities(capabilities({ deployment_applied: [{ tool_ref: entry.tool_ref }] }))
    ).toBe(false);
  });
});
