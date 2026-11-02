import canonicalize from 'canonicalize';

import { normalizePolicy } from './canonical.js';
import { pointer } from './pointer.js';
import type { JsonValue, PolicyWrite } from './types.js';

/** One difference between two policies' canonical forms. */
export interface PolicyChange {
  /** A JSON pointer into the canonical policy: `/name`, `/subjects`, `/targets/tools`, `/config/mode`. */
  readonly path: string;
  readonly op: 'add' | 'remove' | 'replace';
  readonly before?: JsonValue;
  readonly after?: JsonValue;
}

const MEMBERS = ['kind', 'name', 'description', 'subjects', 'targets', 'config'] as const;

function json(value: JsonValue): string {
  return canonicalize(value) ?? '';
}

/** The elements of `before` missing from `after` and the reverse, as multisets (a repeated element counts each time). */
function multisetChanges(
  path: string,
  before: readonly JsonValue[],
  after: readonly JsonValue[]
): PolicyChange[] {
  const remaining = after.map(json);
  const removed: PolicyChange[] = [];
  for (const element of before) {
    const index = remaining.indexOf(json(element));
    if (index === -1) removed.push({ path, op: 'remove', before: element });
    else remaining[index] = '\u0000';
  }
  const added = after
    .filter((_, index) => remaining[index] !== '\u0000')
    .map((element): PolicyChange => ({ path, op: 'add', after: element }));
  return [...removed, ...added];
}

function valueChange(
  path: string,
  before: JsonValue | undefined,
  after: JsonValue | undefined
): PolicyChange[] {
  if (before === undefined && after === undefined) return [];
  if (before === undefined) return [{ path, op: 'add', after: after as JsonValue }];
  if (after === undefined) return [{ path, op: 'remove', before }];
  return json(before) === json(after) ? [] : [{ path, op: 'replace', before, after }];
}

/**
 * The differences between the current version of a policy and an incoming one, over their canonical forms
 * (`normalizePolicy`): so the order of subjects and tools never counts. `subjects` and `targets.tools`
 * are compared as sets (multisets for tools), one change per element added or removed; `config` member by
 * member; every other member as a value. Empty when the two are the same policy. With no current
 * version, the one change is the whole incoming policy, added at the root.
 */
export function diffPolicies(
  current: PolicyWrite | undefined,
  incoming: PolicyWrite
): PolicyChange[] {
  const after = normalizePolicy(incoming);
  if (current === undefined) return [{ path: '', op: 'add', after }];
  const before = normalizePolicy(current);
  const changes: PolicyChange[] = [];
  for (const member of MEMBERS) {
    const a = before[member];
    const b = after[member];
    if (member === 'subjects') {
      changes.push(...multisetChanges('/subjects', a as JsonValue[], b as JsonValue[]));
    } else if (member === 'targets') {
      const ta = (a as { tools: JsonValue }).tools;
      const tb = (b as { tools: JsonValue }).tools;
      changes.push(
        ...(Array.isArray(ta) && Array.isArray(tb)
          ? multisetChanges('/targets/tools', ta, tb)
          : valueChange('/targets/tools', ta, tb))
      );
    } else if (member === 'config') {
      const ca = a as Record<string, JsonValue>;
      const cb = b as Record<string, JsonValue>;
      const keys = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort();
      for (const key of keys)
        changes.push(...valueChange(pointer('config', key), ca[key], cb[key]));
    } else {
      changes.push(...valueChange(pointer(member), a, b));
    }
  }
  return changes;
}
