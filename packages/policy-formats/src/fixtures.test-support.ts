/**
 * Shared by the tests: the cedar-wasm Node build, the upstream fixtures, and the generated cartesian
 * product of the supported subset that the round-trip suites run over.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cedarWasm from '@cedar-policy/cedar-wasm/nodejs';

import type {
  CedarParser,
  ExportablePolicy,
  PolicySubject,
  ToolInvocationConfig,
} from './types.js';

export const cedar = cedarWasm;
/** The Node build satisfies the parser interface an import takes. */
export const parser: CedarParser = cedarWasm;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function fixture(path: string): string {
  return readFileSync(join(ROOT, 'test-fixtures', path), 'utf8');
}

export function packageFile(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** Strings a file must carry exactly: quotes, backslashes, line breaks, controls, C1, separators, astral text. */
export const AWKWARD = [
  'plain',
  'with "quotes" and \\backslashes\\',
  'line\nbreak\r\ntab\t',
  'nul\u0000 bell\u0007 del\u007f c1\u0085\u009f',
  'separators\u2028\u2029 bom\ufeff nonchar\ufffe\uffff',
  'émoji 🛡️ 中文',
  '// not a comment',
  '# not a yaml comment',
  '${x} `tick`',
  ' leading and trailing ',
] as const;

const SUBJECT_SETS: Readonly<Record<'noblecloak' | 'agt', readonly (readonly PolicySubject[])[]>> =
  {
    noblecloak: [
      [{ type: 'user', id: 'user_1' }],
      [{ type: 'agent', id: 'agent_1' }],
      [{ type: 'service', id: 'svc_1' }],
      [{ type: 'group', id: 'grp_1' }],
      [{ type: 'role', id: 'member' }],
      [{ type: 'organization' }],
      [
        { type: 'user', id: 'user_2' },
        { type: 'role', id: 'admin' },
      ],
      [{ type: 'agent', id: 'agent_2' }, { type: 'organization' }, { type: 'group', id: 'grp_2' }],
    ],
    agt: [
      [{ type: 'agent', id: 'agent_1' }],
      [{ type: 'organization' }],
      [
        { type: 'agent', id: 'agent_2' },
        { type: 'agent', id: 'agent_3' },
      ],
      [{ type: 'organization' }, { type: 'agent', id: 'agent_4' }],
    ],
  };

/** Absent (every tool), every tool explicitly, one, two out of order, a duplicated one (rev 10 allows it). */
const TARGETS: readonly (ExportablePolicy['targets'] | undefined)[] = [
  undefined,
  { tools: 'all' },
  { tools: ['mcp:conn_1:main:send_email'] },
  { tools: ['tool_b', 'tool_a'] },
  { tools: ['tool_a', 'tool_a'] },
];

function configs(): ToolInvocationConfig[] {
  const out: ToolInvocationConfig[] = [];
  for (const mode of ['always_allow', 'deny', 'not_granted'] as const) out.push({ mode });
  for (const mode of ['ask', 'escalate'] as const)
    for (const onDeny of [undefined, 'resume', 'halt'] as const)
      for (const expiresAfter of [undefined, 'PT1H'])
        for (const groups of [undefined, [], ['ops', 'finance']])
          out.push({
            mode,
            ...(onDeny === undefined ? {} : { on_deny: onDeny }),
            ...(expiresAfter === undefined ? {} : { expires_after: expiresAfter }),
            ...(groups === undefined ? {} : { approver_groups: groups }),
          });
  return out;
}

/**
 * The supported subset of a dialect as a cartesian product: every mode with every combination of its
 * legal optional members, × the subject sets legal in the dialect (single subjects of each type and
 * multi-subject policies) × the target forms × name absent or present × description absent, empty or
 * present.
 */
export function supportedSubset(dialect: 'noblecloak' | 'agt'): ExportablePolicy[] {
  const out: ExportablePolicy[] = [];
  let n = 0;
  for (const config of configs())
    for (const subjects of SUBJECT_SETS[dialect])
      for (const targets of TARGETS)
        for (const name of [undefined, 'Policy name'])
          for (const description of [undefined, '', 'Why this policy exists.']) {
            n += 1;
            out.push({
              id: `pol_${String(n).padStart(5, '0')}`,
              kind: 'tool_invocation',
              ...(name === undefined ? {} : { name }),
              ...(description === undefined ? {} : { description }),
              subjects: [...subjects],
              ...(targets === undefined ? {} : { targets }),
              config,
            });
          }
  return out;
}

/**
 * The subset in slices, by mode and target form, each with its label: every policy in exactly one slice. A property
 * test runs one `it` per slice, so each case stays well within the test timeout on a slow CI runner, and the union is
 * still the whole subset (a test asserts it).
 */
export function slicesOf(
  subset: readonly ExportablePolicy[]
): { readonly label: string; readonly policies: readonly ExportablePolicy[] }[] {
  const slices = new Map<string, ExportablePolicy[]>();
  for (const policy of subset) {
    const mode = (policy.config as { mode: string }).mode;
    const tools = policy.targets?.tools;
    const form =
      tools === undefined ? 'targets unstated' : tools === 'all' ? 'every tool' : tools.join('+');
    const label = `${mode}, ${form}`;
    const slice = slices.get(label) ?? [];
    slice.push(policy);
    slices.set(label, slice);
  }
  return [...slices].map(([label, policies]) => ({ label, policies }));
}

/** Policies whose every string member is one of {@link AWKWARD}. */
export function awkwardPolicies(dialect: 'noblecloak' | 'agt'): ExportablePolicy[] {
  return AWKWARD.map((text, index) => ({
    id: `${text}#${String(index)}`,
    kind: 'tool_invocation',
    name: text,
    description: text,
    subjects: [
      dialect === 'agt' ? { type: 'agent', id: text } : { type: 'user', id: text },
      dialect === 'agt' ? { type: 'agent', id: `${text}2` } : { type: 'role', id: text },
    ],
    targets: { tools: [text, `${text}2`] },
    config: {
      mode: 'ask',
      on_deny: 'resume',
      expires_after: text,
      approver_groups: [text, text],
    },
  }));
}

/** An exported policy back from an import result, with its key as its id. */
export function asExportable(policy: {
  key?: string;
  write: ExportablePolicy | object;
}): ExportablePolicy {
  if (policy.key === undefined) throw new Error('an imported policy without a key');
  return { ...(policy.write as ExportablePolicy), id: policy.key };
}
