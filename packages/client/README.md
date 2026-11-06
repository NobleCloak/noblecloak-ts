# @noblecloak/client

Typed client for the NobleCloak module API: one authenticated call per route, the argument digest an
approval is bound to, and the check a runtime makes on a signed Resumption before it acts. Its dependencies
are `openapi-fetch` and `canonicalize`; the digest hash and the signature check use the platform's WebCrypto.

- **Install**
- **Quickstart**
- **The primitives:** `createClient`, `argDigest`, `verifyResumption`
- **Service principals:** `@noblecloak/client/service-principal`, tokens from a key
- **Governance API:** `@noblecloak/client/governance-api`, one method per operation, and `isTransient`
- **Errors:** API problems, `ResumptionError`, `DigestError`
- **Types**, **Versioning**, **License**

For the story from a tool call to an approved, consumed and recorded one, read the how-to "Your first governed
tool" (`docs/how-to/first-governed-tool.md` in the repository).

## Install

```sh
npm install @noblecloak/client
```

It is an ES module and needs a runtime with `fetch` and `crypto.subtle` (a current Node, Bun, Deno or a
browser page served over HTTPS).

## Quickstart

Ask whether an agent may run a tool. The action is the tool's name (`tool_ref`) and the digest of the arguments
as you will send them; the answer is `allow`, `deny` or `step_up` (the schema also lists `defer`, which is reserved: nothing emits it in v1).

```ts
import { argDigest, createClient } from '@noblecloak/client';

const api = createClient({
  baseUrl: 'https://govern.example.com',
  getToken: () => process.env.NC_TOKEN ?? '',
});

// The tool call, as the model made it.
const args = { query: 'damaged' };
const digest = await argDigest(args);

const { data, error, response } = await api.POST('/v1/decisions', {
  body: { action: { tool_ref: 'mcp:tracker:search', arg_digest: digest } },
});

if (error !== undefined) {
  // The client does not throw an API error: it hands it back. See Errors below.
  // The code is the last path segment of the problem's `type` URI.
  const code = error.type.split('/').pop();
  throw new Error(`${String(response.status)} ${String(code)}`);
}
console.log(data.data.decision); // 'allow' | 'deny' | 'step_up' ('defer' is reserved, not emitted in v1)
```

A JSON success body under `/v1` is a `{ data, meta }` envelope, so the decision is `data.data` of what the
client returns. Without a server of your own yet, `nc-mock` from `@noblecloak/spec` serves the same routes with
development tokens (`npx -p @noblecloak/spec nc-mock`; the spec's two commands run on Bun, so Bun must be on
your `PATH`).

## The primitives

### `createClient`

```ts
createClient({ baseUrl, getToken, dpopProof?, fetch? }): ModuleApiClient
```

It wraps [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) over the generated `paths`, so every route is
`api.GET`, `api.POST`, `api.PUT`, `api.PATCH` or `api.DELETE` with a typed path, parameters and body. Every call
resolves to `{ data, error, response }`: `data` on a 2xx, `error` (the problem document) on a 4xx or 5xx, and
the raw `Response` in both. **It never throws on an API error**; a network failure still rejects, as `fetch` does.

| Option      | Meaning                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseUrl`   | The API's base URL.                                                                                                                                                                                                                                                            |
| `getToken`  | Returns the access token, synchronously or as a promise. It is called for **every request**, so it can refresh.                                                                                                                                                                |
| `dpopProof` | Optional (RFC 9449). Called per request with `{ method, url, accessToken }` (the URL without query or fragment). The request then carries `Authorization: DPoP <token>` and a `DPoP` header holding the proof. Without it the request carries `Authorization: Bearer <token>`. |
| `fetch`     | A `fetch` implementation. Defaults to the global one.                                                                                                                                                                                                                          |

### `argDigest`

```ts
argDigest(args: JsonValue): Promise<string>   // lowercase hex SHA-256
```

The digest is `sha256(RFC 8785 canonical form of the arguments as sent)`, in lowercase hex, built on the
`canonicalize` package. "As sent" means before any default your tool's schema would add. An approval is
bound to this digest, so a digest the server computes differently never matches. `canonicalize` follows
`JSON.stringify` and would quietly rewrite what JSON cannot hold, so `argDigest` first refuses it. **It
throws synchronously** (before it returns the promise), a `DigestError`, which is a `TypeError`:

| Refused                                                                                                                                                          | `code`                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `NaN`, `Infinity`, `-Infinity`                                                                                                                                   | `non_finite_number`    |
| An integer beyond ±(2^53 − 1)                                                                                                                                    | `integer_out_of_range` |
| A string or an object key with a lone surrogate                                                                                                                  | `invalid_string`       |
| Nesting deeper than 64 (`MAX_NESTING_DEPTH`; the arguments object is depth 1)                                                                                    | `nesting_too_deep`     |
| `undefined`, a function, a symbol, a bigint, a `Date` or any other object that is not a plain object or array, an object with a `toJSON`, a cycle, an array hole | `unsupported_type`     |

A tool whose schema marks an argument `contentEncoding: base64` or `x-noblecloak-streaming: true`
contributes the SHA-256 of the **decoded** bytes (or, for a streamed argument, of the stream) in place of the value.
Decode base64 first; do not hash the base64 text. `sha256Hex` also accepts a string, which is the trap: a string
is hashed as its UTF-8 text, so pass the decoded bytes. Compute the hash with `sha256Hex(bytes)`,
put the hex string in the argument, then call `argDigest`. `jcs(value)` gives the canonical string itself.

### `verifyResumption`

```ts
verifyResumption(
  jws: string,
  jwks: Jwks,
  expected: { tool_ref: string; arg_digest: string },
  options?: { now?: Date; clockSkewSeconds?: number; acceptResolutions?: readonly string[]; replayGuard?: ResumptionReplayGuard }
): Promise<ResumptionPayload>
```

A Resumption is the signed statement that an approval was resolved. `jws` is its `signature`, an ES256 compact
JWS; `jwks` is the key set at `/.well-known/jwks.json`; `expected` is what the runtime is about to run. It
resolves to the signed payload, or rejects with a `ResumptionError`. It checks, in this order:

1. the structure of the JWS (three non-empty parts, canonical base64url);
2. `alg` is ES256;
3. `kid` names an EC P-256 key in `jwks`;
4. the signature;
5. the payload has not expired (`expires_at`, plus `clockSkewSeconds`, default 0);
6. `resolution` is one of `acceptResolutions` (default `['approved']`: a signature proves who said it, not that
   the answer was yes);
7. `tool_ref` equals `expected.tool_ref`;
8. `action_digest` equals `expected.arg_digest`;
9. when a `replayGuard` is given, the Resumption has not been acted on before.

The guard is keyed on the payload's `approval_id`, kept until `expires_at` plus the skew. `InMemoryReplayGuard`
remembers within **one process** only; for several workers or a restart, implement `ResumptionReplayGuard`
(`firstUse(key, expiresAt)` returns true the first time) over a shared store. **The Resumption is a statement,
not a single-use credential**: the server's `POST /v1/approvals/{id}/consume` is the one gate that spends an
approval, once. Verify first, then consume, then run the tool.

## Service principals

An agent authenticates as an organisation's **service principal**: you hold a private key, the deployment holds
the public half, and its token endpoint issues a short-lived access token for a signed assertion
(`private_key_jwt`, RFC 7523). `@noblecloak/client/service-principal` does that exchange and gives you the
`getToken` the client and the adapters take. It is **server-side only**: it handles a private key, so the main
entry never imports it and you must not bundle it for a browser.

To get a credential, an organisation admin runs `noblecloak sp create` ([`@noblecloak/cli`](../cli/README.md)); it writes the file this loader reads.

```ts
import { createClient } from '@noblecloak/client';
import {
  loadServicePrincipalCredential,
  servicePrincipalTokenSource,
} from '@noblecloak/client/service-principal';

// A path or inline JSON; with no argument, the value of NOBLECLOAK_SP_CREDENTIALS.
const credential = await loadServicePrincipalCredential();
const tokens = servicePrincipalTokenSource(credential, {
  audience: 'https://govern.example.com', // the API's origin: the token's `resource` (RFC 8707)
  scopes: ['module_api'], // optional; omitted, the token carries the principal's stored scopes
});

const api = createClient({ baseUrl: 'https://govern.example.com', getToken: tokens.getToken });
```

**The credential** is JSON with `client_id` (`sp_<uuid>`), `token_endpoint`, `assertion_audience` (the
authorization server's issuer; the assertion's `aud`) and the key, and optionally `org_id`. The key is
either inline as `private_jwk`, or in a separate JWK file named by `key_file`, resolved relative to the
credential file (inline JSON may name only an absolute `key_file`). Exactly one of the two. The key is an EC
P-256 key (signed ES256) or an RSA key of at least 2048 bits (RS256); a public-only key, an `http:` token
endpoint (loopback excepted) and any extra field whose name looks like a secret (`client_secret`,
`password`, `token`, ...) are refused with `ServicePrincipalError` code `invalid_credential`.

**The token.** Each mint signs a new assertion (`iss` = `sub` = `client_id`, a unique `jti`, 120 seconds
long) and posts it as `grant_type=client_credentials` to the token endpoint. The access token is kept until
30 seconds before it expires, or half its lifetime if that is shorter (`refreshSkewMs`); callers that arrive while a request is in flight share it; a
failed request is not cached, so the next call tries again. The token request never follows redirects (a redirect would re-send the assertion elsewhere); one fails as `network_error`. There is no refresh token: a new token is a new
assertion. `tokens.invalidate()` drops the cached token. Needs `fetch` and `crypto.subtle`; reading a
credential file or a `key_file` needs `node:fs` and `node:path`; inline JSON with an inline key needs neither.

`ServicePrincipalError.code`:

| `code`                   | Meaning                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credential_missing`     | No source was passed and `NOBLECLOAK_SP_CREDENTIALS` is unset.                                                                                                                                            |
| `credential_unreadable`  | The credential file or the key file could not be read.                                                                                                                                                    |
| `invalid_credential`     | Not JSON, the wrong shape, a refused key, or a bad `audience`.                                                                                                                                            |
| `invalid_client`         | The token endpoint rejected the principal: it is revoked or expired, its key is not registered, or the local clock is more than 60 seconds off. Check the clock, then rotate its key or create a new one. |
| `token_request_rejected` | Another OAuth refusal; `oauthError` names it (for example `invalid_target`: the `audience` is not one the principal may ask for).                                                                         |
| `invalid_response`       | The token endpoint's answer was not a bearer token with a positive `expires_in`.                                                                                                                          |
| `network_error`          | The request got no answer, or timed out (`timeoutMs`, default 10 seconds), including while the response body was being read.                                                                              |

Messages never contain the key or an assertion, and never echo a credential source that is not a path (a quoted `.env` value is refused as `invalid_credential`, and an unreadable path is named only by where it came from).

## Governance API

`@noblecloak/client/governance-api` wraps the operations a governed runtime calls: `capabilities`, `jwks`,
`createRun`, `decide`, `getApproval`, `waitApproval`, `listApprovals`, `stream`, `getResumption`, `consume`,
`withdraw` and `appendRecord` (`createRun` and `appendRecord` take an idempotency key). Each returns the
unwrapped `data` or a `Problem`, so a 4xx is a value you branch on, not an exception. The main entry does
not import it.

```ts
import { GovernanceApi, ModuleApiError, isTransient } from '@noblecloak/client/governance-api';

const api = new GovernanceApi({ baseUrl: 'https://govern.example.com', getToken: () => token });

try {
  const answer = await api.getApproval(id);
  if (!answer.ok) {
    // answer.problem is { status, code, detail? }. 408 and 429 ask for patience; the rest are refusals.
    return isTransient(answer) ? 'try again' : 'refused';
  }
  use(answer.data);
} catch (error) {
  // A network failure, a 5xx or a body that is not an answer: ModuleApiError with code 'unreachable'.
  if (error instanceof ModuleApiError && isTransient(error)) return 'try again';
  throw error;
}
```

- `ModuleApiError` has one code, `unreachable`, and keeps the original failure as `cause`. It is thrown for a
  network failure, any 5xx, a 2xx body without a `data` member, a list page whose `data` is not an array or
  whose `meta.next` is neither a string nor null, and any non-ok answer from `jwks` and `stream`.
- `isTransient(answer | problem | error)` is true for a `ModuleApiError` with code `unreachable` and for a
  refused answer (or bare `Problem`) with status 5xx, 408 or 429. It is false for success, other statuses
  such as 400, 403, 404 and 409, and any other error (an `Error` that carries a numeric `status`, as an SDK
  error does, is not read as a `Problem`). `jwks` and `stream` throw `ModuleApiError` for every non-ok
  status, 4xx included, so `isTransient` is true for a 403 or 404 from those two: do not retry them forever.
- The constructor option `isPassThrough(error)` names errors to re-throw as themselves: when it returns true
  for what `getToken` (or the request) threw, the error is not turned into `unreachable`. The default is none.

## Errors

A failure has one of three shapes, and each has a table.

### API problems

A 4xx or 5xx is an RFC 9457 problem document (`application/problem+json`) in `error`. Read the code as the last
path segment of `error.type` (`https://…/problems/approval_conflict` is `approval_conflict`); match on it, not on
`title`. Every problem carries `request_id`, which support will ask for. Four members appear on some problems:
`retry_after_seconds` (on `service_unavailable` and `rate_limited`, the same number as `Retry-After`),
`max_items` (on `batch_too_large`, the most the deployment accepts), `max_bytes` (on `payload_too_large`, when the
deployment can say) and `reason` (on `service_unavailable`; `eligibility_lookup` means the deployment could not
tell whether you may resolve the approval). Treat a `reason` you do not know as a plain 503. These are the 39
codes of the document's `info.x-noblecloak-problem-types`.

| Code                            | Status | Meaning                                                                                                      | What to do                                                                                                                                                                                                           |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unauthorized`                  | 401    | No credential, or one that cannot be read.                                                                   | Send a token; check what `getToken` returns.                                                                                                                                                                         |
| `invalid_token`                 | 401    | The token is malformed, expired or not signed by a key the API trusts.                                       | Get a fresh token. Do not retry the same one.                                                                                                                                                                        |
| `wrong_audience`                | 401    | The token's audience is not this API.                                                                        | Ask the issuer for a token whose audience is this API's base URL.                                                                                                                                                    |
| `dpop_unsupported`              | 401    | The deployment does not verify DPoP and the request used the `DPoP` scheme or a bound token.                 | Drop `dpopProof` and use a bearer token.                                                                                                                                                                             |
| `header_identity_rejected`      | 401    | The request carried one of the gateway identity headers the document lists.                                  | Do not send them; identity comes from the token only.                                                                                                                                                                |
| `forbidden`                     | 403    | The principal may not do this.                                                                               | Use a principal that may. Do not retry.                                                                                                                                                                              |
| `organization_context_required` | 403    | The token has no organisation and the route is organisation-scoped.                                          | Use a token issued for an organisation.                                                                                                                                                                              |
| `insufficient_scope`            | 403    | The token lacks the scope the route needs. Two causes, below.                                                | Re-issue the token with the scope. Do not retry as another principal.                                                                                                                                                |
| `entitlement_required`          | 403    | The organisation is not entitled to this route.                                                              | Change the entitlement; retrying does nothing.                                                                                                                                                                       |
| `not_eligible`                  | 403    | The principal may not resolve this approval (for one, the principal that created it).                        | Have an eligible person resolve it.                                                                                                                                                                                  |
| `not_owner`                     | 403    | Only the principal that created the obligation may read its Resumption.                                      | Read it as the creator.                                                                                                                                                                                              |
| `not_found`                     | 404    | No such resource, or one this principal may not see.                                                         | Check the id and the principal.                                                                                                                                                                                      |
| `not_available_on_deployment`   | 404    | The route is not served on this kind of deployment (a hosted-only route on an edge one).                     | Call it on a deployment that serves it.                                                                                                                                                                              |
| `invalid_request`               | 400    | The request does not match the schema (or a deployment refuses a value it does not serve).                   | Fix the request; `detail` says where. Do not retry unchanged.                                                                                                                                                        |
| `identity_not_accepted`         | 400    | The body names an organisation, principal or scope; those come from the token.                               | Remove them from the body.                                                                                                                                                                                           |
| `attestation_not_accepted`      | 400    | The body sets `attestation`, which the server derives.                                                       | Remove it.                                                                                                                                                                                                           |
| `callback_unroutable`           | 400    | `callback_url` is not a public-routable `https` address.                                                     | Give a public `https` URL.                                                                                                                                                                                           |
| `invalid_continuation`          | 400    | The continuation does not match its delivery, or the deployment does not serve that delivery.                | Use a delivery from `Capabilities.continuation_deliveries`.                                                                                                                                                          |
| `batch_too_large`               | 400    | The batch has more items than the deployment accepts.                                                        | Split it into batches of `max_items` or fewer.                                                                                                                                                                       |
| `already_resolved`              | 409    | The approval is already resolved.                                                                            | Read it to see the outcome; do not resolve again.                                                                                                                                                                    |
| `approval_conflict`             | 409    | The digest you sent does not match, or another resolution won.                                               | Re-read the approval, show the current `action_digest` to the approver, and re-decide. **Never send a digest the approver did not see.** On `consume`, the arguments are not the approved ones: do not run the tool. |
| `already_resumed`               | 409    | The Resumption was already consumed.                                                                         | Do not run the tool again; it already ran.                                                                                                                                                                           |
| `obligation_consumed`           | 409    | The obligation was already consumed (a replay of `consume`).                                                 | Do not run the tool again.                                                                                                                                                                                           |
| `obligation_expired`            | 409    | The obligation expired before it was acted on.                                                               | Ask again; the next identical call opens a fresh one.                                                                                                                                                                |
| `obligation_withdrawn`          | 409    | Its requester withdrew it.                                                                                   | Ask again if you still need it.                                                                                                                                                                                      |
| `continuation_expired`          | 409    | The continuation expired.                                                                                    | Open a new obligation with a fresh continuation.                                                                                                                                                                     |
| `continuation_conflict`         | 409    | The open obligation already has a different continuation.                                                    | Send the same continuation, or wait for the obligation to close.                                                                                                                                                     |
| `side_effect_level_downgrade`   | 409    | A tool's side-effect level may stay, rise or move to a level of equal rank through this API and never falls. | Register a new tool for the lower level.                                                                                                                                                                             |
| `governed_run_not_creatable`    | 405    | A governed run is created by the platform, not by a caller.                                                  | Do not create it; read it.                                                                                                                                                                                           |
| `payload_too_large`             | 413    | The body is larger than the deployment accepts.                                                              | Send less; `max_bytes` says how much when known.                                                                                                                                                                     |
| `idempotency_key_reuse`         | 422    | The `Idempotency-Key` was used with a different request.                                                     | Use a new key for a different request; resend the same request with the same key.                                                                                                                                    |
| `continuation_unsupported`      | 422    | The deployment does not serve approvals, so it cannot store a continuation.                                  | Drop the continuation.                                                                                                                                                                                               |
| `reserved_tool_ref`             | 422    | The tool reference is in a namespace the deployment reserves.                                                | Choose another reference.                                                                                                                                                                                            |
| `system_tool_ref`               | 422    | The tool reference is a system tool's.                                                                       | Choose another reference.                                                                                                                                                                                            |
| `tool_ref_in_use`               | 422    | The reference is already in use in your organisation, or is not yours to see.                                | Choose another reference.                                                                                                                                                                                            |
| `approval_unroutable`           | 422    | The deployment cannot open or route an approval for this tool.                                               | Fix the tool's approval routing in the deployment.                                                                                                                                                                   |
| `rate_limited`                  | 429    | Too many requests.                                                                                           | Wait `retry_after_seconds` (or `Retry-After`), then retry.                                                                                                                                                           |
| `internal_error`                | 500    | The deployment failed to answer.                                                                             | Retry with backoff; quote `request_id` if it persists.                                                                                                                                                               |
| `service_unavailable`           | 503    | The deployment cannot answer right now.                                                                      | Retry after `retry_after_seconds` if present.                                                                                                                                                                        |

**`insufficient_scope` has two causes.** A service principal whose token lacks `module_api`; or a user or an agent (any
non-service principal) whose token lacks the scope the deployment advertises as `Capabilities.user_resolve_scope` (read it from
`GET /v1/capabilities`), on resolve, approve, deny or the resolve batch. A deployment that does not advertise the member requires no such scope. The scope check comes first: it answers
before the body is validated and before the approval is looked up, so an id that does not exist is still 403.
Re-issue the token with the scope. Do not retry as another principal. The mock of `@noblecloak/spec` advertises `approvals:resolve` as its `user_resolve_scope`; for any
other deployment, read `Capabilities.user_resolve_scope`.

**`invalid_target` is not a client or API code.** It is the `AuthError` a browser sign-in throws from
`@noblecloak/react/auth` (see the README of `@noblecloak/react`).
For an audience problem this client sees `wrong_audience` or `invalid_token`.

### `ResumptionError.code`

Thrown (as a rejected promise) by `verifyResumption`; the checks run in the order above.

| `code`            | Meaning                                                                                                                                     | What to do                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `malformed`       | Not a JWS, not canonical base64url, the payload lacks a field it needs, the header has no `kid`, or the matching `jwks` key has no `x`/`y`. | Do not act. Refetch the Resumption; for a key with no `x`/`y`, refetch `/.well-known/jwks.json` too. |
| `unsupported_alg` | The header's `alg` is not ES256.                                                                                                            | Do not act.                                                                                          |
| `unknown_kid`     | No EC P-256 key with that `kid` in `jwks`.                                                                                                  | Refetch `/.well-known/jwks.json` once (keys rotate); if still unknown, do not act.                   |
| `bad_signature`   | The signature does not match the payload.                                                                                                   | Do not act.                                                                                          |
| `expired`         | `expires_at` has passed (plus the skew).                                                                                                    | Ask again; a new approval is needed.                                                                 |
| `not_approved`    | The resolution is not in `acceptResolutions` (default: only `approved`).                                                                    | Do not run the tool; report the refusal.                                                             |
| `tool_mismatch`   | Approved for a different tool.                                                                                                              | Do not run this tool with this approval.                                                             |
| `digest_mismatch` | The arguments are not the ones that were approved.                                                                                          | Do not run; digest the arguments you hold and ask again if they changed on purpose.                  |
| `replayed`        | The guard has seen this approval already.                                                                                                   | Do not run it a second time.                                                                         |

### `DigestError.code`

Thrown synchronously by `argDigest` and `jcs`; the codes and their causes are the table under
[`argDigest`](#argdigest). Fix the arguments; do not "sanitise" them to get a digest, because the server digests
what you send.

## Types

`@noblecloak/client/schema` exports the generated `paths`, `components` and `operations`, from the spec package's published
document (`openapi.public.yaml`); the package entry re-exports the same three types. Besides the functions and classes above
(`createClient`, `argDigest`, `verifyResumption`, `InMemoryReplayGuard`, `ResumptionError`, `DigestError`), the
entry exports the values `jcs`, `sha256Hex` and `MAX_NESTING_DEPTH`, and the types `ClientOptions`, `DpopRequest`,
`ModuleApiClient`, `DigestErrorCode`, `JsonValue`, `ExpectedAction`, `Jwks`, `ResumptionErrorCode`,
`ResumptionPayload`, `ResumptionReplayGuard` and `VerifyOptions`.

```ts
import type { components } from '@noblecloak/client/schema';

type Decision = components['schemas']['Decision'];
```

## Versioning

This version implements **contract revision 16** (release `contract-v1-rev16` of `@noblecloak/spec`, which
it pairs with). The revision is the contract's, not the OpenAPI document's `info.version`. The
CHANGELOG names the revision each release was regenerated from. Members added in a revision are optional, so
against a service of an older revision they are absent.

## License

Apache-2.0; see the repository `LICENSE` and `NOTICE`.
