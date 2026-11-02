/**
 * Every word the permissions components render, with its English default. A host overrides any of them through the
 * `labels` prop. A value may hold `{name}` placeholders; the component fills them in. Not words, and so not here: the
 * values the service sends (tool references, ids, modes as sent, decisions, reasons, sources), which are shown as sent.
 *
 * No string names a kind of deployment: what a deployment offers is learned from its capabilities and its answers.
 */
export const PERMISSIONS_DEFAULT_LABELS = {
  // The matrix
  heading: 'Permissions',
  loading: 'Loading policies…',
  unavailableTitle: 'Policies are not offered here',
  unavailableText: 'This service does not serve policies, so there is nothing to show or edit.',
  retry: 'Try again',
  readOnlyNotOffered: 'Policies can be read here but not authored.',
  readOnlyHost: 'Policies are shown read-only.',
  readOnlyForbidden: 'Only an administrator of the organisation authors policies. Editing is off.',
  staleLists:
    'The policies could not be read again after your change; the table may be out of date.',
  matrixCaption: 'Tool policies by role. A cell shows the published policy that governs the pair.',
  toolColumn: 'Tool',
  organisationColumn: 'Organisation',
  registeredTools: 'Registered tools',
  connectionId: 'Connection {id}',
  noTools: 'No tools are registered.',
  cellNoPolicy: 'No policy',
  cellDefault: "the deployment's default applies",
  cellVersion: 'v{version}',
  cellUpdatedBy: 'by {kind} {id}',
  cellConflict: 'Conflict: {names}',
  cellPending: 'Draft pending v{version}',
  cellModeUnknown: 'Unknown mode "{mode}"',
  cellModeAbsent: 'No mode stated',
  cellControl: '{mode} for {subject} on {tool}',
  cellSet: 'Set…',
  cellRetire: 'No policy (retire it)…',
  cellEditPolicy: 'Edit {name}',
  cellPolicyName: '{subject} · {tool}',
  cellOpenedEditor: '{name} governs more than this cell; it is open in the editor.',
  cellOpenedDraft:
    '{name} has a newer draft than this table shows; it is open in the editor so you see it before changing it.',
  cellErrorContext: 'While setting {subject} on {tool}.',
  draftErrorContext: 'While publishing {name}.',
  cellOpenPolicy: 'Open {name}',
  cellOpensPolicy: '{control}: {action}',
  modeOption: '{mode} ({wire})',
  loadFailed: 'The policies could not be read.',
  cellWritten: 'Draft v{version} written for {subject} on {tool}.',
  highlighted: 'Governed by the open policy',
  toolWithdrawn: 'Withdrawn',
  toolWithdrawnNote:
    'This tool is withdrawn: calls to it are denied. Its policies stay; open a policy to edit it.',
  toolStatusUnknown: 'Status "{status}"',
  toolStatusUnknownNote:
    'This service reports a status this page does not know, so the tool is treated as not callable. Open a policy to edit it.',
  sourceSuggested: 'suggested',
  sourceImported: 'imported',

  // Other panels
  otherSubjectsHeading: 'Policies for users, agents and groups',
  otherSubjectsEmpty: 'None.',
  subjectLabelled: '{label} ({subject})',
  otherSubjectRow: '{type} {id}',
  unplacedHeading: 'Policies this table cannot place',
  unplacedTargets: '{name}: the service did not say which tools it governs.',
  unplacedState: '{name}: the service did not say whether it is published.',
  unplacedNotListed: '{name} · {mode}: governs tools the tool list does not show: {tools}.',
  draftsHeading: 'Drafts',
  draftsEmpty: 'No drafts.',
  draftLabel: '{name} · v{version} · draft',
  draftSimulate: 'Simulate {name}',
  draftPublish: 'Publish {name}',
  draftOpen: 'Open {name}',
  otherPoliciesHeading: 'Other policies',
  otherPoliciesEmpty: 'None.',
  otherPoliciesError: 'Other policies could not be read.',
  duplicateDeny: 'After a rejection, an identical call is denied',
  duplicateAskAgain: 'After a rejection, an identical call is asked again',
  duplicateWindow: 'for {seconds} seconds',
  duplicateMaxReasks: 'at most {count} times',
  cannotEvaluate: 'A policy this module cannot evaluate (kind {kind}).',
  suggestedHeading: 'Suggested policies',
  suggestedEmpty: 'No suggestions.',
  suggestedError: 'Suggested policies could not be read.',
  directoryError:
    'The roles directory could not be read; only the roles given here and those policies name are shown.',
  connectionsError: 'Connection names could not be read; connections are shown by id.',
  policyFallbackName: 'Policy {id}',
  closePolicy: 'Close',

  // Modes: name, wire decision, sentence
  mode_always_allow: 'Always allow',
  mode_ask: 'Ask',
  mode_escalate: 'Escalate',
  mode_deny: 'Deny',
  mode_not_granted: 'Not granted',
  modeSentence_always_allow: 'Runs without asking.',
  modeSentence_ask:
    'The call waits for an approval. An eligible approver resolves it: never the principal that made the call, and never a service principal. This holds on every invocation channel. If the approval cannot be routed, the call is denied with reason approval_unroutable.',
  modeSentence_escalate:
    'The call waits for an approval, as with Ask; the service marks it as escalated (routing escalated).',
  modeSentence_deny: 'Never.',
  modeSentence_not_granted: 'No grant is held here; the call is denied with reason not_granted.',
  modeProvisional: 'Provisional in the contract.',
  modeMayBeRefused: 'A service that does not enforce this mode refuses it, and says why.',
  legendHeading: 'Modes',
  legendMode: 'Mode',
  legendWire: 'On the wire',
  legendMeaning: 'Meaning',
  wireDecision: '{decision}',
  wireRouting: '{decision}, routing {routing}',
  wireReason: '{decision}, reason {reason}',

  // The editor
  editorHeading: 'Policy: {name}',
  editorLoading: 'Loading the policy…',
  editorNotFound: 'This policy was not found, or it is not visible to you.',
  editorVersions: 'Versions',
  versionDraft: 'v{version} · draft',
  versionPublished: 'v{version} · published {date}',
  versionBy: 'written by {kind} {id}',
  fieldName: 'Name',
  fieldDescription: 'Description',
  fieldSubjects: 'Subjects',
  fieldSubjectType: 'Subject type',
  fieldSubjectId: 'Subject id',
  subjectAdd: 'Add subject',
  subjectRemove: 'Remove {subject}',
  subjectOrganisation: 'The organisation',
  subjectType_role: 'Role',
  subjectType_organization: 'Organisation',
  subjectType_user: 'User',
  subjectType_agent: 'Agent',
  subjectType_service: 'Service',
  subjectType_group: 'Group',
  fieldTargets: 'Tools',
  targetsAll: 'Every tool',
  targetToolWithdrawn: '{tool} (withdrawn)',
  targetToolStatus: '{tool} (status "{status}")',
  unenforcedTarget: 'not enforced: {tool}',
  fieldMode: 'Mode',
  fieldOnDeny: 'When the approval is denied',
  onDenyResume: 'The run carries on without this action',
  onDenyHalt: 'The run stops',
  onDenyNotStated: 'Not stated',
  fieldApproverGroups: 'Approver groups (comma-separated ids)',
  approverGroupsSentence: 'Approver groups: {groups}',
  approverGroupsNone: 'No approver groups: any eligible approver.',
  fieldExpiresAfter: 'Expires after (ISO 8601 duration, e.g. PT1H)',
  noteConditionsCleared:
    'This mode takes no denial behaviour, approver groups or expiry, so they were removed.',
  noteTargetsNotStated:
    'The service did not say which tools this policy governs, so it cannot be edited here.',
  noRemove: 'This service does not offer retiring a policy or discarding a draft.',
  retire: 'Retire policy',
  retireTitle: 'Retire {name}?',
  retireText:
    "It leaves this table at once. Within the service's policy-cache interval it stops being enforced, and after that no new decision or approval names it. Its history is kept. Its pending draft, if any, is discarded with it. The tools it governed fall back to any other policy, or to the deployment's default.",
  retireConfirm: 'Retire',
  retireCancel: 'Keep it',
  retired: '{name} was retired. Its history is kept.',
  retireErrorContext: 'While retiring {name}.',
  discardDraft: 'Discard draft',
  discardDraftNamed: 'Discard the draft of {name}',
  discardTitle: 'Discard draft v{version} of {name}?',
  discardText: 'The draft is deleted. The published version stays in force, unchanged.',
  discardNeverPublishedTitle: 'Delete {name}?',
  discardNeverPublishedText:
    'It was never published, so nothing enforces it. It is deleted, with its versions.',
  discardConfirm: 'Discard',
  discardCancel: 'Keep it',
  discarded: 'The draft of {name} was discarded.',
  discardedNeverPublished: '{name} was deleted.',
  discardErrorContext: 'While discarding the draft of {name}.',
  save: 'Save draft',
  saving: 'Saving…',
  publish: 'Publish',
  publishing: 'Publishing…',
  reload: 'Reload',
  stale: 'This draft changed since you opened it. Reload it before saving or publishing.',
  unsaved: 'Save the draft before publishing it.',
  published:
    "Published v{version}. Enforcement follows within the deployment's policy-cache interval.",
  conflictWith: 'Another published policy already governs one of these pairs:',
  conflictOpen: 'Open {name}',
  readOnlyEditor: 'Read-only.',

  // Simulation
  simHeading: 'Simulated as you',
  simExplain:
    'A dry run of this policy for your own identity: nothing is enforced or recorded. It cannot show what another person or role would get.',
  simTool: 'Tool',
  simAgent: 'Agent id (optional)',
  simRun: 'Run id (optional)',
  simArguments: 'Arguments (JSON object)',
  simArgumentsInvalid: 'The arguments must be a JSON object.',
  simSubmit: 'Simulate',
  simNoTools: 'There is no tool to simulate: the policy names none this service lists.',
  simRunning: 'Simulating…',
  simVersion: 'Simulated version: v{version}',
  simDecision: 'Decision: {decision}',
  simReason: 'Reason: {reason}',
  simDryRun: 'Dry run — nothing was enforced.',
  simWouldBe: 'Would be: {decision}',
  simRejected: 'Rejected approval: {id}',
  simPolicy: 'The decision names policy {name} v{version}.',
  simDefault: "The deployment's default decided.",
  simNotApplies:
    'This policy does not apply to you, so the result shows what you would get without it.',
  simConsideredHeading: 'Considered',
  simConsideredNone: 'The service did not say what it considered.',
  simColKind: 'Kind',
  simColPolicy: 'Policy',
  simColVersion: 'Version',
  simColSubject: 'Subject',
  simColResult: 'Result',
  simDefaultEntry: 'Deployment default ({source})',
  simComposed: 'Composed to: {decision}',
  simComposedReason: 'Composed to: {decision} ({reason})',

  // The effective view
  viewAuthored: 'Policies',
  viewEffective: 'Effective access',
  viewSwitch: 'Show',
  effectiveAdminsOnly:
    'Effective access is shown to administrators of the organisation only: it needs a dry run as another subject.',
  effectiveNoAnchor:
    "Nothing is published yet, so there is nothing to run a dry run against; every call gets the deployment's default.",
  effectiveBasis: 'Computed from',
  effectiveBasisPublished: 'The published policies',
  effectiveBasisDraft: 'The published policies, with {name} v{version} as if published',
  effectiveCaption:
    'What a holder of each role, or of the organisation alone, would get on each tool: a dry run per cell, nothing enforced. This service does not say how it combines policies, so each cell lists what matched, not which one decided.',
  effectiveCaptionComposed:
    'What a holder of each role, or of the organisation alone, would get on each tool, and which policies set it: a dry run per cell, nothing enforced. This service combines tool policies tightest-wins: deny over needing approval over allow.',
  effectiveLoading: '…',
  effectiveUnsupported: 'This service cannot run a dry run as this subject.',
  effectiveError: 'The dry run failed.',
  effectiveDecision: '{decision}',
  effectiveDecisionReason: '{decision} ({reason})',
  effectivePolicy: '{name} v{version}',
  effectiveSetBy: 'Set by: {entries}',
  effectiveSetByNone: 'The service did not say which entries set this.',
  effectiveMatched: 'Matched: {entries}',
  effectiveMatchedNone: 'Nothing matched.',

  // Import and export
  exportHeading: 'Export',
  exportFormat: 'Format',
  formatCedar: 'Cedar',
  formatAgt: 'AGT manifest (Cedar)',
  exportScope: 'Policies',
  exportScopeAll: 'Every published tool policy',
  exportVersion: 'Version',
  exportVersionPublished: 'Published',
  exportVersionDraft: 'Draft',
  exportAgtVersion: 'AGT release',
  agtVersion50: '5.0 (latest release)',
  agtVersionMain: 'main (unreleased)',
  exportPrepare: 'Prepare the export',
  exportPreparing: 'Preparing the export…',
  exportFailed: 'The export failed: {message}',
  exportDraftUnread: 'The draft could not be read.',
  exportNotListed: 'The policy is no longer listed.',
  exportToolNotCallable:
    'it names {tool}, which this service no longer lets anyone call; a target engine may still allow it',
  exportScopeDraft: '{name} (draft, never published)',
  exportTargetsNotStated:
    'the service did not say which tools this policy governs, so it cannot be written',
  exportAllScope: 'Every published tool policy is exported.',
  exportAgtScope:
    'An AGT manifest binds one policy set, so every published tool policy is exported, with every tool in its catalog.',
  exportUnpublished: '{count} never published are not.',
  exportReport: 'Export report',
  exportDownload: 'Download {filename}',
  reportGroup: '{heading} ({count})',
  reportNone: 'None.',
  reportNotes: 'Notes',
  reportNotExported: 'Not exported',
  reportExportLossy: 'Exported, not enforced as here',
  reportNotImported: 'Not imported',
  reportImportLossy: 'Imported in part',
  reportConflicts: 'Conflicts: not imported',
  importHeading: 'Import',
  importReadOnly: 'Policies cannot be authored here, so an import is shown, not saved.',
  importFile: 'A Cedar or AGT file',
  importPaste: 'Or paste a file',
  importRead: 'Read the file',
  importReading: 'Reading the file…',
  importFailed: 'The file could not be read: {message}',
  importUnknownFormat: 'This is neither Cedar nor an AGT manifest.',
  importReport: 'Import report',
  importSummary: '{format}: {count} policies read.',
  importNew: 'New',
  importMatches: 'Updates {name}',
  importComparedWith: 'Updates {name}, compared with v{version} ({state})',
  importStateDraft: 'draft',
  importStatePublished: 'published',
  importNoChange: 'No change.',
  importChanges: 'Changes to {name}',
  importRefusedForms: 'This service does not take: {members}. It cannot be saved here.',
  importSave: 'Save {name} as a draft',
  importSaveAll: 'Save every change as a draft',
  importSaved: 'Saved as draft v{version}.',
  importOpen: 'Open {name} to simulate and publish',

  // Errors
  errorUnauthorized: 'Your session has expired.',
  signInAgain: 'Sign in again',
  errorForbidden: 'Only an administrator of the organisation authors policies.',
  errorForbiddenRead: 'The service does not allow you to do this.',
  errorNotFound: 'Not found, or not visible to you.',
  errorInvalidRequest: 'The service refused the request.',
  errorInvalidRequestDetail: 'The service refused the request: {detail}',
  errorUnprocessable: 'The service cannot enforce this form: {detail}',
  errorUnprocessableNoDetail: 'The service cannot enforce this form.',
  errorConflict: 'The service reported a conflict.',
  errorRateLimited: 'Too many requests. Try again shortly.',
  errorUnavailable: 'The service could not answer. Try again.',
  errorNetwork: 'The service could not be reached.',
  errorUnsupported: 'This client cannot read everything the service sent.',
  errorMalformed: 'The service sent an answer this client cannot read.',
  error_read_only: 'Policies cannot be authored here.',
  error_publish_not_offered: 'Publishing is not offered here.',
  error_retire_not_offered: 'Retiring a policy and discarding a draft are not offered here.',
  error_draft_changed: 'This draft changed since it was shown. Reload it first.',
  error_no_pending_draft: 'There is no draft to publish.',
  error_unsaved_changes: 'Save the draft before publishing it.',
  error_pair_conflict: 'Two published policies govern this cell, so it cannot be edited here.',
  error_kind_not_editable: 'Only tool policies are edited here.',
  error_targets_not_stated: 'The service did not say which tools this policy governs.',
  error_runs_not_offered: 'A run cannot be named here.',
  error_not_loaded: 'The policies are not loaded yet.',
  error_write_in_flight: 'A change to this policy is already being sent.',
  error_tool_not_callable: 'This tool cannot be called, so its cells cannot be set here.',
  requestId: 'Request id: {requestId}',
} as const;

/** The key of every string the permissions components render. */
export type PermissionsLabelKey = keyof typeof PERMISSIONS_DEFAULT_LABELS;

/** What a host passes as `labels`: any of the components' strings, each replaced by its own text. */
export type PermissionsLabels = Partial<Readonly<Record<PermissionsLabelKey, string>>>;

export type PermissionsTranslate = (
  key: PermissionsLabelKey,
  values?: Readonly<Record<string, string | number>>
) => string;

/** The lookup the components use: the host's label when given, the default otherwise. */
export function createPermissionsTranslate(
  labels: PermissionsLabels | undefined
): PermissionsTranslate {
  return (key, values) => {
    const template: string = labels?.[key] ?? PERMISSIONS_DEFAULT_LABELS[key];
    if (values === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = values[name];
      return value === undefined ? whole : String(value);
    });
  };
}

/** The key of a mode's name or sentence, when the mode is one of the five. */
export function modeKey(
  prefix: 'mode_' | 'modeSentence_',
  mode: string
): PermissionsLabelKey | undefined {
  const key = `${prefix}${mode}`;
  return Object.hasOwn(PERMISSIONS_DEFAULT_LABELS, key) ? (key as PermissionsLabelKey) : undefined;
}
