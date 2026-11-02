import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import type {
  PermissionsError,
  PoliciesController,
  PolicyInfo,
  PolicySubject,
  PolicyWorkingCopy,
} from '../permissions-types.js';
import { POLICY_MODES, PROVISIONAL_MODES, takesConditions } from '../permissions-vocabulary.js';
import { MAY_BE_REFUSED } from './ModeLegend.js';
import { usePolicyEditor } from '../use-policy-editor.js';
import { escapeInvisible } from './format-json.js';
import { createPermissionsTranslate, modeKey } from './permissions-labels.js';
import type { PermissionsLabels, PermissionsTranslate } from './permissions-labels.js';
import {
  PermissionsErrorAlert,
  modeName,
  modeOptionLabel,
  permissionsErrorText,
  policyName,
  toolRefLabel,
  subjectTextWith,
} from './permissions-parts.js';
import type { SubjectLabel } from './permissions-parts.js';
import { useNc, WithComponents } from './slots.js';
import type { ModuleComponents } from './slots.js';

export interface PolicyEditorProps {
  /** What `usePolicies` returns. */
  readonly controller: PoliciesController;
  readonly policyId: string;
  readonly className?: string;
  readonly labels?: PermissionsLabels;
  readonly components?: ModuleComponents;
  /** Called with a policy id the editor links to (the policy a 409 names). */
  readonly onOpenPolicy?: (id: string) => void;
  readonly onSignIn?: () => void;
  /**
   * Called with the sentence that reports it once the policy is gone: retired, or a policy never published deleted
   * with its draft. The host closes the editor; without it the editor shows that the policy is not found.
   */
  readonly onRemoved?: (message: string) => void;
  /** As `PermissionsProps.subjectLabel` (`Permissions` passes its own to the editor it opens). */
  readonly subjectLabel?: SubjectLabel;
}

/** The fields a 422's `detail` can name, by the member it starts with. */
type Field =
  | 'name'
  | 'description'
  | 'subjects'
  | 'targets'
  | 'mode'
  | 'on_deny'
  | 'expires_after'
  | 'approver_groups'
  | 'kind';

/** The field a problem's `detail` names (`"config.mode: ..."` names the mode), or undefined. */
export function refusedField(error: PermissionsError | undefined): Field | undefined {
  if (error?.kind !== 'unprocessable' && error?.kind !== 'invalid_request') return undefined;
  const member = /^\s*([A-Za-z_][\w.[\]]*)\s*:/.exec(error.detail ?? '')?.[1];
  if (member === undefined) return undefined;
  const top = member.replace(/\[\d+\]/g, '').split('.');
  const head = top[0] === 'config' ? top[1] : top[0];
  const known: readonly Field[] = [
    'name',
    'description',
    'subjects',
    'targets',
    'mode',
    'on_deny',
    'expires_after',
    'approver_groups',
    'kind',
  ];
  return known.find((field) => field === head);
}

const SUBJECT_TYPES = ['role', 'organization', 'user', 'agent', 'service', 'group'] as const;

/**
 * The editor of one policy: its versions (draft or published, and who wrote each), and a working copy of the pending
 * draft (or of the published version) with its name, description, subjects, tools and mode; `on_deny`, approver groups
 * and expiry only for a mode that takes them. Save writes the draft; Publish publishes the draft it loaded or saved,
 * where publishing is offered. A refusal from the service is shown next to the member it names, verbatim, and the
 * draft is kept.
 */
export function PolicyEditor({ components, ...props }: PolicyEditorProps) {
  return (
    <WithComponents components={components}>
      <EditorView {...props} />
    </WithComponents>
  );
}

function EditorView({
  controller,
  policyId,
  className,
  labels,
  onOpenPolicy,
  onSignIn,
  onRemoved,
  subjectLabel,
}: Omit<PolicyEditorProps, 'components'>) {
  const t = createPermissionsTranslate(labels);
  const subjectText = subjectTextWith(t, subjectLabel);
  const { Badge, Button, Checkbox, ConfirmDialog, Input, Label, Select, Textarea } = useNc();
  const editor = usePolicyEditor(controller, policyId);
  /** The retire or the discard waiting for its confirm. */
  const [confirming, setConfirming] = useState<'retire' | 'discard' | undefined>(undefined);
  /** The failure of a retire or a discard, with the sentence that says which it was. */
  const [removal, setRemoval] = useState<
    { readonly error: PermissionsError; readonly context: string } | undefined
  >(undefined);
  const [notice, setNotice] = useState('');
  const ids = {
    heading: useId(),
    name: useId(),
    description: useId(),
    subjectType: useId(),
    subjectId: useId(),
    mode: useId(),
    onDeny: useId(),
    groups: useId(),
    expires: useId(),
  };
  const [subjectType, setSubjectType] = useState<string>('role');
  const [subjectId, setSubjectId] = useState('');
  const [groupsText, setGroupsText] = useState<string | undefined>(undefined);
  const rootClass = ['nc-root', 'nc-permissions-editor', className].filter(Boolean).join(' ');

  if (editor.status === 'loading')
    return (
      <section className={rootClass} aria-busy="true">
        <p>{t('editorLoading')}</p>
      </section>
    );
  if (editor.status === 'not_found')
    return (
      <section className={rootClass}>
        {/* A policy retired or deleted here says so; any other is simply not found. */}
        {notice === '' ? <p role="alert">{t('editorNotFound')}</p> : <p role="status">{notice}</p>}
      </section>
    );
  if (editor.status === 'error' && editor.current === undefined)
    return (
      <section className={rootClass}>
        {editor.error === undefined ? null : (
          <PermissionsErrorAlert error={editor.error} t={t} onSignIn={onSignIn} />
        )}
        <Button type="button" variant="secondary" onClick={() => void editor.reload()}>
          {t('reload')}
        </Button>
      </section>
    );

  const working = editor.working;
  const readOnly = editor.authoring.readOnly || working === undefined;
  const config = working?.config ?? {};
  const mode = typeof config.mode === 'string' ? config.mode : undefined;
  // A refusal is shown next to the member it names only when that member is on screen; otherwise at the top, so
  // a refusal is never left unshown (a `kind`, or a condition the current mode hides).
  const shownFields: readonly Field[] = [
    'name',
    'description',
    'subjects',
    'targets',
    'mode',
    ...(mode !== undefined && takesConditions(mode)
      ? (['on_deny', 'approver_groups', 'expires_after'] as const)
      : []),
  ];
  const named = refusedField(editor.error);
  const refused = named !== undefined && shownFields.includes(named) ? named : undefined;
  const fieldError = (field: Field): ReactNode =>
    refused === field && editor.error !== undefined ? (
      <p className="nc-perm-refused" role="alert">
        {permissionsErrorText(editor.error, t, 'write')}
      </p>
    ) : null;
  const name = policyName(editor.current ?? { id: policyId }, t);
  const workingLabel =
    editor.workingFrom === undefined
      ? undefined
      : editor.workingFrom.state === 'draft'
        ? t('versionDraft', { version: editor.workingFrom.version })
        : t('versionPublished', {
            version: editor.workingFrom.version,
            date: escapeInvisible(editor.current?.publishedAt ?? ''),
          });
  const edit = (patch: Partial<Omit<PolicyWorkingCopy, 'kind' | 'config'>>): void => {
    editor.edit(patch);
  };
  // Retire takes a published policy out of force; discard deletes a pending draft, or a policy never published.
  const canRetire = editor.authoring.canRetire;
  const neverPublished = editor.current?.state === 'draft';
  const offerRetire = canRetire && editor.current?.state === 'published';
  const offerDiscard = canRetire && (editor.pendingDraft !== undefined || neverPublished);
  const removing = controller.busy.has(policyId);
  const draftVersion = editor.pendingDraft?.version ?? editor.current?.version ?? 0;
  /** The policy is gone: the host closes the editor, or, without `onRemoved`, the editor says so in its place. */
  const gone = (sentence: string): void => {
    if (onRemoved === undefined) setNotice(sentence);
    else onRemoved(sentence);
  };
  const remove = async (): Promise<void> => {
    setRemoval(undefined);
    setNotice('');
    if (confirming === 'retire') {
      const r = await controller.retire(policyId);
      if (!r.ok) setRemoval({ error: r.error, context: t('retireErrorContext', { name }) });
      else gone(t('retired', { name }));
      return;
    }
    // Only the draft the editor shows: one rewritten since is refused (`draft_changed`), and the editor reloads it.
    const r = await controller.discardDraft(policyId, editor.pendingDraft);
    if (!r.ok) {
      setRemoval({ error: r.error, context: t('discardErrorContext', { name }) });
      return;
    }
    if (r.deleted) {
      gone(t('discardedNeverPublished', { name }));
      return;
    }
    // The store reads the policy again for this editor: the published version, without the draft.
    setGroupsText(undefined);
    setNotice(t('discarded', { name }));
  };
  const subjects = working?.subjects ?? [];
  const targets = working?.targets ?? 'all';
  // What the service says it cannot enforce now, for the version the working copy came from.
  const unenforced = (editor.pendingDraft ?? editor.current)?.unenforcedTargets ?? [];
  const groups = Array.isArray(config.approver_groups)
    ? (config.approver_groups as unknown[]).filter((g): g is string => typeof g === 'string')
    : [];

  const candidate: PolicySubject =
    subjectType === 'organization'
      ? { type: subjectType }
      : { type: subjectType, id: subjectId.trim() };
  // The Add control is offered only for a subject it would add: an id where one is needed, and not one listed.
  const canAdd =
    (subjectType === 'organization' || candidate.id !== '') &&
    !subjects.some((s) => s.type === candidate.type && s.id === candidate.id);
  const addSubject = (): void => {
    if (!canAdd) return;
    edit({ subjects: [...subjects, candidate] });
    setSubjectId('');
  };

  return (
    <section className={rootClass} aria-labelledby={ids.heading}>
      <h3 id={ids.heading}>{t('editorHeading', { name })}</h3>
      {workingLabel === undefined ? null : (
        <p>
          <Badge variant={editor.workingFrom?.state === 'draft' ? 'warning' : 'neutral'}>
            {workingLabel}
          </Badge>
        </p>
      )}
      {editor.authoring.readOnly ? <p className="nc-muted">{t('readOnlyEditor')}</p> : null}
      {editor.notes.includes('targets_not_stated') ? <p>{t('noteTargetsNotStated')}</p> : null}
      {editor.stale ? (
        <div role="alert" className="nc-perm-note">
          <p>{t('stale')}</p>
        </div>
      ) : null}
      {editor.error !== undefined && refused === undefined ? (
        <PermissionsErrorAlert
          error={editor.error}
          t={t}
          context="write"
          onSignIn={onSignIn}
          onOpenPolicy={onOpenPolicy}
          nameOf={(id) =>
            id === editor.conflict?.policyId
              ? editor.conflict.name
              : controller.policies.find((p) => p.id === id)?.name
          }
        />
      ) : null}
      {editor.lastPublished === undefined ? null : (
        <p role="status">{t('published', { version: editor.lastPublished.version })}</p>
      )}
      {removal === undefined ? null : (
        <PermissionsErrorAlert error={removal.error} t={t} context="write" onSignIn={onSignIn}>
          <p>{removal.context}</p>
        </PermissionsErrorAlert>
      )}
      {notice === '' ? null : <p role="status">{notice}</p>}

      <form
        className="nc-perm-form"
        onSubmit={(event) => {
          event.preventDefault();
          void editor.save();
        }}
      >
        <Label htmlFor={ids.name}>{t('fieldName')}</Label>
        <Input
          id={ids.name}
          value={working?.name ?? ''}
          readOnly={readOnly}
          onChange={(event) => {
            edit({ name: event.currentTarget.value });
          }}
        />
        {fieldError('name')}
        <Label htmlFor={ids.description}>{t('fieldDescription')}</Label>
        <Textarea
          id={ids.description}
          value={working?.description ?? ''}
          readOnly={readOnly}
          onChange={(event) => {
            edit({ description: event.currentTarget.value });
          }}
        />
        {fieldError('description')}

        <fieldset>
          <legend>{t('fieldSubjects')}</legend>
          <ul className="nc-perm-list">
            {subjects.map((subject) => {
              const text = subjectText(subject);
              return (
                <li key={`${subject.type}:${subject.id ?? ''}`}>
                  {text}
                  {readOnly || subjects.length < 2 ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        edit({ subjects: subjects.filter((s) => s !== subject) });
                      }}
                    >
                      {t('subjectRemove', { subject: text })}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {readOnly ? null : (
            <div className="nc-perm-row">
              <Label htmlFor={ids.subjectType}>{t('fieldSubjectType')}</Label>
              <Select
                id={ids.subjectType}
                value={subjectType}
                onValueChange={setSubjectType}
                options={SUBJECT_TYPES.map((type) => ({
                  value: type,
                  label: t(`subjectType_${type}`),
                }))}
              />
              {subjectType === 'organization' ? null : (
                <>
                  <Label htmlFor={ids.subjectId}>{t('fieldSubjectId')}</Label>
                  <Input
                    id={ids.subjectId}
                    value={subjectId}
                    onChange={(event) => {
                      setSubjectId(event.currentTarget.value);
                    }}
                  />
                </>
              )}
              <Button type="button" variant="secondary" disabled={!canAdd} onClick={addSubject}>
                {t('subjectAdd')}
              </Button>
            </div>
          )}
          {fieldError('subjects')}
        </fieldset>

        <fieldset>
          <legend>{t('fieldTargets')}</legend>
          <Label>
            <Checkbox
              checked={targets === 'all'}
              // Leaving "every tool" needs a tool to name: the contract takes 1 to 100 targets.
              disabled={
                readOnly ||
                (targets === 'all' && !controller.tools.some((tool) => tool.status === 'active'))
              }
              onChange={(event) => {
                edit({
                  targets: event.currentTarget.checked
                    ? 'all'
                    : controller.tools
                        .filter((tool) => tool.status === 'active')
                        .slice(0, 1)
                        .map((tool) => tool.toolRef),
                });
              }}
            />{' '}
            {t('targetsAll')}
          </Label>
          {targets === 'all' ? null : (
            <ul className="nc-perm-list">
              {[
                // A withdrawn tool is not offered as a new target; one the policy already names stays listed.
                ...new Set([
                  ...controller.tools
                    .filter((tool) => tool.status === 'active')
                    .map((tool) => tool.toolRef),
                  ...targets,
                ]),
              ].map((ref) => (
                <li key={ref}>
                  <Label>
                    <Checkbox
                      checked={targets.includes(ref)}
                      disabled={readOnly || (targets.length === 1 && targets.includes(ref))}
                      onChange={(event) => {
                        const on = event.currentTarget.checked;
                        edit({
                          targets: on ? [...targets, ref] : targets.filter((r) => r !== ref),
                        });
                      }}
                    />{' '}
                    {toolRefLabel(ref, controller.tools, t)}
                  </Label>
                </li>
              ))}
            </ul>
          )}
          {unenforced.length === 0 ? null : (
            <div className="nc-perm-note">
              <ul className="nc-perm-list">
                {unenforced.map((ref) => (
                  <li key={ref}>{t('unenforcedTarget', { tool: escapeInvisible(ref) })}</li>
                ))}
              </ul>
            </div>
          )}
          {fieldError('targets')}
        </fieldset>

        <Label htmlFor={ids.mode}>{t('fieldMode')}</Label>
        <Select
          id={ids.mode}
          value={mode ?? ''}
          disabled={readOnly}
          onValueChange={(value) => {
            setGroupsText(undefined);
            editor.setMode(value);
          }}
          options={[
            ...(mode === undefined || (POLICY_MODES as readonly string[]).includes(mode)
              ? []
              : [{ value: mode, label: modeName(mode, t) }]),
            ...POLICY_MODES.map((m) => ({ value: m, label: modeOptionLabel(m, t) })),
          ]}
        />
        {mode === undefined ? null : <ModeHint mode={mode} t={t} />}
        {fieldError('mode')}
        {editor.notes.includes('conditions_cleared') ? (
          <p className="nc-perm-note" role="status">
            {t('noteConditionsCleared')}
          </p>
        ) : null}

        {mode !== undefined && takesConditions(mode) ? (
          <fieldset>
            <Label htmlFor={ids.onDeny}>{t('fieldOnDeny')}</Label>
            <Select
              id={ids.onDeny}
              disabled={readOnly}
              value={typeof config.on_deny === 'string' ? config.on_deny : ''}
              onValueChange={(value) => {
                editor.setCondition('on_deny', value === '' ? undefined : value);
              }}
              options={[
                { value: '', label: t('onDenyNotStated') },
                { value: 'resume', label: t('onDenyResume') },
                { value: 'halt', label: t('onDenyHalt') },
              ]}
            />
            {fieldError('on_deny')}
            <Label htmlFor={ids.groups}>{t('fieldApproverGroups')}</Label>
            <Input
              id={ids.groups}
              readOnly={readOnly}
              value={groupsText ?? groups.join(', ')}
              onBlur={() => {
                // While typing, the text is kept as typed; after, the field shows what will be saved.
                setGroupsText(undefined);
              }}
              onChange={(event) => {
                const text = event.currentTarget.value;
                setGroupsText(text);
                const list = text
                  .split(',')
                  .map((g) => g.trim())
                  .filter((g) => g !== '');
                editor.setCondition('approver_groups', list.length === 0 ? undefined : list);
              }}
            />
            <p className="nc-muted">
              {groups.length === 0
                ? t('approverGroupsNone')
                : t('approverGroupsSentence', {
                    groups: groups.map((g) => escapeInvisible(g)).join(', '),
                  })}
            </p>
            {fieldError('approver_groups')}
            <Label htmlFor={ids.expires}>{t('fieldExpiresAfter')}</Label>
            <Input
              id={ids.expires}
              readOnly={readOnly}
              value={typeof config.expires_after === 'string' ? config.expires_after : ''}
              onChange={(event) => {
                const value = event.currentTarget.value;
                editor.setCondition('expires_after', value === '' ? undefined : value);
              }}
            />
            {fieldError('expires_after')}
          </fieldset>
        ) : null}

        {editor.authoring.readOnly || canRetire ? null : (
          <p className="nc-muted">{t('noRemove')}</p>
        )}
        <div className="nc-perm-actions">
          {readOnly ? null : (
            <Button
              type="submit"
              disabled={!editor.dirty || editor.saving || editor.stale}
              loading={editor.saving}
            >
              {editor.saving ? t('saving') : t('save')}
            </Button>
          )}
          {editor.authoring.canPublish && editor.pendingDraft !== undefined ? (
            <Button
              type="button"
              variant="secondary"
              disabled={editor.dirty || editor.publishing || editor.stale}
              onClick={() => void editor.publish()}
            >
              {editor.publishing ? t('publishing') : t('publish')}
            </Button>
          ) : null}
          {offerDiscard ? (
            <Button
              type="button"
              variant="secondary"
              disabled={removing}
              onClick={() => {
                setConfirming('discard');
              }}
            >
              {t('discardDraft')}
            </Button>
          ) : null}
          {offerRetire ? (
            <Button
              type="button"
              variant="destructive"
              disabled={removing}
              onClick={() => {
                setConfirming('retire');
              }}
            >
              {t('retire')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setGroupsText(undefined);
              void editor.reload();
            }}
          >
            {t('reload')}
          </Button>
        </div>
        {editor.dirty && editor.authoring.canPublish ? (
          <p className="nc-muted">{t('unsaved')}</p>
        ) : null}
      </form>

      <VersionList versions={editor.versions} t={t} />
      <ConfirmDialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        title={
          confirming === 'retire'
            ? t('retireTitle', { name })
            : neverPublished
              ? t('discardNeverPublishedTitle', { name })
              : t('discardTitle', { name, version: draftVersion })
        }
        description={
          confirming === 'retire'
            ? t('retireText')
            : neverPublished
              ? t('discardNeverPublishedText')
              : t('discardText')
        }
        confirmLabel={confirming === 'retire' ? t('retireConfirm') : t('discardConfirm')}
        cancelLabel={confirming === 'retire' ? t('retireCancel') : t('discardCancel')}
        variant="destructive"
        onConfirm={remove}
      />
    </section>
  );
}

function ModeHint({ mode, t }: { readonly mode: string; readonly t: PermissionsTranslate }) {
  const key = modeKey('modeSentence_', mode);
  if (key === undefined) return null;
  return (
    <>
      <p className="nc-muted">{t(key)}</p>
      {(PROVISIONAL_MODES as readonly string[]).includes(mode) ? (
        <p className="nc-muted">{t('modeProvisional')}</p>
      ) : null}
      {MAY_BE_REFUSED.includes(mode) ? <p className="nc-muted">{t('modeMayBeRefused')}</p> : null}
    </>
  );
}

function VersionList({
  versions,
  t,
}: {
  readonly versions: readonly PolicyInfo[];
  readonly t: PermissionsTranslate;
}) {
  return (
    <>
      <h4>{t('editorVersions')}</h4>
      <ol className="nc-perm-list">
        {versions.map((v) => (
          <li key={`${String(v.version)}:${v.state}`}>
            {v.state === 'draft'
              ? t('versionDraft', { version: v.version })
              : t('versionPublished', {
                  version: v.version,
                  date: escapeInvisible(v.publishedAt ?? ''),
                })}
            {v.updatedBy === undefined
              ? null
              : ` · ${t('versionBy', {
                  kind: escapeInvisible(v.updatedBy.kind),
                  id: escapeInvisible(v.updatedBy.id),
                })}`}
          </li>
        ))}
      </ol>
    </>
  );
}
