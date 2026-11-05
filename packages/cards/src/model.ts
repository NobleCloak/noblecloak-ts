import type { components } from '@noblecloak/client';

import {
  MAX_NAME_LENGTH,
  NOTE_MAX_LENGTH,
  OPEN_ACTION_ID,
  RESERVED_INPUT_NAMES,
  SLACK_LIMITS,
} from './limits.js';
import { CARD_TEXT, fill } from './text.js';

/** The contract's `Approval`, from the same `@noblecloak/client` version that ships with this package. */
export type Approval = components['schemas']['Approval'];
/** The arguments of the call, a JSON object the API returns untrusted. */
export type JsonObject = NonNullable<Approval['arguments']>;

/**
 * The version of what a card shows. A caller records it on every message it sends. It is bumped on any change to
 * what a card shows: a field, a fixed string in `CARD_TEXT`, a rule that decides whether the call or an action
 * appears.
 */
export const CARD_MODEL_VERSION = 3 as const;

/**
 * The resolutions a chat card may offer. An allowlist: every other value (any the contract adds later, and any
 * a deployment keeps for itself) is never offered in chat, whatever a read or the capabilities say.
 */
export const CHAT_RESOLUTIONS = ['approved', 'rejected'] as const;

/**
 * Every resolution the contract's `ResolveResolution` names. A `resolve` entry with any other value is malformed.
 * Built from a record typed over the whole enum, so a resolution the contract adds fails typecheck here until it
 * is listed.
 */
const CONTRACT_RESOLUTION_SET: Record<components['schemas']['ResolveResolution'], true> = {
  approved: true,
  rejected: true,
  escalated: true,
};
const CONTRACT_RESOLUTIONS: readonly string[] = Object.keys(CONTRACT_RESOLUTION_SET);

/** A principal as a card names it. `text` is `Name (id)`, or the id alone when there is no name or the name equals the id. */
export interface CardPrincipal {
  readonly id: string;
  readonly kind: string;
  readonly displayName?: string;
  readonly text: string;
  /** For an agent: its parent, as the read gives it, when the read names one. */
  readonly parent?: string;
}

export interface CardHeader {
  /** The requester first, then the agent where one is known. */
  readonly principals: readonly CardPrincipal[];
  /** The person an agent works for. Always absent in v1: the read does not say. */
  readonly owner?: CardPrincipal;
  readonly toolRef: string;
  readonly headline: string;
}

export interface CardHistoryEntry {
  readonly resolution: string;
  readonly by: CardPrincipal;
  readonly at: string;
  readonly reason?: string;
}

/** Every field of the approval except the call that `ApprovalRequest` shows in its facts, outcome and history. */
export interface CardDetails {
  readonly sideEffectLevel: string;
  readonly obligationKind: string;
  readonly requester?: CardPrincipal;
  readonly agent?: CardPrincipal;
  readonly run?: { readonly id: string; readonly kind: string };
  readonly scopeId: string;
  readonly policy?: { readonly id: string; readonly version: number };
  readonly continuationKind?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly waitingOn?: { readonly count: number; readonly principals?: readonly CardPrincipal[] };
  /** The digest of the call. The click payload carries it as `expected_action_digest`. */
  readonly actionDigest: string;
  readonly history: readonly CardHistoryEntry[];
}

/** The call of a card that is not final. `unreadable` is arguments the read carries that are not an object. */
export type PendingCall =
  | { readonly kind: 'arguments'; readonly arguments: JsonObject }
  | { readonly kind: 'link'; readonly why: 'blocked' | 'not_on_read' | 'unreadable' };

/** The call of a final card: never shown. */
export interface FinalCall {
  readonly kind: 'link';
  readonly why: 'final';
}

/** Layer 2. An object so that declared facts can join later. */
export interface CardFacts {
  readonly call: PendingCall | FinalCall;
}

export interface CardInput {
  readonly name: string;
  readonly type: 'text';
  readonly label: string;
  readonly required: boolean;
  readonly maxLength: number;
}

export interface CardResolveAction {
  readonly kind: 'resolve';
  readonly id: string;
  readonly resolution: (typeof CHAT_RESOLUTIONS)[number];
  readonly label: string;
  readonly style: 'primary' | 'danger';
  readonly inputs: readonly CardInput[];
}

/** Room for "Ask {requester}", nudge and escalation targets. v1 renderers render only `resolve`. */
export interface CardOtherAction {
  readonly kind: string & Record<never, never>;
  readonly id: string;
  readonly label: string;
  readonly inputs: readonly CardInput[];
}

export type CardAction = CardResolveAction | CardOtherAction;

/** One approval that counts toward a requirement, as the read gives it. */
export interface CardRequirementApproval {
  readonly by: CardPrincipal;
  readonly at: string;
  /** `listed`: the approver was eligible for the requirement itself; `break_glass`: an administrator under the organisation's setting. */
  readonly basis: string;
}

/**
 * A requirement of the approval. A read without `Approval.requirements` gives one synthetic entry, `{ id:
 * 'approval' }`, with only the first five members. When the read has the member, there is one entry per readable
 * requirement of the read and `approvers` is set on every one of them, so a renderer tells the two apart by it.
 */
export interface CardRequirement {
  readonly id: string;
  readonly state: 'pending' | 'approved' | 'rejected' | 'expired' | 'withdrawn' | 'unknown';
  readonly decidedBy?: CardPrincipal;
  readonly decidedAt?: string;
  readonly note?: string;
  /** From the read: the approver entries in force, a role by its key or a user by id. Empty: the organisation's administrators. */
  readonly approvers?: readonly string[];
  /** From the read: how many eligible principals must approve to meet it. */
  readonly needed?: number;
  /** From the read: the approvals that count toward it, oldest first. */
  readonly approvals?: readonly CardRequirementApproval[];
}

export interface CardStatus {
  readonly requirements: readonly CardRequirement[];
  readonly line: string;
}

export interface CardLinks {
  /** The caller's deep link to `/approvals/{id}`. */
  readonly open: string;
}

/**
 * Every way a card or a rendered message can be less than the read offered, for a caller that records the
 * message as clickable. A card carries the ones the model knows (`actions_dropped`, `actions_withheld`,
 * `call_unreadable` for arguments that are not an object, and `minimal` for an approval it could not read) in
 * `degraded`; a renderer adds the rest and returns the whole list.
 * - `no_payload`: the card has resolve actions but `sentMessageId` is missing or no UUID, or the approval id is
 *   no UUID, or the digest is empty, or the payload is too long; the message has no resolve buttons and no inputs.
 * - `actions_capped`: the card has more than the surface's `maxActions` resolve actions (Slack 10, Teams 5) and the rest are dropped.
 * - `inputs_capped`: the resolve actions the card renders take more distinct inputs than the surface renders
 *   (`inputs`, 5), so some input, a required one included, is not on the message while its button is. A click on
 *   that button can fail for want of the input.
 * - `minimal`: the card is the minimal one (title, headline, status, link), with no resolve buttons: either the
 *   full message was over the platform's size cap, or `toApprovalCard` could not read the approval.
 * - `actions_dropped`: the read lists an action that the model skipped as invalid (not an object, an id that is
 *   not a string, empty, too long, `nc.open` or a duplicate, inputs that are not an array, or an input of an unknown type, a
 *   reserved or invalid name, a `max_length` that is not a positive integer or a `required` that is not a boolean).
 *   A `resolve` action whose `resolution` is missing, not a string or not a resolution the contract names counts
 *   too, as does an entry whose `kind` is missing, empty or not a string. An action of a string kind other than
 *   `resolve`, or whose resolution the contract names but `CHAT_RESOLUTIONS`
 *   does not (`escalated`), is left out by design and not counted.
 * - `actions_withheld`: the deployment lists `approvals.available_actions` in `capabilities.features` and the
 *   pending read has no `available_actions`, so the card has no actions rather than the derived approve and deny.
 * - `call_unreadable`: the arguments are not an object, or the printer could not read them; the message says so.
 * - `call_too_large`: the arguments are over the call's budget for the surface (or the printer's), so the message
 *   shows the link to the full call instead.
 * - `call_shortened`: the message shows the call with a part of it cut, and says so.
 * - `no_link`: the Approvals URL is not one `safeUrl` accepts, so the message has no link to Approvals.
 */
export const CARD_DEGRADATIONS = [
  'no_payload',
  'actions_capped',
  'inputs_capped',
  'minimal',
  'actions_dropped',
  'actions_withheld',
  'call_unreadable',
  'call_too_large',
  'call_shortened',
  'no_link',
] as const;

export type CardDegradation = (typeof CARD_DEGRADATIONS)[number];

declare const CARD_BRAND: unique symbol;

interface CardBase {
  /** A type-level brand: a card literal lacks this member, so in typed code only `toApprovalCard`, which casts, makes a card. */
  readonly [CARD_BRAND]: true;
  readonly version: typeof CARD_MODEL_VERSION;
  readonly approvalId: string;
  readonly viewerRole: 'approver' | 'self' | 'decided_by_viewer' | 'other';
  readonly header: CardHeader;
  readonly details: CardDetails;
  /** Layer 1: why the agent is asking. Absent in v1. */
  readonly reason?: never;
  /** Layer 3: references to the work behind the request. Absent in v1. */
  readonly references?: never;
  readonly status: CardStatus;
  readonly links: CardLinks;
  readonly selfApproval: boolean;
  readonly notice?: 'already_handled';
  /** The degradations the model knows of; a renderer adds its own (see `CardDegradation`). */
  readonly degraded: readonly CardDegradation[];
}

/** A card for a request that is pending (it may have the call and resolve actions), and the minimal card made when the approval could not be read. */
export interface PendingCard extends CardBase {
  readonly facts: { readonly call: PendingCall };
  readonly actions: readonly CardAction[];
}

/** A card for a request that is not pending: its facts, status and history, and no call, no inputs and no resolve actions. */
export interface FinalCard extends CardBase {
  readonly facts: { readonly call: FinalCall };
  readonly actions: readonly [];
}

export type ApprovalCard = PendingCard | FinalCard;

export interface CardViewer {
  readonly principalId: string;
}

export interface ApprovalCardOptions {
  /** True when the organisation keeps the call out of chat. Anything but `false` blocks it. */
  readonly blockCallInChat: boolean;
  /** The caller's deep link to `/approvals/{id}`. */
  readonly approvalsUrl: string;
  /**
   * The deployment's capabilities. `features` is `Capabilities.features`: when it lists
   * `approvals.available_actions`, a pending read without `available_actions` gets no actions (the deployment
   * says, by omitting the member, that this reader has none) instead of the approve and deny derived from
   * `resolutions`.
   */
  readonly capabilities: {
    readonly resolutions: readonly string[];
    readonly features?: readonly string[];
  };
  readonly notice?: 'already_handled';
}

export function isResolveAction(action: CardAction): action is CardResolveAction {
  return action.kind === 'resolve' && 'resolution' in action;
}

// ---- reading a read that may be malformed: every optional member that is not what it should be is absent ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `principalText`'s rule: `Name (id)`, or the id alone when there is no name, it is empty or it equals the id. */
function principalText(id: string, name: string | undefined): string {
  return name === undefined || name === '' || name === id ? id : `${name} (${id})`;
}

function principalOf(value: unknown, kind?: string): CardPrincipal | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined;
  const id = value.id;
  const name = nonEmptyString(value.display_name ?? value.name);
  const parent = nonEmptyString(value.parent);
  return {
    id,
    kind: nonEmptyString(value.kind) ?? kind ?? 'unknown',
    ...(name === undefined ? {} : { displayName: name }),
    text: principalText(id, name),
    ...(parent === undefined ? {} : { parent }),
  };
}

function principalList(value: unknown): CardPrincipal[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CardPrincipal[] = [];
  for (const entry of value as unknown[]) {
    const principal = principalOf(entry);
    if (principal !== undefined) out.push(principal);
  }
  return out;
}

function historyOf(value: unknown): CardHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: CardHistoryEntry[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) continue;
    const by = principalOf(entry.by);
    const resolution = nonEmptyString(entry.resolution);
    const at = nonEmptyString(entry.at);
    if (by === undefined || resolution === undefined || at === undefined) continue;
    const reason = nonEmptyString(entry.reason);
    out.push({ resolution, by, at, ...(reason === undefined ? {} : { reason }) });
  }
  return out;
}

function inputOf(value: unknown): CardInput | undefined {
  if (!isRecord(value) || value.type !== 'text') return undefined;
  const name = value.name;
  if (typeof name !== 'string' || name === '' || name.length > MAX_NAME_LENGTH) return undefined;
  if (RESERVED_INPUT_NAMES.includes(name)) return undefined;
  // A member the deployment sends and that is not what the contract says is malformed, and the action is dropped:
  // a default would put an input on the card that the deployment did not describe.
  const max = value.max_length;
  if (max !== undefined && !(typeof max === 'number' && Number.isInteger(max) && max >= 1)) {
    return undefined;
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') return undefined;
  return {
    name,
    type: 'text',
    label: nonEmptyString(value.label) ?? name,
    required: value.required === true,
    maxLength: max === undefined ? NOTE_MAX_LENGTH : Math.min(max, SLACK_LIMITS.inputMaxLength),
  };
}

/** The actions' ids when they are derived from the capabilities, by resolution. A listed action has the deployment's own id. */
export const DERIVED_ACTION_IDS: Readonly<Record<(typeof CHAT_RESOLUTIONS)[number], string>> = {
  approved: 'approve',
  rejected: 'deny',
};

function isChatResolution(value: unknown): value is (typeof CHAT_RESOLUTIONS)[number] {
  return CHAT_RESOLUTIONS.some((resolution) => resolution === value);
}

const NOTE_INPUT: CardInput = {
  name: 'reason',
  type: 'text',
  label: CARD_TEXT.noteLabel,
  required: false,
  maxLength: NOTE_MAX_LENGTH,
};

function styleOf(resolution: (typeof CHAT_RESOLUTIONS)[number]): 'primary' | 'danger' {
  return resolution === 'approved' ? 'primary' : 'danger';
}

/**
 * The actions a deployment lists: `resolve` actions whose resolution is in `CHAT_RESOLUTIONS` and whose inputs the
 * model can read.
 * `dropped` is true when an entry was skipped as invalid (see `actions_dropped` in `CardDegradation`): an entry
 * that is not an object, an action with a bad or duplicate id, an id derived for the other resolution (`approve` on a rejection), or one with an input that is of an unknown type,
 * is named like a click-payload key (`RESERVED_INPUT_NAMES`) or has a malformed `max_length` or `required`, or a
 * `resolve` entry whose `resolution` is missing, not a string or unknown to the contract, or an entry whose `kind`
 * is missing, empty or not a string. An entry of another string kind, or with a contract resolution outside `CHAT_RESOLUTIONS` (`escalated`), is left out by design and not counted.
 */
function listedActions(listed: readonly unknown[]): { actions: CardAction[]; dropped: boolean } {
  const out: CardAction[] = [];
  const seen = new Set<string>();
  let dropped = false;
  for (const entry of listed) {
    if (!isRecord(entry)) {
      dropped = true;
      continue;
    }
    // `kind` is a required string: a missing or non-string one is malformed. A string kind that is not `resolve`
    // is left out by design.
    if (typeof entry.kind !== 'string' || entry.kind === '') {
      dropped = true;
      continue;
    }
    if (entry.kind !== 'resolve') continue;
    const resolution = entry.resolution;
    const id = entry.id;
    if (!isChatResolution(resolution)) {
      // A resolution the contract names but chat does not offer (`escalated`) is left out by design; a missing,
      // non-string or unknown one is a malformed entry.
      if (typeof resolution !== 'string' || !CONTRACT_RESOLUTIONS.includes(resolution))
        dropped = true;
      continue;
    }
    if (
      typeof id !== 'string' ||
      id === '' ||
      id.length > MAX_NAME_LENGTH ||
      id === OPEN_ACTION_ID ||
      seen.has(id)
    ) {
      dropped = true;
      continue;
    }
    // An id derived for the other resolution (`approve` for a rejection) would let a message sent with derived ids
    // resolve the opposite way when its button is clicked after the deployment lists actions (see `findCardAction`).
    if (CHAT_RESOLUTIONS.some((c) => DERIVED_ACTION_IDS[c] === id && c !== resolution)) {
      dropped = true;
      continue;
    }
    if (!Array.isArray(entry.inputs)) {
      dropped = true;
      continue;
    }
    const inputs: CardInput[] = [];
    let known = true;
    for (const raw of entry.inputs as unknown[]) {
      const input = inputOf(raw);
      if (input === undefined) {
        known = false;
        break;
      }
      inputs.push(input);
    }
    if (!known) {
      dropped = true;
      continue;
    }
    seen.add(id);
    out.push({
      kind: 'resolve',
      id,
      resolution,
      label:
        nonEmptyString(entry.label) ??
        (resolution === 'approved' ? CARD_TEXT.approve : CARD_TEXT.deny),
      style: styleOf(resolution),
      inputs,
    });
  }
  return { actions: out, dropped };
}

/** Approve then deny, for each offered resolution the deployment's capabilities list, each with the note input. */
function derivedActions(resolutions: readonly string[]): CardAction[] {
  const out: CardAction[] = [];
  for (const resolution of CHAT_RESOLUTIONS) {
    if (!resolutions.includes(resolution)) continue;
    out.push({
      kind: 'resolve',
      id: DERIVED_ACTION_IDS[resolution],
      resolution,
      label: resolution === 'approved' ? CARD_TEXT.approve : CARD_TEXT.deny,
      style: styleOf(resolution),
      inputs: [NOTE_INPUT],
    });
  }
  return out;
}

function requirementState(state: string): CardRequirement['state'] {
  switch (state) {
    case 'pending':
    case 'expired':
    case 'withdrawn':
    case 'rejected':
      return state;
    case 'approved':
    case 'consumed':
      return 'approved';
    default:
      return 'unknown';
  }
}

/**
 * One `CardRequirement` per requirement of the read, or `undefined` when the read has none that can be read
 * (the member is absent, not an array, empty, or holds only malformed entries), so the caller keeps the
 * synthetic entry. An entry with no string `id` is skipped, and so is a later entry with an id already seen. `state` is `approved` when
 * the requirement is met, else `approvalState`.
 */
function wireRequirements(
  value: unknown,
  approvalState: CardRequirement['state']
): CardRequirement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CardRequirement[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) continue;
    const id = nonEmptyString(entry.id);
    if (id === undefined || out.some((seen) => seen.id === id)) continue;
    const approvals = approvalsOf(entry.approvals);
    const last = approvals[approvals.length - 1];
    const needed = typeof entry.needed === 'number' ? entry.needed : undefined;
    out.push({
      id,
      state: entry.met === true ? 'approved' : approvalState,
      ...(last === undefined ? {} : { decidedBy: last.by, decidedAt: last.at }),
      approvers: approverKeys(entry.approvers),
      ...(needed === undefined ? {} : { needed }),
      approvals,
    });
  }
  return out.length === 0 ? undefined : out;
}

function approverKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) continue;
    const key = nonEmptyString(entry.role) ?? nonEmptyString(entry.user);
    if (key !== undefined) out.push(key);
  }
  return out;
}

function approvalsOf(value: unknown): CardRequirementApproval[] {
  if (!Array.isArray(value)) return [];
  const out: CardRequirementApproval[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) continue;
    const by = principalOf(entry.by);
    if (by === undefined) continue;
    out.push({ by, at: textOf(entry.at), basis: textOf(entry.basis) });
  }
  return out;
}

function headlineOf(
  toolRef: string,
  requester: CardPrincipal | undefined,
  agent: CardPrincipal | undefined
): string {
  const tool = toolRef;
  const short = (principal: CardPrincipal): string => principal.displayName ?? principal.id;
  if (agent !== undefined && requester !== undefined) {
    return fill(CARD_TEXT.headlineAgent, {
      agent: short(agent),
      requester: short(requester),
      tool,
    });
  }
  if (agent !== undefined) return fill(CARD_TEXT.headlineAgentAlone, { agent: short(agent), tool });
  if (requester !== undefined) {
    return fill(CARD_TEXT.headlineRequester, { requester: short(requester), tool });
  }
  return fill(CARD_TEXT.headlineTool, { tool });
}

/** The feature a deployment lists in `Capabilities.features` when it sets `Approval.available_actions` (rev 15). */
const AVAILABLE_ACTIONS_FEATURE = 'approvals.available_actions';

/** Marks an object as a card. The cast is the one place a card is made: `toApprovalCard` calls it, nothing else does. */
function seal<T extends ApprovalCard>(card: Omit<T, typeof CARD_BRAND>): T {
  return card as T;
}

/**
 * Builds the card for one approval read as one viewer.
 *
 * Pure, and it never throws. A malformed optional member of the read is treated as absent. Anything that does
 * throw while reading (a throwing getter, a revoked proxy, options without `capabilities`) gives the minimal
 * link-only card, `degraded: ['minimal']`, made from the approval id alone if need be.
 * - The call is in the card only when the read carries it, `options.blockCallInChat` is `false` and the
 *   approval is pending. Otherwise `facts.call` is a link, with the reason. Arguments that are present and not
 *   an object are `unreadable`, not `not_on_read`.
 * - A state other than `pending` gives a `FinalCard`: no actions and no call. A state the model does not know
 *   has the requirement state `unknown` and the status line "Status unknown".
 * - Actions come from `available_actions` when the read has it. When it does not, they come from the
 *   capabilities (approve and deny for the resolutions listed), unless `capabilities.features` lists
 *   `approvals.available_actions`: then there are none (`actions_withheld`). Only `CHAT_RESOLUTIONS` are ever
 *   offered.
 * - `status.requirements` has one entry per readable requirement of `approval.requirements` when the read has the
 *   member, else the one synthetic `{ id: 'approval' }` entry.
 * - The note of a final card is the reason of the deciding entry of the history alone: the latest entry whose
 *   resolution is the final resolution.
 */
export function toApprovalCard(
  approval: Approval,
  viewer: CardViewer,
  options: ApprovalCardOptions
): ApprovalCard {
  try {
    return buildCard(approval, viewer, options);
  } catch {
    return failClosedCard(approval, options);
  }
}

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** The minimal link-only card: the approval id and the link, if they can be read, and nothing else. */
function failClosedCard(approval: unknown, options: unknown): PendingCard {
  const approvalId = attempt(() => textOf((approval as Approval).id), '');
  const open = attempt(() => {
    const url = (options as ApprovalCardOptions).approvalsUrl;
    return typeof url === 'string' ? url : '';
  }, '');
  return seal<PendingCard>({
    version: CARD_MODEL_VERSION,
    approvalId,
    viewerRole: 'other',
    header: { principals: [], toolRef: '', headline: CARD_TEXT.headlineUnknown },
    details: {
      sideEffectLevel: '',
      obligationKind: '',
      scopeId: '',
      createdAt: '',
      actionDigest: '',
      history: [],
    },
    facts: { call: { kind: 'link', why: 'unreadable' } },
    actions: [],
    status: {
      requirements: [{ id: 'approval', state: 'unknown' }],
      line: CARD_TEXT.statusUnknown,
    },
    links: { open },
    selfApproval: false,
    degraded: ['minimal'],
  });
}

function buildCard(
  approval: Approval,
  viewer: CardViewer,
  options: ApprovalCardOptions
): ApprovalCard {
  // Read first, so that options without `capabilities` fail closed whatever the approval is.
  const capabilityResolutions: unknown = options.capabilities.resolutions;
  const capabilityFeatures: unknown = options.capabilities.features;
  const state = textOf(approval.state);
  const pending = state === 'pending';
  const toolRef = textOf(approval.tool_ref);
  const requester = principalOf(approval.requester);
  const agent = principalOf(approval.agent, 'agent');
  const approver = principalOf(approval.approver);
  const history = historyOf(approval.resolution_history);

  const run = isRecord(approval.run) ? approval.run : undefined;
  const policy = isRecord(approval.policy) ? approval.policy : undefined;
  const waiting = isRecord(approval.waiting_on) ? approval.waiting_on : undefined;
  const waitingPrincipals = waiting === undefined ? undefined : principalList(waiting.principals);
  const continuationKind = nonEmptyString(approval.continuation_kind);
  const expiresAt = nonEmptyString(approval.expires_at);

  const details: CardDetails = {
    sideEffectLevel: textOf(approval.side_effect_level),
    obligationKind: textOf(approval.obligation_kind),
    ...(requester === undefined ? {} : { requester }),
    ...(agent === undefined ? {} : { agent }),
    ...(run !== undefined && typeof run.id === 'string' && typeof run.kind === 'string'
      ? { run: { id: run.id, kind: run.kind } }
      : {}),
    scopeId: textOf(approval.scope_id),
    ...(policy !== undefined && typeof policy.id === 'string' && typeof policy.version === 'number'
      ? { policy: { id: policy.id, version: policy.version } }
      : {}),
    ...(continuationKind === undefined ? {} : { continuationKind }),
    createdAt: textOf(approval.created_at),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(waiting !== undefined && typeof waiting.count === 'number'
      ? {
          waitingOn: {
            count: waiting.count,
            ...(waitingPrincipals === undefined || waitingPrincipals.length === 0
              ? {}
              : { principals: waitingPrincipals }),
          },
        }
      : {}),
    actionDigest: textOf(approval.action_digest),
    history,
  };

  const args: unknown = approval.arguments;
  // Fail closed: a caller that leaves the option out (a JavaScript caller) does not get the call in chat.
  const callAllowed = (options.blockCallInChat as unknown) === false;
  const degraded: CardDegradation[] = [];
  let call: PendingCall;
  if (!callAllowed) call = { kind: 'link', why: 'blocked' };
  else if (args === undefined) call = { kind: 'link', why: 'not_on_read' };
  else if (isRecord(args)) call = { kind: 'arguments', arguments: args };
  else call = { kind: 'link', why: 'unreadable' };

  let actions: CardAction[] = [];
  if (pending) {
    const listed: unknown = approval.available_actions;
    if (Array.isArray(listed)) {
      const read = listedActions(listed as unknown[]);
      actions = read.actions;
      if (read.dropped) degraded.push('actions_dropped');
    } else if (
      Array.isArray(capabilityFeatures) &&
      capabilityFeatures.includes(AVAILABLE_ACTIONS_FEATURE)
    ) {
      degraded.push('actions_withheld');
    } else {
      actions = derivedActions(Array.isArray(capabilityResolutions) ? capabilityResolutions : []);
    }
    if (call.kind === 'link' && call.why === 'unreadable') degraded.push('call_unreadable');
  }

  const selfApproval = pending && requester?.id === viewer.principalId;
  const decidedByViewer = !pending && approver?.id === viewer.principalId;
  const viewerRole: ApprovalCard['viewerRole'] = selfApproval
    ? 'self'
    : decidedByViewer
      ? 'decided_by_viewer'
      : pending
        ? 'approver'
        : 'other';

  const resolution =
    nonEmptyString(approval.resolution) ?? (state === 'consumed' ? 'approved' : state);
  const requirementStateOf = requirementState(state);
  // The deciding entry: the latest one whose resolution is the final resolution. Its reason is the note, if it
  // has one; an entry before it, or by someone else, never lends its reason.
  const deciding = pending
    ? undefined
    : [...history].reverse().find((entry) => entry.resolution === resolution);
  const decidedAt = nonEmptyString(approval.resolved_at);
  const viewerNote = deciding?.by.id === viewer.principalId ? deciding.reason : undefined;

  const line = statusLine({
    pending,
    known: requirementStateOf !== 'unknown',
    state,
    selfApproval,
    decidedByViewer,
    resolution,
    approver,
    viewerNote,
  });

  const requirement: CardRequirement = {
    id: 'approval',
    state: requirementStateOf,
    ...(approver === undefined ? {} : { decidedBy: approver }),
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(deciding?.reason === undefined ? {} : { note: deciding.reason }),
  };

  const common = {
    version: CARD_MODEL_VERSION,
    approvalId: textOf(approval.id),
    viewerRole,
    header: {
      principals: [
        ...(requester === undefined ? [] : [requester]),
        ...(agent === undefined ? [] : [agent]),
      ],
      toolRef,
      headline: headlineOf(toolRef, requester, agent),
    },
    details,
    status: {
      requirements: wireRequirements(approval.requirements, requirementStateOf) ?? [requirement],
      line,
    },
    links: { open: options.approvalsUrl },
    selfApproval,
    ...(options.notice === 'already_handled' ? { notice: 'already_handled' as const } : {}),
    degraded,
  };
  return pending
    ? seal<PendingCard>({ ...common, facts: { call }, actions })
    : seal<FinalCard>({ ...common, facts: { call: { kind: 'link', why: 'final' } }, actions: [] });
}

interface StatusInput {
  readonly pending: boolean;
  /** False when the state is none the model knows. */
  readonly known: boolean;
  readonly state: string;
  readonly selfApproval: boolean;
  readonly decidedByViewer: boolean;
  readonly resolution: string;
  readonly approver: CardPrincipal | undefined;
  readonly viewerNote: string | undefined;
}

function statusLine(input: StatusInput): string {
  if (input.pending) return input.selfApproval ? CARD_TEXT.statusSelf : CARD_TEXT.statusPending;
  if (!input.known) return CARD_TEXT.statusUnknown;
  if (input.state === 'withdrawn') return CARD_TEXT.statusWithdrawn;
  if (input.state === 'expired') return CARD_TEXT.statusExpired;
  const approved = input.resolution === 'approved';
  const denied = input.resolution === 'rejected';
  if (input.decidedByViewer && (approved || denied)) {
    const lead = approved ? CARD_TEXT.statusYouApproved : CARD_TEXT.statusYouDenied;
    return input.viewerNote === undefined
      ? lead
      : `${lead}${CARD_TEXT.statusYouSeparator}${input.viewerNote}`;
  }
  const by = input.approver?.text;
  if (by === undefined) {
    if (approved) return CARD_TEXT.statusApprovedUnnamed;
    return denied ? CARD_TEXT.statusDeniedUnnamed : CARD_TEXT.statusClosed;
  }
  if (approved) return fill(CARD_TEXT.statusHandledApproved, { approver: by });
  if (denied) return fill(CARD_TEXT.statusHandledDenied, { approver: by });
  return fill(CARD_TEXT.statusHandled, { approver: by });
}
