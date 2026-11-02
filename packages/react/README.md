# @noblecloak/react

React governance modules for NobleCloak. Today the package ships four modules. **Approvals**: a person sees
the approval requests waiting on them, sees what the call is (or is told plainly that they cannot), and
approves or denies it with an optional reason. **Action status**: the person (or service) that opened an
approval sees where it stands, who it waits on, since when, what a denial does and, once it is used, what
came of it. **Permissions**: an administrator sees, per role and tool, the published tool policy that governs the
pair, edits a policy as a draft, runs it in dry run for themselves and publishes it (see "Embed Permissions" below).
**Connections**: an administrator registers the organisation's tool servers and refreshes their tools, and every
person links a credential of their own to a server, with consent they can revoke (see "Embed Connections" below).
Approvals has three parts, each usable on its own:

- a headless store and hook, `useApprovals`, that lists the requests waiting on the signed-in person,
  follows the live stream and approves or denies;
- one component, `<Approvals />`, the queue and the detail of one request;
- browser sign-in as a public client, `createBrowserAuth`, for apps that have no sign-in of their own.

It talks to the NobleCloak module API and needs nothing else of the server.

## Contract revision

Approvals and Action status are built for **revision 8 of the module API contract**; the package's tests run against
the mock server of this repository's `packages/spec`, which implements revision 15. Four things need a service of
revision 6 or later: the stream's `approver=me` filter, the recently decided view (`state` as a set and
`order=resolved_at`), approving several requests at once, and the names, `requester` and `arguments_state` an
approval carries. Revision 8 adds the scope a person's token needs to resolve (`Capabilities.user_resolve_scope`,
see the sign-in section). Revision 9 adds `Approval.on_deny`, an optional member the creator reads. The Approvals module neither reads nor
shows it, so a revision 9 service behaves as revision 8 there; Action status shows it (see below), and reads it
as "not stated" from a service that omits it. Against a revision 5 service the queue, the detail and the decisions work as before:
the stream is opened without the filter when the service refuses it (400), the new members are absent and show
nothing, and the new views report the service's refusal. The Permissions module needs a service of revision 10
(the policies family, `considered` on a simulation). The Connections module needs a service of revision 11 (status,
kind of authentication and credential tier on a registration, refresh, and, where advertised, the OAuth round trip
and each person's link); against an earlier service it lists registrations and reads their missing members as not
stated. This version is not tested against earlier revisions of the contract.

## Install

```sh
bun add @noblecloak/react        # or: npm install @noblecloak/react
```

`react` ^19 is a peer dependency (the only version tested). `@noblecloak/client`, the typed API client, and
`@noblecloak/theme`, the primitives the components render, are dependencies and arrive with it. Import from the
subpaths; the package root has no module in it.

| Import                            | What it holds                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@noblecloak/react/approvals`     | `useApprovals`, `useApprovalRequest`, `createApprovalsStore`, `Approvals`, `ApprovalRequest`, `MODULE_ID` and the types |
| `@noblecloak/react/action-status` | `useActionStatus`, `ActionStatus`, `MODULE_ID` and the types                                                            |
| `@noblecloak/react/auth`          | `createBrowserAuth`, `useAuthState`, `AuthError`, the refresh-token stores and the types                                |
| `@noblecloak/react/slots`         | `NcProvider`, `useNc`, `useSlot`, `defaultComponents` and the `NcComponents` type (see "Bring your own components")     |
| `@noblecloak/react/styles.css`    | the component's stylesheet, scoped under `.nc-root`; the hook and sign-in need none                                     |

## Embed it

`approvals` and `auth` are client modules (they start with `'use client'`), so under the Next.js App Router
use them from a client component. The component takes what `useApprovals` returns:

```tsx
'use client';

import { Approvals, useApprovals } from '@noblecloak/react/approvals';
import '@noblecloak/react/styles.css';

export function Inbox({ getToken }: { getToken: () => Promise<string> }) {
  const controller = useApprovals({ baseUrl: 'https://approvals.example.test', getToken });
  return <Approvals controller={controller} />;
}
```

- `baseUrl` is the approvals API's origin. The API is always on another origin than your page, so it must let
  your page's exact origin call it (cross-origin requests, with `Authorization`).
- `getToken` is called for each request and receives `{ forceRefresh }` after a `401`. Return an access token
  issued for the API's audience. Any sign-in of your own works; `createBrowserAuth` below is one.
- `onSessionExpired` runs when a refreshed token is refused too; the component then shows "Sign in again",
  which calls its `onSignIn` prop, or refreshes the controller when you give none.
- `labels` replaces any string of the component (a value may hold `{name}` placeholders). `className` and the
  `--nc-bg`, `--nc-fg`, `--nc-muted`, `--nc-border`, `--nc-accent`, `--nc-danger`, `--nc-radius` and
  `--nc-font-sans` variables style it; with none set the colours follow `prefers-color-scheme`, and
  `data-nc-theme="light"` or `"dark"` on an ancestor overrides that. The declarations that map these variables
  onto the module's internal tokens are `@noblecloak/theme`'s `tokens.css`, and the controls and panels are the
  theme's primitives, styled by its `components.css`; both are inlined into `@noblecloak/react/styles.css` when
  the package is built, so the stylesheet is still one file with no import. The theme's further `--nc-*` names
  (`--nc-surface`, `--nc-accent-fg`, `--nc-font-mono` and the rest; see `@noblecloak/theme`) re-theme them too.
  Inside `.nc-root` the module's own plain elements are reset to the browser's defaults, so a host's element
  rules (`h2 { ... }`, `* { all: unset }`) do not reach them; nothing outside `.nc-root` is touched. Only the
  module's markup is reset: an element with no class, a theme primitive, or one with an `nc-` class other than
  the classes the modules pass to a replaceable component (`nc-detail`, `nc-error`, `nc-tabs`, `nc-row`,
  `nc-toggle`). So an element a replacement component renders with its own classes keeps your rules, also when
  it merges in the class the module passes (`cn('my-card', className)`) and also when your rules are in a
  cascade layer (Tailwind v4); an element it renders with no class at all is reset like the module's own.
- `components` replaces the primitives the component renders; see "Bring your own components".
- Nothing runs at import and nothing needs `window` while rendering, so a server render is safe: the hook
  returns a constant idle snapshot there and starts work in the browser after hydration.

### Headless

`useApprovals` alone brings no component and no stylesheet: a bundle that imports only the hook contains
neither (the build asserts it). `createApprovalsStore(options)` is the same behaviour without React.

```ts
const { approvals, status, connection, detail, openDetail, approve, deny } = useApprovals({
  baseUrl,
  getToken,
});
```

- `approvals` is the first page of the requests waiting on the signed-in person (`state=pending` and
  `approver=me`); `truncated` says there are more. The list is the truth and the live stream a hint: the
  stream carries every request of the organisation, so each event leads to a re-list, and a list that cannot
  be read is an error, never an empty queue.
- `connection` is `connecting`, `live`, `polling` (the stream is down; the list is polled) or `offline`.
- A `503` is `unavailable`: retryable, with a backoff, and never shown as "not eligible" or as an empty queue.
  The module reads `Retry-After` (whole seconds or an HTTP date) from every non-2xx answer into
  `error.retryAfterMs`, and the built-in error message shows it for a rate-limited (`429`) error; the
  backoff for a `503` and for a failed list ignores it and uses its own schedule. Across origins a browser
  hands `Retry-After` to script only when the server lists it in `Access-Control-Expose-Headers`; otherwise
  `retryAfterMs` is absent.
- `approve(id, { reason })` and `deny(id, { reason })` answer `{ ok: true, approval }` or
  `{ ok: false, error }`; an API problem is returned, never thrown, and `error.requestId` is the id to quote.
  Decisions are confirmed by the server, not applied optimistically.

### One request on its own

`useApprovalRequest(id, options)` reads a single request by id, with no queue, no stream and no polling of a loaded request; an
`unavailable` read retries itself with backoff (`retryingInMs`). It takes the client and sign-in options of `useApprovals` (`baseUrl`, `getToken`, `fetch`, `onSessionExpired`,
`onFault`, and `enabled`, which reads nothing while false and leaves the status at `loading`), and returns the same detail state the queue's
open request holds, plus `retry()`. `onSessionExpired` runs once per refused session, like the queue's, and again after a read has succeeded. It reads again when `id` changes and drops a reply for the id it left.

```tsx
'use client';

import { ApprovalRequest, useApprovalRequest } from '@noblecloak/react/approvals';
import '@noblecloak/react/styles.css';

export function RequestPage({ id, getToken }: { id: string; getToken: () => Promise<string> }) {
  return <ApprovalRequest id={id} baseUrl="https://approvals.example.test" getToken={getToken} />;
}
```

To read the request yourself (for example to act on its status), pass the hook's result instead:
`<ApprovalRequest request={useApprovalRequest(id, options)} />`.

- `request.status` is `loading`, `loaded`, `resolved`, `not_found`, `unavailable`, `forbidden`, `unauthorized`
  or `error`. A failed read is never shown as empty or as not found. `retry()` reads again from
  `unavailable`, `error`, `forbidden` or `unauthorized`. The type is the one `<Approvals />` uses for its open
  request, which also has `refreshing`; this hook never reaches it, because a loaded request is not read again.
- Once read, `request.approval` carries the tool (`tool_ref`), `action_digest`, the requester, the agent and its
  parent, the run, the policy id and version, `continuation_kind`, `created_at`, `expires_at`, `waiting_on` and
  `resolution_history`. A field the service does not send is absent, and the component leaves it out.
- `request.arguments` is present only when the service sends the call to this person
  (`approval.arguments_state`); otherwise the component shows the digest and says the call is not shown.
- `<ApprovalRequest />` takes either `id` with the `useApprovalRequest` options, or `request` (a hook result), plus `className`, `labels` and `onSignIn`, as `<Approvals />` does. It is
  read-only: it has no Approve, Deny or Close. To decide a request, open it from `useApprovals`.
- `useApprovalRequest` alone brings no component and no stylesheet (the build asserts it, as for `useApprovals`).

## Action status

`useActionStatus(approvalId, options)` is the view of the principal that **created** an approval, keyed by the id
it holds. It takes the client and sign-in options of `useApprovals` (`baseUrl`, `getToken`, `fetch`, `enabled`,
`pollMs`, `reconcileMs`, `onSessionExpired`, `onFault`) and returns the status plus `retry()`. The creator is
usually a service principal, which is never an approver, so it follows its own approvals (`created_by=me`) and
not the approver queue.

```tsx
'use client';

import { ActionStatus } from '@noblecloak/react/action-status';
import '@noblecloak/react/styles.css';

export function Status({
  approvalId,
  getToken,
}: {
  approvalId: string;
  getToken: () => Promise<string>;
}) {
  return (
    <ActionStatus
      approvalId={approvalId}
      baseUrl="https://approvals.example.test"
      getToken={getToken}
    />
  );
}
```

To read the status yourself, pass the hook's result: `<ActionStatus status={useActionStatus(id, options)} />`.
The hook alone brings no component and no stylesheet (the build asserts it).

- `status` is `loading`, `ready`, `not_found`, `forbidden`, `unauthorized`, `unavailable` or `error`. A failed
  read is never shown as empty. `retry()` reads again after a failure, and again after an outcome that could not
  be read. A failure carries the read's `error`, and the component shows its request id (and, for `error`, the
  same sentence for its cause that `<Approvals />` uses).
- A session that ends on the stream or a list after the status was read stops the live updates, so the status is
  `unauthorized` (the host's `onSessionExpired` runs once) rather than a frozen `ready`; `retry()`, or the Sign in
  again button, starts them again once the host has a new session. Any other fault that ends the run (a bug in
  it, reported through `onFault` as `internal_error`) stops them the same way, so the status is `error` with that
  cause, and `retry()` (the Try again button) starts the run again. A settled status stays as it is.
- When `ready`, `connection` is the approvals store's connection (`connecting`, `live`, `polling` or `offline`, as
  `useApprovals` reports it; a settled status is `offline`, since its updates have stopped), and `stale` is true
  while a status that is not settled may be out of date: the list or capabilities read that would see a change
  is failing, or the live updates have stopped (`offline`). While one of those reads fails, the approvals store
  reads it again on the list's backoff (1 s doubling to 30 s), and `retry()` starts the run again
  at once. `connecting` is not out of date, since every mount starts there, and neither is `polling` while the
  list still reads. The component then says "This status may be out of date." under the state, so a pending or
  approved status is never shown as live when its reads are failing.
- When `ready`, `state` is the approval's state (`pending`, `approved`, `rejected`, `consumed`, `expired`,
  `withdrawn`), `since` is when it was created, and `refreshing` is true while it is read again (the last content
  stays).
- `pendingOn` (only while `pending`) says who it waits on: `{ kind: 'principals', count, principals }` for a user
  creator (up to five named approvers), `{ kind: 'count', count }` for a service-principal creator (a count only,
  which may be zero), and `{ kind: 'unknown' }` when the service did not say. It comes from `waiting_on`, which
  only the single read of one approval carries, so the hook reads that one approval again when a live event names
  it and only while it is pending.
- `onDeny` is `resume` or `halt` as the policy that matched stated it when the approval was created, and
  `not_stated` when the service omits it (a service that does not implement it, or a policy that states none).
  It is never guessed.
- `outcome` (only when `consumed`) is built from the outcome record the approval names (`outcome_record_id`,
  read with `GET /v1/records/{id}`) and holds the record's id, what it says happened (`result`: `succeeded`,
  `failed` or `unknown`) and when it was recorded, not the record. When the approval names no record, or the record
  cannot be read (403, 404, a failed request), it is `{ status: 'unavailable', reason }` (with the failed read's
  `error`, request id included, when a read failed) and the component says "Outcome not available" with the
  reason. A 404 is `not_found` whether or not its body is a problem document; any other failure status (a 408, a
  400, a 5xx) and a 200 whose body is not JSON (a proxy's page) are `unavailable`, and each has a Try again
  control. Only a 200 whose JSON is not a record for this approval this version can read (another record, another
  approval, an outcome status it does not know) is `reason: 'malformed'`: it is reported through `onFault`, and
  has no Try again control, since a record is never changed and the same read gives the same answer. Whether a creator may read its own outcome record is the service's rule
  and is not stated by the contract, so a 403 is shown, not assumed away.
  A record that states no `outcome` (the member is optional on a Record) is `{ status: 'unavailable', reason:
'no_outcome' }` and reads "the record states no outcome"; "Reported as unknown" is kept for a record that
  states `unknown` itself. A record is never changed, so `no_outcome` and `no_record` show no Try again control and
  `retry()` does not re-read a `no_outcome` record.
- A consumed approval that names no outcome record (`no_record`) is never settled: the stream and the periodic
  list keep running while the component is mounted, and the approval is read again on each list, because the
  record may be linked later. There is no bound or backoff on that wait. It is the cost of showing the outcome
  as soon as one is linked; a host whose consumers never record an outcome should unmount the component (or
  pass `enabled: false`) once the state is `consumed`.
- The creator reads over bearer tokens and the approvals routes, so the limits in `/v1/capabilities` stop it as
  they stop an approver: a deployment that requires DPoP (every bearer request is refused) or advertises no
  `resolutions` (the approvals family is not served), and one that serves no approvals at all (404), give
  `{ status: 'error', error: { kind: 'unsupported' } }`, shown as "This service does not support that action." with no
  Try again control.
- `settled` is true when nothing further can change: a denied, expired or withdrawn approval, or a consumed one
  whose outcome record was read, was refused, or could not be read (a network or server error). The stream and
  the polls stop then, and `retry()` (or the Try again button) reads the record again. An approved approval is
  not settled (it waits to be used), and neither is a consumed one that names no record yet. A gone approval
  (`not_found`), a deployment that does not serve it (`unsupported`) and an approval reply this version cannot
  read (`error` with `malformed_response`) also stop the stream and the polls; `retry()` reads the approval
  afresh. A gone approval has a Try again button, since it may be visible later (a lag, or access granted
  since); `unsupported` has none.
- `<ActionStatus />` is theme-slotted like `<Approvals />` (the stylesheet is `@noblecloak/react/styles.css`; the
  component imports none) and takes `approvalId` with the options, or `status`, plus `className`, `labels` and
  `onSignIn`. It is read-only.

## Sign in

`createBrowserAuth` is an OAuth 2.0 authorization-code flow with PKCE (S256) for a **public client**: no
client secret exists in a browser.

```ts
import { createBrowserAuth } from '@noblecloak/react/auth';

export const auth = createBrowserAuth({
  issuer: 'https://auth.example.test', // endpoints come from its metadata document
  clientId: '<the id of your registered public client>',
  redirectUri: 'http://localhost:3000/approvals/callback', // exact, on this page's origin
  resource: 'https://approvals.example.test', // the API's origin: the token's audience
});
```

- `useAuthState(auth)` gives the state: `signed_out`, `redirecting`, `completing`, `signed_in`, `denied` or
  `error`. **Nothing signs in by itself**: call `auth.signIn(returnTo)` from a click, never on mount and never
  after a denial, so a refusal cannot loop. On the redirect page call `auth.completeSignIn()` once; it removes
  the code from the address before it does anything else. On load, `auth.restore()` takes one refresh from a
  stored refresh token without a redirect.
- Pass `getToken: (options) => auth.getToken(options)` to `useApprovals`.
- A construction that cannot be right (an issuer or resource that is not an `https:` origin, or
  `http://localhost`; a redirect address that is not on this page's origin) throws `AuthError`, so a
  misconfiguration fails at once and not at sign-in.
- `scope` (optional) is what the sign-in asks for. By default `createBrowserAuth` asks for `approvals:resolve`
  (the contract's rev 8 `Capabilities.user_resolve_scope`): a deployment that advertises it answers a person's
  token that lacks it with 403 `insufficient_scope` when it resolves, approves or denies, and reads, withdrawals
  and consumption are not gated by this scope. That scope is why this module asks; a client that does not ask for
  it, such as the plugin, gets a token without it, so such a token can open and read approvals but cannot
  resolve them. Pass `scope: ''` to send no `scope` parameter (a sign-in that only reads), or your own
  space-separated scope tokens to replace the default. Core drops a scope it does not issue, and the
  token then carries no scope; another authorization server may refuse the sign-in with `invalid_scope` instead, in which
  case pass `scope: ''` or the scope it issues. Where the API gates the resolve, a token without the scope gets 403
  `insufficient_scope`. A refresh keeps the scopes of the
  original grant, so a tab signed in before the deployment issues the scope keeps a token without it; the module shows
  the generic "no access" text for that 403, and the person must sign in again (a fresh sign-in, not a refresh) to
  pick the scope up.
- **Sign-in errors.** A failure is an `AuthError` with a `code`, in the `error` state or thrown at construction:
  `invalid_target`, `invalid_scope`, `redirect_uri_mismatch`, `state_mismatch`, `missing_callback_parameters`,
  `no_pending_request`, `invalid_grant`, `metadata_unavailable`, `network`, `server_error` and `signed_out`.
  `invalid_target` means the `resource` is not a bare origin: it must be an absolute `https:` origin (or
  `http://localhost`) with no path, query or trailing slash, and `createBrowserAuth` throws it at construction.
  The same code appears in the `error` state when the sign-in service answers the redirect with
  `error=invalid_target`, meaning it does not accept that API as a target for this client; then the deployment
  is not configured for it, and retrying does not help. An API's own audience problem reaches
  `@noblecloak/client` as `wrong_audience` or `invalid_token`, not as an `AuthError`.
- The sign-in service shows its own consent page when the app asks for access, and asks **on every
  authorization**; the module remembers no grant. What the page says is the service's text, not the module's.
  Choosing "deny" there returns the page to `denied`, with a button to try again.

### What `sessionStorage` does and does not protect

The access token is kept in memory only and is gone on reload. The **refresh token** is kept in
`sessionStorage` (under `nc.auth.refresh.<clientId>`) so that a reload in the same tab restores the session
without a new sign-in; it is scoped to that tab and cleared when the tab closes. Where `sessionStorage` is
missing or refuses a write (some private-browsing modes, a full quota), the default store keeps the refresh
token in memory instead, and a reload then signs in again. Either way the token stays with the one tab,
which keeps it from another tab, another window and a later visit. It does **not** protect against script running in your page: any
script that executes there can read `sessionStorage` exactly as it can read memory. The defence is a
content-security policy (next section) and keeping third-party script out of the page. The refresh token is
single-use: the service rotates it on each refresh and revokes the whole family if an old one is replayed. A
duplicated tab copies `sessionStorage`, so two tabs can share one family; the second to refresh ends in the
signed-out state with a message, not in a loop. To keep the refresh token somewhere else, give
`storage` a `RefreshTokenStore` (`memoryRefreshStore()` keeps it in memory only, so a reload signs in again).

## Content-security policy

The module needs no `'unsafe-inline'` and no `'unsafe-eval'`, and no inline style: it renders no `style`
attribute, and the stylesheet is a file. A policy that fits it, in the shape the example app sends with a fresh
nonce on each response:

```text
default-src 'self'; script-src 'self' 'nonce-<nonce>'; style-src 'self' 'nonce-<nonce>';
connect-src 'self' <the API's origin> <the issuer's origin>; object-src 'none'; base-uri 'self';
form-action 'self'; frame-ancestors 'none'
```

- `connect-src` must list the API and the issuer: the module calls the API (list, read, resolve and the
  stream, which is a `fetch` with a bearer token, not `EventSource`) and the issuer's metadata, token and
  revocation endpoints. Every request is sent with `credentials: 'omit'`.
- The authorization request is a top-level navigation to the issuer, so `form-action` and `connect-src` need
  no entry for it.
- Give the redirect page `Cache-Control: no-store` and `Referrer-Policy: no-referrer`: its address holds the
  authorization code until the module removes it.

## What an approver is and is not shown

For what an approval itself covers (one call, one scope, used once), see "What an approval covers" (`docs/what-an-approval-covers.md` in the repository).

The person decides on a **fresh read of that one request**, and what the read returns is all the person gets.

- **The queue** shows the tool, its side-effect level (as a word, never by colour alone), the first 12
  characters of the digest, who asked for it and how long ago it was made. A queue row never carries the
  call's arguments: the module removes them from anything the list, the stream or a decision returns. The
  queue shows more of itself on request ("Show more requests", in steps of 50 up to the 200 the service
  returns at once), and a "Recently decided" tab lists the requests decided lately, newest decision first, with
  who decided each. **"Approve selected"** is offered only for a request that shows no arguments: its
  `arguments_state` is `not_enabled` (the tool does not show its calls to approvers) or `not_sent` (the
  agent sent only a digest), so there is nothing an approver could have been shown. Every other row has no
  checkbox and says why in words: it has a call to read, it is withheld from you, or the service did not say
  (an absent `arguments_state` is unknown, as from a service that predates it). Those are opened and decided
  one at a time, so a person never approves arguments they were not shown. The ticked requests go in one call,
  each with the digest its row had when you confirmed. A request that changed since then is not approved:
  the module does not send it if it already knows of the change, and otherwise the server refuses the old
  digest with 409. Either way it counts as not approved and is never approved with the new digest. The
  controller refuses a row that is not eligible with `precondition`, and the page sends no batch request for it. `approveMany(ids, shown)`
  takes `shown`, the digests the person confirmed, as a required argument, so every caller states what the person
  saw; an id with no entry in it is not sent (it answers `conflict`). Against a rev 5
  service no row is eligible, so the control is absent and the single approve and deny work as before.
- **The detail** is read on its own: selecting a row reads that request again, every time, and **Approve and
  Deny are disabled until that read has loaded**. The store enforces this, not only the component: a decision
  for a request whose detail is not open and loaded is refused locally, with no network call. The digest sent
  with a decision is the digest of the read the person saw. If the request changes while it is open (a new
  digest, or another state), the detail re-reads it once and shows that it changed; a changed digest needs one
  acknowledgement before the buttons come back. A request that is no longer pending shows its outcome and
  history and no buttons.
- **The call** is shown in one of two ways, and the page says which, in words:
  - the full call, headed "The full call, as returned for this request" (when the server returned the
    arguments: the tool is registered to show them to approvers and the reader may see them);
  - the digest alone, with the whole digest and a copy button, and the reason when the service gives one
    (`arguments_state`, contract revision 6): "This tool is not set to show its calls to approvers", "The
    request that opened this approval did not carry the call itself", or "The call itself is not shown to
    you". When the service gives none (an older service, or a state this version does not know), the wording
    is "The arguments of this call are not shown to you. You are approving the call identified by this
    digest." and claims no reason.

  Arguments are untrusted. They are shown as text only (no HTML, no markdown, no links), pretty-printed with
  keys in the order received, and bidirectional controls, zero-width and other invisible characters are shown
  as an escape (`\uXXXX`, or `\u{XXXXX}` above U+FFFF) so a value cannot reorder or hide what is read. A long call is cut with a control to show more;
  **a call that cannot be shown whole (too deep, too long, a repeated key, a number that does not survive
  parsing) leaves Approve and Deny disabled**. Nothing is ever shown as a summary written by the agent.

- **Also shown**: who requested it, the agent (by name when the service gives one) and its parent, the run, the
  scope, the policy and its version (when the request carries one), what the approval is for, how the call
  continues, when it was created and when it expires, and its history. A person is shown by the name the
  service gives with the id beside it ("Ada Lovelace (user_ada)"), and by the id alone when it gives no name:
  a name is whatever the service says, so the id is never dropped. Names are text like any other value the
  service sends.
- **Never shown**: the continuation, the outcome record and any member the module does not list, so a field a
  later revision adds cannot break or change what is rendered.
- **Actions**: a `delete` or `admin` call asks for one more confirmation. A decision that the server refuses
  is explained in plain words, with the request id: not eligible (a person made an approver moments ago may be
  refused briefly), already decided, expired, not found, or the service is unavailable (retry; when the service
  says the cause is its check of who may decide, the page says that, and the wait it names). The wait is read from
  the `Retry-After` header when the browser can read it and otherwise from the problem's `retry_after_seconds`.

## Bring your own components

Every control and panel the components render is one of `@noblecloak/theme`'s primitives, named by its role:
`Button` (every button, the queue rows and the Pending/Recent switch's toggles included), `Checkbox`,
`Textarea`, `Alert` (the error blocks), `Card` (the open request) and `Tabs` (the Pending/Recent switch). Give
your own component for a role, and every element of that role in every module uses it, with no other change:

```tsx
'use client';

import { ActionStatus } from '@noblecloak/react/action-status';
import { Approvals } from '@noblecloak/react/approvals';
import type { ApprovalsController } from '@noblecloak/react/approvals';
import { NcProvider } from '@noblecloak/react/slots';
import type { NcComponents } from '@noblecloak/react/slots';
import type { ButtonProps } from '@noblecloak/theme';

/** Your button: it drops the theme-only props, adds its class to the module's and passes the rest on. */
function MyButton({ variant, size, loading, disabled, className, ...props }: ButtonProps) {
  return (
    <button
      className={['my-button', className].filter(Boolean).join(' ')}
      disabled={disabled === true || loading === true}
      {...props}
    />
  );
}

const components: Partial<NcComponents> = { Button: MyButton };

export function Inbox(props: {
  controller: ApprovalsController;
  approvalId: string;
  getToken: () => Promise<string>;
}) {
  return (
    <NcProvider components={components}>
      <Approvals controller={props.controller} />
      <ActionStatus
        approvalId={props.approvalId}
        baseUrl="https://approvals.example.test"
        getToken={props.getToken}
      />
    </NcProvider>
  );
}
```

- Each component also takes a `components` prop of the same shape, like `labels`:
  `<Approvals components={{ Button: MyButton }} />`. The prop wins over an enclosing `NcProvider`, an inner
  provider over an outer one, and a role you leave out keeps the theme's primitive.
- A replacement receives the primitive's props (`MyButton` gets `ButtonProps`: the native button props, a `ref`
  among them, plus `variant`, `size` and `loading`) and must pass on the ones that make the module work: the
  `onClick`, `disabled`, `aria-*` attributes (`aria-pressed`, `aria-current`), the `ref`, which the module uses
  to move focus, and the `className`, which the module lays out the queue rows, the Pending/Recent toggles, the
  open request and the error blocks by (`nc-row`, `nc-toggle`, `nc-detail`, `nc-error`, `nc-tabs`). Merge it
  with your own classes rather than replacing it, as `MyButton` does; the module's reset leaves an element
  carrying those classes to your rules (see "Embed it"). A replacement `Alert` must pass on `role`: the modules
  give every error block `role="alert"` themselves, so a replacement that spreads its props keeps the error
  announced.
  `defaultComponents` is the shipped map, to spread under a replacement or to wrap one.
- `useNc()` returns the map in force where it is called and `useSlot(name, fallback)` one role, so your own
  components can render the same replacements. Both are client-only, like the provider.
- `labels` is unchanged and separate: replacing a component never changes a string. When a part fails to
  render, its fallback message keeps the default words and the theme's own frame; its retry button is your
  `Button`, or the theme's when yours throws, so a failing replacement stays inside the module too.
- A replacement `Tabs` gets `onReselect` as well as `onValueChange`: call it when the pressed toggle is pressed
  again, which is how choosing "Recently decided" again reads that list again.
- `@noblecloak/react/slots` re-exports `@noblecloak/theme`'s provider, so a provider from either package reaches
  the modules: there is one context. The import line of the stylesheet is unchanged.

## Embed Permissions

`@noblecloak/react/permissions` reads the `/v1` policies family. Its hook learns what the service offers from
`GET /v1/capabilities` alone: without the `policies` family the component shows that policies are not offered here;
without `policies.author` it is read-only; without `policies.publish` drafts are shown with their version and no
Publish control.

```tsx
'use client';
import { Permissions, usePolicies } from '@noblecloak/react/permissions';

export function PolicyTable({ getToken }: { getToken: () => Promise<string> }) {
  const policies = usePolicies({
    baseUrl: 'https://govern.example.test',
    getToken,
    roles: [{ id: 'member' }, { id: 'admin', label: 'Administrators' }],
  });
  return <Permissions controller={policies} />;
}
```

- `usePolicies` returns the lists, the role × tool `matrix`, the drafts and whether authoring is on, plus
  `setCell`, `create`, `publish(id, shown)`, `retire(id)`, `discardDraft(id, shown?)`, `editor(id)` and `simulation(id)`. `usePolicyEditor(policies, id)` and
  `usePolicySimulate(policies, id)` bind one policy's editor and dry run; `createPoliciesStore` is the store without
  React. `useEffectivePolicies(policies)` binds the effective view. The components are `Permissions`,
  `PolicyEditor`, `PolicySimulation`, `EffectiveAccess`, `PolicyRoundTrip` and `ModeLegend`; every word is in their `labels`, and every
  control renders through the slots.
- A cell shows the published policy that governs the pair (mode, name, version, author), or "No policy" and that the
  deployment's default applies. What the five modes mean on the wire is in
  [The ladder](../../docs/the-ladder.md).
- **Host-supplied subject UI.** `renderSubjects` renders the host's own UI in the panel of policies for users, agents
  and groups, under its list, given `{ controller, entries, openPolicy }`; the module renders nothing of its own
  there, and what the host renders authors through the controller. `subjectLabel(subject)` gives a display name the
  module shows beside a subject's type and id (never instead of them) in that panel, the Suggested panel, the editor
  and the dry run; `PolicyEditor` and `PolicySimulation` take it too. Both are optional and the module calls no service for them.
- Import and export as Cedar or an AGT manifest: pass `roundTrip={{ formats, loadImporter? }}`, the converter
  `@noblecloak/policy-formats` loaded by your app (this package does not depend on it, so an app without the panel
  never bundles it). See [Importing and exporting tool policies](../../docs/policy-import-export.md).

Known limits:

- **Roles come from the host.** Columns are the `roles` you pass, the roles the policies name and, where the service
  lists principals, its roles; neither the reference mock nor every deployment lists roles.
- **Effective access** ("Effective access", `useEffectivePolicies`) is for administrators: it runs a dry run as each
  role and the organisation, which the service refuses to anyone else (after one refusal the view shows a note; a
  host that passes `readOnly` gets no view and no request). It names what set a cell only where the service
  advertises `policies.tightest_wins`. It needs a published policy to run the dry run against, and it runs at most
  four at once, for the rows on screen.
- **Retire and discard** need a service that advertises `policies.retire` (`authoring.canRetire`): a cell whose
  policy governs it alone offers "No policy (retire it)", the editor offers Retire and Discard draft, and the Drafts
  tray Discard, each after a confirm. Elsewhere the editor says the service does not offer them.
- **Paging.** Lists are read page by page through `meta.next`; a service that pages with another member is read as
  one page.
- **A pending draft** of a published policy is known only once read (opening the policy, or a cell or tray action).
- **Withdrawn tools** (`Tool.status: withdrawn`, contract revision 11) keep their row and their policies, marked
  "Withdrawn"; their cells write nothing, and a policy is edited as a whole in the editor. A status the module does
  not know is shown as sent and treated as not callable, as the contract asks. A policy target the tool
  list does not show is listed with its policy under "Policies this table cannot place", and the editor lists the
  targets the service says it does not enforce (`unenforced_targets`).

## Embed Connections

`@noblecloak/react/connections` reads the `/v1` connections family. Its hook learns what the service offers from
`GET /v1/capabilities` alone: without the `connections` family the component shows that connections are not available
here; without `connections.oauth` it offers no OAuth; without `connections.user_links` it shows no "my credential"
part; `connection_registration` and `connection_transports` narrow the form to the owner kinds and transports served.

```tsx
'use client';
import { Connections, useConnections } from '@noblecloak/react/connections';

export function ToolServers({ getToken }: { getToken: () => Promise<string> }) {
  const connections = useConnections({ baseUrl: 'https://govern.example.test', getToken });
  return <Connections controller={connections} />;
}
```

- `useConnections` returns the registrations, the capabilities it read, the registrations with a change in flight
  (`pending`) and whether the administrator's changes are offered, plus `create`, `rename`, `refresh(id)`,
  `remove(id)`, `rotateOrgCredential`, `link(id, { consent: true, token? })`, `unlink`, `revokeConsent`, `authorize`
  and `detail(id)`. `useConnection(connections, id)` binds one registration's registered tools and, after
  `discover()`, what its server offers now beside them. `createConnectionsStore` is the store without React. The
  components are `Connections` (the list, the form and the open registration), `ConnectionDetail` and
  `AddConnection`; every word is in their `labels`, and every control renders through the slots.
- **Reconnect.** The list offers Reconnect where the caller's credential is not in use (an OAuth authorization starts
  at once; a token or consent opens the registration), and an open registration offers authorizing again, replacing a
  token, linking again and giving consent again. `catalog` takes the host's presets (`ConnectionPreset`), each a tile
  that opens the form filled in with it; `AddConnection` takes one as `initial`.
- **Return handling.** `authorize` sends the browser to the authorization server through `onNavigate` (default
  `window.location.assign`) and asks it to come back to `returnTo` (default: the current page) with a nonce of its own
  added as `nc_state`, which it keeps in `sessionStorage`. On return, the store reads `nc_connection`, `nc_result` and
  `nc_error` once, keeps them as `lastReturn` only when the nonce and the registration match the authorization this
  browser started and the registration is in the list, and takes any of them out of the address. The component says
  the result in its own words; it never shows text from the address. This relies on the service keeping the query of
  `returnTo` when it adds the `nc_*` parameters; where it does not, the authorization still completes and no result is
  shown.
- **No credential** is shown or kept: tokens are typed into write-only fields and sent once, and a person sees only
  their own link. What connections are, owner and visibility, the tiers and why OAuth leaves the page are in
  [Connections](../../docs/connections.md).

Known limits:

- **Who is an administrator** is learned from the service: the module offers the administrator's changes until a
  change is refused with 403, then stops offering them. Pass `readOnly` when the app already knows.
- **No roster.** Who has linked a credential is not shown, administrators included; the contract has no such read.
- **Approvals blocked on a link** (`Approval.blocked_on`) are not shown here; that belongs to the Approvals module.

## Client-only entries

`@noblecloak/react/approvals`, `@noblecloak/react/action-status`, `@noblecloak/react/auth`, `@noblecloak/react/slots`, `@noblecloak/react/permissions` and `@noblecloak/react/connections` start with a `'use client'` directive, so
under the Next.js App Router everything they export, `MODULE_ID` and `AuthError` included, is a client
reference in a server component. A server component cannot read `MODULE_ID` as a string or test
`instanceof AuthError`; do that in a client component. The other entries have no directive.

## Example

`examples/next-app` in this repository is a complete Next.js App Router app that embeds the Approvals,
Permissions and Connections modules, signs in
and carries a content-security policy. It also runs against the reference mock server with no sign-in
service. Its README has the steps.

Licensed under Apache-2.0; see the repository `LICENSE` and `NOTICE`.
