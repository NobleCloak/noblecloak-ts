import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { argDigest, jcs } from './digest.js';
import type { JsonValue } from './digest.js';
import { InMemoryReplayGuard, ResumptionError, verifyResumption } from './resumption.js';
import type { ExpectedAction, Jwks, ResumptionErrorCode } from './resumption.js';

const FIXTURES = resolve(import.meta.dirname, '../../spec/fixtures/resumption');

interface Fixture {
  readonly description: string;
  readonly jws: string;
  readonly jwks: Jwks;
  readonly expected: ExpectedAction;
  readonly now: string;
  readonly outcome: 'valid' | 'rejected';
  readonly code?: ResumptionErrorCode;
}

const fixtures = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json') && !name.includes('.payload.'))
  .map(
    (name) => [name, JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as Fixture] as const
  );

const rejection = async (promise: Promise<unknown>): Promise<ResumptionError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ResumptionError) return error;
    throw error;
  }
  throw new Error('expected the Resumption to be rejected');
};

describe('the fixtures', () => {
  it('include the valid, valid-without-policy, tampered, unknown-kid, expired and wrong-tool cases', () => {
    expect(fixtures.map(([name]) => name).sort()).toEqual([
      'expired.json',
      'tampered-digest.json',
      'unknown-kid.json',
      'valid-no-policy.json',
      'valid.json',
      'wrong-tool.json',
    ]);
  });

  it('a Resumption with no policy member verifies: the verifier never reads policy', async () => {
    const fixture = fixtures.find(([name]) => name === 'valid-no-policy.json')?.[1];
    if (fixture === undefined) throw new Error('valid-no-policy fixture missing');
    const payload = (await verifyResumption(fixture.jws, fixture.jwks, fixture.expected, {
      now: new Date(fixture.now),
    })) as unknown as Record<string, unknown>;
    expect(payload).not.toHaveProperty('policy');
    expect(payload.resolution).toBe('approved');
  });

  it.each(fixtures)('%s', async (_name, fixture) => {
    const verify = verifyResumption(fixture.jws, fixture.jwks, fixture.expected, {
      now: new Date(fixture.now),
    });
    if (fixture.outcome === 'valid') {
      const payload = await verify;
      expect(payload.tool_ref).toBe(fixture.expected.tool_ref);
      expect(payload.action_digest).toBe(fixture.expected.arg_digest);
    } else {
      expect((await rejection(verify)).code).toBe(fixture.code);
    }
  });

  it('the published canonical payload bytes are exactly what the valid fixture signed', () => {
    const valid = fixtures.find(([name]) => name === 'valid.json')?.[1];
    const bytes = readFileSync(resolve(FIXTURES, 'valid.payload.json'), 'utf8');
    const segment = valid?.jws.split('.')[1] ?? '';
    expect(Buffer.from(segment, 'base64url').toString('utf8')).toBe(bytes);
    expect(jcs(JSON.parse(bytes) as JsonValue)).toBe(bytes);
  });
});

describe('verifyResumption', () => {
  const valid = fixtures.find(([name]) => name === 'valid.json')?.[1];
  if (valid === undefined) throw new Error('valid fixture missing');
  const now = new Date(valid.now);
  const verify = (jws: string, options = {}): Promise<unknown> =>
    verifyResumption(jws, valid.jwks, valid.expected, { now, ...options });
  const [header = '', body = '', signature = ''] = valid.jws.split('.');
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  it('rejects a JWS that is not three parts', async () => {
    expect((await rejection(verify('a.b'))).code).toBe('malformed');
    expect((await rejection(verify('a..c'))).code).toBe('malformed');
  });

  it('rejects a header that is not base64url JSON', async () => {
    expect((await rejection(verify(`!!!.${body}.${signature}`))).code).toBe('malformed');
    expect((await rejection(verify(`${encode('x')}.${body}.${signature}`))).code).toBe('malformed');
    expect(
      (await rejection(verify(`${Buffer.from('nope').toString('base64url')}.${body}.${signature}`)))
        .code
    ).toBe('malformed');
  });

  it('tells an impossible base64url length from JSON that does not parse', async () => {
    const badLength = await rejection(verify(`A.${body}.${signature}`));
    expect(badLength.code).toBe('malformed');
    expect(badLength.message).toMatch(/base64url/);
    expect(badLength.message).not.toMatch(/JSON/);
    const notJson = await rejection(
      verify(`${Buffer.from('nope').toString('base64url')}.${body}.${signature}`)
    );
    expect(notJson.message).toMatch(/is not JSON/);
    expect(notJson.cause).toBeInstanceOf(SyntaxError);
  });

  it('rejects any alg other than ES256, including none', async () => {
    for (const alg of ['none', 'HS256', 'RS256']) {
      const error = await rejection(
        verify(`${encode({ alg, kid: 'fixture-key-1' })}.${body}.${signature}`)
      );
      expect(error.code, alg).toBe('unsupported_alg');
    }
  });

  it('rejects a header with no kid, and a kid that is not in the set', async () => {
    expect((await rejection(verify(`${encode({ alg: 'ES256' })}.${body}.${signature}`))).code).toBe(
      'malformed'
    );
    expect(
      (await rejection(verify(`${encode({ alg: 'ES256', kid: 'other' })}.${body}.${signature}`)))
        .code
    ).toBe('unknown_kid');
  });

  it('rejects a key that is not EC P-256', async () => {
    const jwks = { keys: [{ kty: 'RSA', kid: 'fixture-key-1' }] };
    const error = await rejection(verifyResumption(valid.jws, jwks, valid.expected, { now }));
    expect(error.code).toBe('unknown_kid');
  });

  it('rejects a signature that is not valid, and one that cannot be parsed as a signature', async () => {
    const flipped = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await rejection(verify(`${header}.${body}.${flipped}`))).code).toBe('bad_signature');
    expect((await rejection(verify(`${header}.${body}.AAAA`))).code).toBe('bad_signature');
  });

  it('reports a key with no coordinates as malformed, not as a forged signature', async () => {
    const jwks = { keys: [{ kty: 'EC', crv: 'P-256', kid: 'fixture-key-1' }] };
    const error = await rejection(verifyResumption(valid.jws, jwks, valid.expected, { now }));
    expect(error.code).toBe('malformed');
    expect(error.message).toMatch(/fixture-key-1/);
  });

  it('keeps the cause when WebCrypto refuses the key, and lets environment errors through', async () => {
    const [good] = valid.jwks.keys;
    const jwks = { keys: [{ ...good, kty: 'EC', crv: 'P-256', x: '!!!', y: '!!!' }] };
    const refused = await rejection(verifyResumption(valid.jws, jwks, valid.expected, { now }));
    expect(refused.code).toBe('bad_signature');
    expect(refused.cause).toBeInstanceOf(Error);
    const spy = vi
      .spyOn(crypto.subtle, 'importKey')
      .mockRejectedValue(new DOMException('no P-256 here', 'NotSupportedError'));
    try {
      await expect(verify(valid.jws)).rejects.toMatchObject({ name: 'NotSupportedError' });
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a validly signed Resumption that is not an approval, unless the caller accepts it', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const jwks = { keys: [{ ...jwk, kty: 'EC', crv: 'P-256', kid: 'k1' }] };
    const sign = async (resolution: string): Promise<string> => {
      const signingInput = `${encode({ alg: 'ES256', kid: 'k1' })}.${encode({
        resolution,
        tool_ref: valid.expected.tool_ref,
        action_digest: valid.expected.arg_digest,
        expires_at: '2099-01-01T00:00:00.000Z',
      })}`;
      const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        new TextEncoder().encode(signingInput)
      );
      return `${signingInput}.${Buffer.from(sig).toString('base64url')}`;
    };
    const run = (resolution: string, options = {}): Promise<unknown> =>
      sign(resolution).then((jws) =>
        verifyResumption(jws, jwks, valid.expected, { now, ...options })
      );
    await expect(run('approved')).resolves.toBeDefined();
    const rejected = await rejection(run('rejected'));
    expect(rejected.code).toBe('not_approved');
    expect((await rejection(run('some_other_resolution'))).code).toBe('not_approved');
    await expect(
      run('rejected', { acceptResolutions: ['approved', 'rejected'] })
    ).resolves.toMatchObject({
      resolution: 'rejected',
    });
  });

  it('checks expiry against the supplied clock and honours skew', async () => {
    const afterExpiry = { now: new Date('2099-01-01T00:00:01.000Z') };
    expect((await rejection(verify(valid.jws, afterExpiry))).code).toBe('expired');
    await expect(verify(valid.jws, { ...afterExpiry, clockSkewSeconds: 5 })).resolves.toBeDefined();
  });

  it('rejects a digest that is not the approved one', async () => {
    const error = await rejection(
      verifyResumption(
        valid.jws,
        valid.jwks,
        { ...valid.expected, arg_digest: await argDigest({ other: 1 }) },
        { now }
      )
    );
    expect(error.code).toBe('digest_mismatch');
  });

  it('rejects a payload that is not JSON, or has no expiry', async () => {
    // Re-signing is not possible without the private key, so malformed payloads are caught by the
    // signature check first; this documents that order.
    const garbage = Buffer.from('not json').toString('base64url');
    expect((await rejection(verify(`${header}.${garbage}.${signature}`))).code).toBe(
      'bad_signature'
    );
  });

  it('rejects a Resumption a replay guard has already seen', async () => {
    const guard = new InMemoryReplayGuard(() => now);
    await expect(verify(valid.jws, { replayGuard: guard })).resolves.toBeDefined();
    expect((await rejection(verify(valid.jws, { replayGuard: guard }))).code).toBe('replayed');
  });

  it('keeps the replay key for the whole skew window: a duplicate after expires_at is still replayed', async () => {
    const afterExpiry = new Date('2099-01-01T00:00:01.000Z');
    const guard = new InMemoryReplayGuard(() => afterExpiry);
    const options = { now: afterExpiry, clockSkewSeconds: 5, replayGuard: guard };
    await expect(verify(valid.jws, options)).resolves.toBeDefined();
    expect((await rejection(verify(valid.jws, options))).code).toBe('replayed');
  });

  it('hands the guard expires_at plus the skew', async () => {
    const seen: number[] = [];
    const guard = {
      firstUse: (_key: string, expiresAt: Date) => {
        seen.push(expiresAt.getTime());
        return true;
      },
    };
    await verify(valid.jws, { replayGuard: guard });
    await verify(valid.jws, { replayGuard: guard, clockSkewSeconds: 5 });
    expect(seen[1]).toBe((seen[0] ?? 0) + 5000);
  });

  describe('a derived spelling of the same signature is not a second Resumption', () => {
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const bytes = Buffer.from(signature, 'base64url');
    const withS = (s: bigint): string => {
      const out = Buffer.from(bytes);
      out.set(Buffer.from(s.toString(16).padStart(64, '0'), 'hex'), 32);
      return `${header}.${body}.${out.toString('base64url')}`;
    };
    const s = BigInt(`0x${bytes.subarray(32).toString('hex')}`);

    it('a changed unused trailing bit is rejected as not canonical, guard or not', async () => {
      const last = signature.at(-1) ?? '';
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      // The last of 86 characters carries 4 unused bits: flip one in the character, not in the bytes.
      const flipped = alphabet[alphabet.indexOf(last) ^ 1] ?? '';
      expect(Buffer.from(signature.slice(0, -1) + flipped, 'base64url')).toEqual(bytes);
      const error = await rejection(
        verify(`${header}.${body}.${signature.slice(0, -1)}${flipped}`)
      );
      expect(error.code).toBe('malformed');
      expect(error.message).toMatch(/canonical/);
    });

    it('the other valid ECDSA signature of the payload (s -> n - s) is replayed, not accepted twice', async () => {
      const guard = new InMemoryReplayGuard(() => now);
      await expect(verify(valid.jws, { replayGuard: guard })).resolves.toBeDefined();
      const twin = withS(N - s);
      // WebCrypto verifies it: the signature is genuine, so only the guard can stop it.
      await expect(verify(twin)).resolves.toBeDefined();
      expect((await rejection(verify(twin, { replayGuard: guard }))).code).toBe('replayed');
    });

    it('the guard is keyed on the approval id', async () => {
      const keys: string[] = [];
      await verify(valid.jws, {
        replayGuard: {
          firstUse: (key: string) => {
            keys.push(key);
            return true;
          },
        },
      });
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        approval_id: string;
      };
      expect(keys).toEqual([payload.approval_id]);
    });
  });
});

describe('InMemoryReplayGuard', () => {
  it('forgets a key once it has expired', () => {
    let clock = new Date('2026-01-01T00:00:00Z');
    const guard = new InMemoryReplayGuard(() => clock);
    const expiry = new Date('2026-01-01T00:10:00Z');
    expect(guard.firstUse('k', expiry)).toBe(true);
    expect(guard.firstUse('k', expiry)).toBe(false);
    clock = new Date('2026-01-01T00:10:00Z');
    expect(guard.firstUse('k', new Date('2026-01-01T00:20:00Z'))).toBe(true);
  });

  it('defaults to the system clock', () => {
    const guard = new InMemoryReplayGuard();
    expect(guard.firstUse('k', new Date(Date.now() + 60_000))).toBe(true);
    expect(guard.firstUse('k', new Date(Date.now() + 60_000))).toBe(false);
  });
});
