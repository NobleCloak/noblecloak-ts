# Your first governed tool

This guide takes one tool call from ungoverned to governed, with a human approval in the middle. It
follows the call through the hops in the order the system runs them, and shows the real request and
response of each. You run steps 2 to 6 against the mock, which needs no account and no credentials, and
step 8 says what changes when you point the same code at a real deployment.

Every code block marked as a snippet is a file in [`docs/snippets`](../snippets), which the repository
typechecks and runs against the mock. The guide and the files are kept the same text by a test.

## 1. The idea in one paragraph

A tool call becomes an **action**: a `tool_ref` (the stable name of the tool in your catalog) and an
`arg_digest` (the SHA-256 of the arguments, canonicalised), or the `arguments` themselves for the server to
digest. The platform returns a **decision**: `allow`, `deny` or `step_up`. A `step_up` opens an **approval**,
which a person resolves. Your runtime then fetches a signed **Resumption**, verifies it against the
arguments it is about to send, and **consumes** the approval, which spends it exactly once. A **record**
closes the loop. (The decision value `defer` is reserved and nothing emits it in v1.)

```text
decide ──allow──────────────────────────────▶ run the tool ──▶ record
   │
   └─step_up─▶ approval opens ─▶ a person resolves it
                                      │
        record ◀─ run the tool ◀─ consume ◀─ verify the Resumption ◀─┘
```

## 2. Set up

You need [Bun](https://bun.sh). From the repository root:

```sh
bun install
bun run build
node packages/spec/dist/cli/nc-mock.js
```

`nc-mock` is the mock server from `@noblecloak/spec`. It prints its address and a set of development
tokens, and keeps serving:

```json
{
  "base_url": "http://127.0.0.1:8787",
  "deployment": "hosted",
  "tokens": { "audience": "http://127.0.0.1:8787", "creator": "eyJ…", "approver": "eyJ…", "…": "…" }
}
```

Leave it running and open a second terminal. The mock serves the same tokens at `GET /__mock/tokens`. Two
of them matter here:

| Token      | Principal                | Scope               | Its job                               |
| ---------- | ------------------------ | ------------------- | ------------------------------------- |
| `creator`  | `svc_adapter`, a service | `module_api`        | Your agent. It asks, and it consumes. |
| `approver` | `user_approver`, a user  | `approvals:resolve` | A person. It answers the approval.    |

Everything under `/__mock/*` exists only on the mock. A real deployment has no such routes, and Step 8 says
where its tokens come from instead.

<!-- snippet: connect -->

```ts
import { createClient } from '@noblecloak/client';

export const baseUrl = process.env.NC_BASE_URL ?? 'http://127.0.0.1:8787';

// The mock serves its dev tokens here. A real deployment has no /__mock/* routes.
const tokens = (await (await fetch(`${baseUrl}/__mock/tokens`)).json()) as Record<string, string>;

export function token(name: 'creator' | 'approver'): string {
  const value = tokens[name];
  if (value === undefined) throw new Error(`the mock served no ${name} token`);
  return value;
}

// The agent: a service principal with the module_api scope.
export const creator = createClient({ baseUrl, getToken: () => token('creator') });

// A person: a user principal with the approvals:resolve scope.
export const approver = createClient({ baseUrl, getToken: () => token('approver') });
```

`createClient` returns a typed client for the whole API. `getToken` is called for every request, so it can
refresh. The client does not throw an API error: every call resolves to `{ data, error, response }`. These
two helpers keep the rest of the guide short. `unwrap` returns the body of a successful call and throws the
status and the problem code of a failed one; `problemCode` reads the code out of a problem document (Step 9
explains how).

<!-- snippet: problem -->

```ts
/**
 * The client returns an API error; it never throws one. A problem document (RFC 9457) names its kind in
 * `type`, a URI whose last path segment is the code the guide lists.
 */
export function problemCode(problem: { readonly type?: string }): string {
  return problem.type?.split('/').at(-1) ?? 'unknown';
}

/** What every call of the typed client resolves to: a body or a problem, plus the raw response. */
interface Result<T> {
  readonly data?: T;
  readonly error?: { readonly type?: string };
  readonly response: Response;
}

/** The body of a successful call. Anything else throws, naming the status and the problem code. */
export function unwrap<T>(result: Result<T>): T {
  if (result.error !== undefined || result.data === undefined) {
    const code = result.error === undefined ? 'no body' : problemCode(result.error);
    throw new Error(`${String(result.response.status)} ${code}`);
  }
  return result.data;
}
```

Each snippet file imports the ones above it, so running a later file also runs the steps before it. Run any
of them from the repository root with `bun docs/snippets/<name>.ts`. `approve.ts` and `resume.ts` leave the approval approved but not consumed, and the mock hands that same
approval back for the same action, so the next of those files to approve fails with `409 already_resolved`.
Stop `nc-mock` and start it again between them (or `POST /__mock/control` with `{"reset": true}`).
`consume-and-record.ts` consumes the approval, so it can be run again, and it carries out Steps 4 to 6 in one go.

## 3. Decide: allow

Ask whether the agent may search the tracker. The mock's policy is by `tool_ref`, and
`mcp:tracker:search` is always allowed. `argDigest` computes the digest of the arguments as you will send
them: the RFC 8785 canonical form, hashed with SHA-256, in lowercase hex.

<!-- snippet: allow -->

```ts
import { argDigest } from '@noblecloak/client';

import { creator } from './connect.js';
import { unwrap } from './problem.js';

// The tool call, as the model made it.
const args = { query: 'damaged' };
export const digest = await argDigest(args);

const { data: decision } = unwrap(
  await creator.POST('/v1/decisions', {
    body: { action: { tool_ref: 'mcp:tracker:search', arg_digest: digest } },
  })
);

export const verdict = decision.decision;
console.log(verdict); // allow
```

```sh
bun docs/snippets/allow.ts
```

The response is the standard `{ data, meta }` envelope:

```json
{
  "data": {
    "decision": "allow",
    "policy": { "id": "pol_default", "version": 3, "side_effect_level": "read" },
    "action_digest": "1de0312004f49ecda2e490003b929a2201e20e9c156bf30889d6869adf1488e5",
    "enforced": true
  },
  "meta": { "request_id": "req_…", "deployment": "hosted" }
}
```

On `allow` you run the tool and append a record (Step 6 shows the record). `action_digest` is the identity of
this action: the same tool and the same arguments always give the same one.

You can send `arguments` instead of `arg_digest` and let the server digest them. Send exactly one of the
two. The digest keeps the arguments out of the request.

## 4. Step up: a person decides

Switch to a tool whose policy is "ask". The mock decides by `tool_ref` alone: the arguments never change the
answer. `ext:local:send_email` is one it knows. For a tool of your own, register an `ext:` tool with
`POST /v1/tools`; a tool registered that way is also "ask".

<!-- snippet: register-tool -->

```ts
import { creator } from './connect.js';
import { unwrap } from './problem.js';

/** Puts an external tool in the catalog. The mock decides a new tool as step_up; the contract leaves the default policy to the deployment. */
export async function registerTool(toolRef: string): Promise<void> {
  unwrap(
    await creator.POST('/v1/tools', {
      body: {
        tool_ref: toolRef,
        transport: 'external',
        description: 'Refund an order.',
        side_effect_level: 'external',
        input_schema: { type: 'object' },
        owner_kind: 'org',
        // The people who decide an approval of this tool see the arguments of the call.
        show_arguments_to_approvers: true,
      },
    })
  );
}
```

Use an `ext:` tool, a tool that runs in your process. A tool the deployment runs through its gateway
(`mcp:`) also steps up, but it gets `resume_token_will_issue: false`: there is nothing for you to consume, so
Steps 5 and 6 do not apply to it.

The decision request carries the caller's `continuation`: how it wants to be told that the approval
resolved. `kind` names the runtime and `delivery` is `push`, `pull` or `held`. Here the runtime pulls.

<!-- snippet: step-up -->

```ts
import { argDigest } from '@noblecloak/client';

import { creator } from './connect.js';
import { unwrap } from './problem.js';

export const toolRef = 'ext:local:send_email';
export const args = { to: 'ada@example.com', subject: 'Your refund' };
export const digest = await argDigest(args);

const { data: decision } = unwrap(
  await creator.POST('/v1/decisions', {
    body: {
      action: { tool_ref: toolRef, arg_digest: digest },
      // How the runtime wants to hear that the approval resolved: it will pull the Resumption.
      continuation: { kind: 'webhook', delivery: 'pull' },
    },
  })
);

if (decision.decision !== 'step_up' || decision.approval === undefined) {
  throw new Error(`expected step_up with an approval, got ${decision.decision}`);
}

export const approvalId = decision.approval.id;
console.log(decision.decision, decision.approval.state, decision.approval.resume_token_will_issue);
// step_up pending true
```

The response carries the approval in `data.approval`, not a continuation:

```json
{
  "data": {
    "decision": "step_up",
    "reason": "approval_required",
    "policy": { "id": "pol_default", "version": 3, "side_effect_level": "external" },
    "approval": {
      "id": "cb9b58ae-8006-4aec-aad9-12c2c55ee7ad",
      "state": "pending",
      "created": true,
      "created_at": "2026-10-09T18:45:57.350Z",
      "expires_at": "2026-10-09T19:45:57.350Z",
      "resume_token_will_issue": true
    },
    "action_digest": "5e22011dc10edcd3831fe6a6bba074428a9b307fb7260cd3d3e95c5b45317d0b",
    "enforced": true
  },
  "meta": { "request_id": "req_…", "deployment": "hosted" }
}
```

Ask again for the same action while the approval is open and you get the same approval back, with
`created: false`. The agent now stops and waits. It can long-poll with `GET /v1/approvals/{id}/wait`
(`timeout` up to 55 seconds), follow `GET /v1/approvals/stream`, or be told through its continuation.

What the person agrees to is narrow: one call, one scope, used once. See [What an approval covers](../what-an-approval-covers.md).

### Resolve it

**Who may approve.** The principal that created an approval cannot resolve it with its own token, and neither can any
service principal. A deployment may let a person resolve through the approver surface, which
`Capabilities` advertises. The contract fixes only that; who else is eligible is the deployment's own rule. Ask
your administrator who can approve in your organisation. An org admin can. The script below shows both
sides: the agent tries and is refused with `403 not_eligible`, then a person approves with the digest they
saw (`expected_action_digest`), so an approval can only be given to the action that was shown.

<!-- snippet: approve -->

```ts
import { approver, creator } from './connect.js';
import { problemCode, unwrap } from './problem.js';
import { approvalId, digest } from './step-up.js';

const path = { id: approvalId };
const body = { expected_action_digest: digest };

// The agent asked for the approval, so it cannot give it.
const refused = await creator.POST('/v1/approvals/{id}/approve', { params: { path }, body });
if (refused.error === undefined) throw new Error('the creator resolved its own approval');
export const refusal = problemCode(refused.error);
console.log(refused.response.status, refusal); // 403 not_eligible

// A person can.
const { data: approval } = unwrap(
  await approver.POST('/v1/approvals/{id}/approve', { params: { path }, body })
);
export const state = approval.state;
console.log(state); // approved
```

```sh
bun docs/snippets/approve.ts
```

`/approve` and `/deny` are shorthand for `POST /v1/approvals/{id}/resolve`, which takes
`{ resolution: "approved" | "rejected" | "escalated", expected_action_digest, reason?, input? }`.

**The Approvals module.** People do not call this API by hand. The standalone Approvals module is the
queue and the detail page a person works in. Nothing runs the module against a bare mock, so use the path
the examples already document: it starts its own mock on `127.0.0.1:8787`, registers a refund tool and plays an
agent that asks for a refund and holds the approval until a person decides. Stop the mock from Step 2 first,
since both want that port.

```sh
bun run --cwd examples/next-app start:demo     # leave it running
```

In a second terminal:

```sh
cd examples/next-app
NEXT_PUBLIC_NC_MODE=mock NEXT_PUBLIC_NC_API_URL=http://127.0.0.1:8787 bun run dev
```

Open <http://localhost:3000/approvals>, select the refund request, read the call and approve or deny it.
Use `127.0.0.1`, not `localhost`, for the API: the mock listens on `127.0.0.1` only, so a `localhost` that resolves to the IPv6 `::1` cannot connect; use the address the mock prints. The agent in that demo checks the Resumption, consumes the approval and counts one refund, which is
Steps 5 and 6 done for you. See
[`examples/next-app/README.md`](../../examples/next-app/README.md). When you are done, stop it and start
the mock (`node packages/spec/dist/cli/nc-mock.js`) again to continue with the script.

## 5. Resume: verify the Resumption

Once the approval is approved, the agent that created it reads the **Resumption**. Only the creating
principal can: another service principal gets `404 not_found`, and a user gets `403 not_owner`. Before the
approval is resolved there is nothing to read yet, and the creator gets `404 not_found` too. A rejected
approval has a Resumption as well; it says `resolution: rejected` and carries no `resume_token`, and you do
not run the action. The Resumption is a compact JWS signed with ES256. Its payload says what was approved: `approval_id`, `tool_ref`,
`action_digest`, `resolution`, `approver`, `resolved_at`, `expires_at`, the `continuation` you sent, and for
an `ext:` tool a `resume_token`.

```json
{
  "data": {
    "approval_id": "cb9b58ae-8006-4aec-aad9-12c2c55ee7ad",
    "action_id": "act_5e22011dc10e",
    "tool_ref": "ext:local:send_email",
    "obligation_kind": "tool_invocation",
    "resolution": "approved",
    "action_digest": "5e22011dc10edcd3831fe6a6bba074428a9b307fb7260cd3d3e95c5b45317d0b",
    "approver": { "id": "user_approver", "kind": "user" },
    "resolved_at": "2026-10-09T18:45:57.351Z",
    "expires_at": "2026-10-09T19:45:57.350Z",
    "policy": { "id": "pol_default", "version": 3 },
    "continuation": { "kind": "webhook", "delivery": "pull" },
    "resume_token": "rt_…",
    "signature": "eyJhbGciOiJFUzI1NiIs….….…"
  },
  "meta": { "request_id": "req_…", "deployment": "hosted" }
}
```

Do not trust the JSON next to the signature. Verify the signature, against the public key set at
`/.well-known/jwks.json` (no token needed), and against the action you are about to run.
`verifyResumption` takes the compact JWS **string**, `resumption.signature`, as its first argument. It
checks the structure, the algorithm, the key id, the signature, the expiry, that the resolution is
`approved`, that the `tool_ref` is the one you are about to run, and that `action_digest` equals the digest
of the arguments you are about to send.

The snippet first tries changed arguments, to show the refusal: a `ResumptionError` carries a `code`, here
`digest_mismatch`. The approval belongs to the arguments that were approved, not to the tool in general.

<!-- snippet: resume -->

```ts
import {
  argDigest,
  InMemoryReplayGuard,
  ResumptionError,
  verifyResumption,
} from '@noblecloak/client';
import type { Jwks } from '@noblecloak/client';

import { baseUrl, creator } from './connect.js';
import { unwrap } from './problem.js';
// Importing approve.js runs the approval first.
import './approve.js';
import { args, approvalId, digest, toolRef } from './step-up.js';

// Only the principal that created the approval can read its Resumption.
const { data: resumption } = unwrap(
  await creator.GET('/v1/approvals/{id}/resumption', { params: { path: { id: approvalId } } })
);

// The key set is public.
const jwks = (await (await fetch(`${baseUrl}/.well-known/jwks.json`)).json()) as Jwks;
const replayGuard = new InMemoryReplayGuard();

// Arguments that differ from the ones that were approved are refused.
export let refusal = '';
try {
  const changed = await argDigest({ ...args, to: 'mallory@example.com' });
  await verifyResumption(
    resumption.signature,
    jwks,
    { tool_ref: toolRef, arg_digest: changed },
    { replayGuard }
  );
} catch (error) {
  if (!(error instanceof ResumptionError)) throw error;
  refusal = error.code;
}
console.log(refusal); // digest_mismatch

// The arguments the runtime is about to send are the ones that were approved.
const verified = await verifyResumption(
  resumption.signature,
  jwks,
  { tool_ref: toolRef, arg_digest: digest },
  { replayGuard }
);
export const approvedBy = verified.approver.id;
console.log(verified.resolution, approvedBy); // approved user_approver

export const resumeToken = resumption.resume_token;
```

```sh
bun docs/snippets/resume.ts
```

The other codes of a `ResumptionError` are `malformed`, `unsupported_alg`, `unknown_kid`, `bad_signature`,
`expired`, `not_approved`, `tool_mismatch` and `replayed`. `acceptResolutions` lets you act on a resolution
other than `approved`, and `clockSkewSeconds` tolerates a little clock drift.

A Resumption is a **statement**, not a credential. Anyone who holds it learns that this action was
approved, and verifying it twice is harmless. You can fetch it only until the approval is consumed: after
that the fetch is `409 already_resumed`, so a runtime that crashed after consuming reads the approval instead. The guard in the snippet is a convenience for a runtime that
must not act on the same one twice after a retry. The single-use gate is the server's `/consume`, next.
`verifyResumption` does not check `resume_token`; the server does.

## 6. Consume, run, record

`POST /v1/approvals/{id}/consume` takes the `resume_token` and the action **as you are about to run it**.
The server recomputes the identity from that action, checks it against the approval, checks that the token
binds this approval, and spends the approval atomically and once. After it succeeds, the approval is
`consumed`, and a second consume is `409 obligation_consumed`. Then run the tool, and append the record. The
record names the decision, the approval it followed and what happened.

<!-- snippet: consume-and-record -->

```ts
import { creator } from './connect.js';
import { unwrap } from './problem.js';
import { args, approvalId, digest, toolRef } from './step-up.js';
import { resumeToken } from './resume.js';

if (resumeToken === undefined) throw new Error('the Resumption carries no resume_token');

// Consuming is the single-use gate: the server checks the action against the approval and spends it once.
const { data: consumed } = unwrap(
  await creator.POST('/v1/approvals/{id}/consume', {
    params: { path: { id: approvalId } },
    body: { resume_token: resumeToken, action: { tool_ref: toolRef, arg_digest: digest } },
  })
);
console.log(consumed.state); // consumed

// Run the tool. Here it only prints.
console.log(`sending "${args.subject}" to ${args.to}`);

// Close the loop: the record names the approval it followed.
const { data: record } = unwrap(
  await creator.POST('/v1/records', {
    body: {
      tool_ref: toolRef,
      decision: 'step_up',
      approval_id: approvalId,
      outcome: { status: 'succeeded', summary: 'email sent' },
    },
  })
);
export const linked = record.approval_link?.linked;
console.log(linked); // true
```

```sh
bun docs/snippets/consume-and-record.ts
```

Read `data.approval_link.linked` on the `201`. `true` means the record is now the approval's outcome. When
the link is refused, the record is still appended and the answer is still `201`: `linked` is `false` and
`reason` says why, one of `not_consumed`, `already_linked` or `not_found`. The record you appended stands
whether or not it linked. An `approval_id` that names no approval you may see is different: nothing is
written and the answer is `404 not_found`. The outcome `status` is `succeeded`, `failed` or `unknown`.

Consume before you run the tool, not after. The approval is spent on the attempt, so a crash between the
two can never run the tool twice. If you cannot tell whether a consume reached the server, read the
approval: `consumed` means it did.

That is the whole loop: decide, step up, approve, verify, consume, run, record.

## 7. The same thing with an adapter

You do not have to write that loop for every agent framework. The LangGraph adapter, `@noblecloak/langgraph`,
runs it for a LangGraph agent: it pauses the run on the approval, verifies the Resumption, consumes it, runs the
tool once and records the outcome. It lives in its own repository,
[`noblecloak-langgraph-ts`](https://github.com/NobleCloak/noblecloak-langgraph-ts), with its README, a worked
example and the skill that sets governance up for an existing LangGraph project.

## 8. Now against a real deployment

The code does not change. The base URL and the tokens do.

- **Audience.** A token's `aud` is the API's origin: scheme and host, no path and no trailing slash. A token
  for another API is `401 wrong_audience`.
- **Scope.** A service principal's token carries the scope `module_api`; without it a route answers
  `403 insufficient_scope`. A token with no organisation is `403 organization_context_required`.
- **A person resolving.** Where the deployment advertises `user_resolve_scope` in its capabilities, a user's
  token must carry that scope (`approvals:resolve` on the mock) to resolve an approval. Without it the answer
  is `403 insufficient_scope`, given before the approval is even looked up.
- **DPoP.** `GET /v1/capabilities` says whether the deployment verifies DPoP proofs: `dpop` is `off`,
  `optional` or `required`. Pass the `dpopProof` option of `createClient` when it is required.
- **Identity headers.** Send only the `Authorization` header. A request that carries any header an upstream
  gateway sets to say who the caller is gets `401 header_identity_rejected`, whatever the token.
- **Eligibility.** The requester cannot approve its own request, except through the approver surface where Capabilities advertises it. An org admin can approve.
- **Where the agent's token comes from.** A person signs in with OAuth 2.1 and PKCE. A headless agent needs
  an organisation-scoped service principal, which an organisation admin creates with `noblecloak sp create`
  (`@noblecloak/cli`; it writes the credential file the agent loads). A self-serve grant
  for it is coming: the contract describes it, and no deployment serves it yet.

Ask a deployment what it serves before you depend on it:

```sh
curl -s -H "Authorization: Bearer $TOKEN" https://<your-deployment>/v1/capabilities
```

## 9. Errors at each step

An API error is never thrown by the client. The call resolves to `{ error, response }`: `response.status` is
the HTTP status, and `error` is a problem document (RFC 9457) whose `type` is a URI. **The code is the last
path segment of `error.type`**, which is what `problemCode` returns. A problem may also carry `detail` and
`request_id`; quote the `request_id` when you ask for help.

| Step                 | Code                            | Status | What it means and what to do                                                                                                           |
| -------------------- | ------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Any                  | `unauthorized`, `invalid_token` | 401    | No token, or one that does not verify. Get a fresh one.                                                                                |
| Any                  | `wrong_audience`                | 401    | The token is for another API. Its `aud` must be this API's origin.                                                                     |
| Any                  | `dpop_unsupported`              | 401    | A DPoP-bound token sent to a deployment that does not verify DPoP. Use a bearer token.                                                 |
| Any                  | `header_identity_rejected`      | 401    | The request carried a gateway identity header. Send only `Authorization`.                                                              |
| Any                  | `insufficient_scope`            | 403    | The token lacks `module_api` (service) or the resolve scope (user).                                                                    |
| Any                  | `organization_context_required` | 403    | The token has no organisation and the route is organisation-scoped.                                                                    |
| Any                  | `forbidden`                     | 403    | Not permitted.                                                                                                                         |
| Any                  | `rate_limited`                  | 429    | Slow down and retry later.                                                                                                             |
| Any                  | `service_unavailable`           | 503    | The deployment cannot answer right now. Retry.                                                                                         |
| 3, 4 Decide          | `invalid_request`               | 400    | The body does not match the schema, for example neither or both of `arg_digest` and `arguments`.                                       |
| 4 Decide             | `invalid_continuation`          | 400    | The continuation does not fit its delivery, or the deployment does not serve that delivery.                                            |
| 4 Decide             | `callback_unroutable`           | 400    | A `push` callback URL that is not public-routable HTTPS.                                                                               |
| 4 Decide             | `continuation_conflict`         | 409    | The open approval already has a different continuation.                                                                                |
| 4 Decide             | `continuation_unsupported`      | 422    | The deployment does not serve approvals, so it cannot keep a continuation.                                                             |
| 4 Resolve            | `not_eligible`                  | 403    | The caller may not resolve this approval: its creator, any service principal, or a user the deployment does not accept as an approver. |
| 4 Resolve            | `approval_conflict`             | 409    | `expected_action_digest` is not the approval's action, or another resolution won.                                                      |
| 4 Resolve            | `already_resolved`              | 409    | Someone already resolved it.                                                                                                           |
| 4 Resolve, 6 Consume | `obligation_expired`            | 409    | The approval expired. Decide again.                                                                                                    |
| 5 Resume             | `obligation_consumed`           | 409    | The approval was already consumed.                                                                                                     |
| 5 Resume             | `not_owner`                     | 403    | Only the principal that created the approval reads its Resumption.                                                                     |
| 5 Resume             | `not_found`                     | 404    | There is no such approval, or it is not yours to see.                                                                                  |
| 5 Resume             | `already_resumed`               | 409    | The approval was already consumed, so its Resumption is no longer served.                                                              |
| 5 Resume             | `obligation_withdrawn`          | 409    | The requester withdrew the approval.                                                                                                   |
| 5 Resume             | `obligation_expired`            | 409    | The approval expired. Decide again.                                                                                                    |
| 5 Resume             | `continuation_expired`          | 409    | The continuation's own validity ran out.                                                                                               |
| 5 Verify (client)    | `ResumptionError.code`          | n/a    | Raised by `verifyResumption`, not by the API: `digest_mismatch`, `tool_mismatch`, `expired` and the rest.                              |
| 6 Consume            | `forbidden`                     | 403    | Only the principal that created the approval can consume it, and not from the approver surface.                                        |
| 6 Consume            | `not_found`                     | 404    | No such approval, or it is not yours to see.                                                                                           |
| 6 Consume            | `approval_conflict`             | 409    | The approval is not approved, the `resume_token` does not bind it, or the action is not the approved one.                              |
| 6 Consume            | `obligation_consumed`           | 409    | Already consumed. Do not run the tool again.                                                                                           |
| 6 Consume            | `continuation_expired`          | 409    | The continuation's own validity ran out.                                                                                               |
| 6 Record             | `invalid_request`               | 400    | The body does not match the schema.                                                                                                    |
| 6 Record             | `attestation_not_accepted`      | 400    | You sent `attestation`. The server derives it.                                                                                         |
| 6 Record             | `not_found`                     | 404    | `approval_id` names no approval you may see. Nothing was written.                                                                      |
| 6 Record             | `idempotency_key_reuse`         | 422    | The same `Idempotency-Key` was sent with a different body.                                                                             |

`Idempotency-Key` is accepted on `POST /v1/records`, `/v1/records/batch`, `/v1/approvals`, `/v1/agents`,
`/v1/runs` and `/v1/webhooks`: the same key and body within 24 hours returns the original answer. It is not
accepted on `/v1/decisions`, `/v1/tools`, `/consume` or `/resolve`.

## 10. Glossary

- **Action**: the thing being decided: a `tool_ref` plus the digest of the arguments (or the arguments).
- **Decision**: the answer to an action. `allow`, `deny` or `step_up`; `defer` is reserved. A decision that
  was observed but not enforced carries `enforced: false`.
- **Approval**: what a `step_up` opens, also called an obligation. Its state is `pending`, then `approved`
  (and later `consumed`) or `rejected`; it can also end as `expired` or `withdrawn`. What it covers is set out in
  [What an approval covers](../what-an-approval-covers.md).
- **Continuation**: how the runtime says it wants to learn that an approval resolved: a `kind` (the
  runtime) and a `delivery` (`push`, `pull` or `held`). The caller sends it; the creating principal reads
  it back.
- **Resumption**: the signed statement that an action was approved. Verify it; it is not single use.
- **Record**: the append-only entry for what was decided and done, linked to the approval it followed.
- **Principal**: whoever calls the API: a user, an agent, a service, a group or a role. A service principal
  is a headless client such as your agent. An organisation's administrator can bind an agent you declared with
  `POST /v1/agents` to one service principal (`PUT /v1/agents/{id}/principal`, body `{ "principal_id": ... }`). A
  policy that names the agent then applies to the calls made with that principal's token, and to no other call: the
  token says who is acting, and `actor.agent_id` in a request body is only a hint. One service principal is bound to
  one agent, and a second bind is 409 `principal_bound`. Every caller also holds the role `everyone`, so a policy on
  it is the baseline for all of them.
- **Deployment-applied reference**: a `tool_ref` in the namespace `tool:noblecloak:` that is no tool: it names a
  change the deployment makes itself when an approval for it is approved. [Propose a policy set for your
  agent](./propose-a-policy-set.md) walks through the first one, which registers an agent's tools, binds its service
  principal and publishes its policies as one approved change.
- **Capability**: what a deployment says it serves, from `GET /v1/capabilities`: the resolutions, the
  features, the limits, the DPoP setting and the scope a person needs to resolve.
- **Contract**: the OpenAPI document `@noblecloak/spec` ships. The typed client and the mock are built from
  it, so the shapes in this guide are the shapes on the wire.
