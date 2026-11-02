/**
 * The mock's rev 15 behaviour that the conformance scenarios do not read: the actions it lists (approve and deny,
 * each with the optional note), who sees them (the single read of a pending approval, by a reader who may resolve
 * it, and nobody else on any other representation), the feature it advertises and the break that shows them to all.
 */
import { describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { createMock } from './app.js';
import type { Mock, MockOptions } from './app.js';

const spec = loadCommittedDocument();
type Json = Record<string, unknown>;
const FEATURE = 'approvals.available_actions';

const make = async (
  options: Partial<MockOptions> = {}
): Promise<{
  mock: Mock;
  tokens: Awaited<ReturnType<Mock['tokens']>>;
  call: (token: string, method: string, path: string, body?: unknown) => Promise<Response>;
  open: () => Promise<{ id: string; digest: string }>;
  read: (token: string, id: string) => Promise<Json>;
}> => {
  const mock = await createMock({ control: true, spec, ...options });
  const tokens = await mock.tokens();
  let n = 0;
  const call = (token: string, method: string, path: string, body?: unknown): Promise<Response> =>
    Promise.resolve(
      mock.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
  const data = async (response: Response): Promise<Json> =>
    ((await response.json()) as Json).data as Json;
  const read = async (token: string, id: string): Promise<Json> =>
    data(await call(token, 'GET', `/v1/approvals/${id}`));
  const open = async (): Promise<{ id: string; digest: string }> => {
    n += 1;
    const answer = await call(tokens.creator_user, 'POST', '/v1/approvals', {
      action: {
        tool_ref: 'mcp:tracker:create_issue',
        arguments: { title: `actions ${String(n)}` },
      },
      continuation: { kind: 'langgraph', delivery: 'pull' },
    });
    expect(answer.status).toBe(201);
    const id = String((await data(answer)).id);
    return { id, digest: String((await read(tokens.approver, id)).action_digest) };
  };
  return { mock, tokens, call, open, read };
};

describe('the mock, rev 15', () => {
  it('lists approve and deny to an approver on the single read of a pending approval, each with the note as reason', async () => {
    const { tokens, open, read } = await make();
    const { id } = await open();
    const actions = (await read(tokens.approver, id)).available_actions as Json[];
    expect(actions.map((a) => [a.kind, a.resolution])).toEqual([
      ['resolve', 'approved'],
      ['resolve', 'rejected'],
    ]);
    expect(new Set(actions.map((a) => a.id)).size).toBe(2);
    for (const action of actions) {
      expect(typeof action.label).toBe('string');
      const inputs = action.inputs as Json[];
      expect(inputs.map(({ label, ...rest }) => [typeof label, rest])).toEqual([
        ['string', { name: 'reason', type: 'text', required: false }],
      ]);
    }
  });

  it('offers only the resolutions that it serves', async () => {
    const { tokens, open, read } = await make({ resolutions: ['approved'] });
    const { id } = await open();
    const actions = (await read(tokens.approver, id)).available_actions as Json[];
    expect(actions.map((a) => a.resolution)).toEqual(['approved']);
  });

  it('omits the member, rather than sending it empty, when it serves no resolution that has an action', async () => {
    const { tokens, open, read } = await make({ resolutions: ['escalated'] });
    const { id } = await open();
    expect(await read(tokens.approver, id)).not.toHaveProperty('available_actions');
  });

  it('lists none to the creator, to a member who may not resolve it, on a list row, on a stream event, or once it is resolved', async () => {
    const { mock, tokens, call, open, read } = await make();
    const { id, digest } = await open();
    expect(await read(tokens.creator_user, id)).not.toHaveProperty('available_actions');
    expect(await read(tokens.member, id)).not.toHaveProperty('available_actions');
    // The reads above decide on eligibility; a row of the list is not a single read, for an approver too.
    const list = (await (await call(tokens.approver, 'GET', '/v1/approvals?limit=200')).json()) as {
      data: Json[];
    };
    const row = list.data.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('available_actions');
    // Stream events for the same approver. A resolution sends the approval, and so does an escalation, which keeps
    // it pending: only the second event is one that the pending gate alone does not already keep clear.
    const response = await mock.app.request('/v1/approvals/stream', {
      headers: { authorization: `Bearer ${tokens.approver}` },
    });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const second = await open();
    const third = await open();
    expect(
      (
        await call(tokens.approver, 'POST', `/v1/approvals/${second.id}/approve`, {
          expected_action_digest: second.digest,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await call(tokens.approver, 'POST', `/v1/approvals/${third.id}/resolve`, {
          resolution: 'escalated',
          expected_action_digest: third.digest,
        })
      ).status
    ).toBe(200);
    const decoder = new TextDecoder();
    const events = new Map<string, Json>();
    let buffer = '';
    try {
      for (let i = 0; i < 20 && events.size < 2; i += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
        for (const frame of buffer.split('\n\n')) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line === undefined) continue;
          try {
            const parsed = JSON.parse(line.slice(6)) as Json;
            if (parsed.id === second.id || parsed.id === third.id) events.set(parsed.id, parsed);
          } catch {
            // an incomplete frame: wait for the rest
          }
        }
      }
    } finally {
      await reader.cancel();
    }
    const approvedEvent = events.get(second.id);
    const escalatedEvent = events.get(third.id);
    expect(approvedEvent?.state).not.toBe('pending');
    expect(approvedEvent).not.toHaveProperty('available_actions');
    expect(escalatedEvent?.state).toBe('pending');
    expect(escalatedEvent).not.toHaveProperty('available_actions');
    // Resolved: the approver's own single read no longer lists them.
    const approved = await call(tokens.approver, 'POST', `/v1/approvals/${id}/approve`, {
      expected_action_digest: digest,
    });
    expect(approved.status).toBe(200);
    const resolved = await read(tokens.approver, id);
    expect(resolved.state).not.toBe('pending');
    expect(resolved).not.toHaveProperty('available_actions');
  });

  it('lists none to an approver whose token lacks the resolve scope, which resolving would refuse', async () => {
    const { tokens, call, open, read } = await make();
    const { id, digest } = await open();
    const token = tokens.approver_token_without_resolve_scope;
    expect(await read(token, id)).not.toHaveProperty('available_actions');
    const refused = await call(token, 'POST', `/v1/approvals/${id}/approve`, {
      expected_action_digest: digest,
    });
    expect(refused.status).toBe(403);
    expect(await read(tokens.approver, id)).toHaveProperty('available_actions');
  });

  it('with available_actions_shown_to_all, lists them to the creator and a member, and still not on a list row', async () => {
    const { tokens, call, open, read } = await make({
      breaks: new Set(['available_actions_shown_to_all' as const]),
    });
    const { id } = await open();
    expect(await read(tokens.creator_user, id)).toHaveProperty('available_actions');
    expect(await read(tokens.member, id)).toHaveProperty('available_actions');
    expect(await read(tokens.approver_token_without_resolve_scope, id)).toHaveProperty(
      'available_actions'
    );
    const list = (await (
      await call(tokens.creator_user, 'GET', '/v1/approvals?created_by=me&limit=1')
    ).json()) as { data: Json[] };
    expect(list.data[0]).not.toHaveProperty('available_actions');
  });

  it('with available_actions_shown_when_resolved, still lists them to the approver once the approval is resolved, and to nobody else', async () => {
    const { tokens, call, open, read } = await make({
      breaks: new Set(['available_actions_shown_when_resolved' as const]),
    });
    const { id, digest } = await open();
    const approved = await call(tokens.approver, 'POST', `/v1/approvals/${id}/approve`, {
      expected_action_digest: digest,
    });
    expect(approved.status).toBe(200);
    const resolved = await read(tokens.approver, id);
    expect(resolved.state).not.toBe('pending');
    expect(resolved).toHaveProperty('available_actions');
    expect(await read(tokens.member, id)).not.toHaveProperty('available_actions');
    expect(await read(tokens.creator_user, id)).not.toHaveProperty('available_actions');
  });

  it('with available_actions_shown_without_resolve_scope, lists them to the approver whose token lacks the scope, and still not to the creator or a member', async () => {
    const { tokens, open, read } = await make({
      breaks: new Set(['available_actions_shown_without_resolve_scope' as const]),
    });
    const { id } = await open();
    expect(await read(tokens.approver_token_without_resolve_scope, id)).toHaveProperty(
      'available_actions'
    );
    expect(await read(tokens.member, id)).not.toHaveProperty('available_actions');
    expect(await read(tokens.creator_user, id)).not.toHaveProperty('available_actions');
  });

  it('with available_actions_shown_to_members, lists them to a member who is not eligible, and still not to the creator', async () => {
    const { tokens, open, read } = await make({
      breaks: new Set(['available_actions_shown_to_members' as const]),
    });
    const { id } = await open();
    expect(await read(tokens.member, id)).toHaveProperty('available_actions');
    expect(await read(tokens.creator_user, id)).not.toHaveProperty('available_actions');
    expect(await read(tokens.approver_token_without_resolve_scope, id)).not.toHaveProperty(
      'available_actions'
    );
  });

  it('advertises the feature wherever it serves approvals, on either deployment, and not when it serves none', async () => {
    const features = async (options: Partial<MockOptions>): Promise<string[]> => {
      const { tokens, call } = await make(options);
      return (
        ((await (await call(tokens.creator, 'GET', '/v1/capabilities')).json()) as Json).data as {
          features: string[];
        }
      ).features;
    };
    expect(await features({})).toContain(FEATURE);
    expect(await features({ deployment: 'edge' })).toContain(FEATURE);
    expect(await features({ advertise: ['runs'] })).not.toContain(FEATURE);
  });
});
