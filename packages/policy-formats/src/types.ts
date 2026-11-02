import type { components, JsonValue } from '@noblecloak/client';

export type { JsonValue };

/** The content of a policy (contract rev 10 `PolicyWrite`): what an import produces and a round trip compares. */
export type PolicyWrite = components['schemas']['PolicyWrite'];
/** A policy as the API reads it (contract rev 10 `Policy`). */
export type Policy = components['schemas']['Policy'];
/** A registered tool (contract rev 10 `Tool`). */
export type Tool = components['schemas']['Tool'];
export type PolicySubject = components['schemas']['PolicySubject'];
export type PolicyMode = components['schemas']['PolicyMode'];
export type ToolInvocationConfig = components['schemas']['ToolInvocationConfig'];

/**
 * A policy to export: its content and its `id`, which becomes the policy key of every statement the
 * policy is exported as (`@noblecloak_policy`), so an import can tell which policy a statement belongs to.
 * A read `Policy` is one.
 */
export type ExportablePolicy = PolicyWrite & { readonly id: string };

/** A tool of the inventory an AGT export lists in the manifest's `tools` catalog. A read `Tool` is one. */
export interface InventoryTool {
  readonly tool_ref: string;
}

/**
 * One thing a conversion could not carry, or carried only in part. `path` is a JSON pointer: into the array
 * of policies given to an export, or into the imported file's structure (a Cedar statement is
 * `/policies/<n>`, its n-th static policy in file order; an AGT manifest's inline policy set is
 * `/policies/<id>/policy_set` and its statements follow the same scheme below it). `policy` is the policy
 * key the entry belongs to, when there is one.
 */
export interface ReportEntry {
  readonly path: string;
  readonly reason: string;
  readonly policy?: string;
}

export interface ExportResult {
  /** The file: a leading comment block that states what the export lost, then the content. */
  readonly text: string;
  /** Exported, but the target engine does not enforce it as NobleCloak does. */
  readonly lossy: readonly ReportEntry[];
  /** Not exported at all. */
  readonly unsupported: readonly ReportEntry[];
  /** File-wide statements, such as what the target engine does with a call no policy matches. */
  readonly notes: readonly string[];
}

export interface CedarExportOptions {
  /**
   * `allow` adds a statement that permits every call no other statement forbids, marked
   * `@noblecloak_baseline("allow")`. Absent, nothing is added and the target engine denies a call no
   * policy matches.
   */
  readonly baseline?: 'allow';
}

/** The AGT release an export targets. */
export type AgtVersion = '5.0' | 'main';

export interface AgtExportOptions extends CedarExportOptions {
  /**
   * `5.0` (the default, the latest AGT release): manifest version `0.3.1-beta`. `main`: manifest version
   * `0.4.0-alpha.1`, for AGT's unreleased main branch (ACS engine 0.4.0-alpha.4).
   */
  readonly agtVersion?: AgtVersion;
  /**
   * Whether the host's Cedar dispatcher turns a permit's `@advice` escalate into an approval. Default:
   * true for `main` (its bundled dispatcher does), false for `5.0` (its bundled dispatcher reads no
   * annotation, so a permit with advice would be a plain allow). When false, `ask` and `escalate` are
   * exported as a `forbid` (fail closed); when true, as a `permit` carrying `@advice`.
   */
  readonly adviceAwareDispatcher?: boolean;
  /**
   * The name AGT sees for a tool, by `tool_ref`. AGT's adapters pass the framework's own tool name (for
   * MCP, the bare tool name), so a `tool_ref` matches only where the host passes it as the name. A
   * `tool_ref` with no entry is exported as itself.
   */
  readonly toolNames?: Readonly<Record<string, string>>;
  /** The manifest's `approval` block (AGT D5: `default_resolver`, `resolvers`, ...), written as given. Absent, none is written. */
  readonly resolver?: Readonly<Record<string, JsonValue>>;
}

/** Where an imported policy came from (contract rev 11 `PolicyWrite.origin`). */
export interface PolicyOrigin {
  readonly format: 'agt' | 'cedar';
  /** Lowercase hex SHA-256 of the imported file's bytes. */
  readonly digest: string;
}

export interface ImportedPolicy {
  /** The policy key (`@noblecloak_policy`): the id of the policy that was exported. Absent for a statement written elsewhere. */
  readonly key?: string;
  readonly write: PolicyWrite;
}

export interface ImportResult {
  readonly policies: readonly ImportedPolicy[];
  /** Not imported: a construct the format can express and NobleCloak cannot, or that this package does not read. */
  readonly unsupported: readonly ReportEntry[];
  /** Imported, but part of the file was not kept (an annotation, a resolver block, a tool name with no mapping). */
  readonly lossy: readonly ReportEntry[];
  /** Not imported: the statement's body and its NobleCloak annotations disagree. */
  readonly conflicts: readonly ReportEntry[];
  /** File-wide remarks, such as that comments are not kept. */
  readonly notes: readonly string[];
  readonly origin: PolicyOrigin;
}

export interface CedarImportResult extends ImportResult {
  /** The options that, given to `exportCedar` with the imported policies, reproduce a file this package wrote. */
  readonly options: CedarExportOptions;
}

export interface AgtImportResult extends ImportResult {
  /** The manifest's `agent_control_specification_version`. */
  readonly manifestVersion: string;
  /** The tools of the manifest's catalog, as `tool_ref`s. */
  readonly tools: readonly InventoryTool[];
  /** The options that, given to `exportAgt` with the imported policies and `tools`, reproduce a file this package wrote. */
  readonly options: AgtExportOptions;
}

/** The subset of `@cedar-policy/cedar-wasm` an import uses. The package itself satisfies it. */
export interface CedarParser {
  policySetTextToParts(
    text: string
  ):
    | { type: 'success'; policies: string[]; policy_templates: string[] }
    | { type: 'failure'; errors: { message: string }[] };
  policyToJson(
    policy: string
  ): { type: 'success'; json: unknown } | { type: 'failure'; errors: { message: string }[] };
}

export interface ImportOptions {
  /**
   * The Cedar parser, or a function that loads it. Absent, `@cedar-policy/cedar-wasm` (an optional peer
   * dependency) is loaded with a dynamic `import()` on the first import. A Node program may pass
   * `() => import('@cedar-policy/cedar-wasm/nodejs')`.
   */
  readonly cedar?: CedarParser | (() => Promise<CedarParser>);
}

export interface AgtImportOptions extends ImportOptions {
  /**
   * The same map an export takes (`tool_ref` → AGT tool name), inverted to read the manifest's tool
   * names back as `tool_ref`s. Without an entry, a name is read from the catalog's `noblecloak_tool_ref`
   * (which this package writes), and failing that imported as itself and reported.
   */
  readonly toolNames?: Readonly<Record<string, string>>;
}
