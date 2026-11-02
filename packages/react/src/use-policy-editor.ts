/**
 * `usePolicyEditor`: binds the editor of one policy, held by the store behind `usePolicies`, to React with
 * `useSyncExternalStore`. The hook imports no CSS and no component. The editor reads the policy and its versions on
 * its first subscriber; it shares the store's capabilities, its read-only state and its list (to name the policy a 409
 * names).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type {
  PoliciesController,
  PolicyEditorController,
  PolicyEditorStore,
} from './permissions-types.js';

/** The editor of policy `id`: its versions, a working copy, save and publish. */
export function usePolicyEditor(policies: PoliciesController, id: string): PolicyEditorController {
  const { editor: editorOf, authoring } = policies;
  const editor: PolicyEditorStore = useMemo(() => editorOf(id), [editorOf, id]);
  const subscribe = useCallback((listener: () => void) => editor.subscribe(listener), [editor]);
  const getSnapshot = useCallback(() => editor.getSnapshot(), [editor]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const reload = useCallback(() => editor.reload(), [editor]);
  const edit = useCallback<PolicyEditorStore['edit']>(
    (patch) => {
      editor.edit(patch);
    },
    [editor]
  );
  const setMode = useCallback<PolicyEditorStore['setMode']>(
    (mode) => {
      editor.setMode(mode);
    },
    [editor]
  );
  const setCondition = useCallback<PolicyEditorStore['setCondition']>(
    (field, value) => {
      editor.setCondition(field, value);
    },
    [editor]
  );
  const save = useCallback(() => editor.save(), [editor]);
  const publish = useCallback(() => editor.publish(), [editor]);

  return useMemo(
    () => ({ ...snapshot, authoring, reload, edit, setMode, setCondition, save, publish }),
    [snapshot, authoring, reload, edit, setMode, setCondition, save, publish]
  );
}
