# @noblecloak/spec

The NobleCloak module API contract: one OpenAPI 3.1 document, a mock server that implements it, and
a conformance suite that passes or fails any server.

- **What the document is**
- **Install**, **Quickstart**
- **`nc-conform`**, **`nc-mock`**, **Exit codes and errors**
- **Scenarios**, **The corpus**, **Exports**, **Versioning**, **License**

## What the document is

One OpenAPI 3.1 document, `dist/openapi.public.yaml` in the published package (export `./openapi.public.yaml`).
It is the one document the mock serves and the conformance suite checks a server against.

Read it with `loadDocument`:

```ts
import { loadDocument } from '@noblecloak/spec';

const document = loadDocument(); // parsed OpenAPI 3.1
```

It is also importable as `@noblecloak/spec/openapi.public.yaml`. For typed calls use
`@noblecloak/client`, which is generated from the same document.

Every operation names where it is served (`x-noblecloak-deployment`: `both` or `hosted`), every 4xx
documents the problem types it can carry, and a JSON 2xx body under `/v1` is a `{ data, meta }` envelope.
The exceptions are named on their operations: the AuthZEN responses and the key set are bare, a policy
export is text, the approval stream is server-sent events, and a 204 has no body.

## Install

```sh
npm install @noblecloak/spec
```

That installs the document, the two commands (`nc-conform`, `nc-mock`) and the entry point below. Run a command
without installing it by naming the package: `npx -p @noblecloak/spec nc-mock`.

**The two commands run on Bun.** Their first line is `#!/usr/bin/env bun`, so `nc-mock` and `nc-conform` need Bun on
your `PATH`, even when npm or `npx` starts them. The document and the entry point are plain files and modules and
need no Bun.

## Quickstart

Start the mock, then run the suite against it with the tokens it prints:

```sh
npx -p @noblecloak/spec nc-mock --port 8787
# in a second terminal, with the "creator" and "approver" tokens it printed (or GET /__mock/tokens):
npx -p @noblecloak/spec nc-conform --base-url http://127.0.0.1:8787 \
  --token "$CREATOR_JWT" --approver-token "$APPROVER_JWT" --allow-skips
```

In a repository checkout, `nc-mock` and `nc-conform` do not resolve on the path until a build has put their targets in
place (bun links a workspace bin only if its target existed at install time). After `bun run build`, run
`bun packages/spec/dist/cli/nc-mock.js` and `bun packages/spec/dist/cli/nc-conform.js` instead.

Against your own server the same command, with your base URL and your tokens, says whether it speaks the
contract. Without the optional tokens some scenarios cannot run; they are listed as skipped, and the run exits 1
until you pass the token or `--allow-skips` (the command above passes it so that it succeeds; for a full run, pass
every token in the `nc-conform` section instead). For typed calls to a server, use `@noblecloak/client`; for a guided
walk through a tool call, an approval and its consumption, the how-to "Your first governed tool"
(`docs/how-to/first-governed-tool.md` in the repository).

## `nc-conform`

Runs the conformance suite against a server and passes or fails it.

```sh
nc-conform --base-url https://govern.example.com \
  --token "$CREATOR_JWT" \
  [--approver-token "$APPROVER_JWT"] \
  [--deployment hosted|edge] \
  [--admin-token ...] [--member-token ...] \
  [--creator-user-token ...] [--other-org-token ...] [--entitled-token ...] \
  [--wrong-audience-token ...] [--forged-token ...] [--expired-token ...] \
  [--dpop-bound-token ...] [--no-org-token ...] [--no-scope-token ...] [--other-service-token ...] \
  [--approver-surface-token ...] [--approver-token-without-resolve-scope ...] \
  [--reserved-tool-ref <ref>] [--system-tool-ref <ref>] [--tool-ref-in-use <ref>] [--on-deny-tool-ref <ref>] [--on-deny-silent-tool-ref <ref>] [--no-on-deny] \
  [--admin-role <key>] [--connection-server-url <url>] [--oauth-return-to <url>] \
  [--clock-control <url>] [--mock-control <url>] \
  [--webhook-sink <https-base> --webhook-sink-token <token> [--webhook-sink-wait <s>] [--webhook-sink-settle <s>]] [--allow-skips] [--reject-undeclared | --allow-undeclared] [--json]
```

`--token` is the principal that creates obligations (an adapter), and is required. `--approver-token` is optional: it is a
different principal that may resolve them. Without it, every scenario that has the approver act is skipped as
`unconfigured`, and so is `every-route-responds-per-schema` when it leaves a route unexercised that only those scenarios reach (it names them), so a run without `--allow-skips` exits 1; a full conformance claim therefore needs both principals. Where the deployment advertises `user_resolve_scope`, `--approver-token` (and `--approver-surface-token`) must carry that scope. `--creator-user-token` is a second creating principal of kind `user`:
`--token` is a service principal, which is refused on kind alone, and a user is refused on identity
alone, so the suite proves the two rules apart. `--dpop-bound-token` is a user token that carries `cnf.jkt`, `--no-org-token` a user token with no organisation
claim, and `--no-scope-token` a service-principal token without the `module_api` scope; the scenarios for
`dpop_unsupported`, `organization_context_required` and `insufficient_scope` need them (a deployment
that verifies DPoP proofs has no `dpop_unsupported` to show). Because nothing here can prove that a
deployment advertising DPoP mode `optional` or `required` really checks proofs, the two `dpop_unsupported`
scenarios are then an unverified skip (they count against the exit code, like a missing token), not a
capability skip. `--other-service-token` is a second service principal of the same organisation as `--token`; the scenario
that shows one service principal cannot see another's approvals needs it. `--other-org-token` is a user of a different
organisation, which the tenancy scenarios use to prove it can see and change none of the first
organisation's data. `--token` must be a service principal: the approval-visibility scenarios prove that
a service principal sees only the approvals it created, and that a user principal sees the organisation's.
Nothing checks the token's kind at startup (`GET /v1/capabilities` names no principal): given a user
token, those scenarios fail (for one, the creator's unfiltered list carries another user's approvals),
without saying that the token is the cause.
`--admin-token` is the token a step uses when it says `as: admin`: the steps that register or change a tool,
for a deployment that lets only an organisation's administrators do that. Absent, those steps use `--token`;
against a deployment that restricts registration, a run that forgets it fails the scenarios that register a
tool as `admin` with 403 `forbidden`. One scenario is about what an administrator who is a user sees
(`tools-principal-owned-seen-by-administrator-users-only`) and cannot be shown with `--token` standing in: without
`--admin-token` it is skipped as `unconfigured`, and the exit code is 1 unless `--allow-skips`. `--other-org-token` must be
allowed to register a tool in its own organisation where registration is restricted. From rev 10 the scenarios that
author, replace or publish a policy run as `admin` and need `--admin-token`, a user the deployment recognises as an
administrator of the organisation (a service principal never is): without it they are `unconfigured` skips, never an
authoring attempt as the creator, and the every-route check reports the routes only they reach as an `unconfigured`
skip naming `admin`, as it does for `approver`. Each registers its own organisation-owned tool and targets only that
tool.
`--approver-surface-token` (rev 7) is the same user as `--creator-user-token`, with a token issued to the deployment's
approver surface (the approvals module's own client). The two scenarios about the surface rule need it
(`creator-may-resolve-from-the-approver-surface`, `approver-surface-token-cannot-open`) and run only where
`GET /v1/capabilities` says `self_approval_from_approver_surface: true`; elsewhere they are capability skips,
and with the capability but without the token they are `unconfigured` skips, as for `--member-token`.
`--approver-token-without-resolve-scope` (rev 8) is the same user as `--approver-token`, with a token minted without the
scope `GET /v1/capabilities` names in `user_resolve_scope`. The two scenarios about it
(`user-token-without-resolve-scope-is-insufficient-scope` and `available-actions-hidden-without-resolve-scope`) run only where that member is advertised; elsewhere it is a
capability skip, and with the member but without the token it is an `unconfigured` skip, as for `--member-token`.
`--member-token` is a user of the organisation that is neither the creator nor eligible to approve (on a
deployment that restricts approving to some users, a user outside them): the scenarios that show such a user
reads an approval's digest and never its arguments, and sees no available actions (rev 15), need it. Absent, those scenarios are skipped as
unconfigured, so a run exits 1 unless it passes `--allow-skips` or the token, as for `--other-service-token`.
`--reserved-tool-ref` and `--system-tool-ref` name a tool reference in a namespace the deployment reserves
and the reference of one of its system tools, which `POST /v1/tools` must refuse (`reserved_tool_ref`,
`system_tool_ref`). `--tool-ref-in-use` names a reference already in use in the caller's organisation
for a tool registered another way, so that registering it would make a call ambiguous
(`tool_ref_in_use`). `--on-deny-tool-ref` (rev 9) names a tool whose matching policy is `ask` (or `escalate`) and states
`on_deny`: the scenario that expects `Approval.on_deny` for the creator needs it, and the approver token must be eligible
to resolve that tool's approvals (the scenario approves them; an `escalate` policy that routes to another approver group
may not allow it). A deployment that implements no `on_deny` on its policies passes `--no-on-deny` instead: that scenario is
then a `capability` skip, which does not affect the exit code, and it needs no `--allow-skips`. `--on-deny-silent-tool-ref`
names a tool whose matching policy is `ask` and states no `on_deny`; every deployment with an `ask` tool supplies it,
whether or not it implements `on_deny`, because the scenario that expects the creator to be told nothing of a deny
(never `resume` or `halt` by default) binds a deployment that implements none too.
Rev 11 adds three fixtures, each an `unconfigured` skip without it. `--admin-role` names the bare key of a role the
`--admin-token` holds: the tightest-wins scenario authors a policy for that role and the simulate-as-a-subject scenario
simulates as it. `--connection-server-url` names a tool server the deployment can reach and enumerate: the scenarios that
refresh, discover, delete and register it again, and the one about an approval blocked on a link, each register it and
delete the registration at their end. The organisation must not already have a registration of that server (a
second is 409 `connection_exists`), and a scenario that fails before its last step leaves its registration behind, so
the next run meets that 409 until it is deleted; without it the every-route check reports refresh and discover as an
`unconfigured` skip naming the fixture. `--oauth-return-to` names a `return_to` on an origin the deployment admits for
browser modules, for the authorize scenarios. From rev 11 the connection scenarios register as `admin` (a deployment may
let only administrators register), each with a server URL of its own, since an organisation has one registration per
server URL. `--mock-control` is the URL of a server's control endpoint (only the mock has one):
the scenarios that need a deployment to fail once, or to advertise a batch limit below 100, run only with
it. `--webhook-sink` and `--webhook-sink-token` name a public HTTPS receiver the deployment can deliver webhooks to (the scenarios register their webhooks under it as `${callback_base_url}`, default `https://hooks.example.com`); the scenarios that read a webhook's deliveries then read them from the sink with a bearer `GET`, polling every 2 s for up to `--webhook-sink-wait` seconds (default 60) and re-reading after `--webhook-sink-settle` seconds (default 10), instead of needing `--mock-control`. The server must expose the fixture tools the scenarios use, named by `--proxied-tool` (default
`mcp:tracker:create_issue`), `--allow-tool` (`mcp:tracker:search`), `--deny-tool` (`mcp:crm:delete_account`) and
`--default-tool` (`mcp:tracker:list_labels`, a tool no explicit policy matches); `--deployment` defaults to `hosted`. And a scenario that needs a token or a capability
you did not give is skipped, not failed, **but the run still exits 1**: a server whose negative-authz,
wrong-audience or expiry checks never ran is not shown conformant. The skipped scenarios and the flag
that enables each are printed as a warning. Pass `--allow-skips` to exit on failures alone. A skip by
design (another deployment) never affects the exit code.

**Partial deployments.** A run starts by reading `GET /v1/capabilities` with `--token`; an answer that
is not 200 or does not match the document fails the run. A deployment serves the floor (capabilities,
decisions, records append/list/get, tools, AuthZEN, the well-known documents, every authentication
rule) and then the route families it advertises: `approvals` when `resolutions` is non-empty, and each
of `runs`, `webhooks`, `origins`, `policies`, `agents`, `principals`, `connections`,
`records.checkpoints`, `records.chain`, `evidence` when its name is in `features`. A scenario that
declares `requires: <family>` (a name or a list) for a family that is not advertised, or `unless: <family>` for
a family that is advertised, is printed `skipped: capability`; so is a scenario that declares `features: [...]` (rev 10) for a
feature in `features` that is not a family (`policies.author`, `policies.publish`, `policies.import_export`,
`records.verify`, `evidence.export`, `approvals.rejected_duplicate`) that the deployment does not advertise, and the
every-route check leaves out an operation whose feature (`x-noblecloak-feature`, policy import and export) is not
advertised; and so is a scenario that declares `limits: [...]` for a batch limit
(`Capabilities.limits`) the deployment does not advertise, or advertises as 100. Those scenarios send the advertised limit and the
limit plus one and need no mock control, so they verify the limit a hosted façade advertises. A scenario that
declares `unreduced_limits: [...]` sends the largest batch the contract allows (100) and is skipped the same way by a
deployment that advertises a lower limit; an absent limit means 100, so it runs. That skip does not affect the exit code and needs no `--allow-skips`, and the generated every-route
checks leave out the routes of such a family. The floor is never skipped.
**Restrictions a deployment advertises (rev 6).** `GET /v1/capabilities` may say that a deployment restricts
what the rest of the document allows: `limits.approval_arguments_max_bytes`, `continuation_deliveries` and
`tool_registration`, besides `resolutions` and `limits.resolutions_batch_max_items`; rev 17 adds `continuation_kinds`, the
continuation kinds the deployment accepts, whose absence means the seven kinds of rev 16 rather than no restriction, and rev 18
`proposals`, the rows and members of a policy-set proposal it accepts, whose absence means those of rev 14. A scenario that
declares `advertises: [...]` (a list of those members), `unserved_delivery: <delivery>` or
`unserved_resolution: <resolution>` (about what the deployment does _not_ serve), or `tool_registration:
administrators`, runs only against a deployment that says so; against any other it is printed `skipped:
capability` (not served), never `unconfigured`, and does not affect the exit code. The converse is also a capability skip:
`serves_delivery` and `serves_resolution` name what a scenario's success needs (the public-callback check needs
`push`; the stream scenario that escalates needs `escalated`), `serves_kind` (rev 17) names a continuation kind it
needs (skipped where `continuation_kinds` lacks it, or is absent and the kind is not one of rev 16's), `serves_row_kind` and
`serves_proposal_member` (rev 18) name a row kind or an optional member of a proposal it needs (skipped where `proposals` lacks
it, or is absent and it is not one of rev 14's), and `tool_registration: any` marks a scenario
that registers a tool as a principal that is not an administrator (another organisation's user). Where a deployment
lets only administrators register tools and the run has no `--admin-token`, a scenario that says `as: admin`
is skipped as `unconfigured` (the exit code is 1 unless `--allow-skips`), because the creator token that stands in
for `admin` is refused there and the scenario would not have shown what it checks. Pass `--admin-token`.

A response that carries a field its schema does not declare fails the run. That is the default, and
`--reject-undeclared` says it explicitly; `--allow-undeclared` turns it off. The two flags contradict each other:
passing both is a usage error (exit 2). The scenarios are described under Scenarios below.

**Known failures.** `nc-conform` has no flag to mark a scenario as an expected failure, to select scenarios or to
exclude any: it runs all of them and exits 1 if one fails. To accept a failure you already know about, run it with
`--json` and compare the `id` of each `results` entry whose `outcome` is `failed` with a list you keep. A CI wrapper that exits 0 only when the failed
ids equal that list does it, and fails when a listed scenario starts passing, so the list cannot go stale.
`--allow-skips` is the only exception the command makes, and it covers skips, never failures.

**What the suite does not test.** The document says things that no scenario can exercise against a server
that behaves and offers no control, so a conformant run does not show them: a deployment that cannot determine
whether a reader is eligible to approve answers 503 `service_unavailable` with `reason` `eligibility_lookup`
(never the digest-only view); a body above the deployment's limit is 413 `payload_too_large`; and a decision
for an approval the deployment cannot route is `deny` with reason `approval_unroutable` (the 422
`approval_unroutable` of `POST /v1/approvals` is tested). With `--mock-control` the suite injects the first two
against the mock and checks the shape of the answer; against a deployment it can only check the shape, never the
cause. Likewise `Problem.reason` and `retry_after_seconds` are checked only where a server can be made to fail.

## `nc-mock`

Serves the contract from in-memory fixtures.

```sh
nc-mock [--port 8787] [--deployment hosted|edge] [--advertise <family>,...] [--allow-origin <origin>]... [--break <flag>]...
        [--approval-arguments-max-bytes <n>] [--deliveries push,pull,held] [--restrict-tool-registration]
        [--max-body-bytes <n>] [--resolutions approved,rejected,escalated] [--no-runs]
        [--approver-surface-client <client_id>]
```

Defaults: port 8787 (`--port 0` picks a free one), bound to `127.0.0.1`, deployment `hosted`. At start it prints
a JSON object with `base_url`, `deployment` and the development `tokens`, and then serves until interrupted; the
same tokens are served at `GET /__mock/tokens`. **`/__mock/*` exists only on the mock** (tokens, clock and failure
control): a real deployment has none of those routes.

It prints a base URL and dev tokens, and serves the contract from in-memory fixtures. Its `decide` is
a fixture lookup, not policy. `--port` is an integer from 0 to 65535 (0 picks a free one). `--face public`
is still accepted, by `nc-mock` and `nc-conform` alike, and ignored with a deprecation line on stderr: the
package has one document; a later release rejects the flag. `--break` flips one
behaviour on purpose (it may be repeated; an unknown flag lists the known ones and exits 2), so you can
see that a conformance check fails against a server with that defect:
`nc-mock --break accept_missing_token`, then run `nc-conform` against it. `--advertise decisions,records`
serves and advertises the floor and only the families named (`--advertise decisions,records` is the floor
alone), so a run against it shows the capability skips. `--allow-origin http://localhost:3000` lets a
browser on that origin call the mock (it may be repeated). Each origin is exact, as a browser sends it:
`*`, a pattern, a path or a trailing slash exits 2. The answer follows the hosted API's: allowed methods
`GET, POST, DELETE, PUT, PATCH, OPTIONS`; allowed request headers `Content-Type`, `Authorization`,
`Idempotency-Key`, `X-Request-Id` and `DPoP`; only `X-Request-Id` exposed; `Max-Age` 600; no credentials.
A preflight is answered before authentication, on `/__mock/*` as on `/v1/*`. With no `--allow-origin` the
mock sends no CORS header. From rev 12 the mock also admits the origins an organisation registered with
`PUT /v1/origins` (an administrator's write; the `admin` dev token is one): a preflight is answered for an origin in the union of
the listed and every organisation's registered origins, and an actual request whose `Origin` is in neither the list nor the caller's own organisation's origins is 403 `forbidden`
with no CORS header. A preflight from an origin that is not admitted gets no CORS header and the
route's ordinary answer (404), which may differ in status from the hosted API's. `startMock` and `createMock` take the same list as `allowedOrigins`.

The rev 6 flags make a mock a deployment that restricts something, so that the scenarios about a restriction
run and the runner's capability skips can be seen. `--approval-arguments-max-bytes 512` advertises
`limits.approval_arguments_max_bytes` and refuses larger arguments for a tool that shows them (400
`invalid_request`); `--deliveries pull,held` advertises `continuation_deliveries` and refuses a continuation of
another delivery (400 `invalid_continuation`); `--restrict-tool-registration` advertises `tool_registration:
administrators` and lets only `user_admin` and the adapter's service principal register or change a tool (the
`admin` dev token is `user_admin`); `--max-body-bytes 4096` answers a larger body 413 `payload_too_large` with
`max_bytes`; `--resolutions approved,rejected` advertises that list and refuses `escalated` (400 `invalid_request`);
`--no-runs` is every family but `runs`, so a `run_id` is 404 `not_found`; it and `--advertise` both choose
which families are served, so passing both is a usage error (exit 2). A tool owned by a principal (the default
for `owner_kind`) is listed to its registering principal and the administrators only.

The mock has an approver surface (rev 7): `--approver-surface-client <client_id>` names it (default
`noblecloak-approvals-module`), and the `approver_surface_token` dev token is the creator user's token with that
`client_id` and, since rev 14, the administrator role (it approves deployment-applied proposals). A token issued to it resolves an obligation its own user opened, and is refused on `POST /v1/approvals`
(403 `forbidden`); the user's own token is still `not_eligible`. The mock admits a proxy obligation to `allow` only when
it was created under a run, and tells a record that names an approval whether it was linked (`approval_link`).

The mock advertises `user_resolve_scope: "approvals:resolve"` (rev 8) and mints that scope on every user token; the
`approver_token_without_resolve_scope` dev token is the approver's own user without it. A user token that lacks the
scope is 403 `insufficient_scope` on resolve, approve, deny and the batch, answered before the approval is looked up or
eligibility considered; reads, withdraw and consume are not gated by it, and a service principal is still refused as
`not_eligible`.

The mock snapshots `on_deny` (rev 9) when it opens an approval: the `on_deny` of the stored policy the approval names
(`pol_default` for the seeded `ask` tools, `pol_silent`, which states none, for `mcp:tracker:add_comment`), taken only
where that policy's mode is `ask` or `escalate` and only from its published version, so a later edit that is
published changes new approvals and not existing ones. It gives `on_deny` to the approval's creator and to no other
reader; a tool registered through the API names no policy and carries none.

The mock's policies (rev 10) keep their versions: `POST /v1/policies` writes a draft (version 1), a `PUT` replaces a
draft or, on a published policy, writes a draft of the next version, which the read leaves aside until it is published,
and `GET /v1/policies/{id}/versions` lists every version, the draft included. Only a user holding the mock's own role `policy_admin`
authors (the `admin` dev token does; who is an administrator is each deployment's own rule); anyone else is 403 `forbidden`, after the 404 for a policy the caller cannot see.
The mock refuses with 422 `unsupported_policy_form` (rev 13: with `member` naming the place; `detail` keeps its rev 12 prefix) a kind it does not implement, `not_granted`, and a
`duplicate_requests` policy whose subject is not the organisation or whose targets are not every tool, and answers 409
`policy_conflict` when a publish would govern a (tool, subject) pair another published tool policy governs. Simulate
lists in `considered` every policy in force (the simulated version standing in for its own) whose targets cover the
tool and a subject of which matches the caller, composes them tightest-wins (rev 11: `deny` and `not_granted` over
`ask` and `escalate` over `always_allow`, whoever the subject), marks each entry of the winning mode `contributed`,
names the simulated policy as the decision's `policy` when it contributed, and falls to the tool's own mode as the
default only when nothing matched; the mock's decide still answers from the tool's mode, so the agent binding and the
`everyone` role below are shown through simulate without `subject`, which is scoped as a decision would be. As a subject (rev 11, the
`admin` token only) it evaluates a role as that role and the organisation, the organisation alone, or a user with the
roles of the latest token the mock saw for that user (a user it never saw holds none). It retires a published policy
and discards a draft (rev 11), and keeps each version's `origin`.

The mock's connections (rev 11) keep a status, a credential tier and a write-only organisation credential; a server's
URL is its identity (scheme and host case, the default port and a trailing slash do not count), so a second
registration of it is 409 `connection_exists`. Refresh and discover answer the same two tools for every server, with
references that stay the same across delete and re-add; delete withdraws them and re-registering the URL makes them
active again. Each caller's link is its own; the authorize step answers a URL of the mock's consent page
(`/__mock/consent/{id}`, served with control on), which returns the browser to `return_to` with the `nc_` parameters
(`?deny=1` refuses), and admits a `return_to` on `https://module.mock.test`, an origin registered with `PUT
/v1/origins`, or an `--allow-origin`. An approval of a tool whose `per_user` registration its creator has no usable
link to carries `blocked_on` for the creator. `--restrict-connection-registration` registers organisation-owned
connections by administrators only, and `--connection-transports mcp` serves one transport. It applies the rejected-duplicate rule and advertises
`approvals.rejected_duplicate` on both deployments wherever it serves approvals; with no `duplicate_requests` policy
published the setting is `deny` for 24 hours. The mock has no path on which an approval ends `rejected` because its
action was refused when it ran, so every rejection it records is a resolver's.

`--break <flag>` takes one of the names in the exported `BREAKS` list (`import { BREAKS } from '@noblecloak/spec'`),
for example `accept_missing_token`, `ignore_audience` or `digest_not_jcs`. An unknown name prints the known ones
and exits 2. `--approver-surface-client <client_id>` names the approver surface described above.

## Exit codes and errors

`nc-conform --json` prints the report as JSON instead of text. Exit codes of both commands: 0 success,
1 a failed scenario (or an unverified skip, for `nc-conform`), 2 a usage error.

A usage error (an unknown flag or `--break` name, a malformed value) prints a line beginning `nc-mock:` or
`nc-conform:` on standard error and exits 2. A server's own errors are RFC 9457 problems; their codes are listed
in the document's `info.x-noblecloak-problem-types` and, with what to do about each, in the README of
`@noblecloak/client`.

## Scenarios

The suite is data: YAML files in `scenarios/` (each file is a scenario or a list of them). Read one top down.

```yaml
- id: problem-request-id-on-every-problem # unique across all files
  title: Every problem carries a non-empty request_id
  tags: [both, negative, floor] # where it applies, and whether it is a negative
  steps:
    - name: no token # optional label
      as: none # which token: creator, approver, admin, member, none, ...
      request: { method: GET, path: /v1/capabilities }
      expect:
        status: 401
        problem: unauthorized # the body's type ends with /unauthorized
        body:
          - { path: request_id, matches: '.+' }
```

- `tags` say where it runs (`both`, `hosted`, `edge`) and what it is (`negative`, `floor`, `needs-mock-control`). A
  scenario with no `requires` (as above) is part of the floor and always runs; one that declares
  `requires: approvals`, say, runs only where the deployment advertises that family.
- `requires`, `unless`, `features`, `limits`, `advertises`, `dpop` and similar members select scenarios by what
  `GET /v1/capabilities` advertises; a scenario whose condition is not met is a capability skip, which does not
  affect the exit code. `needs` and `fixtures` name tokens and fixtures the run must be given; without them the
  scenario is an unconfigured skip, which does.
- A step is a request with an `expect` (a status, a `problem` code, predicates over the body such as `equals`,
  `exists`, `matches`, `in`, `contains`, `contains_members`, `length`, and response `headers`), or one of: `control` (make the mock
  fail once, lower a limit, disable a webhook or hand over its deliveries), `advance_seconds` (move the mock's clock), `verify` (a Resumption or a webhook delivery; `verify_resumption` is the earlier form), `authzen`, and
  `stream_events`. A step's `save: { approval_id: data.approval.id }` keeps a value of the response body for later
  steps as `${approval_id}`; `${uniq}` is a fresh string per run.
- `foreach: corpus` runs the steps once per vector of [the corpus](#the-corpus), with `item` bound to it.

**To add one**, in a checkout of this repository: add a file to `packages/spec/scenarios/` (or an entry to an
existing one) with a unique `id`. A scenario tagged `negative` must also appear in a row of the broken-mock
matrix (`packages/spec/src/conformance/matrix.ts`), which names the `--break` flag that makes it fail; a negative
that passes against a server with its defect checks nothing. Then run `bun run test` in `packages/spec`, which
runs the suite against the mock and the broken-mock matrix. The published CLI runs the
scenarios of the package; it has no flag for a directory of your own.

## The corpus

`@noblecloak/spec/corpus` is `corpus/arg-digest-pairs.json`: test vectors for the argument digest, so an
implementation in any language can check that it digests arguments the way the platform does. It holds
`version`, a `description`, the formula `arg_digest` (`lowercase_hex(SHA-256(UTF8(JCS(arguments_as_sent))))`) and
`pairs`, a list of `{ id, arguments_json, arg_digest }`. Parse `arguments_json`, canonicalise it with RFC 8785,
hash the UTF-8 bytes with SHA-256 and compare the lowercase hex to `arg_digest`.
`corpus/arg-digest-pairs.sha256` is the SHA-256 of the JSON file, a pin that shows the vectors were not edited
by hand. `nc-conform` runs the same vectors against a server
(`foreach: corpus`).

## Exports

| Specifier                              | What it is                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@noblecloak/spec`                     | `loadDocument`, `loadSpec`, `operationsOf`, `SpecIndex`, `PUBLIC_SPEC`, `packageRoot`, `createMock`, `startMock`, `BREAKS`, `runConformance`, `formatReport` and their types. |
| `@noblecloak/spec/openapi.public.yaml` | The document, as YAML.                                                                                                                                                        |
| `@noblecloak/spec/corpus`              | The argument-digest vectors, as JSON.                                                                                                                                         |
| `@noblecloak/spec/package.json`        | The manifest.                                                                                                                                                                 |

Bins: `nc-conform` and `nc-mock`.

`createMock` and `startMock` serve the document they are given (`spec`, default the published one). A deployment
that extends the document adds its members to every approval handle the mock serves with
`extendHandle: (handle, obligation) => handle`; without it a handle is exactly what the document declares.

## Browser origins and webhook deliveries (rev 12)

**Register the origins your module runs on.** An administrator of the organisation replaces the set with
`PUT /v1/origins`; any principal of the organisation reads it with `GET /v1/origins`.

```sh
curl -X PUT "$BASE/v1/origins" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"origins": ["https://app.example.com", "http://localhost:3000"]}'
```

Each origin is exact, `scheme://host[:port]` as a browser sends it in `Origin`: no path, trailing slash,
userinfo or wildcard, and `https` (`http` only for `localhost` and `127.0.0.1`). A deployment refuses an origin that is not
exact with 400 `invalid_request`; it never strips a slash for you. A preflight is answered for the registered
origins of every organisation, so it reveals nothing about who registered one. An actual request carries your
token and is checked against your own organisation's origins plus the deployment's own: any other `Origin`
is 403 `forbidden` and the answer carries no `Access-Control-Allow-Origin`.

**Subscribe a webhook, then verify what arrives.** An administrator creates a subscription with
`POST /v1/webhooks` (`{ "url": "https://...", "events": ["approval.resolved"] }`). There is no secret: a
delivery is signed with the deployment's key. A delivery is a `POST` with `Content-Type:
application/cloudevents+json`, a CloudEvents 1.0 JSON object (`WebhookDelivery`) with a `signature` member,
and an unsigned `NobleCloak-Webhook-Id` header naming your subscription. `data` is thin: it names the resource and its new
state, and you read the resource with your own token. To accept a delivery, verify the JWS against the key
set, check that the signed payload is the body without `signature`, and dedupe on `id`:

```ts
import { jcs } from '@noblecloak/client';

const seen = new Set<string>(); // keep this in a store shared by your instances

export async function accept(request: Request, jwks: { keys: JsonWebKey[] & { kid?: string }[] }) {
  const delivery = (await request.json()) as Record<string, unknown> & {
    signature: string;
    id: string;
  };
  const [header, payload, signature] = delivery.signature.split('.') as [string, string, string];
  const { alg, kid } = JSON.parse(atob(header.replace(/-/g, '+').replace(/_/g, '/')));
  const jwk = jwks.keys.find((key) => key.kid === kid);
  if (alg !== 'ES256' || jwk === undefined) return new Response(null, { status: 400 });

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const bytes = (text: string) =>
    Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const signed = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    bytes(signature),
    new TextEncoder().encode(`${header}.${payload}`)
  );

  // The payload must be this body without `signature`, in its JCS form.
  const { signature: _signature, ...unsigned } = delivery;
  const covers = new TextDecoder().decode(bytes(payload)) === jcs(unsigned as never);
  if (!signed || !covers) return new Response(null, { status: 400 });

  if (seen.has(delivery.id)) return new Response(null, { status: 200 }); // already handled
  seen.add(delivery.id);
  // ... read the resource named by `delivery.subject` with your own token ...
  return new Response(null, { status: 200 }); // any 2xx means delivered
}
```

Any 2xx answer means delivered. Otherwise the deployment retries with backoff for at least 24 hours and then drops the
delivery, and a webhook whose deliveries have failed continuously for 72 hours becomes `disabled` (`state` on the
subscription); delete it and create it anew to enable it again. Deliveries are not ordered and may repeat.

## Agent identity, the `everyone` role and simulating a set (rev 13)

Rev 13 makes four additions, each optional on the wire, so a rev 12 server's responses still validate.

**Binding an agent.** An agent you declare with `POST /v1/agents` can be bound to one service principal of the
organisation: `PUT /v1/agents/{id}/principal` with `{ "principal_id": "<service principal id>" }`, and `DELETE` to remove
it (204, and 204 again when it was never bound). Both are for an administrator of the organisation; a service
principal, itself included, is 403. `Agent.principal_id` reads the binding (`null` when unbound). A service principal is
bound to at most one agent: binding it to a second is 409 `principal_bound`, whose `agent_id` names the agent that
holds it, and an id that is no service principal of the organisation is 404. A policy whose subject is an agent
applies to a call only through this binding: the token says who is acting, so `actor.agent_id` in a request body is a
display hint and never selects a policy (a change for anyone who relied on the hint). An approval opened with a bound
principal's token names the bound agent and ignores the hint.

**The `everyone` role.** Every caller holds the reserved role `everyone`, a user, an agent or a service principal. A
policy may name it as a subject, and it applies to every caller beside the policies of the caller's other subjects, so
it is the organisation's baseline. It is held implicitly: it is never assigned, never listed by `GET /v1/principals?type=role`
and never created. Simulating as `{ "type": "role", "id": "everyone" }` gives the baseline, and a simulation as an agent
is that agent's policies, `everyone` and the organisation's. Every holder of a subject other than the organisation also
holds `everyone`: a simulation as the organisation is the organisation subject alone. (The word `default` is not a role: it is only a value of
`source` on a `considered` entry that is a default of the deployment.)

**Simulating a set.** `POST /v1/policies/simulate` takes `policies` (1 to 100 policy bodies, as `POST /v1/policies` takes
them) with the call to decide, and needs no stored policy: use it when nothing is published. The bodies stand beside
what is in force and never replace a stored policy. An entry of `considered` that comes from a proposed body has a null
`id` and `version` and a `proposed_index`; a deployment's default also has a null `id` and `version`, and carries
`source` instead. Nothing is written. Without `subject` it needs no administrator.

**A structured `member`.** `unsupported_policy_form` carries `member`, a path into the request body as sent
(`subjects[0].type`, `config.mode`, `subject`, `policies[2].subjects[0].type`). `detail` stays prose; a client reads
`member` and falls back to `detail` for a rev 12 deployment.

The mock shows all four. Its `decide` still answers from the tool's mode, so the binding and `everyone` appear through
simulate without `subject`. A service principal is one the mock has seen call it (`svc_adapter`, `svc_other` and
`svc_no_scope` are always known).

## Deployment-applied proposals (rev 14)

Rev 14 adds one thing, optional on the wire, so a rev 13 server's responses still validate (it also narrows the namespace below): a **deployment-applied
reference**, a `tool_ref` in the namespace `tool:noblecloak:` that names a change the deployment makes itself when an
approval for it is approved. The first is `tool:noblecloak:propose-policy-set`: a person opens it through `POST
/v1/approvals` with a `PolicySetProposal` (an agent's tools, its service principal and its policies), an administrator
approves it, and the deployment registers the tools, binds the principal and publishes the policies in one step, or
applies nothing. The walk-through is `docs/how-to/propose-a-policy-set.md` in the repository.

**The namespace.** It is reserved to the deployment: registering a tool under it is 422 `reserved_tool_ref`, the
reference is never listed by `GET /v1/tools` and a decision on it is a `deny` for an unknown tool. Its policy is fixed,
and authoring a policy that targets it (or simulating a body that does) is 422 `policy_immutable`. A deployment lists
what it applies in `Capabilities.deployment_applied` (`{ tool_ref, arguments_schema_ref }`); one that does not list the
reference answers 422 `approval_unroutable`.

**Opening.** Only a user opens a proposal. A refusal is 422 `proposal_refused`, whose `code` is `not_a_user`, `shape`,
`unknown_agent`, `principal_bound`, `tool_ref_in_use`, `target_unknown`, `baseline_exists` or `tightening_looser`, and
whose `member` (widened from `unsupported_policy_form`) names the part of the body, for example
`action.arguments.policies[1].policy.targets.tools[0]`. `Approval.preview` (`simulations`, one per tool the policies
govern, and `loosening`, the baselines looser than the tool's default) is read on the single read of a pending
approval by a reader who may approve it, and is no part of `arguments`. A proposed policy carries `mode` only: any other
`config` member (`approver_groups`, `expires_after`, `on_deny`, ...) or an `origin` is `shape`, with `member` naming it
(`action.arguments.policies[1].policy.config.approver_groups`), because the approver sees the arguments, but what the checks at open (loosening and tightening) and the preview
compare is the mode alone, so a change to the routing, the expiry or `on_deny` would get no check and no preview line.

**Approving.** All or nothing, in the order tools, binding, policies. A refusal at that moment resolves the approval
`rejected`, and its last `resolution_history` entry has `by` the administrator whose approval was refused and `reason`
`proposal_refused:<code>` (the codes above, or `policy_conflict`); the answer to the approve call is still 200. A
success is `approved` and at once `consumed`. Only an administrator approves, and the person who proposed approves
their own proposal only from the approver surface.

**The mock and the scenarios.** The mock implements all of it on the hosted deployment (it advertises
`deployment_applied`; an edge deployment applies nothing), against a snapshot of its state that it restores on any
failure, and sends the `policy.published` events only once everything is applied. `31-rev14-policy-set-proposal.yaml`
has nineteen scenarios. Those that apply a proposal need `--admin-token` (the approver) and `--creator-user-token` (the
person who opens it); the one about self-approval also needs `--approver-surface-token`, whose user must be an
administrator and the same user as the creator-user token. Each unbinds and retires what it created in `cleanup`;
a tool a proposal registers stays registered, under a reference of its own. A scenario gains the field
`arguments_bytes`, the most bytes of arguments it sends: it is skipped (a capability skip) where the deployment
advertises a smaller `approval_arguments_max_bytes`, and `proposal-arguments-bound` is the scenario that runs only
where one is advertised. `deployment_applied` joins the capability members a scenario may require with `advertises`. Rev 14 also corrects three rev 13 scenarios (at four steps) that
authored `tool_invocation` policies for the organisation subject without gating on it (they now use the role
`everyone` and gate on `serves_policy_subject_type`, `role` or `[role, agent]`), and that wrote one policy without
`targets`, which a deployment that advertises `targets_all: false` refuses (it now names its tool), and the generated `policy-forms-advertised-are-accepted` creates
a real agent for its agent-subject drafts where `agents` is served.

## Per-approval actions (rev 15)

Rev 15 adds one thing, optional on the wire, so a rev 14 server's responses still validate: **`Approval.available_actions`**,
the list of what the reader may do on this approval. Until now the only source was the deployment-wide
`Capabilities.resolutions`; an action is typed, carries the deployment's own wording and declares the inputs it takes.

**The members.** An `ApprovalAction` is `{ id, kind, label, resolution?, inputs }`. `kind` is an open enum whose
documented value is `resolve` (a client ignores a kind it does not know); `resolution` is a `ResolveResolution` and is
present exactly when `kind` is `resolve`; `inputs` is a list of `ApprovalActionInput`, `{ name, type, label, required,
max_length? }`. `type` is an open enum whose documented value is `text` (a client does not offer an action that has an
input of a type it does not know). The input named `reason` fills `ResolveRequest.reason`; any other name is a member of
`ResolveRequest.input`.

**Who sees it.** As `Approval.preview`: only on `GET /v1/approvals/{id}`, only while the approval is `pending`, and only
to a reader who may resolve it; absent on a list row, a stream event and for every other reader. Every `resolve` action's
`resolution` is one of `Capabilities.resolutions`. On a deployment that does not list `approvals.available_actions`,
absent means the deployment does not say, and a client derives approve and deny from `Capabilities.resolutions` as
before. On a deployment that lists it, absent means no action for this reader, and a client derives none. Being listed is
not authorisation: resolving still decides eligibility when it is called.

**The feature.** A deployment that sets the member lists `approvals.available_actions` in `Capabilities.features`;
a scenario that needs it says `features: [approvals.available_actions]`.

**The mock and the scenarios.** The mock advertises the feature wherever it serves approvals, on either deployment, and
lists one `resolve` action for each of `approved` and `rejected` that it serves ("Approve", "Deny"), each with the one
optional input `reason`; a mock that serves neither omits the member rather than sending it empty. It lists them to an
eligible user whose token carries `Capabilities.user_resolve_scope`, as resolving asks, and only while the approval is
pending. Four breaks drop those gates: `available_actions_shown_to_all` (eligibility and scope),
`available_actions_shown_when_resolved` (pending), `available_actions_shown_without_resolve_scope` (scope) and
`available_actions_shown_to_members` (eligibility, for a member).
`32-rev15-available-actions.yaml` has three scenarios: `available-actions-for-approvers`, and the negatives
`available-actions-hidden-from-others` (the person who opened it, a member who is not eligible, and the approver once it
is resolved; the first, second and fourth breaks fail it) and `available-actions-hidden-without-resolve-scope` (the approver's token
without the scope, on a deployment that advertises `user_resolve_scope`; the third break fails it).

## Fact-conditioned policies and approval requirements (rev 16)

Rev 16 lets a `tool_invocation` policy decide a call by what the call carries, and say who may answer the approval it
raises. Every addition is optional on the wire, so a rev 15 server's responses still validate, and a deployment that
does not list a rev 16 feature refuses its members with 422 `unsupported_policy_form` and behaves as rev 15.

**Facts on a tool (`tools.facts`).** `Tool.facts` (and `ToolWrite.facts`; `ToolPatch.facts` replaces the whole map, and
`null` clears it) maps a fact name (`FactName`, `^[a-z][a-z0-9_]{0,62}$`, at most 32 per tool) to a `FactBinding`
`{ path, type, description? }`. `path` is one or more `.key` / `[N]` segments read from the root of the call's arguments;
a wildcard (`[*]`) or a recursive descent (`..key`) selects a set and is refused with 400 `invalid_request` naming the
binding in `member` (`facts.<name>.path`). `type` is `number`, `string`, `boolean` or `count` (an array, whose length is
the value). Nothing is coerced: a path that selects nothing, or a value of another type, leaves the fact with no value.
The deployment reads facts from `action.arguments` of the call it decides; a call that sends only `arg_digest` has none.

**Rules (`policies.rules`).** `ToolInvocationConfig.rules` is a list of up to 32 `PolicyRule`s, `{ when, then,
approvers? }`: `when` is 1 to 8 `PolicyCondition`s, all of which must hold; `then` is `always_allow`, `ask` or `deny`.
A condition is `{ fact, op, value? }`: `eq`/`ne` take a scalar, `in`/`not_in` a list of 1 to 100 scalars, `gt`, `gte`,
`lt`, `lte` a number (and need a `number` or `count` fact), `exists` no value. One policy is evaluated by walking its
rules in order: a rule with a false condition is skipped whatever its other conditions; otherwise a rule with an
unevaluable condition (the fact has no value) stops the walk and the policy asks; otherwise the rule matches and its
`then` is the result. No rule matches: `mode`. `exists` is never unevaluable. The policies that match a call still
compose tightest-wins. A condition that names a fact one of the targeted tools does not declare, or compares a fact
that is neither a `number` nor a `count`, is 400 `invalid_request` naming the condition's `fact` in `member` when every
target is a registered tool. In what a simulation considered, an entry gains `rule` (`{ index, then }`, the rule that
gave its result) and `missing_facts` (the facts the rule that stopped the walk needed), and a `step_up` that such a walk
contributed to names them in `Decision.missing_facts` (as does a simulation's result).

**Approvers and requirements (`approvals.requirements`).** `ToolInvocationConfig.approvers` lists who may satisfy the
requirement the policy contributes when it asks: `PolicyApprover` is `{ role }` or `{ user }`, each with an optional
`when`, and an `ask` rule may carry its own `approvers`, which then replace the policy's. A walk a missing fact stopped
never uses the policy's `approvers`: the stopping rule's when it is an `ask` rule that has them, else the
organisation's administrators. `exclude: [requester]` keeps
the person who opened the approval out of the requirement, from every surface. `approver_groups` is unchanged.
`Approval.requirements` lists one `ApprovalRequirement` per policy that asked: `{ id, policies, approvers, exclude,
needed, met, approvals }`, with `approvers` the entries in force when it opened (`ApproverRef`; empty means the
organisation's administrators) and `needed` always 1. Two policies whose entries in force and `exclude` are the same
contribute one requirement listing both. An approve satisfies every unmet requirement the approver is eligible for;
while one stays unmet the answer is 200 with the approval still `pending`, and the change is an `approval.updated`.
Anyone eligible for an unmet requirement may reject the approval. `waiting_on` counts those eligible for an unmet
requirement, never the creator.

**The organisation's setting.** A policy of the new kind `approval_routing` (organisation subject, every tool; the most
recently published one is in force) carries `ApprovalRoutingConfig`, `{ org_admin_break_glass }`. On (the default when
none is published), an administrator of the organisation may meet every requirement in one approve (`basis:
break_glass`), except one that excludes them. `Capabilities.policy_forms` lists it as `approval_routing`, and
`tool_invocation.config_members` gains `rules`, `approvers` and `exclude`.

**The mock and the scenarios.** The mock advertises `tools.facts` on either deployment, `policies.rules` where it
authors policies (hosted), and `approvals.requirements` where it also serves approvals. Its decision is still a fixture
lookup, except for a call that a published policy carrying `rules`, `approvers` or `exclude` matches: then it composes
every policy that matches the call, and an approval it opens carries requirements. `POST /v1/approvals` sets the same
requirements as a decision of the call, and a call that matches an open approval lacking some of its requirements adds
them while it is pending, and joins an approved one as it is, with the requirements it was approved under. Roles are read from the `role:<key>`
scopes of the approver's token. Five breaks drop one rule each: `rules_ignored`, `missing_fact_falls_to_mode`,
`partial_approve_resolves`, `exclude_requester_ignored` and `break_glass_ignores_setting`.
`33-rev16-facts-rules-requirements.yaml` has four scenarios: `rev16-rules-decide-by-the-facts-of-the-call` (deny,
allow and ask by the facts, a digest-only call that asks and names the missing fact, and a simulation's `rule` and `missing_facts`; the first two
breaks fail it), `rev16-requirements-met-one-by-one` (two requirements met by two approvers, and an approval opened through `POST /v1/approvals` that carries the same two and that a decision of the same call joins; the third break fails it),
and the negatives `rev16-exclude-requester-refuses-the-requester` (the fourth) and
`rev16-break-glass-follows-the-organisation-setting` (the fifth).

## The `claude_agent_sdk` continuation kind (rev 17)

Rev 17 adds one value to the closed enum `Continuation.kind`: `claude_agent_sdk`, for the Claude Agent SDK connector, which
opens its approvals with `delivery: pull`. Its `correlation` is `{ session_id, tool_use_id, agent_id?, mode }`, `mode` being
`defer` or `retry`, and a missing `agent_id` means the main agent. The server reads none of it: the correlation stays opaque,
at most 8 KiB, and is echoed as sent. The enum is otherwise unchanged, so a kind outside it is still 400 `invalid_request`.
The schema ties the new kind to `pull`: `claude_agent_sdk` with `push` or `held` is 400 `invalid_request`, and the seven earlier
kinds keep every delivery. The tie is not a narrowing: the kind did not exist before rev 17, so it refuses no request a client could already send. Rev 17 advertises its addition through a `Capabilities` member, the way rev 6 did for deliveries: `continuation_kinds` lists the kinds the deployment accepts, so a client or an adapter reads `capabilities()` instead of finding out from a 400 on its first decision. Unlike `continuation_deliveries`, where absent means all three, an absent `continuation_kinds` means the seven kinds of rev 16, because a deployment that predates rev 17 cannot advertise the member. Its items are open-ended strings whose known values are the eight kinds, not an enum, so a rev 17 client or kit still reads the capabilities of a later deployment that lists a newer kind, and treats that kind as one it does not send. The member changes conformance (skip rather than fail) and discoverability, nothing else on the wire: a deployment that does not accept the kind answers 400 `invalid_request` to it, not
`invalid_continuation`, which is for a continuation that does not match its delivery or a delivery not served.

**The mock and the scenarios.** The mock validates a request against the document's schemas, so it accepts and echoes the new
kind and refuses an unknown one. The mock advertises `continuation_kinds` on either deployment wherever it serves approvals, as the `Continuation.kind` enum of the document it implements. `34-rev17-claude-agent-sdk.yaml` has three scenarios:
`rev17-claude-agent-sdk-continuation-lifecycle` (step_up with the continuation, approve, the Resumption echoing the correlation,
consume) and the negatives `rev17-unknown-continuation-kind-is-refused` (the kind `foo` on a decision and on
`POST /v1/approvals`, and nothing else, so it passes on any deployment that keeps the enum closed, whether its kinds are rev 16's or rev 17's) and `rev17-claude-agent-sdk-is-pull-only` (`claude_agent_sdk` with `held` on both routes; `push` is covered by the document and mock tests only, because a scenario declares one delivery). The existing `skip_request_validation` break fails both negatives. Each scenario declares `serves_delivery` for the one delivery it sends (`pull`, `pull`, `held`), so a deployment that does not serve that delivery skips it. The lifecycle also declares `serves_kind: claude_agent_sdk`, so a deployment that has not adopted the kind skips it rather than failing at step 2 (`POST /v1/decisions`, 400 `invalid_request`). The two negatives are not gated on the kind and run on any deployment that serves their delivery: an unknown kind, and `claude_agent_sdk` with `held`, are refused whether or not the kind is adopted. The lifecycle's correlation uses `mode: retry`, the mode the Claude Agent SDK adapter's v1 sends; the server does not read it, and the spec tests validate `defer` too.

## Role rows, proposals without an agent and tool grants (rev 18)

Rev 18 widens `PolicySetProposal` three ways so that a set of starter policies is proposed through the same reference as an
agent's. A **`role` row** (a new value of `PolicySetEntry.role`) is a `tool_invocation` policy for one role of the
organisation, `{ type: role, id: <key> }`, with a bare role key that is never `everyone` (a policy of `everyone` is a
`baseline`), one tool and `mode` only. No check compares it with the baseline; instead `Approval.preview.ineffective` lists a
role row whose mode is looser than a policy of `everyone` gives the same tool (published, or a baseline of the same set),
because tightest-wins makes it change nothing while that policy stands, and `Approval.preview.loosening` gains an entry with
`subject` for a role row that loosens what its role gets (where no published policy the role holds governs the tool, against
the default), so an empty `loosening` still says that approving loosens nothing. A role row needs the entitlement
`policies.role_subjects`: without it the proposal is refused `proposal_refused` with the new code `not_entitled` (naming the
first role row), at open and again at approval (`proposal_refused:not_entitled`). The entitlement keys are now documented as
known values of `Capabilities.entitlements`. **`agent` is optional**: a proposal without it carries `baseline` and `role` rows
(and `tools`) only, and its preview simulates as `{ type: role, id: everyone }`; a tightening or `tool_grants` without an agent is
`shape`. **`tool_grants`** lists tools the organisation already holds, granted on approval to the service principal in
`agent.principal_id` (required for them) in the same all-or-nothing step, after the binding and before the policies; a reference
that is no tool of the organisation, or a withdrawn one, is `target_unknown`, and one of the proposal's own `tools` or in the
`tool:noblecloak:` namespace is `shape`. `Approval.preview.grants` lists them. A grant is a deployment-applied instruction: the
visibility rule of `GET /v1/tools` is unchanged, and what a grant does beyond it is the deployment's.

A deployment says what it accepts in `Capabilities.proposals` (`row_kinds`, `members`); absent means `baseline` and
`tightening` and no member, and a row kind or member it does not list is `shape`.

**The mock and the scenarios.** The mock implements all of it on the hosted deployment and advertises every row kind and
`tool_grants` (`MockOptions.proposals` starts it with less). The mock keeps no entitlements per organisation: it reads the
opener's token (the `entitled` token holds `policies.role_subjects`, `creator_user` does not) and records that set on the
approval; at approval an approving token that carries an `entitlements` claim stands for the organisation's current set, and
one without the claim leaves the recorded set in force. That token model is the mock's stand-in for the organisation's
entitlement, which is what the contract speaks of. It records grants in its state and changes no tool's visibility.
`35-rev18-proposal-role-rows-and-grants.yaml` has eight scenarios (the entitled set applied without an agent, its refusal for
`creator_user`, the agentless refusals, the two tool-grant refusals, a grant previewed and applied, a shadowed role row in the
preview, and a role row that loosens in the preview). Six new breaks fail them, as do the existing
`proposal_refusal_code_missing` (every refusal), `proposal_not_consumed` (the two that apply) and `preview_loosening_missing`
(the loosening role row).

## Versioning

This version implements **contract revision 18**, released as `contract-v1-rev18`; the CHANGELOG head names it. Rev 18 adds a
value to the closed `PolicySetEntry.role` enum (`role`), the optional members `PolicySetProposal.tool_grants`,
`ApprovalPreview.grants`, `ApprovalPreview.ineffective`, `ApprovalPreview.loosening[].subject` and `Capabilities.proposals`, the `proposal_refused` code
`not_entitled`, and known values on `Capabilities.entitlements`, and it makes `PolicySetProposal.agent` optional. That last one
widens what a request may send: a reader of a proposal's `arguments` may now find no `agent`, and such an approval names no
agent. Rev 17 adds one value to the closed `Continuation.kind` enum (`claude_agent_sdk`) and one optional member, `Capabilities.continuation_kinds`. The widening keeps a rev 16 server's responses valid: the full `continuation` is read only by the creating principal, and every other reader sees `continuation_kind`, a free string. Rev 16 added optional members only (tool facts, policy rules, approvers and `exclude`, the `approval_routing` kind, `Approval.requirements`, and the features `tools.facts`, `policies.rules` and `approvals.requirements`), as rev 15 did (`Approval.available_actions` and the feature `approvals.available_actions`). Rev 14 made a narrowing, which still holds, and added optional members; its CHANGELOG entry names both. The narrowing: a tool registration or a policy target in the namespace `tool:noblecloak:` is refused (422 `reserved_tool_ref`, 422 `policy_immutable`). The behaviour rev 13 changed still holds: `actor.agent_id` does not select an agent's policies (the binding does), and so do the narrowings rev 12 made: `Webhook.secret` is removed, a registered origin must be exact, and origin writes and the webhook routes are administrator-only. The
revision is the contract's. `info.version` in the document (1.0.0) is **not** the revision. A revision only adds optional members, or values to a closed enum, unless its CHANGELOG entry names a narrowing, as rev 6 does
for the listing of a tool owned by a principal.

## License

Apache-2.0; see the repository `LICENSE` and `NOTICE`.
