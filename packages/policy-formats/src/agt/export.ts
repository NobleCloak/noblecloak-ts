import { compareCodeUnits } from '../canonical.js';
import { AGT } from '../cedar/ast.js';
import { baselineStatement, encodedOutcome, encodePolicy } from '../cedar/encode.js';
import type { ApprovalEncoding } from '../cedar/encode.js';
import { printStatements } from '../cedar/print.js';
import { PolicyFormatError } from '../errors.js';
import {
  approvalSettingsLossy,
  checkBaseline,
  outcomeNote,
  prepare,
  unmatchedNote,
} from '../export.js';
import { pointer } from '../pointer.js';
import { commentBlock, HEADER_MARK, headerLines } from '../report.js';
import type {
  AgtExportOptions,
  AgtVersion,
  ExportablePolicy,
  ExportResult,
  InventoryTool,
  ToolInvocationConfig,
} from '../types.js';
import { hasLoneSurrogate } from '../validate.js';
import { literalBlock, member } from './yaml.js';

/** The manifest version each target writes (`agent_control_specification_version`). */
export const MANIFEST_VERSION: Readonly<Record<AgtVersion, string>> = {
  '5.0': '0.3.1-beta',
  main: '0.4.0-alpha.1',
};

/** Every manifest version an import accepts, by the AGT release whose engine accepts it. */
export const ACCEPTED_VERSIONS: Readonly<Record<string, AgtVersion>> = {
  '0.3.1-beta': '5.0',
  '0.3.1-beta-agt': '5.0',
  '0.3.0-alpha': '5.0',
  '0.3.0-alpha-agt': '5.0',
  '0.4.0-alpha.1': 'main',
  '0.5.0-alpha.1': 'main',
};

/** The id of the one policy the manifest binds at `pre_tool_call`. */
export const POLICY_ID = 'noblecloak_tool_invocation';
/** The catalog member that records which `tool_ref` an AGT tool name stands for. */
export const TOOL_REF_MEMBER = 'noblecloak_tool_ref';
export const TOOL_NAME_FROM = '$.tool_call.name';
export const POLICY_TARGET = '$.tool_call.args';
/** The manifest's `metadata.name`. */
export const EXPORT_NAME = 'noblecloak-tool-policies';

/** The default of `adviceAwareDispatcher`: AGT main's bundled dispatcher reads `@advice`, 5.0's does not. */
export function defaultAdviceAware(version: AgtVersion): boolean {
  return version === 'main';
}

function checkName(kind: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || hasLoneSurrogate(value))
    throw new PolicyFormatError(
      'invalid_input',
      `${kind} ${JSON.stringify(value)} is not a non-empty, well-formed string`
    );
  return value;
}

/**
 * An AGT manifest (YAML): the ACS manifest of the target release, binding at `pre_tool_call` one inline
 * Cedar policy set in AGT's dialect, with every tool of the inventory (and every tool a policy names) in
 * its `tools` catalog, since the engine fails a call to a tool outside the catalog closed. Give it the
 * organisation's whole set of `tool_invocation` policies: a manifest binds one policy per intervention
 * point, so this one replaces whatever else is bound there.
 *
 * AGT names no end user, so only `agent` and `organization` subjects export; a policy with any other
 * subject is reported as unsupported. `ask` and `escalate` are a `permit` carrying `@advice` escalate
 * when the dispatcher reads advice (`adviceAwareDispatcher`, default true for `main`), else a `forbid`
 * (fail closed). The YAML opens with a comment block stating what the export lost.
 */
export function exportAgt(
  policies: readonly ExportablePolicy[],
  tools: readonly InventoryTool[],
  opts: AgtExportOptions = {}
): ExportResult {
  const version = opts.agtVersion ?? '5.0';
  if (!Object.hasOwn(MANIFEST_VERSION, version))
    throw new PolicyFormatError('invalid_input', `agtVersion is "5.0" or "main"`);
  const adviceAware = opts.adviceAwareDispatcher ?? defaultAdviceAware(version);
  const encoding: ApprovalEncoding = adviceAware ? 'advice' : 'fail_closed';
  const toolNames = opts.toolNames ?? {};
  for (const [ref, name] of Object.entries(toolNames)) {
    checkName('a toolNames tool_ref', ref);
    checkName(`the toolNames entry of ${JSON.stringify(ref)}`, name);
  }
  const nameOf = (ref: string): string =>
    (Object.hasOwn(toolNames, ref) ? toolNames[ref] : undefined) ?? ref;

  checkBaseline(opts.baseline);
  const { exported, unsupported, lossy } = prepare(policies, AGT);
  let advised = false;
  for (const { index, policy } of exported) {
    const config = policy.config as ToolInvocationConfig;
    const mode = encodedOutcome(config);
    const at = pointer(index, 'config', 'mode');
    if (mode === 'ask' || mode === 'escalate') {
      advised ||= adviceAware;
      lossy.push({
        path: at,
        reason: adviceAware
          ? `${
              mode === 'ask'
                ? 'ask is exported as a permit with @advice escalate: AGT has one approval path, so ask and escalate are not told apart'
                : 'escalate is exported as a permit with @advice escalate: AGT sends every escalation to its default resolver, and the routing of escalate is not carried'
            }${outcomeNote(mode, config.mode)}${
              version === '5.0'
                ? "; on AGT 5.0 this relies on the host's dispatcher reading @advice (adviceAwareDispatcher: true): the bundled Cedar dispatcher would allow the call"
                : ''
            }`
          : `${mode} is exported as a forbid (fail closed): ${
              version === '5.0'
                ? "AGT 5.0's bundled Cedar dispatcher reads no @advice, so a permit would allow the call"
                : 'the host dispatcher does not read @advice (adviceAwareDispatcher: false)'
            }; @noblecloak_mode keeps ${config.mode} for an import${outcomeNote(mode, config.mode)}`,
        policy: policy.id,
      });
    } else if (mode === 'not_granted') {
      lossy.push({
        path: at,
        reason: `not_granted is exported as a forbid: AGT denies the call with the reason ${
          version === '5.0' ? 'no_matching_policy' : 'in @id'
        }, not not_granted`,
        policy: policy.id,
      });
    }
    lossy.push(...approvalSettingsLossy(index, policy, 'AGT'));
    // One entry per policy (a policy has at most one organization subject), pointing at the subjects
    // array: an index into it would change with the subjects' order, and the comment block must not.
    if (policy.subjects.some((subject) => subject.type === 'organization'))
      lossy.push({
        path: pointer(index, 'subjects'),
        reason:
          'the organization subject is an unconstrained principal: it covers every agent the manifest governs, which is the organisation exactly only when the manifest is deployed for it alone',
        policy: policy.id,
      });
  }

  // The catalog: every inventory tool and every tool an exported policy names, by AGT name.
  const refs = new Set<string>();
  for (const tool of tools as readonly unknown[]) {
    if (typeof tool !== 'object' || tool === null)
      throw new PolicyFormatError(
        'invalid_input',
        'a tool of the inventory is an object with a tool_ref'
      );
    refs.add(checkName('a tool_ref', (tool as { tool_ref?: unknown }).tool_ref));
  }
  for (const { policy } of exported) {
    const targets = policy.targets?.tools ?? 'all';
    if (targets !== 'all') for (const ref of targets) refs.add(ref);
  }
  const catalog = new Map<string, string>();
  for (const ref of refs) {
    const name = nameOf(ref);
    const other = catalog.get(name);
    if (other !== undefined)
      throw new PolicyFormatError(
        'invalid_input',
        `the tools ${JSON.stringify(other)} and ${JSON.stringify(ref)} both have the AGT name ${JSON.stringify(name)}`
      );
    catalog.set(name, ref);
  }
  const renamed = [...catalog].filter(([name, ref]) => name !== ref).length;

  const baseline = opts.baseline === 'allow';
  const notes = [
    unmatchedNote(baseline),
    'The manifest binds this policy set at pre_tool_call; AGT binds one policy per intervention point, so it replaces any policy bound there.',
    renamed === 0
      ? 'Tool names are the tool_refs verbatim: a statement matches only where the host passes the tool_ref as the tool name.'
      : `Tool names follow the toolNames map for ${String(renamed)} of ${String(catalog.size)} tools; the others are the tool_refs verbatim. The catalog's ${TOOL_REF_MEMBER} records each tool_ref.`,
  ];
  if (version === '5.0')
    notes.push(
      "AGT 5.0 evaluates a Cedar policy only through a Cedar dispatcher the host registers: its SDKs' zero-config default dispatcher evaluates Rego only and refuses this manifest."
    );
  if (advised)
    notes.push(
      'AGT passes one escalate reason to its resolver: when several ask or escalate policies match a call, only the first declared one reaches it, where NobleCloak requires every one.'
    );

  const statements = exported.flatMap(({ policy }) =>
    encodePolicy(policy, { dialect: AGT, approvalEncoding: encoding, toolId: nameOf })
  );
  if (baseline) statements.push(baselineStatement(AGT));
  const policySet =
    statements.length === 0 ? `// ${HEADER_MARK}: none.\n` : printStatements(statements);

  const lines = [
    ...member('agent_control_specification_version', MANIFEST_VERSION[version]),
    ...member('metadata', { name: EXPORT_NAME }),
    'policies:',
    `  ${POLICY_ID}:`,
    '    type: cedar',
    ...literalBlock('policy_set', policySet, '    '),
    'intervention_points:',
    '  pre_tool_call:',
    ...member('policy_target', POLICY_TARGET).map((line) => `    ${line}`),
    ...member('tool_name_from', TOOL_NAME_FROM).map((line) => `    ${line}`),
    '    policy:',
    `      id: ${POLICY_ID}`,
    ...member(
      'tools',
      Object.fromEntries(
        [...catalog]
          .sort(([a], [b]) => compareCodeUnits(a, b))
          .map(([name, ref]) => [name, { [TOOL_REF_MEMBER]: ref }])
      )
    ),
  ];
  if (opts.resolver !== undefined) lines.push(...member('approval', opts.resolver));
  const header = headerLines(
    `AGT ${version}, ACS manifest ${MANIFEST_VERSION[version]} with a Cedar policy set at pre_tool_call`,
    notes,
    lossy,
    unsupported
  );
  return {
    text: `${commentBlock('#', header)}${lines.join('\n')}\n`,
    lossy,
    unsupported,
    notes,
  };
}
