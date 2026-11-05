import { OPEN_ACTION_ID, SLACK_LIMITS } from './limits.js';
import type { ApprovalCard } from './model.js';
import { payloadFor } from './payload.js';
import { formatCall, renderText, utf8Length } from './sanitize.js';
import { CARD_TEXT } from './text.js';
import type { CardDegradation } from './model.js';
import {
  actionDegradations,
  collectDegradations,
  distinctInputs,
  factRows,
  historyLines,
  requirementsLine,
  resolveActions,
  safeUrl,
  whyText,
} from './view.js';

/**
 * A Slack block, as the structure Slack documents: the members this package writes, and no Slack SDK. A
 * block is only ever built here, never read back.
 */
export interface SlackBlock {
  readonly type: 'header' | 'section' | 'context' | 'input' | 'actions';
  readonly block_id?: string;
  readonly [member: string]: unknown;
}

/** What a renderer needs besides the card. */
export interface RenderOptions {
  /**
   * The id of the sent-message row the click payload points at (a UUID). Without it, or with an id that is no
   * UUID, a card shows no buttons that resolve and no inputs, only the link to Approvals: a click that
   * carries no reference to the sent message could not be handled.
   */
  readonly sentMessageId?: string;
}

const SLACK_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** `&`, `<` and `>` are Slack's control characters: every one of a server string is escaped, in every object. */
function slackChar(char: string): string {
  return SLACK_ESCAPES[char] ?? char;
}

/** In a code block a backtick would end it, so it is shown as the look-alike U+02CB. */
function codeChar(char: string): string {
  return char === '`' ? '\u02cb' : slackChar(char);
}

const MRKDWN_LOOKALIKES: Readonly<Record<string, string>> = {
  '*': '\u2217',
  _: '\uff3f',
  '~': '\u223c',
  '`': '\u02cb',
};

/** The notification text is mrkdwn, so besides the escapes its formatting characters become look-alikes. */
function fallbackChar(char: string): string {
  return MRKDWN_LOOKALIKES[char] ?? slackChar(char);
}

function plain(raw: string, limit: number): { type: 'plain_text'; text: string; emoji: false } {
  return { type: 'plain_text', text: renderText(raw, limit, slackChar), emoji: false };
}

function openButton(url: string): Record<string, unknown> {
  return {
    type: 'button',
    text: plain(CARD_TEXT.openInApprovals, SLACK_LIMITS.buttonText),
    action_id: OPEN_ACTION_ID,
    url,
  };
}

/** A card for a request that is closed: it has no inputs and no actions block, only a link on the call's section. */
function isFinal(card: ApprovalCard): boolean {
  return card.facts.call.kind === 'link' && card.facts.call.why === 'final';
}

function section(raw: string): SlackBlock {
  return { type: 'section', text: plain(raw, SLACK_LIMITS.sectionText) };
}

function codeSection(escapedBody: string): SlackBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: '```\n' + escapedBody + '\n```', verbatim: true },
  };
}

/**
 * Renders the card as a Slack message: `text` is the notification fallback and `blocks` the message.
 *
 * - Untrusted text is in `plain_text` objects. The one `mrkdwn` object is the call's code block, with `verbatim`
 *   on; `link_names` is never set. `&`, `<` and `>` are escaped in every string, and invisible and
 *   bidirectional-control characters are shown as escapes.
 * - Every field is cut to the documented limit, ending in "…". A call over its budget is replaced by the
 *   sentence that points to the Approvals link.
 * - A final card has no inputs and no resolve buttons.
 * - Every resolve button's `value` is the same payload, `encodeActionPayload`'s; its `action_id` is the
 *   `CardAction.id`.
 * - At most `SLACK_LIMITS.maxActions` resolve buttons. A message over `maxBlocks` blocks or over
 *   `SLACK_LIMITS.messageBytes` is replaced by the minimal card: header, headline, status and the link.
 * It never throws.
 */
export function toBlockKit(
  card: ApprovalCard,
  options: RenderOptions = {}
): { text: string; blocks: readonly SlackBlock[] } {
  return renderBlockKit(card, options).message;
}

/**
 * `toBlockKit` and a list of the ways the message is less than the read offered (see `CardDegradation`). An
 * empty list means every resolve action the card has is on the message, the call is shown whole where the read
 * carries it, and the Approvals link is there. It never throws.
 */
export function renderBlockKit(
  card: ApprovalCard,
  options: RenderOptions = {}
): {
  message: { text: string; blocks: readonly SlackBlock[] };
  degraded: readonly CardDegradation[];
} {
  // A card that is already the minimal one (see `CardDegradation`) has nothing else to build.
  const built = card.degraded.includes('minimal') ? undefined : buildFull(card, options);
  const fits =
    built !== undefined &&
    built.message.blocks.length <= SLACK_LIMITS.maxBlocks &&
    utf8Length(JSON.stringify(built.message)) <= SLACK_LIMITS.messageBytes;
  const actions = actionDegradations(
    card,
    options.sentMessageId,
    SLACK_LIMITS.maxActions,
    SLACK_LIMITS.inputs
  );
  const linked = safeUrl(card.links.open) !== undefined;
  return fits
    ? {
        message: built.message,
        degraded: collectDegradations({
          card,
          actions,
          call: built.degraded,
          linked,
          minimal: false,
        }),
      }
    : {
        message: buildMinimal(card),
        degraded: collectDegradations({ card, actions, call: [], linked, minimal: true }),
      };
}

/** Header, headline, status and the link; no facts, call, history, inputs or resolve buttons. */
function buildMinimal(card: ApprovalCard): { text: string; blocks: readonly SlackBlock[] } {
  const url = safeUrl(card.links.open);
  const headline = section(card.header.headline);
  const final = isFinal(card);
  const blocks: SlackBlock[] = [
    { type: 'header', text: plain(CARD_TEXT.title, SLACK_LIMITS.headerText) },
    url !== undefined && final ? { ...headline, accessory: openButton(url) } : headline,
    { type: 'context', elements: [plain(card.status.line, SLACK_LIMITS.sectionText)] },
  ];
  if (url !== undefined && !final) blocks.push({ type: 'actions', elements: [openButton(url)] });
  return { text: renderText(CARD_TEXT.title, SLACK_LIMITS.fallbackText, fallbackChar), blocks };
}

function buildFull(
  card: ApprovalCard,
  options: RenderOptions
): {
  message: { text: string; blocks: readonly SlackBlock[] };
  degraded: readonly CardDegradation[];
} {
  const url = safeUrl(card.links.open);
  const blocks: SlackBlock[] = [
    { type: 'header', text: plain(CARD_TEXT.title, SLACK_LIMITS.headerText) },
    section(card.header.headline),
  ];

  const rows = factRows(card).map((row) => {
    const label = `${row.label}: `;
    return plain(
      label + renderText(row.value, SLACK_LIMITS.factChars - label.length, (c) => c),
      SLACK_LIMITS.sectionField
    );
  });
  for (let start = 0; start < rows.length; start += SLACK_LIMITS.sectionFields) {
    blocks.push({ type: 'section', fields: rows.slice(start, start + SLACK_LIMITS.sectionFields) });
  }

  const call = callBlocks(card, url);
  blocks.push(...call.blocks);

  // Each line is escaped on its own and the lines are joined after, so the only line breaks are these joins.
  const history = historyLines(card, SLACK_LIMITS.historyEntries).map((line) =>
    renderText(line, SLACK_LIMITS.historyLineChars, slackChar)
  );
  if (history.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'plain_text', text: [CARD_TEXT.history, ...history].join('\n'), emoji: false },
    });
  }

  const requirements = requirementsLine(card);
  const statusElements = [
    ...(card.notice === 'already_handled'
      ? [plain(CARD_TEXT.alreadyHandled, SLACK_LIMITS.sectionText)]
      : []),
    ...(requirements === undefined ? [] : [plain(requirements, SLACK_LIMITS.sectionText)]),
    plain(card.status.line, SLACK_LIMITS.sectionText),
  ];
  blocks.push({ type: 'context', elements: statusElements });

  const payload =
    options.sentMessageId === undefined ? undefined : payloadFor(card, options.sentMessageId);
  const actions = payload === undefined ? [] : resolveActions(card, SLACK_LIMITS.maxActions);
  for (const row of distinctInputs(actions, SLACK_LIMITS.inputs)) {
    blocks.push({
      type: 'input',
      block_id: `nc.input.${row.input.name}`,
      optional: !row.required,
      label: plain(row.input.label, SLACK_LIMITS.inputLabel),
      element: {
        type: 'plain_text_input',
        action_id: row.input.name,
        multiline: true,
        max_length: Math.min(row.input.maxLength, SLACK_LIMITS.inputMaxLength),
      },
    });
  }
  const buttons: Record<string, unknown>[] = actions.map((action) => ({
    type: 'button',
    text: plain(action.label, SLACK_LIMITS.buttonText),
    action_id: action.id,
    style: action.style,
    value: JSON.stringify(payload),
  }));
  if (url !== undefined && !isFinal(card)) buttons.push(openButton(url));
  if (buttons.length > 0) blocks.push({ type: 'actions', elements: buttons });

  const text = renderText(
    `${CARD_TEXT.title}: ${card.header.toolRef}`,
    SLACK_LIMITS.fallbackText,
    fallbackChar
  );
  return { message: { text, blocks }, degraded: call.degraded };
}

function callBlocks(
  card: ApprovalCard,
  url: string | undefined
): { blocks: SlackBlock[]; degraded: CardDegradation[] } {
  const call = card.facts.call;
  if (call.kind === 'link') {
    const sentence =
      url === undefined ? whyText(call.why) : `${whyText(call.why)} ${CARD_TEXT.viewFullCall}`;
    const block = section(sentence);
    // A closed request has no actions block, so its link rides on the section as the accessory.
    return {
      blocks: [
        url !== undefined && isFinal(card) ? { ...block, accessory: openButton(url) } : block,
      ],
      degraded: [],
    };
  }
  const printed = formatCall(call.arguments);
  // The printed call has structural line breaks; each line is escaped on its own, so a break inside a value
  // (which the printer has already written as an escape) cannot become one.
  if (printed.unreadable) {
    return { blocks: [section(CARD_TEXT.callUnreadable)], degraded: ['call_unreadable'] };
  }
  const body = printed.tooLarge
    ? undefined
    : printed.text
        .split('\n')
        .map((line) => renderText(line, Infinity, codeChar))
        .join('\n');
  if (body === undefined || body.length > SLACK_LIMITS.callChars) {
    return { blocks: [section(CARD_TEXT.viewFullCall)], degraded: ['call_too_large'] };
  }
  return {
    blocks: [codeSection(body), ...(printed.shortened ? [shortenedNote()] : [])],
    degraded: printed.shortened ? ['call_shortened'] : [],
  };
}

function shortenedNote(): SlackBlock {
  return { type: 'context', elements: [plain(CARD_TEXT.callShortened, SLACK_LIMITS.sectionText)] };
}
