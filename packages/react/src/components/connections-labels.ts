/**
 * Every word the connections components render, with its English default. A host overrides any of them through the
 * `labels` prop. A value may hold `{name}` placeholders; the component fills them in. Not words, and so not here: the
 * values the service sends (names, URLs, ids, tool references, side-effect levels, codes), which are shown as sent.
 *
 * No string names a kind of deployment: what a deployment offers is learned from its capabilities and its answers.
 */
export const CONNECTIONS_DEFAULT_LABELS = {
  // The list
  heading: 'Connections',
  loading: 'Loading connections…',
  unavailableTitle: 'Connections are not available here',
  unavailableText: 'This service does not serve connections to tool servers.',
  retry: 'Try again',
  loadFailed: 'The connections could not be read.',
  staleList: 'The list could not be read again after your change; it may be out of date.',
  empty: 'No tool servers are registered.',
  listCaption: 'Registered tool servers',
  colName: 'Name',
  colServer: 'Server',
  colState: 'State',
  colOwner: 'Owner',
  colMyCredential: 'My credential',
  colActions: 'Actions',
  reconnect: 'Reconnect',
  reconnectNamed: 'Reconnect {name}',
  ownerOrganisation: 'Organisation',
  ownerPrincipal: 'Principal {id}',
  transport: '{transport}',
  state_connected: 'Connected',
  state_pending_authorization: 'Waiting for authorization',
  state_degraded: 'Degraded',
  stateUnknown: 'State "{state}"',
  stateNotStated: 'State not stated',
  stateDetail: '({detail})',
  lastVerified: 'Last checked {date}',
  neverVerified: 'Never checked',
  tier_org_shared: 'Organisation credential',
  tier_per_user: 'Each user links their own',
  tierUnknown: 'Credential tier "{tier}"',
  auth_none: 'No authentication',
  auth_bearer: 'Bearer token',
  auth_oauth: 'OAuth',
  authUnknown: 'Authentication "{kind}"',
  open: 'Open {name}',
  close: 'Close',
  readOnlyHost: "The organisation's registrations are shown read-only.",
  readOnlyForbidden:
    "Only an administrator of the organisation changes the organisation's registrations.",
  readOnlyRegister: 'Only an administrator registers servers here.',

  // The return from an authorization
  returnConnected: 'Authorization of {name} completed.',
  returnError: 'Authorization of {name} did not complete: {reason}',
  returnError_consent_denied: 'consent was not given.',
  returnError_expired: 'the authorization expired.',
  returnError_exchange_failed: 'the authorization server did not issue a credential.',
  returnError_upstream_error: 'the authorization server reported an error.',
  returnErrorGeneric: 'Authorization of {name} did not complete.',
  returnDismiss: 'Dismiss',

  // The host's catalog of servers
  catalogHeading: 'Catalog',
  catalogConnect: 'Connect',
  catalogConnectNamed: 'Connect {name}',
  catalogRegistered: 'Registered',
  presetAuthNotOffered:
    'This server signs in with {auth}, which is not offered here. Choose how it authenticates before registering it.',

  // Registering a server
  addHeading: 'Register a tool server',
  addOpen: 'Register a server',
  addCancel: 'Cancel',
  fieldName: 'Name',
  fieldUrl: 'Server URL',
  fieldUrlHint:
    'The URL identifies the server and its tools: it cannot be changed later. It carries no credential.',
  fieldTransport: 'Transport',
  fieldOwner: 'Owner',
  ownerOptionOrg: 'The organisation',
  ownerOptionPrincipal: 'Me',
  fieldAuth: 'How the server authenticates callers',
  fieldScopes: 'OAuth scopes (space-separated, optional)',
  fieldIssuer: 'Authorization server (optional)',
  fieldClientId: 'Client id at the authorization server (optional)',
  fieldTier: 'Whose credential calls use',
  tierDefault: "The service's default",
  fieldOrgCredential: 'Organisation credential (bearer token)',
  fieldOrgCredentialHint: 'Write-only: it is sent once and never shown again.',
  submitAdd: 'Register',
  submitting: 'Registering…',
  urlInvalid: 'Enter an absolute https:// URL (http:// only to this machine).',
  urlHasCredential: 'Leave credentials out of the URL.',
  nameRequired: 'Enter a name.',
  orgCredentialRequired: 'An organisation credential is needed for a bearer server.',
  registered: '{name} is registered.',
  registeredPending: '{name} is registered. It waits for an administrator to authorize it.',
  existsOpen: 'Open the existing registration',
  exists: 'The organisation already has a registration of this server.',

  // A registration
  detailHeading: '{name}',
  detailServer: 'Server: {url}',
  detailTransport: 'Transport: {transport}',
  detailAuth: 'Authentication: {auth}',
  detailTier: 'Credential: {tier}',
  detailOwner: 'Owner: {owner}',
  registeredAt: 'Registered',
  rename: 'Rename',
  renameField: 'New name',
  renameSave: 'Save name',
  renamed: 'Renamed to {name}.',
  refresh: 'Refresh tools',
  refreshing: 'Refreshing…',
  refreshed:
    'The server offers {count} tools: {added} added, {removed} withdrawn, {reactivated} active again.',
  refreshSuppressed:
    'The server offered no tools at all, so the registered tools were kept rather than withdrawn. Check the server before refreshing again.',
  remove: 'Delete registration',
  removeTitle: 'Delete {name}?',
  removeText:
    "Its tools become withdrawn and their policies stay. Every user's link to it is removed. Registering the same server URL again makes the tools active again.",
  removeConfirm: 'Delete',
  removeCancel: 'Keep it',
  removed: '{name} was deleted. Its tools are withdrawn.',
  authorizeOrg: 'Authorize the organisation credential',
  reauthorizeOrg: 'Authorize the organisation credential again',
  authorizing: 'Opening the authorization…',
  rotate: 'Replace the organisation credential',
  rotateField: 'New organisation credential (bearer token)',
  rotateSave: 'Replace',
  rotated: 'The organisation credential of {name} was replaced.',

  // My credential
  myHeading: 'My credential',
  myNotTaken:
    'Calls through this server use the organisation credential; there is nothing to link.',
  myNone: 'You have not linked a credential.',
  myLinked: 'Your credential is linked{since}.',
  myLinkedSince: ' since {date}',
  myPending: 'Your link waits for you to authorize it.',
  myDegraded: 'Your link stopped working. Link it again.',
  myStateUnknown: 'Your link is in state "{state}".',
  myConsentRevoked: 'You revoked your consent: your link is not used.',
  myConsentUnknown: 'Your consent is in state "{consent}": your link is not used.',
  myOthers:
    'This is your credential only. Your colleagues link their own; the tools stay available to them.',
  link: 'Link my account',
  linkAgain: 'Link again',
  linkToken: 'My bearer token',
  linkTokenHint: 'Write-only: it is sent once and never shown again.',
  linkTokenReplace: 'Replace my token',
  consentHeading: 'Your consent',
  consentText:
    "The organisation's gateway will use this credential for your own calls through {name}, and for nobody else's. You can revoke this at any time.",
  consentCheck: 'I consent to this use of my credential',
  consentContinue: 'Link with my consent',
  consentContinueOauth: 'Consent and continue to authorize',
  consentCancel: 'Cancel',
  consentGiveAgain: 'Give consent again',
  authorizeMine: 'Authorize my link',
  reauthorizeMine: 'Authorize my link again',
  unlink: 'Unlink',
  unlinkTitle: 'Unlink your credential from {name}?',
  unlinkText:
    'Your credential is removed. The tools stay available to everyone who has linked their own; your calls through this server fail until you link again.',
  unlinkConfirm: 'Unlink',
  unlinkCancel: 'Keep it',
  unlinked: 'Your credential was removed from {name}. The tools stay available to others.',
  revokeConsent: 'Revoke my consent',
  revokeTitle: 'Revoke your consent for {name}?',
  revokeText:
    'Your credential is kept but no longer used. The tools stay available to others. You can give consent again later.',
  revokeConfirm: 'Revoke',
  revokeCancel: 'Keep it',
  revoked: 'Your consent for {name} is revoked. The tools stay available to others.',
  linked: 'Your credential is linked to {name}.',

  // Tools
  toolsHeading: 'Tools',
  toolsLoading: 'Loading tools…',
  toolsFailed: 'The tools could not be read.',
  toolsEmpty: 'No tools are registered from this server. Refresh to register what it offers.',
  toolsCaption: 'Tools of {name}',
  colTool: 'Tool',
  colDescription: 'Description',
  colLevel: 'Side effect',
  colStanding: 'Standing',
  standing_registered: 'Registered',
  standing_offered: 'Offered, not registered',
  standing_withdrawn: 'Registered, no longer offered',
  standing_unknown_status: 'Registered, status "{status}": not callable',
  discover: 'Check what the server offers',
  discovering: 'Asking the server…',
  discoverFailed: 'The server could not be asked what it offers.',
  discoverNote: 'A check registers nothing. Refresh registers what the server offers.',

  // Errors
  errorUnauthorized: 'Your session has expired.',
  signInAgain: 'Sign in again',
  errorForbidden: 'Only an administrator of the organisation does this.',
  errorForbiddenRead: 'The service does not allow you to do this.',
  errorNotFound: 'Not found, or not visible to you.',
  errorInvalidRequest: 'The service refused the request.',
  errorInvalidRequestDetail: 'The service refused the request: {detail}',
  errorConflict: 'The service reported a conflict.',
  errorRateLimited: 'Too many requests. Try again shortly.',
  errorUnavailable: 'The service could not answer. Try again.',
  errorNetwork: 'The service could not be reached.',
  errorUnsupported: 'This client cannot read everything the service sent.',
  errorMalformed: 'The service sent an answer this client cannot read.',
  error_read_only: 'Only an administrator of the organisation does this.',
  error_owner_kind_not_offered: 'This service does not register connections of this owner.',
  error_oauth_not_offered: 'Authorization is not offered here.',
  error_links_not_offered: 'Linking a credential is not offered here.',
  error_nothing_to_link: 'This registration takes no link.',
  error_consent_required: 'A credential is linked only with your consent.',
  error_not_loaded: 'The registration is not loaded.',
  error_write_in_flight: 'A change to this registration is already being sent.',
  error_cannot_navigate: 'This page cannot open the authorization.',
  requestId: 'Request id: {requestId}',
} as const;

/** The key of every string the connections components render. */
export type ConnectionsLabelKey = keyof typeof CONNECTIONS_DEFAULT_LABELS;

/** What a host passes as `labels`: any of the components' strings, each replaced by its own text. */
export type ConnectionsLabels = Partial<Readonly<Record<ConnectionsLabelKey, string>>>;

export type ConnectionsTranslate = (
  key: ConnectionsLabelKey,
  values?: Readonly<Record<string, string | number>>
) => string;

/** The lookup the components use: the host's label when given, the default otherwise. */
export function createConnectionsTranslate(
  labels: ConnectionsLabels | undefined
): ConnectionsTranslate {
  return (key, values) => {
    const template: string = labels?.[key] ?? CONNECTIONS_DEFAULT_LABELS[key];
    if (values === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = values[name];
      return value === undefined ? whole : String(value);
    });
  };
}

/** The key `prefix` + `value` when the module has words for it (a known state, tier, kind or code). */
export function knownKey(prefix: string, value: string): ConnectionsLabelKey | undefined {
  const key = `${prefix}${value}`;
  return Object.hasOwn(CONNECTIONS_DEFAULT_LABELS, key) ? (key as ConnectionsLabelKey) : undefined;
}
