/**
 * The limits the renderers cut to. The first block of each constant is a limit the platform documents
 * (Slack: docs.slack.dev, the pages for each block and element; Teams: learn.microsoft.com, "Format your bot
 * messages"). The second block is a budget this package chooses inside those limits.
 */

export const SLACK_LIMITS = {
  // Documented.
  maxBlocks: 50,
  sectionText: 3000,
  sectionField: 2000,
  sectionFields: 10,
  blockId: 255,
  headerText: 150,
  inputLabel: 2000,
  inputMaxLength: 3000,
  actionId: 255,
  buttonText: 75,
  buttonValue: 2000,
  buttonUrl: 3000,
  fallbackText: 4000,
  // Chosen.
  /** The most characters of the call, after escaping, inside its code block. More and the call is replaced by the link. */
  callChars: 2600,
  /** One fact shown as a field, cut here (the platform allows 2000). */
  factChars: 300,
  /** One history line. */
  historyLineChars: 300,
  /** The latest history entries shown. */
  historyEntries: 5,
  /** The distinct inputs rendered (a note is one). */
  inputs: 5,
  /**
   * The most resolve buttons. Slack documents at most 25 elements in an actions block (docs.slack.dev, "Actions
   * block"), and that block also holds the Open in Approvals button; the cap is well under it. The rest are
   * decided in Approvals through the link.
   */
  maxActions: 10,
  /** The serialized message is kept under this many UTF-8 bytes; over it the card falls back to the minimal one. */
  messageBytes: 40_000,
} as const;

export const TEAMS_LIMITS = {
  // Documented: a bot message is at most 100 KB, counted as UTF-16; the docs advise staying within 80 KB. The
  // serialized card is measured in UTF-16 bytes (two per code unit) against this.
  cardBytes: 80_000,
  // Chosen.
  /** The most characters of the call, after escaping. More and the call is replaced by the link. */
  callChars: 8000,
  /** The most lines of the call; each line is one text block. */
  callLines: 120,
  textBlockChars: 1000,
  factChars: 300,
  buttonTitle: 75,
  historyLineChars: 300,
  historyEntries: 5,
  inputs: 5,
  inputLabel: 300,
  /**
   * The most resolve actions. Teams shows at most six primary actions on a card and moves the rest to an overflow
   * menu (learn.microsoft.com, "Cards format"; "Cards reference", Maximum six), so five resolve actions leave
   * room for the Open in Approvals link on the card itself. The rest are decided in Approvals through the link.
   */
  maxActions: 5,
} as const;

/** The call is shown to this nesting depth (the outermost container is depth 1); deeper containers become a count. */
export const CALL_MAX_DEPTH = 8;
/** One string inside the call is cut here. */
export const CALL_MAX_STRING = 500;
/** The note input's length when the deployment gives none. */
export const NOTE_MAX_LENGTH = 1000;
/** The longest input name or action id the model keeps (Slack bounds `action_id` and `block_id` at 255). */
export const MAX_NAME_LENGTH = 200;
/** The most characters of one payload (the Slack button `value` bound). */
export const MAX_PAYLOAD_CHARS = SLACK_LIMITS.buttonValue;
/** The `action_id` of the "Open in Approvals" button. A card action may not use it, so a click on it maps to no action. */
export const OPEN_ACTION_ID = 'nc.open';
/**
 * Input names no action may use. The keys of the click payload: Teams merges the values of the card's inputs into
 * the action's `data`, so an input with one of these names would share a namespace with the payload and could
 * replace the approval id or digest the card was bound to.
 */
export const RESERVED_INPUT_NAMES: readonly string[] = [
  'v',
  'approval_id',
  'sent_message_id',
  'expected_action_digest',
];
