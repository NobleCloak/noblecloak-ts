import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

import { effectiveCellKey } from '../permissions-effective.js';
import type { EffectiveCell, EffectiveEntry, EffectiveRequest } from '../permissions-effective.js';
import type { MatrixColumn, PermissionsMatrix, PoliciesController } from '../permissions-types.js';
import { useEffectivePolicies } from '../use-effective-policies.js';
import type { EffectivePoliciesController } from '../use-effective-policies.js';
import { escapeInvisible } from './format-json.js';
import { createPermissionsTranslate } from './permissions-labels.js';
import type { PermissionsLabels, PermissionsTranslate } from './permissions-labels.js';
import {
  PermissionsErrorAlert,
  permissionsErrorText,
  policyName,
  subjectText,
} from './permissions-parts.js';
import { useNc, WithComponents } from './slots.js';
import type { ModuleComponents } from './slots.js';

export interface EffectiveAccessProps {
  /** What `usePolicies` returns. */
  readonly controller: PoliciesController;
  readonly className?: string;
  readonly labels?: PermissionsLabels;
  readonly components?: ModuleComponents;
  readonly onSignIn?: () => void;
}

/**
 * What a holder of each role, or of the organisation alone, would get on each tool: a dry run per cell as that subject,
 * which only an administrator may run. It shows the decision and, where the service advertises how it composes, which
 * entries set it; otherwise what matched, with no claim about which entry decided. Cells are computed for the rows on
 * screen, a few at a time.
 */
export function EffectiveAccess({ components, ...props }: EffectiveAccessProps) {
  return (
    <WithComponents components={components}>
      <EffectiveView {...props} />
    </WithComponents>
  );
}

function EffectiveView({
  controller,
  className,
  labels,
  onSignIn,
}: Omit<EffectiveAccessProps, 'components'>) {
  const t = createPermissionsTranslate(labels);
  const effective = useEffectivePolicies(controller);
  const rootClass = ['nc-root', 'nc-permissions-effective', className].filter(Boolean).join(' ');
  return (
    <section className={rootClass}>
      <EffectiveBody controller={controller} effective={effective} t={t} onSignIn={onSignIn} />
    </section>
  );
}

/** The effective view inside the `Permissions` component, which holds the controller of the view. */
export function EffectiveBody({
  controller,
  effective,
  t,
  onSignIn,
}: {
  readonly controller: PoliciesController;
  readonly effective: EffectivePoliciesController;
  readonly t: PermissionsTranslate;
  readonly onSignIn?: (() => void) | undefined;
}) {
  const { Button, Label, Select } = useNc();
  const basisId = useId();
  const matrix = controller.matrix;
  const drafts = controller.drafts;
  // A draft basis whose draft is gone (published, or no longer known) falls back to the published policies.
  const basis = effective.basis;
  const draftGone =
    basis.kind === 'draft' &&
    !drafts.some((d) => d.policyId === basis.policyId && d.version === basis.version);
  const { setBasis } = effective;
  useEffect(() => {
    if (draftGone) setBasis({ kind: 'published' });
  }, [draftGone, setBasis]);
  switch (effective.status) {
    case 'off':
      return <p aria-busy="true">{t('loading')}</p>;
    case 'not_offered':
    case 'not_permitted':
      return <p className="nc-perm-note">{t('effectiveAdminsOnly')}</p>;
    case 'paused':
      return (
        <>
          {effective.error === undefined ? null : (
            <PermissionsErrorAlert error={effective.error} t={t} onSignIn={onSignIn} />
          )}
          <Button type="button" variant="secondary" onClick={effective.retry}>
            {t('retry')}
          </Button>
        </>
      );
    default:
      break;
  }
  const basisValue =
    effective.basis.kind === 'published'
      ? 'published'
      : `draft:${String(effective.basis.version)}:${effective.basis.policyId}`;
  const basisSelect =
    drafts.length === 0 ? null : (
      <div className="nc-perm-row">
        <Label htmlFor={basisId}>{t('effectiveBasis')}</Label>
        <Select
          id={basisId}
          value={basisValue}
          onValueChange={(value) => {
            if (value === 'published') {
              effective.setBasis({ kind: 'published' });
              return;
            }
            const draft = drafts.find((d) => `draft:${String(d.version)}:${d.policyId}` === value);
            if (draft !== undefined)
              effective.setBasis({
                kind: 'draft',
                policyId: draft.policyId,
                version: draft.version,
              });
          }}
          options={[
            { value: 'published', label: t('effectiveBasisPublished') },
            ...drafts.map((d) => ({
              value: `draft:${String(d.version)}:${d.policyId}`,
              label: t('effectiveBasisDraft', {
                name: policyName(d.policy, t),
                version: d.version,
              }),
            })),
          ]}
        />
      </div>
    );
  if (effective.status === 'no_anchor' || matrix === undefined)
    return (
      <>
        {basisSelect}
        <p className="nc-perm-note">{t('effectiveNoAnchor')}</p>
      </>
    );
  return (
    <>
      {basisSelect}
      <EffectiveTable matrix={matrix} effective={effective} t={t} />
    </>
  );
}

function EffectiveTable({
  matrix,
  effective,
  t,
}: {
  readonly matrix: PermissionsMatrix;
  readonly effective: EffectivePoliciesController;
  readonly t: PermissionsTranslate;
}) {
  const columns = matrix.columns;
  const rows = matrix.groups.flatMap((g) => g.rows);
  const tableRef = useRef<HTMLTableElement | null>(null);
  /** The tools of the rows on screen. */
  const visible = useRef(new Set<string>());
  const { request } = effective;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const ask = (toolRefs: Iterable<string>): void => {
    const cells: EffectiveRequest[] = [];
    for (const toolRef of toolRefs)
      for (const column of columnsRef.current)
        cells.push({ columnKey: column.key, subject: column.subject, toolRef });
    if (cells.length > 0) request(cells);
  };
  const askRef = useRef(ask);
  askRef.current = ask;

  // Rows are asked for as they come on screen; without IntersectionObserver every row is.
  const rowKey = rows.map((r) => r.tool.toolRef).join('\n');
  useEffect(() => {
    const table = tableRef.current;
    if (table === null) return undefined;
    const trs = [...table.querySelectorAll<HTMLTableRowElement>('tr[data-tool]')];
    // The rows changed: only those the observer reports from now on are on screen.
    visible.current = new Set();
    if (typeof IntersectionObserver === 'undefined') {
      visible.current = new Set(trs.map((tr) => tr.dataset.tool ?? ''));
      askRef.current(visible.current);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      const shown: string[] = [];
      for (const entry of entries) {
        const tool = (entry.target as HTMLElement).dataset.tool ?? '';
        if (entry.isIntersecting) {
          visible.current.add(tool);
          shown.push(tool);
        } else visible.current.delete(tool);
      }
      askRef.current(shown);
    });
    for (const tr of trs) observer.observe(tr);
    return () => {
      observer.disconnect();
    };
  }, [rowKey]);

  // A new round (another basis, or the published policies changed) asks again for the rows on screen.
  const columnKey = columns.map((c) => c.key).join('\n');
  useEffect(() => {
    askRef.current(visible.current);
  }, [effective.round, effective.status, columnKey]);

  return (
    <div className="nc-perm-scroll">
      <table ref={tableRef} className="nc-perm-table nc-perm-matrix nc-perm-effective">
        <caption>
          {effective.composition ? t('effectiveCaptionComposed') : t('effectiveCaption')}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('toolColumn')}</th>
            {columns.map((column) => (
              <th scope="col" key={column.key}>
                {columnLabel(column, t)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.tool.toolRef} data-tool={row.tool.toolRef}>
              <th scope="row">
                <code>{escapeInvisible(row.tool.toolRef)}</code>
              </th>
              {columns.map((column) => (
                <EffectiveCellView
                  key={column.key}
                  cell={effective.cells.get(effectiveCellKey(column.key, row.tool.toolRef))}
                  composition={effective.composition}
                  t={t}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function columnLabel(column: MatrixColumn, t: PermissionsTranslate): string {
  return column.subject.type === 'organization'
    ? t('organisationColumn')
    : escapeInvisible(column.label);
}

/** An entry as text: its subject and policy, or the deployment's default. */
function entryText(entry: EffectiveEntry, t: PermissionsTranslate): string {
  const kind = entry.kind === 'tool_invocation' ? '' : ` (${escapeInvisible(entry.kind)})`;
  if (entry.policyId === null)
    return `${t('simDefaultEntry', { source: escapeInvisible(entry.source ?? '') })}${kind}`;
  const policy = t('effectivePolicy', {
    name: policyName({ name: entry.name, id: entry.policyId }, t),
    version: entry.version ?? '',
  });
  const subject = entry.subject === undefined ? '' : `${subjectText(entry.subject, t)} · `;
  return `${subject}${policy}${kind}`;
}

function EffectiveCellView({
  cell,
  composition,
  t,
}: {
  readonly cell: EffectiveCell | undefined;
  readonly composition: boolean;
  readonly t: PermissionsTranslate;
}) {
  let body: ReactNode;
  if (cell === undefined || cell.state === 'loading')
    return (
      <td data-state="loading" aria-busy="true">
        <span className="nc-perm-meta">{t('effectiveLoading')}</span>
      </td>
    );
  if (cell.state === 'unsupported')
    body = <span className="nc-perm-meta">{t('effectiveUnsupported')}</span>;
  else if (cell.state === 'error')
    body = (
      <span className="nc-perm-meta">
        {t('effectiveError')} {permissionsErrorText(cell.error, t)}
      </span>
    );
  else {
    const r = cell.result;
    const decision =
      r.reason === undefined
        ? t('effectiveDecision', { decision: escapeInvisible(r.decision) })
        : t('effectiveDecisionReason', {
            decision: escapeInvisible(r.decision),
            reason: escapeInvisible(r.reason),
          });
    const setBy = composition ? r.setBy : undefined;
    body = (
      <>
        <span className="nc-perm-mode">{decision}</span>
        {setBy !== undefined ? (
          setBy.length === 0 ? (
            <span className="nc-perm-meta">{t('effectiveSetByNone')}</span>
          ) : (
            <span className="nc-perm-meta">
              {t('effectiveSetBy', { entries: setBy.map((e) => entryText(e, t)).join('; ') })}
            </span>
          )
        ) : (
          <span className="nc-perm-meta">
            {r.matched.length === 0
              ? t('effectiveMatchedNone')
              : t('effectiveMatched', {
                  entries: r.matched
                    .map((e) => `${entryText(e, t)} → ${escapeInvisible(e.result)}`)
                    .join('; '),
                })}
          </span>
        )}
      </>
    );
  }
  return <td data-state={cell.state}>{body}</td>;
}
