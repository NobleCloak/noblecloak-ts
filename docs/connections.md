# Connections: tool servers, their tools, and your own credential

A connection is an organisation's registration of a tool server: an MCP server (or an A2A agent) that the
organisation's agents call through the governed gateway. This page is for two readers: an **administrator**, who
registers servers and decides how calls through them authenticate, and a **member**, who links a credential of their
own so that their calls through a server work. The rules come from the contract (`@noblecloak/spec`, `openapi.yaml`,
revision 11). The Connections module (`@noblecloak/react/connections`) is one way to show and use them.

## What a registration is

A registration names a server by its **URL**, a name, and a **transport** (`mcp` or `a2a`). The URL is the identity
of the server and of every tool registered from it: it cannot be changed (a `PATCH` that names `url` is refused).
A server that moved is registered again, at its new URL, and its tools are new tools.

An organisation has **one registration per server**. Registering a URL the organisation already has (the deployment
may treat URLs that differ only in form, such as a trailing slash, as the same server) is refused with
`409 connection_exists`, which names the existing registration when you may read it. A URL never carries a
credential: one with `user:password@` in it is refused.

## Owner and visibility

A registration is owned by the **organisation** or by one **principal**:

- an organisation's registration is visible to every member of the organisation, which is what lets each of them use
  it; only the organisation's administrators rename, refresh or delete it;
- a principal's registration is visible to that principal and to administrators, and is a `404` to anyone else; its
  owner and administrators change it.

A deployment may restrict who registers (`connection_registration` in its capabilities): for example, only
administrators, and only organisation registrations. That restriction is about registering, never about using.

## How calls authenticate: the three kinds and the two tiers

How the server authenticates callers is the registration's **kind of authentication**: `none`, `bearer` (a token)
or `oauth`. Whose credential calls use is its **credential tier**, set once by an administrator at registration:

- **`per_user`**: each person links a credential of their own. A call made with your link is your call; the
  organisation never uses your credential for anyone else.
- **`org_shared`**: one credential of the organisation, which an administrator sets (a bearer token, write-only and
  never shown again, which an administrator may replace), or authorizes through OAuth.

No operation ever returns a credential.

## Your own credential: link, consent, revoke, unlink

On a `per_user` registration that takes authentication, every person, administrators included, manages their own
link and nobody else's:

- **Link** with your explicit **consent** to the organisation's gateway using the credential for your own calls.
  For a bearer server you give the token once; for an OAuth server you then authorize (below). A link is never
  created without consent.
- **Revoke consent** keeps the credential but stops its use until you give consent again.
- **Unlink** removes your link and its credential.

None of these changes the tools: they stay available to everyone who has linked their own credential, and their
policies are untouched. Your calls fail for lack of a credential until you link again. Nobody, an administrator
included, can see or act on another person's link.

## Why an OAuth link leaves the page and comes back

An OAuth credential is granted on the authorization server's own page, not inside the app. Starting the authorization
gives a single-use URL, and the browser goes there. After you consent (or refuse), the browser comes back to the page
it left, with three query parameters:

| Parameter       | What it says                                                                         |
| --------------- | ------------------------------------------------------------------------------------ |
| `nc_connection` | the registration                                                                     |
| `nc_result`     | `connected` or `error`                                                               |
| `nc_error`      | on an error, one of `consent_denied`, `expired`, `exchange_failed`, `upstream_error` |

The page it returns to must be on an origin the deployment admits for browser modules. The Connections module adds a
nonce of its own to that page's address, shows the result once, only for an authorization this browser started and
only in its own words, and then takes the parameters out of the address. The contract has the deployment keep
`return_to`'s own query and add the `nc_*` parameters to it, so that nonce comes back; a deployment that dropped the
query would still complete the authorization, and the module would then show no result. The same round trip authorizes an `org_shared` OAuth registration,
which only an administrator may do.

## Reconnecting

A credential is connected again with the same routes:

- **Authorize again.** An OAuth link that waits, stopped working, or works and that you want to consent to again (or
  have the authorization server issue anew) goes through the round trip above. So does an `org_shared` OAuth
  registration, for an administrator. A link or registration that works stays in use until the new round trip
  completes; one that is refused or never completes leaves it as it was.
- **Replace a token.** Link again with a new bearer token; for an `org_shared` bearer registration, an administrator
  replaces the organisation credential.
- **Link again** after unlinking, or **give consent again** after revoking it.

The Connections module offers Reconnect in its list wherever a credential is not in use, and every one of these in an
open registration.

## Discover and refresh: how tools become addressable

- **Discover** asks the server, live, what it offers now. It registers nothing.
- **Refresh** registers what the server offers: a tool offered for the first time is added; one offered again after
  it was withdrawn is active again under the same reference; one no longer offered becomes **withdrawn**. If the
  server offers nothing at all, a deployment may keep the registered tools rather than withdraw every one, and says
  so.

A registered tool is addressed by its `tool_ref`, which is what policies name (see
[The ladder](./the-ladder.md)). A `tool_ref` is a stable reference the deployment assigns: compare it, never parse it.
It stays the same while the server's URL does, across disconnecting and reconnecting.

## Deleting a registration

Deleting a registration withdraws its tools: they stay listed with `status: withdrawn`, their policies remain and
list them as unenforced, and a decision for one is `deny` with reason `unknown_tool`. Every person's link to the
registration goes with it. Registering the same URL again makes the tools active again under the same references, and
their policies are back in force without being written again.

## What a deployment may not offer

A deployment says what it serves in `GET /v1/capabilities`, and the module offers only that:

- without the `connections` family, there are no connections at all;
- without `connections.oauth`, there is no OAuth round trip (no `oauth` registrations to authorize);
- without `connections.user_links`, there are no per-person links, and a registration's tier is `org_shared`;
- `connection_transports` names the transports it serves.

A deployment that runs next to your own agents rather than as a hosted service typically lacks the OAuth round trip
and per-person links.
