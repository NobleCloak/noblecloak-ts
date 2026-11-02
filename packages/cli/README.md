# @noblecloak/cli

The `noblecloak` command line. An organisation administrator uses it to create, list, rotate and revoke the
organisation's **service principals**, and to write the credential file an agent loads.

- **Install**, **Configuration**
- **Commands**: `sp create`, `sp list`, `sp rotate`, `sp revoke`
- **The credential file**, **Sign-in**, **Exit codes**, **Security notes**

## Install

```sh
npm install --global @noblecloak/cli   # needs Node 20.3 or later
noblecloak --help
```

Or run it without installing: `npx @noblecloak/cli sp list --org <uuid>`.

## Configuration

The command has no built-in defaults. You give it the deployment, with a flag or an environment variable
(the flag wins):

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

Each command signs you in and ends the session when it finishes. It uses the `noblecloak-cli` public client
with OAuth 2.1 authorization code and PKCE (S256) on a loopback address:

1. It reads the deployment's authorization server metadata, and stops (exit code 1) unless the metadata's
   `issuer` is the `--auth-url` you gave, a trailing slash aside.
2. It listens on `127.0.0.1` on a free port and prints the sign-in URL (and opens it in your browser unless you
   pass `--no-open`).
3. It accepts one callback on `/callback` whose `state` matches, and ignores any other. It gives up after five
   minutes (exit code 3).
4. It exchanges the code, runs the command, then **revokes the refresh token** at the deployment, whether the
   command succeeded or failed.

The access token stays in memory. Nothing about your session is written to disk.

Ctrl-C works at every step: it cancels the sign-in wait, the request in flight or the `revoke` confirmation, then
revokes the refresh token and exits with code 3. After an interrupted `create`, `rotate` or `revoke` request the
server may or may not have applied it: run `sp list` to check. Each request is abandoned after 30 seconds
(exit code 1), and the refresh token is revoked then too. A `create`, `rotate` or `revoke` request that times out
or whose connection drops gets the same answer, with exit code 1: the server may or may not have applied it (for
`create` and `rotate` the message also says what to look for in `sp list`). For those three requests, "Cannot reach
the server" means the connection was refused or the host name did not resolve, so the request was not sent.

For provisioning scripts, `--user-token-file <path>` reads an admin access token from a file instead. The file
must not be readable by its group or by others (`chmod 600`); the command refuses it otherwise. A symlink is followed and the target's mode is the one checked. Treat this as a
stopgap for scripts: the token is short-lived and you have to obtain it yourself.

## Exit codes

| Code | Meaning                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| 0    | Done.                                                                                                      |
| 1    | A server or unexpected error. The server's `error.code` and `error.message` are shown.                     |
| 2    | Input refused: a bad flag, missing configuration, an existing `--out`, an unsafe token file.               |
| 3    | Not signed in: sign-in failed, timed out or was cancelled, the server answered 401, or you pressed Ctrl-C. |
| 4    | Forbidden: you are not an administrator of that organisation.                                              |

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
