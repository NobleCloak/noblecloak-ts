import { CST, Lexer, parseDocument } from 'yaml';

import { AGT } from '../cedar/ast.js';
import { assemble } from '../cedar/decode.js';
import type { ToolResolver } from '../cedar/decode.js';
import {
  COMMENTS_NOTE,
  EMPTY_NOTE,
  hasForeignCedarComments,
  loadCedar,
  parsePolicySet,
  withoutOwnHeader,
} from '../cedar/parse.js';
import { originOf, readInput } from '../digest.js';
import { PolicyFormatError } from '../errors.js';
import { pointer, quote, show } from '../pointer.js';
import type {
  AgtExportOptions,
  AgtImportOptions,
  AgtImportResult,
  ImportedPolicy,
  InventoryTool,
  JsonValue,
  ReportEntry,
} from '../types.js';
import {
  ACCEPTED_VERSIONS,
  defaultAdviceAware,
  EXPORT_NAME,
  POLICY_TARGET,
  TOOL_NAME_FROM,
  TOOL_REF_MEMBER,
} from './export.js';

const POINTS = [
  'agent_startup',
  'input',
  'pre_model_call',
  'post_model_call',
  'pre_tool_call',
  'post_tool_call',
  'output',
  'agent_shutdown',
];

/** Sets an own property, so a key such as `__proto__` is kept as data, never as the prototype. */
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the YAML holds a comment other than the block this package writes at its top. */
function hasForeignYamlComments(text: string): boolean {
  const rest = withoutOwnHeader(text, '#');
  for (const token of new Lexer().lex(rest)) if (CST.tokenType(token) === 'comment') return true;
  return false;
}

/** A JSON copy of a YAML value, or undefined when it holds something JSON cannot (a binary, a date). */
function asJson(value: unknown, depth = 0): JsonValue | undefined {
  // As deep as the export's YAML printer writes, so a block that imports can be exported again.
  if (depth > 64) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => asJson(item, depth + 1));
    return items.every((item) => item !== undefined) ? items : undefined;
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const [key, member] of Object.entries(value)) {
    const json = asJson(member, depth + 1);
    if (json === undefined) return undefined;
    setOwn(out, key, json);
  }
  return out;
}

/**
 * An AGT manifest (YAML) → policies: the inline Cedar policy set bound at `pre_tool_call`, read in AGT's
 * Cedar dialect. Tool names are read back as `tool_ref`s through `opts.toolNames` (inverted), else the
 * catalog's `noblecloak_tool_ref`, else as themselves (reported). Accepts every manifest version AGT 5.0 or
 * AGT main accepts; anything else is reported and nothing is imported. Rego, custom and test policies,
 * other intervention points, `extends`, `annotators` and file paths are reported, never followed. Throws
 * `parse_error` when the text is not one YAML mapping or the policy set is not Cedar.
 */
export async function importAgt(
  input: string | Uint8Array,
  opts: AgtImportOptions = {}
): Promise<AgtImportResult> {
  const { text, bytes } = readInput(input);
  const doc = parseDocument(text, { uniqueKeys: true, version: '1.2' });
  // A warning is an unresolved tag (`!secret`, `!!foo`): the value under it would be read as something else.
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length > 0)
    throw new PolicyFormatError(
      'parse_error',
      `not a YAML document this import reads: ${problems.map((error) => error.message).join('; ')}`,
      problems.map((error) => error.message)
    );
  let manifest: unknown;
  try {
    manifest = doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new PolicyFormatError(
      'parse_error',
      `the YAML document cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      [],
      { cause: error }
    );
  }
  if (!isRecord(manifest))
    throw new PolicyFormatError('parse_error', 'an AGT manifest is a YAML mapping');
  const origin = await originOf('agt', bytes);

  const unsupported: ReportEntry[] = [];
  const lossy: ReportEntry[] = [];
  const notes: string[] = [];
  const version = manifest.agent_control_specification_version;
  const agtVersion =
    typeof version === 'string' && Object.hasOwn(ACCEPTED_VERSIONS, version)
      ? ACCEPTED_VERSIONS[version]
      : undefined;
  if (agtVersion === undefined) {
    return {
      policies: [],
      unsupported: [
        {
          path: '/agent_control_specification_version',
          reason: `manifest version ${show(version)} is not one AGT 5.0 (0.3.1-beta, 0.3.1-beta-agt, 0.3.0-alpha, 0.3.0-alpha-agt) or AGT main (0.4.0-alpha.1, 0.5.0-alpha.1) accepts; nothing is imported`,
        },
      ],
      lossy,
      conflicts: [],
      notes,
      origin,
      manifestVersion: typeof version === 'string' ? version : '',
      tools: [],
      options: {},
    };
  }
  const options: { -readonly [K in keyof AgtExportOptions]: AgtExportOptions[K] } = { agtVersion };

  const metadata = manifest.metadata;
  if (isRecord(metadata))
    for (const [key, value] of Object.entries(metadata))
      if (!(key === 'name' && value === EXPORT_NAME))
        lossy.push({ path: pointer('metadata', key), reason: 'manifest metadata is not kept' });

  /** A member of the wrong shape is reported and read as empty, never read around. */
  const mapping = (path: string, value: unknown): Record<string, unknown> => {
    if (value === undefined || isRecord(value)) return value ?? {};
    unsupported.push({ path, reason: `${show(value)} is not a mapping; it is not read` });
    return {};
  };

  if (
    manifest.extends !== undefined &&
    !(Array.isArray(manifest.extends) && manifest.extends.length === 0)
  )
    unsupported.push({
      path: '/extends',
      reason: "the parent manifests are not read: resolve extends with AGT's own loader first",
    });
  if (
    manifest.annotators !== undefined &&
    !(isRecord(manifest.annotators) && Object.keys(manifest.annotators).length === 0)
  )
    unsupported.push({ path: '/annotators', reason: 'annotators have no NobleCloak form' });
  if (manifest.approval !== undefined) {
    const approval = asJson(manifest.approval);
    if (isRecord(approval)) {
      options.resolver = approval;
      lossy.push({
        path: '/approval',
        reason:
          "the approval block configures AGT's resolver and is no policy; it is returned as options.resolver for an export",
      });
    } else {
      unsupported.push({
        path: '/approval',
        reason: 'the approval block is not a JSON mapping; it is neither imported nor returned',
      });
    }
  }

  // The catalog: AGT tool name → tool_ref.
  const catalog = mapping('/tools', manifest.tools);
  const recordedOf = (name: string): string | undefined => {
    const entry = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
    const recorded = isRecord(entry) ? entry[TOOL_REF_MEMBER] : undefined;
    return typeof recorded === 'string' && recorded.length > 0 ? recorded : undefined;
  };
  // The tool_ref each name stands for: the recorded one, or the name itself. A tool_ref two names stand
  // for cannot be read back to one of them, so those names keep their own names and are reported.
  const claimants = new Map<string, string[]>();
  for (const name of Object.keys(catalog)) {
    const ref = recordedOf(name) ?? name;
    claimants.set(ref, [...(claimants.get(ref) ?? []), name]);
  }
  const recordedRef = (name: string): string | undefined => {
    const recorded = recordedOf(name);
    return recorded !== undefined && (claimants.get(recorded)?.length ?? 0) === 1
      ? recorded
      : undefined;
  };
  for (const [ref, names] of claimants)
    if (names.length > 1)
      for (const name of names)
        if (recordedOf(name) !== undefined)
          lossy.push({
            path: pointer('tools', name, TOOL_REF_MEMBER),
            reason: `the tool_ref ${quote(ref)} stands for several tool names (${names.map(quote).join(', ')}); this one is read as the tool_ref ${quote(name)}`,
          });
  for (const [name, entry] of Object.entries(catalog)) {
    const at = pointer('tools', name);
    if (!isRecord(entry)) {
      lossy.push({ path: at, reason: 'the catalog entry is not a mapping' });
      continue;
    }
    for (const [key, value] of Object.entries(entry)) {
      if (key === TOOL_REF_MEMBER && typeof value === 'string' && value.length > 0) continue;
      lossy.push({
        path: `${at}${pointer(key)}`,
        reason:
          key === TOOL_REF_MEMBER
            ? `${TOOL_REF_MEMBER} is not a non-empty string; the tool name is not mapped through it`
            : 'the catalog member is not kept: a NobleCloak policy reads no tool attribute',
      });
    }
  }
  const inverse = new Map<string, string[]>();
  for (const [ref, name] of Object.entries(opts.toolNames ?? {}))
    inverse.set(name, [...(inverse.get(name) ?? []), ref]);
  const refOf = (name: string): { ref: string; mapped: boolean } | { ambiguous: string[] } => {
    const refs = inverse.get(name);
    const [only] = refs ?? [];
    if (refs !== undefined)
      return refs.length === 1 && only !== undefined
        ? { ref: only, mapped: true }
        : { ambiguous: refs };
    const recorded = recordedRef(name);
    return recorded === undefined ? { ref: name, mapped: false } : { ref: recorded, mapped: true };
  };
  for (const [name, refs] of inverse) {
    const recorded = recordedRef(name);
    if (recorded !== undefined && refs.length === 1 && refs[0] !== recorded)
      lossy.push({
        path: pointer('tools', name, TOOL_REF_MEMBER),
        reason: `the catalog records the tool_ref ${quote(recorded)}; opts.toolNames maps ${quote(refs[0] ?? '')} to this name, and it is imported as that`,
      });
  }

  const points = mapping('/intervention_points', manifest.intervention_points);
  for (const point of Object.keys(points))
    if (point !== 'pre_tool_call')
      unsupported.push({
        path: pointer('intervention_points', point),
        reason: POINTS.includes(point)
          ? `${point} is not imported: NobleCloak policies govern tool invocation, bound at pre_tool_call`
          : `${quote(point)} is not an intervention point`,
      });

  const policies = mapping('/policies', manifest.policies);
  const binding = points.pre_tool_call;
  let boundId: string | undefined;
  const at = (...rest: string[]): string =>
    pointer('intervention_points', 'pre_tool_call', ...rest);
  if (binding === undefined) {
    notes.push('No policy is bound at pre_tool_call, so there is nothing to import.');
  } else if (!isRecord(binding)) {
    unsupported.push({
      path: at(),
      reason: `${show(binding)} is not a mapping; nothing is imported`,
    });
  } else {
    if (binding.tool_name_from !== TOOL_NAME_FROM)
      lossy.push({
        path: at('tool_name_from'),
        reason:
          binding.tool_name_from === undefined
            ? 'without tool_name_from the engine builds no Tool resource, so a statement naming a tool never matches'
            : `tool names are read from ${show(binding.tool_name_from)}, not ${TOOL_NAME_FROM}; they are imported as written`,
      });
    if (binding.annotations !== undefined)
      unsupported.push({ path: at('annotations'), reason: 'annotators have no NobleCloak form' });
    if (binding.policy_target === undefined)
      lossy.push({
        path: at('policy_target'),
        reason:
          'absent: AGT refuses to load a manifest whose pre_tool_call has no policy_target, so these policies were not in force; they are imported as written',
      });
    for (const key of Object.keys(binding)) {
      if (key === 'tool_name_from' || key === 'annotations' || key === 'policy') continue;
      if (key === 'policy_target' && binding[key] === POLICY_TARGET) continue;
      lossy.push({
        path: at(key),
        reason: `the binding member ${quote(key)} is not kept: an export writes policy_target ${POLICY_TARGET} only`,
      });
    }
    const policyBinding = binding.policy;
    if (isRecord(policyBinding) && typeof policyBinding.id === 'string') {
      boundId = policyBinding.id;
      for (const key of Object.keys(policyBinding))
        if (key !== 'id')
          unsupported.push({
            path: at('policy', key),
            reason: `the binding member ${quote(key)} is not imported: only an inline Cedar policy bound by id is read`,
          });
      if (!Object.hasOwn(policies, boundId) || !isRecord(policies[boundId]))
        unsupported.push({ path: at('policy', 'id'), reason: `names no policy of the manifest` });
    } else {
      unsupported.push({
        path: at('policy'),
        reason:
          'binds no policy by id: only an inline Cedar policy bound by id is read; nothing is imported',
      });
    }
  }
  const bound = new Set(
    Object.values(points)
      .map((entry) => (isRecord(entry) && isRecord(entry.policy) ? entry.policy.id : undefined))
      .filter((id): id is string => typeof id === 'string')
  );
  for (const id of Object.keys(policies))
    if (!bound.has(id))
      unsupported.push({
        path: pointer('policies', id),
        reason: 'bound by id at no intervention point; not imported',
      });

  let imported: ImportedPolicy[] = [];
  const conflicts: ReportEntry[] = [];
  const definition =
    boundId === undefined || !Object.hasOwn(policies, boundId) ? undefined : policies[boundId];
  if (boundId !== undefined && isRecord(definition)) {
    const base = pointer('policies', boundId);
    if (definition.type !== 'cedar') {
      unsupported.push({
        path: base,
        reason: `a ${show(definition.type)} policy is not read; only an inline Cedar policy_set is`,
      });
    } else if (typeof definition.policy_set !== 'string') {
      unsupported.push(
        definition.policy_set === undefined
          ? {
              path: `${base}/policy_path`,
              reason:
                'a policy file is not read (an import has no file system): inline it as policy_set',
            }
          : {
              path: `${base}/policy_set`,
              reason: `${show(definition.policy_set)} is not Cedar text`,
            }
      );
    } else {
      for (const key of Object.keys(definition))
        if (key !== 'type' && key !== 'policy_set')
          unsupported.push({
            path: `${base}${pointer(key)}`,
            reason:
              key === 'query'
                ? 'query is not imported: AGT main rejects it and AGT 5.0 ignores it'
                : `${quote(key)} is not imported (an import reads the inline policy_set only)`,
          });
      const seen = new Set<string>();
      const resolveTool: ToolResolver = (name, path) => {
        const resolved = refOf(name);
        if ('ambiguous' in resolved) {
          // The caller's map names several tool_refs for this AGT name; keep the name and say so.
          return {
            ref: name,
            lossy: {
              path,
              reason: `toolNames maps ${resolved.ambiguous.map(quote).join(', ')} to the tool name ${quote(name)}; it is imported as the tool_ref ${quote(name)}`,
            },
          };
        }
        if (!Object.hasOwn(catalog, name) && !seen.has(name)) {
          seen.add(name);
          lossy.push({
            path,
            reason: `the tool ${quote(name)} is not in the manifest's tools catalog: AGT fails a call to it closed (tool_unknown)`,
          });
        }
        return resolved.mapped
          ? { ref: resolved.ref }
          : {
              ref: resolved.ref,
              lossy: {
                path,
                reason: `the tool name ${quote(name)} has no tool_ref mapping; it is imported as the tool_ref ${quote(name)}`,
              },
            };
      };
      const cedar = await loadCedar(opts.cedar);
      const policySet = definition.policy_set;
      const { statements, templates } = parsePolicySet(
        cedar,
        policySet,
        `${base}/policy_set`,
        AGT,
        resolveTool
      );
      if (statements.length === 0 && templates.length === 0) notes.push(EMPTY_NOTE);
      const assembled = assemble(statements);
      imported = assembled.policies;
      unsupported.push(...assembled.unsupported, ...templates);
      lossy.push(...assembled.lossy);
      conflicts.push(...assembled.conflicts);
      if (assembled.baseline) options.baseline = 'allow';
      if (assembled.encoding === 'advice' || assembled.encoding === 'fail_closed') {
        const aware = assembled.encoding === 'advice';
        if (aware !== defaultAdviceAware(agtVersion)) options.adviceAwareDispatcher = aware;
      }
      if (assembled.encoding === 'mixed')
        notes.push(
          'Some ask or escalate policies are written as a permit with @advice and others as a fail-closed forbid; an export writes them all one way.'
        );
      if (
        agtVersion === '5.0' &&
        (assembled.encoding === 'advice' || assembled.encoding === 'mixed')
      )
        notes.push(
          "This AGT 5.0 manifest writes ask or escalate as a permit with @advice: AGT 5.0's bundled Cedar dispatcher reads no @advice, so it allowed those calls unless the host supplied an advice-aware dispatcher."
        );
      if (hasForeignCedarComments(policySet)) notes.push(COMMENTS_NOTE);
    }
  }
  if (hasForeignYamlComments(text) && !notes.includes(COMMENTS_NOTE)) notes.push(COMMENTS_NOTE);

  const tools: InventoryTool[] = [];
  const toolNames: Record<string, string> = {};
  for (const name of Object.keys(catalog)) {
    const resolved = refOf(name);
    const ref = 'ambiguous' in resolved ? name : resolved.ref;
    tools.push({ tool_ref: ref });
    if (ref !== name) setOwn(toolNames, ref, name);
  }
  if (Object.keys(toolNames).length > 0) options.toolNames = toolNames;

  return {
    policies: imported,
    unsupported,
    lossy,
    conflicts,
    notes,
    origin,
    manifestVersion: version as string,
    tools,
    options,
  };
}
