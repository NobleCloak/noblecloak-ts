import canonicalize from 'canonicalize';

import type { JsonValue, PolicySubject, PolicyWrite } from './types.js';

/** Orders strings by UTF-16 code unit, as RFC 8785 orders object members. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function subjectId(subject: PolicySubject): string {
  return 'id' in subject ? subject.id : '';
}

/** Orders subjects by `type`, then `id` (the organisation subject has none and sorts as the empty id). */
export function compareSubjects(a: PolicySubject, b: PolicySubject): number {
  return compareCodeUnits(a.type, b.type) || compareCodeUnits(subjectId(a), subjectId(b));
}

/** Copies a JSON object without its `undefined` members (an absent member and an undefined one are the same policy). */
function definedMembers(value: object): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, member] of Object.entries(value) as [string, JsonValue | undefined][]) {
    if (member !== undefined) out[key] = member;
  }
  return out;
}

/**
 * The canonical object of a policy's content: only the `PolicyWrite` members (so a read `Policy` and the
 * write it came from compare equal), `targets` always explicit (absent is `{ tools: "all" }`), `subjects`
 * sorted by type then id, `targets.tools` sorted with duplicates kept (rev 10 does not make them unique),
 * `approver_groups` in its own order, and `config` with only the members present (no default filled in).
 */
export function normalizePolicy(policy: PolicyWrite): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { kind: policy.kind };
  if (policy.name !== undefined) out.name = policy.name;
  if (policy.description !== undefined) out.description = policy.description;
  out.subjects = [...policy.subjects]
    .sort(compareSubjects)
    .map((subject) => definedMembers(subject));
  const tools = policy.targets?.tools ?? 'all';
  out.targets = { tools: tools === 'all' ? 'all' : [...tools].sort(compareCodeUnits) };
  out.config = definedMembers(policy.config);
  return out;
}

/**
 * The canonical form of a policy's content: RFC 8785 (JCS) JSON of {@link normalizePolicy}. Two policies
 * with the same canonical form are the same policy; a round trip compares these strings.
 */
export function canonicalPolicy(policy: PolicyWrite): string {
  const text = canonicalize(normalizePolicy(policy));
  /* v8 ignore next -- canonicalize returns undefined only for a value JSON cannot hold, which normalizePolicy never builds */
  if (text === undefined) throw new TypeError('the policy has no JSON form');
  return text;
}
