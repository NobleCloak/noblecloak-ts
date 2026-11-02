/**
 * What rev 5 of the document says, as assertions: the per-tool arguments setting and the one operation
 * that carries an approval's arguments, an optional `policy`, the two new refusals, and the pins.
 */
import { describe, expect, it } from 'vitest';

import { loadScenarios } from '../conformance/scenarios.js';
import { tokenFor } from '../conformance/engine.js';
import type { HttpStep, Target } from '../conformance/types.js';
import { loadSpec } from './load.js';
import type { JsonObject } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';
import { obj, str } from './testing.js';

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

describe('show_arguments_to_approvers', () => {
  it('is a boolean on Tool, ToolWrite (default false) and ToolPatch, and none of them requires it', () => {
    for (const name of ['Tool', 'ToolWrite', 'ToolPatch']) {
      expect(props(name).show_arguments_to_approvers, name).toMatchObject({ type: 'boolean' });
      expect(obj(schemas[name], name).required ?? [], name).not.toContain(
        'show_arguments_to_approvers'
      );
    }
    expect(props('ToolWrite').show_arguments_to_approvers).toMatchObject({ default: false });
    expect(obj(schemas.ToolWrite, 'ToolWrite').additionalProperties).toBe(false);
    expect(obj(schemas.ToolPatch, 'ToolPatch').additionalProperties).toBe(false);
  });

  it('states the arguments rule once in the description, with the 503 and the opener-only storage', () => {
    const text = flat((doc.info as JsonObject).description);
    expect(text).toContain('Who sees the arguments of an approval');
    expect(text).toContain(
      'The arguments shown are those of the request that opened the approval; a later matching request adds nothing'
    );
    expect(text).toContain('carried `arguments`, not `arg_digest`');
    expect(text).toContain('at the time of the read');
    expect(text).toContain('the operation is `GET /v1/approvals/{id}`');
    expect(text).toContain('503 `service_unavailable`, never the digest-only view');
    expect(text).toContain('turning it on later restores nothing');
    expect(text).toContain('never truncates them');
  });

  it('says on Approval.arguments that only the single read carries them, and drops "when policy permits"', () => {
    const text = flat(props('Approval').arguments?.description);
    expect(text).toContain('Present only on `GET /v1/approvals/{id}`');
    expect(JSON.stringify(doc)).not.toContain('only when policy permits');
    expect(flat(op('/v1/approvals/{id}', 'get').description)).toContain('on this operation only');
    for (const [path, method] of [
      ['/v1/decisions', 'post'],
      ['/v1/approvals', 'post'],
    ] as const)
      expect(flat(op(path, method).description), path).toContain('no `arguments`');
    expect(flat(obj(schemas.ApprovalHandle, 'ApprovalHandle').description)).toContain(
      'never carries `arguments`'
    );
  });
});

describe('policy is optional on Approval and Resumption', () => {
  it.each(['Approval', 'Resumption'])(
    '%s does not require policy and says what absent means',
    (name) => {
      const schema = obj(schemas[name], name);
      expect(schema.required as string[]).not.toContain('policy');
      expect(props(name).policy).toEqual({ $ref: '#/components/schemas/PolicyRef' });
      expect(flat(schema.description)).toContain('absent means no explicit policy matched');
      expect(flat(schema.description)).toContain('never synthesised and never null');
    }
  );
});

describe('the two named refusals', () => {
  it('registers approval_unroutable and tool_ref_in_use as 422', () => {
    expect(registry.approval_unroutable?.status).toBe(422);
    expect(registry.tool_ref_in_use?.status).toBe(422);
  });

  it('puts approval_unroutable on createApproval beside idempotency_key_reuse, and keeps rev 4 tool cases', () => {
    expect(op('/v1/approvals', 'post').responses).toMatchObject({
      '422': { $ref: '#/components/responses/UnprocessableCreateApproval' },
    });
    expect(responses.UnprocessableCreateApproval?.['x-noblecloak-problem-types']).toEqual([
      'idempotency_key_reuse',
      'approval_unroutable',
      // Rev 14: a deployment-applied proposal it refuses.
      'proposal_refused',
    ]);
    const post = flat(op('/v1/tools', 'post').description);
    expect(post).toContain(
      'The checks run in this order: reserved, system, in use, already registered'
    );
    expect(post).toContain('is 400 `invalid_request` (`POST` is not an upsert)');
    expect(post).toContain('409 `side_effect_level_downgrade`');
  });

  it('names approval_unroutable among the reasons a decision can give', () => {
    expect(flat(props('Decision').reason?.description)).toContain('approval_unroutable');
  });
});

describe('the pins', () => {
  it('states the ask rule in the vocabulary paragraph and on decide', () => {
    expect(flat((doc.info as JsonObject).description)).toContain(
      'A policy `ask` is `step_up` on every invocation channel'
    );
    expect(flat(op('/v1/decisions', 'post').description)).toContain(
      'A policy `ask` is `step_up` on every invocation channel'
    );
  });

  it('says a rejected approval has a Resumption with no resume_token', () => {
    const text = flat(op('/v1/approvals/{id}/resumption', 'get').description);
    expect(text).toContain('`resolution: rejected` and no `resume_token`');
    expect(text).toContain('An `approved` Resumption that carries a `resume_token`');
  });

  it('lets a deployment refuse a delivery or a resolution it does not serve', () => {
    expect(flat(registry.invalid_continuation?.title)).toContain('does not serve that delivery');
    expect(flat(obj(schemas.Continuation, 'Continuation').description)).toContain(
      'refuse a delivery it does not serve with 400 `invalid_continuation`'
    );
    expect(op('/v1/decisions', 'post').responses).toMatchObject({
      '400': { $ref: '#/components/responses/BadRequestCallback' },
    });
    expect(responses.BadRequestDecisionBatch?.['x-noblecloak-problem-types']).toEqual([
      'invalid_request',
      'batch_too_large',
      'callback_unroutable',
      'invalid_continuation',
    ]);
    expect(flat(op('/v1/approvals/{id}/resolve', 'post').description)).toContain(
      'refuse a resolution it does not serve'
    );
    expect(flat(props('Capabilities').resolutions?.description)).toContain('`escalated`');
  });

  it('says a deployment may restrict who registers or changes tools', () => {
    expect(flat((doc.info as JsonObject).description)).toContain('Who registers tools');
    expect(flat(op('/v1/tools', 'post').description)).toContain('403 `forbidden`');
    expect(flat(op('/v1/tools/{id}', 'patch').description)).toContain('403 `forbidden`');
  });
});

describe('registering tools as an administrator', () => {
  const scenarios = loadScenarios();
  const registersItsOwnTool = 'negative-service-principal-does-not-see-a-users-private-tool';

  it('no HTTP step, nested in a stream `during` block or not, writes a tool as the creator; a step with no `as` counts as the creator', () => {
    // AuthZEN steps are evaluations (`/access/v1/evaluation`) and cannot write a tool, so they are not inspected.
    const offenders: string[] = [];
    for (const scenario of scenarios) {
      for (const [i, step] of scenario.steps.entries()) {
        const requests: { at: string; step: HttpStep }[] = [];
        if ('request' in step) requests.push({ at: `step ${String(i + 1)}`, step });
        if ('stream_events' in step)
          for (const [j, nested] of step.stream_events.during.entries())
            requests.push({ at: `step ${String(i + 1)} during ${String(j + 1)}`, step: nested });
        for (const { at, step: http } of requests) {
          const { method, path } = http.request;
          if (!/^\/v1\/tools(\/|$)/.test(path) || !['POST', 'PATCH'].includes(method)) continue;
          const who = http.as ?? 'creator';
          // The one scenario about a service principal's own tool registers it as that principal, on a
          // deployment that lets any principal register (`tool_registration: any`).
          if (
            scenario.id === registersItsOwnTool &&
            scenario.tool_registration === 'any' &&
            who === 'creator'
          )
            continue;
          if (who === 'creator' || who === 'creator_user')
            offenders.push(`${scenario.id} ${at} (${method} ${path}) as ${who}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every POST /v1/tools body in the scenarios names owner_kind: org, except where the scenario is about whose a tool is', () => {
    // Since rev 6 a tool owned by a principal is visible to that principal and the administrators only,
    // so a scenario that registers one for others to use would depend on the default. The two scenarios
    // about that visibility, and the one about a reference held by a hidden tool, name `principal` on purpose.
    const aboutOwnership = new Set([
      'tools-principal-owned-hidden-from-colleagues',
      'negative-principal-owned-tool-read-by-colleague-is-404',
      'negative-hidden-tool-clash-is-one-refusal',
      'tools-principal-owned-seen-by-administrator-users-only',
      'negative-service-principal-does-not-see-a-users-private-tool',
    ]);
    const missing: string[] = [];
    for (const scenario of scenarios) {
      for (const [i, step] of scenario.steps.entries()) {
        if (!('request' in step) || step.request.method !== 'POST') continue;
        if (step.request.path !== '/v1/tools') continue;
        const body = step.request.body as Record<string, unknown> | undefined;
        const kind = body?.owner_kind;
        const allowed = aboutOwnership.has(scenario.id)
          ? kind === 'org' || kind === 'principal'
          : kind === 'org';
        if (!allowed) missing.push(`${scenario.id} step ${String(i + 1)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('an admin step uses --admin-token, and falls back to the creator token when none was given', () => {
    const base = { baseUrl: 'http://x', deployment: 'hosted' } as const;
    const fixtures = { proxied_tool: 'a', allow_tool: 'b', deny_tool: 'c', default_tool: 'd' };
    const without: Target = { ...base, fixtures, tokens: { creator: 'svc' } };
    const withAdmin: Target = { ...base, fixtures, tokens: { creator: 'svc', admin: 'adm' } };
    expect(tokenFor(without, 'admin')).toBe('svc');
    expect(tokenFor(withAdmin, 'admin')).toBe('adm');
    expect(tokenFor(withAdmin, undefined)).toBe('svc');
    expect(tokenFor(without, 'member')).toBeUndefined();
  });
});
