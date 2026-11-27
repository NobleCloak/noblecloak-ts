import {
  FORKS,
  SETUP_INTENTS,
  STEP_AVAILABILITIES,
  STEP_STATES,
  setupProgress,
  type Fork,
  type SetupSignal,
  type SetupState,
  type SetupStepRow,
} from '@noblecloak/setup-steps';
import { interrupted, interruptedError, requestSignal } from './abortable.js';
import type { Io } from './io.js';

/** What the setup read says about an organization, as the terminal needs it. */
export type SetupRead =
  /** Some screens are left: `left` of `total`, counted by the same rule as the setup pill. */
  | { readonly kind: 'unfinished'; readonly left: number; readonly total: number }
  /** Nothing is left: the first run is complete, or the checklist was dismissed. */
  | { readonly kind: 'finished' }
  /** The person is not an administrator of the organization: members have no checklist (403). */
  | { readonly kind: 'not_admin' }
  /** The server refused the token (401): it was revoked or has expired. */
  | { readonly kind: 'rejected' }
  /** Anything else: the server or network failed, or the answer did not parse. */
  | { readonly kind: 'unreadable' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  typeof value === 'string' ? values.find((v) => v === value) : undefined;

/**
 * A signal reported as `{ done: boolean | null }`. A missing one reads unknown, never done; one that is
 * present but not that shape is undefined, and the whole body is refused (the shell's schema does the same).
 */
function signal(value: unknown): SetupSignal | undefined {
  if (value === undefined) return { done: null };
  return isRecord(value) && (typeof value.done === 'boolean' || value.done === null)
    ? { done: value.done }
    : undefined;
}

/**
 * The setup rule's input from the body of `GET /organizations/{id}/setup`, with the degrade rules the rule's
 * package documents: an unknown state reads `unknown`, an unknown availability reads `disabled`, an unknown
 * intent reads `null`, a missing signal reads `{ done: null }`. Undefined, as the shell's schema refuses it
 * (noblesos-shell src/setup/setupProgress.ts), when the body has no step list or no `dismissed`, when any
 * step is not an object with a string `key`, or when a signal that is present is not `{ done: boolean | null }`:
 * a wrong answer would be worse than none, and the two counts must not diverge.
 */
export function parseSetupState(
  data: unknown
): { state: SetupState; fork: Fork | undefined } | undefined {
  if (!isRecord(data) || !Array.isArray(data.steps) || typeof data.dismissed !== 'boolean') {
    return undefined;
  }
  const steps: SetupStepRow[] = [];
  for (const row of data.steps as unknown[]) {
    if (!isRecord(row) || typeof row.key !== 'string') return undefined;
    steps.push({
      key: row.key,
      state: oneOf(STEP_STATES, row.state) ?? 'unknown',
      availability: oneOf(STEP_AVAILABILITIES, row.availability) ?? 'disabled',
    });
  }
  const appAuthorized = signal(data.app_authorized);
  const proposalApproved = signal(data.setup_proposal_approved);
  const heldDecided = signal(data.held_action_decided);
  if (appAuthorized === undefined || proposalApproved === undefined || heldDecided === undefined) {
    return undefined;
  }
  return {
    state: {
      steps,
      intent: oneOf(SETUP_INTENTS, data.intent) ?? null,
      app_authorized: appAuthorized,
      setup_proposal_approved: proposalApproved,
      held_action_decided: heldDecided,
      dismissed: data.dismissed,
    },
    fork: oneOf(FORKS, data.fork),
  };
}

/** The count the terminal prints, by the pill's rule: `left` of `total` screens, or finished. */
export function progressOf(data: unknown): SetupRead {
  const parsed = parseSetupState(data);
  if (parsed === undefined) return { kind: 'unreadable' };
  const progress = setupProgress(parsed.state, parsed.fork);
  const left = progress.total - progress.finished;
  if (progress.hidden || left <= 0) return { kind: 'finished' };
  return { kind: 'unfinished', left, total: progress.total };
}

/**
 * Reads the organization's setup with the admin-API token (`setup:read`). Never throws except for an
 * interrupt: every other failure is a `SetupRead` the caller words.
 */
export async function readSetup(
  io: Io,
  origin: string,
  orgId: string,
  accessToken: string
): Promise<SetupRead> {
  let response: Response;
  try {
    response = await io.fetch(`${origin}/organizations/${orgId}/setup`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: requestSignal(io),
    });
  } catch {
    if (interrupted(io)) throw interruptedError('Nothing was changed.');
    return { kind: 'unreadable' };
  }
  if (response.status === 401) return { kind: 'rejected' };
  if (response.status === 403) return { kind: 'not_admin' };
  if (!response.ok) return { kind: 'unreadable' };
  const body: unknown = await response.json().catch(() => undefined);
  if (body === undefined && interrupted(io)) throw interruptedError('Nothing was changed.');
  return progressOf(isRecord(body) ? body.data : undefined);
}
