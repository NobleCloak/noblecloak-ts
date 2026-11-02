/**
 * Pure pieces of the policy import/export panel: a policy as the converter of `@noblecloak/policy-formats` takes it, an
 * imported policy matched to the organisation's by its policy key, and whether the service's advertised policy forms
 * take an imported policy. No I/O and no React; the converter itself is loaded on demand by the panel.
 */
import type { PolicyFormsFacts, PolicyInfo, PolicyWorkingCopy } from './permissions-types.js';

/** A policy's content as `PolicyWrite` writes it. */
export interface PolicyContent {
  readonly kind: string;
  readonly name?: string;
  readonly description?: string;
  readonly subjects: readonly { readonly type: string; readonly id?: string }[];
  readonly targets: { readonly tools: 'all' | readonly string[] };
  readonly config: Readonly<Record<string, unknown>>;
}

/** The content of a version, or `undefined` when its targets were not stated (a write would mean every tool). */
export function contentOf(policy: PolicyInfo): PolicyContent | undefined {
  if (policy.targets === undefined) return undefined;
  return {
    kind: policy.kind,
    ...(policy.name === undefined ? {} : { name: policy.name }),
    ...(policy.description === undefined ? {} : { description: policy.description }),
    subjects: policy.subjects.map((s) =>
      s.id === undefined ? { type: s.type } : { type: s.type, id: s.id }
    ),
    targets: { tools: policy.targets === 'all' ? 'all' : [...policy.targets] },
    config: { ...policy.config },
  };
}

/** A policy as an export takes it: its content and its id, the policy key of every statement it becomes. */
export function exportableOf(
  policy: PolicyInfo
): (PolicyContent & { readonly id: string }) | undefined {
  const content = contentOf(policy);
  return content === undefined ? undefined : { ...content, id: policy.id };
}

/** The working copy a save writes, from an imported policy's content. */
export function workingCopyOf(content: PolicyContent): PolicyWorkingCopy {
  return {
    kind: content.kind,
    ...(content.name === undefined ? {} : { name: content.name }),
    ...(content.description === undefined ? {} : { description: content.description }),
    subjects: content.subjects.map((s) =>
      s.id === undefined ? { type: s.type } : { type: s.type, id: s.id }
    ),
    targets: content.targets.tools === 'all' ? 'all' : [...content.targets.tools],
    config: { ...content.config },
  };
}

/**
 * The members of an imported policy the service's advertised forms do not take, as `PolicyWrite` names them
 * (`config.mode`, `subjects`, `targets`, `config.<member>`). Empty when the forms take it, or when the service
 * advertises none (a refusal is then learnt from its 422).
 */
export function refusedMembers(
  content: PolicyContent,
  forms: PolicyFormsFacts | undefined
): string[] {
  const form = forms?.toolInvocation;
  if (form === undefined || content.kind !== 'tool_invocation') return [];
  const refused: string[] = [];
  const mode = content.config.mode;
  if (typeof mode === 'string' && !form.modes.includes(mode)) refused.push('config.mode');
  if (content.subjects.some((s) => !form.subjectTypes.includes(s.type))) refused.push('subjects');
  if (content.targets.tools === 'all' && !form.targetsAll) refused.push('targets');
  for (const member of Object.keys(content.config))
    if (member !== 'mode' && !form.configMembers.includes(member)) refused.push(`config.${member}`);
  return refused;
}

/**
 * The organisation's policy an imported one is matched to: the `tool_invocation` policy whose id is its policy key,
 * exactly. Absent key, or no such policy: it is new.
 */
export function matchOf(
  key: string | undefined,
  policies: readonly PolicyInfo[]
): PolicyInfo | undefined {
  return key === undefined ? undefined : policies.find((p) => p.id === key);
}
