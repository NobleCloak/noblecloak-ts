# @noblecloak/cli

The `noblecloak` command line. An organisation administrator uses it to create, list, rotate and revoke the
organisation's **service principals**, and to write the credential file an agent loads.

- **Install**, **Quickstart**, **Configuration**
- **Commands**: `login`, `setup`, `logout`, `sp create`, `sp list`, `sp rotate`, `sp revoke`, `starter`
- **The saved sign-in**, **The credential file**, **Sign-in**, **Exit codes**, **Security notes**

## Install

```sh
npm install --global @noblecloak/cli   # needs Node 20.3 or later
noblecloak --help
```

## Quickstart

To start, sign in and finish setup: `npx @noblecloak/cli login`, then `noblecloak setup` (see
[`noblecloak login`](#noblecloak-login)). `login` and `setup` know NobleCloak's servers: they need no
configuration.

Run it without installing: `npx @noblecloak/cli sp list --org <uuid>` (the `sp` commands need the
[configuration](#configuration) below), or the starter agent, `npx @noblecloak/cli starter` (see
[`noblecloak starter`](#noblecloak-starter)).

## Configuration

The `sp` commands have no built-in defaults (`starter` has: see below). You give them the deployment, with a flag
or an environment variable (the flag wins):

| Flag                       | Variable                    | Meaning                                                                                                |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `--auth-url <url>`         | `NOBLECLOAK_AUTH_URL`       | The deployment's authorization server, e.g. `https://auth.example.com`. https only (http on loopback). |
| `--admin-audience <value>` | `NOBLECLOAK_ADMIN_AUDIENCE` | The audience of the admin API. Ask the deployment's operator for it: the server does not advertise it. |

If either is missing the command exits with code 2 and names both the flag and the variable.

```sh
export NOBLECLOAK_AUTH_URL=https://auth.example.com
export NOBLECLOAK_ADMIN_AUDIENCE=<the admin audience>
```

`--org` is always the organisation's UUID. The admin token this command holds is accepted on the four
service-principal routes only, so the command cannot look an organisation up by name.

## Commands

### `noblecloak login`

```sh
npx @noblecloak/cli login [--email <address>] [--deployment production|beta] [--no-open] [--json]
```

Signs you in through your browser, and says what to do next:

```
Opening your browser to sign in…
(If it didn't open: https://auth.noblecloak.com/…)

✓ Signed in

Next: finish setup (3 of 4 steps left)
  noblecloak setup   or   https://app.noblecloak.com/setup

In Claude Code, run /mcp to connect tools.
```

The browser tab ends on NobleCloak's own signed-in page, not on a page of this command: the loopback listener
never serves HTML. It redirects the tab to the app's `/cli/signed-in` page, naming your organisation by id (and
nothing else: no token, code or email), or to the same page with a fixed error code when the sign-in failed. A
deployment whose app URL is not known gets a plain-text answer instead.

The _Next_ line follows the organisation's setup, counted by the same rule as the setup pill (`@noblecloak/setup-steps`).
An organisation with nothing left to do, and a person who is not an administrator of it, get only the `/mcp`
line. If the progress cannot be read, `login` says so on stderr and still signs you in.

| Flag                       | Variable                    | Meaning                                                                                                                                                                                 |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--deployment <name>`      | `NOBLECLOAK_DEPLOYMENT`     | `production` (default) or `beta`. An explicit `--deployment` ignores the host variables below.                                                                                          |
| `--auth-url <url>`         | `NOBLECLOAK_AUTH_URL`       | Replaces the deployment's authorization server (self-hosted). The admin audience and app URL are then not guessed: pass `--admin-audience`, and `--app-url` for the browser pages.      |
| `--admin-audience <value>` | `NOBLECLOAK_ADMIN_AUDIENCE` | Replaces the deployment's admin API audience.                                                                                                                                           |
| `--app-url <url>`          | `NOBLECLOAK_APP_URL`        | Replaces the deployment's app origin, where `/cli/signed-in` and `/setup` are served.                                                                                                   |
| `--email <address>`        |                             | Tells the sign-in page which company login to use. It goes to the authorization server as `login_hint`, and nowhere else: not to the app, not into the saved file, not into the output. |
| `--no-open`                |                             | Print the sign-in URL and open nothing.                                                                                                                                                 |
| `--json`                   |                             | Print one JSON object on stdout.                                                                                                                                                        |

`login` asks for one scope, `setup:read`, on the admin API's audience: enough to read the organisation's setup
checklist and nothing else. It does not ask for `service_principals:manage`; the `sp` commands sign in for that on
their own.

### `noblecloak setup`

```sh
noblecloak setup [--deployment production|beta] [--no-open] [--json]
```

Opens the setup wizard (`/setup` on the deployment's app) in your browser; the wizard opens at the first unfinished
step. It does not need you to be signed in. When a sign-in is saved it also says how many steps are left, or that
setup is finished. A saved sign-in that has expired or was revoked costs only that line: `setup` says to run
`noblecloak login` and opens the wizard anyway. When the count cannot be read it says so and still opens the wizard;
`--json` gives the reason as `saved_sign_in` (`none`, `skipped`, `expired`, `other_deployment`, `unusable` or `read`).
It takes the same host flags as `login`; a self-hosted deployment needs `--app-url`, and `--admin-audience` only for
the count (without it the count is skipped).

### `noblecloak logout`

```sh
noblecloak logout [--json]
```

Asks the server to end the saved sign-in (it revokes the refresh token), then deletes the file. It does the same for
a saved file it will not use because other users can read it, and for any `auth.json.*.tmp` file a dead command
left behind. It says `Signed out.` only when the server accepted every revoke. When the server could not be told
(unreachable, not https, or a file that cannot be read at all, so there is no token to send), it deletes the file and
says the session there may stay open until it expires.

### `noblecloak sp create`

```sh
noblecloak sp create --org <uuid> --name "ci agent" \
  --audience https://govern.example.com --out ./sp-credential.json
export NOBLECLOAK_SP_CREDENTIALS=./sp-credential.json
```

| Flag                    | Meaning                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--org <uuid>`          | The organisation that owns the principal. You must administer it.                                                               |
| `--name <name>`         | 1 to 255 characters.                                                                                                            |
| `--audience <url>`      | An API origin the principal may request tokens for. Repeat it, 1 to 10 times.                                                   |
| `--scope <scope>`       | A scope to grant. Repeat it. Omitted, the server grants `module_api`.                                                           |
| `--expires-in-days <n>` | 1 to 365. Omitted, the server picks its default (90 days).                                                                      |
| `--out <path>`          | Where to write the credential. Refused (exit 2, before sign-in) if the path exists or its directory is missing or not writable. |
| `--json`                | Print one JSON object instead of text.                                                                                          |

It generates an EC P-256 key pair on your machine, sends the server **only the public key**, and writes the
private key into the credential file. The key never leaves the machine and is never printed.

If the server creates the principal but does not return a token endpoint and an assertion audience (its issuer
is not configured), no file is written. The command exits with code 1 and prints the `sp revoke` command that
retires the principal.

### `noblecloak sp list`

```sh
noblecloak sp list --org <uuid> [--json]
```

A table of id, client_id, name, audiences, scopes, expires_at, revoked and key thumbprints (shortened in the
text output, complete with `--json`).

### `noblecloak sp rotate`

```sh
noblecloak sp rotate --credentials ./sp-credential.json [--revoke-previous] [--expires-in-days <n>]
```

Reads `org_id` and `sp_id` from the file, generates a new key, registers its public half, and replaces the file
**only after the server accepts it**: the new file is written beside the old one with mode 0600 and renamed over
it. If the server refuses, the file's bytes are unchanged. By default the previous key stays valid, so running
agents keep working while you roll the new file out; `--revoke-previous` retires every previous key at once.

The new key is always written inline, as `private_jwk`. A file that names its key with `key_file` instead is
refused (exit code 2) before sign-in: move the key file's JWK into `private_jwk` and remove `key_file`, then
rotate.

The command checks that the file's directory is writable before it calls the server (exit code 2 otherwise). If
the server accepts the rotation but the new file still cannot be written, the new key is lost. Without
`--revoke-previous` the old file is unchanged and still works: run the rotation again. With `--revoke-previous`
the server has already retired the keys in the old file, so the command exits with code 1 and prints the
`sp revoke` command: revoke the principal and create a new one.

### `noblecloak sp revoke`

```sh
noblecloak sp revoke --org <uuid> --sp <uuid> [--yes]
```

Shows the principal's name and client_id and asks you to confirm. Without a terminal it refuses (exit code 2)
unless you pass `--yes`. After a revoke the principal's next token request fails; an access token it already
holds works until it expires, at most 15 minutes. The command does not delete any local file: delete the
credential file yourself.

### `noblecloak starter`

A starter agent that needs no model and no key but a service principal's. It does two things, and a person decides
both in Approvals: it proposes the setup of an agent, then it makes one write to the sandbox.

```sh
noblecloak sp create --org <uuid> --name "starter" \
  --audience https://govern.noblecloak.com --audience https://mcp-agents.noblecloak.com \
  --out ./sp-credential.json
npx @noblecloak/cli starter --credentials ./sp-credential.json
```

1. **Credential check.** It reads the credential and gets a token for each of the two audiences before anything
   is opened, so a principal that lacks one fails at once (exit code 11) and not while you wait on an approval.
   The principal needs the govern origin (for `/v1`) and the gateway audience (for the MCP gateway), so
   create it with both `--audience` flags, as above.
2. **Setup, as you.** It signs you in (loopback sign-in as above, for the govern audience; it needs no
   administrator scope) and opens one `propose-policy-set` approval: the agent is bound to the service principal,
   granted the sandbox's `tool:sandbox:create-note`, and given an `ask` policy for it. **Approve it in
   Approvals.** The command waits. The agent is, in this order: the one `--agent` names; else, when the credential
   file has an `org_id` that is a UUID, the agent the deployment declares for a principal created **in the
   browser** (a credential downloaded from the Team module; the deployment opens a setup proposal for it then).
   `noblecloak sp create` never has one opened, so a credential from `sp create` finds no such agent and the
   command declares a new agent named "NobleCloak starter" instead, as it does for a credential without an
   `org_id`. For the browser's agent the command reads it first (`GET /v1/agents/{id}`): if it is bound to this
   principal the setup is already applied and the command exits 13 without opening anything (use
   `--skip-setup`); otherwise it opens the proposal with the continuation the deployment gave its own, and the
   deployment answers with the proposal it already has open ("Setup already open") instead of opening a second.
   The deployment matches per proposer and per continuation: it answers with the open proposal only when you
   are the administrator who created the principal in the browser. For another administrator a second proposal
   opens, and whichever of the two is approved second fails with `policy_conflict`, which the command reports
   as already set up. If an administrator rejected the browser's proposal, the deployment (with its
   rejected-duplicate rule on) refuses to open the same one again (exit 13, naming the rejected approval):
   create new credentials; the command does not declare another agent to get around the rejection.
3. **Write, as the principal.** It opens an external run and an approval for one `tool:sandbox:create-note` call
   with its exact arguments, and waits. **Approve or deny it in Approvals.** Only if you approve does it send one
   MCP `tools/call` (`int_sandbox_create_note`) to the gateway, with the run named in `x-noblecloak-external-run-id`.
   An approval admits one call: the command never repeats it.

While it waits, it prints on stderr where to decide the request, what the request is called there, and how long
it waits: for the `production` and `beta` deployments the Approvals page of that deployment's app
(`https://app.noblecloak.com/approvals`, `https://shell.beta.shared.bianoble.com/approvals`), then the request's tool
reference (`tool:noblecloak:propose-policy-set` for the setup, `tool:sandbox:create-note` for the write), then
that Ctrl-C stops the command and leaves the request open. With `--govern-url` (or `NOBLECLOAK_GOVERN_URL`)
pointing elsewhere there is no link: the command does not guess an app address. `--json` output is unchanged.

The two approvals are decided by a person with the Approvals module, never with the token that opened them.

| Flag                         | Variable                      | Meaning                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--credentials <path>`       | `NOBLECLOAK_SP_CREDENTIALS`   | The credential file `sp create` wrote (or its JSON). Exit code 10 without one.                                                                                                                                                                                                                                                   |
| `--deployment <name>`        | `NOBLECLOAK_DEPLOYMENT`       | `production` (default): the defaults for the four hosts below.                                                                                                                                                                                                                                                                   |
| `--auth-url <url>`           | `NOBLECLOAK_AUTH_URL`         | The authorization server where you sign in. Production `https://auth.noblecloak.com`.                                                                                                                                                                                                                                            |
| `--govern-url <url>`         | `NOBLECLOAK_GOVERN_URL`       | The governance API origin, and the audience of your token and the principal's. Production `https://govern.noblecloak.com`.                                                                                                                                                                                                       |
| `--mcp-url <url>`            | `NOBLECLOAK_MCP_URL`          | The MCP gateway origin; the call goes to `<url>/v1/mcp`. Production `https://mcp.noblecloak.com`.                                                                                                                                                                                                                                |
| `--gateway-audience <value>` | `NOBLECLOAK_GATEWAY_AUDIENCE` | The audience of the principal's gateway token (an identifier, not an address). Production `https://mcp-agents.noblecloak.com`.                                                                                                                                                                                                   |
| `--agent <id>`               |                               | Use this agent instead of declaring one, to retry a setup that was not applied. A setup already applied for it is refused (`policy_conflict`): use `--skip-setup`.                                                                                                                                                               |
| `--skip-setup`               |                               | Make the write only, after a setup you already approved. Takes neither `--agent` nor `--user-token-file`.                                                                                                                                                                                                                        |
| `--wait <seconds>`           |                               | How long to wait for each approval, 1 to 3600. Default 600. The setup wait is cut to 840 seconds, because a freshly issued access token lasts 15 minutes (an older `--user-token-file` token may expire sooner); a setup approved after that is followed by `--skip-setup`. A setup or write still open stays open in Approvals. |
| `--user-token-file <path>`   |                               | A govern-audience access token (mode 600) for the setup, instead of signing in.                                                                                                                                                                                                                                                  |
| `--no-open`, `--json`        |                               | As for the `sp` commands. `--json` prints `agent_id`, `setup_approval_id`, `run_id`, `write_approval_id`, `outcome` and `result`.                                                                                                                                                                                                |

A host is taken from its flag, then its variable, then the `--deployment` default. An explicit `--deployment` flag ignores the host variables (`NOBLECLOAK_AUTH_URL` and the rest), so one left over from the `sp` commands cannot mix two deployments; `NOBLECLOAK_DEPLOYMENT` does not.

Running it twice: the setup binds the principal to one agent and publishes that agent's policy, so it is
applied once. After you approved it, run `starter --skip-setup` for another write, with the same credential.

## The saved sign-in

`login` is the one command that keeps your sign-in. It writes `~/.noblecloak/cli/auth.json` (the directory is
`NOBLECLOAK_CLI_STATE_DIR` when that is set): the directory is mode 0700, the file 0600, written through a temp
file and a rename so a reader never sees half of it. A file that other users can read, and anything that is not a
regular file, is not used. A directory that already exists must be owned by you with no group or other access, or
`login` refuses to save into it (it never changes the mode of a directory it did not create). `noblecloak logout`
revokes the sign-in and deletes it. A sign-in is also deleted when `setup` finds the server saying its refresh token
is revoked, already used, expired or otherwise over; any other refusal of a refresh (a transient single sign-on
failure, the network, a server error) keeps the file. A `401` on the setup read says the sign-in expired and keeps
the file.

Commands that renew the sign-in take an exclusive lock file (`auth.json.lock` in the same directory) around reading,
refreshing and writing, because a refresh token works once and the server revokes the whole family when one is used
twice. A second command waits, then reads what the first wrote. A lock older than 90 seconds is a crashed command's
and is taken over. A `login` that replaces an earlier sign-in revokes the earlier session too.

```json
{
  "version": 1,
  "issuer": "https://auth.noblecloak.com",
  "clientId": "noblecloak-cli",
  "audience": "https://admin-api.noblecloak.com",
  "scope": "setup:read",
  "accessToken": "…",
  "refreshToken": "…",
  "expiresAt": 1795546703480,
  "tokenType": "Bearer",
  "authenticatedAt": "2026-11-24T00:00:00.000Z",
  "orgId": "<the organisation the sign-in is bound to>",
  "sub": "<the person's id>"
}
```

The member names `accessToken`, `refreshToken`, `expiresAt` (epoch milliseconds), `tokenType`, `scope`,
`authenticatedAt`, `issuer`, `orgId` and `sub` are the Claude Code plugin's own `auth.json` names, so the plugin
can read this file with the code it has. The file holds no email. **Check `clientId`, `audience` and `issuer` before
sending the token anywhere:** it belongs to the `noblecloak-cli` client and is bound to the admin API, so it is not
accepted by the MCP gateway or the governance API. The access token lives 15 minutes; commands renew it with the
refresh token (the server rotates it, and the file is rewritten). The refresh token expires after 7 days without use.

`starter` does not use this sign-in: it needs a token for the govern API's audience, and a token is bound to one
audience when it is issued, so it keeps signing in for its own.

## The credential file

`sp create` writes one self-contained JSON file, mode 0600:

```json
{
  "client_id": "sp_<uuid>",
  "token_endpoint": "https://auth.example.com/auth/oauth/token",
  "assertion_audience": "https://auth.example.com",
  "private_jwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "…",
    "y": "…",
    "d": "…",
    "kid": "…",
    "alg": "ES256",
    "use": "sig"
  },
  "org_id": "<uuid>",
  "sp_id": "<uuid>",
  "name": "ci agent",
  "audiences": ["https://govern.example.com"],
  "scopes": ["module_api"],
  "expires_at": "2027-01-25T00:00:00.000Z"
}
```

The first four fields and `org_id` are what `@noblecloak/client/service-principal` reads; the CLI checks every file
it writes with that package's own credential parser before it saves it, and refuses one that also carries
`key_file` (the loader needs exactly one of `private_jwk` and `key_file`), so the SDK will load it. `sp_id`, `name`,
`audiences`, `scopes` and `expires_at` are for you and for `sp rotate`. `kid` is the key's RFC 7638 thumbprint. To
hand the file to a CI system, store its text as a secret and set `NOBLECLOAK_SP_CREDENTIALS` to that JSON.

## Sign-in

Except for `login` (see [The saved sign-in](#the-saved-sign-in)), each command that needs you (all but `starter --skip-setup`) signs you in and ends the session when it finishes. It uses the `noblecloak-cli` public client
with OAuth 2.1 authorization code and PKCE (S256) on a loopback address:

1. It reads the deployment's authorization server metadata, and stops (exit code 1) unless the metadata's
   `issuer` is the `--auth-url` you gave, a trailing slash aside.
2. It listens on `127.0.0.1` on a free port and prints the sign-in URL (and opens it in your browser unless you
   pass `--no-open`).
3. It accepts one callback on `/callback` whose `state` matches, and ignores any other. It gives up after five
   minutes (exit code 3).
4. It exchanges the code, runs the command, then **revokes the refresh token** at the deployment, whether the
   command succeeded or failed.

For these commands the access token stays in memory. Nothing about your session is written to disk.

Ctrl-C works at every step: it cancels the sign-in wait, the request in flight or the `revoke` confirmation, then
revokes the refresh token and exits with code 3. After an interrupted `create`, `rotate` or `revoke` request the
server may or may not have applied it: run `sp list` to check. Each request is abandoned after 30 seconds
(exit code 1), and the refresh token is revoked then too. A `create`, `rotate` or `revoke` request that times out
or whose connection drops gets the same answer, with exit code 1: the server may or may not have applied it (for
`create` and `rotate` the message also says what to look for in `sp list`). For those three requests, "Cannot reach
the server" means the connection was refused or the host name did not resolve, so the request was not sent.

For provisioning scripts, `--user-token-file <path>` reads an admin access token from a file instead (for `starter` it is a govern-audience token, as above). The file
must not be readable by its group or by others (`chmod 600`); the command refuses it otherwise. A symlink is followed and the target's mode is the one checked. Treat this as a
stopgap for scripts: the token is short-lived and you have to obtain it yourself.

## Exit codes

| Code | Meaning                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Done.                                                                                                                                                                             |
| 1    | A server or unexpected error. The server's `error.code` and `error.message` are shown. A wait for an approval that the network or a 5xx cuts is repeated until `--wait` is out.   |
| 2    | Input refused: a bad flag, missing configuration, an existing `--out`, an unsafe token file.                                                                                      |
| 3    | Not signed in: sign-in failed, timed out or was cancelled, the server answered 401, or you pressed Ctrl-C.                                                                        |
| 4    | Forbidden (403): for `sp`, you are not an administrator of that organisation; for `starter`, the person or principal is not allowed that call (for example not an administrator). |

`starter` adds:

| Code | Meaning                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10   | No service-principal credential was given.                                                                                                                                                                                                                                                                                                                    |
| 11   | The principal may not ask for a token for the govern origin or the gateway audience, or its credential is for the other deployment (pass `--deployment`).                                                                                                                                                                                                     |
| 12   | The sandbox is not available: the deployment has no sandbox write tool to grant (the setup was refused as `target_unknown`), or cannot route an approval for it.                                                                                                                                                                                              |
| 13   | The setup was denied or withdrawn, or the deployment refused to apply it; or the principal is already set up (run with `--skip-setup`); or an administrator rejected the same setup and the deployment will not open it again (create new credentials); or, with `--skip-setup`, the principal was never granted the write tool (run without `--skip-setup`). |
| 14   | The write was denied or withdrawn, the gateway refused it, or the deployment will not reopen a write it refused moments ago. Nothing was written.                                                                                                                                                                                                             |
| 15   | Nobody decided an approval within `--wait` seconds, or it expired. An expired approval is gone; an undecided one stays open in Approvals until it expires.                                                                                                                                                                                                    |
| 16   | The approval for the write was already used by an earlier call.                                                                                                                                                                                                                                                                                               |

Text goes to stdout, diagnostics and the sign-in URL to stderr. With `--json` stdout carries exactly one JSON
object when the command succeeds.

## Security notes

- The credential file holds a private key. `sp create` makes it with mode 0600 and will not overwrite an
  existing file. **Never commit it**; add it to `.gitignore`.
- If a credential file is lost or exposed, run `noblecloak sp revoke` for it at once.
- The command never prints key material, authorization codes, access tokens or refresh tokens, on stdout, on
  stderr or in `--json` output.
- A principal expires on its `expires_at` date. Rotate before then: `sp rotate` resets the expiry with `--expires-in-days` and keeps the previous key valid by default.

## License

Apache-2.0.
