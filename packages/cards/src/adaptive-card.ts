import { TEAMS_LIMITS } from './limits.js';
import type { ApprovalCard } from './model.js';
import { payloadFor } from './payload.js';
import type { ActionPayload } from './payload.js';
import { formatCall, renderText, utf16Length } from './sanitize.js';
import { CARD_TEXT } from './text.js';
import type { RenderOptions } from './block-kit.js';
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

/** An Adaptive Card, as the JSON Teams takes. Only the members this package writes are named. */
export interface AdaptiveCardJson {
  readonly type: 'AdaptiveCard';
  readonly $schema: string;
  readonly version: '1.5';
  readonly body: readonly AdaptiveElement[];
  readonly actions?: readonly AdaptiveAction[];
}

export interface AdaptiveElement {
  readonly type: string;
  readonly [member: string]: unknown;
}

export interface AdaptiveAction {
  readonly type: 'Action.Execute' | 'Action.OpenUrl';
  readonly title: string;
  readonly [member: string]: unknown;
}

/** Characters that start markdown in a Teams text block, and the angle brackets of `<at>`; each gets a backslash. */
const MARKDOWN = new Set([
  '\\',
  '`',
  '*',
  '_',
  '~',
  '[',
  ']',
  '(',
  ')',
  '<',
  '>',
  '#',
  '|',
  '&',
  '!',
]);

function markdownChar(char: string): string {
  return MARKDOWN.has(char) ? `\\${char}` : char;
}

const PLAIN_LOOKALIKES: Readonly<Record<string, string>> = {
  '<': '\u2039',
  '>': '\u203a',
  '[': '\uff3b',
  ']': '\uff3d',
};

/** For text that is not markdown (an action title, an input label): angle and square brackets become look-alikes, so no link or `<at>` can form. */
function plainChar(char: string): string {
  return PLAIN_LOOKALIKES[char] ?? char;
}

/** Text for a text block or fact: markdown and `<at>` neutralised, invisible characters shown as escapes, cut. */
function md(raw: string, limit: number = TEAMS_LIMITS.textBlockChars): string {
  return renderText(raw, limit, markdownChar);
}

function plainText(raw: string, limit: number): string {
  return renderText(raw, limit, plainChar);
}

/** A card for a request that is closed: it has no `actions` member, only a link that selecting the call's text follows. */
function isFinal(card: ApprovalCard): boolean {
  return card.facts.call.kind === 'link' && card.facts.call.why === 'final';
}

function block(text: string, extra: Record<string, unknown> = {}): AdaptiveElement {
  return { type: 'TextBlock', text, wrap: true, ...extra };
}

/**
 * Renders the card as an Adaptive Card 1.5 for Teams.
 *
 * - Text is escaped so that no markdown and no `<at>` is live, and invisible and bidirectional-control
 *   characters are shown as escapes. The call is a run of monospace text blocks, one per line, in a
 *   container. The card has no `msteams` member: no mention entity and nothing that mentions anyone.
 * - Inputs are `Input.Text`. The actions are `Action.Execute` with `verb` set to the `CardAction.id` and `data`
 *   set to the payload object, and `Action.OpenUrl` for Approvals.
 * - The call is replaced by the sentence that points to the Approvals link when it is over its budget. Every
 *   field is cut to a limit, but the cuts do not bound the card: the click payload on each action, doubled escapes and
 *   long names can still take it past `TEAMS_LIMITS.cardBytes`, and then the minimal card below is sent.
 * - A final card has no inputs and no `Action.Execute`.
 * - At most `TEAMS_LIMITS.maxActions` `Action.Execute` actions. A card whose serialized size, counted in UTF-16 bytes as
 *   Teams counts a message, is over `TEAMS_LIMITS.cardBytes` is replaced by the minimal card: title, headline, status and the link.
 * It never throws.
 */
export function toAdaptiveCard(card: ApprovalCard, options: RenderOptions = {}): AdaptiveCardJson {
  return renderAdaptiveCard(card, options).card;
}

/**
 * `toAdaptiveCard` and a list of the ways the card is less than the read offered (see `CardDegradation`). An
 * empty list means every resolve action the card has is on it, the call is shown whole where the read carries
 * it, and the Approvals link is there. It never throws.
 */
export function renderAdaptiveCard(
  card: ApprovalCard,
  options: RenderOptions = {}
): { card: AdaptiveCardJson; degraded: readonly CardDegradation[] } {
  // A card that is already the minimal one (see `CardDegradation`) has nothing else to build.
  const built = card.degraded.includes('minimal') ? undefined : build(card, options);
  const actions = actionDegradations(
    card,
    options.sentMessageId,
    TEAMS_LIMITS.maxActions,
    TEAMS_LIMITS.inputs
  );
  const linked = safeUrl(card.links.open) !== undefined;
  return built !== undefined && utf16Length(JSON.stringify(built.card)) <= TEAMS_LIMITS.cardBytes
    ? {
        card: built.card,
        degraded: collectDegradations({
          card,
          actions,
          call: built.degraded,
          linked,
          minimal: false,
        }),
      }
    : {
        card: buildMinimal(card),
        degraded: collectDegradations({ card, actions, call: [], linked, minimal: true }),
      };
}

/** Title, headline, status and the link; no facts, call, history, inputs or resolve actions. */
function buildMinimal(card: ApprovalCard): AdaptiveCardJson {
  const url = safeUrl(card.links.open);
  const final = isFinal(card);
  const headline = block(md(card.header.headline));
  const open: AdaptiveAction | undefined =
    url === undefined
      ? undefined
      : {
          type: 'Action.OpenUrl',
          title: plainText(CARD_TEXT.openInApprovals, TEAMS_LIMITS.buttonTitle),
          url,
        };
  const body: AdaptiveElement[] = [
    block(md(CARD_TEXT.title), { weight: 'Bolder', size: 'Medium' }),
    open !== undefined && final
      ? { type: 'Container', items: [headline], selectAction: open }
      : headline,
    block(md(card.status.line), { isSubtle: true }),
  ];
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body,
    ...(open !== undefined && !final ? { actions: [open] } : {}),
  };
}

function build(
  card: ApprovalCard,
  options: RenderOptions
): { card: AdaptiveCardJson; degraded: readonly CardDegradation[] } {
  const url = safeUrl(card.links.open);
  const body: AdaptiveElement[] = [
    block(md(CARD_TEXT.title), { weight: 'Bolder', size: 'Medium' }),
    block(md(card.header.headline)),
  ];

  body.push({
    type: 'FactSet',
    facts: factRows(card).map((row) => ({
      title: md(row.label, TEAMS_LIMITS.factChars),
      value: md(row.value, TEAMS_LIMITS.factChars),
    })),
  });

  const call = callElements(card, url);
  body.push(...call.elements);

  const history = historyLines(card, TEAMS_LIMITS.historyEntries);
  if (history.length > 0) {
    body.push(block(md(CARD_TEXT.history), { weight: 'Bolder' }));
    for (const line of history) body.push(block(md(line, TEAMS_LIMITS.historyLineChars)));
  }

  if (card.notice === 'already_handled') body.push(block(md(CARD_TEXT.alreadyHandled)));
  const requirements = requirementsLine(card);
  if (requirements !== undefined) body.push(block(md(requirements), { isSubtle: true }));
  body.push(block(md(card.status.line), { isSubtle: true }));

  const payload =
    options.sentMessageId === undefined ? undefined : payloadFor(card, options.sentMessageId);
  const resolve = payload === undefined ? [] : resolveActions(card, TEAMS_LIMITS.maxActions);
  for (const row of distinctInputs(resolve, TEAMS_LIMITS.inputs)) {
    body.push({
      type: 'Input.Text',
      id: row.input.name,
      label: plainText(row.input.label, TEAMS_LIMITS.inputLabel),
      isRequired: row.required,
      isMultiline: true,
      maxLength: row.input.maxLength,
    });
  }

  const actions: AdaptiveAction[] = resolve.map((action) => ({
    type: 'Action.Execute',
    title: plainText(action.label, TEAMS_LIMITS.buttonTitle),
    verb: action.id,
    data: payload satisfies ActionPayload | undefined,
    associatedInputs: 'auto',
    style: action.style === 'primary' ? 'positive' : 'destructive',
  }));
  if (url !== undefined && !isFinal(card)) {
    actions.push({
      type: 'Action.OpenUrl',
      title: plainText(CARD_TEXT.openInApprovals, TEAMS_LIMITS.buttonTitle),
      url,
    });
  }

  return {
    card: {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.5',
      body,
      ...(actions.length === 0 ? {} : { actions }),
    },
    degraded: call.degraded,
  };
}

/** Leading spaces become no-break spaces, which a text block keeps. */
function keepIndent(line: string): string {
  const spaces = /^ */u.exec(line)?.[0].length ?? 0;
  return '\u00a0'.repeat(spaces) + line.slice(spaces);
}

function callElements(
  card: ApprovalCard,
  url: string | undefined
): { elements: AdaptiveElement[]; degraded: CardDegradation[] } {
  const call = card.facts.call;
  if (call.kind === 'link') {
    const sentence =
      url === undefined ? whyText(call.why) : `${whyText(call.why)} ${CARD_TEXT.viewFullCall}`;
    const element = block(md(sentence));
    if (url === undefined || !isFinal(card)) return { elements: [element], degraded: [] };
    return {
      elements: [
        {
          type: 'Container',
          items: [element],
          selectAction: {
            type: 'Action.OpenUrl',
            title: plainText(CARD_TEXT.openInApprovals, TEAMS_LIMITS.buttonTitle),
            url,
          },
        },
      ],
      degraded: [],
    };
  }
  const printed = formatCall(call.arguments);
  if (printed.unreadable) {
    return { elements: [block(md(CARD_TEXT.callUnreadable))], degraded: ['call_unreadable'] };
  }
  const lines = printed.tooLarge
    ? undefined
    : printed.text.split('\n').map((line) => keepIndent(md(line, TEAMS_LIMITS.callChars)));
  const size = lines?.reduce((total, line) => total + line.length, 0) ?? Infinity;
  if (
    lines === undefined ||
    lines.length > TEAMS_LIMITS.callLines ||
    size > TEAMS_LIMITS.callChars
  ) {
    return { elements: [block(md(CARD_TEXT.viewFullCall))], degraded: ['call_too_large'] };
  }
  return {
    elements: [
      {
        type: 'Container',
        style: 'emphasis',
        items: lines.map((line) => block(line, { fontType: 'Monospace', spacing: 'None' })),
      },
      ...(printed.shortened ? [block(md(CARD_TEXT.callShortened), { isSubtle: true })] : []),
    ],
    degraded: printed.shortened ? ['call_shortened'] : [],
  };
}
