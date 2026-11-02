# @noblecloak/cards

One approval card model, built from a NobleCloak `/v1` approval read and rendered to Slack Block Kit and to
Adaptive Cards 1.5 (Teams). It is pure TypeScript: no React, no DOM, no Slack or Teams SDK, no network. It
depends on `@noblecloak/client` for types only.

- **Model:** `toApprovalCard`, `CARD_MODEL_VERSION`, `CHAT_RESOLUTIONS`, `CARD_DEGRADATIONS`, `CARD_TEXT`
- **Renderers:** `toBlockKit`, `toAdaptiveCard`; `renderBlockKit`, `renderAdaptiveCard` (the same, plus `degraded`)
- **Click payload:** `encodeActionPayload`, `parseActionPayload`, `parseExecuteData`, `findCardAction`, `clickIntent`
- **Limits**, **What a card shows**, **Safety**, **License**

## Use

```ts
import { toApprovalCard, toBlockKit, toAdaptiveCard, renderBlockKit } from '@noblecloak/cards';

// `approval` is the body of GET /v1/approvals/{id}, read as the person who will see the card.
const card = toApprovalCard(
  approval,
  { principalId: viewer.id },
  {
    blockCallInChat: org.blockCallInChat, // true keeps the call out of chat
    approvalsUrl: `https://approvals.example.com/approvals/${approval.id}`,
    capabilities, // GET /v1/capabilities; `resolutions` and `features` are read
  }
);

const slack = toBlockKit(card, { sentMessageId }); // { text, blocks }
const teams = toAdaptiveCard(card, { sentMessageId }); // an Adaptive Card 1.5 object

// To know whether the buttons are all there, use the render* form:
const { message, degraded } = renderBlockKit(card, { sentMessageId });
// degraded: [] or some of the codes in CARD_DEGRADATIONS, below.
```

`degraded` says every way the message is less than the read offered. Its codes (`CARD_DEGRADATIONS`):

| Code               | Meaning                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no_payload`       | The card has resolve actions but no working click payload (no `sentMessageId`, or an id that is no UUID, an empty or too long digest)                                                  |
| `actions_capped`   | The card has more resolve actions than the surface shows                                                                                                                               |
| `inputs_capped`    | Some input of a shown action is not on the message, so its button may fail                                                                                                             |
| `minimal`          | Title, headline, status and link only: the message was over the size cap, or `toApprovalCard` could not read the approval                                                              |
| `actions_dropped`  | The read lists an action the model skipped as invalid (a bad, duplicate or wrongly derived id, no string `kind`, an unknown or reserved input, a malformed `max_length` or `required`) |
| `actions_withheld` | The deployment lists `approvals.available_actions` and the pending read has none, so the card has no actions                                                                           |
| `call_unreadable`  | The arguments are not an object, or could not be read                                                                                                                                  |
| `call_too_large`   | The call is over the surface's budget and the message points to the full call in Approvals                                                                                             |
| `call_shortened`   | The call is shown with a part cut, and the message says so                                                                                                                             |
| `no_link`          | The Approvals URL is not an `http` or `https` link the platforms accept, so the message has no link                                                                                    |

`sentMessageId` is the id (a UUID) of the row the caller keeps for the message it sends. Without it the
renderers draw no buttons that resolve and no inputs, only the link to Approvals.

## What a card shows

- The fields `ApprovalRequest` shows: the tool, the side-effect level, the kind, the requester, the agent and its
  parent, the run, the scope, the policy, what the request waits on, the timing, the digest and the history.
- **The call** only when the read carries it, `blockCallInChat` is `false` and the approval is `pending`.
  Otherwise the card says why (`facts.call` is a link with `why` of `blocked`, `not_on_read`, `unreadable` for
  arguments that are present and not an object, or `final`) and points to Approvals.
- **Actions** only while the approval is `pending`. When the read has `available_actions` the card uses them,
  keeping their wording and inputs, and drops an action with a malformed input, an entry with no string `kind`, or an
  action on the id derived for the other resolution (`approve` for a rejection, `deny` for an approval)
  (`actions_dropped`). When it does
  not, a deployment that lists `approvals.available_actions` in `capabilities.features` gets no actions
  (`actions_withheld`): the absent member means this reader has none. Any other deployment gets approve and deny
  for each of `approved` and `rejected` that `capabilities.resolutions` lists. Only `CHAT_RESOLUTIONS`
  (`approved`, `rejected`) is ever offered, whatever else a read or the capabilities list.
- **A request that is no longer pending** (a `FinalCard`) keeps its facts, status and history and drops only the
  call, the inputs and the resolve buttons. A Block Kit card has no `actions` block and an Adaptive Card has no
  `actions` member; the link to Approvals rides on the section that says the call is not shown. A state the
  model does not know reads "Status unknown".
- **The note** of a final card is the reason of the deciding entry of the history, the latest entry whose
  resolution is the final resolution. No other entry lends its reason.

`CARD_MODEL_VERSION` is bumped on any change to what a card shows, so a caller can record which version it sent.

## The click payload

A button carries three references, never authority:

```json
{ "v": 1, "approval_id": "…", "sent_message_id": "…", "expected_action_digest": "…" }
```

`parseActionPayload` is strict: exactly those four keys, `v` equal to 1, UUID ids and a non-empty digest, the whole
no longer than 2000 characters. It takes the string a Slack button carries or the object an Adaptive Card
`Action.Execute` carries, and it never throws.

- Which action was pressed is not in the payload. It is the platform's own identifier (Slack's `action_id`,
  Teams' `verb`), set to the `CardAction.id`. Rebuild the card from a fresh read as the person who clicked and
  call `clickIntent(card, payload, identifier)`: it gives `{ approvalId, resolution, expectedActionDigest }`, or
  `undefined` when the payload is for another approval or the card has no such resolve action, and then nothing is
  resolved. `expectedActionDigest` is the payload's, never the fresh card's, so a click on a message whose call
  has changed since is refused by the approvals service. `findCardAction` is the lookup it uses: an identifier
  derived from the capabilities (`approve`, `deny`) that the fresh card lacks, because the deployment began to
  list its own actions after the message was sent, finds the one resolve action with that resolution. A listed action on a derived id with the other resolution
  (`deny` that approves) is never offered, so it cannot reverse such a click (`actions_dropped`).
- The digest is not a secret. What lets a click resolve is the platform's signature, a check of the clicker's
  identity at click time, and the approvals service's own eligibility decision.
- Teams merges the values of the card's inputs into `data`, so a click arrives as `{...payload, reason}` and
  `parseActionPayload` refuses it. Call `parseExecuteData(data)` instead: it gives `{ payload, inputs }`, the four
  payload keys checked as strictly and the other string values, or `undefined`.

## Safety

- Every server string is shown with invisible and bidirectional-control characters, line breaks and other control
  characters (C0, DEL, C1) and lone UTF-16 surrogates as `\uXXXX` escapes, so a server string cannot start a line
  of its own and a strict JSON decoder accepts the payload.
- **Slack:** untrusted text is in `plain_text` objects. The one `mrkdwn` object is the call's code block, with
  `verbatim` on. `&`, `<` and `>` are escaped in every string, `link_names` is never set, and a backtick inside
  the call is shown as the look-alike U+02CB so it cannot end the block.
- **Teams:** markdown characters and `<` are backslash-escaped, so no link, emphasis or `<at>` is live. An input
  label and an action title are plain text, so their angle and square brackets become look-alikes. The card has
  no `msteams` member, so nothing mentions anyone. Bare web addresses in text may still be linked by Teams.
- An action with an input named like a payload key (`v`, `approval_id`, `sent_message_id`,
  `expected_action_digest`) is left out, because Teams merges input values into the payload's `data`.
- An input is marked required only when every action on the card takes it and requires it. Teams validates every
  input on the card for every button, so a required input of one action would otherwise block the others; the
  server still enforces what each action requires.
- Every field is cut to its limit, ending in "…". A call nested deeper than 8 levels shows the deeper part as a
  count, a string in the call is cut at 500 characters, and a call over its budget is replaced by the sentence
  that points to Approvals. `toApprovalCard` never throws: a malformed optional member of the read is treated as
  absent, and an approval it cannot read at all (a throwing getter, a revoked proxy, options without
  `capabilities`) gives the minimal link-only card, `degraded: ['minimal']`.

## Limits

| Platform | Limit the renderer holds                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack    | 50 blocks; section text 3000; 10 fields of 2000; header 150; button text 75; button value 2000; fallback `text` 4000; at most 10 resolve buttons; 5 inputs; the message within 40,000 UTF-8 bytes                           |
| Teams    | The serialised card within 80,000 bytes counted as UTF-16, two per code unit (the platform counts a message in UTF-16, allows 100 KB and advises 80 KB); at most 120 lines of the call; at most 5 resolve actions; 5 inputs |

A Slack message over 50 blocks or 40,000 bytes, and a Teams card over 80,000 UTF-16 bytes, is replaced by a minimal
one (title, headline, status and the link), and `renderBlockKit` and `renderAdaptiveCard` report `minimal`.

Resolve actions: at most 10 on Slack and 5 on Teams (`maxActions` in each limits object). Teams shows six primary
actions and moves the rest to an overflow menu, so five leave room for the Open in Approvals link on the card.
The rest are decided in Approvals through the link, and the render functions report `actions_capped`. Inputs past
the fifth distinct one are not rendered and the render functions report `inputs_capped`.

`SLACK_LIMITS` and `TEAMS_LIMITS` export the numbers, including the budgets chosen inside the platform limits
(`maxActions`, `inputs`, and Slack's `messageBytes`).

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
