/**
 * What rev 17 of the document says, as assertions: `Continuation.kind` gains `claude_agent_sdk`, the seven kinds
 * before it are unchanged, the enum stays closed, and the correlation of the new kind is documented and stays opaque.
 */
import { describe, expect, it } from 'vitest';

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
  });
});
