/**
 * The broken-mock matrix. Each row flips ONE behaviour of the mock and names the scenarios that must
 * then fail. A negative scenario that passes against a server with its defect is not testing
 * anything, so every scenario tagged `negative` has to appear in at least one row.
 */
import { availableParallelism } from 'node:os';

import type { Break } from '../mock/breaks.js';
import { NO_RUNS_RUN, runAgainstMock } from './against-mock.js';
import type { MockRun } from './against-mock.js';
import { loadScenarios } from './scenarios.js';
import type { Report, Scenario } from './types.js';

export interface Flip {
  readonly flip: Break;
  readonly deployment: 'hosted' | 'edge';
  /** Serve and advertise only these families, as `nc-mock --advertise` does. */
  readonly advertise?: readonly string[];
  /** The batch limits the mock advertises from the start, for the scenarios that read them from capabilities. */
  readonly limits?: MockRun['limits'];
  /** What the mock restricts and advertises, for the scenarios about a restriction. */
  readonly restrictions?: MockRun['restrictions'];
  /** Scenario ids that must fail when this behaviour is broken. */
  readonly fails: readonly string[];
}

const SSRF = [
  'loopback',
  'metadata',
  'rfc1918',
  'hostname-resolving-to-loopback',
  'hostname-embedding-metadata-ip',
  'ipv6-loopback',
  'localhost-name',
  'ipv4-mapped-loopback',
  'ipv4-mapped-metadata',
  'trailing-dot-localhost',
  'nat64-metadata',
  'dashed-hostname-embedding-loopback',
  'decimal-ip',
  'userinfo-masking-loopback',
  'single-label-host',
].flatMap((name) => [`callback-unroutable-${name}`, `callback-unroutable-${name}-webhooks`]);

export const MATRIX: readonly Flip[] = [
  { flip: 'allow_token_replay', deployment: 'hosted', fails: ['negative-replayed-resume-token'] },
  {
    flip: 'allow_service_resolve',
    deployment: 'hosted',
    fails: [
      'negative-service-cannot-resolve',
      'negative-service-cannot-approve',
      'negative-service-cannot-deny',
    ],
  },
  {
    // The surface rule is not implemented: the creator is never eligible, whatever its token's client.
    flip: 'surface_self_approval_refused',
    deployment: 'hosted',
    fails: ['creator-may-resolve-from-the-approver-surface'],
  },
  {
    // A token issued to the approver surface opens an obligation through POST /v1/approvals or a step_up decision.
    flip: 'surface_token_may_open',
    deployment: 'hosted',
    fails: ['approver-surface-token-cannot-open'],
  },
  {
    // A token issued to the approver surface spends a Resumption.
    flip: 'surface_token_may_consume',
    deployment: 'hosted',
    fails: ['approver-surface-token-cannot-consume'],
  },
  {
    // A user's token without the advertised scope resolves, approves, denies or batch-resolves.
    flip: 'resolve_without_scope_allowed',
    deployment: 'hosted',
    fails: ['user-token-without-resolve-scope-is-insufficient-scope'],
  },
  {
    // The repeat decision for a principal-scoped proxy obligation answers allow, which no gateway can admit.
    flip: 'principal_scoped_proxy_allowed',
    deployment: 'hosted',
    fails: ['lifecycle-proxied-tool-principal-scoped'],
  },
  {
    // The record names an approval and the 201 carries no approval_link.
    flip: 'approval_link_missing',
    deployment: 'hosted',
    fails: ['record-reports-whether-it-linked-to-the-approval'],
  },
  {
    // The 201 always says linked, though the approval was not consumed or already had an outcome record.
    flip: 'approval_link_always_linked',
    deployment: 'hosted',
    fails: ['record-reports-whether-it-linked-to-the-approval'],
  },
  {
    flip: 'allow_creator_self_resolve',
    deployment: 'hosted',
    fails: ['negative-ineligible-resolve', 'creator-cannot-self-approve-through-either-door'],
  },
  {
    flip: 'ignore_org_scope',
    deployment: 'hosted',
    fails: [
      'tenancy-approvals-isolated',
      'negative-other-organisation-cannot-read-an-approval-with-a-continuation',
      'tenancy-records-isolated',
      'tenancy-record-chain-isolated',
      'tenancy-runs-isolated',
      'tenancy-checkpoint-counts-own-records-only',
      'tenancy-tools-isolated',
      'tenancy-connections-isolated',
      'tenancy-webhooks-isolated',
      'tenancy-agents-isolated',
      'tenancy-run-cannot-name-foreign-agent',
      'tenancy-policies-isolated',
      'tenancy-policy-writes-isolated',
      'hosted-policy-import-export',
      'tenancy-policy-retire-isolated',
      'tenancy-connection-links-isolated',
    ],
  },
  { flip: 'ignore_stale_digest', deployment: 'hosted', fails: ['negative-stale-digest'] },
  {
    flip: 'accept_attestation',
    deployment: 'hosted',
    fails: ['negative-caller-supplied-attestation'],
  },
  {
    flip: 'accept_approval_id_on_create',
    deployment: 'hosted',
    fails: ['negative-caller-supplied-approval-id'],
  },
  {
    flip: 'accept_actor_headers',
    deployment: 'hosted',
    fails: ['header-identity-without-token-401-every-route'],
  },
  {
    // Only the five listed names are refused: a name under the prefix that is not listed is read.
    flip: 'accept_unlisted_prefixed_headers',
    deployment: 'hosted',
    fails: [
      'header-identity-without-token-401-every-route',
      'header-identity-with-valid-token-401-every-route',
    ],
  },
  {
    flip: 'actor_headers_override_token',
    deployment: 'hosted',
    fails: ['header-identity-with-valid-token-401-every-route'],
  },
  {
    flip: 'org_header_overrides_token',
    deployment: 'hosted',
    fails: ['header-identity-with-valid-token-401-every-route'],
  },
  {
    flip: 'permissions_header_overrides_token',
    deployment: 'hosted',
    fails: ['header-identity-with-valid-token-401-every-route'],
  },
  {
    flip: 'unmatched_routes_open',
    deployment: 'hosted',
    fails: ['head-without-token-refused-every-route'],
  },
  {
    // Routes of families the deployment does not advertise answer anyone: the no-token and HEAD probes
    // reach them and may not meet a 200.
    flip: 'unadvertised_routes_open',
    deployment: 'hosted',
    advertise: ['decisions', 'records'],
    fails: [
      'header-identity-without-token-401-every-route',
      'header-identity-with-valid-token-401-every-route',
      'head-without-token-refused-every-route',
    ],
  },
  {
    // The same on edge, where every hosted-only route is unadvertised: it must still be 404.
    flip: 'unadvertised_routes_open',
    deployment: 'edge',
    fails: ['hosted-routes-404-on-edge'],
  },
  {
    flip: 'accept_dpop_as_bearer',
    deployment: 'hosted',
    fails: ['negative-dpop-scheme-unsupported', 'negative-dpop-bound-token-unsupported'],
  },
  { flip: 'accept_missing_org', deployment: 'hosted', fails: ['negative-no-organisation-claim'] },
  {
    flip: 'accept_missing_scope',
    deployment: 'hosted',
    fails: ['negative-service-without-module-api-scope'],
  },
  { flip: 'accept_missing_token', deployment: 'hosted', fails: ['negative-no-token'] },
  { flip: 'ignore_audience', deployment: 'hosted', fails: ['negative-wrong-audience'] },
  { flip: 'accept_forged_signature', deployment: 'hosted', fails: ['negative-forged-token'] },
  { flip: 'accept_expired_token', deployment: 'hosted', fails: ['negative-expired-token'] },
  { flip: 'sign_unlisted_key', deployment: 'hosted', fails: ['resumption-signature-verification'] },
  {
    flip: 'unbound_resumption_signature',
    deployment: 'hosted',
    fails: ['resumption-signature-verification'],
  },
  {
    flip: 'consume_ignores_action',
    deployment: 'hosted',
    fails: ['negative-consume-wrong-action'],
  },
  {
    flip: 'idempotency_ignored',
    deployment: 'hosted',
    fails: ['idempotency-records', 'idempotency-appends-once'],
  },
  { flip: 'callback_unguarded', deployment: 'hosted', fails: SSRF },
  {
    flip: 'resumption_open_to_approver',
    deployment: 'hosted',
    fails: ['negative-resumption-audience'],
  },
  {
    // A final approval is still matched: an identical call joins it instead of opening afresh, or of being
    // denied as a duplicate of a rejection.
    flip: 'terminal_not_freed',
    deployment: 'hosted',
    fails: [
      'terminal-withdrawn-frees-identity',
      'terminal-expiry-frees-identity',
      'rejected-duplicate-is-denied-by-default',
      'rejected-duplicate-create-approval-is-409',
      'rejected-duplicate-frees-the-call-outside-the-window',
      'rejected-duplicate-batch-decides-identical-elements-as-one',
      'rejected-duplicate-ask-again-reopens-with-prior-rejections',
    ],
  },
  {
    // The rev 9 behaviour on a deployment that advertises the rule: a rejection frees the call at once.
    flip: 'rejected_duplicate_reopened',
    deployment: 'hosted',
    fails: [
      'rejected-duplicate-is-denied-by-default',
      'rejected-duplicate-create-approval-is-409',
      'rejected-duplicate-batch-decides-identical-elements-as-one',
      'rejected-duplicate-ask-again-reopens-with-prior-rejections',
    ],
  },
  {
    // The duplicate is refused without saying why or naming the rejection.
    flip: 'rejected_duplicate_reason_missing',
    deployment: 'hosted',
    fails: [
      'rejected-duplicate-is-denied-by-default',
      'rejected-duplicate-create-approval-is-409',
      'rejected-duplicate-batch-decides-identical-elements-as-one',
      'rejected-duplicate-ask-again-reopens-with-prior-rejections',
    ],
  },
  {
    // A rejection refuses the call for ever: the window and ask_again are ignored.
    flip: 'rejection_never_frees',
    deployment: 'hosted',
    fails: [
      'rejected-duplicate-frees-the-call-outside-the-window',
      'rejected-duplicate-ask-again-reopens-with-prior-rejections',
    ],
  },
  {
    // Identical elements of one batch each open their own approval.
    flip: 'batch_duplicates_split',
    deployment: 'hosted',
    fails: ['rejected-duplicate-batch-decides-identical-elements-as-one'],
  },
  {
    // Anyone of the organisation authors, replaces and publishes policies.
    flip: 'policy_authoring_unguarded',
    deployment: 'hosted',
    fails: ['negative-policy-authoring-needs-an-administrator'],
  },
  {
    // Simulate answers the decision and does not say what it considered.
    flip: 'simulate_considered_missing',
    deployment: 'hosted',
    fails: ['negative-simulate-lists-the-policies-it-considered'],
  },
  {
    // A policy's config is accepted whatever its kind.
    flip: 'policy_config_kind_unbound',
    deployment: 'hosted',
    fails: ['negative-policy-config-must-fit-its-kind'],
  },
  {
    flip: 'resumption_after_withdraw',
    deployment: 'hosted',
    fails: ['negative-resumption-after-withdraw'],
  },
  {
    // Every approval handle carries a member the document does not declare; a run that holds responses to
    // the document (as a run against the mock does unless it opts out) fails the first scenario that reads one.
    flip: 'undeclared_handle_member',
    deployment: 'hosted',
    fails: ['lifecycle-external-tool'],
  },
  { flip: 'decide_consumes', deployment: 'hosted', fails: ['lifecycle-external-tool'] },
  {
    flip: 'continuation_multiplicity_ignored',
    deployment: 'hosted',
    fails: ['continuation-multiplicity'],
  },
  { flip: 'digest_not_jcs', deployment: 'hosted', fails: ['identity-corpus-digests'] },
  { flip: 'dedupe_split_doors', deployment: 'hosted', fails: ['dedupe-across-both-doors'] },
  { flip: 'authzen_discovery_broken', deployment: 'hosted', fails: ['authzen-unmodified-client'] },
  {
    flip: 'outcome_not_linked',
    deployment: 'hosted',
    fails: ['lifecycle-external-tool', 'record-reports-whether-it-linked-to-the-approval'],
  },
  {
    flip: 'external_tool_no_resume_token',
    deployment: 'hosted',
    fails: ['resumption-external-has-token-proxied-does-not'],
  },
  {
    flip: 'proxy_tool_resume_token',
    deployment: 'hosted',
    fails: ['resumption-external-has-token-proxied-does-not'],
  },
  {
    flip: 'skip_request_validation',
    deployment: 'hosted',
    fails: [
      'decision-rejects-bad-body',
      'negative-resolve-closed-enum',
      'negative-record-bad-context-and-policy',
      'negative-record-derived-fields-not-accepted',
      'negative-record-degraded-invalid',
      'negative-batch-above-100-is-invalid-request',
      'rev17-unknown-continuation-kind-is-refused',
      'rev17-claude-agent-sdk-is-pull-only',
    ],
  },
  { flip: 'withdraw_by_anyone', deployment: 'hosted', fails: ['terminal-withdraw-requester-only'] },
  {
    flip: 'response_schema_violation',
    deployment: 'hosted',
    fails: ['routes-tools', 'every-route-responds-per-schema'],
  },
  {
    // The capabilities read that starts the run does not match the document: the run fails, it does
    // not assume a scope.
    flip: 'capabilities_schema_violation',
    deployment: 'hosted',
    fails: ['capabilities-read-at-run-start'],
  },
  {
    // The capabilities read answers 503: the run fails, it does not skip.
    flip: 'capabilities_unreadable',
    deployment: 'hosted',
    fails: ['capabilities-read-at-run-start'],
  },
  {
    // The deployment serves no approvals and takes a continuation on a step-up anyway.
    flip: 'accept_continuation_without_approvals',
    deployment: 'hosted',
    advertise: ['decisions', 'records'],
    fails: ['continuation-unsupported-without-approvals'],
  },
  {
    // The deployment advertises approvals but serves only the floor: every scenario that needs
    // approvals runs and meets a 404.
    flip: 'advertise_unserved',
    deployment: 'hosted',
    advertise: ['decisions', 'records'],
    fails: [
      'lifecycle-proxied-tool-principal-scoped',
      'decision-step-up-shape',
      'negative-replayed-resume-token',
      'approvals-queue-and-detail',
    ],
  },
  {
    // A default decision, a batch item, the AuthZEN context and a record written without a policy
    // say `policy: null` instead of leaving the member out.
    flip: 'null_policy_on_default',
    deployment: 'hosted',
    fails: [
      'decision-default-policy-absent',
      'authzen-default-decision-has-no-policy',
      'records-default-decision-reads-back-without-policy',
    ],
  },
  {
    // Every reader gets the continuation, not the principal that created the approval alone.
    flip: 'continuation_visible_to_all',
    deployment: 'hosted',
    fails: [
      'continuation-withheld-from-other-readers',
      'continuation-withheld-from-another-user-of-the-organisation',
      'continuation-on-the-stream-is-the-creators-alone',
    ],
  },
  {
    // `created_by` is ignored altogether: no filter, and any value is accepted.
    flip: 'created_by_filter_ignored',
    deployment: 'hosted',
    fails: ['approvals-created-by-me', 'negative-created-by-takes-only-me'],
  },
  {
    // A service principal gets the organisation's view of approvals, not its own.
    flip: 'service_principal_sees_org_approvals',
    deployment: 'hosted',
    fails: [
      'negative-service-principal-sees-only-what-it-created',
      'negative-service-principal-cannot-see-another-service-principals',
      'negative-service-principal-writes-to-another-service-principals-approval-are-404',
    ],
  },
  {
    // A degraded record reads back as a normal one: the member is dropped.
    flip: 'degraded_dropped_on_read',
    deployment: 'hosted',
    fails: ['records-degraded-round-trip', 'records-degraded-filter'],
  },
  {
    // The degraded filter and its value check are ignored.
    flip: 'degraded_filter_ignored',
    deployment: 'hosted',
    fails: ['records-degraded-filter', 'negative-records-degraded-filter-takes-true-or-false'],
  },
  {
    // A problem carries no request id.
    flip: 'problem_without_request_id',
    deployment: 'hosted',
    fails: ['problem-request-id-on-every-problem', 'negative-no-token', 'negative-stale-digest'],
  },
  {
    // A 500 or 503 answers `about:blank` with no typed code.
    flip: 'server_error_untyped',
    deployment: 'hosted',
    fails: ['server-error-503-is-service-unavailable', 'server-error-500-is-internal-error'],
  },
  {
    // A 503 does not say when to retry.
    flip: 'retry_after_missing',
    deployment: 'hosted',
    fails: ['server-error-503-is-service-unavailable'],
  },
  {
    flip: 'reserved_tool_ref_accepted',
    deployment: 'hosted',
    fails: ['negative-tools-reserved-reference'],
  },
  {
    flip: 'system_tool_ref_accepted',
    deployment: 'hosted',
    fails: ['negative-tools-system-reference'],
  },
  {
    flip: 'side_effect_level_downgrade_accepted',
    deployment: 'hosted',
    fails: [
      'negative-tools-side-effect-level-never-falls',
      'negative-tools-write-and-external-share-a-rank',
    ],
  },
  {
    // The limit is advertised and a batch above it is served.
    flip: 'batch_limit_not_enforced',
    deployment: 'hosted',
    fails: ['negative-decision-batch-limit', 'negative-records-batch-limit'],
  },
  {
    // The same flip against a deployment that advertises its limits without a control request.
    flip: 'batch_limit_not_enforced',
    deployment: 'hosted',
    limits: { decisions: 50, records: 50 },
    fails: [
      'advertised-decision-batch-limit-is-enforced',
      'advertised-records-batch-limit-is-enforced',
    ],
  },
  {
    // The continuation an approval echoes is another approval's of the same creator.
    flip: 'continuation_cross_wired',
    deployment: 'hosted',
    fails: [
      'continuation-echoed-to-its-creator-in-every-state',
      'continuation-withheld-from-other-readers',
      'continuation-on-the-stream-is-the-creators-alone',
    ],
  },
  {
    // The mock keeps and shows the arguments of a tool that does not show them to approvers.
    flip: 'arguments_without_opt_in',
    deployment: 'hosted',
    fails: ['approval-arguments-single-read-only'],
  },
  {
    // Every operation that returns an approval carries its arguments, not only the single read.
    flip: 'arguments_beyond_the_single_read',
    deployment: 'hosted',
    fails: ['approval-arguments-single-read-only'],
  },
  {
    // The arguments survive a rejection, a withdrawal and a consumption.
    flip: 'arguments_kept_when_final',
    deployment: 'hosted',
    fails: [
      'approval-arguments-cleared-at-every-final-state',
      'approval-arguments-cleared-on-expiry',
    ],
  },
  {
    // Turning the setting off does not take the arguments of an open approval away from its readers.
    flip: 'arguments_kept_when_setting_off',
    deployment: 'hosted',
    fails: ['approval-arguments-follow-the-setting'],
  },
  {
    // A user who may not approve is shown the arguments.
    flip: 'arguments_to_ineligible_reader',
    deployment: 'hosted',
    fails: ['approval-arguments-withheld-from-an-ineligible-user'],
  },
  {
    // An approval the default policy decided names a policy anyway.
    flip: 'policy_synthesised_on_default_approval',
    deployment: 'hosted',
    fails: ['approval-policy-absent-when-the-default-applied'],
  },
  {
    // POST /v1/approvals for a tool with no row is the generic 400, not approval_unroutable.
    flip: 'approval_unroutable_generic',
    deployment: 'hosted',
    fails: ['negative-approval-unroutable'],
  },
  {
    // A reference the deployment dispatches under another identity is registered, or refused as already registered, not as in use.
    flip: 'tool_ref_in_use_accepted',
    deployment: 'hosted',
    fails: ['negative-tools-ref-in-use'],
  },
  {
    // A policy ask is denied on the headless and workflow channels.
    flip: 'headless_ask_denied',
    deployment: 'hosted',
    fails: ['decision-ask-is-step-up-on-every-channel'],
  },
  {
    // A records batch is written element by element: a refusal in the middle leaves the earlier ones.
    flip: 'records_batch_partial_write',
    deployment: 'hosted',
    fails: [
      'negative-records-batch-is-all-or-nothing',
      'negative-records-batch-with-an-invisible-approval-is-all-or-nothing',
    ],
  },
  {
    // An approval does not name the principal that created it.
    flip: 'requester_missing',
    deployment: 'hosted',
    fails: ['approval-requester-is-the-creator'],
  },
  {
    // A principal named on an approval is named by its own id.
    flip: 'display_name_is_the_id',
    deployment: 'hosted',
    fails: ['approval-principals-carry-display-names'],
  },
  {
    // The single read says `shown` whatever the reader and the state.
    flip: 'arguments_state_wrong',
    deployment: 'hosted',
    fails: [
      'approval-arguments-single-read-only',
      'approval-arguments-withheld-from-an-ineligible-user',
      'approval-arguments-cleared-at-every-final-state',
      'approval-arguments-not-sent-when-opened-with-a-digest',
    ],
  },
  {
    // A record and a Resumption name their principals, which only an approval may do.
    flip: 'names_leak_into_records',
    deployment: 'hosted',
    fails: ['record-and-resumption-carry-no-names'],
  },
  {
    // A registration that clashes with a hidden tool is answered by the level, as for a visible tool.
    flip: 'hidden_tool_clash_reveals_level',
    deployment: 'hosted',
    fails: ['negative-hidden-tool-clash-is-one-refusal'],
  },
  {
    // The list rows carry no `arguments_state`.
    flip: 'list_arguments_state_missing',
    deployment: 'hosted',
    fails: [
      'approval-list-rows-carry-arguments-state',
      'approval-list-rows-withhold-before-not-enabled',
    ],
  },
  {
    // A resolved approval read by someone who may not decide it is told `withheld`, not `final`.
    flip: 'final_state_withheld_from_ineligible',
    deployment: 'hosted',
    fails: ['approval-arguments-withheld-from-an-ineligible-user'],
  },
  {
    // A reader who may not approve is told the tool's setting (`not_enabled`) instead of `withheld`.
    flip: 'ineligible_reader_learns_tool_setting',
    deployment: 'hosted',
    fails: [
      'approval-arguments-state-withheld-before-not-enabled',
      'approval-list-rows-withhold-before-not-enabled',
    ],
  },
  {
    // `waiting_on` goes to every reader of a pending approval, not its creator alone.
    flip: 'waiting_on_visible_to_all',
    deployment: 'hosted',
    fails: ['approval-waiting-on-is-the-creators'],
  },
  {
    // `waiting_on` says no one is waited on, whoever is: count 0 and no names.
    flip: 'waiting_on_content_wrong',
    deployment: 'hosted',
    fails: ['approval-waiting-on-is-the-creators'],
  },
  {
    // `waiting_on` names the creator, who may not decide it: the ineligible are listed.
    flip: 'waiting_on_lists_ineligible',
    deployment: 'hosted',
    fails: ['approval-waiting-on-is-the-creators'],
  },
  {
    // `waiting_on` is put on a row of the list and on a stream event, not on the single read alone.
    flip: 'waiting_on_on_list_rows',
    deployment: 'hosted',
    fails: ['approval-waiting-on-is-the-single-reads-alone'],
  },
  {
    // `on_deny` goes to every reader of the approval, not its creator alone.
    flip: 'on_deny_visible_to_all',
    deployment: 'hosted',
    fails: ['approval-on-deny-is-the-creators-snapshot'],
  },
  {
    // `on_deny` goes to every subscriber of the stream, though the reads keep it to the creator.
    flip: 'on_deny_on_stream_to_all',
    deployment: 'hosted',
    fails: ['approval-on-deny-is-the-creators-snapshot'],
  },
  {
    // `on_deny` goes to every subscriber on the event that announces a new approval, though the approve event keeps it
    // to the creator.
    flip: 'on_deny_on_creation_event_to_all',
    deployment: 'hosted',
    fails: ['approval-on-deny-is-the-creators-snapshot'],
  },
  {
    // A policy that states no `on_deny` is read as `resume`.
    flip: 'on_deny_defaults_to_resume',
    deployment: 'hosted',
    fails: ['approval-on-deny-is-absent-when-the-policy-states-none'],
  },
  {
    // With the eligibility lookup down, the creator's own read fails (503) instead of omitting `waiting_on`.
    flip: 'waiting_on_fails_the_read',
    deployment: 'hosted',
    fails: ['negative-waiting-on-is-best-effort'],
  },
  {
    // The eligibility outage is a bare 503: it names no reason.
    flip: 'eligibility_reason_missing',
    deployment: 'hosted',
    fails: ['negative-eligibility-outage-is-named'],
  },
  {
    // A 503 carries the header and not the body member, so a browser cannot read the hint.
    flip: 'retry_after_body_missing',
    deployment: 'hosted',
    fails: ['negative-retry-hint-is-in-the-body', 'negative-eligibility-outage-is-named'],
  },
  {
    // The stream ignores approver, its value included, and delivers the organisation's events.
    flip: 'stream_approver_filter_ignored',
    deployment: 'hosted',
    fails: ['approvals-stream-for-approver', 'negative-approver-filter-takes-only-me'],
  },
  {
    // `state` is read as one value, so a set matches nothing and a bad value is not refused.
    flip: 'state_set_ignored',
    deployment: 'hosted',
    fails: [
      'approvals-list-state-set-ordered-by-resolution',
      'approvals-stream-for-approver',
      'negative-approver-filter-takes-only-me',
    ],
  },
  {
    // `order=resolved_at` orders by creation and returns approvals that were never resolved.
    flip: 'order_ignored',
    deployment: 'hosted',
    fails: ['approvals-list-state-set-ordered-by-resolution'],
  },
  {
    // A batch that names an approval twice answers the repeat with the first answer, as if applied again.
    flip: 'resolve_batch_repeat_answered_as_applied',
    deployment: 'hosted',
    fails: ['resolve-batch-edge-cases'],
  },
  {
    // The first element a batch resolve cannot resolve fails the call and drops the rest.
    flip: 'resolve_batch_aborts_on_first_error',
    deployment: 'hosted',
    fails: ['resolve-batch-mixed-outcomes'],
  },
  {
    // The advertised resolve batch limit is not enforced.
    flip: 'resolve_batch_over_limit_accepted',
    deployment: 'hosted',
    fails: ['negative-resolve-batch-over-limit'],
  },
  {
    // A resolution the deployment does not advertise is produced.
    flip: 'unserved_resolution_accepted',
    deployment: 'hosted',
    restrictions: { resolutions: ['approved', 'rejected'] },
    fails: ['negative-unserved-resolution-is-refused'],
  },
  {
    // Arguments beyond the advertised bound are kept.
    flip: 'arguments_bound_not_enforced',
    deployment: 'hosted',
    restrictions: { approvalArgumentsMaxBytes: 512 },
    // Rev 14: the bound holds for the arguments of a proposal too.
    fails: ['approval-arguments-beyond-the-advertised-bound', 'proposal-arguments-bound'],
  },
  {
    // A continuation whose delivery the deployment does not list is accepted.
    flip: 'undeclared_delivery_accepted',
    deployment: 'hosted',
    restrictions: { deliveries: ['pull', 'held'] },
    fails: ['negative-undeclared-delivery-is-refused'],
  },
  {
    // A principal that is not an administrator registers and changes tools where only administrators may.
    flip: 'tool_registration_not_enforced',
    deployment: 'hosted',
    restrictions: { restrictToolRegistration: true },
    fails: ['negative-tool-registration-refused-to-a-non-administrator'],
  },
  {
    // A batch resolve skips the eligibility rule the single route applies.
    flip: 'resolve_batch_skips_eligibility',
    deployment: 'hosted',
    fails: ['resolve-batch-eligibility-is-per-item'],
  },
  {
    // A batch resolve with a malformed element applies the valid ones, and an empty batch is served.
    flip: 'resolve_batch_applies_partial_body',
    deployment: 'hosted',
    fails: ['resolve-batch-edge-cases'],
  },
  {
    // A batch resolve reads the store directly, so another organisation's approval is reachable.
    flip: 'resolve_batch_reaches_other_orgs',
    deployment: 'hosted',
    fails: ['tenancy-resolve-batch-isolated'],
  },
  {
    // A tool owned by one principal is listed to, and read by, a colleague.
    flip: 'tool_visible_to_colleague',
    deployment: 'hosted',
    fails: [
      'tools-principal-owned-hidden-from-colleagues',
      'negative-principal-owned-tool-read-by-colleague-is-404',
    ],
  },
  {
    // An administrator user is shown no other principal's `principal`-owned tool.
    flip: 'admin_cannot_see_private_tools',
    deployment: 'hosted',
    fails: ['tools-principal-owned-seen-by-administrator-users-only'],
  },
  {
    // A service principal is treated as an administrator for visibility: it sees a user's private tool.
    flip: 'service_principal_sees_private_tools',
    deployment: 'hosted',
    fails: ['negative-service-principal-does-not-see-a-users-private-tool'],
  },
  {
    // The agent's name on an approval is the agent's id repeated.
    flip: 'agent_name_is_the_id',
    deployment: 'hosted',
    fails: ['approval-names-its-agent'],
  },
  {
    // A body above the limit the deployment sets is accepted.
    flip: 'oversized_body_accepted',
    deployment: 'hosted',
    fails: ['negative-oversized-body-is-413'],
  },
  {
    // A run_id is read as a run of the caller's, though the deployment serves no runs.
    flip: 'run_id_without_runs_accepted',
    deployment: 'hosted',
    advertise: NO_RUNS_RUN.advertise ?? [],
    fails: ['negative-run-id-without-runs-served'],
  },
  {
    // Rev 11: considered marks no entry as what contributed to the composed decision.
    flip: 'considered_contributed_missing',
    deployment: 'hosted',
    fails: ['policies-tightest-wins-composes-and-marks-contributors'],
  },
  {
    // Rev 11: considered marks every entry as contributing, an overruled allow included.
    flip: 'every_entry_contributed',
    deployment: 'hosted',
    fails: ['policies-tightest-wins-composes-and-marks-contributors'],
  },
  {
    // Rev 11: a member simulates as a subject.
    flip: 'simulate_subject_unguarded',
    deployment: 'hosted',
    fails: ['negative-simulate-as-a-subject'],
  },
  {
    // Rev 11: a member retires a policy and discards a draft.
    flip: 'retire_unguarded',
    deployment: 'hosted',
    fails: ['negative-policy-retire-needs-an-administrator'],
  },
  {
    // Rev 11: a registration answers with its organisation credential.
    flip: 'org_credential_echoed',
    deployment: 'hosted',
    fails: ['negative-connection-org-credential'],
  },
  {
    // Rev 11: a principal-owned connection is read and listed by a colleague.
    flip: 'connection_owner_visible',
    deployment: 'hosted',
    fails: ['negative-principal-owned-connection-hidden'],
  },
  {
    // Rev 11: refresh answers its counts and registers nothing.
    flip: 'refresh_does_not_register',
    deployment: 'hosted',
    fails: ['negative-connection-refresh-registers-its-tools'],
  },
  {
    // Rev 11: a second registration of the same server is accepted.
    flip: 'duplicate_server_accepted',
    deployment: 'hosted',
    fails: ['negative-duplicate-server-url'],
  },
  {
    // Rev 11: a patch moves a connection to another URL.
    flip: 'patch_url_accepted',
    deployment: 'hosted',
    fails: ['negative-connection-url-is-fixed'],
  },
  {
    // Rev 11: a decision for a withdrawn tool is answered as for an active one.
    flip: 'withdrawn_tool_allowed',
    deployment: 'hosted',
    fails: ['negative-connection-delete-withdraws-and-readd-rebinds'],
  },
  {
    // Rev 11: registration ignores the owner kinds and the callers the deployment advertises.
    flip: 'connection_registration_not_enforced',
    deployment: 'hosted',
    restrictions: { connectionRegistration: { owner_kinds: ['org'], who: 'administrators' } },
    fails: [
      'negative-connection-registration-owner-kind-refused',
      'negative-connection-registration-administrators-only',
    ],
  },
  {
    // Rev 11: a member who sees an organisation's registration renames, refreshes or deletes it.
    flip: 'org_connection_change_unguarded',
    deployment: 'hosted',
    fails: ['negative-member-cannot-change-org-connection'],
  },
  {
    // Rev 11: a registration of a transport the deployment does not advertise is accepted.
    flip: 'undeclared_transport_accepted',
    deployment: 'hosted',
    restrictions: { connectionTransports: ['mcp'] },
    fails: ['negative-unserved-connection-transport'],
  },
  {
    // Rev 11: a link answers with the credential it was given.
    flip: 'connection_token_echoed',
    deployment: 'hosted',
    fails: ['negative-connection-links'],
  },
  {
    // Rev 11: an authorization returns to any return_to.
    flip: 'authorize_return_unchecked',
    deployment: 'hosted',
    fails: ['negative-connection-oauth-authorize'],
  },
  {
    // Rev 11: a link without consent, or with consent false, is accepted.
    flip: 'link_without_consent_accepted',
    deployment: 'hosted',
    fails: ['negative-connection-links'],
  },
  {
    // Rev 11: my_link shows another user's link.
    flip: 'link_visible_to_other_user',
    deployment: 'hosted',
    fails: ['negative-connection-links'],
  },
  {
    // Rev 11: revoking consent answers 204 and changes nothing.
    flip: 'consent_revoke_ignored',
    deployment: 'hosted',
    fails: ['negative-connection-links'],
  },
  {
    // Rev 11: a simulation as an agent also matches role policies.
    flip: 'simulate_agent_holds_roles',
    deployment: 'hosted',
    fails: ['simulate-as-an-agent'],
  },
  {
    // Rev 11 errata: discarding a draft answers 204 and keeps it.
    flip: 'discard_draft_ignored',
    deployment: 'hosted',
    fails: ['policy-retire-and-discard'],
  },
  // Rev 12: browser origins and webhooks.
  {
    // An actual request is checked against every organisation's registered origins, not the caller's.
    flip: 'origin_check_ignores_org',
    deployment: 'hosted',
    fails: ['origins-actual-request-org-checked'],
  },
  {
    // A preflight is answered against the deployment's own origins only.
    flip: 'registered_origin_preflight_refused',
    deployment: 'hosted',
    fails: ['origins-preflight-any-registered'],
  },
  {
    // A webhook still comes back with a secret.
    flip: 'webhook_secret_returned',
    deployment: 'hosted',
    fails: ['routes-webhooks'],
  },
  {
    // A delivery carries a signature that does not verify.
    flip: 'delivery_unsigned',
    deployment: 'hosted',
    fails: ['webhook-delivery-signed'],
  },
  {
    // A delivery is signed over a payload that leaves `data` out.
    flip: 'delivery_signature_skips_data',
    deployment: 'hosted',
    fails: ['webhook-delivery-signed'],
  },
  {
    // A delivery's `data` carries `arguments`.
    flip: 'delivery_carries_arguments',
    deployment: 'hosted',
    fails: ['webhook-delivery-thin'],
  },
  {
    // Anyone registers origins and manages webhooks.
    flip: 'organisation_settings_unguarded',
    deployment: 'hosted',
    fails: [
      'origins-and-webhooks-administrators-only',
      'routes-origins',
      'routes-webhooks',
      'tenancy-webhooks-isolated',
    ],
  },
  {
    // A disabled webhook still receives deliveries.
    flip: 'disabled_webhook_delivered',
    deployment: 'hosted',
    fails: ['webhook-disabled-gets-nothing'],
  },
  {
    // A delivery's `data` carries a member beyond the thin ones.
    flip: 'webhook_data_extra_member',
    deployment: 'hosted',
    fails: ['webhook-delivery-thin'],
  },
  {
    // A webhook is delivered the events of other organisations.
    flip: 'webhook_delivery_ignores_org',
    deployment: 'hosted',
    fails: ['webhook-delivery-org-scoped'],
  },
  {
    // An origin with a trailing slash, a path or a wildcard is accepted.
    flip: 'inexact_origin_accepted',
    deployment: 'hosted',
    fails: ['origins-must-be-exact'],
  },
  {
    // Rev 11 errata: a subject type advertised in policy_forms is refused with 422.
    flip: 'advertised_policy_form_refused',
    deployment: 'hosted',
    fails: ['policy-forms-advertised-are-accepted'],
  },
  {
    // Rev 11: authorizing a linked link, or a connected org_shared registration, again drops the credential in use.
    flip: 'reauthorize_drops_credential',
    deployment: 'hosted',
    fails: ['connection-reauthorize'],
  },
  {
    // Rev 11: blocked_on is shown to readers other than the creator.
    flip: 'blocked_on_shown_to_others',
    deployment: 'hosted',
    fails: ['negative-approval-blocked-on-link'],
  },
  {
    flip: 'hosted_routes_on_edge',
    deployment: 'edge',
    fails: ['hosted-routes-404-on-edge', 'edge-rev11-hosted-only-surfaces'],
  },
  { flip: 'edge_features_leak', deployment: 'edge', fails: ['capabilities-edge-features'] },
  { flip: 'suggested_on_edge', deployment: 'edge', fails: ['edge-suggested-policies-unavailable'] },
  {
    // Rev 13: any caller, a service principal included, binds an agent to a service principal.
    flip: 'agent_binding_unguarded',
    deployment: 'hosted',
    fails: ['agent-binding-admin-only'],
  },
  {
    // Rev 13: a service principal can be bound to two agents.
    flip: 'principal_bound_to_two_agents',
    deployment: 'hosted',
    fails: ['agent-binding-admin-only'],
  },
  {
    // Rev 13: the actor.agent_id hint selects the agent's policies instead of the binding.
    flip: 'hint_selects_agent_policy',
    deployment: 'hosted',
    fails: ['agent-policy-from-binding-only'],
  },
  {
    // Rev 13: a caller bound to no agent holds every agent's policies.
    flip: 'unbound_caller_holds_agent_policy',
    deployment: 'hosted',
    fails: ['agent-policy-from-binding-only'],
  },
  {
    // Rev 13: a service principal does not hold the everyone role.
    flip: 'everyone_not_held_by_service',
    deployment: 'hosted',
    fails: ['everyone-role-reaches-every-caller'],
  },
  {
    // Rev 13: a simulation as an agent drops the everyone role.
    flip: 'agent_subject_loses_everyone',
    deployment: 'hosted',
    fails: ['simulate-as-an-agent'],
  },
  {
    // Rev 13: a proposed body replaces the stored policy of the same subject instead of standing beside it.
    flip: 'simulate_set_replaces_stored',
    deployment: 'hosted',
    fails: ['simulate-set-stands-beside-stored-policies'],
  },
  {
    // Rev 13: a proposed duplicate_requests body replaces the setting in force instead of standing beside it.
    flip: 'simulate_set_duplicate_replaces_in_force',
    deployment: 'hosted',
    fails: ['simulate-set-duplicate-stands-beside-in-force'],
  },
  {
    // Rev 13: a user principal can be bound to an agent.
    flip: 'user_principal_bindable',
    deployment: 'hosted',
    fails: ['agent-binding-refuses-a-user'],
  },
  {
    // Rev 13: a considered entry of a proposed body also carries `source`, as a default does.
    flip: 'proposed_entry_has_source',
    deployment: 'hosted',
    fails: ['simulate-set-without-anything-stored'],
  },
  {
    // Rev 13: unsupported_policy_form carries no member.
    flip: 'unsupported_form_member_missing',
    deployment: 'hosted',
    fails: ['unsupported-policy-form-names-member', 'simulate-set-without-anything-stored'],
  },
  {
    // Rev 13: an approval opened by a bound service principal names the agent the hint names, not its own.
    flip: 'approval_names_hinted_agent',
    deployment: 'hosted',
    fails: ['agent-policy-from-binding-only'],
  },
  {
    // Rev 13: the everyone role is listed as a directory role.
    flip: 'everyone_listed_as_directory_role',
    deployment: 'hosted',
    fails: ['everyone-role-not-a-directory-role'],
  },
  {
    // Rev 13: the agent_id of the run actor.run_id names selects the agent's policies.
    flip: 'run_agent_selects_agent_policy',
    deployment: 'hosted',
    fails: ['agent-policy-not-from-a-run'],
  },
  {
    // Rev 13: a set simulation (POST /v1/policies/simulate) selects the agent from actor.agent_id.
    flip: 'set_simulation_reads_hint',
    deployment: 'hosted',
    fails: ['agent-policy-from-binding-only'],
  },
  {
    // Rev 13: the everyone role is listed as a directory role under a prefixed id (role:everyone).
    flip: 'everyone_listed_by_prefixed_id',
    deployment: 'hosted',
    fails: ['everyone-role-not-a-directory-role'],
  },
  {
    // Rev 14: a tool can be registered under the reserved namespace tool:noblecloak:.
    flip: 'reserved_namespace_registrable',
    deployment: 'hosted',
    fails: ['proposal-reserved-namespace'],
  },
  {
    // Rev 14: a deployment-applied reference is listed by GET /v1/tools as an ordinary tool.
    flip: 'deployment_applied_listed_as_tool',
    deployment: 'hosted',
    fails: ['proposal-reserved-namespace'],
  },
  {
    // Rev 14: a policy can target a deployment-applied reference (create, replace or simulate).
    flip: 'policy_on_deployment_applied_accepted',
    deployment: 'hosted',
    fails: ['proposal-policy-immutable'],
  },
  {
    // Rev 14: a service principal can open a proposal.
    flip: 'service_principal_can_propose',
    deployment: 'hosted',
    fails: ['proposal-refused-not-a-user'],
  },
  {
    // Rev 14: a refused proposal carries no code.
    flip: 'proposal_refusal_code_missing',
    deployment: 'hosted',
    fails: [
      'proposal-refused-not-a-user',
      'proposal-refused-bad-shape',
      'proposal-refused-agent-and-principal',
      'proposal-refused-tools-and-targets',
      'proposal-refused-baseline-exists',
      'proposal-refused-tightening-looser',
      // Rev 18: the refusals of role rows, of a proposal without an agent and of tool grants.
      'rev18-role-row-not-entitled',
      'rev18-no-agent-no-tightening-no-grants',
      'rev18-tool-grants-need-a-principal',
      'rev18-tool-grant-unknown-tool',
    ],
  },
  {
    // Rev 14: a baseline is accepted over a published policy of the role everyone.
    flip: 'baseline_over_existing',
    deployment: 'hosted',
    fails: ['proposal-refused-baseline-exists'],
  },
  {
    // Rev 14: a tightening looser than the composed result is accepted.
    flip: 'tightening_looser_accepted',
    deployment: 'hosted',
    fails: ['proposal-refused-tightening-looser'],
  },
  {
    // Rev 14: the preview leaves out the baselines that loosen a tool.
    flip: 'preview_loosening_missing',
    deployment: 'hosted',
    fails: [
      'proposal-applied-on-approval',
      'proposal-preview-is-for-approvers',
      'rev18-preview-names-a-loosening-role-row',
    ],
  },
  {
    // Rev 14: the preview is shown to every reader of the approval.
    flip: 'preview_shown_to_all',
    deployment: 'hosted',
    fails: ['proposal-preview-is-for-approvers'],
  },
  {
    // Rev 14: a user who is not an administrator approves a proposal.
    flip: 'proposal_approved_by_non_admin',
    deployment: 'hosted',
    fails: ['proposal-approver-must-be-an-administrator'],
  },
  {
    // Rev 14: a proposal that fails part-way keeps what the steps before the failure did.
    flip: 'proposal_effect_partial',
    deployment: 'hosted',
    fails: ['proposal-refused-at-approval-applies-nothing'],
  },
  {
    // Rev 14: approving applies without running the checks of opening again.
    flip: 'proposal_recheck_skipped',
    deployment: 'hosted',
    fails: ['proposal-rechecked-at-approval'],
  },
  {
    // Rev 14: an import brings in a policy that names a deployment-applied reference.
    flip: 'import_reserved_accepted',
    deployment: 'hosted',
    fails: ['proposal-import-skips-reference'],
  },
  {
    // Rev 14: the refusal to apply is not recorded in the history entry's reason.
    flip: 'proposal_refusal_reason_missing',
    deployment: 'hosted',
    fails: ['proposal-refused-at-approval-applies-nothing'],
  },
  {
    // Rev 14: denying a proposal applies it.
    flip: 'proposal_deny_applies',
    deployment: 'hosted',
    fails: ['proposal-denied-applies-nothing'],
  },
  {
    // Rev 14: an applied proposal is left approved instead of consumed.
    flip: 'proposal_not_consumed',
    deployment: 'hosted',
    fails: [
      'proposal-applied-on-approval',
      'proposal-self-approval-from-the-approver-surface',
      'rev18-role-rows-applied-without-an-agent',
      'rev18-tool-grants-previewed-and-applied',
    ],
  },
  {
    // Rev 14: a proposed policy whose config carries a member beyond mode (or an origin) is accepted.
    flip: 'proposal_config_beyond_mode_accepted',
    deployment: 'hosted',
    fails: ['proposal-refused-config-beyond-mode'],
  },
  {
    // Rev 14: mode-only is enforced for the tightenings and not for the baseline.
    flip: 'proposal_baseline_config_beyond_mode_accepted',
    deployment: 'hosted',
    fails: ['proposal-refused-config-beyond-mode'],
  },
  {
    // Rev 18: a role row is accepted from an organisation that is not entitled to policies with a role subject.
    flip: 'proposal_role_unentitled_accepted',
    deployment: 'hosted',
    fails: ['rev18-role-row-not-entitled'],
  },
  {
    // Rev 18: tool grants are accepted on a proposal whose agent names no service principal.
    flip: 'proposal_grants_without_principal_accepted',
    deployment: 'hosted',
    fails: ['rev18-tool-grants-need-a-principal'],
  },
  {
    // Rev 18: a tool grant for a tool the organisation does not hold is accepted.
    flip: 'proposal_unknown_grant_accepted',
    deployment: 'hosted',
    fails: ['rev18-tool-grant-unknown-tool'],
  },
  {
    // Rev 18: the preview leaves out the role rows a policy of everyone shadows.
    flip: 'preview_ineffective_missing',
    deployment: 'hosted',
    // Absent is what the contract allows for a preview that shadows nothing, so only the shadowed row shows it.
    fails: ['rev18-preview-names-a-shadowed-role-row'],
  },
  {
    // Rev 18: the preview leaves out the role rows that loosen a tool for their role.
    flip: 'preview_role_loosening_missing',
    deployment: 'hosted',
    fails: ['rev18-preview-names-a-loosening-role-row'],
  },
  {
    // Rev 18: a simulation as a service principal leaves out the policies of the agent it is bound to.
    flip: 'simulate_service_ignores_binding',
    deployment: 'hosted',
    fails: ['rev18-simulate-as-a-service-principal'],
  },
  {
    // Rev 18: the preview leaves out the tool grants.
    flip: 'preview_grants_missing',
    deployment: 'hosted',
    fails: ['rev18-tool-grants-previewed-and-applied'],
  },
  {
    // Rev 15: the single read lists the available actions to a reader who may not resolve the approval.
    flip: 'available_actions_shown_to_all',
    deployment: 'hosted',
    fails: ['available-actions-hidden-from-others'],
  },
  {
    // Rev 15: the single read keeps listing the available actions once the approval is resolved.
    flip: 'available_actions_shown_when_resolved',
    deployment: 'hosted',
    fails: ['available-actions-hidden-from-others'],
  },
  {
    // Rev 15: the single read lists the available actions to an approver whose token lacks the resolve scope.
    flip: 'available_actions_shown_without_resolve_scope',
    deployment: 'hosted',
    fails: ['available-actions-hidden-without-resolve-scope'],
  },
  {
    // Rev 15: the single read lists the available actions to a member who is not eligible to approve it.
    flip: 'available_actions_shown_to_members',
    deployment: 'hosted',
    fails: ['available-actions-hidden-from-others'],
  },
  {
    // Rev 16: a decision ignores the rules and answers the policy's mode.
    flip: 'rules_ignored',
    deployment: 'hosted',
    fails: ['rev16-rules-decide-by-the-facts-of-the-call'],
  },
  {
    // Rev 16: a rule that cannot be evaluated is skipped, as if false, instead of making the policy ask.
    flip: 'missing_fact_falls_to_mode',
    deployment: 'hosted',
    fails: ['rev16-rules-decide-by-the-facts-of-the-call'],
  },
  {
    // Rev 16: the first approve approves the whole approval, with a requirement still unmet.
    flip: 'partial_approve_resolves',
    deployment: 'hosted',
    fails: ['rev16-requirements-met-one-by-one'],
  },
  {
    // Rev 16: `exclude: [requester]` is ignored, so the requester meets the requirement from the approver surface.
    flip: 'exclude_requester_ignored',
    deployment: 'hosted',
    fails: ['rev16-exclude-requester-refuses-the-requester'],
  },
  {
    // Rev 16: an administrator meets every requirement by break-glass with the organisation's setting off.
    flip: 'break_glass_ignores_setting',
    deployment: 'hosted',
    fails: ['rev16-break-glass-follows-the-organisation-setting'],
  },
];

export interface FlipResult {
  readonly flip: Break;
  readonly deployment: 'hosted' | 'edge';
  /** Expected scenario ids that did NOT fail: the flip went undetected. */
  readonly undetected: readonly string[];
  readonly failed: readonly string[];
}

export interface MatrixReport {
  readonly baseline: readonly Report[];
  readonly flips: readonly FlipResult[];
  /** Negative scenarios no row names. */
  readonly uncovered: readonly string[];
  readonly ok: boolean;
}

/** The ids of every scenario of `scenarios` tagged `negative`, and the generated negatives. */
export function negativeScenarioIds(scenarios: readonly Scenario[] = loadScenarios()): string[] {
  return [
    ...scenarios.filter((s) => s.tags.includes('negative')).map((s) => s.id),
    'header-identity-without-token-401-every-route',
    'header-identity-with-valid-token-401-every-route',
    'head-without-token-refused-every-route',
    'hosted-routes-404-on-edge',
  ];
}

/** How many flips run at once: `NC_MATRIX_CONCURRENCY`, else the smaller of four and the cores. */
export function matrixConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const asked = Number(env.NC_MATRIX_CONCURRENCY);
  if (Number.isInteger(asked) && asked >= 1) return asked;
  return Math.min(4, availableParallelism());
}

export interface MatrixOptions {
  /** Flips in flight at once. Defaults to `matrixConcurrency()`. */
  readonly concurrency?: number;
  /** The document, the scenarios and the mock options of every run (see `MockRun`); defaults as there. */
  readonly spec?: MockRun['spec'];
  readonly scenarios?: MockRun['scenarios'];
  readonly mock?: MockRun['mock'];
  /**
   * The negative scenario ids the rows must name between them; one no row names makes the report not `ok`.
   * Defaults to `negativeScenarioIds` of `scenarios`.
   */
  readonly negatives?: readonly string[];
}

/**
 * Runs `work` over `items` with at most `limit` in flight; results keep the order of `items`. The first
 * rejection stops new items from starting and is thrown once the ones in flight have settled.
 */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const lane = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const i = next++;
      try {
        out[i] = await work(items[i] as T);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failure !== undefined) throw failure.error;
  return out;
}

/**
 * Runs the baseline in both deployments (the whole suite, once each), then every flip against only the
 * scenarios its row names, a few flips at a time. A named id that is no scenario rejects the run.
 */
export async function runMatrix(
  rows: readonly Flip[] = MATRIX,
  options: MatrixOptions = {}
): Promise<MatrixReport> {
  const shared: Pick<MockRun, 'spec' | 'scenarios' | 'mock'> = {
    ...(options.spec === undefined ? {} : { spec: options.spec }),
    ...(options.scenarios === undefined ? {} : { scenarios: options.scenarios }),
    ...(options.mock === undefined ? {} : { mock: options.mock }),
  };
  const baseline = [
    await runAgainstMock({ deployment: 'hosted', ...shared }),
    await runAgainstMock({ deployment: 'edge', ...shared }),
  ];
  const flips = await mapPool(rows, options.concurrency ?? matrixConcurrency(), async (row) => {
    const report = await runAgainstMock({
      deployment: row.deployment,
      ...shared,
      breaks: [row.flip],
      only: row.fails,
      ...(row.advertise === undefined ? {} : { advertise: row.advertise }),
      ...(row.limits === undefined ? {} : { limits: row.limits }),
      ...(row.restrictions === undefined ? {} : { restrictions: row.restrictions }),
    });
    const failed = report.results.filter((r) => r.outcome === 'failed').map((r) => r.id);
    return {
      flip: row.flip,
      deployment: row.deployment,
      failed,
      undetected: row.fails.filter((id) => !failed.includes(id)),
    } satisfies FlipResult;
  });
  const named = new Set(rows.flatMap((r) => r.fails));
  const negatives = options.negatives ?? negativeScenarioIds(options.scenarios ?? loadScenarios());
  const uncovered = negatives.filter((id) => !named.has(id));
  const ok =
    baseline.every((r) => r.failed === 0) &&
    flips.every((f) => f.undetected.length === 0) &&
    uncovered.length === 0;
  return { baseline, flips, uncovered, ok };
}

export function formatMatrix(report: MatrixReport): string {
  const lines = report.baseline.map(
    (r) =>
      `baseline ${r.deployment}: ${String(r.passed)} passed, ${String(r.failed)} failed, ${String(r.skipped)} skipped`
  );
  for (const f of report.flips) {
    lines.push(
      `${f.undetected.length === 0 ? 'ok  ' : 'MISS'} ${f.flip} (${f.deployment}) -> fails ${f.failed.join(', ')}${f.undetected.length === 0 ? '' : `; NOT detected: ${f.undetected.join(', ')}`}`
    );
  }
  if (report.uncovered.length > 0)
    lines.push(`negative scenarios with no flip: ${report.uncovered.join(', ')}`);
  const detected = report.flips.filter((f) => f.undetected.length === 0).length;
  lines.push(
    `broken-mock matrix: ${String(detected)}/${String(report.flips.length)} flips detected, ${String(report.uncovered.length)} negatives uncovered`
  );
  return lines.join('\n');
}
