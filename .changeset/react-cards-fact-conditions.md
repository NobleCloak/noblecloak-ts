---
'@noblecloak/react': minor
'@noblecloak/cards': minor
---

Fact conditions and approver routing in the React modules, and requirements on the card. In `@noblecloak/react`: the connections tools table edits a tool's fact bindings (`updateToolFacts`, `ConnectionToolInfo.facts`, the capability `toolFacts`); the policy editor gains Rules, Approvers and Exclusions, each shown only where `policy_forms` lists the member, with `setRules`, `setApprovers` and `setExclude`, `checkRules` and the `permissions-rules` helpers, and a save the contract would refuse is not sent (`rules_invalid`); `Permissions` shows the break-glass setting (`setApprovalRouting`); the dry run shows the rule that decided and the facts the call lacked; the approval detail lists the requirements of an approval (`requirementsOf`); `ConnectionsError` and `PermissionsError` carry the problem's `member`. In `@noblecloak/cards`: `toApprovalCard` emits one `CardRequirement` per requirement of the read (with optional `approvers`, `needed` and `approvals`), both renderers add a requirements line when the read carried them, and `CARD_MODEL_VERSION` is 3. A read without requirements renders exactly as before.
