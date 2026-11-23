---
'@noblecloak/react': minor
---

`<Approvals>`: the list and the detail say in words what is asked and by whom, and the decision is always reachable. The TypeScript API is additive; the DOM and the stylesheet are not: see "Changed in the DOM and CSS" below.

A row is one sentence, the whole tool reference, the side-effect level and age, and "Review and decide". For a call the sentence is "{requester} wants to use {tool} ({source})"; for a policy-set proposal "Policy setup from {requester}", or "Policy setup for {agent}, from {requester}" when the request names another agent. `{requester}` is the principal the service verified (`requester.display_name`) and is always the one named as asking. `agent.name` is the caller's own display hint, so it is never the asker: it shows only as "via {agent}" on a call's detail line (and, for a proposal, as the agent it is for). With no requester name the sentence has none and the id stays in the detail. `{tool}` and `{source}` are the tool reference split at its last `:` (an `mcp:` reference is the tool and its server), as written, so `issue_refund` and `issue-refund` and the same tool of two namespaces never read alike. Names are cut short and isolated. The open request is headed by the same sentence, and "Recently decided" rows use it. The checkbox of a row is named by the sentence.

The reason box, Approve and Deny are one group, "Your decision", pinned to the bottom of the screen under a long call. The group says why the buttons are off when the call is not shown in full or the request changed and is not acknowledged. A policy-set proposal's full call is under "Show the full call": open, and collapsible by the approver (the summary above it reads only some members of the call). "Show all" keeps the call in place and moves focus to its heading. Approve on a `delete` or `admin` call opens a modal (the theme's `ConfirmDialog`: focus held inside and starting on Cancel, Escape cancels) that names the request and the level; Deny still never asks, and the dialog closes without sending if the request can no longer be decided while it is open.

Changed in the DOM and CSS:

- the `.nc-no-choose` element (the note beside a row with no checkbox) is gone; the note is a muted span inside the row button, with new text;
- the inline "Confirm approval" group (`role="group"` labelled "Confirm approval", with its prompt and two buttons) is gone; a dialog replaces it;
- a queue row's accessible name is now its sentence, the reference, the level, the age and "Review and decide" (it was the reference, requester, level, digest and age), and its button carries `data-approval-id`;
- `.nc-actions` is now `position: sticky` and `display: flex` (it was a grid) and has `role="group"`; the reason box is 2 rows (was 3);
- new classes `nc-call-fold`, `nc-row-open` and `nc-row-ref`; `details` and `summary` are in the stylesheet's element reset; the call's heading takes focus after "Show all".

Additive `labels` keys: `rowTitleTool`, `rowTitleToolAnon`, `rowTitleProposal`, `rowTitleProposalFor`, `rowTitleProposalAgent`, `rowTitleProposalAnon`, `toolWithSource`, `rowToolUnknown`, `rowVia`, `rowOpen`, `callFullToggle`, `decisionLabel`, `decisionCallNotWhole`, `decisionDigestChanged`, `confirmHeading`, `confirmRequest`. No key is removed or renamed. `rowDigest` and `rowRequester` are no longer shown in a row. Default text changed for `rowSelect` ("Select: {tool}", where `{tool}` is now the sentence), `rowNoBatchReadable` ("Open this request to read its call before approving.") and `rowNoBatchUnknown` ("Open this request to read it before approving.").
