/**
 * The `permissions` module entry: `usePolicies` (the hook over the headless store), `createPoliciesStore`,
 * `usePolicyEditor` and `usePolicySimulate` (one policy's editor and dry run), `useEffectivePolicies` (what a holder of a
 * role or of the organisation would get), the components `Permissions`, `PolicyEditor`, `PolicySimulation`,
 * `EffectiveAccess`, `PolicyRoundTrip` (import and export as Cedar or an AGT manifest) and `ModeLegend`, the grid builder, the mode vocabulary as the contract publishes
 * it, the module's types and `MODULE_ID`. A client entry: the hooks import no component, and an import of only a hook
 * bundles none.
 */
export const MODULE_ID = 'permissions';

export type {
  AuthoringState,
  CellPolicy,
  CellWriteResult,
  ConsideredEntry,
  DraftEntry,
  EditorNote,
  MatrixCell,
  MatrixColumn,
  MatrixGroup,
  MatrixRow,
  OtherPoliciesState,
  OtherPolicy,
  OtherPolicyView,
  OtherSubjectEntry,
  PendingRef,
  PermissionsError,
  PermissionsErrorKind,
  PermissionsMatrix,
  PermissionsPreconditionCode,
  PoliciesController,
  PoliciesSnapshot,
  PoliciesStatus,
  PoliciesStore,
  PolicyAuthor,
  PolicyCapabilityFacts,
  PolicyEditorController,
  PolicyEditorSnapshot,
  PolicyEditorStore,
  PolicyFormsFacts,
  PolicyInfo,
  PolicyOrigin,
  PolicySimulationController,
  PolicySimulationSnapshot,
  PolicySimulationStore,
  PolicySubject,
  PolicyWorkingCopy,
  PolicyDiscardResult,
  PolicyWriteResult,
  RoleOption,
  SimulationInput,
  SimulationOutcome,
  SimulationResult,
  SuggestedState,
  ToolInfo,
  UnplacedPolicy,
  UsePoliciesOptions,
} from './permissions-types.js';
export type { KnownPolicyMode, ModeOnTheWire } from './permissions-vocabulary.js';
export type {
  EffectiveBasis,
  EffectiveCell,
  EffectiveEntry,
  EffectiveRequest,
  EffectiveResult,
  EffectiveSnapshot,
  EffectiveStatus,
  EffectiveStore,
} from './permissions-effective.js';
export { EFFECTIVE_CONCURRENCY, effectiveCellKey } from './permissions-effective.js';
export { useEffectivePolicies } from './use-effective-policies.js';
export type { EffectivePoliciesController } from './use-effective-policies.js';

export {
  CONDITION_FIELDS,
  CONDITION_MODES,
  MODE_ON_THE_WIRE,
  POLICY_MODES,
  PROVISIONAL_MODES,
} from './permissions-vocabulary.js';
export { buildPermissionsMatrix, cellsGovernedBy } from './permissions-matrix.js';
export type { MatrixInput } from './permissions-matrix.js';
export { createPoliciesStore } from './permissions-store.js';
export { usePolicies } from './use-policies.js';
export { usePolicyEditor } from './use-policy-editor.js';
export { usePolicySimulate } from './use-policy-simulate.js';
export { Permissions } from './components/Permissions.js';
export type { PermissionsProps, SubjectSlotContext } from './components/Permissions.js';
export type { SubjectLabel } from './components/permissions-parts.js';
export { PolicyEditor } from './components/PolicyEditor.js';
export type { PolicyEditorProps } from './components/PolicyEditor.js';
export { PolicySimulation } from './components/PolicySimulation.js';
export type { PolicySimulationProps } from './components/PolicySimulation.js';
export { ModeLegend } from './components/ModeLegend.js';
export { EffectiveAccess } from './components/EffectiveAccess.js';
export { PolicyRoundTrip } from './components/PolicyRoundTrip.js';
export type {
  AgtVersion,
  CedarParser,
  CedarSource,
  ExportablePolicy,
  PolicyFormats,
  PolicyImporter,
  PolicyRoundTripProps,
  RoundTripChange,
  RoundTripExport,
  RoundTripImport,
  RoundTripReportEntry,
} from './components/PolicyRoundTrip.js';
export type { EffectiveAccessProps } from './components/EffectiveAccess.js';
export type { ModeLegendProps } from './components/ModeLegend.js';
export type { PermissionsLabelKey, PermissionsLabels } from './components/permissions-labels.js';
export type { ModuleComponents as PermissionsComponents } from './components/slots.js';
