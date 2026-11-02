/** Test support for the service-principal tests: keys, a stub token endpoint and an assertion verifier. */
import type { PrivateJwk, ServicePrincipalCredential } from './service-principal.js';

export const CLIENT_ID = 'sp_0b8d1d6e-5c53-4b8e-9d3a-2f6f7a1c9e10';
export const ISSUER = 'https://api.example.test';
export const TOKEN_ENDPOINT = `${ISSUER}/auth/oauth/token`;
export const AUDIENCE = 'https://govern.example.test';

export interface TestKey {
  readonly privateJwk: PrivateJwk;
  readonly publicKey: CryptoKey;
}

export async function ecKey(): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicKey: pair.publicKey,
  };
}

export async function rsaKey(modulusLength = 2048): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  return {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicKey: pair.publicKey,
  };
}

export function credential(
  key: TestKey,
  overrides: Partial<ServicePrincipalCredential> = {}
): ServicePrincipalCredential {
  return {
    client_id: CLIENT_ID,
    token_endpoint: TOKEN_ENDPOINT,
    assertion_audience: ISSUER,
    private_jwk: key.privateJwk,
    ...overrides,
  };
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0)
  );
  return bytes;
}

export interface VerifiedAssertion {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
  readonly signatureValid: boolean;
}

export async function verifyAssertion(jwt: string, key: TestKey): Promise<VerifiedAssertion> {
  const [h, c, s] = jwt.split('.');
  if (h === undefined || c === undefined || s === undefined) throw new Error('not a compact JWS');
  const header = JSON.parse(new TextDecoder().decode(fromBase64Url(h))) as Record<string, unknown>;
  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(c))) as Record<string, unknown>;
  const algorithm =
    header.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  const signatureValid = await crypto.subtle.verify(
    algorithm,
    key.publicKey,
    fromBase64Url(s),
    new TextEncoder().encode(`${h}.${c}`)
  );
  return { header, claims, signatureValid };
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly form: URLSearchParams;
}

export interface StubEndpoint {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: RecordedRequest[];
}

/** A fetch that records each request and answers with `respond` (default: a 600-second token). */
export function stubEndpoint(
  respond: (request: RecordedRequest, n: number) => Response | Promise<Response> = (_r, n) =>
    tokenResponse(`token-${String(n)}`)
): StubEndpoint {
  const requests: RecordedRequest[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const recorded: RecordedRequest = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      form: new URLSearchParams(await request.text()),
    };
    requests.push(recorded);
    return respond(recorded, requests.length);
  };
  return { fetch: fetchStub, requests };
}

export function tokenResponse(accessToken: string, expiresIn = 600): Response {
  return Response.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: 'module_api',
  });
}

/** A copy of `value` without `key`. */
export function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as Omit<T, K>;
}
