/**
 * What rev 13 of the document says, as assertions: an agent is bound to one service principal, every caller holds
 * the reserved role `everyone`, a set of proposed policies is simulated without storing any, and
 * `unsupported_policy_form` names its member. Each addition is optional on the wire, so a rev 12 response that
 * lacks it still validates.
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
const flat = (text: unknown): string => str(text as never).replace(/\s+/g, ' ');
const op = (path: string, method: string): JsonObject =>
  obj((paths[path] as JsonObject)[method], `${method} ${path}`);
const props = (name: string): Record<string, JsonObject> =>
  obj(schemas[name], name).properties as Record<string, JsonObject>;
const index = new SpecIndex(doc);
const NOW = '2026-10-28T12:00:00Z';
const META = { request_id: 'req_1', deployment: 'hosted' };
const PROBLEM = {
  type: 'https://docs.noblecloak.com/problems/unsupported_policy_form',
  title: 't',
  status: 422,
  request_id: 'req_1',
};
const description = flat(obj(doc.info, 'info').description);
const registry = obj(obj(doc.info, 'info')['x-noblecloak-problem-types'], 'registry');

describe('agent identity (rev 13)', () => {
  it('states the binding, the hint and the approval once, for an outside reader', () => {
    const at = description.indexOf('**Agent identity (rev 13).**');
    expect(at).toBeGreaterThan(-1);
    const text = description.slice(at, at + 2400);
    expect(text).toContain('bound to at most one service principal');
    expect(text).toContain('a service principal is bound to at most one agent');
    expect(text).toContain('**only** through that binding');
    expect(text).toContain('`actor.agent_id` on a request never selects a policy');
    expect(text).toContain('the approval names the bound agent and the hint is ignored');
    expect(text).toContain('a service principal included, is 403 `forbidden`');
    expect(text).toContain('Agent policies only tighten');
  });

  it("says a run's agent_id never selects policy, on ActorHint, Run and createRun", () => {
    expect(flat(obj(schemas.ActorHint, 'ActorHint').description)).toContain(
      'the `agent_id` of the run it names never selects which policies apply to the call either (rev 13)'
    );
    expect(flat(props('Run').agent_id?.description)).toContain(
      'never selects which policies apply to a call that names the run (rev 13)'
    );
    expect(flat(op('/v1/runs', 'post').description)).toContain(
      "The run's `agent_id` never selects a policy (rev 13)"
    );
  });

  it('adds PUT and DELETE /v1/agents/{id}/principal to the agents family, for both deployments', () => {
    const bind = op('/v1/agents/{id}/principal', 'put');
    const unbind = op('/v1/agents/{id}/principal', 'delete');
    expect(bind.operationId).toBe('bindAgentPrincipal');
    expect(unbind.operationId).toBe('unbindAgentPrincipal');
    for (const operation of [bind, unbind]) {
      expect(operation['x-noblecloak-family']).toBe('agents');
      expect(operation['x-noblecloak-deployment']).toBe('both');
    }
    expect(Object.keys(obj(bind.responses, 'responses'))).toEqual(
      expect.arrayContaining(['200', '403', '404', '409'])
    );
    expect(Object.keys(obj(unbind.responses, 'responses'))).toEqual(
      expect.arrayContaining(['204', '403', '404'])
    );
    expect(flat(unbind.description)).toContain('Idempotent');
  });

  it('principal_bound is a 409 whose agent_id names the holder', () => {
    expect(registry.principal_bound).toMatchObject({ status: 409 });
    expect(flat(props('Problem').agent_id?.description)).toContain('principal_bound');
    const conflict = obj(
      obj(doc.components, 'components').responses,
      'responses'
    ).ConflictPrincipalBound;
    expect(conflict).toMatchObject({ 'x-noblecloak-problem-types': ['principal_bound'] });
  });

  it('Agent gains an optional nullable principal_id, and a rev 12 agent still validates', () => {
    expect(obj(schemas.Agent, 'Agent').required).not.toContain('principal_id');
    expect(props('Agent').principal_id).toMatchObject({ type: ['string', 'null'] });
    const validate = index.schema('AgentEnvelope');
    const rev12 = { id: 'agent_1', name: 'a', parent_id: null, created_at: NOW };
    expect(validate({ data: rev12, meta: META })).toBe(true);
    expect(validate({ data: { ...rev12, principal_id: null }, meta: META })).toBe(true);
    expect(validate({ data: { ...rev12, principal_id: 'svc_1' }, meta: META })).toBe(true);
    expect(validate({ data: { ...rev12, principal_id: 3 }, meta: META })).toBe(false);
  });

  it('the bind body is closed and needs a principal_id', () => {
    const validate = index.schema('AgentPrincipalWrite');
    expect(validate({ principal_id: 'svc_1' })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ principal_id: '' })).toBe(false);
    expect(validate({ principal_id: 'svc_1', org: 'x' })).toBe(false);
    // The id is the one a record and the directory carry, so a client can find it.
    const text = flat(props('AgentPrincipalWrite').principal_id?.description);
    expect(text).toContain('the `id` that `Record.actor` carries');
    expect(text).toContain('`GET /v1/principals` lists it under');
    expect(text).toContain('a principal of another organisation');
  });

  it('the hint is described as display only, on ActorHint and on createRun', () => {
    expect(flat(schemas.ActorHint?.description)).toContain('`agent_id` is a display hint (rev 13)');
    expect(flat(op('/v1/runs', 'post').description)).toContain('never selects a policy');
  });
});

describe('the reserved role everyone (rev 13)', () => {
  it('is stated once: held by every caller, a subject a policy may name, never assigned, listed or created', () => {
    const at = description.indexOf('**Reserved roles (rev 13).**');
    expect(at).toBeGreaterThan(-1);
    const text = description.slice(at, at + 1800);
    expect(text).toContain('Every caller of an organisation holds the role `everyone`');
    expect(text).toContain('`{ type: role, id: everyone }`');
    expect(text).toContain('never lets it be assigned');
    expect(text).toContain('`GET /v1/principals?type=role` omits it');
    expect(text).toContain('the rule covers every form');
    expect(text).toContain('or by a `display_name` of `everyone`, in any case');
    expect(text).toContain('never lets it be created');
    expect(text).toContain('The word `default` is not a role');
  });

  it('a role policy subject may name it, and the simulation text amends "no user\'s or role\'s"', () => {
    expect(flat(schemas.PolicySubject?.description)).toContain('reserved role `everyone` (rev 13)');
    const text = flat(op('/v1/policies/{id}/simulate', 'post').description);
    expect(text).toContain('plus the `everyone` role (rev 13)');
    expect(text).not.toContain("and no user's or role's");
    // The organisation subject is the organisation alone: it does not hold `everyone`.
    expect(text).toContain(
      'Every holder of a subject other than the organisation also holds `everyone` (rev 13)'
    );
    expect(text).not.toContain('Every holder of a subject also holds');
  });

  it('the source of a default is told apart from the role', () => {
    const considered = obj(schemas.ConsideredPolicies, 'ConsideredPolicies');
    const items = obj(obj(considered.properties, 'p').policies, 'policies').items as JsonObject;
    const source = obj(obj(items.properties, 'p').source, 'source');
    expect(flat(source.description)).toContain('the reserved role is `everyone`');
  });
});

describe('simulating a set (rev 13)', () => {
  it('adds POST /v1/policies/simulate to the policies family, for both deployments, naming no stored policy', () => {
    const operation = op('/v1/policies/simulate', 'post');
    expect(operation.operationId).toBe('simulatePolicySet');
    expect(operation['x-noblecloak-family']).toBe('policies');
    expect(operation['x-noblecloak-deployment']).toBe('both');
    const text = flat(operation.description);
    expect(text).toContain('when nothing is published yet');
    expect(text).toContain('never replaces a stored policy');
    expect(text).toContain('`proposed_index`');
    expect(text).toContain('The route writes nothing');
  });

  it('the body is closed, needs 1 to 100 policies and an action, and takes the optional members of a simulation', () => {
    const body = obj(schemas.SimulateSetRequest, 'SimulateSetRequest');
    expect(body.additionalProperties).toBe(false);
    expect(body.required).toEqual(['policies', 'action']);
    expect(Object.keys(props('SimulateSetRequest'))).toEqual([
      'policies',
      'actor',
      'action',
      'resource',
      'context',
      'subject',
    ]);
    expect(props('SimulateSetRequest').policies).toMatchObject({ minItems: 1, maxItems: 100 });
    const validate = index.schema('SimulateSetRequest');
    const policy = {
      kind: 'tool_invocation',
      subjects: [{ type: 'role', id: 'everyone' }],
      config: { mode: 'always_allow' },
    };
    const action = { tool_ref: 'ext:t', arguments: {} };
    expect(validate({ policies: [policy], action })).toBe(true);
    expect(validate({ policies: [], action })).toBe(false);
    expect(validate({ policies: [policy] })).toBe(false);
    expect(validate({ policies: [policy], action, extra: 1 })).toBe(false);
    expect(validate({ policies: Array.from({ length: 101 }, () => policy), action })).toBe(false);
  });

  it('a considered entry of a proposed body has a null id and version and proposed_index; a rev 12 entry validates', () => {
    const validate = index.schema('SimulateEnvelope');
    const result = (entry: unknown): unknown => ({
      data: {
        decision: 'allow',
        action_digest: 'a'.repeat(64),
        enforced: false,
        considered: { policies: [entry], composed: { decision: 'allow' } },
      },
      meta: META,
    });
    const proposed = { kind: 'tool_invocation', id: null, version: null, result: 'always_allow' };
    expect(validate(result({ ...proposed, proposed_index: 0 }))).toBe(true);
    expect(validate(result({ ...proposed, proposed_index: -1 }))).toBe(false);
    // A rev 12 default and a rev 12 stored entry carry no proposed_index.
    expect(validate(result({ ...proposed, source: 'default' }))).toBe(true);
    expect(validate(result({ ...proposed, id: 'pol_1', version: 1 }))).toBe(true);
    const items = obj(
      obj(obj(schemas.ConsideredPolicies, 'c').properties, 'p').policies,
      'policies'
    ).items as JsonObject;
    expect(items.required).toEqual(['kind', 'id', 'version', 'result']);
  });

  it('an entry is a default or a proposed body, never both', () => {
    const validate = index.schema('SimulateEnvelope');
    const result = (entry: unknown): unknown => ({
      data: {
        decision: 'allow',
        action_digest: 'a'.repeat(64),
        enforced: false,
        considered: { policies: [entry], composed: { decision: 'allow' } },
      },
      meta: META,
    });
    const base = { kind: 'tool_invocation', id: null, version: null, result: 'always_allow' };
    expect(validate(result({ ...base, source: 'default' }))).toBe(true);
    expect(validate(result({ ...base, proposed_index: 1 }))).toBe(true);
    expect(validate(result({ ...base, source: 'default', proposed_index: 1 }))).toBe(false);
  });

  it('the entry stays closed under rejectUndeclared: its `not` declares no member', () => {
    const closed = new SpecIndex(doc, { rejectUndeclared: true }).schema('SimulateEnvelope');
    const result = (entry: unknown): unknown => ({
      data: {
        decision: 'allow',
        action_digest: 'a'.repeat(64),
        enforced: false,
        considered: { policies: [entry], composed: { decision: 'allow' } },
      },
      meta: META,
    });
    const base = { kind: 'tool_invocation', id: null, version: null, result: 'always_allow' };
    expect(closed(result({ ...base, proposed_index: 0 }))).toBe(true);
    expect(closed(result({ ...base, proposed_index: 0, surprise: 1 }))).toBe(false);
  });
});

describe('the member of an unsupported_policy_form (rev 13)', () => {
  it('Problem gains an optional member, and a rev 12 problem without it validates', () => {
    expect(props('Problem').member).toMatchObject({ type: 'string', minLength: 1 });
    expect(obj(schemas.Problem, 'Problem').required).not.toContain('member');
    const validate = index.schema('Problem');
    expect(validate(PROBLEM)).toBe(true);
    expect(validate({ ...PROBLEM, member: 'policies[2].subjects[0].type' })).toBe(true);
    expect(validate({ ...PROBLEM, member: '' })).toBe(false);
  });

  it('member has a grammar: dotted names and decimal indexes, starting at a top-level member', () => {
    const validate = index.schema('Problem');
    for (const member of ['policies[2].subjects[0].type', 'config.mode', 'subject'])
      expect(validate({ ...PROBLEM, member }), member).toBe(true);
    for (const member of ['a..b', '[0]', 'policies[x]'])
      expect(validate({ ...PROBLEM, member }), member).toBe(false);
  });

  it('says member names it, with detail as the rev 12 fallback, where the text used to say detail names it', () => {
    for (const text of [
      flat(obj(registry.unsupported_policy_form, 'entry').title),
      flat(op('/v1/policies', 'post').description),
      flat(op('/v1/policies/{id}/simulate', 'post').description),
      flat(
        obj(
          obj(obj(doc.components, 'components').responses, 'responses').UnprocessablePolicyForm,
          'UnprocessablePolicyForm'
        ).description
      ),
    ]) {
      expect(text).toContain('member');
      expect(text).not.toMatch(/`detail` names (the member|`subject`)/);
    }
  });
});
