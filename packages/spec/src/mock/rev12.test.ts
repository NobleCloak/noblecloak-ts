/**
 * The mock's rev 12 behaviour that the conformance scenarios cannot see: the union a preflight is answered
 * against, the refusal of an actual request after authentication, one signature shared by every subscriber,
 * and what raises an event.
 */
import { jcs } from '@noblecloak/client';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadCommittedDocument } from '../spec/testing.js';
import { verifyDeliverySignature } from '../conformance/verify-delivery.js';
import { createMock, DELIVERABLE_RESOLUTIONS, isDeliverableResolution } from './app.js';
import type { Mock } from './app.js';
import { isExactRegisteredOrigin } from './cors.js';

const spec = loadCommittedDocument();
const APP = 'https://app.example.test';
const OTHER = 'https://other.example.test';
type Json = Record<string, unknown>;

describe('isExactRegisteredOrigin', () => {
  it.each([
    ['https://app.example.test', true],
    ['https://app.example.test:8443', true],
    ['http://localhost:3000', true],
    ['http://127.0.0.1:8080', true],
    ['http://app.example.test', false],
    ['https://app.example.test/', false],
    ['https://app.example.test/x', false],
    ['https://app.example.test?x', false],
    ['https://app.example.test#x', false],
    ['https://u@app.example.test', false],
    ['https://*.example.test', false],
    ['https://app.example.test:443', false],
    ['HTTPS://APP.example.test', false],
    ['null', false],
    ['', false],
  ])('%j -> %s', (value, exact) => {
    expect(isExactRegisteredOrigin(value)).toBe(exact);
  });
});

describe('the mock, rev 12', () => {
  let mock: Mock;
  let tokens: Awaited<ReturnType<Mock['tokens']>>;
  beforeAll(async () => {
    mock = await createMock({ control: true, spec });
    tokens = await mock.tokens();
  });

  const call = async (
    token: string,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<Response> =>
    mock.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (response: Response): Promise<Json> => (await response.json()) as Json;
  const deliveriesOf = async (webhookId: string): Promise<Json[]> => {
    const response = await mock.app.request('/__mock/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveries: { webhook_id: webhookId } }),
    });
    return ((await json(response)).deliveries ?? []) as Json[];
  };
  const subscribe = async (events: string[]): Promise<string> => {
    const created = await call(tokens.admin, 'POST', '/v1/webhooks', {
      url: 'https://hooks.example.test/in',
      events,
    });
    expect(created.status).toBe(201);
    return String(((await json(created)).data as Json).id);
  };

  it('answers a preflight for an origin only another organisation registered, and an actual request of that other organisation is refused without CORS headers', async () => {
    expect((await call(tokens.admin, 'PUT', '/v1/origins', { origins: [APP] })).status).toBe(200);
    const preflight = await mock.app.request('/v1/origins', {
      method: 'OPTIONS',
      headers: { Origin: APP, 'Access-Control-Request-Method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(APP);

    const refused = await call(tokens.other_org, 'GET', '/v1/origins', undefined, { Origin: APP });
    expect(refused.status).toBe(403);
    expect((await json(refused)).type).toMatch(/\/forbidden$/);
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    expect(refused.headers.get('vary')).toContain('Origin');

    const served = await call(tokens.admin, 'GET', '/v1/origins', undefined, { Origin: APP });
    expect(served.status).toBe(200);
    expect(served.headers.get('access-control-allow-origin')).toBe(APP);
    expect((await call(tokens.other_org, 'GET', '/v1/origins')).status).toBe(200);
  });

  it('refuses a preflight for an origin nobody registered, and never reflects or stars', async () => {
    const response = await mock.app.request('/v1/origins', {
      method: 'OPTIONS',
      headers: { Origin: OTHER, 'Access-Control-Request-Method': 'GET' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('names the origin it refuses and changes nothing', async () => {
    await call(tokens.admin, 'PUT', '/v1/origins', { origins: [APP] });
    const refused = await call(tokens.admin, 'PUT', '/v1/origins', {
      origins: [OTHER, `${OTHER}/`],
    });
    expect(refused.status).toBe(400);
    expect(String((await json(refused)).detail)).toContain(`${OTHER}/`);
    expect(
      ((await json(await call(tokens.admin, 'GET', '/v1/origins'))).data as Json).origins
    ).toEqual([APP]);
  });

  it('gives every subscriber the same signature, and a body that names none', async () => {
    const first = await subscribe(['record.appended']);
    const second = await subscribe(['record.appended', 'approval.resolved']);
    const appended = await call(tokens.creator, 'POST', '/v1/records', {
      tool_ref: 'rr:shared',
      decision: 'allow',
    });
    expect(appended.status).toBe(201);
    const recordId = String(((await json(appended)).data as Json).id);
    const [a] = await deliveriesOf(first);
    const [b] = await deliveriesOf(second);
    expect(a).toBeDefined();
    expect(a).toEqual(b);
    expect(a?.subject).toBe(recordId);
    expect(a?.source).toBe(mock.config.audience);
    expect(JSON.stringify(a)).not.toContain(first);
    expect(JSON.stringify(a)).not.toContain(second);
    const jwks = mock.jwks();
    await expect(verifyDeliverySignature(String(a?.signature), jwks)).resolves.toBeUndefined();
    const unsigned = Object.fromEntries(
      Object.entries(a ?? {}).filter(([key]) => key !== 'signature')
    );
    const payload = String(a?.signature).split('.')[1] ?? '';
    expect(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).toBe(jcs(unsigned as never));
  });

  it('delivers only the events a webhook subscribes to', async () => {
    const policies = await subscribe(['policy.published']);
    await call(tokens.creator, 'POST', '/v1/records', { tool_ref: 'rr:other', decision: 'allow' });
    expect(await deliveriesOf(policies)).toEqual([]);
  });

  it('delivers nothing of another organisation, and the organisation its own event', async () => {
    const hook = await subscribe(['record.appended']);
    const foreign = await call(tokens.other_org, 'POST', '/v1/records', {
      tool_ref: 'rr:org2',
      decision: 'allow',
    });
    expect(foreign.status).toBe(201);
    expect(await deliveriesOf(hook)).toEqual([]);
    const own = await call(tokens.creator, 'POST', '/v1/records', {
      tool_ref: 'rr:org1',
      decision: 'allow',
    });
    const ownId = String(((await json(own)).data as Json).id);
    const delivered = await deliveriesOf(hook);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.subject).toBe(ownId);
  });

  it('owes a deleted webhook nothing: its queued deliveries go with it', async () => {
    const hook = await subscribe(['record.appended']);
    await call(tokens.creator, 'POST', '/v1/records', { tool_ref: 'rr:gone', decision: 'allow' });
    expect(await deliveriesOf(hook)).toHaveLength(1);
    expect((await call(tokens.admin, 'DELETE', `/v1/webhooks/${hook}`)).status).toBe(204);
    expect(await deliveriesOf(hook)).toEqual([]);
  });

  it('keeps the queue bounded, dropping the oldest deliveries first', async () => {
    const hook = await subscribe(['record.appended']);
    for (let i = 0; i < 1005; i++)
      await call(tokens.creator, 'POST', '/v1/records', {
        tool_ref: `rr:bound${String(i)}`,
        decision: 'allow',
      });
    expect((await deliveriesOf(hook)).length).toBeLessThanOrEqual(1000);
  });

  it('a control reset empties the outbox', async () => {
    const hook = await subscribe(['record.appended']);
    await call(tokens.creator, 'POST', '/v1/records', { tool_ref: 'rr:reset', decision: 'allow' });
    expect(await deliveriesOf(hook)).toHaveLength(1);
    await mock.app.request('/__mock/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    expect(await deliveriesOf(hook)).toEqual([]);
  });
});

describe('the deployment’s own origins, rev 12', () => {
  it('admits the mock module origin on an actual request from an organisation that registered nothing, and the preflight agrees', async () => {
    const mock = await createMock({ control: true, spec });
    const tokens = await mock.tokens();
    const origin = 'https://module.mock.test';
    const preflight = await mock.app.request('/v1/origins', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    const served = await mock.app.request('/v1/origins', {
      headers: { authorization: `Bearer ${tokens.other_org}`, Origin: origin },
    });
    expect(served.status).toBe(200);
    expect(served.headers.get('access-control-allow-origin')).toBe(origin);
  });
});

describe('the delivery guard for a resolution, rev 12', () => {
  it('delivers the three known resolutions and nothing else', () => {
    for (const known of ['approved', 'rejected', 'escalated'])
      expect(isDeliverableResolution(known)).toBe(true);
    expect(isDeliverableResolution('something_new')).toBe(false);
    expect(isDeliverableResolution('')).toBe(false);
  });

  it('is the WebhookResolution known values of the document', () => {
    const known = (
      (spec.components as Record<string, unknown>).schemas as Record<
        string,
        Record<string, unknown>
      >
    ).WebhookResolution;
    expect([...DELIVERABLE_RESOLUTIONS].sort()).toEqual(
      [...((known?.['x-noblecloak-known-values'] as string[] | undefined) ?? [])].sort()
    );
  });
});
