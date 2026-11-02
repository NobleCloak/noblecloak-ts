import type { Approval, NamedPrincipalRef } from '../approvals-types.js';
import { escapeInvisible } from './format-json.js';
import type { ApprovalsLabelKey, Translate } from './labels.js';

const LEVEL: Readonly<Record<Approval['side_effect_level'], ApprovalsLabelKey>> = {
  read: 'levelRead',
  write: 'levelWrite',
  delete: 'levelDelete',
  external: 'levelExternal',
  admin: 'levelAdmin',
};

const OBLIGATION: Readonly<Record<Approval['obligation_kind'], ApprovalsLabelKey>> = {
  tool_invocation: 'obligationToolInvocation',
  spending: 'obligationSpending',
};

function lookup<K extends string>(
  table: Readonly<Record<K, ApprovalsLabelKey>>,
  value: string,
  t: Translate
): string {
  // A value this version does not know (a later contract may add one) is shown as it came.
  return Object.hasOwn(table, value) ? t(table[value as K]) : escapeInvisible(value);
}

/** A side-effect level as a word. */
export function levelWord(level: string, t: Translate): string {
  return lookup(LEVEL, level, t);
}

/** An obligation kind as a label. */
export function obligationWord(kind: string, t: Translate): string {
  return lookup(OBLIGATION, kind, t);
}

/** A principal named inside an approval (the client's `NamedPrincipalRef`), or an agent the same way: told as a name and an id, or the id alone. */
export type NamedRef = Pick<NamedPrincipalRef, 'id' | 'display_name'>;

/**
 * The text that names a principal: `Name (id)` when the service named it, the id otherwise. The id stays beside
 * a name because a name is whatever the service says and two principals can share one. Raw text: render it
 * as inert text, as every value the service sends is.
 */
export function principalText(ref: NamedRef): string {
  const name = ref.display_name;
  return name === undefined || name === '' || name === ref.id ? ref.id : `${name} (${ref.id})`;
}
