/**
 * What rev 17 of the document says, as assertions: `Continuation.kind` gains `claude_agent_sdk`, the seven kinds
 * before it are unchanged, the enum stays closed, and the new kind is pull only, and its correlation is documented and stays opaque.
 * A deployment advertises the kinds it accepts as `Capabilities.continuation_kinds`.
 */
import { describe, expect, it } from 'vitest';

import { CONTINUATION_KINDS, REV16_CONTINUATION_KINDS } from '../conformance/types.js';
import { FEATURES } from './families.js';
import { loadSpec } from './load.js';
import type { JsonObject } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';
import { obj, str } from './testing.js';
import { SpecIndex } from './validate.js';

const doc = loadSpec(PUBLIC_SOURCE());
const schemas = (doc.components as JsonObject).schemas as Record<string, JsonObject>;
const continuation = obj(schemas.Continuation, 'Continuation');
const kindEnum = (obj(continuation.properties, 'properties').kind as JsonObject).enum as string[];
const flat = (text: unknown): string => str(text as never).replace(/\s+/g, ' ');
const index = new SpecIndex(doc);
const fits = (value: unknown): boolean => index.schema('Continuation')(value);

describe('the claude_agent_sdk continuation kind (rev 17)', () => {
  it('lists the seven earlier kinds in their order, then claude_agent_sdk, and no other', () => {
    expect(kindEnum).toEqual([
      'adk',
      'langgraph',
      'vercel_ai',
      'openai_agents',
      'webhook',
      'mcp_held',
      'agt',
      'claude_agent_sdk',
    ]);
  });

  it('accepts a claude_agent_sdk continuation with each correlation shape the connector sends', () => {
    expect(
      fits({
        kind: 'claude_agent_sdk',
        delivery: 'pull',
        correlation: { session_id: 's', tool_use_id: 't', mode: 'defer' },
      })
    ).toBe(true);
    expect(
      fits({
        kind: 'claude_agent_sdk',
        delivery: 'pull',
        correlation: { session_id: 's', tool_use_id: 't', agent_id: 'a', mode: 'retry' },
      })
    ).toBe(true);
    expect(fits({ kind: 'claude_agent_sdk', delivery: 'pull' })).toBe(true);
  });

  it('still refuses a kind outside the enum, and the kinds before it still validate', () => {
    expect(fits({ kind: 'foo', delivery: 'pull' })).toBe(false);
    expect(fits({ kind: 'claude-agent-sdk', delivery: 'pull' })).toBe(false);
    for (const kind of kindEnum.slice(0, 7)) expect(fits({ kind, delivery: 'pull' })).toBe(true);
  });

  it('ties claude_agent_sdk to pull: held and push are refused, and the other kinds keep every delivery', () => {
    expect(fits({ kind: 'claude_agent_sdk', delivery: 'held' })).toBe(false);
    expect(
      fits({ kind: 'claude_agent_sdk', delivery: 'push', callback_url: 'https://example.com/cb' })
    ).toBe(false);
    for (const kind of kindEnum.slice(0, 7)) {
      expect(fits({ kind, delivery: 'held' })).toBe(true);
      expect(fits({ kind, delivery: 'push', callback_url: 'https://example.com/cb' })).toBe(true);
    }
    expect(fits({ delivery: 'pull' })).toBe(false);
  });

  it('keeps the correlation opaque: the schema does not constrain its members', () => {
    const correlation = obj(obj(continuation.properties, 'properties').correlation, 'correlation');
    expect(correlation).toEqual({ type: 'object', additionalProperties: true });
    expect(fits({ kind: 'claude_agent_sdk', delivery: 'pull', correlation: { anything: 1 } })).toBe(
      true
    );
  });

  it('documents the correlation of the new kind and that the server does not read it', () => {
    const text = flat(continuation.description);
    expect(text).toContain(
      '`correlation` is `{ session_id, tool_use_id, agent_id?, mode }` with `mode` `defer` or `retry`'
    );
    expect(text).toContain('a missing `agent_id` means the main agent');
    expect(text).toContain('The server reads none of it');
    expect(text).toContain('used with `pull` only');
  });

  it('advertises the kinds as Capabilities.continuation_kinds, absent meaning the seven of rev 16, and as no feature', () => {
    const capabilities = obj(schemas.Capabilities, 'Capabilities');
    const properties = capabilities.properties as Record<string, JsonObject>;
    const member = obj(properties.continuation_kinds, 'continuation_kinds');
    expect(member.type).toBe('array');
    // Open-ended, as PolicyKind and ApprovalAction.kind are: a later revision's kind must not make a rev 17 kit fail
    // the capabilities read. The known values are the document's kinds, and no enum closes the items.
    const items = obj(member.items, 'continuation_kinds.items');
    expect(items.type).toBe('string');
    expect(items.enum).toBeUndefined();
    expect(items['x-noblecloak-known-values']).toEqual(kindEnum);
    // A deployment that serves approvals lists at least one kind, each once, as the rev 11 list members do.
    expect(member.minItems).toBe(1);
    expect(member.uniqueItems).toBe(true);
    expect(capabilities.required).not.toContain('continuation_kinds');
    const text = flat(member.description);
    expect(text).toContain('Absent means the seven kinds of rev 16 (`adk` … `agt`)');
    expect(text).toContain('A kind not accepted is 400 `invalid_request`');
    expect(text).toContain(
      'Open-ended: a client treats a kind it does not know as one it does not send.'
    );
    expect(flat(continuation.description)).toContain(
      'A deployment lists the kinds it accepts in `Capabilities.continuation_kinds`.'
    );
    // The feature flag an earlier draft of rev 17 had is gone, from the document and from the features a scenario may
    // require. Its name is spelled in parts so that no copy of it is left in the tree.
    const retired = ['continuations', 'claude_agent_sdk'].join('.');
    expect(JSON.stringify(doc)).not.toContain(retired);
    expect(FEATURES as readonly string[]).not.toContain(retired);
  });

  it('keeps the conformance list of kinds equal to the document, and the rev 16 list the same less claude_agent_sdk', () => {
    expect([...CONTINUATION_KINDS]).toEqual(kindEnum);
    expect([...REV16_CONTINUATION_KINDS]).toEqual(kindEnum.slice(0, 7));
  });
});
