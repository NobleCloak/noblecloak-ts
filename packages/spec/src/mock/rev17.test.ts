/**
 * The mock's rev 17 behaviour: it validates a request against the document's own schemas, so it accepts and echoes a
 * `claude_agent_sdk` continuation with `pull`, and refuses a kind the enum does not list and the new kind with `held` or `push`.
 * It advertises the document's kinds as `continuation_kinds` wherever it serves approvals.
 */
import { describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { createMock } from './app.js';

const spec = loadCommittedDocument();
type Json = Record<string, unknown>;
const correlation = { session_id: 's-1', tool_use_id: 'toolu-1', agent_id: 'a-1', mode: 'defer' };

describe('the mock, rev 17', () => {
  it('accepts a claude_agent_sdk continuation on POST /v1/approvals and echoes it unchanged to its creator', async () => {
    const mock = await createMock({ control: true, spec });
    const tokens = await mock.tokens();
    const send = (path: string, method: string, body?: unknown): Promise<Response> =>
      Promise.resolve(
        mock.app.request(path, {
          method,
          headers: {
            authorization: `Bearer ${tokens.creator_user}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      );
    const opened = await send('/v1/approvals', 'POST', {
      action: { tool_ref: 'mcp:tracker:create_issue', arguments: { title: 'rev17' } },
      continuation: { kind: 'claude_agent_sdk', delivery: 'pull', correlation },
    });
    expect(opened.status).toBe(201);
    const id = String((((await opened.json()) as Json).data as Json).id);
    const read = await send(`/v1/approvals/${id}`, 'GET');
    expect(read.status).toBe(200);
    const approval = ((await read.json()) as Json).data as Json;
    expect(approval.continuation).toEqual({
      kind: 'claude_agent_sdk',
      delivery: 'pull',
      correlation,
    });
  });

  it('refuses a kind the enum does not list with 400 invalid_request', async () => {
    const mock = await createMock({ control: true, spec });
    const tokens = await mock.tokens();
    const refused = await mock.app.request('/v1/approvals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.creator_user}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: { tool_ref: 'mcp:tracker:create_issue', arguments: { title: 'rev17-foo' } },
        continuation: { kind: 'foo', delivery: 'pull' },
      }),
    });
    expect(refused.status).toBe(400);
    expect(String(((await refused.json()) as Json).type)).toMatch(/invalid_request$/);
  });

  it('refuses claude_agent_sdk with held and with push, 400 invalid_request', async () => {
    const mock = await createMock({ control: true, spec });
    const tokens = await mock.tokens();
    for (const continuation of [
      { kind: 'claude_agent_sdk', delivery: 'held' },
      { kind: 'claude_agent_sdk', delivery: 'push', callback_url: 'https://example.com/cb' },
    ]) {
      const refused = await mock.app.request('/v1/approvals', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.creator_user}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: { tool_ref: 'mcp:tracker:create_issue', arguments: { title: 'rev17-pull-only' } },
          continuation,
        }),
      });
      expect(refused.status).toBe(400);
      expect(String(((await refused.json()) as Json).type)).toMatch(/invalid_request$/);
    }
  });

  it('advertises continuation_kinds as its document lists them wherever it serves approvals, and no feature for the kind', async () => {
    const capabilities = async (
      options: Parameters<typeof createMock>[0]
    ): Promise<{ features: string[]; continuation_kinds?: string[] }> => {
      const mock = await createMock({ control: true, ...options });
      const tokens = await mock.tokens();
      const res = await mock.app.request('/v1/capabilities', {
        headers: { authorization: `Bearer ${tokens.creator_user}` },
      });
      return ((await res.json()) as { data: { features: string[]; continuation_kinds?: string[] } })
        .data;
    };
    const kindsOf = (document: typeof spec): string[] =>
      (
        ((document.components as Json).schemas as Json).Continuation as {
          properties: { kind: { enum: string[] } };
        }
      ).properties.kind.enum;
    const eight = kindsOf(spec);
    expect(eight).toHaveLength(8);
    expect(eight).toContain('claude_agent_sdk');
    for (const deployment of ['hosted', 'edge'] as const) {
      const data = await capabilities({ spec, deployment });
      expect(data.continuation_kinds).toEqual(eight);
      expect(data.features.filter((f) => f.startsWith('continuations.'))).toEqual([]);
    }
    expect(await capabilities({ spec, advertise: ['runs'] })).not.toHaveProperty(
      'continuation_kinds'
    );
    const prior = loadCommittedDocument();
    const kind = (
      ((prior.components as Json).schemas as Json).Continuation as {
        properties: { kind: { enum: string[] } };
      }
    ).properties.kind;
    kind.enum = kind.enum.filter((k) => k !== 'claude_agent_sdk');
    expect((await capabilities({ spec: prior })).continuation_kinds).toEqual(eight.slice(0, 7));
  });
});
