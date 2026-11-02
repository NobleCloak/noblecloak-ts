# NobleCloak example app

A Next.js (App Router) app with the Approvals, Permissions and Connections modules embedded: `/approvals` is the
queue and the detail of one request, `/approvals/callback` is where sign-in returns; `/permissions` is the role ×
tool table of tool policies with its editor and dry run, and `/permissions/callback` its sign-in return;
`/connections` lists the registered tool servers, registers one, refreshes its tools and links the person's own
credential with consent, and `/connections/callback` is its sign-in return. `/` and `/api/health` are the fixture
the NobleCloak skills and end-to-end tests run against.

The permissions page takes the roles to show as columns from `NEXT_PUBLIC_NC_ROLES` (comma-separated role keys),
before the roles the policies name: neither the mock nor every deployment lists roles. In mock mode it uses the
mock's `admin` token, which may author policies. Its sign-in returns to `/permissions/callback`, named by its own
`NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI`, so each page's sign-in lands on its own route. The connections page does
the same with `NEXT_PUBLIC_NC_CONNECTIONS_REDIRECT_URI`, and in mock mode it too uses the mock's `admin` token. An
OAuth link on it leaves for the authorization and returns to the page, so the API must admit this app's origin for
that return (the mock admits the origins it lets call it). Each route builds its own sign-in object, so an app that
uses several in one tab has several over the same session storage; sharing one is a later step.

The app runs on **http://localhost:3000** and only there: `dev` and `start` pass `-p 3000`, which also stops
Next from moving to another port when 3000 is taken. The sign-in's redirect address and the origin the API
lets a browser call are both that exact origin.

## What this shows

An agent calls a governed tool and NobleCloak decides `step_up`: a person must approve this exact call. The
request appears in the queue of the Approvals module, which this app embeds. You read the call, approve or
deny it, and the agent consumes the approval and acts once. The demo here plays the agent with `@noblecloak/client` (`e2e/demo.ts`): it checks the resumption, consumes it and counts one refund (it runs no tool); the
steps are in [Your first governed tool](../../docs/how-to/first-governed-tool.md).

## Run it against the mock in five minutes

Two terminals. The mock must be on `127.0.0.1:8787`, and it must let this app's origin call it.
`start:demo` does both and leaves an approval pending: the mock, the refund tool registered and an agent
(`e2e/demo.ts`, through `@noblecloak/client`) holding a refund until a person decides. Use `127.0.0.1:8787` as the API address, the address the mock
prints: the mock listens on `127.0.0.1` only, so a `localhost` that resolves to the IPv6 `::1` cannot
connect to it.

From the repository root:

```sh
bun install
bun run build                                                # builds the workspaces
bun run --cwd examples/next-app start:demo                   # leave it running
```

It prints `{"event":"browser_ready","api":"http://127.0.0.1:8787","open":...,"approval_id":"..."}` and then
waits. In a second terminal, from the repository root:

```sh
cd examples/next-app
NEXT_PUBLIC_NC_MODE=mock NEXT_PUBLIC_NC_API_URL=http://127.0.0.1:8787 bun run dev
```

Open http://localhost:3000/approvals. In mock mode there is no sign-in: the page takes the `approver` token
from the mock and says so in a **Mock token** banner. Then:

1. The refund request is in the queue within a couple of seconds, and the page says it is live.
2. Select it. The detail says **Loading the request...** and offers nothing to decide with until the call has
   been read; then **Approve** and **Deny** are enabled, and the call's arguments (order `A-7`) are shown.
3. Click **Approve**. The page says **Approved. The request has left your queue.**
4. In the first terminal `start:demo` prints its events, including `worker_resumed`, and exits 0. It exits 0
   only when the outcome matches the decision: after an Approve, the approval was consumed and exactly one
   refund was issued; with `NC_DECISION=deny`, the approval ended rejected and no refund was issued.

## Run it against a deployment

You need a deployment with Approvals enabled for your organisation, its sign-in service, and a person who is
accepted as an approver. The placeholder origins below are `https://govern.example.test` (the API) and
`https://auth.example.test` (the sign-in service); use your deployment's.

1. **Register the public client**, once per deployment, by the operator. The id is not a secret, and a
   registration is permanent, so do not repeat it on each start. From `packages/react`:

   ```sh
   bun run register-client --issuer https://auth.example.test \
     --redirect-uri http://localhost:3000/approvals/callback
   # {"issuer":"https://auth.example.test","client_id":"..."}
   ```

2. **Configure the app.** Copy `.env.example` to `.env.local` and fill in the four variables (leave
   `NEXT_PUBLIC_NC_MODE` unset: unset means sign-in):

   ```sh
   NEXT_PUBLIC_NC_API_URL=https://govern.example.test       # the API's origin: no path, no trailing slash
   NEXT_PUBLIC_NC_ISSUER=https://auth.example.test
   NEXT_PUBLIC_NC_CLIENT_ID=<the client_id from step 1>
   NEXT_PUBLIC_NC_REDIRECT_URI=http://localhost:3000/approvals/callback   # exactly this page
   ```

   The API address, the issuer and the redirect address must be `https`, or `http://localhost` for local
   work; `http://127.0.0.1` is refused in sign-in mode; the redirect address is exact, with no query, fragment or wildcard. The app tells you which
   variable is wrong. The values are inlined when the app is built, so another deployment is another build:
   `bun run build` then `bun run start` (or `bun run dev`).

3. **The scope.** The sign-in asks for `approvals:resolve`, which a person's token needs to approve or deny.
   Check that it is the scope your deployment advertises as `user_resolve_scope`:

   ```sh
   # $TOKEN: the approver's access token (on the mock either token works)
   curl -s -H "Authorization: Bearer $TOKEN" https://govern.example.test/v1/capabilities
   ```

   If the deployment names another scope, pass it as `scope` to `createBrowserAuth` in
   `app/approvals/auth.ts`.

4. **Something to approve.** Run an agent that creates an approval in the same organisation, through
   `@noblecloak/client` with a service principal your deployment's administrator issues. `e2e/demo.ts` is the
   smallest one (it runs against the mock); the LangGraph adapter's repository,
   [`noblecloak-langgraph-ts`](https://github.com/NobleCloak/noblecloak-langgraph-ts), has a worked example
   against a deployment.

Open http://localhost:3000/approvals and click **Sign in**. Signing in is always a click: nothing signs in
on load, and a denial or an error stays on the page with a **Try again** button. Once the deployment's
consent step is enabled (it is off today), it will ask you to let this app read and decide the approval
requests waiting for you; its text is the deployment's, not this app's.

## Troubleshooting

| You see                                         | Why                                                                                                                                                                                                                                                                                                                                                              | Fix                                                                                                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A page naming a variable that is wrong or unset | `NEXT_PUBLIC_*` is read when the app is built, and one is missing or malformed, including an API address that is not a bare `https` or `http://localhost` origin (in sign-in mode). The settings check runs first, so this page, not an `AuthError`, is what the app shows; `AuthError` `invalid_target` appears only when calling `createBrowserAuth` directly. | Fix `.env.local` and build again; a running `dev` server needs a restart. Use scheme, host and port only: no path, query or trailing slash.                                                            |
| `403 insufficient_scope`                        | The person's token lacks the scope in `user_resolve_scope`, so a resolve is refused (reading the queue still works).                                                                                                                                                                                                                                             | See step 3 above; sign out and in again after changing the scope.                                                                                                                                      |
| `403 not_eligible`                              | The signed-in person may not resolve this approval: they are not an accepted approver, or they created it.                                                                                                                                                                                                                                                       | Sign in as another approver. A service principal never can.                                                                                                                                            |
| `409 approval_conflict`                         | Someone else resolved it first, or the call changed since you read it.                                                                                                                                                                                                                                                                                           | Reload the queue and read the request again.                                                                                                                                                           |
| `401 wrong_audience`                            | The token was issued for another origin than the API's.                                                                                                                                                                                                                                                                                                          | Make `NEXT_PUBLIC_NC_API_URL` the API's exact origin. In mock mode this comes only from a token minted for another origin (another mock instance); use the address the mock printed, `127.0.0.1:8787`. |
| The queue stays empty                           | No approval exists in your organisation, or the mock does not let this origin call it.                                                                                                                                                                                                                                                                           | Start `start:demo` (it allows `http://localhost:3000`), or create an approval; the app has to run on port 3000.                                                                                        |

## Content-security policy

Production responses (`next build`, `next start`) carry a policy with a nonce that is new for each response:
scripts and styles only from this origin or with that nonce, no `'unsafe-inline'`, and network calls only to
this origin, the API and the sign-in service. Pages are rendered per request for that reason. The development
server is exempt. `/approvals/callback` is also sent with `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`, because its address holds the authorization code until the page removes it.

## Tests

- `bun run test` runs the unit and component tests (jsdom) with coverage.
- `bun run test:e2e` runs a real browser (Playwright, Chromium) against
  the production build, in two runs because the build inlines `NEXT_PUBLIC_*` (`NC_E2E_MODE=oidc` selects
  the second). It needs the browser once: `bunx playwright install chromium-headless-shell`.
  CI runs it as the `e2e / example app` job of `ci.yml` (build, install the browser, `test:e2e`). It uses ports
  3000 and, in mock mode, 8787; in sign-in mode the sign-in service and the API are answered by the test.
  - Mock mode (`e2e/approvals.spec.ts`), across `http://localhost:3000` and `http://127.0.0.1:8787`: the
    policy header, the queue, the detail read (nothing can be decided before it loads), Approve and Deny. The
    queue row must show within 2 s of the page's load (the brief's 2 s, measured from the page's load,
    when the approval already exists; the agent-to-page time is not timed).
  - Mock mode (`e2e/permissions.spec.ts`): each test starts its own mock with this app's origin allowed. The
    table shows the two seeded policies; an administrator sets an Organisation cell, simulates the draft (it
    names the caller's organisation, so the decision shows), publishes it, and the cell shows the published
    version.
  - Mock mode (`e2e/connections.spec.ts`): each test starts its own mock with this app's origin allowed. An
    administrator registers a tool server, refreshes its tools and links a bearer token of their own after
    ticking the consent (the token is on no page afterwards); an OAuth link consents, leaves for the mock's
    consent page and comes back to the page, which says the authorization completed and shows the link.
  - Sign-in mode (`e2e/signin.spec.ts`, T23c): the callback in a real browser with a seeded pending record
    and a stand-in sign-in service. A denied consent stays on the callback, makes no request and the
    approvals page does not navigate afterwards; a granted one exchanges the code once, cleans the
    address and the API receives the access token. It does not cover the redirect to a real authorization
    server (the beta half). The API origin of this run is `http://localhost:8789`, because sign-in accepts
    `https:` or `http://localhost` there and not `http://127.0.0.1`.
