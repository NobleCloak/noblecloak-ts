# @noblecloak/react

## 0.8.4

### Patch Changes

- First release on the public npm registry. No code change: the versions step past the ones published to the organisation's package registry so that the public release is strictly newer.
- Updated dependencies
  - @noblecloak/client@0.11.1
  - @noblecloak/theme@0.1.2

## 0.8.3

### Patch Changes

- Updated dependencies [5cf6237]
  - @noblecloak/client@0.11.0

## 0.8.2

### Patch Changes

- 4c1eda2: Maps the contract's new problem codes `proposal_refused` and `policy_immutable` (rev 14) to the `invalid_request` kind, so the code table still equals the contract's registry. No component opens a proposal or authors a policy that names a deployment-applied reference.
- Updated dependencies [40c58bd]
  - @noblecloak/client@0.10.0

## 0.8.1

### Patch Changes

- d3d31fe: Maps the contract's new problem code `principal_bound` (rev 13) to the `conflict` kind, so the code table still equals the contract's registry. No component calls the agent-binding route.
- Updated dependencies [d427655]
  - @noblecloak/client@0.9.0

## 0.8.0

### Minor Changes

- 3e67ebe: Remove the `./audit` and `./principals` subpath exports. They were placeholders that exported only `MODULE_ID`; the
  Audit and Principals modules are not in v1, and the subpaths come back when the modules land.

## 0.7.1

### Patch Changes

- Updated dependencies [ed41848]
  - @noblecloak/client@0.8.0

## 0.7.0

### Minor Changes

- 2d6ebb9: Add the Connections module, `@noblecloak/react/connections` (now a client entry): `useConnections`, `useConnection`
  and `createConnectionsStore` over the `/v1` connections family (contract rev 11), and the `Connections`,
  `ConnectionDetail` and `AddConnection` components. It learns what a service offers from its capabilities alone
  (`connections`, `connections.oauth`, `connections.user_links`, `connection_registration`, `connection_transports`): an
  administrator registers a tool server (its URL is its tools' identity and cannot change), sees its state, refreshes
  and lists its tools (with what the server offers now beside them), renames it, rotates an organisation credential and
  deletes it; every person links a credential of their own to a `per_user` registration only after an explicit consent
  step, and can revoke that consent or unlink, each saying the tools stay available to others. An OAuth link or an
  organisation credential leaves the page for the authorization and comes back with `nc_connection`, `nc_result` and
  `nc_error`, which the module reads once and takes out of the address; it shows the result only for an authorization
  this browser started (a nonce kept in `sessionStorage` and added to the return page as `nc_state`; a service that
  drops that page's query completes the authorization and no result is shown) of a registration in its list, and in its
  own words only (no text of the address is shown). No credential is ever shown or kept: a token is typed into a
  write-only field and sent once. A caller the service refuses an administrator's change (403) is offered those changes
  no more; a principal still changes its own registrations.
- c5b7704: Connections: Reconnect wherever it makes sense. The list has a Reconnect action on every registration whose credential is not in use for the caller (its own link waits, stopped working or has its consent revoked; or, for an administrator, the organisation credential waits or stopped working): an OAuth authorization starts at once, and a token or consent to give opens the registration. An open registration offers "Authorize my link again" on a `linked` OAuth link and "Authorize the organisation credential again" on a `connected` `org_shared` OAuth registration (administrators), beside the existing replace-token, link-again and give-consent-again actions; both need a service that serves the rev 11 re-authorization. A registration shows when it was registered.

  `catalog` (on `Connections`) takes the host's presets (`ConnectionPreset`: name, URL, and optionally a description, transport, kind of authentication and OAuth scopes, issuer and client id), each a tile whose Connect opens the form filled in with it, marked Registered when a registration of that URL is listed. `AddConnection` takes one as `initial`. The module ships no presets.

- a106119: Permissions gains an "Effective access" view (`useEffectivePolicies`, `EffectiveAccess`, and a switch in
  `Permissions`): for each role and the organisation, and each tool, a dry run as that subject (contract revision 11
  `SimulateRequest.subject`) shows the decision and, where the service advertises `policies.tightest_wins`, the entries
  it marked `contributed` ("Set by"); without it the view lists what matched and claims no rule. Dry runs are sent only
  when the view is shown, for the rows on screen, at most four at once, cached per basis and published versions, and
  aborted on dispose. Simulating as a subject is an administrator's: the first refusal (403) ends the view with a note,
  a refused subject type (422) marks its column, and a host that passes `readOnly` gets no view and sends nothing. The
  basis is the published policies, or one draft as if published. `PolicyCapabilityFacts` gains `tightestWins` and
  `ConsideredEntry` gains `contributed`.
- 2cc1fd3: Permissions: host-supplied subject UI. `renderSubjects` (on `Permissions`) renders the host's own UI in the panel of policies for users, agents and groups, under its list, given a `SubjectSlotContext` (`controller`, that panel's `entries`, and `openPolicy(id)` to open a policy in the component's editor); the module renders nothing of its own there. `subjectLabel` (on `Permissions`, `PolicyEditor` and `PolicySimulation`; type `SubjectLabel`) gives a display name for a subject, shown beside its type and id, never instead of them, in that panel, the Suggested panel, the editor's subjects and a dry run's considered entries; `Permissions` passes it to the editor and dry run it opens. A label that throws or is empty is left out. Both are optional and call no service.
- aa48923: Add the Permissions module, `@noblecloak/react/permissions` (now a client entry): `usePolicies`,
  `usePolicyEditor`, `usePolicySimulate` and `createPoliciesStore` over the `/v1` policies family, and the
  `Permissions`, `PolicyEditor`, `PolicySimulation` and `ModeLegend` components. It learns what a service offers
  from its capabilities alone, shows for each role and tool the published policy that governs the pair (or that
  the deployment's default applies), and makes no claim about how policies combine. The stylesheet's element reset also
  covers tables, forms and `option`.

  Rulings (David, 2026-10-22):

  - All five modes are offered; `escalate` and `not_granted` are marked as ones a service may refuse, and its 422
    `detail` says why.
  - `ask` is worded as the contract has it: a step-up an eligible approver resolves, never the caller.
  - The ladder page (`docs/the-ladder.md`) makes no claim about how policies combine until the contract states one
    (revision 11): its `not_granted` and `deny` section gives only the decision and reason each maps to.
  - Suggested policies are rendered only (no adopt); `duplicate_requests` policies are read-only; the example's
    roles come from `NEXT_PUBLIC_NC_ROLES`.

- 722d367: Permissions gains a policy import/export panel, `PolicyRoundTrip` (also through `Permissions`' `roundTrip` prop),
  built on `@noblecloak/policy-formats`, which the host loads and passes in (`formats`, and `loadImporter` to import), so
  an app that does not use the panel never bundles or installs it, and only one that imports files loads the Cedar
  parser. Export writes Cedar (every published tool policy, or one policy, published or draft) or an AGT manifest
  (every published tool policy and the tool inventory, AGT 5.0 by default or main), shows the export report before the
  download and writes it at the top of the file. Import reads a pasted or chosen file, always shows its report, matches
  each policy to the organisation's by its policy key, shows what it would change against the pending draft or the
  published version, and saves a change as a draft with its `origin` (contract revision 11), which the editor then
  simulates and publishes; forms the service's `policy_forms` do not list are not offered for saving, and a 422 is
  shown through the module's problem display. Without authoring an import is shown and nothing is saved. The store gains
  `latest(id)` and `saveImported(write, { origin, id?, seen? })`; `PolicyInfo` gains `draftVersion` and `origin`, and
  `PolicyCapabilityFacts` gains `policyForms`.
- a9d3dfe: Permissions: retire a policy and discard a draft, where the service advertises `policies.retire` (rev 11). The store gains `retire(id)` (`POST /v1/policies/{id}/retire`: the policy leaves the lists at once, its pending draft with it) and `discardDraft(id)` (`DELETE /v1/policies/{id}/draft`: a published policy keeps its published version; one never published is deleted; given the draft the caller showed, a draft rewritten since is refused as `draft_changed`), refused without a request as `retire_not_offered` where the feature is not advertised and as `read_only` where authoring is off; a 403 turns authoring off as any write's does. `AuthoringState.canRetire` and `PolicyCapabilityFacts.retire` say whether they are offered; `PolicyDiscardResult` is the discard's outcome (`deleted` when the policy was never published). A policy the service answers 404 for, or that a list read no longer shows, leaves the store with its pending draft.

  The components offer them to an administrator, each after a confirm that says what it does (history kept; once the service's policy-cache interval has passed, a retired policy is not enforced and no new decision or approval names it; the published version stays in force when a draft is discarded): a cell whose published policy governs it alone has "No policy (retire it)…", returning it to no policy; the editor has Retire policy and Discard draft (`PolicyEditor` takes `onRemoved`, called with the sentence that reports a policy that is gone, and `Permissions` closes the editor with it); the Drafts tray has Discard. The "removal is not available" sentence is gone: the editor says the service does not offer retiring only where authoring is on and `policies.retire` is not advertised.

- 7530075: Permissions reads `Tool.status` (contract revision 11). A withdrawn tool keeps its row and its policies, marked
  "Withdrawn", and its cells are read-only: `setCell` on it answers the precondition `tool_not_callable` and sends
  nothing. A status the module does not know is kept and shown as sent, and, as the contract asks, the tool is treated
  as not callable, so its cells are read-only too. A published policy or a draft whose target
  names no listed tool is placed in `matrix.unplaced` with the new reason `target_not_listed` and those `toolRefs`, and
  the table lists it with its policy. The editor shows a policy's `unenforced_targets`.

### Patch Changes

- 3226475: `Approvals`: with the Pending/Recent tabs shown, the tabs row keeps its own height and the detail panel grows on its own (noblecloak-ui#55). The detail spans the module's first two grid rows, and the first row (the tabs) used to grow with a tall detail, opening a gap between the tabs and the queue; `styles.css` now gives the root `grid-template-rows: auto 1fr`, so only the second row takes what the detail needs. With no tabs, the first row is the queue, which likewise no longer grows with the detail.
- 8b78e53: Contract rev 11 (release `contract-v1-rev11`): policy provenance and lifecycle; connection registration, each user's own credential link with consent, the OAuth authorize step and refresh; tool status; approvals blocked on the link of the principal the call runs as; and the capabilities that say what a deployment does of each. Every member it adds is optional on the wire, so a rev 10 server's responses still validate against rev 11's schemas (it does not pass rev 11's new scenarios), with the narrowings listed below. A server must not emit a rev 11 member to a rev 10 runner: `nc-conform` rejects undeclared members by default.

  **Policies**

  - **What composed a decision.** Each entry of `ConsideredPolicies` may carry `contributed: true` when the deployment used it to reach `composed` (under the rule below, every approval-requiring entry of a step-up; false or absent otherwise). It names which entries determined the outcome, never an order among them.
  - **`policies.tightest_wins`**, a feature of either kind, states how a deployment composes `tool_invocation` policies: across every matched entry the tightest mode wins, `deny` over needs approval (`ask`, `escalate`) over `always_allow`; `not_granted` composes as `deny` (provisional); a mode is loosened only through an exemption the deployment defines. A default is a fallback, listed only when nothing of its kind matched. `Decision.policy` and `SimulateResult.policy` name one of the contributing entries, the deployment's choice; `considered` gives the set. A deployment that does not list the feature states no rule.
  - **Simulate as a subject.** `SimulateRequest.subject` (`role`, `user`, `agent` or `organization`; `agent` added before release, see the simulate-as-agent changeset) answers for a hypothetical holder of exactly that subject. Administrators only (403 `forbidden`); another type, or one the deployment cannot simulate, is 422 `unsupported_policy_form` naming `subject`. The caller stays the token's principal and nothing is recorded.
  - **Retire and discard**, behind the hosted-only feature `policies.retire`: `POST /v1/policies/{id}/retire` takes a published policy out of reads and lists (404 afterwards), keeps its versions with the new `Policy.retired_at`, and, within the policy-cache interval, stops enforcement and naming it on new decisions and approvals; retiring a policy never published is 400. `DELETE /v1/policies/{id}/draft` discards a published policy's pending draft (404 when there is none) or deletes a policy never published. Authoring rules apply (404 before 403).
  - **`Policy.draft_version`** names the pending draft of a published policy, on the read and on list rows.
  - **`Capabilities.policy_forms`** names the `tool_invocation` modes, subject types, `targets_all` and config members a deployment enforces; an advertised form is never refused with 422.
  - **Provenance of an import.** `PolicyWrite.origin` (`format`, `digest`: the lowercase hex SHA-256 of the file as imported) makes a create `source: imported`; `Policy.origin` is read only and per version, and `source` never changes after create.
  - **Approver groups.** A policy's `approver_groups` together form one approval requirement, met by any eligible member of any listed group (D-A90); the schema may grow per ADR-0049 §6c.4.

  **Connections**

  - **The registration.** `Connection` gains `status` (open: `connected`, `pending_authorization`, `degraded`; the registration's, never a user's link), `status_detail` (closed: `unreachable`, `credential_rejected`, `introspection_failed`), `last_verified_at`, `auth_kind` (`none`, `bearer`, `oauth`) and `credential_tier` (open: `org_shared`, `per_user`). `ConnectionWrite.auth` says how the server authenticates callers and never carries a credential. No operation returns a credential.
  - **Credential tier**, fixed at create and set by an administrator only: `per_user` (the default where `connections.user_links` is advertised) or `org_shared` (the default elsewhere). An `org_shared` + `bearer` registration needs the write-only `org_credential`, which an administrator rotates with `PATCH`; `org_shared` + `oauth` starts `pending_authorization`.
  - **Each user's own link** (hosted, `connections.user_links`): `POST /v1/connections/{id}/link` with `consent: true` (required; anything else is 400) and, for `bearer`, a write-only `token`; `DELETE …/link` removes it (204, idempotent); `DELETE …/link/consent` revokes consent and keeps the credential; either drops an authorization in flight. `Connection.my_link` is the caller's own link and nobody else's; no route reads another user's link, an administrator's included.
  - **Authorize** (hosted, `connections.oauth`): `POST /v1/connections/{id}/authorize` with `return_to` answers a single-use `authorization_url`, on the caller's own link (`per_user`, after linking with consent) or on the organisation credential (`org_shared`, administrators only). The browser returns with `nc_connection`, `nc_result` and, on an error, an `nc_error` code from a closed list; the deployment keeps `return_to`'s own query and adds the `nc_*` parameters to it.
  - **Refresh and discover.** `POST /v1/connections/{id}/refresh` registers what the server offers (an upsert; tools no longer offered become `withdrawn`; a reference already registered another way is left as it is) and reports `tool_count`, `added`, `removed`, `reactivated`. `discover` stays a live dry run.
  - **Visibility** is stated once, on `Owner`: a `principal`-owned connection is its owner's and administrators'; an organisation's is every member's.
  - **Delete** keeps the rev 10 sentence and adds: the tools become `withdrawn`, their policies remain and list them in `unenforced_targets`, registering the same server URL again makes them `active` under the same `tool_ref`, and every user's link goes with the registration.
  - **`Capabilities.connection_registration`** (owner kinds and who) and **`connection_transports`**.

  **Tools.** `Tool.status` (open: `active`, `withdrawn`; absent means `active`); a decision for a withdrawn tool is `deny` with reason `unknown_tool`. `?connection=` is described. `tool_ref` is a deployment-assigned stable reference that clients compare and never parse.

  **Approvals.** `Approval.blocked_on` (`reason`, open: `credential_link_required`; `connection_id`) tells the principal the call runs as (the run's owner; on a direct call, the creator), and no one else, on the single read and list rows (never a stream event), that the call waits on their own link; the deployment neither executes the call nor issues a Resumption (the read is 404) while it is present. A direct call with no usable link that opens no approval is `deny` with reason `credential_link_required`, which the vocabulary maps to `deny`.

  **New problem type:** `connection_exists` (409 on `POST /v1/connections`, with `Problem.connection_id` when the caller may read the existing registration).

  **Narrowings.**

  - A deployment may refuse a `principal`-owned registration, or a registration by a caller who is not an administrator, with 403, and says so in `Capabilities.connection_registration`.
  - On every deployment, whatever `connection_registration` says, `PATCH`, `DELETE` and refresh of an `org`-owned connection are an administrator's: any other caller is 403 `forbidden`. A `principal`-owned connection is changed by its owner and by administrators.
  - A `principal`-owned connection is read and listed by its owner and administrators only (`Owner`); any other caller gets 404.
  - `PATCH /v1/connections/{id}` with `url` is 400 `invalid_request`.
  - A connection URL with userinfo (`user:password@`) is 400 `invalid_request`: a URL carries no credential.
  - A second registration of the same server URL in an organisation is 409 `connection_exists`.
  - `credential_tier: per_user` where `connections.user_links` is not advertised is 400 `invalid_request`.
  - A transport the deployment does not list in `connection_transports` is 400 `invalid_request`.

  Conformance (the mock and `nc-conform` follow). New scenario files `26-policies-rev11.yaml`, `27-connections.yaml` and `28-connection-links.yaml`; a new `routes-connection-links` exercises the link routes and authorize as the administrator alone; `routes-connections` and `tenancy-connections-isolated` register as `admin` (and need `--admin-token`) with a URL of their own, and the tenancy scenarios cover refresh, retire, discard, link, consent and authorize. New fixtures, each an `unconfigured` skip without it: `admin_role` (`--admin-role`, a role the administrator holds), `connection_server_url` (`--connection-server-url`, a tool server the deployment can enumerate; the routes only its scenarios reach are an `unconfigured` coverage skip that names it) and `oauth_return_to` (`--oauth-return-to`). New scenario gates: `serves_connection_owner_kind`, `unserved_connection_owner_kind`, `connection_registration_who`, `serves_connection_transport`, `unserved_connection_transport`; the `features` list gains `policies.retire`, `policies.tightest_wins`, `connections.oauth` and `connections.user_links`; `advertises` gains `policy_forms`, `connection_registration` and `connection_transports`. A generated scenario creates every form a deployment advertises in `policy_forms`. The edge scenarios check that `policies.retire`, `connections.oauth` and `connections.user_links` are not advertised and that the new hosted routes, `my_link` and `blocked_on` are absent there.

  The mock: simulate composes tightest-wins (no longer most specific first), marks `contributed`, and names the simulated policy when it contributed; it simulates as a subject (a user with the roles of its latest token here), retires and discards, stores `origin`, and advertises `policies.tightest_wins` wherever it serves policies and `policies.retire`, `policy_forms`, `connections.oauth` and `connections.user_links` on hosted. Connections keep a status, a tier and a write-only organisation credential; a server's URL is its identity (scheme and host case, default port and trailing slash do not count); refresh and discover answer two canned tools whose references stay stable across delete and re-add; links are per caller; a consent page at `/__mock/consent/{id}` (with control on) completes an authorization and returns with the `nc_` parameters; `blocked_on` follows the creator's link. `nc-mock` gains `--restrict-connection-registration` and `--connection-transports`. New break flags, each with a row of the broken-mock matrix: `considered_contributed_missing`, `simulate_subject_unguarded`, `retire_unguarded`, `org_credential_echoed`, `connection_owner_visible`, `refresh_does_not_register`, `duplicate_server_accepted`, `patch_url_accepted`, `withdrawn_tool_allowed`, `connection_registration_not_enforced`, `org_connection_change_unguarded`, `undeclared_transport_accepted`, `connection_token_echoed`, `authorize_return_unchecked`, `link_without_consent_accepted`, `link_visible_to_other_user`, `consent_revoke_ignored`, `blocked_on_shown_to_others`, `every_entry_contributed`. New predicate `lacks_members` (no element of an array carries all of the given members).

  `@noblecloak/client`: regenerated from contract rev 11 (`PolicyOrigin`, `ConnectionAuth`, `OrgCredential`, `ConnectionLink`, `ConnectionLinkRequest`, `ConnectionAuthorizeRequest`, `ConnectionAuthorizeResult`, `ConnectionRefreshResult` and their envelopes, and the members above). Members added are optional, so code written against rev 10 types still compiles.

  `@noblecloak/react`: `PROBLEM_KINDS` maps `connection_exists` to `conflict`, so the module's error kinds stay equal to the contract's problem types.

- Updated dependencies [8d2f70d]
- Updated dependencies [cadb241]
- Updated dependencies [8b78e53]
- Updated dependencies [a3fe662]
- Updated dependencies [ea5f3f7]
- Updated dependencies [52347dd]
  - @noblecloak/client@0.7.0
  - @noblecloak/theme@0.1.1

## 0.6.1

### Patch Changes

- Updated dependencies [5545f4b]
  - @noblecloak/client@0.6.0

## 0.6.0

### Minor Changes

- b8f48d4: `@noblecloak/react`: bring your own components. `Approvals`, `ApprovalRequest` and `ActionStatus` now render their controls and panels with `@noblecloak/theme`'s primitives (`Button` for every button, the queue rows and the Pending/Recent toggles included; `Checkbox`, `Textarea`, `Alert`, `Card`, `Tabs`). A new client subpath, `@noblecloak/react/slots`, exports `NcProvider` (also `NcComponentsProvider`), `useNc`, `useSlot`, `defaultComponents` and the `NcComponents` type; each component also takes a `components` prop shaped like `labels`. A replaced `Button` replaces every button of every module, and `labels` is unchanged. `@noblecloak/theme` is now a dependency (one slot context for a builder's provider and the modules) and publishes in the same release. `styles.css` inlines the theme's primitive styles after its tokens (still one file, no import), so the look of the controls changes to the theme's, their focus ring included (the theme's 2px ring in `--nc-ring`, which falls back to the accent, where the module drew a 3px accent ring; the detail heading keeps the module's); the module's own plain elements are reset inside `.nc-root` so a host's element rules do not reach them; `code` and the call's JSON use `--nc-font-mono`. The import line and the eight `--nc-*` inputs are unchanged, and the theme's further `--nc-*` names now re-theme the modules too.

  `@noblecloak/theme`: `Tabs` toggles and the `DataTable` sort header render through the `Button` slot (their look is unchanged), `Tabs` takes `onReselect`, called when the pressed item is pressed again (the module uses it so choosing Recent again still re-reads it), `NcComponentsContext` and `useSlot` are exported, `components.css` is exported on its own, the entry carries `'use client'` (it calls `createContext`, which a React Server Component cannot import), and `NcComponentsProvider` keeps its merged map while its `components` and the enclosing map are unchanged, so consumers below it do not re-render with its parent.

### Patch Changes

- dd97825: `styles.css` is now built from `@noblecloak/theme`'s token CSS, inlined at build time: the import path, the eight `--nc-*` input names and their light and dark defaults are unchanged, and the stylesheet still has no import, no reset and no web font. It also declares the theme's additional internal variables, which no module rule reads yet, so no computed style of a module element changes.
- Updated dependencies [b8f48d4]
- Updated dependencies [a356619]
  - @noblecloak/theme@0.1.0

## 0.5.0

### Minor Changes

- f757ad4: Add the `action-status` module: `useActionStatus(approvalId)` and `<ActionStatus />`, the view of the principal that created an approval. It reports the state, who a pending approval waits on (`waiting_on`: named approvers, or a count only for a service-principal creator, or unknown), since when, what a denial does (`on_deny`, or "not stated" when the service omits it), and, once the approval is consumed, the outcome from the record it names (`outcome_record_id`), with "outcome not available" and a reason when there is none or it cannot be read (the failed read's `error` rides along; a 200 whose JSON is not this approval's record, which the same read would give again, is `malformed`, reported through `onFault` and not retried, while a failure status or a body that is not JSON is retryable). It follows the creator's own approvals over the existing stream and polling, and stops when nothing further can change. A ready status carries the approvals store's `connection` and a `stale` flag, true while an unsettled status may be out of date (the list or capabilities read failing, or the live updates stopped; not while the stream is still connecting), and the component then says "This status may be out of date."; a fault that ends the live updates is an `error` status whose `retry()` starts them again. `@noblecloak/react/action-status` is now a client entry (`'use client'`) and its hook and component are probed by the build for tree-shaking.

  In `useApprovals` too, an `onFault` that throws no longer loses the fault: it is reported as it would be without one.

## 0.4.2

### Patch Changes

- Updated dependencies [e2bee5b]
  - @noblecloak/client@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [1e76f7e]
  - @noblecloak/client@0.4.0

## 0.4.0

### Minor Changes

- dba4c19: Add `useApprovalRequest(id, options)` and `<ApprovalRequest id />` (or `<ApprovalRequest request />` for a hook result you already hold) to `@noblecloak/react/approvals`: read one approval request by id with no queue, stream or polling, and show it read-only (tool, digest, the call when the service allows it, requester, agent and parent, run, policy, timing, what it waits on, history). `useApprovals` behaves as before.

## 0.3.0

### Minor Changes

- e122c89: `createBrowserAuth` gains `scope?: string`, and the authorize request now carries it. The default is `approvals:resolve`, the scope a deployment that advertises contract rev 8's `Capabilities.user_resolve_scope` requires of a person's token to resolve, approve or deny an approval; before this change the request carried no `scope`. Pass `scope: ''` to send no `scope` parameter, or your own space-separated scope tokens to replace the default; a value that is not scope tokens throws `AuthError('invalid_scope')` at construction. Core drops a scope it does not issue (the token then carries no scope); another authorization server may refuse the sign-in with `invalid_scope`, in which case pass `scope: ''` or the scope it issues. A client that does not ask for the scope, such as the plugin, gets a token without it; whether Core restricts the scope per client is not decided here.

### Patch Changes

- Updated dependencies [e122c89]
  - @noblecloak/client@0.3.0

## 0.2.0

### Minor Changes

- 5234ad3: Approvals module against contract rev 6. A request shows who asked for it, and the agent, the approver and each entry of the history by name with the id beside it (the id alone when the service names none); a call that is not shown says why (`arguments_state`: the tool is not set to show its calls, the request carried only a digest, or you are not allowed to see it) and claims no reason when the service says none. The stream is opened with `approver=me`, but an event is only a prompt to read the filtered list, never a queue row by itself (a service may ignore the filter, and the contract does not say whether it applied it); a service that answers 400 to the parameter gets an unfiltered stream. A visible change for the person: a new request now appears after a short re-read of the list, not the instant its stream event arrives. The re-read waits 250 ms after the last event (at most 2 s of a steady stream) and the list read is what shows the row, because the module cannot know the stream was filtered. New on the controller, all optional so a host's own controller keeps compiling: `loadMore` (the queue grows by 50 to the 200 the service returns at once), `loadRecent` and `loadMoreRecent` with a `recent` snapshot member (the recently decided requests, newest decision first), and `approveMany(ids, shown)` (`shown`, the digests the person confirmed, is required, so no caller skips the check; an id without one is not sent; approves the chosen requests in calls of at most 50, only those whose `arguments_state` is `not_enabled` or `not_sent`, each with the digest its row had when the person confirmed; a request whose call could be read, or whose state is absent or withheld, is refused with `precondition`; it opens no detail). The component adds a "Recently decided" tab, "Show more requests" and "Show older", and, for a request that shows no arguments, a checkbox with "Approve selected" and a confirmation (every other row says in words why it has none). An error carries the problem's `reason` (a 503 `eligibility_lookup` is told as "could not check whether you may decide", not as unavailable), and the wait comes from `retry_after_seconds` when the browser cannot read `Retry-After`. `waiting_on` is shown from the single read only (nothing when absent, zero when zero), never from a list row or an event. Needs a contract rev 6 service for the filter, the recent view and the batch; against a rev 5 service the queue, the detail and the single approve and deny work as before, no batch approve is offered, the recent view reports the service's refusal and nothing is shown for a member the service did not send.

### Patch Changes

- 65f3e4f: What the package publishes. The README documents embedding, sign-in, the content-security policy and what an approver is and is not shown, and states the contract revision the package is built against. The published declarations no longer carry the test seams `createBrowserAuthWith` and `escapeInvisible` (marked `@internal`, stripped from the build), and `ApprovalsError` is one union that names no helper the package does not export. An import of only `useApprovals` now bundles no component: two top-level calls that kept the component and a date formatter in a bundle are marked pure.
- Updated dependencies [5234ad3]
- Updated dependencies [a9ce285]
  - @noblecloak/client@0.2.0

## 0.1.0

### Minor Changes

- f6402b1: The approvals store and hook. `@noblecloak/react/approvals` now exports `useApprovals(options)` and `createApprovalsStore(options)`; `useApprovals` returns the `ApprovalsController` that `<Approvals controller={…}/>` takes. The store holds the queue (`state=pending&approver=me`, first page, `truncated` when there is more), the stream (the module's own parser over `fetch`, never `EventSource`), the 401 rule (one forced `getToken` refresh and one retry, then `onSessionExpired`), the reconciliation of list and stream with tombstones and a 30-second suppression after `not_eligible`, the backoff and polling bounds, and the stream watchdog. Approve and Deny work only for the one open approval whose detail was read in this session; `arguments` are held in that open detail only and are stripped from every list, stream event and resolve response.

  Shared-contract changes in `approvals-types.ts`, all of them against the unreleased 0.0.0 draft types:

  - `ApprovalsErrorBase.cause?: unknown` is new (additive). It is set only on local `network` errors (`network`, `client_error`, `token_unavailable`) to name the exception behind a request that produced no response, and not on errors that came from a response.
  - `UseApprovalsOptions.onFault(fault)` is new (additive). It is called with a fault in a subscriber or in event handling, or with a bug the store met; without it the fault is reported with `reportError` where the runtime has one and written to `console.error` as `name: message` otherwise. `useApprovals` reads it when the fault happens, so adding or removing it after the first render takes effect.
  - `expectedActionDigest` is removed from `ResolveOptions`: **Breaking** for a caller of `approve` or `deny` that passed it. It stays on the store-only `resolve` call.
  - `ApprovalSummary` omits `continuation`, which only the single read returns: **Breaking**: a value typed `Approval` that has `continuation` is no longer assignable.
  - `ApprovalDetailState` gains `argumentsSource?: string` on `refreshing`, `loaded` and `resolved` (additive): the exact text of the `arguments` member of the single read, so a number is shown as it was sent and a repeated key is told.

  Two limits of what is shown. A duplicated tab shares `sessionStorage` and so one refresh-token family; the second tab to refresh ends with the "two tabs" message. The arguments are shown from the text that was sent where the browser lets `JSON.parse` read a number's source (Chrome 114, Safari 18.4, Firefox 135 and later), so `12345678901234567890`, `1.0`, `-0` and `1e400` appear as sent; where it does not, a number that a double may not hold exactly is announced and Approve and Deny stay off. A key that an object names twice is announced and keeps them off too. Integer-like keys still render in sorted order, as JavaScript orders them.

- f6402b1: Browser sign-in for the approvals module. `@noblecloak/react/auth` now exports `createBrowserAuth` and `useAuthState`, with `sessionStorageRefreshStore` (the default) and `memoryRefreshStore`, beside `AuthError` and the types. It is the authorization code flow with PKCE (S256 only) for a public client: `resource` is sent on every authorize request, no `scope` is asked for, the access token lives in memory only and the one refresh token in `sessionStorage` (tab-scoped) or in a store the host supplies. A refresh is single-flight and is never retried with a spent token; a replay, such as a duplicated tab, ends the session cleanly in `signed_out`. `signIn()` runs only when the host calls it, and a denied or failed consent is a state (`denied`, `error`), never a loop. `createBrowserAuth` throws `AuthError('invalid_target')` for a `resource` that is not an origin and `AuthError('redirect_uri_mismatch')` for a redirect URI that is not exact or not on the page's origin.

  `createBrowserAuth` throws `AuthError('server_error')` for an `issuer` that is not an absolute `https:` (or `http://localhost`) URL. `AuthError.code` is one of `signed_out`, `invalid_grant`, `network`, `server_error`, `invalid_target`, `redirect_uri_mismatch`, `state_mismatch`, `no_pending_request`, `missing_callback_parameters` and, new in this change, `metadata_unavailable`: a refresh could not load the sign-in service's metadata. It is a code of its own so that a caller can tell an outage from a session that ended: the token was not presented, the session and the stored refresh token are kept, and the call may be repeated. Metadata that names another issuer, an endpoint that is not https, or a `token_endpoint` or `revocation_endpoint` on another origin than the issuer is refused. A refresh response without a new `refresh_token` keeps the stored one (RFC 6749 section 6).

  `@noblecloak/react/approvals` and `@noblecloak/react/auth` start with `'use client'`; the other entries do not.

  `BrowserAuthOptions` gains an optional `onFault(fault)` (additive), called with a fault in a subscriber or in the `storage` the host supplied; without it the fault is reported with `reportError` where the runtime has one and written to `console.error` as `name: message` otherwise. A `storage.get()` that throws is treated as holding no token, so `signOut()` and `restore()` always complete.

- f6402b1: The approvals component. `@noblecloak/react/approvals` now exports `Approvals`, with the types `ApprovalsProps`, `ApprovalsLabelKey` and `ApprovalsLabels`. `<Approvals controller={…}/>` renders the queue and the open request from a controller (the shape `useApprovals` returns): the call is shown as inert, bounded text, or as its digest with a plain statement of which view it is; Approve and Deny are on only while the request is loaded, and approving a `delete` or `admin` call asks for a second click. `labels` replaces any string, `onSignIn` handles an expired session, and `@noblecloak/react/styles.css` styles it under `.nc-root` with the `--nc-*` custom properties and light and dark colours.
- 4d1d802: The approvals module's public types (`ApprovalsController`, `ApprovalSummary`, `ApprovalDetailState`, `ApprovalsError`, `ResolveResult`, `UseApprovalsOptions`, `ApprovalsStore`), the `./auth` entry with the sign-in types and `AuthError`, and the `./styles.css` entry. The package now depends on `@noblecloak/client` and has a peer dependency on `react` 19.

  `sideEffects` is now `["**/*.css"]` instead of `false`, so a bundler keeps the stylesheet import. The `./approvals` and `./auth` entries start with `'use client'`.

  `ApprovalsError` carries `type` (the problem document's `type` URI, verbatim) and `retryAfterMs` (from `Retry-After`, when the server sent one), and has a `malformed_response` kind for a response that arrived but could not be read as the contract's shape; a list that cannot be parsed surfaces as that error and never as an empty `approvals`.

### Patch Changes

- Updated dependencies [1d6b2ba]
  - @noblecloak/client@0.1.0
