/**
 * The mock's rev 17 behaviour: it validates a request against the document's own schemas, so it accepts and echoes a
 * `claude_agent_sdk` continuation with `pull`, and refuses a kind the enum does not list and the new kind with `held` or `push`.
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

  it('advertises continuations.claude_agent_sdk iff its document lists the kind and it serves approvals', async () => {
    const FEATURE = 'continuations.claude_agent_sdk';
    const features = async (options: Parameters<typeof createMock>[0]): Promise<string[]> => {
      const mock = await createMock({ control: true, ...options });
      const tokens = await mock.tokens();
      const res = await mock.app.request('/v1/capabilities', {
        headers: { authorization: `Bearer ${tokens.creator_user}` },
      });
      return ((await res.json()) as { data: { features: string[] } }).data.features;
    };
    expect(await features({ spec })).toContain(FEATURE);
    expect(await features({ spec, deployment: 'edge' })).toContain(FEATURE);
    expect(await features({ spec, advertise: ['runs'] })).not.toContain(FEATURE);
    const prior = loadCommittedDocument();
    const kind = (
      ((prior.components as Json).schemas as Json).Continuation as {
        properties: { kind: { enum: string[] } };
      }
    ).properties.kind;
    kind.enum = kind.enum.filter((k) => k !== 'claude_agent_sdk');
    expect(await features({ spec: prior })).not.toContain(FEATURE);
  });
});
