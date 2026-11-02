# @noblecloak/cards

## 0.1.0

### Minor Changes

- ffbd67a: New package. `toApprovalCard` builds one approval card from a `/v1` approval read, a viewer and the caller's
  options: the fields `ApprovalRequest` shows, the call only when the read carries it and nothing blocks it,
  and typed actions with their own inputs. A request that is no longer pending (`FinalCard`) keeps its facts,
  status and history and drops only the call, the inputs and the resolve buttons. `toApprovalCard` never throws:
  an approval it cannot read gives the minimal link-only card, `degraded: ['minimal']`.

  `toBlockKit` renders the card to Slack Block Kit and `toAdaptiveCard` to an Adaptive Card 1.5, both with
  bounded, escaped output. `renderBlockKit` and `renderAdaptiveCard` return the same, plus `degraded`, the ways the
  message is less than the read offered: `CARD_DEGRADATIONS` lists the codes `no_payload`, `actions_capped`,
  `inputs_capped`, `minimal`, `actions_dropped`, `actions_withheld`, `call_unreadable`, `call_too_large`,
  `call_shortened` and `no_link`.

  `encodeActionPayload` and `parseActionPayload` carry a click as three references. `parseExecuteData` reads the
  `data` of a Teams `Action.Execute`, where Teams has merged the input values into the payload. `findCardAction`
  maps the platform's action identifier to the card's resolve action, and `clickIntent` turns a click into the
  approval, the resolution and the digest the message was sent with.

### Patch Changes

- Updated dependencies [5cf6237]
  - @noblecloak/client@0.11.0
