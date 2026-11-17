# @noblecloak/cards

## 0.2.0

### Minor Changes

- fc8eb12: Fact conditions and approver routing in the React modules, and requirements on the card. In `@noblecloak/react`: the connections tools table edits a tool's fact bindings (`updateToolFacts`, `ConnectionToolInfo.facts`, the capability `toolFacts`); the policy editor gains Rules, Approvers and Exclusions, each shown only where `policy_forms` lists the member, with `setRules`, `setApprovers` and `setExclude`, `checkRules` and the `permissions-rules` helpers, and a save the contract would refuse is not sent (`rules_invalid`); `Permissions` shows the break-glass setting (`setApprovalRouting`); the dry run shows the rule that decided and the facts the call lacked; the approval detail lists the requirements of an approval (`requirementsOf`); `ConnectionsError` and `PermissionsError` carry the problem's `member`. In `@noblecloak/cards`: `toApprovalCard` emits one `CardRequirement` per requirement of the read (with optional `approvers`, `needed` and `approvals`), both renderers add a requirements line when the read carried them, and `CARD_MODEL_VERSION` is 3. A read without requirements renders exactly as before.

### Patch Changes

- Updated dependencies [20a6b38]
- Updated dependencies [da6bdc6]
- Updated dependencies [2276872]
  - @noblecloak/client@0.13.0

## 0.1.2

### Patch Changes

- Updated dependencies [a208682]
  - @noblecloak/client@0.12.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - @noblecloak/client@0.11.1

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
