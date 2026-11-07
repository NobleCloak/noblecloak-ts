/**
 * Generated from the NobleCloak module API document (`@noblecloak/spec`'s `openapi.public.yaml`) by
 * `bun tools/generate-schema.ts`. Do not edit.
 */
export interface paths {
    "/v1/decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ask for a decision on an action.
         * @description The platform's decide, as the module API serves it. The principal is the token's and is never read from the
         *     body. `actor.run_id` names an `external` run the caller owns and selects its scope; without it the
         *     principal scope applies. `continuation` is stored if and only if the decision is `step_up`; one
         *     continuation per obligation, so a different one for the same open identity is 409
         *     `continuation_conflict` and an identical one (the same JSON value; member order does not matter) is the idempotent retry. `expect_approval_id` is a
         *     hint only: this route never consumes.
         *
         *     A deployment that does not advertise `approvals` (see `GET /v1/capabilities`) has nowhere to keep a
         *     continuation and opens no obligation. It answers 422 `continuation_unsupported` if, and only if,
         *     the request carries a `continuation` and the decision is `step_up`; on `allow` and `deny` it accepts
         *     the request and ignores the continuation. A deployment that advertises `approvals` stores it as
         *     described above.
         *
         *     For an identity whose obligation is approved and not yet consumed, the answer is `allow` when the
         *     gateway will admit the call, and `step_up` with `approval.state: approved` when the caller must
         *     consume it through `/consume`. Tell which applies from `approval.resume_token_will_issue`; when it
         *     is `false` the caller has nothing to consume and must not execute the action itself.
         *
         *     A policy `ask` is `step_up` on every invocation channel when approvals are served. When the
         *     deployment cannot open or route the approval it answers `deny` with reason `approval_unroutable`,
         *     never a silent `allow` and never a `step_up` with nothing behind it; a tool with no catalog row,
         *     or one that is `withdrawn` (rev 11; see `Tool.status`), stays `deny` with reason `unknown_tool`. On a
         *     deployment that advertises
         *     `approvals.rejected_duplicate`, a step-up for an identity a resolver rejected within the window of
         *     the duplicate-requests policy is answered `deny` with reason `rejected_duplicate` and
         *     `rejected_approval_id`, and opens nothing (see Terminal states free the identity). On a deployment that
         *     advertises `connections.user_links` (rev 11), a call to a tool of a `per_user` registration by a
         *     caller with no usable link to it (none, consent not `given`, or `degraded`) that opens no approval
         *     is `deny` with reason `credential_link_required`; a step-up opens the approval, which carries
         *     `blocked_on` for the principal the call runs as (the run's owner; on a direct call, the creator). The
         *     answer carries no `arguments`: the arguments of an
         *     approval are read from `GET /v1/approvals/{id}` only (see Who sees the arguments of an approval).
         *     A deployment may refuse a `continuation` whose delivery it does not serve with 400
         *     `invalid_continuation`, after the `callback_url` check for a push; `continuation_deliveries` on
         *     `GET /v1/capabilities` lists the deliveries it serves.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["decide"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/decisions/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ask for decisions on a list of actions.
         * @description Array in, array out, in the same order. For gateways evaluating a tool list. The elements are
         *     decided in order under the token's principal, each as `/v1/decisions` would decide it. Identical
         *     elements (the same tool and arguments, in the same scope) are one obligation: the first of them
         *     opens it or joins the open one, and the rest join it, or are denied with it under the
         *     rejected-duplicate rule (see Terminal states free the identity). The `continuation` rule of `/v1/decisions`
         *     applies to each element: on a deployment that does not advertise `approvals`, one element that is
         *     `step_up` and carries a `continuation` refuses the whole batch with 422 `continuation_unsupported`.
         *
         *     At most 100 requests: a body above that is a schema violation (400 `invalid_request`). A deployment
         *     may accept fewer and says so in `limits.decisions_batch_max_items` on `GET /v1/capabilities`; a
         *     batch above that limit and no larger than 100 is 400 `batch_too_large`, whose problem body carries
         *     `max_items`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["decideBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/access/v1/evaluation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * AuthZEN access evaluation over the same decision schema.
         * @description The root-mounted AuthZEN Authorization API 1.0 evaluation endpoint. 1.0 is the OpenID Foundation's
         *     Final Specification (approved 2026-01-12), not a draft; the version this operation implements is
         *     pinned by its version extension. `resource.type` is `tool`,
         *     `resource.id` is the `tool_ref`, `action.name` is the tool method (or `invoke`), and
         *     `context.arguments` or `context.arg_digest` carries the action. `subject` is informational: the
         *     principal is the token's. The response is AuthZEN's `decision: true | false`; `context.noblecloak`
         *     carries the full decision object. A `step_up` decision answers `decision: false`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["authzenEvaluate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/.well-known/authzen-configuration": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * AuthZEN discovery.
         * @description Policy decision point metadata for AuthZEN clients. Unauthenticated and not wrapped in the envelope.
         */
        get: operations["authzenConfiguration"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The approval queue.
         * @description Approvals visible to the caller, newest first (by creation; `order=resolved_at` orders by
         *     resolution time and returns only the approvals that have been resolved). `state` takes one state
         *     or a comma-separated set. `approver=me` filters to those the caller may resolve, and
         *     `created_by=me` to those the caller created. Each row carries `arguments_state`, with the values
         *     and the reader-dependent rule it has on the single read (see Who sees the arguments of an
         *     approval), so a queue can tell why a row shows no arguments; a row never carries `arguments`
         *     themselves. A deployment that cannot determine which approvals
         *     the caller may resolve answers 503 `service_unavailable` with `reason` `eligibility_lookup`. A user principal sees every approval of
         *     its organisation; a service principal sees only the approvals it created, with or without
         *     `created_by=me` (see Who sees an approval). Each row carries `continuation` only when the caller
         *     created it.
         */
        get: operations["listApprovals"];
        put?: never;
        /**
         * Open an approval for an action the caller's own engine decided on.
         * @description The door for callers whose own engine decided: a governance toolkit's escalation backend or a
         *     hand-rolled check. Creates an obligation from `action` and `continuation`. The server computes the
         *     identity and dedupes on the open obligation shared with `/decisions`: a match returns 200 with
         *     `created: false` and the same id. Rev 16: on a deployment that lists `approvals.requirements`, the
         *     approval carries the requirements a decision of the same call would set, and a match is joined only as
         *     `Approval.requirements` states (an `approved` match is joined as it is, 200, whatever the call sets: it
         *     keeps the requirements it was approved under and no other approval opens). An approval id supplied in the body is an identity assertion and
         *     is refused with 400 `identity_not_accepted`. `run_id` is an `external` scope from `POST /v1/runs`;
         *     absent, the principal scope applies. The creating principal can never resolve what it created.
         *
         *     A tool with no catalog row, a `withdrawn` one (rev 11), or one whose approval the deployment cannot
         *     open or route, is 422 `approval_unroutable`, and `detail` names the reason. Rev 14: a
         *     `tool_ref` in the namespace `tool:noblecloak:` is a deployment-applied reference and is not a tool: a
         *     deployment that lists it in `Capabilities.deployment_applied` checks `action.arguments` against the
         *     schema named there and opens an approval whose approval applies a change (see Deployment-applied
         *     proposals); a refusal is 422 `proposal_refused` with `code`, and a deployment that does not list it
         *     answers 422 `approval_unroutable`. On a deployment that advertises
         *     `approvals.rejected_duplicate`, an identity a resolver rejected within the window of the
         *     duplicate-requests policy is 409 `rejected_duplicate`, carrying `rejected_approval_id`, and nothing
         *     is opened (see Terminal states free the identity). The handle carries no `arguments`: they are
         *     read from `GET /v1/approvals/{id}` only (see Who sees the arguments of an approval). A
         *     deployment may refuse a `continuation` whose delivery it does not serve with 400
         *     `invalid_continuation`, after the `callback_url` check for a push; `continuation_deliveries` on
         *     `GET /v1/capabilities` lists the deliveries it serves.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["createApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Approval detail.
         * @description Includes lineage (`agent.parent`, run kind), `policy` when an explicit policy matched,
         *     `continuation_kind`, `resolution_history`, and `arguments` on this operation only: when the tool
         *     has `show_arguments_to_approvers` on at the time of the read, the approval is not final, and the
         *     reader is the principal that created it or one eligible to approve it (see Who sees the
         *     arguments of an approval); otherwise only the digest. A deployment that cannot determine
         *     whether the reader is eligible answers 503 `service_unavailable` with `reason`
         *     `eligibility_lookup`, never the digest-only view. `arguments_state` says why the arguments are
         *     shown or not, `requester` names the principal that created the approval, and `waiting_on` is
         *     present for the creator of a pending approval, on this operation only and best-effort: when the
         *     deployment cannot determine who is eligible the read is still 200 and `waiting_on` is absent; the
         *     creator's read does not depend on that lookup. `on_deny` (rev 9) is the creator's alone and is
         *     present only when the matching policy stated it at creation. `blocked_on` (rev 11) is shown only to
         *     the principal the call runs as (the run's owner; on a direct call, the creator): present while the call
         *     waits on that principal's own credential link. The full `continuation` is
         *     included only when the caller is the principal that created the approval, in every state; for
         *     every other reader the member is absent. A service principal reading an approval it did not create
         *     gets 404 `not_found` (see Who sees an approval).
         */
        get: operations["getApproval"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resolve an approval.
         * @description The canonical resolve. 409 `approval_conflict` when `expected_action_digest` does not match the
         *     approval's action or another resolution won; 403 `not_eligible` when the caller may not resolve
         *     it, which includes the principal that created the obligation. A deployment may refuse a
         *     resolution it does not serve, `escalated` where it has no escalation, with 400 `invalid_request`
         *     (`Capabilities.resolutions` says which it can produce). A deployment that cannot determine whether
         *     the caller is eligible answers 503 `service_unavailable` with `reason` `eligibility_lookup`.
         *
         *     Rev 16: on an approval that carries `requirements`, `approved` satisfies every unmet requirement the caller is eligible for, and answers 200 with the approval still `pending` while any requirement is unmet (see `Approval.requirements`); `rejected` rejects the approval. A caller eligible for no unmet requirement is 403 `not_eligible` while the approval is `pending`.
         *
         *     Where the deployment advertises `Capabilities.user_resolve_scope`, a user's token must carry that scope: without it the call is 403
         *     `insufficient_scope`, answered before the body is validated, before the approval is looked up and before eligibility is considered: an approval id that does not exist is still 403 `insufficient_scope`, and a missing scope is never reported as `not_found`, `invalid_request` or `not_eligible`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["resolveApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/resolve/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resolve a list of approvals.
         * @description Array in, array out, in the same order. Each element names one approval and resolves it as
         *     `POST /v1/approvals/{id}/resolve` does, under the token's principal, with the same rules per
         *     element: eligibility, the `expected_action_digest` the approver saw, the resolutions the
         *     deployment serves. An element is answered by the resulting `Approval`, or by a problem document
         *     (the same `type` and `status` the single route would answer), so one `approval_conflict` or
         *     `not_found` does not fail the rest; the elements are resolved one at a time and independently, in
         *     order. An approval named twice is resolved by its first element and the repeat answers the conflict
         *     the single route gives for an approval that is no longer pending (`already_resolved`). Rev 16: on an
         *     approval that carries `requirements`, each element is applied as `/resolve` applies it (see
         *     `Approval.requirements`), so a first element that leaves a requirement unmet leaves the approval
         *     `pending`, and a repeat by an approver eligible for no unmet requirement left answers 403
         *     `not_eligible`; once the approval is no longer pending, a repeat answers `already_resolved` as above. The body is
         *     validated whole before any element is applied: one malformed element, or an empty list, is 400
         *     `invalid_request` and nothing in the batch is resolved. A service principal never resolves: the call is 403 `not_eligible` as a whole. A
         *     deployment that cannot determine whether the caller is eligible answers 503 `service_unavailable`
         *     with `reason` `eligibility_lookup`. `Idempotency-Key` is not used, as for `/resolve`.
         *
         *     At most 100 elements: a body above that is a schema violation (400 `invalid_request`). A
         *     deployment may accept fewer and says so in `limits.resolutions_batch_max_items` on
         *     `GET /v1/capabilities`; a batch above that limit and no larger than 100 is 400
         *     `batch_too_large`, whose problem body carries `max_items`, and nothing in it is resolved.
         *
         *     Where the deployment advertises `Capabilities.user_resolve_scope`, a user's token must carry that scope: without it the call is 403
         *     `insufficient_scope`, answered before the body is validated, before the approval is looked up and before eligibility is considered: an approval id that does not exist is still 403 `insufficient_scope`, and a missing scope is never reported as `not_found`, `invalid_request` or `not_eligible`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["resolveApprovalsBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Alias for resolve with resolution approved.
         * @description The server rewrites this to `/resolve` with `resolution: approved`.
         *
         *     Rev 16: on an approval that carries `requirements`, an approve that leaves a requirement unmet answers 200 with the approval still `pending` (see `Approval.requirements`).
         *
         *     Where the deployment advertises `Capabilities.user_resolve_scope`, a user's token must carry that scope: without it the call is 403
         *     `insufficient_scope`, answered before the body is validated, before the approval is looked up and before eligibility is considered: an approval id that does not exist is still 403 `insufficient_scope`, and a missing scope is never reported as `not_found`, `invalid_request` or `not_eligible`.
         *
         *     Rev 14: approving a deployment-applied approval applies its change, all or nothing (see
         *     Deployment-applied proposals). When the deployment refuses to apply it, the answer is still 200, and the
         *     approval is `rejected` with the reason in the last entry of `resolution_history`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["approveApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/deny": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Alias for resolve with resolution rejected.
         * @description The server rewrites this to `/resolve` with `resolution: rejected`.
         *
         *     Rev 16: on an approval that carries `requirements`, a caller eligible for at least one unmet requirement rejects the approval (see `Approval.requirements`).
         *
         *     Where the deployment advertises `Capabilities.user_resolve_scope`, a user's token must carry that scope: without it the call is 403
         *     `insufficient_scope`, answered before the body is validated, before the approval is looked up and before eligibility is considered: an approval id that does not exist is still 403 `insufficient_scope`, and a missing scope is never reported as `not_found`, `invalid_request` or `not_eligible`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["denyApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/withdraw": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Withdraw an approval.
         * @description Requester-only. The state becomes `withdrawn`. Withdrawal is not a resolution. It frees the
         *     identity, so the next identical call opens a new obligation.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["withdrawApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/wait": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Long-poll an approval.
         * @description Returns when the state changes or `timeout` seconds pass (at most 55), with the current state either way. The rules of `GET /v1/approvals/{id}` apply (see Who sees an approval): a service principal waiting on an approval it did not create gets 404 `not_found`, and `continuation` is present for the creating principal only.
         */
        get: operations["waitApproval"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Server-sent events for approvals.
         * @description An SSE stream of `approval.updated` events whose data is an Approval, for approvals visible to the
         *     caller. With `created_by=me` only approvals the caller created are delivered. With `approver=me`
         *     only approvals the caller may resolve are delivered; eligibility does not depend on the state, so
         *     the event that resolves such an approval still arrives. `state` takes one state or a
         *     comma-separated set and delivers only events whose approval is in one of them. The parameters
         *     combine (every one must hold). A service principal is delivered only the approvals it created,
         *     with or without `created_by=me` (see Who sees an approval). An event carries `continuation` only
         *     when the caller created the approval. A deployment that cannot determine eligibility when the
         *     stream opens with `approver=me` answers 503 `service_unavailable` with `reason`
         *     `eligibility_lookup` and opens no stream.
         */
        get: operations["streamApprovals"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/resumption": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The signed Resumption.
         * @description Minted server-side at resolution and readable by the creating principal only, until consumed,
         *     expired or withdrawn (409 `obligation_withdrawn`: a withdrawn approval is not released). A service
         *     principal that did not create the approval gets 404 `not_found`, not 403 (see Who sees an
         *     approval). The `signature` is a JWS compact serialization (alg ES256, `kid` in the header) whose
         *     payload is the JCS form of this object without `signature`; verify it against
         *     `/.well-known/jwks.json`. A caller does not mint a Resumption: consumption is `/consume`.
         *
         *     An adapter learns what to do from structure. An `approved` Resumption that carries a `resume_token`
         *     means the runtime consumes and reports; one that does not means the gateway handles admission.
         *     While the approval carries `blocked_on` (rev 11) there is no Resumption: this read is 404
         *     `not_found`, as before resolution, until the link of the principal the call runs as is usable.
         *     A rejected approval has a Resumption too: it carries `resolution: rejected` and no
         *     `resume_token`, and the caller does not run the action. A Resumption carries no `arguments`.
         */
        get: operations["getResumption"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/consume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Consume an approved obligation.
         * @description The only route that consumes. The server recomputes the identity from the action as the runtime is
         *     about to run it, answers 409 `approval_conflict` on mismatch, verifies that `resume_token` binds
         *     this obligation, and consumes it atomically and once; the state becomes `consumed`. A replay is
         *     409 `obligation_consumed`. On an edge deployment this route and `/resumption` proxy to hosted:
         *     obligations call home and there is no local release.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["consumeApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/continuations/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Validate a continuation.
         * @description Validates a continuation shape. For `push` it performs a signed challenge to `callback_url` and
         *     reports reachability. The same callback guard applies as on `POST /v1/approvals`: a `callback_url`
         *     that is not public-routable is 400 `callback_unroutable`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["testContinuation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/records": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Query records.
         * @description Records visible to the caller, newest first. `degraded=true` returns only the records that carry the `degraded` member, `degraded=false` only the records that do not, and without the parameter both are returned. Any other value is 400 `invalid_request`.
         */
        get: operations["listRecords"];
        put?: never;
        /**
         * Append a record.
         * @description Appends one record. `attestation` is derived by the server and is refused with 400
         *     `attestation_not_accepted` if supplied: every record appended through `/v1` is stamped `asserted`,
         *     whoever the caller is. An optional `approval_id` links the outcome to the approval it followed. A body with
         *     content type `application/vnd.microsoft.agt.event+json` is accepted as an AGT event and mapped,
         *     by every deployment, since records are in the floor; an event the deployment cannot map is 400
         *     `invalid_request`.
         *
         *     A caller that could not obtain a decision (the deployment did not answer in time, or answered with
         *     an error) appends the call it went on to make with `degraded`: see the `Degraded` schema. The
         *     record's `decision` is then the fallback the caller applied, and it carries no `policy`. A body
         *     that carries `degraded` together with `policy`, a `reason` that is not a code, or a member the
         *     schema does not define is 400 `invalid_request`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["appendRecord"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/records/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Append records in a batch.
         * @description Appends up to 100 records atomically, in order. The same rules as `POST /v1/records` apply to
         *     each element. A body above 100 is a schema violation (400 `invalid_request`). A deployment may
         *     accept fewer and says so in `limits.records_batch_max_items` on `GET /v1/capabilities`; a batch
         *     above that limit and no larger than 100 is 400 `batch_too_large`, whose problem body carries
         *     `max_items`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["appendRecords"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/records/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Record detail.
         * @description One record.
         */
        get: operations["getRecord"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/records/{id}/chain": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The chain around a record.
         * @description prompt (optional), action, decision, approval, outcome. Each link is nullable and carries a reason when it is null. The chain is linkage by reference, not a hash chain.
         */
        get: operations["getRecordChain"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/records/checkpoints": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a records checkpoint.
         * @description Paid. Hosted only.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["createCheckpoint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/records/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Verify records against checkpoints.
         * @description Paid. Hosted only.
         */
        get: operations["verifyRecords"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/evidence/exports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Export evidence.
         * @description Paid. Hosted only.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["createEvidenceExport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List policies.
         * @description Read from the signed bundle on an edge deployment. The route itself is free and served on both deployments; only `source=suggested` is paid content: it is hosted only (on an edge deployment it is 404 `not_available_on_deployment`) and the organisation must hold the `policies.suggested` entitlement (otherwise 403 `entitlement_required`). Without `source`, or with any other value, the route needs no entitlement. Each row is the policy as `GET /v1/policies/{id}` returns it (its published version, or its draft when it was never published). `kind`, `tool`, `subject_type` and `state` filter the rows; the page is cut by `cursor` and `limit`, and `meta.next` is the cursor of the next page. A policy whose targets name a tool the caller cannot see (a tool another principal owns; see `POST /v1/tools`) is left out of the list, as it is 404 on a read, and so is a retired policy (rev 11). A row of a published policy that has a pending draft carries `draft_version`.
         */
        get: operations["listPolicies"];
        put?: never;
        /**
         * Author a policy.
         * @description Hosted only. Creates a draft (`state: draft`, `published_at: null`); nothing is enforced until it
         *     is published. Authoring requires an administrator of the organisation (a user the deployment
         *     recognises as one; a service principal never is): any other caller is 403 `forbidden`.
         *
         *     `config` is the configuration of the policy's `kind` (`PolicyConfig`): `ToolInvocationConfig` for
         *     `tool_invocation`, `SpendingConfig` for `spending`, `DuplicateRequestsConfig` for
         *     `duplicate_requests`, each with its own legality matrix (`on_deny`, `expires_after` and
         *     `approver_groups` only with `ask` and `escalate`; `max_reasks` only with `ask_again`). A `config`
         *     that does not fit its `kind` is 400 `invalid_request`. `targets` absent means every tool; `name`
         *     absent means the deployment derives one. A deployment may refuse a form it cannot enforce (a kind,
         *     a subject type, a target form, a mode or a config member, such as `expires_after` or
         *     `approver_groups`, it does not implement for the kind) with 422 `unsupported_policy_form`, whose
         *     `member` names it (rev 13; see `Problem.member`). A `duplicate_requests` policy takes the organisation subject only, and
         *     targets every tool (`targets` absent or `{ tools: all }`); any other subject or target form is 422
         *     `unsupported_policy_form`. Rev 14: a policy whose `targets.tools` names a reference in the namespace
         *     `tool:noblecloak:` is 422 `policy_immutable`: a deployment-applied reference has a fixed policy that no
         *     policy can change (see Deployment-applied proposals). `PUT /v1/policies/{id}` and the proposed bodies of
         *     `POST /v1/policies/simulate` are checked the same way.
         *
         *     A create that carries `origin` (rev 11: the format and digest of the file the policy was imported
         *     from) makes a policy whose `source: imported`; a create without it is `source: authored`. `source`
         *     is fixed at create.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["createPolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Policy detail.
         * @description One policy at its current published version (`state: published`), or its draft (`state: draft`, `published_at: null`) when it was never published. A draft written after a publish is read from `GET /v1/policies/{id}/versions` until it is published; the read names its version in `draft_version` (rev 11). A policy whose targets name a tool the caller cannot see (a tool another principal owns) is 404 `not_found`, as is a policy of another organisation and a retired policy (rev 11).
         */
        get: operations["getPolicy"];
        /**
         * Replace a draft policy.
         * @description Hosted only. Writes the policy's draft. On a policy that was never published it replaces the
         *     draft. On a published policy it writes a draft as the next version: `GET /v1/policies/{id}` keeps
         *     returning the published version until the draft is published, and `GET
         *     /v1/policies/{id}/versions` lists the draft (`published_at: null`). The body follows the rules of
         *     `POST /v1/policies` (400 for a `config` that does not fit its `kind`, 422
         *     `unsupported_policy_form` for a form the deployment cannot enforce: a kind, a subject type, a
         *     target form, a mode or a config member it does not implement for the kind). A replace never changes
         *     `source` (rev 11): `origin` describes the version it writes, and is absent from a version written
         *     without it.
         *
         *     Authoring requires an administrator of the organisation; a service principal never is. A policy
         *     the caller cannot see (another organisation's, or one whose targets name a tool the caller cannot
         *     see) is 404 `not_found`, and that is answered before the administrator check; a caller who sees the
         *     policy and is not an administrator is 403 `forbidden`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        put: operations["updatePolicy"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Policy versions.
         * @description Every version of a policy, newest first, the pending draft included (`published_at: null`). The visibility rule of `GET /v1/policies/{id}` applies, except that a retired policy's versions stay listed here (rev 11), each carrying `retired_at`.
         */
        get: operations["listPolicyVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies/{id}/simulate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Decide in dry-run against a draft version.
         * @description Runs the decision against a version of the policy without opening an obligation or writing a
         *     record: the draft, or the version `draft_version` names, stands in for the stored policy, and the
         *     decision is scoped as `POST /v1/decisions` would scope it. Simulation writes nothing, so it needs
         *     no administrator, except to simulate as a subject (below). The answer is the decision
         *     (`SimulateResult`) and, from a deployment that implements rev 10, `considered`: the policies that
         *     matched the call and what each gave, and the decision they composed to (see `ConsideredPolicies`;
         *     rev 11 marks the entries that `contributed`). The organisation's duplicate-requests policy
         *     is listed when the simulated decision is a step-up or the simulated policy is itself a
         *     `duplicate_requests` policy, and a simulated step-up for an identity a resolver rejected within
         *     its window is answered `deny` with reason `rejected_duplicate`, as a decision would be: unless an
         *     identical approval is open, which the decision would join. The visibility rule of `GET
         *     /v1/policies/{id}` applies.
         *
         *     **Without a subject** (rev 13) the caller holds what a decision would give it: its user and roles, the
         *     `everyone` role, the organisation, and, when the caller is a service principal bound to an agent, that
         *     agent's policies. `actor.agent_id` never selects an agent's policies.
         *
         *     **As a subject** (rev 11). With `subject`, the result is for a hypothetical holder of exactly this
         *     subject (a role: that role plus the organisation; a user: the deployment's view of that user, roles
         *     included; an agent: the policies whose subjects name that agent, plus the `everyone` role (rev 13)
         *     and the organisation, and no user's or other role's; the organisation: the organisation subject
         *     alone). Every holder of a subject other than the organisation also holds `everyone` (rev 13), so
         *     a role simulation of `everyone` gives the baseline of the organisation. The caller remains the token's
         *     principal, nothing identifying the caller is read from `subject`, and nothing is recorded. Only an
         *     administrator of the organisation simulates as a subject: any other caller is 403 `forbidden`,
         *     answered after the visibility rule. The subject types are `role`, `user`, `agent` or
         *     `organization`; any other type, or one the deployment cannot simulate, is 422
         *     `unsupported_policy_form`, whose `member` names `subject` (rev 13; a rev 12 deployment names it in
         *     `detail`). A simulation as a subject reads the tools as the caller sees them, so a tool the subject
         *     could not see is still simulated. It applies no rejected-duplicate rule: a hypothetical holder
         *     has no rejections, so the duplicate-requests policy is listed with the result `none`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["simulatePolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies/simulate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Decide in dry-run against proposed policy bodies.
         * @description Rev 13. Runs the decision as `POST /v1/policies/{id}/simulate` does, but against policy bodies
         *     carried in the request instead of a stored policy. Use it when nothing is published yet: a builder
         *     can see what a set of policies would do before creating any of them. Each body in `policies` is a
         *     `PolicyWrite`, validated exactly as `POST /v1/policies` validates it (400 `invalid_request`, or 422
         *     `unsupported_policy_form` whose `member` is a path into the request body, for example
         *     `policies[0].subjects[0].type`).
         *
         *     The proposed bodies stand **beside** what is in force: they are added to the stored policies that
         *     match the call, and a proposed body never replaces a stored policy (it has no id to replace). The
         *     answer is a `SimulateEnvelope`. Each `considered` entry that comes from a proposed body has `id` and
         *     `version` null and carries `proposed_index`, the index of the body in the request. A deployment's
         *     default also has a null `id` and `version`, and is told apart by `source`: a default carries `source`
         *     and never `proposed_index`. The decision is scoped as `POST /v1/decisions` would scope it, and
         *     `subject`, when present, simulates a hypothetical holder as in `POST /v1/policies/{id}/simulate` (and
         *     needs an administrator of the organisation, as there). Without `subject` no administrator is
         *     needed. When `subject` is present the administrator check runs before the body is validated: a caller
         *     who is not an administrator is 403 `forbidden` whatever else is wrong with the body. The route writes
         *     nothing: it creates no policy, opens no obligation and appends no record.
         *
         *     A proposed `duplicate_requests` body stands beside the duplicate-requests setting in force (the
         *     published policy, else the default), which is listed as well, and the tightest of them applies. At
         *     most one body may be `duplicate_requests`: a second is 422 `unsupported_policy_form` whose `member` is
         *     `policies[<its index>].kind`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["simulatePolicySet"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies/{id}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Publish a draft policy.
         * @description Hosted only. Records the publish durably: the pending draft becomes the published version, keeping
         *     its `version` (`published_at`, `state: published`), so each publish adds one published version to
         *     `GET /v1/policies/{id}/versions`; a publish with no pending draft records nothing new and answers the
         *     published version. A deployment that serves webhooks delivers `policy.published`. A `tool_invocation`
         *     policy's enforcement follows within the deployment's policy-cache interval (hosted: up to 60
         *     seconds), not at the instant of the answer. A `duplicate_requests` policy is the organisation's
         *     setting from the answer of its publish on: the next decision that meets a rejection applies it. A `tool_invocation` policy that would govern a (tool, subject) pair another published
         *     policy already governs is 409 `policy_conflict`, whose `policy_id` names that policy; a
         *     `duplicate_requests` policy never conflicts: the organisation's duplicate-requests policy is the
         *     one it published most recently, so publishing another supersedes it. A form the deployment cannot
         *     enforce (a kind, a subject type, a target form, a mode or a config member it does not implement
         *     for the kind) is 422 `unsupported_policy_form`.
         *
         *     Authoring requires an administrator of the organisation; a service principal never is. A policy
         *     the caller cannot see is 404 `not_found`, answered before the administrator check; a caller who
         *     sees the policy and is not an administrator is 403 `forbidden`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["publishPolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies/{id}/retire": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Retire a published policy.
         * @description Hosted only, and only where the deployment advertises the feature `policies.retire` (rev 11: a
         *     hosted deployment that does not advertise it answers 404 `not_available_on_deployment`). Retires a
         *     published policy: from the answer on it is left out of `GET /v1/policies`, and a read of it is 404
         *     `not_found`, while `GET /v1/policies/{id}/versions` keeps its history, each version carrying
         *     `retired_at`. A pending draft is discarded with it. A `tool_invocation` policy stops being enforced
         *     within the deployment's policy-cache interval (hosted: up to 60 seconds), not at the instant of the
         *     answer; a retired `duplicate_requests` policy stops being the organisation's setting from the
         *     answer on. Once the deployment's policy-cache interval has passed, no new decision or approval names
         *     the retired policy (one window with its enforcement: a deployment that caches per instance may name it
         *     until then). The answer is
         *     the policy at its last published version, with `retired_at`. A policy
         *     that was never published is 400 `invalid_request`: discard it with `DELETE
         *     /v1/policies/{id}/draft` instead. A retired policy is 404 `not_found` here, as on a read.
         *
         *     Retiring requires an administrator of the organisation; a service principal never is. A policy the
         *     caller cannot see is 404 `not_found`, answered before the administrator check; a caller who sees the
         *     policy and is not an administrator is 403 `forbidden`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["retirePolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies/{id}/draft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Discard a policy's pending draft.
         * @description Hosted only, and only where the deployment advertises the feature `policies.retire` (rev 11), as
         *     `POST /v1/policies/{id}/retire` is. On a published policy it discards the pending draft: the read
         *     is unchanged, `GET /v1/policies/{id}/versions` no longer lists the draft and `draft_version` is
         *     absent; it answers 404 `not_found` when it has none. On a policy that was never published it
         *     deletes the policy: a read of it is then 404 `not_found`, and it leaves every list, its versions
         *     included. Either answers 204.
         *
         *     Discarding requires an administrator of the organisation; a service principal never is. A policy
         *     the caller cannot see is 404 `not_found`, answered before the administrator check; a caller who sees
         *     the policy and is not an administrator is 403 `forbidden`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        delete: operations["discardPolicyDraft"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Import policies.
         * @description Hosted only, and only where the deployment advertises the feature `policies.import_export` (rev
         *     10: a hosted deployment that does not advertise it answers 404 `not_available_on_deployment`).
         *     Returns a report; nothing is lost silently. Whatever cannot be represented is listed under
         *     `unsupported`.
         *
         *     Rev 14: a policy whose `targets` name a reference in the namespace `tool:noblecloak:` is never
         *     imported, because no policy changes a deployment-applied reference (see Deployment-applied
         *     proposals). It is listed under `unsupported`, with a `reason` that names `policy_immutable`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["importPolicies"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies/{id}/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Export a policy.
         * @description Hosted only, and only where the deployment advertises the feature `policies.import_export` (rev 10: a hosted deployment that does not advertise it answers 404 `not_available_on_deployment`).
         */
        get: operations["exportPolicy"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List connections.
         * @description The registrations of tool servers the caller may see (see `Owner`): a `principal`-owned connection is listed to its owner and to administrators only, an organisation's to every principal of the organisation. A deleted connection is not listed.
         */
        get: operations["listConnections"];
        put?: never;
        /**
         * Create a connection.
         * @description Registers a connection to a tool server. The server's URL fixes the identity of the tools registered
         *     from it (rev 11). One registration per server URL per organisation: a second live registration of
         *     a URL the deployment treats as the same server is 409 `connection_exists`, whose `connection_id`
         *     names the existing registration when the caller may read it (see `Owner`) and is absent otherwise.
         *     The deployment may treat URLs that differ only in form as the same server; a query string is part of
         *     the server's identity. A URL carries no credential: one with userinfo (`user:password@`) is 400
         *     `invalid_request`. A user linking a credential
         *     to an existing registration never meets this refusal.
         *
         *     **Who registers** (rev 11). A deployment may restrict registration
         *     (`Capabilities.connection_registration`): an owner kind it does not list, or a caller it does not
         *     admit, is 403 `forbidden`. That governs registration only, never who may use the registration. A
         *     transport the deployment does not serve (`Capabilities.connection_transports`) is 400
         *     `invalid_request`.
         *
         *     **Credentials** (rev 11). `auth` says how the server authenticates callers (`none`, `bearer` or
         *     `oauth`; absent means `none`) and never carries a credential. `credential_tier` is fixed here, and
         *     only an administrator sets it: `per_user`, where each user links a credential of their own (`POST
         *     /v1/connections/{id}/link`), or
         *     `org_shared`, one credential of the organisation that an administrator sets. Absent, it is
         *     `per_user` where the deployment advertises `connections.user_links` and `org_shared` elsewhere;
         *     `per_user` where the deployment does not advertise `connections.user_links` is 400
         *     `invalid_request`. `org_credential` is the organisation credential: administrator only and write
         *     only, legal only with `credential_tier: org_shared` and `auth.kind: bearer` (400 `invalid_request`
         *     otherwise), and that pair needs it (400 without). An `org_shared` registration that asks for
         *     `auth.kind: none` is 400 `invalid_request` when `credential_tier` is sent, since an organisation
         *     credential needs a kind of authentication; a registration with `auth.kind: none` that names no tier
         *     needs no credential and keeps the default tier. `org_shared` with `auth.kind: oauth` is created
         *     with `status: pending_authorization`, until an administrator authorizes it (`POST
         *     /v1/connections/{id}/authorize`). A caller who is not an
         *     administrator and sends `credential_tier` or `org_credential` is 403 `forbidden`. No operation
         *     returns a credential.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["createConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Connection detail.
         * @description One connection. Visibility follows `Owner`: a connection the caller may not see is 404 `not_found`.
         */
        get: operations["getConnection"];
        put?: never;
        post?: never;
        /**
         * Delete a connection.
         * @description Removes a connection. Its tools stay addressable for existing policies but can no longer be
         *     called through it: its tools become `withdrawn`; their policies remain and list them in
         *     `unenforced_targets`; registering the same server URL again makes them `active` under the same
         *     `tool_ref`. Every user's link to the registration is removed with it, and every authorization in
         *     flight. A deleted connection is 404
         *     `not_found` and is absent from lists (rev 11). Who deletes is who changes it (see `PATCH
         *     /v1/connections/{id}`). Visibility follows `Owner`: a connection the caller may not see is 404 `not_found`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        delete: operations["deleteConnection"];
        options?: never;
        head?: never;
        /**
         * Update a connection.
         * @description Changes the mutable fields of a connection: its `name`, and, for an `org_shared` registration with
         *     `auth.kind: bearer`, its organisation credential (`org_credential`, rotated by an administrator
         *     only, write only; 403 `forbidden` to anyone else, 400 `invalid_request` on any other registration).
         *     `url` is refused with 400 `invalid_request` (rev 11), whatever the kind of authentication: a
         *     connection's URL is the identity of its tools, so a server that moved is registered anew.
         *
         *     Who changes a connection (rev 11), on every deployment and whatever
         *     `Capabilities.connection_registration` says: a connection owned by the organisation (`org`) is the
         *     organisation's, so only its administrators change it, and any other caller who sees it is 403
         *     `forbidden`; a `principal`-owned connection is changed by its owner and by administrators.
         *     Visibility follows `Owner`: a connection the caller may not see is 404 `not_found`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        patch: operations["updateConnection"];
        trace?: never;
    };
    "/v1/connections/{id}/discover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Enumerate a tool server's tools.
         * @description Enumerates the tools the connected server offers. Discovery does not register them: it is a live
         *     dry run (rev 11), and `POST /v1/connections/{id}/refresh` registers. Visibility follows `Owner`: a connection the caller may not see is 404 `not_found`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["discoverConnectionTools"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections/{id}/authorize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start the OAuth round trip of a registration.
         * @description Rev 11. Hosted only, and only where the deployment advertises the feature `connections.oauth` (a
         *     hosted deployment that does not advertise it answers 404 `not_available_on_deployment`). For a
         *     registration whose `auth_kind` is `oauth`, answers the URL to send the browser to
         *     (`authorization_url`), good for one use and until `expires_at`. It acts on:
         *
         *     - a `per_user` registration: the caller's own link, which must exist with `consent: given` and a
         *       `status` of `pending_authorization`, `degraded` or `linked`; otherwise 400 `invalid_request` (link
         *       first, `POST /v1/connections/{id}/link`). Any caller who sees the registration authorizes their own
         *       link.
         *     - an `org_shared` registration: its organisation credential. Administrators only (403 `forbidden`
         *       otherwise), and the registration's `status` must be `pending_authorization`, `degraded` or
         *       `connected`.
         *
         *     Authorizing again a link that is `linked`, or an `org_shared` registration that is `connected`, is a
         *     re-authorization: the user consents again, or the authorization server issues a new credential. The
         *     credential in use stays in use, and the `status` stays as it is, until the round trip completes: a
         *     round trip that completes replaces the credential; one that ends in an error, or never completes,
         *     leaves the credential and the `status` as they were.
         *
         *     A registration whose `auth_kind` is not `oauth` is 400 `invalid_request`, and so is a `return_to`
         *     that is not on an origin the deployment admits for browser modules. After the user's consent the
         *     browser returns to `return_to` with the query parameters `nc_connection=<id>`,
         *     `nc_result=connected|error` and, on an error, `nc_error=<code>`, a code from the closed list
         *     `consent_denied`, `expired`, `exchange_failed`, `upstream_error`; never text from the authorization
         *     server. The deployment keeps `return_to`'s own query and adds the `nc_*` parameters to it.
         *     Visibility follows `Owner`: a connection the caller may not see is 404 `not_found`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["authorizeConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections/{id}/link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Link the caller's own credential to a registration, with consent.
         * @description Rev 11. Hosted only, and only where the deployment advertises the feature `connections.user_links`
         *     (a hosted deployment that does not advertise it answers 404 `not_available_on_deployment`). Creates
         *     or updates the caller's own credential link to a `per_user` registration and gives the caller's
         *     consent to its use. `consent` is required and must be `true`: a body without it, or with `false`, is
         *     400 `invalid_request`. For `auth_kind: bearer`, `token` is required on the first link and replaces
         *     the stored one when sent again; it is write only and never returned. For `auth_kind: oauth`, a
         *     `token` is 400 `invalid_request`: the link answers `my_link.status: pending_authorization`, and the
         *     caller then authorizes it (`POST /v1/connections/{id}/authorize`). Posting `consent: true` again
         *     after a revocation gives consent again and keeps the stored credential. An `org_shared`
         *     registration, or one whose `auth_kind` is `none`, has nothing to link: 400 `invalid_request`. The
         *     answer is the registration, with `my_link`.
         *
         *     A link is the caller's alone: it is never used for another user's calls, and no route reads or acts
         *     on another user's link, an administrator's included. Unlinking or revoking consent withdraws no tool
         *     and touches no policy. Visibility follows `Owner`: a connection the caller may not see is 404 `not_found`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["linkConnection"];
        /**
         * Remove the caller's own link to a registration.
         * @description Rev 11. Hosted only, behind `connections.user_links` as `POST /v1/connections/{id}/link` is. Removes
         *     the caller's own link and its credential, and any authorization of it still in flight (its
         *     `authorization_url` no longer completes). 204, also when the caller had none. It withdraws no tool
         *     and touches no policy. Visibility follows `Owner`: a connection the caller may not see is 404 `not_found`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        delete: operations["unlinkConnection"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections/{id}/link/consent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Revoke the caller's consent to its own link, keeping the credential.
         * @description Rev 11. Hosted only, behind `connections.user_links` as `POST /v1/connections/{id}/link` is. Revokes
         *     the caller's consent to the use of its own link and keeps the credential (`my_link.consent:
         *     revoked`); the deployment never uses a link whose consent is not `given`, and an authorization of it
         *     still in flight no longer completes. Consent is given again by
         *     posting the link with `consent: true`. 204; 404 `not_found` when the caller has no link. It withdraws
         *     no tool and touches no policy. Visibility follows `Owner`: a connection the caller may not see is 404 `not_found`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        delete: operations["revokeConnectionConsent"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections/{id}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-enumerate a tool server's tools and register them.
         * @description Rev 11. Enumerates the tools the connected server offers and registers them, an upsert: a tool
         *     offered for the first time is added, one offered again after it was withdrawn is `active` again
         *     under the same `tool_ref` (`reactivated`), and one no longer offered becomes `withdrawn` (`removed`;
         *     see `Tool.status`). Tools registered this way carry the connection's `transport` and its
         *     `connection_id`. An offered tool whose `tool_ref` is already registered another way (`POST
         *     /v1/tools`, or another server) is left as it is: it counts in `tool_count` and in none of the others. `empty_upstream_suppressed` is true when the server offered no tool at all and the
         *     deployment kept the registered ones rather than withdraw every one. The deployment enumerates with
         *     a credential it may use for enumeration, and never with a user's link to make that user's calls.
         *     Who refreshes is who changes the connection (see `PATCH /v1/connections/{id}`). Visibility follows `Owner`: a connection the caller may not see is 404 `not_found`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["refreshConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List tools.
         * @description Addressable tools that policies reference. A tool whose `owner.kind` is `principal` is listed only to the principal that registered it and to administrators (an administrator is a user, never a service principal; see Who registers tools); a tool whose `owner.kind` is `org` is listed to every principal of the organisation. A decision for a `principal` tool by any other principal is answered as for a tool with no catalog row: `deny` with reason `unknown_tool`. Tools registered by `POST /v1/connections/{id}/refresh` carry `transport` `mcp` or `a2a` and their `connection_id`. A tool its server no longer offers, or whose connection was deleted, stays listed with `status: withdrawn` (rev 11) and keeps the `connection_id` it was last registered from; a decision for it is `deny` with reason `unknown_tool`.
         */
        get: operations["listTools"];
        put?: never;
        /**
         * Register an external or in-process tool.
         * @description Registers a tool with `transport: external`: a local tool of an agent framework, run by the
         *     caller. Without a catalog row a decision for the tool is `deny` with reason `unknown_tool`, as it
         *     is for a `withdrawn` tool (rev 11); tools are never enrolled lazily. A tool with `transport: external` is consumed by its caller.
         *
         *     A reference in a namespace this deployment reserves is 422 `reserved_tool_ref` (rev 14: the namespace
         *     `tool:noblecloak:` is reserved on every deployment), and a reference
         *     equal to a system tool's is 422 `system_tool_ref`. A reference that is already in use in the
         *     caller's organisation for a tool registered another way is 422 `tool_ref_in_use`: a call under
         *     it would be ambiguous. That is a different case from a reference that is registered already
         *     (below). Only registration can be refused this way; a patch cannot change a tool's reference.
         *     The checks run in this order: reserved, system, in use, already registered. A reference that
         *     belongs to a tool the caller cannot see (a principal-owned tool of another principal, to a caller
         *     who is not an administrator user) is always answered 422 `tool_ref_in_use`, whichever ownership
         *     level (principal or organisation) and whichever side-effect level the caller asked for, and the body carries no property of that tool: not its level, owner, kind, setting or
         *     id, so two such refusals differ only in `request_id`. The existence of a reference within an
         *     organisation is not secret; a later revision is expected to make the references of
         *     principal-owned tools unique per owner. The two answers below are for a tool the caller can see.
         *     A patch cannot change a tool's reference, so it has no such answer. A tool's side-effect level never falls, and it
         *     moves through `PATCH /v1/tools/{id}`: registering a reference again at a level of strictly
         *     lower rank is 409 `side_effect_level_downgrade`, and registering a reference that is already
         *     registered at any other level (the same, a higher one, or the other level of the `write` and
         *     `external` tier) is 400 `invalid_request` (`POST` is not an upsert). The ranking is on
         *     `SideEffectLevel`.
         *
         *     `show_arguments_to_approvers` may be set here and on `PATCH /v1/tools/{id}` for any tool the
         *     caller may change, whatever its transport; a deployment that does not serve approvals accepts it
         *     and ignores it. A deployment may allow only some principals to register tools: any other is 403
         *     `forbidden`, whatever the body (`Capabilities.tool_registration` says which applies). A tool
         *     registered with `owner_kind: principal` (the default) is visible to the registering principal and
         *     to administrators only (see Who registers tools); `owner_kind: org` makes it the organisation's.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["registerTool"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tools/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Tool detail.
         * @description One tool, with its side-effect level, data routing and transport. A tool whose `owner.kind` is `principal` is read only by the principal that registered it and by administrators (see Who registers tools; a service principal is never one); any other reader gets 404 `not_found`, as for a tool that does not exist.
         */
        get: operations["getTool"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update a tool.
         * @description Changes the mutable fields of a tool. The side-effect level never falls: a level of
         *     strictly lower rank is 409 `side_effect_level_downgrade`, and a level of the same or a higher
         *     rank, including a move between `write` and `external` in either direction, is accepted. The
         *     ranking is on `SideEffectLevel`. `show_arguments_to_approvers` may be changed here; turning it
         *     off clears the arguments already stored for the tool's open approvals. A deployment may allow only
         *     some principals to change tools (`Capabilities.tool_registration`): any other is 403 `forbidden`,
         *     whatever the body. A `principal`-owned tool is the registering principal's and
         *     the administrators' to change (see Who registers tools); for any other principal it is 404 `not_found`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        patch: operations["updateTool"];
        trace?: never;
    };
    "/v1/principals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List principals.
         * @description One facade over users, groups and roles of the identity provider and of agents.
         */
        get: operations["listPrincipals"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Declare an agent.
         * @description Declares an agent, optionally with its `parent`.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["createAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Agent detail.
         * @description One agent and its declared parent.
         */
        get: operations["getAgent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/principal": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Bind an agent to a service principal.
         * @description Rev 13. Binds the agent to one service principal of the organisation, so that the agent's policies
         *     apply to calls made with that principal's token (see Agent identity). Binding an agent that is
         *     already bound replaces its binding: binding the same agent to the same principal again is a 200 no-op,
         *     and binding it to a different principal replaces the binding, so the old principal loses that agent's
         *     policies. For an administrator of the organisation: any other caller, a
         *     service principal included, is 403 `forbidden`. An agent of another organisation, an id that names no
         *     agent, and a `principal_id` that names no service principal of the organisation (a user cannot be
         *     bound) are the same 404 `not_found`, answered after the administrator check. A service principal that
         *     is already bound to another agent is 409 `principal_bound`, whose `agent_id` names that agent. The 409 must be atomic: a deployment
         *     enforces it with a uniqueness constraint on the principal, never a check followed by a set.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        put: operations["bindAgentPrincipal"];
        post?: never;
        /**
         * Remove an agent's binding.
         * @description Rev 13. Removes the agent's binding, so that no caller holds its policies. Idempotent: an agent that
         *     is not bound is 204 as well. For an administrator of the organisation: any other caller is 403
         *     `forbidden`. An agent of another organisation and an id that names no agent are the same 404
         *     `not_found`, answered after the administrator check.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        delete: operations["unbindAgentPrincipal"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create an external run.
         * @description An `external` run creates a scope and never an execution. Approvals created with its `run_id` are
         *     deduplicated within the run's scope and never shared with another scope. `kind: governed` is
         *     created by the platform, not by a caller: it is 405 `governed_run_not_creatable`.
         *
         *     A run may name only an agent that is a row of the caller's organisation in `/v1/agents`
         *     (`agent_id`): an agent of another organisation, and an id that names no agent, are the same 404
         *     `not_found`. The run's `agent_id` never selects a policy (rev 13), whoever names the run in
         *     `actor.run_id`. `actor.agent_id` on a decision or a record is a free-form display hint (rev 13): it is
         *     not checked this way and it never selects a policy.
         *
         *     The scope propagation rule: a delegated run has a fresh `scope_id`, so a child never shares an
         *     obligation with its delegator, and an approval granted in one scope never satisfies a call in
         *     another.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["createRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Run detail.
         * @description Read-only for `governed` runs. Both kinds expose `scope_id`; the scope propagation rule is described on `POST /v1/runs`.
         */
        get: operations["getRun"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List webhooks.
         * @description Webhook subscriptions of the organisation. For an administrator of the organisation (rev 12): any other principal is 403 `forbidden`.
         */
        get: operations["listWebhooks"];
        put?: never;
        /**
         * Subscribe a webhook.
         * @description Subscribes `url` to the events listed in `events`: `approval.resolved`, `record.appended` and
         *     `policy.published`. The events are organisation-wide, so creating, listing and deleting webhooks
         *     is for an administrator of the organisation (rev 12): any other principal is 403 `forbidden`. The
         *     same callback guard applies as on continuations.
         *
         *     **Delivery (rev 12).** A delivery is a `POST` to `url` with `Content-Type:
         *     application/cloudevents+json`; the body is a `WebhookDelivery`, a CloudEvents 1.0 structured-mode
         *     JSON object plus a `signature` member. `signature` is a JWS compact serialization (ES256, `kid` in
         *     the header) whose payload is the JCS form of the object without `signature`, exactly as for a
         *     Resumption: verify it against `/.well-known/jwks.json`. There is one signature per event, shared by
         *     every subscriber, so the body names no subscriber; the subscription's id travels in the unsigned
         *     request header `NobleCloak-Webhook-Id`. Any 2xx response means delivered. Otherwise the deployment
         *     retries with backoff for at least 24 hours and then drops the delivery. A webhook whose deliveries
         *     have failed continuously for 72 hours becomes `disabled` (`Webhook.state`), and a disabled webhook
         *     gets no deliveries; to enable it again, delete it and create it anew (there is no update route).
         *     Deliveries are not ordered and may repeat: a receiver dedupes on the event `id`.
         *
         *     An event is thin: `data` names the resource and its new state, never the representation, so a
         *     receiver reads the resource with its own token. `subject` is the resource id, `type` is the
         *     `WebhookEvent`, and `source` is the origin of the deployment. `approval.resolved` is sent when an
         *     approval reaches a final resolution (`approved` or `rejected`); an escalation does not resolve it.
         *     A deployment delivers only the documented resolutions: an approval resolved any other way emits no
         *     `approval.resolved` delivery.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["createWebhook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete a webhook.
         * @description Stops deliveries. For an administrator of the organisation (rev 12): any other principal is 403 `forbidden`. A webhook of another organisation is 404 `not_found`, answered before the administrator check.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        delete: operations["deleteWebhook"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/origins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Registered browser origins.
         * @description The browser origins registered for the organisation. Open to any principal of the organisation (rev 12); registering them is for an administrator.
         */
        get: operations["getOrigins"];
        /**
         * Replace registered browser origins.
         * @description Replaces the organisation's registered browser origins. For an administrator of the organisation (rev 12): any other principal is 403 `forbidden`. Every origin must be exact (see Browser origins): one that is not is 400 `invalid_request`, naming it, and nothing is changed. An origin stored before rev 12 that is not exact admits nothing (not for CORS and not as a `return_to`); `GET /v1/origins` still returns it so an administrator can replace it, and a deployment never normalises an origin at request time.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        put: operations["putOrigins"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What this deployment serves.
         * @description `deployment`, `entitlements[]`, `jwks_uri`, `kids[]`, `resolutions[]`, `features[]` (the route
         *     families and hosted-only features served here), `authzen_configuration`, and `limits`, the batch
         *     sizes this deployment accepts when they are below the contract's 100 and the bound on the arguments
         *     it keeps for an approval. A deployment that restricts what the rest of the document allows says
         *     so in optional members: `continuation_deliveries` (the deliveries it serves), rev 17,
         *     `continuation_kinds` (the continuation kinds it accepts; absent, the seven kinds of rev 16), rev 18,
         *     `proposals` (the rows and members of a policy-set proposal it accepts; absent, those of rev 14),
         *     `tool_registration` (who may register tools) and, rev 11, `policy_forms` (the policy forms it
         *     enforces), `connection_registration` (who may register a connection) and `connection_transports`
         *     (the connection transports it serves); any other absent member is the unrestricted rev 5 behaviour. A client needs
         *     nothing else to know what this deployment offers.
         *
         *     **Families.** A deployment may serve only part of the document. The routes it may leave out fall
         *     into eleven families, and each operation names its family in `x-noblecloak-family`:
         *     `approvals` (the approval routes and `/v1/continuations/test`), `runs`, `webhooks`, `origins`,
         *     `policies`, `agents`, `principals`, `connections`, `records.checkpoints` (checkpoints and
         *     verification), `records.chain` and `evidence`. `approvals` is advertised if and only if
         *     `resolutions` is non-empty; every other family is advertised if and only if its name is in
         *     `features`. A route of a family the deployment does not advertise is not served. A route of an
         *     advertised family behaves as documented.
         *
         *     **Floor.** Capabilities, decisions (single and batch), records (append, batch, list, get), tools,
         *     the AuthZEN evaluation, the well-known documents and every authentication rule are served by every
         *     deployment, whatever it advertises.
         */
        get: operations["getCapabilities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/.well-known/jwks.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The key set.
         * @description The hosted key set. On an edge deployment it is a mirror of the same set for offline verification: the edge mints nothing.
         */
        get: operations["getJwks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/edge/{path}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The edge protocol path. */
                path: string;
            };
            cookie?: never;
        };
        /**
         * Edge protocol read, by reference only.
         * @description Placeholder. The edge protocol is defined outside this document; the edge is the caller.
         */
        get: operations["edgeProtocolRead"];
        put?: never;
        /**
         * Edge protocol write, by reference only.
         * @description Placeholder. The edge protocol is defined outside this document; the edge is the caller.
         *
         *     Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.
         */
        post: operations["edgeProtocolWrite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export interface webhooks {
    webhookDelivery: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A webhook delivery (rev 12).
         * @description What a receiver is sent at the `url` of a webhook, one request per event (see `createWebhook`). The
         *     request is not an operation of this API: the receiver implements it. The body is signed (verify it
         *     against `/.well-known/jwks.json`), `NobleCloak-Webhook-Id` names the subscription and is not signed,
         *     and any 2xx response means delivered.
         */
        post: operations["receiveWebhookDelivery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export interface components {
    schemas: {
        /** @description An RFC 9457 problem. `type` is a stable URI whose last path segment is the problem code. */
        Problem: {
            /**
             * Format: uri
             * @example https://docs.noblecloak.com/problems/approval_conflict
             */
            type: string;
            title: string;
            status: number;
            detail?: string;
            instance?: string;
            /** @description The id of this request, of the same kind as `meta.request_id` on a success envelope. Every problem this API produces carries one, a server failure included, and it is never empty. */
            request_id: string;
            /** @description Only on `batch_too_large`: the most items this deployment accepts in the batch, so a client that never read `limits` on the capabilities can split the batch and retry. */
            max_items?: number;
            /** @description Only on `service_unavailable` and `rate_limited`, and only when the response carries the `Retry-After` header: the same number of seconds. A browser reads a response header cross-origin only if the server lists it, and it can always read the body. */
            retry_after_seconds?: number;
            /** @description Only on `service_unavailable`: a code token naming the cause. The documented value is `eligibility_lookup` (the deployment could not determine whether the caller may resolve an approval, so it answers 503 and never a digest-only view or a refusal). A client treats a well-formed value it does not know as a plain 503; a client that matches on `type` keeps working. */
            reason?: string;
            /** @description Only on `payload_too_large`: the most bytes of body this deployment accepts, when it can say. */
            max_bytes?: number;
            /** @description Only on `policy_conflict`: the published policy that already governs one of the (tool, subject) pairs of the policy being published. */
            policy_id?: string;
            /** @description Only on `rejected_duplicate`: the most recent rejected approval, within the window, whose identity the request repeats, readable under the rules of Who sees an approval. */
            rejected_approval_id?: string;
            /** @description Only on `connection_exists` (rev 11): the existing registration of the same server, when the caller may read it (see `Owner`); absent otherwise. */
            connection_id?: string;
            /** @description Only on `principal_bound` (rev 13): the agent the service principal is already bound to. Always present on `principal_bound`. */
            agent_id?: string;
            /** @description Only on `unsupported_policy_form` (rev 13) and on `proposal_refused` (rev 14, where it is present when the refusal has a part of the body to name), and (rev 16) on an `invalid_request` that refuses a fact binding or a condition, for example `facts.amount.path` or `config.rules[0].when[1].fact`: the member of the request body the deployment cannot enforce, as a dotted and bracketed path into the body as sent, for example `subjects[0].type`, `config.mode`, `subject`, on `POST /v1/policies/simulate` `policies[2].subjects[0].type`, or on `proposal_refused` `action.arguments.policies[1].policy.targets.tools[0]`. Keys are the member names as sent; an index is a decimal integer; the first segment is a top-level member of the request body. `detail` stays human prose. A client reads `member`, and falls back to `detail` when a rev 12 deployment omits it. */
            member?: string;
            /** @description Only on `proposal_refused` (rev 14), and always present on it: why the proposal was refused. The documented values are `not_a_user`, `shape`, `unknown_agent`, `principal_bound`, `tool_ref_in_use`, `target_unknown`, `baseline_exists`, `tightening_looser` and, rev 18, `not_entitled` (see `PolicySetProposal`). A client treats a well-formed value it does not know as a plain refusal; a client that matches on `type` keeps working. */
            code?: string;
        };
        Meta: {
            request_id: string;
            /** @enum {string} */
            deployment: "hosted" | "edge";
            cursor?: string | null;
            /** @description Pass as `cursor` for the next page; null on the last page. */
            next?: string | null;
        };
        /** Format: date-time */
        Timestamp: string;
        /** @description Lowercase hex SHA-256. */
        Digest: string;
        /**
         * @description How much a tool can change. The levels rank `read` < `write` = `external` < `delete` < `admin`: `write` and `external` are the same governance tier, so a tie counts as no change. A tool's level never falls: a move to a strictly lower rank is 409 `side_effect_level_downgrade`; a move to a higher rank, or between `write` and `external` in either direction, is allowed. The order of the members of this list is the order the vocabulary is written in, not the ranking.
         * @enum {string}
         */
        SideEffectLevel: "read" | "write" | "delete" | "external" | "admin";
        /**
         * @description `defer` is reserved and has no emitter in v1.
         * @enum {string}
         */
        DecisionValue: "allow" | "deny" | "step_up" | "defer";
        /** @enum {string} */
        ObligationKind: "tool_invocation" | "spending";
        /** @description How an approval was resolved. Open-ended: the documented values are `approved`, `rejected` and `escalated`, and a client treats any other value as a resolution it does not act on. Known values: approved | rejected | escalated. */
        Resolution: string;
        /**
         * @description The state of an approval. Separate from its resolution.
         * @enum {string}
         */
        ApprovalState: "pending" | "approved" | "rejected" | "consumed" | "expired" | "withdrawn";
        /** @enum {string} */
        PrincipalKind: "user" | "agent" | "service" | "group" | "role";
        /** @description A principal by id and kind, never by name. A record's `actor` and a Resumption's `approver` are this shape: a name is shown only inside an approval (see `NamedPrincipalRef` and Who is named on an approval). */
        PrincipalRef: {
            id: string;
            kind: components["schemas"]["PrincipalKind"];
        };
        /** @description A principal as an approval names it: `PrincipalRef` with an optional name. Used only where the reference is part of an approval representation (`Approval.requester`, `Approval.approver`, the entries of `Approval.resolution_history`, the principals of `Approval.waiting_on`), and shown only to a reader who can see that approval. */
        NamedPrincipalRef: {
            id: string;
            kind: components["schemas"]["PrincipalKind"];
            /** @description The name the deployment knows the principal by. Optional: absent when the deployment cannot name the principal, never the id repeated and never null (see Who is named on an approval). */
            display_name?: string;
        };
        PolicyRef: {
            id: string;
            version: number;
        };
        DecisionPolicy: {
            id: string;
            version: number;
            side_effect_level: components["schemas"]["SideEffectLevel"];
        };
        /** @description Hints about who is acting. The principal is the token's and is never read from here. `run_id` names an `external` run the caller owns and selects its scope. A deployment that does not advertise `runs` has no run to name, so a `run_id` there is 404 `not_found`, whatever its value. On a deployment that does advertise `runs`, a `run_id` that names no run the caller owns is 403 `forbidden`. `run_id` selects the scope and nothing else: the `agent_id` of the run it names never selects which policies apply to the call either (rev 13). `agent_id` is a display hint (rev 13): a deployment may show it, and it never selects which policies apply to the call. An agent's policies apply through the service principal bound to the agent (see Agent identity). */
        ActorHint: {
            /** @description A display hint, never identity (rev 13). For a caller with no bound agent, `Approval.agent` reflects this client-supplied value, which the deployment has not verified. */
            agent_id?: string;
            run_id?: string;
        };
        /** @description What is about to run. Exactly one of `arg_digest` (the digest of the arguments as sent) or `arguments` (the arguments themselves, which the server digests). Rev 16: the facts a policy's rules test are read from `arguments` through the tool's fact bindings (`Tool.facts`); a call that sends only `arg_digest` has no facts, so a rule that needs one is unevaluable and its policy asks. */
        Action: {
            tool_ref: string;
            method?: string;
            arg_digest?: components["schemas"]["Digest"];
            arguments?: {
                [key: string]: unknown;
            };
        } & (unknown | unknown);
        Resource: {
            type: string;
            id: string;
            properties?: {
                [key: string]: unknown;
            };
        };
        DecisionContext: {
            invocation_channel?: components["schemas"]["InvocationChannel"];
            call_id?: string;
            group_id?: string;
        };
        /**
         * @description How the call was made. The same enum and meaning wherever it appears.
         * @enum {string}
         */
        InvocationChannel: "interactive" | "headless" | "workflow";
        /** @description The context a record carries: the invocation channel only. `call_id` and `group_id` belong to a decision request and are not accepted on a record. */
        RecordContext: {
            invocation_channel?: components["schemas"]["InvocationChannel"];
        };
        /** @description How the runtime is told that an approval resolved. One continuation per obligation. `correlation` is opaque, at most 8 KiB, and never an input to identity. `callback_url` is required if and only if `delivery` is `push`, must be https and public-routable: the server resolves the host and refuses loopback, RFC 1918, link-local and cloud-metadata ranges, follows no redirects, and checks again at every delivery. Wherever a continuation is echoed (`Approval.continuation`, the Resumption, the approval stream) it is the same JSON value as was sent; the order of an object's members and insignificant whitespace are not preserved and carry no meaning, and two continuations are the same when their RFC 8785 canonical forms are equal. A deployment may refuse a delivery it does not serve with 400 `invalid_continuation`, after the `callback_url` check for a push. `claude_agent_sdk` is the Claude Agent SDK connector's kind and is used with `pull` only: it with `push` or `held` is 400 `invalid_request`; its `correlation` is `{ session_id, tool_use_id, agent_id?, mode }` with `mode` `defer` or `retry`, and a missing `agent_id` means the main agent. The server reads none of it: the correlation stays opaque, at most 8 KiB, and is echoed as sent. A deployment lists the kinds it accepts in `Capabilities.continuation_kinds`. */
        Continuation: {
            /** @enum {string} */
            kind: "adk" | "langgraph" | "vercel_ai" | "openai_agents" | "webhook" | "mcp_held" | "agt" | "claude_agent_sdk";
            /** @enum {string} */
            delivery: "push" | "pull" | "held";
            correlation?: {
                [key: string]: unknown;
            };
            /** Format: uri */
            callback_url?: string;
            /** @description The continuation's own validity. It is separate from the approval's per-policy `expires_after`. */
            expires_at?: components["schemas"]["Timestamp"];
        } & (unknown & unknown);
        DecisionRequest: {
            actor?: components["schemas"]["ActorHint"];
            action: components["schemas"]["Action"];
            resource?: components["schemas"]["Resource"];
            context?: components["schemas"]["DecisionContext"];
            continuation?: components["schemas"]["Continuation"];
            /** @description A hint only, used to log a mismatch. This route never consumes. */
            expect_approval_id?: string;
        };
        DecisionBatchRequest: {
            requests: components["schemas"]["DecisionRequest"][];
        };
        /** @description The obligation a step-up decision opened or matched. It never carries `arguments`: they are read from `GET /v1/approvals/{id}` only. */
        ApprovalHandle: {
            /** @description The approval id. It MUST be unguessable: not sequential and not derivable from the action, the scope or any other value a caller can compute. The 403 `not_eligible` that resolve, approve and deny answer to a service principal on kind alone shows that an approval with the id exists, and that exception relies on this (see Who sees an approval). */
            id: string;
            state: components["schemas"]["ApprovalState"];
            /** @description True when this call opened the obligation, false when it matched an open one. */
            created: boolean;
            created_at: components["schemas"]["Timestamp"];
            /** Format: date-time */
            expires_at?: string | null;
            /** @description True when the Resumption will carry a `resume_token` the caller must consume through `/consume`. When it is `false` the caller will receive no `resume_token`, has nothing to consume, and must not execute the action itself: the deployment executes the tool. A caller that holds a local function under a tool reference the deployment executes denies the call instead of running it, and withdraws the approval if its own decision opened it (`created`). */
            resume_token_will_issue: boolean;
        };
        /** @description A non-human condition a `defer` decision waits on. Reserved. */
        Condition: {
            kind: string;
            resume_at?: components["schemas"]["Timestamp"];
            ref?: string;
        };
        /** @description What the server decided for one action. `policy` is optional: absent means no explicit policy matched and the default applied, and when present its `id` and `version` are required and never null. */
        Decision: {
            decision: components["schemas"]["DecisionValue"];
            /** @description For example `not_granted`, `rate_limited`, `unknown_tool`, `approval_unroutable`, `rejected_duplicate`, `credential_link_required` (rev 11: a `deny` for a direct call by a caller with no usable credential link to the `per_user` registration of the tool, when no approval is opened). */
            reason?: string;
            /** @description The argument digest the server computed for the action as received. */
            action_digest: components["schemas"]["Digest"];
            /** @description The policy that decided; absent when the default applied. Where several policies contributed to the decision (rev 11; see `policies.tightest_wins` on `Capabilities.features`), it names one of the entries that contributed, the deployment's choice: the `considered` of a simulation lists the set. */
            policy?: components["schemas"]["DecisionPolicy"];
            approval?: components["schemas"]["ApprovalHandle"];
            enforced: boolean;
            would_be?: components["schemas"]["DecisionValue"];
            condition?: components["schemas"]["Condition"];
            /** @description Only on a `deny` with reason `rejected_duplicate` (rev 10): the most recent rejected approval, within the window, whose identity this call repeats, readable under the rules of Who sees an approval. Absent on every other decision. */
            rejected_approval_id?: string;
            /** @description Rev 16: on a `step_up`, the facts with no value that stopped the rule walk of a policy that contributed to it (see the evaluation in `ToolInvocationConfig`), each once, in the order the policies and their rules name them. Absent when every contributing policy's result came from a rule that matched or from its `mode`, and on every other decision. Set only by a deployment that lists the feature `policies.rules`. */
            missing_facts?: components["schemas"]["FactName"][];
        };
        CreateApprovalRequest: {
            action: components["schemas"]["Action"];
            continuation: components["schemas"]["Continuation"];
            run_id?: string;
            resource?: components["schemas"]["Resource"];
            context?: components["schemas"]["DecisionContext"];
        };
        HistoryEntry: {
            resolution: components["schemas"]["Resolution"];
            by: components["schemas"]["NamedPrincipalRef"];
            at: components["schemas"]["Timestamp"];
            /** @description Why, in the resolver's words. Rev 14: on a deployment-applied approval that the deployment refused to apply when it was approved, the entry has `resolution: rejected`, `by` the administrator whose approval was refused, and `reason` of the form `proposal_refused:<code>`, where `<code>` is a `Problem.code` of `proposal_refused` or `policy_conflict` (see Deployment-applied proposals). */
            reason?: string;
        };
        /** @description An approval. `continuation_kind` is visible to every reader of the approval. `continuation`, the full continuation the approval was opened with, is present only when the reader is the principal that created the approval, in every state (pending, approved, rejected, consumed, expired, withdrawn); for every other reader the member is absent. A service principal reads only the approvals it created (see Who sees an approval). `policy` is optional: absent means no explicit policy matched and the default applied; it is never synthesised and never null, and when present its `id` and `version` are required. */
        Approval: {
            /** @description The approval id. It MUST be unguessable: not sequential and not derivable from the action, the scope or any other value a caller can compute. The 403 `not_eligible` that resolve, approve and deny answer to a service principal on kind alone shows that an approval with the id exists, and that exception relies on this (see Who sees an approval). */
            id: string;
            state: components["schemas"]["ApprovalState"];
            resolution?: components["schemas"]["Resolution"];
            tool_ref: string;
            obligation_kind: components["schemas"]["ObligationKind"];
            action_digest: components["schemas"]["Digest"];
            /** @description The arguments as the caller sent them (their digest is `action_digest`). Present only on `GET /v1/approvals/{id}`, and only when the tool has `show_arguments_to_approvers` on at the time of the read, the approval is not final and the reader is the principal that created it or one eligible to approve it; absent everywhere else, and then the digest is all a reader sees (see Who sees the arguments of an approval). */
            arguments?: {
                [key: string]: unknown;
            };
            /**
             * @description Why a read shows the arguments or not. Present on `GET /v1/approvals/{id}` and on each approval of `GET /v1/approvals`; a stream event may omit it, and a client then treats the state as unknown. `shown`: `arguments` is present (never on a list row, which carries no `arguments`; the state there says what the single read would show). `not_enabled`: the tool's `show_arguments_to_approvers` is off. `not_sent`: the approval holds no arguments, because the request that opened it carried only `arg_digest` or the setting was off then. `withheld`: the reader is neither the creator nor eligible to approve. `final`: the approval is in a final state. A reader who is neither the creator nor eligible to approve is told `final` for an approval in a final state and `withheld` otherwise, never `not_enabled`, `not_sent` or `shown`; the creator and an eligible approver are told the first of `final`, `not_enabled`, `not_sent`, `shown` that applies, never `withheld`. It discloses nothing of the arguments (see Who sees the arguments of an approval).
             * @enum {string}
             */
            arguments_state?: "shown" | "not_enabled" | "not_sent" | "withheld" | "final";
            scope_id: string;
            side_effect_level: components["schemas"]["SideEffectLevel"];
            policy?: components["schemas"]["PolicyRef"];
            /** @description The principal that created the approval. Present on every representation to any reader who can see the approval (see Who is named on an approval). */
            requester?: components["schemas"]["NamedPrincipalRef"];
            /** @description Who a pending approval waits on, to the principal that created it and to no one else, on `GET /v1/approvals/{id}` only: never a row of `GET /v1/approvals` or an event of the stream. `count` is the number of principals eligible to resolve the approval that the deployment knows of at the time of the read; it may be zero, may change between reads, and is not a promise that any of them has been notified. `principals` is at most five of them. Rev 16: on an approval that carries `requirements`, the principals counted are those eligible for at least one unmet requirement, never the creator. Absent on an approval that is not pending and for every other reader, and absent when the deployment cannot determine who is eligible (the read is still 200, never an error on that account). For a service-principal creator `principals` is omitted and only the count is given. */
            waiting_on?: {
                count: number;
                principals?: components["schemas"]["NamedPrincipalRef"][];
            };
            /**
             * @description What the requester's run does when the approval is denied, as the policy that matched stated it when the approval was created (rev 9): a snapshot of that policy's `on_deny`, so a later edit of the policy does not change an approval that already exists. It is the creator's alone, on every representation of the approval that the creator reads, and absent for every other reader. It is absent when no named policy matched (`policy` is absent), when the matching policy states none, and when the matching policy's mode is not `ask` or `escalate`, where `ToolInvocationConfig` makes `on_deny` illegal. A deployment that does not implement `on_deny` on its policies omits it from every approval, and a client then treats what a deny does as not stated, never as `resume` or `halt`.
             * @enum {string}
             */
            on_deny?: "resume" | "halt";
            /** @description Set when the approval was opened for an identity a resolver had already rejected, because the organisation's duplicate-requests policy says `ask_again` (rev 10; see Terminal states free the identity): `count` is the number of a resolver's rejections of this identity within the policy's window since its last consumed approval, and `last_at` is when the latest of them was resolved. Present on every representation of the approval (the single read, a row of the list, a stream event) to every reader who can see the approval, and absent on an approval opened for an identity with no such rejection. A deployment that does not advertise `approvals.rejected_duplicate` never sets it. */
            prior_rejections?: {
                count: number;
                last_at: components["schemas"]["Timestamp"];
            };
            /** @description Rev 11: the call would run through the deployment as a principal with no usable credential link (none, consent not `given`, or `degraded`) to the `per_user` registration `connection_id`. It is shown only to the principal the call would run as (the run's owner; on a direct call, the creator), on the single read and on a row of the list, and is absent for every other reader and on every stream event. An approval with `blocked_on` may still be resolved; the deployment does not execute the call or issue its resume token while it is present, and clears it once that principal's link is `linked` with `consent: given`. It follows that link on every read of a pending or approved approval: revoking consent sets it again. The way out is the link routes: `POST /v1/connections/{connection_id}/link`, then, for a registration whose `auth_kind` is `oauth`, `POST /v1/connections/{connection_id}/authorize`. A deployment that does not advertise `connections.user_links`, and so every edge deployment, never sets it. */
            blocked_on?: {
                /** @description Why the call waits. `credential_link_required`: the principal needs a usable link to the registration. Open-ended: a client treats a value it does not know as a block it cannot clear itself. */
                reason: string;
                connection_id: string;
            };
            /** @description The agent the approval names. For a caller bound to an agent it is that agent. For a caller with no bound agent it reflects the client's unverified `actor.agent_id` hint (rev 13): display only, and an approver must not treat it as identity. */
            agent?: {
                id: string;
                /** @description The agent's name (`Agent.name`), when the deployment can say. Absent otherwise. */
                name?: string;
                parent?: string | null;
            };
            run?: {
                id: string;
                /** @enum {string} */
                kind: "external" | "governed";
            };
            continuation_kind?: string;
            /** @description The continuation as it was sent, echoed to the principal that created the approval and to no one else. It is echoed as the same JSON value, not the same bytes: the order of an object's members and insignificant whitespace are not preserved and carry no meaning, so a deployment that keeps JSON in a normalising store may return the members in another order. */
            continuation?: components["schemas"]["Continuation"];
            created_at: components["schemas"]["Timestamp"];
            /** Format: date-time */
            expires_at?: string | null;
            /** Format: date-time */
            resolved_at?: string | null;
            approver?: components["schemas"]["NamedPrincipalRef"];
            /** @description The record that reported what happened after consumption. */
            outcome_record_id?: string | null;
            resolution_history?: components["schemas"]["HistoryEntry"][];
            /** @description Rev 14: what approving a deployment-applied approval would change, computed when it was opened. Present only on `GET /v1/approvals/{id}`, only while the approval is `pending`, and only to a reader who may approve it; absent on every other representation, for every other reader and on an approval of an ordinary tool. A rev 13 reader never needs it. */
            preview?: components["schemas"]["ApprovalPreview"];
            /** @description Rev 15: what the reader may do on this approval, with the deployment's wording and the inputs each action takes. Present only on `GET /v1/approvals/{id}`, only while the approval is `pending`, and only to a reader who may resolve it, and only on a deployment that lists the feature `approvals.available_actions`; absent on every other representation (a list row, a stream event) and for every other reader. The `resolution` of each `resolve` action is one of `Capabilities.resolutions`. On a deployment that does not list `approvals.available_actions`, absent means the deployment does not say, and a client derives approve and deny from `Capabilities.resolutions`. On a deployment that lists it, absent means no action for this reader, and a client derives none. Being listed is not authorisation: resolving still decides eligibility when it is called. A rev 14 reader never needs it. */
            available_actions?: components["schemas"]["ApprovalAction"][];
            /**
             * @description Rev 16: what must be met before the approval is approved, one entry per requirement. Each policy whose result asked and that contributed to the step-up that opened the approval (for one opened through `POST /v1/approvals`, the step-up a decision of the same call would give) contributes one requirement, and two policies whose approver entries in force and `exclude` are the same (an entry listed twice counts once) contribute one requirement between them, which lists both. Present on every representation of the approval to every reader who can see it, on a deployment that lists the feature `approvals.requirements`, and only there: a deployment that does not list it never sets the member. Where the feature is listed, an approval without the member has one requirement, satisfied as before rev 16.
             *
             *     Joining: a decision or `POST /v1/approvals` whose call matches an open approval joins it (two requirements are the same when their approver entries and `exclude` are). A `pending` approval that lacks requirements the call sets gains them, unmet, and emits `approval.updated`, so a joined `pending` approval never carries fewer requirements than the call sets. An `approved` approval that has not been consumed is joined as it is: its requirements are the ones in force when it was approved, and a requirement the call sets later is not added to it and does not open another approval. An approval binds the decision it answered, the same reason `on_deny` and the organisation's break-glass setting are fixed when the approval opens, and there is one approval per call identity at a time.
             *
             *     Approve: the approver satisfies every unmet requirement they are eligible for, so one person may satisfy several, and the approval is `approved` once every requirement is met. An approve that leaves a requirement unmet answers 200 with the approval still `pending`, no `resolution`, and the requirements it satisfied recording the approver; it emits `approval.updated`. Reject: any principal eligible for at least one unmet requirement rejects the approval, whatever has been met. An approve or reject by a principal eligible for no unmet requirement is 403 `not_eligible` while the approval is `pending`; once it is not, a principal eligible for any of its requirements is answered as before rev 16 (409 `already_resolved` for an approval already resolved). The rules on the creator (see Who may resolve, and `Capabilities.self_approval_from_approver_surface`) apply on top: a requirement whose `exclude` holds `requester` is never satisfied by the creator, from any surface. A rev 15 reader never needs it.
             */
            requirements?: components["schemas"]["ApprovalRequirement"][];
        };
        /** @description Rev 16: one requirement of an approval. Who is eligible for it: a holder of one of its `approvers` (a role the principal holds when it acts, or the user named); with `approvers` empty, an administrator of the organisation. When the organisation's `approval_routing` setting has `org_admin_break_glass` on (the default), an administrator of the organisation is eligible for every requirement too, and satisfies it with `basis: break_glass`. A principal `exclude` names is eligible for none of it, whatever else holds. */
        ApprovalRequirement: {
            /** @description Stable within the approval. */
            id: string;
            /** @description The policies that contributed the requirement, at the versions that decided. */
            policies: components["schemas"]["PolicyRef"][];
            /** @description The approver entries in force when the approval was opened (the matching rule's `approvers` when it had them, else the policy's, keeping only the entries whose `when` held). Empty: the organisation's administrators. */
            approvers: components["schemas"]["ApproverRef"][];
            exclude: "requester"[];
            /** @description How many eligible principals must approve to meet it. Always 1 in rev 16. */
            needed: number;
            met: boolean;
            /** @description The approvals that count toward it, oldest first. */
            approvals: {
                by: components["schemas"]["NamedPrincipalRef"];
                at: components["schemas"]["Timestamp"];
                /**
                 * @description `listed`: the approver was eligible for the requirement itself. `break_glass`: an administrator of the organisation under the `approval_routing` setting.
                 * @enum {string}
                 */
                basis: "listed" | "break_glass";
            }[];
        };
        /** @description What approving a `tool:noblecloak:propose-policy-set` approval would change (rev 14), computed by the deployment when the approval is opened from the proposed bodies, with nothing stored, as `POST /v1/policies/simulate` does. It is no part of `arguments`. Rev 18 adds `grants`, `ineffective` and the `loosening` entries of `role` rows (with `subject`); a deployment that predates rev 18 sends none of them. */
        ApprovalPreview: {
            /** @description One entry for each tool that the proposal's policies govern, in the order the tools first appear in `policies`: the decision for a call to that tool, composed for the agent of the proposal, as a simulation as `{ type: agent, id: <agent.id> }` with every proposed body standing beside the policies in force and the proposal's tools registered. Once the agent is bound, the bound service principal holds exactly those policies. Rev 18: for a proposal without `agent`, the simulation is as `{ type: role, id: everyone }`, the baseline every caller holds. A simulation as `everyone` or as the agent does not show what a `role` row does, since neither holds the role: `loosening` and `ineffective` report the `role` rows. */
            simulations: {
                tool_ref: string;
                result: components["schemas"]["SimulateResult"];
            }[];
            /** @description One entry for each `baseline` policy of the proposal whose mode is looser than the mode the deployment's own default gives the tool (the mode of the `considered` entry with `source` `default` that a simulation lists when no policy of the kind matched; for a tool this proposal registers, the mode it would have once registered). Rev 18: and one entry, with `subject`, for each `role` row that loosens what a holder of its role gets for the tool: `from` is what tightest-wins composes for the role now, from the published `tool_invocation` policies it holds for the tool (of the role itself, of `everyone` and of the organisation) or, where there are none, the default; `to` is what it composes with the proposal's `baseline` for the tool and the row beside them. So a `role` row loosens only where no published policy the role holds governs the tool. `deny` is tighter than `ask` and `escalate`, which are tighter than `always_allow`. A row that keeps or tightens what it is compared with has no entry, so an empty list says that approving loosens nothing for any caller. A `tightening` never loosens: opening refuses one looser than what the agent gets without it (`tightening_looser`). */
            loosening: {
                tool_ref: string;
                from: components["schemas"]["PolicyMode"];
                to: components["schemas"]["PolicyMode"];
                /** @description Rev 18: the subject of the `role` row the entry is for, `{ type: role, id: <key> }`. Absent on the entry of a `baseline`, which is for every caller. */
                subject?: components["schemas"]["PolicySubject"];
            }[];
            /** @description Rev 18: one entry for each reference of the proposal's `tool_grants`, in that order: the tools whose grant approving records for the service principal in `agent.principal_id`. Absent or empty when the proposal carries no `tool_grants`. */
            grants?: {
                tool_ref: string;
            }[];
            /** @description Rev 18: one entry for each `role` row of the proposal whose mode is looser than the tightest mode a `tool_invocation` policy of the role `everyone` gives the same tool, counting the published policies and the proposal's own `baseline` rows. Under tightest-wins such a row changes nothing for the role while that policy of `everyone` stands. It is reported to the approver and refuses nothing. Absent or empty means no row of the proposal is shadowed this way. */
            ineffective?: {
                tool_ref: string;
                subject: components["schemas"]["PolicySubject"];
            }[];
        };
        /** @description One input of an `ApprovalAction` (rev 15): a value the person may give when they take the action. The input named `reason` fills `ResolveRequest.reason`; any other name is a member of `ResolveRequest.input`. */
        ApprovalActionInput: {
            name: string;
            /** @description How the input is entered. Open-ended: the documented value is `text`, and a client does not offer an action that has an input of a type it does not know. */
            type: string;
            /** @description The deployment's wording for the input. */
            label: string;
            /** @description Whether the action is refused without a value for this input. */
            required: boolean;
            /** @description The most characters the deployment accepts for a `text` input. */
            max_length?: number;
        };
        /** @description One thing a reader may do on one approval (rev 15), typed, with the deployment's own wording and the inputs it takes. Listed in `Approval.available_actions`. Being listed is not authorisation: resolving still decides eligibility when it is called. */
        ApprovalAction: {
            /** @description Names the action; unique within the list. */
            id: string;
            /** @description What the action does. Open-ended: the documented value is `resolve`, and a client ignores an action whose kind it does not know. */
            kind: string;
            /** @description The resolution the action sends to `POST /v1/approvals/{id}/resolve`. Present exactly when `kind` is `resolve`. */
            resolution?: components["schemas"]["ResolveResolution"];
            /** @description The deployment's wording for the action, for example the wording of a denial. */
            label: string;
            /** @description The inputs the action takes, possibly none. */
            inputs: components["schemas"]["ApprovalActionInput"][];
        };
        /** @description The proposer's own account (rev 14) of what a policy's tool can do, for the administrator who decides. The deployment stores it with the approval and enforces nothing from it. */
        PolicySetAssessment: {
            side_effect_level: components["schemas"]["SideEffectLevel"];
            /** @enum {string} */
            blast_radius: "one_record" | "many_records" | "org_wide";
            reversible: boolean;
            /** @description Whether the tool acts on, or sends something to, a party outside the organisation. */
            external_party: boolean;
            financial: boolean;
        };
        /** @description One policy of a `PolicySetProposal` (rev 14), with the reasons the proposer gives for it. */
        PolicySetEntry: {
            /**
             * @description `baseline`: the organisation's policy for the tool, which every caller holds (`everyone`). `tightening`: a policy of the agent alone, which only tightens what the baseline and the other policies in force give the agent. `role` (rev 18): a policy for one role of the organisation, which every holder of the role holds beside the baseline. A deployment lists the kinds of row it accepts in `Capabilities.proposals.row_kinds`.
             * @enum {string}
             */
            role: "baseline" | "tightening" | "role";
            rationale: string;
            assessment: components["schemas"]["PolicySetAssessment"];
            policy: components["schemas"]["PolicyWrite"];
        };
        /**
         * @description The arguments of `tool:noblecloak:propose-policy-set` (rev 14): an agent's tools, its binding to a service principal and the policies that govern it, proposed together and applied together (see Deployment-applied proposals). Rev 18: also policies for roles of the organisation and tool grants for the agent's service principal; without `agent`, policies of the organisation alone. The schema is closed. The whole `action.arguments` fits `limits.approval_arguments_max_bytes` where the deployment advertises one; the two caps of 50 keep a typical proposal well inside the 32 KiB that a deployment commonly sets, and an agent that needs more is proposed in several sets.
         *     **Rules beyond the schema.** A `baseline` is a `tool_invocation` policy with exactly one subject, `{ type: role, id: everyone }`, and `targets.tools` a list of exactly one `tool_ref`. A `tightening` is a `tool_invocation` policy with exactly one subject, `{ type: agent, id: <agent.id> }`, and `targets.tools` a list of exactly one `tool_ref`. A `role` row (rev 18) is a `tool_invocation` policy with exactly one subject, `{ type: role, id: <key> }`, where the key is a bare role key of the organisation as `PolicySubject` describes it, not empty and with no whitespace before or after it, and never `everyone` (in any case, compared after Unicode NFKC normalisation, or in a form that ends in `:everyone` or `/everyone`: a policy of `everyone` is a `baseline`), and `targets.tools` a list of exactly one `tool_ref`. Rev 18: without `agent`, the proposal has no `tightening` (`member` `action.arguments.policies[<i>].role`) and no `tool_grants` (`member` `action.arguments.tool_grants`). `tool_grants` is present only when `agent.principal_id` is (`member` `action.arguments.tool_grants`), and none of its references is in the namespace `tool:noblecloak:` or is a `tool_ref` of this proposal's own `tools` (`member` `action.arguments.tool_grants[<i>]`): a grant names a tool the organisation already holds. A deployment that does not list `role` in `Capabilities.proposals.row_kinds` refuses a `role` row (`member` `action.arguments.policies[<i>].role`), and one that does not list `tool_grants` in `Capabilities.proposals.members` refuses the member (`member` `action.arguments.tool_grants`). No two entries of `tools` have the same `tool_ref`. No two entries of `policies` have the same target tool and subject. No policy targets a reference in the namespace `tool:noblecloak:`. A proposed policy's `config` carries `mode` only: any other member (`approver_groups`, `expires_after`, `on_deny`, or any other) and any `origin` is not proposed. The approver does see the arguments, but what the checks at open (loosening and tightening) and the preview compare is the mode alone, so a change to the routing, the expiry or `on_deny` would get no check and no preview line. A proposal that breaks one of these is refused with `code` `shape` and, where it has a part to name, that part as `member` (for example `action.arguments.policies[1].policy.config.approver_groups`).
         *     **Refusals at open (422 `proposal_refused`, rev 14).** `code` is one of: `not_a_user` (the caller is not a user, a service principal or an agent; only a person proposes); `shape` (the body breaks the schema or a rule above, or `agent.principal_id` names no service principal of the organisation; `member` names the part); `unknown_agent` (`agent.id` is no agent of the organisation; `member` `action.arguments.agent.id`); `principal_bound` (`agent.principal_id` is bound to another agent; `member` `action.arguments.agent.principal_id`); `tool_ref_in_use` (a tool of the proposal collides with a tool of the organisation, or with one the deployment dispatches another way; `member` `action.arguments.tools[<i>].tool_ref`); `target_unknown` (a policy targets a tool that is neither registered nor in this proposal's `tools`; `member` `action.arguments.policies[<i>].policy.targets.tools[0]`); `baseline_exists` (a published policy of the role `everyone` already governs the tool, so a baseline would loosen or replace it without anyone choosing to: propose a tightening instead; `member` `action.arguments.policies[<i>]`); `tightening_looser` (the tightening gives the agent a looser mode than the policies in force and the proposal's baselines compose to for that tool; `member` `action.arguments.policies[<i>]`); rev 18, `target_unknown` also for a reference of `tool_grants` that is no tool of the organisation, or one that is withdrawn (`member` `action.arguments.tool_grants[<i>]`); rev 18, `not_entitled` (the organisation is not entitled to policies with a role subject, the entitlement `policies.role_subjects` of `Capabilities.entitlements`; `member` names the first `role` row, `action.arguments.policies[<i>]`, and `detail` names the entitlement). No check compares a `role` row with the baseline: a role may be given a looser mode than `everyone` or a tighter one, and the preview lists, in `ineffective`, a `role` row that a tighter policy of `everyone` shadows. When several apply, which one is reported is the deployment's choice. Opening applies nothing and stores nothing but the approval and its preview.
         *     **A tightening for an agent that already has a policy for the tool.** No check at open refuses a tightening because a published `tool_invocation` policy of the same agent already governs its tool, by name or by `all`. Such a proposal may open when no other check refuses it, but approving it never applies it: it is refused with `proposal_refused:policy_conflict` (or another code, when a check run again refuses it first), because at most one published policy governs a (tool, subject) pair. Such a tightening is made by changing that policy, or by retiring it before the proposal is approved.
         *     **Entitlement at approval (rev 18).** Approving checks the entitlement again: a proposal with a `role` row that is approved when the organisation is no longer entitled to policies with a role subject applies nothing, and the approval resolves `rejected` with the reason `proposal_refused:not_entitled`.
         *     **Tool grants (rev 18).** A grant is a change the deployment makes, as the binding is: on approval the deployment records that the service principal in `agent.principal_id` may list and call each tool of `tool_grants`, where the deployment limits a service principal's tools to those granted to it. The visibility rule of `GET /v1/tools` (`Owner`) is unchanged, and what a grant does beyond that is the deployment's. A grant that already exists is kept as it is. A deployment lists `tool_grants` in `Capabilities.proposals.members` only when it applies grants.
         */
        PolicySetProposal: {
            /** @description The agent the proposal is for, a row of `/v1/agents` of the organisation. `principal_id`, when present, is a service principal of the organisation to bind to the agent on approval, as `PUT /v1/agents/{id}/principal` binds it; absent, the agent's binding is left as it is. Rev 18: optional; a proposal without it carries only `baseline` and `role` rows and, optionally, `tools`. */
            agent?: {
                id: string;
                principal_id?: string;
            };
            /** @description Tools to register on approval, as `POST /v1/tools` registers them, each owned by the organisation (`owner_kind: org`) and with a `tool_ref` that starts `ext:`. */
            tools?: (components["schemas"]["ToolWrite"] & {
                tool_ref?: string;
                /** @constant */
                owner_kind: "org";
            })[];
            policies: components["schemas"]["PolicySetEntry"][];
            /** @description Rev 18: the `tool_ref`s of tools the organisation already holds, to grant to the service principal in `agent.principal_id` on approval (see Tool grants above). */
            tool_grants?: string[];
        };
        /**
         * @description What a caller may resolve an approval as. Closed: any other value, including one this API may return in a response, is 400 `invalid_request`.
         * @enum {string}
         */
        ResolveResolution: "approved" | "rejected" | "escalated";
        ResolveRequest: {
            resolution: components["schemas"]["ResolveResolution"];
            reason?: string;
            /** @description Typed human input. Opaque in v1. */
            input?: {
                [key: string]: unknown;
            };
            /** @description The digest the approver saw. A mismatch is 409 `approval_conflict`. */
            expected_action_digest: components["schemas"]["Digest"];
        };
        /** @description One element of a batch: the body of `POST /v1/approvals/{id}/resolve` and the id of the approval it names. `expected_action_digest` is required, as it is there: an approver resolves the call they saw. */
        ResolveBatchItem: {
            approval_id: string;
            resolution: components["schemas"]["ResolveResolution"];
            reason?: string;
            /** @description Typed human input. Opaque in v1. */
            input?: {
                [key: string]: unknown;
            };
            /** @description The digest the approver saw. A mismatch is 409 `approval_conflict` for this element. */
            expected_action_digest: components["schemas"]["Digest"];
        };
        ResolveBatchRequest: {
            items: components["schemas"]["ResolveBatchItem"][];
        };
        /** @description The outcome of one element: the `Approval` after resolution, or a problem document. A problem has `type` and no `id`; an approval has `id` and no `type`. */
        ResolveBatchResult: components["schemas"]["Approval"] | components["schemas"]["Problem"];
        AliasResolveRequest: {
            reason?: string;
            expected_action_digest: components["schemas"]["Digest"];
        };
        /** @description The signed statement that an approval resolved. `signature` is a JWS compact serialization (ES256, `kid` in the header) whose payload is the JCS form of this object without `signature`. The payload carries `tool_ref` and `obligation_kind` because a digest binds the arguments but not the tool. `policy` is optional: absent means no explicit policy matched and the default applied; it is never synthesised and never null, and when present its `id` and `version` are required. */
        Resumption: {
            approval_id: string;
            /** @description An opaque server id for the action. */
            action_id: string;
            tool_ref: string;
            obligation_kind: components["schemas"]["ObligationKind"];
            resolution: components["schemas"]["Resolution"];
            action_digest: components["schemas"]["Digest"];
            approver: components["schemas"]["PrincipalRef"];
            resolved_at: components["schemas"]["Timestamp"];
            expires_at: components["schemas"]["Timestamp"];
            policy?: components["schemas"]["PolicyRef"];
            /** @description Present if and only if the caller consumes through `/consume`. Never given to an approving browser. */
            resume_token?: string;
            /** @description The continuation the approval was opened with, echoed as the same JSON value, not the same bytes: member order and insignificant whitespace are not preserved and carry no meaning. The signature covers the JCS form of the object, which does not depend on member order. */
            continuation: components["schemas"]["Continuation"];
            /** @description The JWS compact serialization. */
            signature: string;
        };
        ConsumeRequest: {
            resume_token: string;
            /** @description The action as the runtime is about to run it. */
            action: components["schemas"]["Action"];
        };
        ConsumeResult: {
            approval_id: string;
            /** @constant */
            state: "consumed";
            consumed_at: components["schemas"]["Timestamp"];
            tool_ref: string;
            action_digest: components["schemas"]["Digest"];
        };
        ContinuationTestRequest: {
            continuation: components["schemas"]["Continuation"];
        };
        ContinuationTestResult: {
            valid: boolean;
            /** @description Set for `push`, after a signed challenge. */
            reachable?: boolean | null;
            problems?: {
                field: string;
                message: string;
            }[];
        };
        RecordOutcome: {
            /** @enum {string} */
            status: "succeeded" | "failed" | "unknown";
            summary?: string;
            error?: string;
        };
        /** @description One appended record. Linkage is by reference (`approval_id`, `GET /v1/records/{id}/chain`), not a hash chain. Field names are TRACE-shaped. A deployment derives any further per-record fields itself (the caller never supplies them), and there is no second record shape. `context` is optional; a deployment that needs the channel and does not receive it rejects the record with 400, it never defaults it. */
        Record: {
            id: string;
            ts: components["schemas"]["Timestamp"];
            actor: components["schemas"]["PrincipalRef"];
            tool_ref: string;
            /** @description The policy that matched. Absent when no policy matched explicitly and the default applied, as on the decision object; when present, `id` and `version` are both required and never null. */
            policy?: components["schemas"]["PolicyRef"];
            decision: components["schemas"]["DecisionValue"];
            approval_id?: string;
            /** @description Whether the deployment linked this record to the approval named by `approval_id`. Present on the 201 of `POST /v1/records` (and of each element of `POST /v1/records/batch`) only when the request carried `approval_id`; absent on a read and on a record appended without one. The record is appended whether or not the link was made: a refused link is not an error and the status is 201 either way. */
            approval_link?: components["schemas"]["ApprovalLink"];
            outcome?: components["schemas"]["RecordOutcome"];
            prompt_id?: string;
            /** @description The context the caller supplied when it appended the record. Absent when none was supplied. */
            context?: components["schemas"]["RecordContext"];
            /** @description `false` means the decision was observed, not enforced, as on the decision object. Echoed as supplied; absent means `true`. */
            enforced?: boolean;
            /** @description Present when the caller could not obtain a decision and applied a fallback: `decision` is that fallback and `policy` is absent. Absent, not null, on every other record. A reader tolerates a `reason` it does not know. A deployment returns the members `Degraded` defines (`reason`, `status`, `request_id`) and no others at v1, so one schema serves the request and the response. */
            degraded?: components["schemas"]["Degraded"];
            /**
             * @description Derived by the server. Every record appended through `/v1` is `asserted`. `observed` is a valid value on a read, reserved for records the platform captured itself.
             * @enum {string}
             */
            attestation: "observed" | "asserted";
        };
        /** @description The outcome of linking a record to the approval its `approval_id` names. `linked: true`: the record is now the approval's outcome record (`Approval.outcome_record_id`). `linked: false`: the record was appended and the approval was left as it was, and `reason` says why: `not_consumed` (the approval has not been consumed, so there is no outcome to attach), `already_linked` (the approval already has an outcome record; the first link stands) or `not_found` (the caller did not create the approval, or there is none it may link to; the two are not told apart). A reader tolerates a `reason` it does not know. `reason` is absent when `linked` is `true`. */
        ApprovalLink: {
            linked: boolean;
            /** @enum {string} */
            reason?: "not_consumed" | "already_linked" | "not_found";
        };
        /** @description Why a call went ahead without a decision from the deployment. `reason` is a code, never free text: the pattern admits no dot, colon, slash or space, so a hostname, a URL or a stack trace cannot be sent by mistake. The documented values are `timeout`, `unreachable`, `http_error`, `no_token` and `internal_error`; a deployment accepts any other value that matches the pattern, and a reader tolerates one it does not know. `status` is the HTTP status the deployment answered with and `request_id` the request id of that failed response; each is present only when the deployment answered. A record that carries `degraded` is `asserted`, like every record appended through `/v1`. */
        Degraded: {
            /**
             * @example timeout
             * @example unreachable
             * @example http_error
             * @example no_token
             * @example internal_error
             */
            reason: string;
            status?: number;
            request_id?: string;
        };
        RecordCreate: {
            tool_ref: string;
            actor?: components["schemas"]["ActorHint"];
            /** @description The policy that matched. Omit it when no policy matched explicitly and the default applied; when present, `id` and `version` are both required. */
            policy?: components["schemas"]["PolicyRef"];
            decision: components["schemas"]["DecisionValue"];
            /** @description Links the outcome to the approval it followed. */
            approval_id?: string;
            outcome?: components["schemas"]["RecordOutcome"];
            prompt_id?: string;
            /** @description The invocation channel, the same enum and meaning as `context.invocation_channel` on the `/decisions` request; `call_id` and `group_id` are not accepted. `tool_use_id`, `source` and `side_effect_level` are deliberately not accepted: a deployment derives them, and a caller can never lower a level. */
            context?: components["schemas"]["RecordContext"];
            /** @description `true` when absent. `false` means the decision was observed, not enforced, as on the decision object. On a degraded record it says whether the caller enforced the fallback. */
            enforced?: boolean;
            /** @description Set when the caller could not obtain a decision and went on under a fallback. `decision` is then the fallback the caller applied, `policy` must be absent (400 `invalid_request` otherwise), and `enforced` says whether the caller enforced that fallback. `side_effect_level` and everything else the deployment derives stay server-side. */
            degraded?: components["schemas"]["Degraded"];
        };
        RecordBatchRequest: {
            records: components["schemas"]["RecordCreate"][];
        };
        /** @description An AGT audit event, mapped to a record. */
        AgtEvent: {
            event_type: string;
            agent_id: string;
            tool_name: string;
            timestamp: components["schemas"]["Timestamp"];
            decision?: string;
            result?: string;
        } & {
            [key: string]: unknown;
        };
        ChainLink: {
            id: string | null;
            /** @description Why the link is null. */
            reason: string | null;
        };
        RecordChain: {
            prompt: components["schemas"]["ChainLink"];
            action: components["schemas"]["ChainLink"];
            decision: components["schemas"]["ChainLink"];
            approval: components["schemas"]["ChainLink"];
            outcome: components["schemas"]["ChainLink"];
        };
        Checkpoint: {
            id: string;
            created_at: components["schemas"]["Timestamp"];
            record_count: number;
        };
        Verification: {
            verified: boolean;
            checkpoint_id?: string;
            checked_at: components["schemas"]["Timestamp"];
        };
        EvidenceExport: {
            id: string;
            /** @enum {string} */
            state: "pending" | "ready" | "failed";
            created_at: components["schemas"]["Timestamp"];
        };
        /** @enum {string} */
        PolicySource: "authored" | "suggested" | "imported";
        /** @enum {string} */
        PolicyFormat: "agt" | "cedar";
        /** @description What a policy governs (rev 10). Open-ended: the documented kinds are `tool_invocation` (whether a call to a tool is allowed, asked or denied), `spending` (provisional) and `duplicate_requests` (what happens to an identical call after a resolver rejected it) and, since rev 16, `approval_routing` (the organisation's setting for who may satisfy an approval's requirements, see `ApprovalRoutingConfig`). A client treats a kind it does not know as a policy it cannot evaluate, never as a decision, and treats that policy's `config` as opaque. Known values: tool_invocation | spending | duplicate_requests | approval_routing. */
        PolicyKind: string;
        /**
         * @description `draft`: written and never published, or written after the last publish (then the policy's published version is still the one in force). `published`: the version in force.
         * @enum {string}
         */
        PolicyState: "draft" | "published";
        /**
         * @description The mode of a `tool_invocation` policy. `always_allow` maps to `allow`; `ask` and `escalate` to `step_up`; `deny` to `deny`. `not_granted` (rev 10): the subject holds no grant; maps to `deny` (reason `not_granted`). `not_granted` is provisional: no deployment implements it yet, and a deployment that does not implement it refuses a policy that sets it with 422 `unsupported_policy_form`.
         * @enum {string}
         */
        PolicyMode: "always_allow" | "ask" | "escalate" | "deny" | "not_granted";
        /**
         * @description The configuration of a `tool_invocation` policy. Legality matrix: `on_deny`, `expires_after` and `approver_groups` apply only to `ask` and `escalate`; they are illegal with `always_allow`, `deny` and `not_granted`. Rev 16: `rules`, `approvers` and `exclude` are legal with every mode (a `deny` policy may carry an `always_allow` rule, which is still composed tightest-wins with every other policy that matched). `approvers` and `exclude` on a policy none of whose outcomes asks are legal and do nothing.
         *
         *     Evaluation of one policy for one call (rev 16). The facts of the call are read from its `action.arguments` through the fact bindings of the tool (`Tool.facts`); a call that sends only `arg_digest` has no facts. Walk `rules` in order:
         *
         *     - A condition is true, false or unevaluable. It is unevaluable when the fact it names has no value: the tool declares no such fact, the call carries no arguments, the binding's path selects nothing, or the value there does not have the binding's type. `exists` is never unevaluable: a fact with no value does not exist.
         *     - A rule with a false condition is skipped, whatever its other conditions.
         *     - Otherwise a rule with an unevaluable condition stops the walk: the policy's result is `ask`, and the facts with no value are its `missing_facts`. The requirement it contributes takes that rule's `approvers` when the rule's `then` is `ask` and it has them, and otherwise has no approver entries (the organisation's administrators): never the policy's `approvers`, since the facts that would have chosen them are missing.
         *     - Otherwise every condition is true and the rule matches: its `then` is the policy's result, and the walk stops (the first matching rule wins).
         *     - When no rule matches, the result is `mode`.
         *
         *     The results of every policy that matched the call compose tightest-wins, as the feature `policies.tightest_wins` states. Each policy whose result asks and that contributed to a composed step-up contributes one requirement to the approval (see `ApprovalRequirement`). A deployment that does not list the feature `policies.rules` refuses `rules`, and one that does not list `approvals.requirements` refuses `approvers`, `exclude` and the `approvers` of a rule, each with 422 `unsupported_policy_form` naming the member, as it refuses any member its `policy_forms` does not list. A condition (of a rule or of an approver) that names a fact one of the targeted tools does not declare, or compares (`gt`, `gte`, `lt`, `lte`) a fact that one of them declares as neither `number` nor `count`, is 400 `invalid_request` naming the condition's `fact` in `member` (for example `config.rules[0].when[1].fact`) when every target names a tool the organisation has registered; with `targets: all`, or a target that names no tool yet, it is accepted and is unevaluable where it does not fit.
         */
        ToolInvocationConfig: {
            /** @description The outcome when no rule matches; with no `rules`, the outcome. Required. */
            mode: components["schemas"]["PolicyMode"];
            /** @enum {string} */
            on_deny?: "resume" | "halt";
            /** @description An ISO 8601 duration, for example PT1H. */
            expires_after?: string;
            /** @description Together these groups form one approval requirement, satisfied by any eligible member of any listed group (rev 11, D-A90): each approval-requiring policy that matches a call contributes one requirement, and every requirement must be met. The schema may grow per ADR-0049 §6c.4. */
            approver_groups?: string[];
            /** @description Rev 16: rules over the facts of the call, evaluated in order; the first that matches gives the policy's result, and `mode` applies when none does (see the evaluation above). Served under the feature `policies.rules`. */
            rules?: components["schemas"]["PolicyRule"][];
            /** @description Rev 16: who may satisfy the requirement this policy contributes when its result asks: `mode` asks and no rule matched, or a rule whose `then` is `ask` matched and carries no `approvers` of its own. Not when a fact with no value stopped the walk (see the evaluation above). Each entry is a role or a user, and is in force for a call only while its own `when` holds. The deployment enforces it, unlike `approver_groups`, which it leaves as it was. Served under the feature `approvals.requirements`. */
            approvers?: components["schemas"]["PolicyApprover"][];
            /** @description Rev 16: who may never satisfy this policy's requirement, whatever else makes them eligible. `requester`: the principal that opened the approval, including from the approver surface and as an organisation administrator under break-glass. Served under the feature `approvals.requirements`. */
            exclude?: "requester"[];
        };
        /** @description Rev 16: the name of a fact a tool declares (`Tool.facts`) and a condition names (`PolicyCondition.fact`). */
        FactName: string;
        /** @description Rev 16: how one fact of a call is read from the call's arguments. The value at `path` must have the JSON type `type` names: `number` a JSON number, `string` a string, `boolean` true or false, `count` an array, whose length is the fact's value. Nothing is coerced (`"42"` is not a number). A path that selects nothing, or a value of another type, leaves the fact with no value, and a condition that needs it is unevaluable (see `ToolInvocationConfig`). Facts are read by the deployment from the arguments of the call it decides; a client never asserts a fact. */
        FactBinding: {
            /** @description Where the value is, from the root of the arguments: one or more segments, each `.key` (a member; `key` starts with a letter or `_` and holds letters, digits, `_` and `-`) or `[N]` (the element at the non-negative index `N` of an array). For example `.amount`, `.target.env`, `.lines[0].price`. A wildcard (`[*]`) or a recursive descent (`..key`) selects a set, not one value, and is refused with 400 `invalid_request` naming the binding in `member`. */
            path: string;
            /** @enum {string} */
            type: "number" | "string" | "boolean" | "count";
            description?: string;
        };
        /** @description Rev 16: the facts a tool declares, by name: at most 32. A policy's conditions name them (see `ToolInvocationConfig`). Served under the feature `tools.facts`; a deployment that does not list it refuses a write that carries `facts` with 422 `unsupported_policy_form` naming `facts`. */
        ToolFacts: {
            [key: string]: components["schemas"]["FactBinding"];
        };
        /** @description Rev 16: one test of a fact of the call. `eq`, `ne`: `value` is a JSON scalar, compared for equality with the fact's value (a value of another JSON type is not equal). `in`, `not_in`: `value` is a list of 1 to 100 scalars, and the test is whether the fact's value equals one of them. `gt`, `gte`, `lt`, `lte`: `value` is a number, and the fact must be a `number` or a `count`. `exists`: no `value`; true when the fact has a value. A condition whose fact has no value is unevaluable, except under `exists`, where it is false. */
        PolicyCondition: {
            fact: components["schemas"]["FactName"];
            /** @enum {string} */
            op: "eq" | "ne" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "exists";
            /** @description What the fact is tested against; its form depends on `op` (see above). */
            value?: unknown;
        } & (unknown & unknown & unknown & unknown);
        /** @description Rev 16: one to eight conditions, all of which must hold (they are ANDed). An alternative is a separate rule. */
        PolicyConditions: components["schemas"]["PolicyCondition"][];
        /** @description Rev 16: when every condition of `when` holds, the policy's result is `then` (see the evaluation in `ToolInvocationConfig`). `approvers` is legal only with `then: ask`, and then replaces the policy's `approvers` for the requirement this rule's outcome contributes, and for the one the policy contributes when a fact with no value stops the walk at this rule. */
        PolicyRule: {
            when: components["schemas"]["PolicyConditions"];
            /** @enum {string} */
            then: "always_allow" | "ask" | "deny";
            approvers?: components["schemas"]["PolicyApprover"][];
        };
        /** @description Rev 16: one entry of who may satisfy a requirement: every holder of a role (`role`, its bare key, as a role subject's id) or one user (`user`, the principal id). With `when`, the entry is in force for a call only when every condition holds; a condition that is false or unevaluable leaves it out. */
        PolicyApprover: {
            role: string;
            when?: components["schemas"]["PolicyConditions"];
        } | {
            user: string;
            when?: components["schemas"]["PolicyConditions"];
        };
        /** @description Rev 16: an approver entry of a requirement, as it was in force when the approval was opened: a role by its bare key, or a user by principal id. */
        ApproverRef: {
            role: string;
        } | {
            user: string;
        };
        /** @description The configuration of an `approval_routing` policy (rev 16): the organisation's setting for who may satisfy the requirements of its approvals. A policy of this kind takes the organisation subject only and targets every tool; any other subject or target form is 422 `unsupported_policy_form`. The organisation's setting is its most recently published `approval_routing` policy, in force from the answer of its publish; with none, `org_admin_break_glass` is `true`. Served under the feature `approvals.requirements`, and listed in `policy_forms` as `approval_routing`. */
        ApprovalRoutingConfig: {
            /** @description `true`: an administrator of the organisation may satisfy every unmet requirement of an approval in one approve (`basis: break_glass`), except a requirement whose `exclude` excludes them. `false`: an administrator satisfies only the requirements that list them, and those with no approver entries in force. */
            org_admin_break_glass: boolean;
        };
        SpendingConfig: {
            limit: {
                amount: number;
                currency: string;
            };
        };
        /** @description The configuration of a `duplicate_requests` policy (rev 10): what happens to an identical call after a resolver rejected it (see Terminal states free the identity). Legality matrix: `max_reasks` applies only to `ask_again`; it is illegal with `deny`. A policy of this kind takes the organisation subject only and targets every tool; any other subject or target form is 422 `unsupported_policy_form`. The organisation's setting is its most recently published `duplicate_requests` policy, in force from the answer of its publish; with none, the deployment's default is `after_rejection: deny` with a window of 86 400 seconds (24 hours). */
        DuplicateRequestsConfig: {
            /**
             * @description `deny`: an identical call within the window of a rejection is answered `deny` with reason `rejected_duplicate` and opens nothing. `ask_again`: it opens a fresh approval carrying `prior_rejections`, until the count of rejections exceeds `max_reasks`.
             * @enum {string}
             */
            after_rejection: "deny" | "ask_again";
            /**
             * @description How long after a rejection the rule applies, in seconds: a rejection counts while its `resolved_at` lies within this many seconds of the call. Absent means 86 400 (24 hours).
             * @default 86400
             */
            window_seconds: number;
            /** @description Only with `ask_again`: how many resolver rejections of an identical call are each followed by a re-ask. With the count being the resolver's rejections of the identity within the window since its last consumed approval, a call whose count exceeds `max_reasks` is answered as under `deny` (`max_reasks: 1`: after the first rejection the call is asked again, after the second it is denied). It bounds rejections, not re-asks: a re-ask that is withdrawn or expires is not a rejection and does not count. Absent means no limit. */
            max_reasks?: number;
        };
        /** @description The configuration of a policy, by its kind (rev 10): `ToolInvocationConfig` for `tool_invocation`, `SpendingConfig` for `spending`, `DuplicateRequestsConfig` for `duplicate_requests` and (rev 16) `ApprovalRoutingConfig` for `approval_routing`. The schema accepts any of them; that a configuration fits its policy's `kind` is checked by the server, which answers a write whose `config` does not fit 400 `invalid_request`. A client treats the `config` of a kind it does not know as opaque. */
        PolicyConfig: components["schemas"]["ToolInvocationConfig"] | components["schemas"]["SpendingConfig"] | components["schemas"]["DuplicateRequestsConfig"] | components["schemas"]["ApprovalRoutingConfig"];
        /**
         * @description The type of a policy subject (rev 10): a principal kind, or `organization`.
         * @enum {string}
         */
        PolicySubjectType: "user" | "agent" | "service" | "group" | "role" | "organization";
        /** @description Who a policy applies to: a principal by kind and id, or (rev 10) the organisation itself, `{ type: organization }`, with no id (it is the token's organisation). A role subject's id is the bare role key (for example `member`, or the reserved role `everyone` (rev 13), which every caller holds); a deployment maps it to its own form. Tools are never subjects: a policy names the tools it governs in `targets`. */
        PolicySubject: {
            type: components["schemas"]["PrincipalKind"];
            id: string;
        } | {
            /** @constant */
            type: "organization";
        };
        /** @description The tools a policy governs (rev 10): `{ tools: all }`, every tool, or `{ tools: [<tool_ref>, ...] }`. On a write, an absent `targets` means every tool; a server that implements rev 10 always returns `targets` on a read. A `tool_ref` is a deployment-assigned stable reference (rev 11): clients compare it for equality and never parse it, and a deployment keeps it stable while the tool's server identity is unchanged, across disconnect and reconnect. */
        PolicyTargets: {
            tools: "all" | string[];
        };
        PolicyWrite: {
            kind: components["schemas"]["PolicyKind"];
            /** @description Absent on create, the deployment derives one. */
            name?: string;
            description?: string;
            subjects: components["schemas"]["PolicySubject"][];
            /** @description Absent means every tool. */
            targets?: components["schemas"]["PolicyTargets"];
            config: components["schemas"]["PolicyConfig"];
            /** @description Where this version comes from, when it was imported (rev 11). A create that carries it makes a policy whose `source` is `imported`. `source` is fixed at create, so a later write with or without `origin` never changes it; `origin` describes the version it was written with. */
            origin?: components["schemas"]["PolicyOrigin"];
        };
        /** @description Where an imported policy version came from (rev 11): the format of the file it was imported from, and the lowercase hex SHA-256 of that file's bytes as imported. */
        PolicyOrigin: {
            format: components["schemas"]["PolicyFormat"];
            digest: components["schemas"]["Digest"];
        };
        /** @description A policy at one version. The members rev 10 adds (`name`, `description`, `state`, `targets`, `unenforced_targets`, `updated_at`, `updated_by`) are optional on the wire, so a server of an earlier revision omits them; a server that implements rev 10 returns `name`, `state` and `targets` on every read. The members rev 11 adds (`draft_version`, `retired_at`, `origin`) are optional and read only. */
        Policy: {
            id: string;
            version: number;
            source: components["schemas"]["PolicySource"];
            kind: components["schemas"]["PolicyKind"];
            name?: string;
            description?: string;
            state?: components["schemas"]["PolicyState"];
            subjects: components["schemas"]["PolicySubject"][];
            targets?: components["schemas"]["PolicyTargets"];
            /** @description Read only. The `tool_ref`s of `targets` this deployment cannot currently enforce the policy on: the tool was removed, or another tool now answers to the reference. Absent or empty when it enforces every target; never left out silently when it does not. */
            unenforced_targets?: string[];
            config: components["schemas"]["PolicyConfig"];
            /** Format: date-time */
            published_at?: string | null;
            updated_at?: components["schemas"]["Timestamp"];
            /** @description Who wrote this version, by id and kind (a policy carries no names). */
            updated_by?: components["schemas"]["PrincipalRef"];
            /** @description Read only (rev 11). On a published policy, the version of its pending draft (the draft a replace wrote after the last publish); absent when there is none, and on a policy that was never published, whose read is the draft itself. A row of `GET /v1/policies` carries it as the read does. */
            readonly draft_version?: number;
            /** @description Read only (rev 11): when the policy was retired (`POST /v1/policies/{id}/retire`). Present on the versions of a retired policy, which `GET /v1/policies/{id}/versions` keeps listing; a retired policy is neither read nor listed otherwise. */
            readonly retired_at?: components["schemas"]["Timestamp"];
            /** @description Read only (rev 11): where this version was imported from, as its write stated it (`PolicyWrite.origin`); absent on a version written without one. */
            readonly origin?: components["schemas"]["PolicyOrigin"];
        };
        SimulateRequest: {
            draft_version?: number;
            actor?: components["schemas"]["ActorHint"];
            action: components["schemas"]["Action"];
            resource?: components["schemas"]["Resource"];
            context?: components["schemas"]["DecisionContext"];
            /** @description Simulate for a hypothetical holder of exactly this subject (rev 11; see `POST /v1/policies/{id}/simulate`). Administrators only. The caller remains the token's principal. */
            subject?: components["schemas"]["PolicySubject"];
        };
        /** @description The body of `POST /v1/policies/simulate` (rev 13): proposed policy bodies and the call to decide. A proposed body's members that are meaningful only to a stored policy (`name`, `description`, `origin`) are accepted and ignored. */
        SimulateSetRequest: {
            /** @description The proposed bodies. They stand beside the policies in force and never replace one. */
            policies: components["schemas"]["PolicyWrite"][];
            actor?: components["schemas"]["ActorHint"];
            action: components["schemas"]["Action"];
            resource?: components["schemas"]["Resource"];
            context?: components["schemas"]["DecisionContext"];
            /** @description Simulate for a hypothetical holder of exactly this subject, as on `POST /v1/policies/{id}/simulate`. Administrators only. The caller remains the token's principal. */
            subject?: components["schemas"]["PolicySubject"];
        };
        /** @description What a simulated decision considered (rev 10): the inputs and the outcome, never an order of precedence or why one entry won. `policies` lists every policy that matched the call, each matched subject included (not only the one that decided), and the deployment's defaults that applied (a default is listed when no policy of its kind matched) as entries whose `id` and `version` are null and whose `source` names the default. `composed` is the decision the entries composed to, the same as the simulated decision. Rev 11 marks the entries that determined it (`contributed`); which rule composed them is the deployment's, stated by the feature `policies.tightest_wins` where it is advertised. */
        ConsideredPolicies: {
            policies: {
                kind: components["schemas"]["PolicyKind"];
                /** @description The policy; null for a default of the deployment, or for a proposed body (rev 13). */
                id: string | null;
                /** @description The version considered (the draft, or the version simulated); null for a default of the deployment, or for a proposed body (rev 13). */
                version: number | null;
                /** @description Rev 13: on an entry that comes from a proposed body of `POST /v1/policies/simulate`, the index of that body in the request's `policies`. A default of the deployment, which also has a null `id` and `version`, carries `source` and never `proposed_index`. */
                proposed_index?: number;
                /** @description What the entry gave: a mode for a `tool_invocation` policy; for a `duplicate_requests` policy `none` (no rejection applies), `deny` or `ask_again`. */
                result: string;
                /** @description The subject of the policy that matched the call. */
                subject?: components["schemas"]["PolicySubject"];
                /** @description Present on a default: which one, for example `default` or `deployment_applied`. It is a value here and never a role: the reserved role is `everyone`. Absent on an entry from a stored policy or a proposed body; an entry is a default or a proposed body, never both. */
                source?: string;
                /** @description Rev 11: true on every entry the deployment used to reach `composed`, and false or absent on one it did not. Under `policies.tightest_wins` it is every entry whose result gives the composed decision: when that is a step-up, every approval-requiring entry, each of which contributes a requirement that must be met. An entry a tighter one overruled (an `always_allow` beside a `deny`) did not contribute. It says which entries determined the outcome, not an order among them. A deployment that does not implement rev 11 omits it. */
                contributed?: boolean;
                /** @description Rev 16: on a `tool_invocation` entry whose result a rule of the policy gave, that rule: its index in the policy's `rules` and its `then`. Absent when no rule matched (the result is the policy's `mode`), when a missing fact stopped the walk (see `missing_facts`), and on a deployment that does not list `policies.rules`. */
                rule?: {
                    index: number;
                    /** @enum {string} */
                    then: "always_allow" | "ask" | "deny";
                };
                /** @description Rev 16: on a `tool_invocation` entry whose rules could not be evaluated, the facts the rule that stopped the walk needed and the call did not supply; the entry's `result` is then `ask`. A simulation whose `action` carries only `arg_digest` supplies no fact. Absent otherwise. */
                missing_facts?: components["schemas"]["FactName"][];
            }[];
            composed: {
                decision: components["schemas"]["DecisionValue"];
                reason?: string;
            };
        };
        /** @description The decision a version of a policy would give (rev 10): the members of `Decision`, with the same rules (`policy` is absent when the default decided, and never null), and `considered`, which a server that implements rev 10 always returns. Nothing was opened or recorded. */
        SimulateResult: {
            decision: components["schemas"]["DecisionValue"];
            /** @description For example `not_granted`, `unknown_tool`, `rejected_duplicate`. */
            reason?: string;
            /** @description The argument digest the server computed for the action as received. */
            action_digest: components["schemas"]["Digest"];
            /** @description The policy that decided; absent when the default applied. Where several policies contributed to the decision (rev 11; see `policies.tightest_wins` on `Capabilities.features`), it names one of the entries that contributed, the deployment's choice: the `considered` of a simulation lists the set. */
            policy?: components["schemas"]["DecisionPolicy"];
            approval?: components["schemas"]["ApprovalHandle"];
            enforced: boolean;
            would_be?: components["schemas"]["DecisionValue"];
            condition?: components["schemas"]["Condition"];
            /** @description Only on a `deny` with reason `rejected_duplicate`, as on `Decision`. */
            rejected_approval_id?: string;
            /** @description Rev 16: only on a `step_up`, as on `Decision`: the facts whose absence stopped the walk of a contributing policy. */
            missing_facts?: components["schemas"]["FactName"][];
            considered?: components["schemas"]["ConsideredPolicies"];
        };
        PolicyImportReport: {
            applied: components["schemas"]["PolicyRef"][];
            unsupported: {
                path: string;
                reason: string;
            }[];
        };
        /** @description Who owns a tool or a connection. A tool or a connection owned by a `principal` is visible to that principal and to administrators only (an administrator is a user, never a service principal; see Who registers tools and `GET /v1/tools`): to anyone else it is 404 `not_found` and absent from lists. One owned by the organisation (`org`) is visible to every principal of the organisation; for a connection (rev 11) that is what lets each member use the registration. Every connection route follows this rule. */
        Owner: {
            /** @enum {string} */
            kind: "principal" | "org";
            id: string;
        };
        /** @description The registration of a tool server. The members rev 11 adds are optional on the wire, so a server of an earlier revision omits them; a server that implements rev 11 returns `status`, `auth_kind` and `credential_tier` on every read. No operation returns a credential: not the organisation credential, and no user's. */
        Connection: {
            id: string;
            name: string;
            /** Format: uri */
            url: string;
            /** @enum {string} */
            transport: "mcp" | "a2a";
            owner: components["schemas"]["Owner"];
            created_at: components["schemas"]["Timestamp"];
            /** @description The state of the registration (rev 11), never a user's credential. `connected`: the registration is in force (for `org_shared`, its organisation credential is too). `pending_authorization`: an `org_shared` registration with `auth_kind: oauth` waiting for an administrator's consent; never used for a `per_user` registration. `degraded`: the deployment's last check of it failed (`status_detail` says how). Open-ended: a client treats a value it does not know as not `connected`. Known values: connected | pending_authorization | degraded. */
            status?: string;
            /**
             * @description Why the registration is `degraded` (rev 11): a code from this closed list, never text from the server. Absent otherwise.
             * @enum {string}
             */
            status_detail?: "unreachable" | "credential_rejected" | "introspection_failed";
            /**
             * Format: date-time
             * @description When the deployment last checked the registration (rev 11); null when it never has.
             */
            last_verified_at?: string | null;
            /**
             * @description How the server authenticates callers (rev 11; `ConnectionWrite.auth`). Never a credential.
             * @enum {string}
             */
            auth_kind?: "none" | "bearer" | "oauth";
            /** @description Whose credential calls through the registration use (rev 11): `org_shared`, one organisation credential an administrator sets; `per_user`, each user's own link. Fixed at create. Open-ended: a client treats a value it does not know as a tier it cannot use. Known values: org_shared | per_user. */
            credential_tier?: string;
            /** @description The caller's own credential link to this registration, and nobody else's (rev 11). Present on every read of a `per_user` registration whose `auth_kind` is not `none`, by a deployment that advertises `connections.user_links`; absent otherwise. Never a credential. */
            my_link?: components["schemas"]["ConnectionLink"];
        };
        /** @description One caller's credential link to a `per_user` registration (rev 11), as that caller reads it. */
        ConnectionLink: {
            /** @description `linked`: the link holds a credential the deployment can use. `pending_authorization`: an OAuth link waiting for the caller to authorize it (`POST /v1/connections/{id}/authorize`). `degraded`: the deployment's last use of it failed. `none`: the caller has no link. Open-ended: a client treats a value it does not know as a link it cannot use. Known values: linked | pending_authorization | degraded | none. */
            status: string;
            /** @description `given`: the caller consents to the use of the link. `revoked`: it no longer does, and the deployment does not use the link (the credential is kept). `none`: there is no link. Open-ended: a client treats a value it does not know as consent not given. Known values: given | revoked | none. */
            consent: string;
            /** @description When the link last came to hold a credential. */
            linked_at?: components["schemas"]["Timestamp"];
        };
        /** @description The caller's link to a `per_user` registration (rev 11): consent, always, and for `auth_kind: bearer` the credential. */
        ConnectionLinkRequest: {
            /**
             * @description The caller's consent to the use of its own link. Required, and only `true`.
             * @constant
             */
            consent: true;
            /** @description For `auth_kind: bearer`: the credential, required on the first link and replacing the stored one when sent again. Never returned. Refused for `auth_kind: oauth`. */
            token?: string;
        };
        ConnectionAuthorizeRequest: {
            /**
             * Format: uri
             * @description Where the browser returns after consent: on an origin the deployment admits for browser modules. The deployment keeps `return_to`'s own query and adds the `nc_*` parameters to it.
             */
            return_to: string;
        };
        ConnectionAuthorizeResult: {
            /**
             * Format: uri
             * @description Where to send the browser. Good for one use.
             */
            authorization_url: string;
            expires_at: components["schemas"]["Timestamp"];
        };
        /** @description How a tool server authenticates callers (rev 11): `none`, `bearer` or `oauth`, which may name the `scopes` to ask for and the authorization server's `issuer` and the deployment's `client_id` there. It never carries a credential: an organisation credential is `org_credential`, and a user's is their link. */
        ConnectionAuth: {
            /** @constant */
            kind: "none";
        } | {
            /** @constant */
            kind: "bearer";
        } | {
            /** @constant */
            kind: "oauth";
            scopes?: string[];
            /** Format: uri */
            issuer?: string;
            client_id?: string;
        };
        /** @description The organisation credential of an `org_shared` registration with `auth.kind: bearer` (rev 11): set and rotated by an administrator, write only, and never returned. */
        OrgCredential: {
            token: string;
        };
        ConnectionWrite: {
            name: string;
            /**
             * Format: uri
             * @description The server's URL, which fixes the identity of its tools (rev 11). It carries no credential: a URL with userinfo is 400 `invalid_request`. It is shown to every principal who sees the registration.
             */
            url: string;
            /** @enum {string} */
            transport: "mcp" | "a2a";
            /**
             * @description Whose connection this is. The owner id is the token's.
             * @default principal
             * @enum {string}
             */
            owner_kind: "principal" | "org";
            /** @description How the server authenticates callers (rev 11). Absent means `{ kind: none }`. */
            auth?: components["schemas"]["ConnectionAuth"];
            /**
             * @description Rev 11, administrator only, fixed at create: see `POST /v1/connections`. Absent, `per_user` where the deployment advertises `connections.user_links`, else `org_shared`.
             * @enum {string}
             */
            credential_tier?: "org_shared" | "per_user";
            /** @description Rev 11, administrator only: legal only with `credential_tier: org_shared` and `auth.kind: bearer`, which needs it. */
            org_credential?: components["schemas"]["OrgCredential"];
        };
        ConnectionPatch: {
            name?: string;
            /** @description Rev 11: rotates the organisation credential of an `org_shared` registration with `auth.kind: bearer`. Administrator only. */
            org_credential?: components["schemas"]["OrgCredential"];
            /**
             * Format: uri
             * @description Refused with 400 `invalid_request` (rev 11): a connection's URL is the identity of its tools.
             */
            url?: string;
        };
        /** @description What `POST /v1/connections/{id}/refresh` registered (rev 11). */
        ConnectionRefreshResult: {
            /** @description The tools the server offers now. */
            tool_count: number;
            /** @description Tools registered for the first time. */
            added: number;
            /** @description Tools no longer offered, now `withdrawn`. */
            removed: number;
            /** @description Tools offered again after they were withdrawn, `active` under the same `tool_ref`. */
            reactivated: number;
            /** @description True when the server offered no tool at all and the deployment kept the registered tools rather than withdraw every one. */
            empty_upstream_suppressed?: boolean;
        };
        Tool: {
            id: string;
            /** @description A deployment-assigned stable reference (rev 11): clients compare it for equality and never parse it. A deployment keeps it stable while the tool's server identity is unchanged, across disconnect and reconnect. */
            tool_ref: string;
            /** @description The connection the tool was registered from; a `withdrawn` tool keeps the one it was last registered from. Null for a tool registered through `POST /v1/tools`. */
            connection_id?: string | null;
            /** @description Rev 11: `active`, or `withdrawn` when its server no longer offers it or its connection was deleted. A decision for a `withdrawn` tool is `deny` with reason `unknown_tool`, and it stays in `GET /v1/tools`. Absent means `active`; a hosted deployment returns it on every tool. Open-ended: a client treats a value it does not know as not callable. Known values: active | withdrawn. */
            status?: string;
            description?: string;
            /** @enum {string} */
            transport: "mcp" | "a2a" | "external";
            input_schema?: {
                [key: string]: unknown;
            };
            side_effect_level: components["schemas"]["SideEffectLevel"];
            /** @description The orchestrator's data-routing value. Opaque to this contract. */
            data_routing: string;
            owner?: components["schemas"]["Owner"];
            /** @description Whether the people who decide an approval of this tool see the call's arguments (see Who sees the arguments of an approval). Absent means `false`. */
            show_arguments_to_approvers?: boolean;
            /** @description Rev 16: the facts a call to this tool carries, each read from its arguments. Absent: the tool declares none. Set only by a deployment that lists the feature `tools.facts`. */
            facts?: components["schemas"]["ToolFacts"];
        };
        ToolWrite: {
            tool_ref: string;
            /** @constant */
            transport: "external";
            description?: string;
            input_schema: {
                [key: string]: unknown;
            };
            side_effect_level: components["schemas"]["SideEffectLevel"];
            /**
             * @default principal
             * @enum {string}
             */
            owner_kind: "principal" | "org";
            /**
             * @description Show the call's arguments to the people who decide an approval of this tool. A deployment that does not serve approvals accepts the field and ignores it.
             * @default false
             */
            show_arguments_to_approvers: boolean;
            /** @description Rev 16: the facts the tool declares (see `Tool.facts`). */
            facts?: components["schemas"]["ToolFacts"];
        };
        ToolPatch: {
            description?: string;
            side_effect_level?: components["schemas"]["SideEffectLevel"];
            input_schema?: {
                [key: string]: unknown;
            };
            show_arguments_to_approvers?: boolean;
            /** @description Rev 16: replaces the tool's whole map of facts; `null` removes every fact. A fact a published policy's condition names may be removed: that fact then has no value, so a condition naming it is unevaluable (false under `exists`), with the consequences the evaluation in `ToolInvocationConfig` gives. */
            facts?: components["schemas"]["ToolFacts"] | null;
        };
        Principal: {
            id: string;
            kind: components["schemas"]["PrincipalKind"];
            display_name: string;
        };
        Agent: {
            id: string;
            name: string;
            parent_id: string | null;
            created_at: components["schemas"]["Timestamp"];
            /** @description Rev 13: the service principal this agent is bound to (see Agent identity), or null when it is unbound. Optional on the wire so that a rev 12 deployment's agent still validates; a client treats an absent member as null. */
            principal_id?: string | null;
        };
        /** @description The body of `PUT /v1/agents/{id}/principal` (rev 13). */
        AgentPrincipalWrite: {
            /** @description The id of a service principal of the organisation: the `id` that `Record.actor` carries on a record the service principal appended, and that `GET /v1/principals` lists it under. An id that names no service principal of the caller's organisation, a user or a principal of another organisation included, is 404 `not_found`. */
            principal_id: string;
        };
        AgentWrite: {
            name: string;
            parent_id?: string;
        };
        Run: {
            id: string;
            /** @enum {string} */
            kind: "external" | "governed";
            /** @description The scope approvals under this run are deduplicated in. A delegated run has a fresh scope id, so it never shares an obligation with its delegator. */
            scope_id: string;
            /** @description The agent the run was created for, as `createRun` was given it. Like `actor.agent_id` it is a hint and never selects which policies apply to a call that names the run (rev 13): an agent's policies apply only through the service principal bound to the agent (see Agent identity). */
            agent_id?: string | null;
            created_at: components["schemas"]["Timestamp"];
        };
        RunWrite: {
            /**
             * @description `governed` is refused with 405.
             * @enum {string}
             */
            kind: "external" | "governed";
            /** @description An agent of the caller's organisation (a row of `/v1/agents`); any other id is 404 `not_found`. */
            agent_id?: string;
        };
        /** @description A webhook subscription. Rev 12 removes `secret`: a delivery is signed with the deployment's key (see `createWebhook`), so there is no shared secret to return. The object is open: a response from a rev 11 deployment that still carries `secret` is accepted. */
        Webhook: {
            id: string;
            /** Format: uri */
            url: string;
            events: components["schemas"]["WebhookEvent"][];
            /** @description Rev 12. Whether the webhook gets deliveries; absent means `active`. `disabled`: its deliveries failed continuously for 72 hours, and it gets none until it is deleted and created anew. A client treats a value it does not know as not `active`. Known values: active | disabled. */
            state?: string;
            created_at: components["schemas"]["Timestamp"];
        };
        /** @enum {string} */
        WebhookEvent: "approval.resolved" | "record.appended" | "policy.published";
        WebhookWrite: {
            /** Format: uri */
            url: string;
            events: components["schemas"]["WebhookEvent"][];
        };
        /** @description Rev 12. The body of a webhook delivery: a CloudEvents 1.0 structured-mode JSON object plus `signature`, a JWS compact serialization (ES256, `kid` in the header) whose payload is the JCS form of this object without `signature`, as for a Resumption. Verify it against `/.well-known/jwks.json`. One signature per event, shared by every subscriber: the body names no subscriber (the request header `NobleCloak-Webhook-Id` carries the subscription's id, unsigned). `id` is the event id; a receiver dedupes on it. */
        WebhookDelivery: {
            /** @enum {string} */
            specversion: "1.0";
            id: string;
            type: components["schemas"]["WebhookEvent"];
            /**
             * Format: uri
             * @description The origin of the deployment's govern host.
             */
            source: string;
            /** @description The id of the resource the event is about. */
            subject: string;
            time: components["schemas"]["Timestamp"];
            /** @enum {string} */
            datacontenttype: "application/json";
            /** @description The event data for `type`, and only for `type`: `approval.resolved` carries ApprovalResolvedData, `record.appended` RecordAppendedData, `policy.published` PolicyPublishedData. Thin, never carrying the resource's representation. */
            data: components["schemas"]["ApprovalResolvedData"] | components["schemas"]["RecordAppendedData"] | components["schemas"]["PolicyPublishedData"];
            signature: string;
        } & (unknown & unknown & unknown);
        /** @description Rev 12. The resolution an `approval.resolved` delivery reports. Open-ended: the documented values are `approved`, `rejected` and `escalated`, and a client treats any other value as a resolution it does not act on (fail closed). A deployment delivers only the documented values. Known values: approved | rejected | escalated. */
        WebhookResolution: string;
        /** @description Rev 12. `data` of `approval.resolved`; `subject` is the approval id. */
        ApprovalResolvedData: {
            approval_id: string;
            /** @enum {string} */
            state: "approved" | "rejected";
            resolution: components["schemas"]["WebhookResolution"];
            resolved_at: components["schemas"]["Timestamp"];
            tool_ref: string;
        };
        /** @description Rev 12. `data` of `record.appended`; `subject` is the record id. */
        RecordAppendedData: {
            record_id: string;
            tool_ref: string;
            decision: string;
            ts: components["schemas"]["Timestamp"];
        };
        /** @description Rev 12. `data` of `policy.published`; `subject` is the policy id. */
        PolicyPublishedData: {
            policy_id: string;
            kind: string;
            version: number;
            published_at: components["schemas"]["Timestamp"];
        };
        Origins: {
            origins: string[];
        };
        OriginsWrite: {
            /** @description Rev 12: each origin is exact, `scheme://host[:port]` as a browser sends it in `Origin`: no path, query, fragment, trailing slash, userinfo or wildcard; `https`, or `http` only for `localhost` and `127.0.0.1`. The host is lowercase and a default port (443 for `https`, 80 for `http`) is omitted. The `pattern` is a coarse filter only; the rule stated here governs, and a deployment refuses a non-canonical form the pattern lets through. One that is not exact is 400 `invalid_request`, naming it. */
            origins: string[];
        };
        Capabilities: {
            /** @enum {string} */
            deployment: "hosted" | "edge";
            /** @description The entitlement keys the organisation holds; a route or a request member that needs one names it. Open-ended: a client treats a key it does not know as one it does not use. A route names its key in `x-noblecloak-entitlement` (or, for one value of a parameter, `x-noblecloak-entitlement-for-values`) and answers 403 `entitlement_required` without it; rev 18, a `role` row of a `PolicySetProposal` needs `policies.role_subjects` and is refused `proposal_refused` with `code` `not_entitled` without it. Known values: records.verify | evidence.export | policies.suggested | policies.role_subjects. */
            entitlements: string[];
            /** Format: uri */
            jwks_uri: string;
            kids: string[];
            /** @description The resolutions this deployment can produce. Empty when it does not serve approvals. A resolution it does not serve, `escalated` where it has no escalation, is refused with 400 `invalid_request`. */
            resolutions: string[];
            /** @description The route families served here (every family except `approvals`, which `resolutions` advertises: `runs`, `webhooks`, `origins`, `policies`, `agents`, `principals`, `connections`, `records.checkpoints`, `records.chain`, `evidence`), the hosted-only features (`policies.author`, `policies.publish`, `policies.import_export`, `policies.retire` (rev 11: retiring a policy and discarding its draft), `connections.oauth` (rev 11: the OAuth authorize step of a connection), `connections.user_links` (rev 11: each user's own credential link to a `per_user` registration, with consent), `records.verify` and `evidence.export`) and the features a deployment of either kind may have. `approvals.rejected_duplicate` (rev 10) says the deployment applies the rejected-duplicate rule (see Terminal states free the identity), and a deployment that does not list it keeps the rev 9 behaviour, where a rejection frees the identity. `approvals.available_actions` (rev 15) says the deployment sets `Approval.available_actions` on the single read of a pending approval, and a deployment that does not list it never sets the member. `policies.tightest_wins` (rev 11) states how the deployment composes `tool_invocation` policies: across every entry that matched a call the tightest mode wins, `deny` over needs approval (`ask`, `escalate`) over `always_allow`, and `not_granted` composes as `deny` (provisional, as `not_granted` is); a mode is loosened only through an exemption the deployment defines. Its default is a fallback, listed in `considered` only when no policy of its kind matched. A decision's `policy` names one of the entries that contributed, the deployment's choice, and the `considered` of a simulation gives the set (`contributed`). A deployment that does not list `policies.tightest_wins` states no rule. Rev 16: `tools.facts` says the deployment reads the facts of a call through `Tool.facts`; `policies.rules` says it evaluates `ToolInvocationConfig.rules`, lists `rule` and `missing_facts` in `considered`, and sets `Decision.missing_facts`; `approvals.requirements` says it enforces `ToolInvocationConfig.approvers` and `exclude`, serves `approval_routing` policies, and sets `Approval.requirements`. A deployment that does not list one of them refuses its members (422 `unsupported_policy_form`) and never sets the members it serves, so it behaves as rev 15. An edge deployment omits the hosted-only features and the families that are hosted-only. */
            features: string[];
            /** Format: uri */
            authzen_configuration: string;
            /** @description The limits of this deployment. For the three batch limits (`decisions_batch_max_items`, `records_batch_max_items`, `resolutions_batch_max_items`) 100 is the most any deployment accepts, and a member that is absent means 100. A batch above a limit and no larger than 100 is 400 `batch_too_large`; one above 100 is 400 `invalid_request`, the schema's `maxItems`, whatever the limit. */
            limits?: {
                /** @description The most items `POST /v1/decisions/batch` accepts. */
                decisions_batch_max_items?: number;
                /** @description The most items `POST /v1/records/batch` accepts. */
                records_batch_max_items?: number;
                /** @description The most items `POST /v1/approvals/resolve/batch` accepts. */
                resolutions_batch_max_items?: number;
                /** @description The most bytes of arguments (RFC 8785 canonical JSON) this deployment keeps for an approval of a tool that shows its arguments to approvers. Larger arguments are refused with 400 `invalid_request`, whose `detail` says so; absent means this deployment sets no bound it advertises. */
                approval_arguments_max_bytes?: number;
            };
            /** @description The continuation deliveries this deployment serves. Absent means all three. A continuation whose delivery is not listed is refused with 400 `invalid_continuation`, as the routes that take one say. */
            continuation_deliveries?: ("push" | "pull" | "held")[];
            /** @description Rev 17: the continuation kinds this deployment accepts. Absent means the seven kinds of rev 16 (`adk` … `agt`): a deployment that accepts `claude_agent_sdk` lists it. A kind not accepted is 400 `invalid_request`, as a kind outside the `Continuation.kind` enum is. Unlike `continuation_deliveries`, where absent means all three, absent here is the list before rev 17, because a deployment that predates rev 17 cannot advertise the member. Open-ended: a client treats a kind it does not know as one it does not send. Known values: adk | langgraph | vercel_ai | openai_agents | webhook | mcp_held | agt | claude_agent_sdk. */
            continuation_kinds?: string[];
            /**
             * @description Who may register or change tools: `any` principal of the organisation, or only its `administrators`. Absent means `any`. Any other principal is 403 `forbidden`, whatever the body. The per-tool setting `show_arguments_to_approvers` has no member of its own: it is honoured whenever `resolutions` is non-empty.
             * @enum {string}
             */
            tool_registration?: "any" | "administrators";
            /** @description Who may register a connection here (rev 11): the owner kinds it accepts, and whether `any` principal of the organisation or only its `administrators` may register. Absent means unrestricted. A refused owner kind, or a refused caller, is 403 `forbidden`. It governs registration only, never who may use a registration, and never who changes, refreshes or deletes one: an `org`-owned connection is changed by administrators only on every deployment (see `PATCH /v1/connections/{id}`). */
            connection_registration?: {
                owner_kinds: ("principal" | "org")[];
                /** @enum {string} */
                who: "any" | "administrators";
            };
            /** @description The connection transports this deployment serves (rev 11). Absent means both. A create naming another is 400 `invalid_request`. */
            connection_transports?: ("mcp" | "a2a")[];
            /** @description The policy forms this deployment enforces (rev 11), by kind. For `tool_invocation`: the modes, the subject types, whether a policy may target every tool (`targets_all`), and the members of `ToolInvocationConfig` besides `mode` it implements (`config_members`; rev 16 adds `rules` under `policies.rules`, and `approvers` and `exclude` under `approvals.requirements`). For `approval_routing` (rev 16, under `approvals.requirements`): the members of `ApprovalRoutingConfig` it implements; the kind is not served where the entry is absent. An advertised form is never refused with 422 `unsupported_policy_form`; a form it does not list may be. Absent means the deployment does not say, and a refused form is learnt from the 422. */
            policy_forms?: {
                tool_invocation?: {
                    modes: components["schemas"]["PolicyMode"][];
                    subject_types: components["schemas"]["PolicySubjectType"][];
                    targets_all: boolean;
                    /** @description The members of `ToolInvocationConfig` besides `mode` this deployment implements, for example `on_deny`, `expires_after` and `approver_groups`. */
                    config_members: string[];
                };
                /** @description Rev 16: the deployment serves policies of kind `approval_routing` (organisation subject, every tool). */
                approval_routing?: {
                    /** @description The members of `ApprovalRoutingConfig` this deployment implements, for example `org_admin_break_glass`. */
                    config_members: string[];
                };
            };
            /** @description Rev 14: the deployment-applied references this deployment applies on approval (see Deployment-applied proposals). A reference that is not listed is answered 422 `approval_unroutable` when an approval is opened for it. Absent means none: a deployment that does not author and publish policies of its own lists none. */
            deployment_applied?: {
                tool_ref: string;
                /** @description The name of the schema in `components.schemas` that `action.arguments` of an approval for this reference must fit, for example `PolicySetProposal`. */
                arguments_schema_ref: string;
            }[];
            /** @description Rev 18: what this deployment accepts in a `PolicySetProposal`, where it lists `tool:noblecloak:propose-policy-set` in `deployment_applied`. Absent means what a deployment of rev 14 to 17 accepts: `row_kinds` `baseline` and `tightening`, and no optional member. A row kind or an optional member the deployment does not list is refused `proposal_refused` with `code` `shape`. */
            proposals?: {
                /** @description The values of `PolicySetEntry.role` this deployment accepts. Open-ended: a client treats a kind it does not know as one it does not send. Known values: baseline | tightening | role. */
                row_kinds: string[];
                /** @description The optional members of `PolicySetProposal` beyond those of rev 14 that this deployment accepts, possibly none. Open-ended: a client treats a member it does not know as one it does not send. Known values: tool_grants. */
                members: string[];
            };
            /** @description Whether a person may resolve an obligation their own agent opened when the resolving token was issued to the deployment's approver surface (the approvals module's own client). `true`: such a token resolves it; the creating principal's own token, from any client but the approver surface, is never eligible, and a token issued to the approver surface may not open an obligation on any path (`POST /v1/approvals`, a `step_up` on `POST /v1/decisions` or its batch, or an AuthZEN evaluation: 403 `forbidden`; `allow` and `deny` decisions are still answered) and may not consume a Resumption (`POST /v1/approvals/{id}/consume`: 403 `forbidden`), so one such token cannot approve an obligation and spend it. `false`: the creating principal never resolves its own obligation, from any surface. Absent means `false`, the rev 6 behaviour. A scenario that depends on it runs only where the deployment advertises the matching value. */
            self_approval_from_approver_surface?: boolean;
            /** @description The OAuth scope a user-track token must carry to resolve an approval: `POST /v1/approvals/{id}/resolve`, `/approve`, `/deny` and `POST /v1/approvals/resolve/batch` answer 403 `insufficient_scope` to a user's token that lacks it, and answer it before the body is validated, before the approval is looked up and before eligibility: an approval id that does not exist is still 403 `insufficient_scope`, and a missing scope is never reported as `not_found`, `invalid_request` or `not_eligible`. Every non-service principal (a user or an agent) is asked for it; a service principal never resolves and is not asked. Withdraw, consume and every read are not gated by it. Absent means the deployment requires no user scope to resolve (the rev 7 behaviour). A scenario that depends on it runs only where the deployment advertises the member. */
            user_resolve_scope?: string;
            /**
             * @description Whether this deployment verifies DPoP proofs. `off` (the default when the member is absent): it verifies none, so a token that carries `cnf.jkt` and the `Authorization: DPoP` scheme are 401 `dpop_unsupported` and only bearer tokens are accepted. `optional`: a proof-bound token is accepted with its proof and a bearer token is accepted without one. `required`: a bearer token without a proof is 401. The `dpop_unsupported` negatives run only against `off`; against a deployment that advertises `optional` or `required` the conformance suite cannot check that it really verifies proofs, so those scenarios are reported as unverified skips, which count against the exit code unless skips are allowed.
             * @enum {string}
             */
            dpop?: "off" | "optional" | "required";
        };
        Jwk: {
            /** @constant */
            kty: "EC";
            /** @constant */
            crv: "P-256";
            x: string;
            y: string;
            kid: string;
            /** @constant */
            alg?: "ES256";
            /** @constant */
            use?: "sig";
        };
        Jwks: {
            keys: components["schemas"]["Jwk"][];
        };
        AuthzenSubject: {
            type: string;
            id: string;
            properties?: {
                [key: string]: unknown;
            };
        };
        AuthzenAction: {
            name: string;
            properties?: {
                [key: string]: unknown;
            };
        };
        AuthzenEvaluationRequest: {
            subject: components["schemas"]["AuthzenSubject"];
            action: components["schemas"]["AuthzenAction"];
            resource: components["schemas"]["AuthzenSubject"];
            context?: {
                [key: string]: unknown;
            };
        };
        AuthzenEvaluationResponse: {
            decision: boolean;
            context?: {
                noblecloak?: components["schemas"]["Decision"];
            } & {
                [key: string]: unknown;
            };
        };
        AuthzenConfiguration: {
            /** Format: uri */
            policy_decision_point: string;
            /** Format: uri */
            access_evaluation_endpoint: string;
            /** Format: uri */
            access_evaluations_endpoint?: string;
        };
        DecisionEnvelope: {
            data: components["schemas"]["Decision"];
            meta: components["schemas"]["Meta"];
        };
        DecisionBatchEnvelope: {
            data: {
                decisions: components["schemas"]["Decision"][];
            };
            meta: components["schemas"]["Meta"];
        };
        ApprovalHandleEnvelope: {
            data: components["schemas"]["ApprovalHandle"];
            meta: components["schemas"]["Meta"];
        };
        ApprovalEnvelope: {
            data: components["schemas"]["Approval"];
            meta: components["schemas"]["Meta"];
        };
        ResolveBatchEnvelope: {
            data: components["schemas"]["ResolveBatchResult"][];
            meta: components["schemas"]["Meta"];
        };
        ApprovalListEnvelope: {
            data: components["schemas"]["Approval"][];
            meta: components["schemas"]["Meta"];
        };
        ResumptionEnvelope: {
            data: components["schemas"]["Resumption"];
            meta: components["schemas"]["Meta"];
        };
        ConsumeEnvelope: {
            data: components["schemas"]["ConsumeResult"];
            meta: components["schemas"]["Meta"];
        };
        ContinuationTestEnvelope: {
            data: components["schemas"]["ContinuationTestResult"];
            meta: components["schemas"]["Meta"];
        };
        RecordEnvelope: {
            data: components["schemas"]["Record"];
            meta: components["schemas"]["Meta"];
        };
        RecordListEnvelope: {
            data: components["schemas"]["Record"][];
            meta: components["schemas"]["Meta"];
        };
        RecordBatchEnvelope: {
            data: components["schemas"]["Record"][];
            meta: components["schemas"]["Meta"];
        };
        RecordChainEnvelope: {
            data: components["schemas"]["RecordChain"];
            meta: components["schemas"]["Meta"];
        };
        CheckpointEnvelope: {
            data: components["schemas"]["Checkpoint"];
            meta: components["schemas"]["Meta"];
        };
        VerificationEnvelope: {
            data: components["schemas"]["Verification"];
            meta: components["schemas"]["Meta"];
        };
        ExportEnvelope: {
            data: components["schemas"]["EvidenceExport"];
            meta: components["schemas"]["Meta"];
        };
        PolicyEnvelope: {
            data: components["schemas"]["Policy"];
            meta: components["schemas"]["Meta"];
        };
        SimulateEnvelope: {
            data: components["schemas"]["SimulateResult"];
            meta: components["schemas"]["Meta"];
        };
        PolicyListEnvelope: {
            data: components["schemas"]["Policy"][];
            meta: components["schemas"]["Meta"];
        };
        PolicyImportEnvelope: {
            data: components["schemas"]["PolicyImportReport"];
            meta: components["schemas"]["Meta"];
        };
        ConnectionEnvelope: {
            data: components["schemas"]["Connection"];
            meta: components["schemas"]["Meta"];
        };
        ConnectionListEnvelope: {
            data: components["schemas"]["Connection"][];
            meta: components["schemas"]["Meta"];
        };
        ConnectionAuthorizeEnvelope: {
            data: components["schemas"]["ConnectionAuthorizeResult"];
            meta: components["schemas"]["Meta"];
        };
        ConnectionRefreshEnvelope: {
            data: components["schemas"]["ConnectionRefreshResult"];
            meta: components["schemas"]["Meta"];
        };
        ToolEnvelope: {
            data: components["schemas"]["Tool"];
            meta: components["schemas"]["Meta"];
        };
        ToolListEnvelope: {
            data: components["schemas"]["Tool"][];
            meta: components["schemas"]["Meta"];
        };
        PrincipalListEnvelope: {
            data: components["schemas"]["Principal"][];
            meta: components["schemas"]["Meta"];
        };
        AgentEnvelope: {
            data: components["schemas"]["Agent"];
            meta: components["schemas"]["Meta"];
        };
        RunEnvelope: {
            data: components["schemas"]["Run"];
            meta: components["schemas"]["Meta"];
        };
        WebhookEnvelope: {
            data: components["schemas"]["Webhook"];
            meta: components["schemas"]["Meta"];
        };
        WebhookListEnvelope: {
            data: components["schemas"]["Webhook"][];
            meta: components["schemas"]["Meta"];
        };
        OriginsEnvelope: {
            data: components["schemas"]["Origins"];
            meta: components["schemas"]["Meta"];
        };
        CapabilitiesEnvelope: {
            data: components["schemas"]["Capabilities"];
            meta: components["schemas"]["Meta"];
        };
    };
    responses: {
        /** @description Authentication failed. A request that carries any of the headers `x-actor-id`, `x-actor-type`, `x-organization-id`, `x-permissions` or `x-scopes` (or any header whose name starts with `x-actor-`) is 401 `header_identity_rejected`, whatever the token. */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The caller is not permitted. */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The caller is not permitted, or the organisation is not entitled to this route. */
        ForbiddenEntitlement: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The caller is not eligible to resolve this obligation. */
        ForbiddenNotEligible: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Only the principal that created the obligation may read its Resumption. */
        ForbiddenNotOwner: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description No such resource for this caller. */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Not found, or not served on this deployment. */
        NotAvailableOnDeployment: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The request does not match the schema. */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The request does not match the schema, or asserts an identity. */
        BadRequestCreateApproval: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The request does not match the schema, or supplies a server-derived field. */
        BadRequestRecord: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The request does not match the schema, or the callback is not public-routable. */
        BadRequestCallback: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The approval cannot be resolved as requested. */
        ConflictResolve: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The approval can no longer be withdrawn. */
        ConflictWithdraw: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The obligation cannot be consumed as requested. */
        ConflictConsume: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The Resumption is no longer available (consumed, expired or withdrawn). */
        ConflictResumption: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The open obligation already has a different continuation. */
        ConflictContinuation: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The open obligation already has a different continuation, or an identical call was rejected within the window of the duplicate-requests policy (`rejected_duplicate`, with `rejected_approval_id`). */
        ConflictCreateApproval: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Another published policy already governs one of this policy's (tool, subject) pairs; `policy_id` names it. */
        ConflictPolicy: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The service principal is already bound to another agent (rev 13); `agent_id` names that agent. */
        ConflictPrincipalBound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The organisation already has a registration of the same tool server (`connection_exists`); `connection_id` names it when the caller may read it. */
        ConflictConnection: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The policy uses a kind, a subject type, a target form, a mode or a config member this deployment cannot enforce; `member` names it (rev 13; a rev 12 deployment names it in `detail`). */
        UnprocessablePolicyForm: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description As `UnprocessablePolicyForm`, or (rev 14) the body targets a deployment-applied reference, whose policy is fixed (`policy_immutable`). */
        UnprocessablePolicyWrite: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description A governed run is created by the platform. */
        MethodNotAllowedGoverned: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The deployment does not serve approvals, so it cannot store the continuation of a step-up. */
        UnprocessableContinuation: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The Idempotency-Key was used with a different request. */
        UnprocessableIdempotency: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The Idempotency-Key was used with a different request, the deployment cannot open or route an approval for the tool, or (rev 14) it refuses a deployment-applied proposal (`proposal_refused`, with `code`). */
        UnprocessableCreateApproval: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Rate limit exceeded. */
        TooManyRequests: {
            headers: {
                /** @description The seconds to wait before retrying, when the deployment can say. The body carries the same value as `retry_after_seconds`. */
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The request body is larger than this deployment accepts. `max_bytes` says how large it may be, when the deployment can say. */
        PayloadTooLarge: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The request does not match the schema, the batch has more decisions than this deployment accepts (`batch_too_large`, with `max_items`), or an element's continuation is refused (`callback_unroutable`, `invalid_continuation`). */
        BadRequestDecisionBatch: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The request does not match the schema, or the batch has more elements than this deployment accepts (`batch_too_large`, with `max_items`). */
        BadRequestResolveBatch: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The request does not match the schema, supplies a server-derived field, or the batch has more records than this deployment accepts (`batch_too_large`, with `max_items`). */
        BadRequestRecordBatch: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The tool's side-effect level would fall. */
        ConflictToolLevel: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The tool reference is one this deployment does not let a caller register. */
        UnprocessableToolRef: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The deployment failed to answer. The request may be retried. */
        InternalError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The deployment cannot answer right now. Retry later. `reason` names the cause when the deployment can (`eligibility_lookup`: it could not determine whether the caller may resolve an approval). */
        ServiceUnavailable: {
            headers: {
                /** @description The seconds to wait before retrying, when the deployment can say. The body carries the same value as `retry_after_seconds`. */
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        /** @description Replays within 24 hours return the original response and status. Never used on /consume or /resolve. */
        IdempotencyKey: string;
        /** @description The `meta.next` of the previous page. */
        Cursor: string;
        /** @description `me` returns only the approvals whose creating principal is the caller. Any other value is 400 `invalid_request`. */
        CreatedBy: "me";
        Limit: number;
        /**
         * @description One approval state or a comma-separated set of them (`state=approved,rejected`): the approvals
         *     in any of them. A value that is not an `ApprovalState` is 400 `invalid_request`.
         */
        ApprovalStateSet: string;
        /** @description `created_at` (the default) orders newest first by creation. `resolved_at` orders newest first by resolution time and returns only the approvals that have one. Any other value is 400 `invalid_request`. */
        ApprovalOrder: "created_at" | "resolved_at";
        /** @description The approval id. */
        ApprovalId: string;
        /** @description The record id. */
        RecordId: string;
        /** @description The policy id. */
        PolicyId: string;
        /** @description The connection id. */
        ConnectionId: string;
        /** @description The tool id. */
        ToolId: string;
        /** @description The agent id. */
        AgentId: string;
        /** @description The run id. */
        RunId: string;
        /** @description The webhook id. */
        WebhookId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    decide: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DecisionRequest"];
            };
        };
        responses: {
            /** @description The decision. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DecisionEnvelope"];
                };
            };
            400: components["responses"]["BadRequestCallback"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConflictContinuation"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessableContinuation"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    decideBatch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DecisionBatchRequest"];
            };
        };
        responses: {
            /** @description One decision per request element. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DecisionBatchEnvelope"];
                };
            };
            400: components["responses"]["BadRequestDecisionBatch"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConflictContinuation"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessableContinuation"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    authzenEvaluate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AuthzenEvaluationRequest"];
            };
        };
        responses: {
            /** @description The AuthZEN evaluation response. It is not wrapped in the envelope, as AuthZEN requires. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthzenEvaluationResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    authzenConfiguration: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The discovery document. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthzenConfiguration"];
                };
            };
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    listApprovals: {
        parameters: {
            query?: {
                /**
                 * @description One approval state or a comma-separated set of them (`state=approved,rejected`): the approvals
                 *     in any of them. A value that is not an `ApprovalState` is 400 `invalid_request`.
                 */
                state?: components["parameters"]["ApprovalStateSet"];
                /** @description `created_at` (the default) orders newest first by creation. `resolved_at` orders newest first by resolution time and returns only the approvals that have one. Any other value is 400 `invalid_request`. */
                order?: components["parameters"]["ApprovalOrder"];
                /** @description `me` returns approvals the caller is eligible to resolve. */
                approver?: "me";
                /** @description `me` returns only the approvals whose creating principal is the caller. Any other value is 400 `invalid_request`. */
                created_by?: components["parameters"]["CreatedBy"];
                /** @description A scope id (see `GET /v1/runs/{id}`). */
                scope?: string;
                /** @description `missing` returns consumed approvals that have no outcome record. */
                outcome?: "missing";
                /** @description The `meta.next` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of approvals. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalListEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    createApproval: {
        parameters: {
            query?: never;
            header?: {
                /** @description Replays within 24 hours return the original response and status. Never used on /consume or /resolve. */
                "Idempotency-Key"?: components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateApprovalRequest"];
            };
        };
        responses: {
            /** @description An open obligation for this action already existed (`created: false`). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalHandleEnvelope"];
                };
            };
            /** @description A new obligation was opened (`created: true`). */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalHandleEnvelope"];
                };
            };
            400: components["responses"]["BadRequestCreateApproval"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConflictCreateApproval"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessableCreateApproval"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The approval id. */
                id: components["parameters"]["ApprovalId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The approval. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    resolveApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The approval id. */
                id: components["parameters"]["ApprovalId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResolveRequest"];
            };
        };
        responses: {
            /** @description The approval after resolution. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["ForbiddenNotEligible"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConflictResolve"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    resolveApprovalsBatch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResolveBatchRequest"];
            };
        };
        responses: {
            /** @description One result per element, in order. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResolveBatchEnvelope"];
                };
            };
            400: components["responses"]["BadRequestResolveBatch"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["ForbiddenNotEligible"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    approveApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The approval id. */
                id: components["parameters"]["ApprovalId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AliasResolveRequest"];
            };
        };
        responses: {
            /** @description The approval after resolution. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["ForbiddenNotEligible"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConflictResolve"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    denyApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The approval id. */
                id: components["parameters"]["ApprovalId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AliasResolveRequest"];
            };
        };
        responses: {
            /** @description The approval after resolution. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["ForbiddenNotEligible"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConflictResolve"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    withdrawApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The approval id. */
                id: components["parameters"]["ApprovalId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The withdrawn approval. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConflictWithdraw"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    waitApproval: {
        parameters: {
            query?: {
                timeout?: number;
            };
            header?: never;
            path: {
                /** @description The approval id. */
                id: components["parameters"]["ApprovalId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The approval in its current state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    streamApprovals: {
        parameters: {
            query?: {
                /** @description `me` returns only the approvals whose creating principal is the caller. Any other value is 400 `invalid_request`. */
                created_by?: components["parameters"]["CreatedBy"];
                /** @description `me` delivers only approvals the caller is eligible to resolve. Any other value is 400 `invalid_request`. */
                approver?: "me";
                /**
                 * @description One approval state or a comma-separated set of them (`state=approved,rejected`): the approvals
                 *     in any of them. A value that is not an `ApprovalState` is 400 `invalid_request`.
                 */
                state?: components["parameters"]["ApprovalStateSet"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A `text/event-stream` of `approval.updated` events. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getResumption: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The approval id. */
                id: components["parameters"]["ApprovalId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The Resumption. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResumptionEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["ForbiddenNotOwner"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConflictResumption"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    consumeApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The approval id. */
                id: components["parameters"]["ApprovalId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConsumeRequest"];
            };
        };
        responses: {
            /** @description The obligation was consumed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConsumeEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConflictConsume"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    testContinuation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ContinuationTestRequest"];
            };
        };
        responses: {
            /** @description The validation result. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ContinuationTestEnvelope"];
                };
            };
            400: components["responses"]["BadRequestCallback"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    listRecords: {
        parameters: {
            query?: {
                actor?: string;
                tool?: string;
                decision?: components["schemas"]["DecisionValue"];
                approval_id?: string;
                /** @description `true` returns only records that carry `degraded`, `false` only records that do not. */
                degraded?: "true" | "false";
                from?: string;
                to?: string;
                /** @description The `meta.next` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of records. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecordListEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    appendRecord: {
        parameters: {
            query?: never;
            header?: {
                /** @description Replays within 24 hours return the original response and status. Never used on /consume or /resolve. */
                "Idempotency-Key"?: components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecordCreate"];
                "application/vnd.microsoft.agt.event+json": components["schemas"]["AgtEvent"];
            };
        };
        responses: {
            /** @description The appended record. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecordEnvelope"];
                };
            };
            400: components["responses"]["BadRequestRecord"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessableIdempotency"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    appendRecords: {
        parameters: {
            query?: never;
            header?: {
                /** @description Replays within 24 hours return the original response and status. Never used on /consume or /resolve. */
                "Idempotency-Key"?: components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecordBatchRequest"];
            };
        };
        responses: {
            /** @description The appended records, in request order. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecordBatchEnvelope"];
                };
            };
            400: components["responses"]["BadRequestRecordBatch"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessableIdempotency"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getRecord: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The record id. */
                id: components["parameters"]["RecordId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The record. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecordEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getRecordChain: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The record id. */
                id: components["parameters"]["RecordId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The chain. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecordChainEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    createCheckpoint: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The checkpoint. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CheckpointEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["ForbiddenEntitlement"];
            404: components["responses"]["NotAvailableOnDeployment"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    verifyRecords: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The verification result. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VerificationEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["ForbiddenEntitlement"];
            404: components["responses"]["NotAvailableOnDeployment"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    createEvidenceExport: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The export was accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExportEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["ForbiddenEntitlement"];
            404: components["responses"]["NotAvailableOnDeployment"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    listPolicies: {
        parameters: {
            query?: {
                /** @description `suggested` requires the `policies.suggested` entitlement and a hosted deployment. */
                source?: components["schemas"]["PolicySource"];
                /** @description Only the policies of this kind. */
                kind?: components["schemas"]["PolicyKind"];
                /** @description Only the policies that govern this `tool_ref`: those whose targets name it, and those that target every tool. */
                tool?: string;
                /** @description Only the policies with a subject of this type. */
                subject_type?: components["schemas"]["PolicySubjectType"];
                /** @description Only the policies in this state. */
                state?: components["schemas"]["PolicyState"];
                /** @description The `meta.next` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of policies. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyListEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["ForbiddenEntitlement"];
            404: components["responses"]["NotAvailableOnDeployment"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    createPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PolicyWrite"];
            };
        };
        responses: {
            /** @description The draft policy. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotAvailableOnDeployment"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessablePolicyWrite"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The policy id. */
                id: components["parameters"]["PolicyId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The policy. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    updatePolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The policy id. */
                id: components["parameters"]["PolicyId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PolicyWrite"];
            };
        };
        responses: {
            /** @description The draft as written. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotAvailableOnDeployment"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessablePolicyWrite"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    listPolicyVersions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The policy id. */
                id: components["parameters"]["PolicyId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The versions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyListEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    simulatePolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The policy id. */
                id: components["parameters"]["PolicyId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SimulateRequest"];
            };
        };
        responses: {
            /** @description The decision the version would give, and what it considered. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SimulateEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessablePolicyForm"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    simulatePolicySet: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SimulateSetRequest"];
            };
        };
        responses: {
            /** @description The decision the proposed bodies and the policies in force would give, and what it considered. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SimulateEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessablePolicyWrite"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    publishPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The policy id. */
                id: components["parameters"]["PolicyId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The published policy. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotAvailableOnDeployment"];
            409: components["responses"]["ConflictPolicy"];
            422: components["responses"]["UnprocessablePolicyForm"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    retirePolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The policy id. */
                id: components["parameters"]["PolicyId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The retired policy, at its last published version. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotAvailableOnDeployment"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    discardPolicyDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The policy id. */
                id: components["parameters"]["PolicyId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The draft was discarded, or the policy that was never published was deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotAvailableOnDeployment"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    importPolicies: {
        parameters: {
            query: {
                format: components["schemas"]["PolicyFormat"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "text/plain": string;
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description The import report. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyImportEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotAvailableOnDeployment"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    exportPolicy: {
        parameters: {
            query: {
                format: components["schemas"]["PolicyFormat"];
            };
            header?: never;
            path: {
                /** @description The policy id. */
                id: components["parameters"]["PolicyId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The policy in the requested format. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotAvailableOnDeployment"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    listConnections: {
        parameters: {
            query?: {
                /** @description The `meta.next` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of connections. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionListEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    createConnection: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionWrite"];
            };
        };
        responses: {
            /** @description The connection. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["ConflictConnection"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The connection id. */
                id: components["parameters"]["ConnectionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The connection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    deleteConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The connection id. */
                id: components["parameters"]["ConnectionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The connection was deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    updateConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The connection id. */
                id: components["parameters"]["ConnectionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionPatch"];
            };
        };
        responses: {
            /** @description The connection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    discoverConnectionTools: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The connection id. */
                id: components["parameters"]["ConnectionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The discovered tools. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ToolListEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    authorizeConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The connection id. */
                id: components["parameters"]["ConnectionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionAuthorizeRequest"];
            };
        };
        responses: {
            /** @description Where to send the browser. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionAuthorizeEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotAvailableOnDeployment"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    linkConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The connection id. */
                id: components["parameters"]["ConnectionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionLinkRequest"];
            };
        };
        responses: {
            /** @description The registration, with the caller's link. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotAvailableOnDeployment"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    unlinkConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The connection id. */
                id: components["parameters"]["ConnectionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The caller has no link to the registration. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotAvailableOnDeployment"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    revokeConnectionConsent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The connection id. */
                id: components["parameters"]["ConnectionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Consent is revoked; the credential is kept. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotAvailableOnDeployment"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    refreshConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The connection id. */
                id: components["parameters"]["ConnectionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description What the refresh registered. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionRefreshEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    listTools: {
        parameters: {
            query?: {
                /** @description A connection id. Only the tools registered from this connection. */
                connection?: string;
                /** @description The `meta.next` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of tools. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ToolListEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    registerTool: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ToolWrite"];
            };
        };
        responses: {
            /** @description The registered tool. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ToolEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["ConflictToolLevel"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessableToolRef"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getTool: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The tool id. */
                id: components["parameters"]["ToolId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The tool. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ToolEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    updateTool: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The tool id. */
                id: components["parameters"]["ToolId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ToolPatch"];
            };
        };
        responses: {
            /** @description The tool. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ToolEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConflictToolLevel"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    listPrincipals: {
        parameters: {
            query?: {
                type?: components["schemas"]["PrincipalKind"];
                /** @description The `meta.next` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of principals. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PrincipalListEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    createAgent: {
        parameters: {
            query?: never;
            header?: {
                /** @description Replays within 24 hours return the original response and status. Never used on /consume or /resolve. */
                "Idempotency-Key"?: components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentWrite"];
            };
        };
        responses: {
            /** @description The agent. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessableIdempotency"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The agent id. */
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The agent. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    bindAgentPrincipal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The agent id. */
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentPrincipalWrite"];
            };
        };
        responses: {
            /** @description The agent, with its binding. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConflictPrincipalBound"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    unbindAgentPrincipal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The agent id. */
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The agent is not bound to any principal. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    createRun: {
        parameters: {
            query?: never;
            header?: {
                /** @description Replays within 24 hours return the original response and status. Never used on /consume or /resolve. */
                "Idempotency-Key"?: components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RunWrite"];
            };
        };
        responses: {
            /** @description The run. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            405: components["responses"]["MethodNotAllowedGoverned"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessableIdempotency"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The run id. */
                id: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The run. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    listWebhooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The webhooks. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookListEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    createWebhook: {
        parameters: {
            query?: never;
            header?: {
                /** @description Replays within 24 hours return the original response and status. Never used on /consume or /resolve. */
                "Idempotency-Key"?: components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebhookWrite"];
            };
        };
        responses: {
            /** @description The webhook. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookEnvelope"];
                };
            };
            400: components["responses"]["BadRequestCallback"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["UnprocessableIdempotency"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    deleteWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The webhook id. */
                id: components["parameters"]["WebhookId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The webhook was deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getOrigins: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The origins. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OriginsEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    putOrigins: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OriginsWrite"];
            };
        };
        responses: {
            /** @description The origins. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OriginsEnvelope"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getCapabilities: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The capabilities. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CapabilitiesEnvelope"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    getJwks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The JSON Web Key Set. It is not wrapped in the envelope, as RFC 7517 requires. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Jwks"];
                };
            };
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    edgeProtocolRead: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The edge protocol path. */
                path: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Defined by the edge protocol. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication failed. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The caller is not permitted. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found, or not served on this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    edgeProtocolWrite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The edge protocol path. */
                path: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Defined by the edge protocol. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication failed. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The caller is not permitted. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found, or not served on this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["ServiceUnavailable"];
        };
    };
    receiveWebhookDelivery: {
        parameters: {
            query?: never;
            header: {
                /** @description The id of the subscription this delivery is for. Not covered by the signature. */
                "NobleCloak-Webhook-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/cloudevents+json": components["schemas"]["WebhookDelivery"];
            };
        };
        responses: {
            /** @description Delivered. */
            "2XX": {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
