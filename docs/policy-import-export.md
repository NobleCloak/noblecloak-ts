# Importing and exporting tool policies

Tool policies can leave and come back as files: **Cedar** (in NobleCloak's dialect) or an **AGT manifest** (an Agent
Control Specification manifest whose `pre_tool_call` binds an inline Cedar policy set). The converter is
`@noblecloak/policy-formats`; the Permissions module (`@noblecloak/react/permissions`) puts it on screen as an import
and export panel. This page says what each direction does, what a file cannot carry, and what an import changes. The
mapping itself, statement by statement, is in the converter's README.

## Turning the panel on

The panel is `PolicyRoundTrip`, or `Permissions`' `roundTrip` prop. The app passes the converter in, so an app that
does not use the panel never bundles it:

```tsx
<Permissions
  controller={policies}
  roundTrip={{
    formats: () => import('@noblecloak/policy-formats'),
    // Only to import: the importer parses Cedar with @cedar-policy/cedar-wasm (about 4.4 MB), loaded on the first import.
    loadImporter: () => import('@noblecloak/policy-formats/import'),
  }}
/>
```

Without `loadImporter` the panel exports only. A browser app that imports files installs `@cedar-policy/cedar-wasm`
4.14.0 and, where its bundler does not load WebAssembly from that package's default entry, passes a parser it has
initialised as `cedar`.

## Export

- **Cedar**: every published tool policy, or one policy; for one policy with a pending draft, the draft if you choose
  it, and a policy never published as the draft it is. Every `tool_invocation` form is carried.
- **AGT manifest**: every published tool policy and every listed tool that can be called (a withdrawn tool, or one of
  a status the page does not know, is left out of the catalog, so AGT refuses it as the service does; a policy that
  still names one is reported, since a target engine may allow it). A manifest binds one policy set, so it replaces
  whatever the host has bound there, and AGT fails a call to a tool missing from its catalog closed. Choose the AGT
  release: 5.0 (the latest release, the default) or main.

Before the file is downloaded the panel shows the **export report**: what was not exported at all, what was exported
but is not enforced as NobleCloak enforces it, and file-wide notes (for example, that the target engine denies a call
no statement matches). The file opens with the same report as a comment block, so it says itself what it lost. What a
file cannot carry:

- `ask` and `escalate` need an approval, which a plain Cedar engine and AGT 5.0's own dispatcher do not have; they are
  written so the engine denies the call (fail closed), and an import reads them back as `ask` and `escalate`.
- `on_deny`, `expires_after` and approver groups travel as annotations, which a Cedar engine does not enforce.
- AGT names no end user, so a policy for a user, role, group or service is not exported to AGT.
- Policies of other kinds (approval routing, duplicate requests, spending) are never exported. Approval routing is
  an organisation setting for who may satisfy approvals, not a policy on a call.
- A policy whose tools the service did not state cannot be written; the report and the file name it.

## Rules and approvers

A policy can carry rules over the facts of a call, approvers and an exclusion (contract rev 16). A Cedar or AGT
engine sees none of a call's facts, so a rule is never turned into a condition. Instead the policy is written as
one statement with the **tightest outcome it can reach**: the tightest of its mode and every rule's result, and
`ask` whenever a rule tests a fact other than by `exists`, since NobleCloak asks when that fact is missing. A
policy whose mode is `always_allow` and whose rules test a fact other than by `exists` therefore exports as `ask`,
and an engine that cannot ask denies the call (fail closed). Rules never loosen the export: it is at least as
tight as the mode, and a policy whose rules test facts only by `exists` exports as the tightest of its mode and its rules' results, with no added `ask`. Never looser than NobleCloak's own evaluation is the rule.

- **What maps.** The statement's outcome, as for any mode. The rules (in order), the policy's approvers and the
  exclusion ride in annotations, so importing the file back restores the exact policy. The import checks that the
  statement still equals the tightest outcome of those rules; a file edited so that it no longer does is a
  conflict and is not imported.
- **What is reported.** Each of `rules`, `approvers` and `exclude` is listed as lossy, by member: another engine
  applies only the statement's outcome, not the per-call rules, and, when a rule tests a fact other than by `exists`, in NobleCloak a missing fact asks (the report says so only then).
- **What is not exported.** The facts a tool declares (their bindings): the export carries no tool metadata.
  Approval routing, the organisation's setting for who may satisfy approvals, is listed as not exported.

## Import

Paste a file or choose one. The panel tells Cedar from an AGT manifest by its shape, reads it, and shows the **import
report**, always: what was not imported, what was imported in part, and statements whose body and annotations
disagree (a conflict: nothing of that statement is imported). Then, for each policy in the file:

- **Matched or new.** A statement this converter wrote names the policy it came from. That policy, when it is among
  the tool policies the page lists for you, is the one the import updates; otherwise the policy is saved as a new one.
- **What it would change.** The policy is compared with the version a save would replace: the pending draft when
  there is one, else the published version. Each difference is listed; a policy with none is left alone. When the
  service did not say which tools that version governs, the panel says so and offers no save.
- **Save as a draft.** Saving writes the change as a draft, never as the version in force, and records where it came
  from (the file's format and the SHA-256 of its bytes, `origin`; for pasted text, of the text as pasted, which a
  browser may have changed, for example in its line endings). A policy created this way is marked imported. A
  draft is saved only over the version it was compared with; if that changed meanwhile, the save is refused.
- **Then the usual flow.** Open the saved policy to run it as a dry run and to publish it, where publishing is
  offered.

A form the service says it does not enforce (`policy_forms` in its capabilities) is shown and not offered for saving.
A refusal the service gives anyway is shown with its reason. Where policies cannot be authored, an import is shown,
with its report and its changes, and nothing is saved.

## Where each piece comes from

`PolicyWrite.origin` and `Policy.origin` (where an imported version came from), `Policy.draft_version` (whether a
published policy has a pending draft), `Capabilities.policy_forms` (the forms a service enforces), and the policy
routes: `GET /v1/policies`, `GET /v1/policies/{id}/versions`, `POST /v1/policies`, `PUT /v1/policies/{id}`,
`POST /v1/policies/{id}/simulate`, `POST /v1/policies/{id}/publish`, and `GET /v1/tools` for the catalog of an AGT
manifest. The conversion happens in the browser; no import or export route is called.
