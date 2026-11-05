import { useId, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { FACT_TYPES, checkFactRows, factRowOfMember, factRowsOf } from '../connections-facts.js';
import type { FactField, FactRow, FactRowError } from '../connections-facts.js';
import { toolPendingKey } from '../connections-store.js';
import type {
  ConnectionToolInfo,
  ConnectionsController,
  ConnectionsError,
} from '../connections-types.js';
import type { ConnectionsTranslate } from './connections-labels.js';
import { ConnectionsErrorAlert } from './connections-parts.js';
import { escapeInvisible } from './format-json.js';
import { useNc } from './slots.js';

export interface ToolFactsEditorProps {
  readonly controller: ConnectionsController;
  readonly tool: ConnectionToolInfo;
  readonly t: ConnectionsTranslate;
  /** Called with the sentence that says the facts were saved. */
  readonly onSaved: (message: string) => void;
  readonly onCancel: () => void;
  readonly onSignIn?: (() => void) | undefined;
}

/** A row as the editor holds it: the text typed, and a key that stays with the row as others are added and removed. */
interface Draft extends FactRow {
  readonly key: number;
}

/** A refusal of the service that names a field of a row. */
interface Refusal {
  readonly key: number;
  readonly field: FactField;
  readonly detail: string | undefined;
}

/**
 * The fact bindings of one registered tool as a table of name, path, type and description. Saving sends the whole map
 * (it replaces the tool's facts); with no row left it removes them. Each row is checked before anything is sent, and
 * a 400 that names a row's member is shown at that row. Offer it only where the service advertises `tools.facts` and
 * the caller may change the tool's registration.
 */
export function ToolFactsEditor({
  controller,
  tool,
  t,
  onSaved,
  onCancel,
  onSignIn,
}: ToolFactsEditorProps) {
  const { Button, Input, Select } = useNc();
  const headingId = useId();
  const next = useRef(0);
  const draftOf = (row: FactRow): Draft => ({ ...row, key: next.current++ });
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => factRowsOf(tool.facts).map(draftOf));
  const [attempted, setAttempted] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  const [failure, setFailure] = useState<ConnectionsError | undefined>(undefined);
  const busy = controller.pending.has(toolPendingKey(tool.id));
  const toolName = escapeInvisible(tool.toolRef);

  const checked = checkFactRows(drafts);
  const errors: readonly FactRowError[] = attempted && !checked.ok ? checked.errors : [];
  const errorAt = (row: number, field: FactField): string | undefined => {
    const found = errors.find((error) => error.row === row && error.field === field);
    return found === undefined ? undefined : t(`factProblem_${found.problem}`);
  };

  const change = (key: number, patch: Partial<FactRow>): void => {
    setDrafts((held) => held.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    if (refusal?.key === key) setRefusal(undefined);
  };

  const save = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setAttempted(true);
    setFailure(undefined);
    setRefusal(undefined);
    if (!checked.ok) return;
    const had = Object.keys(tool.facts ?? {}).length > 0;
    if (drafts.length === 0 && !had) {
      onCancel();
      return;
    }
    const result = await controller.updateToolFacts(
      tool.id,
      drafts.length === 0 ? null : checked.facts
    );
    if (result.ok) {
      onSaved(t(drafts.length === 0 ? 'factsCleared' : 'factsSaved', { tool: toolName }));
      return;
    }
    const named =
      result.error.kind === 'invalid_request'
        ? factRowOfMember(result.error.member, drafts)
        : undefined;
    const row = named === undefined ? undefined : drafts[named.row];
    if (named !== undefined && row !== undefined)
      setRefusal({ key: row.key, field: named.field, detail: result.error.detail });
    else setFailure(result.error);
  };

  const errorProp = (text: string | undefined): { error?: string } =>
    text === undefined ? {} : { error: text };

  const refusedAt = (draft: Draft, field: FactField): string | undefined =>
    refusal?.key === draft.key && refusal.field === field
      ? t('factsRefused', { detail: escapeInvisible(refusal.detail ?? '') })
      : undefined;

  return (
    <section className="nc-conn-tool-facts" aria-labelledby={headingId}>
      <h5 id={headingId}>{t('toolFactsHeading', { tool: toolName })}</h5>
      <p className="nc-muted">{t('toolFactsNote')}</p>
      <form
        onSubmit={(event) => {
          void save(event);
        }}
      >
        {drafts.length === 0 ? (
          <p>{t('factsNone')}</p>
        ) : (
          <div className="nc-conn-scroll">
            <table className="nc-conn-table">
              <caption>{t('toolFactsCaption', { tool: toolName })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('factName')}</th>
                  <th scope="col">{t('factPath')}</th>
                  <th scope="col">{t('factType')}</th>
                  <th scope="col">{t('factDescription')}</th>
                  <td />
                </tr>
              </thead>
              <tbody>
                {drafts.map((draft, index) => {
                  const row = index + 1;
                  return (
                    <tr key={draft.key}>
                      <td>
                        <Input
                          variant="code"
                          aria-label={t('factNameOf', { row })}
                          value={draft.name}
                          {...errorProp(errorAt(index, 'name') ?? refusedAt(draft, 'name'))}
                          onChange={(event) => {
                            change(draft.key, { name: event.currentTarget.value });
                          }}
                        />
                      </td>
                      <td>
                        <Input
                          variant="code"
                          aria-label={t('factPathOf', { row })}
                          value={draft.path}
                          {...errorProp(errorAt(index, 'path') ?? refusedAt(draft, 'path'))}
                          onChange={(event) => {
                            change(draft.key, { path: event.currentTarget.value });
                          }}
                        />
                      </td>
                      <td>
                        <Select
                          aria-label={t('factTypeOf', { row })}
                          value={draft.type}
                          placeholder={t('factTypePlaceholder')}
                          options={FACT_TYPES.map((type) => ({
                            value: type,
                            label: t(`factType_${type}`),
                          }))}
                          onValueChange={(type) => {
                            change(draft.key, { type });
                          }}
                        />
                        {(errorAt(index, 'type') ?? refusedAt(draft, 'type')) ? (
                          <p role="alert" className="nc-field-error">
                            {errorAt(index, 'type') ?? refusedAt(draft, 'type')}
                          </p>
                        ) : null}
                      </td>
                      <td>
                        <Input
                          aria-label={t('factDescriptionOf', { row })}
                          value={draft.description}
                          {...errorProp(
                            errorAt(index, 'description') ?? refusedAt(draft, 'description')
                          )}
                          onChange={(event) => {
                            change(draft.key, { description: event.currentTarget.value });
                          }}
                        />
                      </td>
                      <td>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            setDrafts((held) => held.filter((held_) => held_.key !== draft.key));
                          }}
                        >
                          {t('factRemove', { row })}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {errors.length > 0 ? <p role="alert">{t('factsFixErrors')}</p> : null}
        {failure === undefined ? null : (
          <ConnectionsErrorAlert error={failure} t={t} context="admin" onSignIn={onSignIn} />
        )}
        <div className="nc-conn-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setDrafts((held) => [
                ...held,
                { key: next.current++, name: '', path: '', type: '', description: '' },
              ]);
            }}
          >
            {t('factAdd')}
          </Button>
          <Button type="submit" loading={busy} disabled={busy}>
            {busy ? t('factsSaving') : t('factsSave')}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('factsCancel')}
          </Button>
        </div>
      </form>
    </section>
  );
}
