/**
 * What rev 12 of the document says, as assertions: how registered browser origins govern CORS, who administers
 * origins and webhooks, and what a webhook delivery is (a signed CloudEvent with thin data). `Webhook.secret`
 * is gone, and a rev 11 response that still carries it validates.
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
const NOW = '2026-10-24T12:00:00Z';

const delivery = (type: string, data: unknown, subject = 'id_1'): Record<string, unknown> => ({
  specversion: '1.0',
  id: 'evt_1',
  type,
  source: 'https://govern.example.test',
  subject,
  time: NOW,
  datacontenttype: 'application/json',
  data,
  signature: 'a.b.c',
});
const RESOLVED = {
  approval_id: 'apr_1',
  state: 'approved',
  resolution: 'approved',
  resolved_at: NOW,
  tool_ref: 'ext:t',
};
const APPENDED = { record_id: 'rec_1', tool_ref: 'ext:t', decision: 'allow', ts: NOW };
const PUBLISHED = { policy_id: 'pol_1', kind: 'tool_invocation', version: 2, published_at: NOW };

describe('browser origins (rev 12)', () => {
  const description = flat(obj(doc.info, 'info').description);

  it('states the preflight model, the actual-request check and the exact-origin rule once', () => {
    const at = description.indexOf('**Browser origins (rev 12).**');
    expect(at).toBeGreaterThan(-1);
    const text = description.slice(at, at + 2600);
    expect(text).toContain('union of the deployment');
    expect(text).toContain("every organisation's registered origins");
    expect(text).toContain('never reveals which organisation registered an origin');
    expect(text).toContain('403 `forbidden`');
    expect(text).toContain('carries no `Access-Control-Allow-Origin`');
    expect(text).toContain('house origins');
    expect(text).toContain('`PUT` replaces the whole set');
    expect(text).toContain('no path, query, fragment, trailing slash, userinfo or wildcard');
    expect(text).toContain('`http` only for `localhost` and `127.0.0.1`');
    expect(text).toContain('it does not strip a slash');
  });

  it('putOrigins is for administrators, declares 403, and getOrigins stays open', () => {
    expect(flat(op('/v1/origins', 'put').description)).toContain(
      'administrator of the organisation (rev 12)'
    );
    expect(Object.keys(obj(op('/v1/origins', 'put').responses, 'responses'))).toContain('403');
    expect(flat(op('/v1/origins', 'get').description)).toContain('Open to any principal');
  });

  it('a registered origin is exact in the schema too, and the read schema stays loose', () => {
    const validate = index.schema('OriginsWrite');
    for (const origin of [
      'https://app.example.com',
      'https://app.example.com:8443',
      'http://localhost:3000',
      'http://127.0.0.1',
    ])
      expect(validate({ origins: [origin] }), origin).toBe(true);
    for (const origin of [
      'https://app.example.com/',
      'https://app.example.com/app',
      'https://app.example.com?x=1',
      'https://app.example.com#x',
      'https://user@app.example.com',
      'https://*.example.com',
      'http://app.example.com',
      'ftp://app.example.com',
    ])
      expect(validate({ origins: [origin] }), origin).toBe(false);
    // A rev 11 deployment may still return a stored origin with a trailing slash.
    expect(index.schema('Origins')({ origins: ['https://app.example.com/'] })).toBe(true);
  });
});

describe('webhooks (rev 12)', () => {
  it('no longer declares a secret, adds an open state, and still accepts a rev 11 response with a secret', () => {
    expect(props('Webhook').secret).toBeUndefined();
    expect(props('Webhook').state).toMatchObject({
      type: 'string',
      'x-noblecloak-known-values': ['active', 'disabled'],
    });
    expect(props('Webhook').state?.enum).toBeUndefined();
    expect(obj(schemas.Webhook, 'Webhook').additionalProperties).toBeUndefined();
    const validate = index.schema('Webhook');
    const base = {
      id: 'wh_1',
      url: 'https://hooks.example.com',
      events: ['record.appended'],
      created_at: NOW,
    };
    expect(validate({ ...base, secret: 'whsec_x' })).toBe(true);
    expect(validate({ ...base })).toBe(true);
    expect(validate({ ...base, state: 'disabled' })).toBe(true);
    const response = index.schema('WebhookEnvelope');
    expect(
      response({
        data: { ...base, secret: 'whsec_x' },
        meta: { request_id: 'req_1', deployment: 'hosted' },
      })
    ).toBe(true);
  });

  it('the state is a plain string that lists its known values', () => {
    expect(flat(props('Webhook').state?.description)).toContain('Known values: active | disabled.');
  });

  it('creating, listing and deleting are an administrator', () => {
    for (const [path, method] of [
      ['/v1/webhooks', 'get'],
      ['/v1/webhooks', 'post'],
      ['/v1/webhooks/{id}', 'delete'],
    ] as const) {
      const operation = op(path, method);
      expect(flat(operation.description), `${method} ${path}`).toContain(
        'administrator of the organisation (rev 12)'
      );
      expect(Object.keys(obj(operation.responses, 'responses')), `${method} ${path}`).toContain(
        '403'
      );
    }
  });

  it('createWebhook describes the delivery once: body, signature, header, retries, disabling, ordering', () => {
    const text = flat(op('/v1/webhooks', 'post').description);
    for (const phrase of [
      '`Content-Type: application/cloudevents+json`',
      'JWS compact serialization (ES256, `kid` in the header)',
      'JCS form of the object without `signature`',
      '/.well-known/jwks.json',
      'one signature per event, shared by every subscriber',
      '`NobleCloak-Webhook-Id`',
      'Any 2xx response means delivered',
      'at least 24 hours',
      '72 hours',
      '`disabled`',
      'delete it and create it anew',
      'not ordered',
      'dedupes on the event `id`',
    ])
      expect(text, phrase).toContain(phrase);
  });

  it('the document describes a delivery as a top-level webhook with the subscription header', () => {
    const webhooks = obj(doc.webhooks, 'webhooks');
    const post = obj(obj(webhooks.webhookDelivery, 'webhookDelivery').post, 'post');
    const headers = (post.parameters as JsonObject[]).filter((p) => p.in === 'header');
    expect(headers.map((p) => p.name)).toEqual(['NobleCloak-Webhook-Id']);
    expect(JSON.stringify(post.requestBody)).toContain('#/components/schemas/WebhookDelivery');
    expect(Object.keys(obj(post.responses, 'responses'))).toEqual(['2XX']);
  });
});

describe('WebhookDelivery (rev 12)', () => {
  const validate = index.schema('WebhookDelivery');

  it('accepts each event with exactly its thin data', () => {
    expect(validate(delivery('approval.resolved', RESOLVED, 'apr_1'))).toBe(true);
    expect(validate(delivery('record.appended', APPENDED, 'rec_1'))).toBe(true);
    expect(validate(delivery('policy.published', PUBLISHED, 'pol_1'))).toBe(true);
  });

  it("ties data to type: an event carrying another event's data is refused", () => {
    expect(validate(delivery('record.appended', RESOLVED, 'rec_1'))).toBe(false);
    expect(validate(delivery('approval.resolved', PUBLISHED, 'apr_1'))).toBe(false);
    expect(validate(delivery('policy.published', APPENDED, 'pol_1'))).toBe(false);
  });

  it('tolerates members added to the data, as a client must; the thin members are server conformance (webhook-delivery-thin)', () => {
    expect(validate(delivery('approval.resolved', { ...RESOLVED, added: 1 }))).toBe(true);
    expect(validate(delivery('record.appended', { ...APPENDED, added: 1 }))).toBe(true);
    expect(validate(delivery('policy.published', { ...PUBLISHED, added: 1 }))).toBe(true);
  });

  it('types the resolution as the open webhook enum', () => {
    expect(validate(delivery('approval.resolved', { ...RESOLVED, resolution: 'later' }))).toBe(
      true
    );
  });

  it('refuses data missing a member, an unsigned body and a spec version other than 1.0', () => {
    const without = (value: Record<string, unknown>, member: string): Record<string, unknown> =>
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== member));
    expect(validate(delivery('approval.resolved', without(RESOLVED, 'tool_ref')))).toBe(false);
    expect(validate(without(delivery('record.appended', APPENDED), 'signature'))).toBe(false);
    expect(validate({ ...delivery('record.appended', APPENDED), specversion: '0.3' })).toBe(false);
  });

  it('names no subscriber and no secret anywhere in the schema', () => {
    const text = JSON.stringify([
      schemas.WebhookDelivery,
      schemas.ApprovalResolvedData,
      schemas.RecordAppendedData,
      schemas.PolicyPublishedData,
    ]);
    expect(text).not.toContain('webhook_id');
    expect(text).not.toContain('"arguments"');
    expect(text).not.toContain('secret');
  });
});
