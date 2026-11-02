import { MAX_PAYLOAD_CHARS, RESERVED_INPUT_NAMES } from './limits.js';
import { CHAT_RESOLUTIONS, DERIVED_ACTION_IDS, isResolveAction } from './model.js';
import type { ApprovalCard, CardAction, CardResolveAction } from './model.js';

/**
 * What a button or an Execute action carries: three references and the version of this shape. It is a
 * reference, never authority. The digest is not a secret. What lets a click resolve is the platform's
 * signature, the check of the clicker's identity at click time, and the approvals service's own eligibility
 * decision. Carrying the digest makes the click resolve the call that was shown.
 */
export interface ActionPayload {
  readonly v: 1;
  readonly approval_id: string;
  readonly sent_message_id: string;
  readonly expected_action_digest: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = ['v', 'approval_id', 'sent_message_id', 'expected_action_digest'] as const;

/** The payload for a card, or `undefined` when it cannot be a valid one (an id that is no UUID, no digest, too long). */
export function payloadFor(card: ApprovalCard, sentMessageId: string): ActionPayload | undefined {
  const payload: ActionPayload = {
    v: 1,
    approval_id: card.approvalId,
    sent_message_id: sentMessageId,
    expected_action_digest: card.details.actionDigest,
  };
  if (!UUID.test(payload.approval_id) || !UUID.test(payload.sent_message_id)) return undefined;
  if (payload.expected_action_digest === '') return undefined;
  return JSON.stringify(payload).length <= MAX_PAYLOAD_CHARS ? payload : undefined;
}

/**
 * The string a Slack button carries as its `value`: the payload as JSON, at most 2000 characters.
 * Throws a `RangeError` when the card cannot make a valid payload: an approval id or a sent-message id that
 * is no UUID, an empty digest, or a digest so long that the payload passes 2000 characters.
 */
export function encodeActionPayload(card: ApprovalCard, sentMessageId: string): string {
  const payload = payloadFor(card, sentMessageId);
  if (payload === undefined) {
    throw new RangeError('The card cannot make an action payload');
  }
  return JSON.stringify(payload);
}

/** The four payload keys of an object, checked as strictly as a payload is: `undefined` when one is missing or wrong. Never throws. */
function payloadOf(record: Readonly<Record<string, unknown>>): ActionPayload | undefined {
  try {
    const approvalId = record.approval_id;
    const sentMessageId = record.sent_message_id;
    const digest = record.expected_action_digest;
    if (record.v !== 1) return undefined;
    if (typeof approvalId !== 'string' || !UUID.test(approvalId)) return undefined;
    if (typeof sentMessageId !== 'string' || !UUID.test(sentMessageId)) return undefined;
    if (typeof digest !== 'string' || digest === '') return undefined;
    const payload: ActionPayload = {
      v: 1,
      approval_id: approvalId,
      sent_message_id: sentMessageId,
      expected_action_digest: digest,
    };
    // The bound `payloadFor` holds a payload to: an object carries no string to measure, so measure it.
    return JSON.stringify(payload).length <= MAX_PAYLOAD_CHARS ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** The value as an object that is not an array, or `undefined`. `Array.isArray` throws on a revoked proxy. */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a payload back. Strict: exactly the four keys, `v` equal to 1, UUID ids and a non-empty digest, the
 * payload no longer than `payloadFor` makes one (2000 characters). It takes the string a Slack button carries
 * or the object an Execute action carries, and returns `undefined` on anything else, including a payload with an
 * extra key. It never throws.
 */
export function parseActionPayload(raw: unknown): ActionPayload | undefined {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_PAYLOAD_CHARS) return undefined;
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const record = plainObject(value);
  if (record === undefined) return undefined;
  try {
    const names = Object.keys(record);
    if (names.length !== KEYS.length || !KEYS.every((key) => names.includes(key))) return undefined;
  } catch {
    return undefined;
  }
  return payloadOf(record);
}

/**
 * Reads the `data` of a Teams `Action.Execute` click. Teams merges the values of the card's inputs into the
 * `data` the action carries, so a click arrives as the payload and the inputs together, `{...payload, reason}`,
 * and `parseActionPayload` refuses it for the extra key. This splits them:
 * - `payload` is the four payload keys, checked as strictly as `parseActionPayload` checks them.
 * - `inputs` is every own key that is not one of the four payload keys (`RESERVED_INPUT_NAMES`), when its value is a
 *   string. A value that is not a string is left out.
 * It returns `undefined` on anything that is not an object or does not hold a valid payload, and it never throws,
 * a getter that throws included. A caller still checks the inputs it expects, by name and length.
 */
export function parseExecuteData(
  data: unknown
): { payload: ActionPayload; inputs: Record<string, string> } | undefined {
  const record = plainObject(data);
  if (record === undefined) return undefined;
  try {
    const payload = payloadOf(record);
    if (payload === undefined) return undefined;
    const inputs: Record<string, string> = {};
    for (const name of Object.keys(record)) {
      if (RESERVED_INPUT_NAMES.includes(name)) continue;
      const value = record[name];
      if (typeof value === 'string') inputs[name] = value;
    }
    return { payload, inputs };
  } catch {
    return undefined;
  }
}

/**
 * The resolve action a click means. Which action was pressed is not in the payload: it is the platform's own action
 * identifier (Slack's `action_id`, Teams' `verb`), set to the `CardAction.id`. A caller rebuilds the card from
 * a fresh read and maps the click here. An identifier the card does not have (the approval is no longer
 * pending) gives `undefined`, and nothing is resolved.
 *
 * A card sent with the ids derived from the capabilities (`approve`, `deny`) and clicked after the deployment
 * began to list its own actions has no action with that id. Then `approve` means the one resolve action
 * whose resolution is `approved`, and `deny` the one whose resolution is `rejected`, if there is exactly one.
 * The reverse is not guessed: the id of a listed action says nothing about its resolution.
 */
export function findCardAction(
  card: ApprovalCard,
  actionId: string
): CardResolveAction | undefined {
  const all: readonly CardAction[] = card.actions;
  const resolves = all.filter((action): action is CardResolveAction => isResolveAction(action));
  const exact = resolves.find((action) => action.id === actionId);
  if (exact !== undefined) return exact;
  const resolution = CHAT_RESOLUTIONS.find(
    (candidate) => DERIVED_ACTION_IDS[candidate] === actionId
  );
  if (resolution === undefined) return undefined;
  const same = resolves.filter((action) => action.resolution === resolution);
  return same.length === 1 ? same[0] : undefined;
}

/** What a click asks the approvals service to do: see `clickIntent`. */
export interface ClickIntent {
  readonly approvalId: string;
  readonly resolution: CardResolveAction['resolution'];
  readonly expectedActionDigest: string;
}

/**
 * What a click on `actionId` of a message asks for, given the card rebuilt from a fresh read and the payload the
 * click carried. `undefined` when the payload is for another approval, or the fresh card has no resolve action
 * for the id (see `findCardAction`): nothing is resolved.
 *
 * `expectedActionDigest` is the payload's, the digest of the call that was shown when the message was sent, never
 * the fresh card's: if the call has changed since, the approvals service refuses the resolve for the mismatch,
 * where the fresh digest would approve a call nobody was shown.
 */
export function clickIntent(
  freshCard: ApprovalCard,
  payload: ActionPayload,
  actionId: string
): ClickIntent | undefined {
  if (payload.approval_id !== freshCard.approvalId) return undefined;
  const action = findCardAction(freshCard, actionId);
  if (action === undefined) return undefined;
  return {
    approvalId: payload.approval_id,
    resolution: action.resolution,
    expectedActionDigest: payload.expected_action_digest,
  };
}
