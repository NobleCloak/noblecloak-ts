import { SLACK_LIMITS } from './limits.js';
import type {
  ApprovalCard,
  CardAction,
  CardDegradation,
  CardInput,
  CardPrincipal,
  CardResolveAction,
} from './model.js';
import { isResolveAction } from './model.js';
import { payloadFor } from './payload.js';
import { CARD_TEXT, fill } from './text.js';

/** What the renderers share: the facts as rows, the history as lines, the inputs and the link. All raw text; a renderer escapes it. */

export interface FactRow {
  readonly label: string;
  readonly value: string;
}

function agentText(agent: CardPrincipal): string {
  return agent.parent === undefined
    ? agent.text
    : `${agent.text} (${fill(CARD_TEXT.factAgentParent, { parent: agent.parent })})`;
}

/** The rows `Detail` shows as its facts, in its order. A member the read did not carry has no row. */
export function factRows(card: ApprovalCard): FactRow[] {
  const { details } = card;
  const rows: FactRow[] = [
    { label: CARD_TEXT.factTool, value: card.header.toolRef },
    { label: CARD_TEXT.factLevel, value: details.sideEffectLevel },
    { label: CARD_TEXT.factKind, value: details.obligationKind },
  ];
  if (details.requester !== undefined) {
    rows.push({ label: CARD_TEXT.factRequester, value: details.requester.text });
  }
  if (details.waitingOn !== undefined) {
    const names = details.waitingOn.principals?.map((principal) => principal.text).join(', ');
    rows.push({
      label: CARD_TEXT.factWaitingOn,
      value:
        names === undefined
          ? String(details.waitingOn.count)
          : `${String(details.waitingOn.count)}: ${names}`,
    });
  }
  if (details.agent !== undefined) {
    rows.push({ label: CARD_TEXT.factAgent, value: agentText(details.agent) });
  }
  if (details.run !== undefined) {
    rows.push({ label: CARD_TEXT.factRun, value: `${details.run.id} (${details.run.kind})` });
  }
  rows.push({ label: CARD_TEXT.factScope, value: details.scopeId });
  if (details.policy !== undefined) {
    const version = fill(CARD_TEXT.factPolicyVersion, { version: String(details.policy.version) });
    rows.push({ label: CARD_TEXT.factPolicy, value: `${details.policy.id} (${version})` });
  }
  if (details.continuationKind !== undefined) {
    rows.push({ label: CARD_TEXT.factContinuation, value: details.continuationKind });
  }
  rows.push({ label: CARD_TEXT.factCreated, value: details.createdAt });
  if (details.expiresAt !== undefined) {
    rows.push({ label: CARD_TEXT.factExpires, value: details.expiresAt });
  }
  rows.push({ label: CARD_TEXT.factDigest, value: details.actionDigest });
  return rows;
}

/** The latest history entries, oldest first, one line each. */
export function historyLines(card: ApprovalCard, entries: number): string[] {
  return card.details.history.slice(-entries).map((entry) => {
    const line = fill(CARD_TEXT.historyEntry, {
      resolution: entry.resolution,
      by: entry.by.text,
      at: entry.at,
    });
    return entry.reason === undefined
      ? line
      : line + fill(CARD_TEXT.historyReason, { reason: entry.reason });
  });
}

/** The resolve actions of a card, at most `max` of them (a surface's `maxActions`): the only kind a v1 renderer renders. */
export function resolveActions(card: ApprovalCard, max: number): CardResolveAction[] {
  const all: readonly CardAction[] = card.actions;
  return all
    .filter((action: CardAction): action is CardResolveAction => isResolveAction(action))
    .slice(0, max);
}

/** The degradations that come from the resolve actions and the payload, before any size check. A card with no resolve action has none. */
export function actionDegradations(
  card: ApprovalCard,
  sentMessageId: string | undefined,
  maxActions: number,
  maxInputs: number
): CardDegradation[] {
  const all: readonly CardAction[] = card.actions;
  const offered = all.filter((action) => isResolveAction(action)).length;
  if (offered === 0) return [];
  if (sentMessageId === undefined || payloadFor(card, sentMessageId) === undefined) {
    return ['no_payload'];
  }
  const out: CardDegradation[] = [];
  if (offered > maxActions) out.push('actions_capped');
  const names = new Set(
    resolveActions(card, maxActions).flatMap((action) => action.inputs.map((input) => input.name))
  );
  if (names.size > maxInputs) out.push('inputs_capped');
  return out;
}

export interface InputRow {
  readonly input: CardInput;
  /**
   * True only when every action passed to `distinctInputs` takes the input and requires it. An action that
   * does not take it would otherwise be blocked by it: Teams validates every input on the card for every
   * `Action.Execute`. The server still enforces what each action requires.
   */
  readonly required: boolean;
}

/**
 * The distinct inputs of some actions, in first-seen order. Two actions that both take `reason` share one
 * field, because a platform card has one field for the person to fill and the buttons read it. The first
 * action's label and length win.
 */
export function distinctInputs(actions: readonly CardAction[], max: number): InputRow[] {
  const rows = new Map<string, { input: CardInput; required: boolean; takers: number }>();
  for (const action of actions) {
    const names = new Set<string>();
    for (const input of action.inputs) {
      const seen = rows.get(input.name);
      if (seen === undefined) rows.set(input.name, { input, required: input.required, takers: 1 });
      else {
        seen.required = seen.required && input.required;
        if (!names.has(input.name)) seen.takers += 1;
      }
      names.add(input.name);
    }
  }
  return [...rows.values()].slice(0, max).map(({ input, required, takers }) => ({
    input,
    required: required && takers === actions.length,
  }));
}

/** An `http` or `https` link the platforms accept as a button URL, or `undefined`. */
export function safeUrl(url: string, max: number = SLACK_LIMITS.buttonUrl): string | undefined {
  // eslint-disable-next-line no-control-regex
  const bad = /[\s\u0000-\u001f\u007f<>"\\^`{|}]/u;
  return /^https?:\/\/[^/?#]/iu.test(url) && url.length <= max && !bad.test(url) ? url : undefined;
}

/** The reason a card shows no call, as its fixed sentence. */
export function whyText(why: 'blocked' | 'not_on_read' | 'unreadable' | 'final'): string {
  switch (why) {
    case 'unreadable':
      return CARD_TEXT.callUnreadable;
    case 'blocked':
      return CARD_TEXT.callBlocked;
    case 'not_on_read':
      return CARD_TEXT.callNotOnRead;
    case 'final':
      return CARD_TEXT.callFinal;
  }
}

/**
 * The degradations of one rendered message, in this order: the card's own, those from the resolve actions and the
 * payload, those from the call as rendered, `no_link` when `safeUrl` refuses the Approvals URL, and `minimal`
 * last when the message is the minimal one. Each appears once.
 */
export function collectDegradations(parts: {
  readonly card: ApprovalCard;
  readonly actions: readonly CardDegradation[];
  readonly call: readonly CardDegradation[];
  readonly linked: boolean;
  readonly minimal: boolean;
}): CardDegradation[] {
  const out = new Set<CardDegradation>(parts.card.degraded.filter((code) => code !== 'minimal'));
  for (const code of parts.actions) out.add(code);
  for (const code of parts.call) out.add(code);
  if (!parts.linked) out.add('no_link');
  if (parts.minimal) out.add('minimal');
  return [...out];
}
