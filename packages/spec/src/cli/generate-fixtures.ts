/**
 * Regenerates `fixtures/resumption/*`: signed Resumptions, valid and broken on purpose, with the key
 * set and the exact canonical payload bytes, so a verifier in any language can check itself against
 * them. Each run uses throwaway keys; only public keys and signatures are written.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { jcs } from '@noblecloak/client';
import type { JsonValue } from '@noblecloak/client';

import { base64Url, generateSigningKey, jwksOf, signJws } from '../mock/jws.js';
import { packageRoot } from '../spec/paths.js';

const OUT = resolve(packageRoot(), 'fixtures/resumption');
const NOW = '2026-10-04T12:00:00.000Z';
const TOOL = 'mcp:tracker:create_issue';
const ARGS_DIGEST = '6bd0ee7972d372ec1f8a3cc44302e5449751305d73c2b69b5a79c62f88a4ca77';

const payload = (overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({
  approval_id: '5f0f6a0e-7a52-4f0e-8d79-3f7a3a4d1c11',
  action_id: 'act_01JAF3M8XQ',
  tool_ref: TOOL,
  obligation_kind: 'tool_invocation',
  resolution: 'approved',
  action_digest: ARGS_DIGEST,
  approver: { id: 'user_2f81', kind: 'user' },
  resolved_at: '2026-10-04T11:58:00.000Z',
  expires_at: '2099-01-01T00:00:00.000Z',
  policy: { id: 'pol_default', version: 3 },
  resume_token: 'rt_fixture_not_a_secret',
  continuation: { kind: 'langgraph', delivery: 'pull', correlation: { thread: 'th_1' } },
  ...overrides,
});

/** The payload of an approval the default policy decided: no `policy` member at all, never null. */
const payloadWithoutPolicy = (): Record<string, JsonValue> => {
  const full = payload();
  return Object.fromEntries(Object.entries(full).filter(([name]) => name !== 'policy'));
};

const write = (name: string, value: unknown): void => {
  writeFileSync(resolve(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
};

mkdirSync(OUT, { recursive: true });
const key = await generateSigningKey('fixture-key-1');
const other = await generateSigningKey('fixture-key-unknown');
const jwks = jwksOf([key]);
const expected = { tool_ref: TOOL, arg_digest: ARGS_DIGEST };

const valid = await signJws(payload(), key);
// The canonical payload bytes: the signing input's second segment decodes to exactly this text.
writeFileSync(resolve(OUT, 'valid.payload.json'), jcs(payload()));

// A payload edited after signing: the digest was swapped for another's, the signature kept.
const [header = '', , signature = ''] = valid.split('.');
const tamperedBody = base64Url(jcs(payload({ action_digest: '0'.repeat(64) })));

write('valid.json', {
  description: 'A well-formed Resumption. Verification succeeds and returns the payload.',
  jws: valid,
  jwks,
  expected,
  now: NOW,
  outcome: 'valid',
});
write('valid-no-policy.json', {
  description:
    'A well-formed Resumption with no `policy` member: no explicit policy matched and the default applied. Verification succeeds and returns the payload.',
  jws: await signJws(payloadWithoutPolicy(), key),
  jwks,
  expected,
  now: NOW,
  outcome: 'valid',
});
write('tampered-digest.json', {
  description:
    'The action_digest in the payload was changed after signing. The signature no longer matches.',
  jws: `${header}.${tamperedBody}.${signature}`,
  jwks,
  expected,
  now: NOW,
  outcome: 'rejected',
  code: 'bad_signature',
});
write('unknown-kid.json', {
  description: 'Signed by a key whose kid is not in the key set.',
  jws: await signJws(payload(), other),
  jwks,
  expected,
  now: NOW,
  outcome: 'rejected',
  code: 'unknown_kid',
});
write('expired.json', {
  description: 'A correctly signed Resumption whose expires_at is before the verification time.',
  jws: await signJws(payload({ expires_at: '2026-10-04T11:59:00.000Z' }), key),
  jwks,
  expected,
  now: NOW,
  outcome: 'rejected',
  code: 'expired',
});
write('wrong-tool.json', {
  description:
    'Signed for one tool and presented for another with an equal digest: rejected, because a digest does not bind the tool.',
  jws: valid,
  jwks,
  expected: { tool_ref: 'mcp:tracker:delete_issue', arg_digest: ARGS_DIGEST },
  now: NOW,
  outcome: 'rejected',
  code: 'tool_mismatch',
});
console.log(`fixtures written to ${OUT}`);
