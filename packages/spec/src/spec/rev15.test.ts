/**
 * What rev 15 of the document says, as assertions: `Approval.available_actions` (`ApprovalAction`,
 * `ApprovalActionInput`) and the feature `approvals.available_actions`. Each addition is optional on the wire, so a
 * rev 14 approval that lacks it still validates. The passages about who may resolve an approval are rev 14's words,
 * and a test here holds three of them to what they said.
 */
import { describe, expect, it } from 'vitest';

import { FEATURES } from './families.js';
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
const required = (name: string): unknown => obj(schemas[name], name).required;
const index = new SpecIndex(doc);

describe('per-approval actions (rev 15)', () => {
  it('declares ApprovalActionInput as a closed object with four required members', () => {
    const schema = obj(schemas.ApprovalActionInput, 'ApprovalActionInput');
    expect(schema.additionalProperties).toBe(false);
    expect([...(required('ApprovalActionInput') as string[])].sort()).toEqual([
      'label',
      'name',
      'required',
      'type',
    ]);
    const members = props('ApprovalActionInput');
    expect(Object.keys(members).sort()).toEqual([
      'label',
      'max_length',
      'name',
      'required',
      'type',
    ]);
    expect(members.name).toMatchObject({ type: 'string', minLength: 1 });
    expect(members.label).toMatchObject({ type: 'string', minLength: 1 });
    expect(members.required).toMatchObject({ type: 'boolean' });
    expect(members.max_length).toMatchObject({ type: 'integer', minimum: 1 });
    expect(flat(schema.description)).toContain(
      'The input named `reason` fills `ResolveRequest.reason`; any other name is a member of `ResolveRequest.input`.'
    );
  });

  it('declares ApprovalAction as a closed object whose resolution is the closed ResolveResolution', () => {
    const schema = obj(schemas.ApprovalAction, 'ApprovalAction');
    expect(schema.additionalProperties).toBe(false);
    expect([...(required('ApprovalAction') as string[])].sort()).toEqual([
      'id',
      'inputs',
      'kind',
      'label',
    ]);
    const members = props('ApprovalAction');
    expect(Object.keys(members).sort()).toEqual(['id', 'inputs', 'kind', 'label', 'resolution']);
    expect(members.id).toMatchObject({ type: 'string', minLength: 1 });
    expect(members.label).toMatchObject({ type: 'string', minLength: 1 });
    expect(members.resolution?.$ref).toBe('#/components/schemas/ResolveResolution');
    expect(obj(members.inputs, 'inputs')).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/ApprovalActionInput' },
    });
    expect(schemas.ResolveResolution?.enum).toEqual(['approved', 'rejected', 'escalated']);
    expect(flat(members.resolution?.description)).toContain(
      'Present exactly when `kind` is `resolve`'
    );
  });

  it('carries no authoring marker on the public face, and names the known value of kind and of type', () => {
    for (const [schema, member, known] of [
      ['ApprovalAction', 'kind', ['resolve']],
      ['ApprovalActionInput', 'type', ['text']],
    ] as const) {
      const open = obj(props(schema)[member], member);
      expect(open.type).toBe('string');
      // The only extension left is the list of documented values; no `enum` closes the member.
      expect(Object.keys(open).filter((key) => key.startsWith('x-noblecloak-'))).toEqual([
        'x-noblecloak-known-values',
      ]);
      expect(open.enum).toBeUndefined();
      expect(open['x-noblecloak-known-values']).toEqual(known);
      expect(flat(open.description)).toContain('Open-ended');
    }
  });

  it('adds Approval.available_actions as an optional list of ApprovalAction, with its visibility stated', () => {
    expect(required('Approval')).not.toContain('available_actions');
    const member = obj(props('Approval').available_actions, 'available_actions');
    expect(member).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/ApprovalAction' },
    });
    const text = flat(member.description);
    expect(text).toContain('Present only on `GET /v1/approvals/{id}`');
    expect(text).toContain('only while the approval is `pending`');
    expect(text).toContain('only to a reader who may resolve it');
    expect(text).toContain('absent on every other representation (a list row, a stream event)');
    expect(text).toContain('`Capabilities.resolutions`');
    expect(text).toContain('Being listed is not authorisation');
  });

  it('names the feature in Capabilities.features and in the features a scenario may require', () => {
    const features = flat(props('Capabilities').features?.description);
    expect(features).toContain('`approvals.available_actions` (rev 15)');
    expect(FEATURES).toContain('approvals.available_actions');
  });

  it('keeps a rev 14 approval valid, and validates an approval that carries actions', () => {
    const approval = {
      id: 'apr_1',
      state: 'pending',
      tool_ref: 'ext:crm:update',
      obligation_kind: 'tool_invocation',
      action_digest: 'a'.repeat(64),
      scope_id: 'scope_1',
      side_effect_level: 'write',
      created_at: '2026-10-30T12:00:00Z',
    };
    const meta = { request_id: 'req_1', deployment: 'hosted' };
    const fits = (body: unknown): boolean => index.schema('ApprovalEnvelope')({ data: body, meta });
    const action = {
      id: 'approve',
      kind: 'resolve',
      label: 'Approve',
      resolution: 'approved',
      inputs: [{ name: 'reason', type: 'text', label: 'Note', required: false, max_length: 500 }],
    };
    expect(fits(approval)).toBe(true);
    expect(fits({ ...approval, available_actions: [action] })).toBe(true);
    expect(fits({ ...approval, available_actions: [] })).toBe(true);
    // A kind or an input type this document does not know is a value, not an error: the member is open.
    expect(
      fits({
        ...approval,
        available_actions: [{ ...action, kind: 'nudge', resolution: undefined }],
      })
    ).toBe(true);
    expect(
      fits({
        ...approval,
        available_actions: [
          { ...action, inputs: [{ ...(action.inputs[0] as object), type: 'choice' }] },
        ],
      })
    ).toBe(true);
    // Closed objects and the closed resolution.
    expect(fits({ ...approval, available_actions: [{ ...action, extra: 1 }] })).toBe(false);
    expect(fits({ ...approval, available_actions: [{ ...action, resolution: 'maybe' }] })).toBe(
      false
    );
    expect(fits({ ...approval, available_actions: [{ ...action, label: '' }] })).toBe(false);
    expect(fits({ ...approval, available_actions: [{ ...action, inputs: undefined }] })).toBe(
      false
    );
    expect(
      fits({
        ...approval,
        available_actions: [
          { ...action, inputs: [{ name: '', type: 'text', label: 'x', required: true }] },
        ],
      })
    ).toBe(false);
    expect(
      fits({
        ...approval,
        available_actions: [
          {
            ...action,
            inputs: [{ name: 'reason', type: 'text', label: 'x', required: true, max_length: 0 }],
          },
        ],
      })
    ).toBe(false);
  });

  it('leaves the passages about who may resolve an approval as rev 14 had them', () => {
    // Rev 15 does not touch the wording of these passages.
    expect(flat(info.description)).toContain('is never eligible to resolve it: 403 `not_eligible`');
    const resolve = obj(
      (paths['/v1/approvals/{id}/resolve'] as JsonObject).post,
      'resolveApproval'
    );
    expect(flat(resolve.description)).toContain(
      '403 `not_eligible` when the caller may not resolve it, which includes the principal that created the obligation'
    );
    const surface = flat(props('Capabilities').self_approval_from_approver_surface?.description);
    expect(surface).toContain(
      "the deployment's approver surface (the approvals module's own client)"
    );
  });
});
