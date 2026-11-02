import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cellsGovernedBy, isSoleCell } from '../permissions-matrix.js';
import type {
  CellPolicy,
  DraftEntry,
  MatrixCell,
  MatrixColumn,
  OtherSubjectEntry,
  PermissionsError,
  PermissionsMatrix,
  PoliciesController,
  PolicyInfo,
  PolicySubject,
  ToolInfo,
} from '../permissions-types.js';
import { POLICY_MODES } from '../permissions-vocabulary.js';
import { useEffectivePolicies } from '../use-effective-policies.js';
import { RenderBoundary } from './boundary.js';
import { EffectiveBody } from './EffectiveAccess.js';
import { escapeInvisible } from './format-json.js';
import { ModeLegendBody } from './ModeLegend.js';
import { createPermissionsTranslate } from './permissions-labels.js';
import type { PermissionsLabels, PermissionsTranslate } from './permissions-labels.js';
import {
  PermissionsErrorAlert,
  modeName,
  modeOptionLabel,
  permissionsErrorText,
  policyName,
  subjectTextWith,
} from './permissions-parts.js';
import type { SubjectLabel } from './permissions-parts.js';
import { PolicyEditor } from './PolicyEditor.js';
import { PolicyRoundTrip } from './PolicyRoundTrip.js';
import type { PolicyRoundTripProps } from './PolicyRoundTrip.js';
import { PolicySimulation } from './PolicySimulation.js';
import { useNc, WithComponents } from './slots.js';
import type { ModuleComponents } from './slots.js';

export interface PermissionsProps {
  /** What `usePolicies` returns. */
  readonly controller: PoliciesController;
  readonly className?: string;
  /** Replaces any of the components' strings. A value may hold `{name}` placeholders, as the default does. */
  readonly labels?: PermissionsLabels;
  /** Replaces any primitive by role (`Button`, `Select`, `Alert`, …), over any `NcProvider` around it. */
  readonly components?: ModuleComponents;
  /** Rendered in the header after the module's own controls (the import/export surface fills it). */
  readonly actions?: ReactNode;
  /** Called by "Sign in again" when the session has expired. */
  readonly onSignIn?: () => void;
  /**
   * Shows the import/export panel (`PolicyRoundTrip`) under the header, with the converter the host loads (`formats`):
   * export always, import where `loadImporter` is given. Absent, there is no panel. A saved import opens in this
   * component's editor.
   */
  readonly roundTrip?: Pick<
    PolicyRoundTripProps,
    'formats' | 'loadImporter' | 'cedar' | 'toolNames'
  >;
  /**
   * Host-supplied subject UI: rendered in the panel of policies for users, agents and groups, under its list, with
   * the controller, that panel's entries and a way to open a policy in this component's editor. The module renders
   * nothing of its own there; what the host renders authors through the controller like any other caller.
   */
  readonly renderSubjects?: (context: SubjectSlotContext) => ReactNode;
  /**
   * A display name for a subject, from the host (for example its directory), shown beside the subject's type and id,
   * never instead of them, in the panel of other subjects, the Suggested panel, the editor and the dry run (not the
   * effective view, whose subjects are the table's roles and the organisation). Return `undefined` for none.
   */
  readonly subjectLabel?: SubjectLabel;
}

/** What `renderSubjects` is given. */
export interface SubjectSlotContext {
  readonly controller: PoliciesController;
  /** The policies the panel lists: each with a subject that is not a role or the organisation. */
  readonly entries: readonly OtherSubjectEntry[];
  /** Opens a policy in the component's editor and dry run. */
  readonly openPolicy: (id: string) => void;
}

/**
 * The role × tool table of tool policies, and around it the policies it cannot place in a cell, the drafts, the
 * policies of other kinds and, when read, the suggested ones; an open policy shows its editor and a dry run.
 *
 * A cell shows the published policy that governs the pair, which the contract makes unique, with its mode, name,
 * version and author; or "No policy" and that the deployment's default applies. A cell never shows what a person
 * holding the role actually gets; the "Effective access" view does, for an administrator, through a dry run as each
 * role, and names what set a cell only where the service advertises how policies compose. With `roundTrip` it shows
 * the import/export panel. Everything it may do comes from the controller (the service's capabilities); nothing names a
 * kind of deployment.
 */
export function Permissions({ components, ...props }: PermissionsProps) {
  return (
    <WithComponents components={components}>
      <PermissionsView {...props} />
    </WithComponents>
  );
}

/** A write's failure, with the sentence that says which write it was. */
interface CellError {
  readonly context: string;
  readonly error: PermissionsError;
}

/** The value of a cell's choice that retires the policy governing it (never a mode). */
const RETIRE_CHOICE = 'nc:retire';

/** A retire or a discard started from the table or the Drafts tray, waiting for its confirm. */
type Removal =
  | { readonly kind: 'retire'; readonly policyId: string; readonly name: string }
  | {
      readonly kind: 'discard';
      readonly policyId: string;
      readonly name: string;
      readonly version: number;
      /** Whether the tray showed it as never published (the title); the answer decides what happened. */
      readonly neverPublished: boolean;
      /** The draft the tray showed: another one found pending is not discarded. */
      readonly shown: PolicyInfo;
    };

function PermissionsView({
  controller,
  className,
  labels,
  actions,
  onSignIn,
  roundTrip,
  renderSubjects,
  subjectLabel,
}: Omit<PermissionsProps, 'components'>) {
  const t = createPermissionsTranslate(labels);
  const subjectText = subjectTextWith(t, subjectLabel);
  const { Button, ConfirmDialog, EmptyState } = useNc();
  const headingId = useId();
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [removal, setRemoval] = useState<Removal | undefined>(undefined);
  const [message, setMessage] = useState('');
  const [cellError, setCellError] = useState<CellError | undefined>(undefined);
  /** Counts the outcomes the table reports (cell writes and tray publishes); only the latest one reports. */
  const attempt = useRef(0);
  /** The authored policies, or what a holder of each role would get (sends nothing until shown). */
  const [view, setView] = useState<'authored' | 'effective'>('authored');
  const effective = useEffectivePolicies(controller);
  const rootClass = ['nc-root', 'nc-permissions', className].filter(Boolean).join(' ');

  const header = (
    <header className="nc-perm-header">
      <h2 id={headingId}>{t('heading')}</h2>
      {actions === undefined ? null : <div className="nc-perm-header-actions">{actions}</div>}
    </header>
  );

  if (controller.status === 'idle' || controller.status === 'loading')
    return (
      <section className={rootClass} aria-labelledby={headingId} aria-busy="true">
        {header}
        <p>{t('loading')}</p>
      </section>
    );
  if (controller.status === 'unavailable')
    return (
      <section className={rootClass} aria-labelledby={headingId}>
        {header}
        <EmptyState title={t('unavailableTitle')} description={t('unavailableText')} />
      </section>
    );
  if (controller.status === 'error' || controller.matrix === undefined)
    return (
      <section className={rootClass} aria-labelledby={headingId}>
        {header}
        {controller.error === undefined ? (
          <p role="alert">{t('loadFailed')}</p>
        ) : (
          <PermissionsErrorAlert error={controller.error} t={t} onSignIn={onSignIn} />
        )}
        <Button type="button" variant="secondary" onClick={() => void controller.refresh()}>
          {t('retry')}
        </Button>
      </section>
    );

  const matrix = controller.matrix;
  const highlighted = new Set(
    openId === undefined
      ? []
      : cellsGovernedBy(matrix, openId).map((c) => `${c.columnKey}|${c.toolRef}`)
  );
  const open = (id: string): void => {
    setOpenId(id);
  };
  const nameOf = (id: string): string | undefined =>
    controller.policies.find((p) => p.id === id)?.name ??
    controller.drafts.find((d) => d.policyId === id)?.name;

  const setCell = async (column: MatrixColumn, toolRef: string, mode: string): Promise<void> => {
    attempt.current += 1;
    const mine = attempt.current;
    setCellError(undefined);
    // A new attempt clears the last outcome. A success, or an opened editor, is reported only by the latest attempt,
    // so an earlier write's success never sits beside a later one's error; a failure is always reported.
    setMessage('');
    const subject = columnText(column, t);
    // The name on the wire is the role's own label and the tool reference as they are, within the contract's 200.
    const wireSubject =
      column.subject.type === 'organization' ? t('organisationColumn') : column.label;
    const result = await controller.setCell(column.subject, toolRef, mode, {
      // Cut by code point, never inside a character.
      name: Array.from(t('cellPolicyName', { subject: wireSubject, tool: toolRef }))
        .slice(0, 200)
        .join(''),
    });
    if (result.kind !== 'error' && mine !== attempt.current) return;
    if (result.kind === 'written') {
      setMessage(
        t('cellWritten', {
          version: result.policy.version,
          subject,
          tool: escapeInvisible(toolRef),
        })
      );
      return;
    }
    if (result.kind === 'open_editor') {
      open(result.policyId);
      const listed = controller.policies.find((p) => p.id === result.policyId);
      const name = policyName(listed ?? { id: result.policyId }, t);
      // A policy that governs only this cell was opened because it has a draft the table does not show.
      setMessage(
        listed !== undefined && isSoleCell(listed)
          ? t('cellOpenedDraft', { name })
          : t('cellOpenedEditor', { name })
      );
      return;
    }
    setCellError({
      context: t('cellErrorContext', { subject, tool: escapeInvisible(toolRef) }),
      error: result.error,
    });
  };

  /** Retires or discards what the confirm names, and reports it as the table reports a write. */
  const remove = async (what: Removal): Promise<void> => {
    attempt.current += 1;
    const mine = attempt.current;
    setCellError(undefined);
    setMessage('');
    const r =
      what.kind === 'retire'
        ? await controller.retire(what.policyId)
        : await controller.discardDraft(what.policyId, what.shown);
    if (!r.ok) {
      setCellError({
        context:
          what.kind === 'retire'
            ? t('retireErrorContext', { name: what.name })
            : t('discardErrorContext', { name: what.name }),
        error: r.error,
      });
      return;
    }
    // A policy that is gone has no editor to show; the service's answer says whether a discard deleted it.
    const deleted = 'deleted' in r && r.deleted;
    const gone = what.kind === 'retire' || deleted;
    if (gone) setOpenId((id) => (id === what.policyId ? undefined : id));
    if (mine !== attempt.current) return;
    setMessage(
      what.kind === 'retire'
        ? t('retired', { name: what.name })
        : deleted
          ? t('discardedNeverPublished', { name: what.name })
          : t('discarded', { name: what.name })
    );
  };

  // The effective view is offered unless the host or a refused write says the user is not an administrator.
  const effectiveOffered = effective.status !== 'not_offered' && effective.status !== 'off';
  const switcher = effectiveOffered ? (
    <div className="nc-perm-view" role="group" aria-label={t('viewSwitch')}>
      <Button
        type="button"
        variant={view === 'authored' ? 'primary' : 'secondary'}
        aria-pressed={view === 'authored'}
        onClick={() => {
          setView('authored');
        }}
      >
        {t('viewAuthored')}
      </Button>
      <Button
        type="button"
        variant={view === 'effective' ? 'primary' : 'secondary'}
        aria-pressed={view === 'effective'}
        onClick={() => {
          setView('effective');
        }}
      >
        {t('viewEffective')}
      </Button>
    </div>
  ) : null;
  if (view === 'effective' && effectiveOffered)
    return (
      <section className={rootClass} aria-labelledby={headingId}>
        {header}
        {switcher}
        <RenderBoundary>
          <EffectiveBody controller={controller} effective={effective} t={t} onSignIn={onSignIn} />
        </RenderBoundary>
        <ModeLegendBody {...(labels === undefined ? {} : { labels })} />
      </section>
    );

  return (
    <section className={rootClass} aria-labelledby={headingId}>
      {header}
      {switcher}
      {roundTrip === undefined ? null : (
        <RenderBoundary>
          <PolicyRoundTrip
            controller={controller}
            {...roundTrip}
            onOpenPolicy={open}
            {...(labels === undefined ? {} : { labels })}
            {...(onSignIn === undefined ? {} : { onSignIn })}
          />
        </RenderBoundary>
      )}
      <AuthoringNote controller={controller} t={t} />
      {controller.error === undefined ? null : (
        <PermissionsErrorAlert error={controller.error} t={t} onSignIn={onSignIn}>
          <p>{t('staleLists')}</p>
        </PermissionsErrorAlert>
      )}
      {controller.sideErrors.roles === undefined ? null : (
        <p className="nc-muted" role="status">
          {t('directoryError')} {permissionsErrorText(controller.sideErrors.roles, t)}
        </p>
      )}
      {controller.sideErrors.connections === undefined ? null : (
        <p className="nc-muted" role="status">
          {t('connectionsError')} {permissionsErrorText(controller.sideErrors.connections, t)}
        </p>
      )}
      {cellError === undefined ? null : (
        <PermissionsErrorAlert
          error={cellError.error}
          t={t}
          context="write"
          onSignIn={onSignIn}
          onOpenPolicy={open}
          nameOf={nameOf}
        >
          <p>{cellError.context}</p>
        </PermissionsErrorAlert>
      )}
      <RenderBoundary>
        <MatrixTable
          matrix={matrix}
          controller={controller}
          highlighted={highlighted}
          t={t}
          onSet={(column, toolRef, mode) => void setCell(column, toolRef, mode)}
          onOpen={open}
          onRetire={(policy) => {
            setRemoval({ kind: 'retire', policyId: policy.policyId, name: policyName(policy, t) });
          }}
        />
      </RenderBoundary>
      <OtherSubjects
        matrix={matrix}
        t={t}
        subjectText={subjectText}
        onOpen={open}
        slot={
          renderSubjects === undefined ? undefined : (
            <RenderBoundary>
              {renderSubjects({ controller, entries: matrix.otherSubjects, openPolicy: open })}
            </RenderBoundary>
          )
        }
      />
      <Unplaced matrix={matrix} t={t} onOpen={open} />
      <Drafts
        controller={controller}
        t={t}
        onOpen={open}
        onStart={() => {
          attempt.current += 1;
          setCellError(undefined);
          setMessage('');
          return attempt.current;
        }}
        onPublished={(policy, mine) => {
          if (mine === attempt.current) setMessage(t('published', { version: policy.version }));
        }}
        onError={(error, name) => {
          // A failure is always reported, whichever attempt it belongs to.
          setCellError({ context: t('draftErrorContext', { name }), error });
        }}
        onDiscard={(draft) => {
          setRemoval({
            kind: 'discard',
            policyId: draft.policyId,
            name: policyName(draft.policy, t),
            version: draft.version,
            neverPublished: draft.neverPublished,
            shown: draft.policy,
          });
        }}
      />
      <OtherPolicies controller={controller} t={t} />
      <Suggested controller={controller} t={t} subjectText={subjectText} />
      {openId === undefined ? null : (
        <div className="nc-perm-open">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setOpenId(undefined);
            }}
          >
            {t('closePolicy')}
          </Button>
          <RenderBoundary key={openId}>
            <PolicyEditor
              controller={controller}
              policyId={openId}
              {...(labels === undefined ? {} : { labels })}
              {...(onSignIn === undefined ? {} : { onSignIn })}
              onOpenPolicy={open}
              onRemoved={(sentence) => {
                setOpenId(undefined);
                setMessage(sentence);
              }}
              {...(subjectLabel === undefined ? {} : { subjectLabel })}
            />
            <PolicySimulation
              controller={controller}
              policyId={openId}
              {...(labels === undefined ? {} : { labels })}
              {...(onSignIn === undefined ? {} : { onSignIn })}
              {...(subjectLabel === undefined ? {} : { subjectLabel })}
            />
          </RenderBoundary>
        </div>
      )}
      <ModeLegendBody {...(labels === undefined ? {} : { labels })} />
      <ConfirmDialog
        open={removal !== undefined}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRemoval(undefined);
        }}
        title={
          removal === undefined
            ? ''
            : removal.kind === 'retire'
              ? t('retireTitle', { name: removal.name })
              : removal.neverPublished
                ? t('discardNeverPublishedTitle', { name: removal.name })
                : t('discardTitle', { name: removal.name, version: removal.version })
        }
        description={
          removal === undefined
            ? ''
            : removal.kind === 'retire'
              ? t('retireText')
              : removal.neverPublished
                ? t('discardNeverPublishedText')
                : t('discardText')
        }
        confirmLabel={removal?.kind === 'retire' ? t('retireConfirm') : t('discardConfirm')}
        cancelLabel={removal?.kind === 'retire' ? t('retireCancel') : t('discardCancel')}
        variant="destructive"
        onConfirm={async () => {
          if (removal !== undefined) await remove(removal);
        }}
      />
      <div role="status" className="nc-live">
        <p>{message}</p>
      </div>
    </section>
  );
}

function columnText(column: MatrixColumn, t: PermissionsTranslate): string {
  return column.subject.type === 'organization'
    ? t('organisationColumn')
    : escapeInvisible(column.label);
}

function AuthoringNote({
  controller,
  t,
}: {
  readonly controller: PoliciesController;
  readonly t: PermissionsTranslate;
}) {
  const reason = controller.authoring.reason;
  if (reason === undefined) return null;
  const text =
    reason === 'not_offered'
      ? t('readOnlyNotOffered')
      : reason === 'host'
        ? t('readOnlyHost')
        : t('readOnlyForbidden');
  return (
    <p className="nc-perm-note" role="status">
      {text}
    </p>
  );
}

function MatrixTable({
  matrix,
  controller,
  highlighted,
  t,
  onSet,
  onOpen,
  onRetire,
}: {
  readonly matrix: PermissionsMatrix;
  readonly controller: PoliciesController;
  readonly highlighted: ReadonlySet<string>;
  readonly t: PermissionsTranslate;
  readonly onSet: (column: MatrixColumn, toolRef: string, mode: string) => void;
  readonly onOpen: (id: string) => void;
  readonly onRetire: (policy: CellPolicy) => void;
}) {
  if (matrix.groups.length === 0) return <p>{t('noTools')}</p>;
  const columns = matrix.columns;
  return (
    <div className="nc-perm-scroll">
      <table className="nc-perm-table nc-perm-matrix">
        <caption>{t('matrixCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('toolColumn')}</th>
            {columns.map((column) => (
              <th scope="col" key={column.key}>
                {columnText(column, t)}
              </th>
            ))}
          </tr>
        </thead>
        {matrix.groups.map((group) => (
          <tbody key={group.connectionId ?? ''}>
            <tr>
              <th scope="colgroup" colSpan={columns.length + 1} className="nc-perm-group">
                {group.connectionId === null
                  ? t('registeredTools')
                  : group.name !== undefined
                    ? escapeInvisible(group.name)
                    : t('connectionId', { id: escapeInvisible(group.connectionId) })}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr
                key={row.tool.toolRef}
                data-status={row.tool.statusKnown ? row.tool.status : 'unknown'}
              >
                <th scope="row">
                  <code>{escapeInvisible(row.tool.toolRef)}</code>
                  <ToolStatus tool={row.tool} t={t} />
                </th>
                {row.cells.map((cell, index) => {
                  const column = columns[index];
                  if (column === undefined) return null;
                  return (
                    <Cell
                      key={cell.columnKey}
                      cell={cell}
                      withdrawn={row.tool.status !== 'active'}
                      column={column}
                      controller={controller}
                      highlighted={highlighted.has(`${cell.columnKey}|${cell.toolRef}`)}
                      t={t}
                      onSet={onSet}
                      onOpen={onOpen}
                      onRetire={onRetire}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** A tool's status beside its reference: "Withdrawn", or a status the module does not know as sent. */
function ToolStatus({ tool, t }: { readonly tool: ToolInfo; readonly t: PermissionsTranslate }) {
  const { Badge } = useNc();
  if (tool.status === 'withdrawn')
    return (
      <>
        {' '}
        <Badge variant="warning">{t('toolWithdrawn')}</Badge>
        <span className="nc-perm-meta">{t('toolWithdrawnNote')}</span>
      </>
    );
  if (tool.statusKnown) return null;
  return (
    <>
      {' '}
      <Badge variant="outline">
        {t('toolStatusUnknown', { status: escapeInvisible(tool.status) })}
      </Badge>
      <span className="nc-perm-meta">{t('toolStatusUnknownNote')}</span>
    </>
  );
}

function PolicyLine({
  policy,
  t,
}: {
  readonly policy: CellPolicy;
  readonly t: PermissionsTranslate;
}) {
  const { Badge } = useNc();
  return (
    <>
      <span className="nc-perm-mode" data-mode-known={policy.modeKnown}>
        {modeName(policy.mode, t)}
      </span>
      <span className="nc-perm-meta">
        {policyName(policy, t)} · {t('cellVersion', { version: policy.version })}
        {policy.updatedBy === undefined
          ? null
          : ` · ${t('cellUpdatedBy', {
              kind: escapeInvisible(policy.updatedBy.kind),
              id: escapeInvisible(policy.updatedBy.id),
            })}`}
      </span>
      {policy.source === 'suggested' || policy.source === 'imported' ? (
        <Badge variant="outline">
          {policy.source === 'suggested' ? t('sourceSuggested') : t('sourceImported')}
        </Badge>
      ) : null}
    </>
  );
}

function Cell({
  cell,
  withdrawn,
  column,
  controller,
  highlighted,
  t,
  onSet,
  onOpen,
  onRetire,
}: {
  readonly cell: MatrixCell;
  /** The row's tool is not callable (withdrawn, or an unknown status): the cell shows its policy and writes nothing. */
  readonly withdrawn: boolean;
  readonly column: MatrixColumn;
  readonly controller: PoliciesController;
  readonly highlighted: boolean;
  readonly t: PermissionsTranslate;
  readonly onSet: (column: MatrixColumn, toolRef: string, mode: string) => void;
  readonly onOpen: (id: string) => void;
  /** Asks to retire the policy governing the cell, where retiring is offered: back to no policy. */
  readonly onRetire: (policy: CellPolicy) => void;
}) {
  const { Badge, Button, Select } = useNc();
  // The editor's words follow authoring; a withdrawn cell is read-only, and its policy is still edited in the editor.
  const authoringOff = controller.authoring.readOnly;
  const readOnly = authoringOff || withdrawn;
  const subject = columnText(column, t);
  const tool = escapeInvisible(cell.toolRef);
  const current = cell.state === 'governed' ? modeName(cell.policy.mode, t) : t('cellNoPolicy');
  const busy =
    controller.busy.has('new') ||
    (cell.state === 'governed' && controller.busy.has(cell.policy.policyId));

  let body: ReactNode;
  let control: ReactNode = null;
  if (cell.state === 'governed') {
    body = <PolicyLine policy={cell.policy} t={t} />;
    // A policy that governs several pairs is edited as a whole; so is any policy on a withdrawn tool, whose cell writes
    // nothing.
    if (!cell.policy.soleCell || withdrawn)
      control = (
        <Button
          type="button"
          variant="link"
          // The cell's name first, as every cell control has it, then the visible words (so speech input finds it).
          aria-label={t('cellOpensPolicy', {
            control: t('cellControl', { mode: current, subject, tool }),
            action: t(authoringOff ? 'cellOpenPolicy' : 'cellEditPolicy', {
              name: policyName(cell.policy, t),
            }),
          })}
          onClick={() => {
            onOpen(cell.policy.policyId);
          }}
        >
          {t(authoringOff ? 'cellOpenPolicy' : 'cellEditPolicy', {
            name: policyName(cell.policy, t),
          })}
        </Button>
      );
  } else if (cell.state === 'none') {
    body = (
      <>
        <span className="nc-perm-mode">{t('cellNoPolicy')}</span>
        <span className="nc-perm-meta">{t('cellDefault')}</span>
      </>
    );
  } else {
    body = (
      <span className="nc-perm-conflict">
        {t('cellConflict', { names: cell.policies.map((p) => policyName(p, t)).join(', ') })}
      </span>
    );
  }
  const editable =
    !readOnly && (cell.state === 'none' || (cell.state === 'governed' && cell.policy.soleCell));
  if (editable)
    control = (
      <Select
        aria-label={t('cellControl', { mode: current, subject, tool })}
        value={cell.state === 'governed' && cell.policy.modeKnown ? (cell.policy.mode ?? '') : ''}
        disabled={busy}
        onValueChange={(value) => {
          if (value === RETIRE_CHOICE) {
            if (cell.state === 'governed') onRetire(cell.policy);
          } else if (value !== '') onSet(column, cell.toolRef, value);
        }}
        options={[
          ...(cell.state === 'governed' && cell.policy.modeKnown
            ? []
            : [{ value: '', label: t('cellSet') }]),
          ...POLICY_MODES.map((mode) => ({ value: mode, label: modeOptionLabel(mode, t) })),
          // The policy governs this cell alone: retiring it returns the cell to no policy.
          ...(cell.state === 'governed' && controller.authoring.canRetire
            ? [{ value: RETIRE_CHOICE, label: t('cellRetire') }]
            : []),
        ]}
      />
    );
  else if (cell.state !== 'governed' || (cell.policy.soleCell && !withdrawn))
    // Read-only, or a conflict: the cell still names its state for a screen reader.
    control = (
      <span className="nc-perm-sr">{t('cellControl', { mode: current, subject, tool })}</span>
    );

  return (
    <td data-state={cell.state} data-highlighted={highlighted ? 'true' : undefined}>
      {body}
      {cell.pending.map((p) => (
        <Badge key={`${p.policyId}:${String(p.version)}`} variant="warning">
          {t('cellPending', { version: p.version })}
        </Badge>
      ))}
      {highlighted ? <span className="nc-perm-meta">{t('highlighted')}</span> : null}
      {control}
    </td>
  );
}

function OtherSubjects({
  matrix,
  t,
  onOpen,
  slot,
  subjectText,
}: {
  readonly matrix: PermissionsMatrix;
  readonly t: PermissionsTranslate;
  readonly onOpen: (id: string) => void;
  /** The host's subject UI, rendered under the list. */
  readonly slot: ReactNode;
  readonly subjectText: (subject: PolicySubject) => string;
}) {
  const { Button } = useNc();
  return (
    <section className="nc-perm-panel">
      <h3>{t('otherSubjectsHeading')}</h3>
      {matrix.otherSubjects.length === 0 ? (
        <p className="nc-muted">{t('otherSubjectsEmpty')}</p>
      ) : (
        <ul className="nc-perm-list">
          {matrix.otherSubjects.map((entry) => (
            <li key={`${entry.policy.id}:${entry.subject.type}:${entry.subject.id ?? ''}`}>
              {subjectText(entry.subject)} · {modeName(entry.policy.mode, t)} ·{' '}
              <Button
                type="button"
                variant="link"
                onClick={() => {
                  onOpen(entry.policy.id);
                }}
              >
                {t('draftOpen', { name: policyName(entry.policy, t) })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {slot === undefined ? null : <div className="nc-perm-host-subjects">{slot}</div>}
    </section>
  );
}

function Unplaced({
  matrix,
  t,
  onOpen,
}: {
  readonly matrix: PermissionsMatrix;
  readonly t: PermissionsTranslate;
  readonly onOpen: (id: string) => void;
}) {
  const { Button } = useNc();
  if (matrix.unplaced.length === 0) return null;
  return (
    <section className="nc-perm-panel">
      <h3>{t('unplacedHeading')}</h3>
      <ul className="nc-perm-list">
        {matrix.unplaced.map((entry) => (
          <li key={`${entry.policy.id}:${String(entry.policy.version)}:${entry.reason}`}>
            {entry.reason === 'target_not_listed'
              ? t('unplacedNotListed', {
                  name: policyName(entry.policy, t),
                  mode: modeName(entry.policy.mode, t),
                  tools: entry.toolRefs.map((ref) => escapeInvisible(ref)).join(', '),
                })
              : entry.reason === 'targets_not_stated'
                ? t('unplacedTargets', { name: policyName(entry.policy, t) })
                : t('unplacedState', { name: policyName(entry.policy, t) })}{' '}
            <Button
              type="button"
              variant="link"
              onClick={() => {
                onOpen(entry.policy.id);
              }}
            >
              {t('draftOpen', { name: policyName(entry.policy, t) })}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Drafts({
  controller,
  t,
  onOpen,
  onStart,
  onPublished,
  onError,
  onDiscard,
}: {
  readonly controller: PoliciesController;
  readonly t: PermissionsTranslate;
  readonly onOpen: (id: string) => void;
  /** Asks to discard a draft, where discarding is offered. */
  readonly onDiscard: (draft: DraftEntry) => void;
  /** Starts an attempt and returns its number, which the outcome carries back. */
  readonly onStart: () => number;
  readonly onPublished: (policy: PolicyInfo, attempt: number) => void;
  readonly onError: (error: PermissionsError, name: string, attempt: number) => void;
}) {
  const { Button } = useNc();
  return (
    <section className="nc-perm-panel">
      <h3>{t('draftsHeading')}</h3>
      {controller.drafts.length === 0 ? (
        <p className="nc-muted">{t('draftsEmpty')}</p>
      ) : (
        <ul className="nc-perm-list">
          {controller.drafts.map((draft) => {
            const name = policyName(draft.policy, t);
            return (
              <li key={draft.policyId}>
                {t('draftLabel', { name, version: draft.version })}{' '}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    onOpen(draft.policyId);
                  }}
                >
                  {t('draftSimulate', { name })}
                </Button>
                {controller.authoring.canPublish ? (
                  <Button
                    type="button"
                    disabled={controller.busy.has(draft.policyId)}
                    onClick={() => {
                      const mine = onStart();
                      // The tray publishes the stored draft: not while its editor holds unsaved changes, which the
                      // editor's own Publish refuses too.
                      if (controller.editor(draft.policyId).getSnapshot().dirty) {
                        onError(
                          {
                            kind: 'precondition',
                            code: 'unsaved_changes',
                            title: 'unsaved changes',
                            local: true,
                          },
                          name,
                          mine
                        );
                        return;
                      }
                      void controller.publish(draft.policyId, draft.policy).then((result) => {
                        if (result.ok) onPublished(result.policy, mine);
                        else onError(result.error, name, mine);
                      });
                    }}
                  >
                    {t('draftPublish', { name })}
                  </Button>
                ) : null}
                {controller.authoring.canRetire ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={controller.busy.has(draft.policyId)}
                    onClick={() => {
                      onDiscard(draft);
                    }}
                  >
                    {t('discardDraftNamed', { name })}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function OtherPolicies({
  controller,
  t,
}: {
  readonly controller: PoliciesController;
  readonly t: PermissionsTranslate;
}) {
  const others = controller.others;
  return (
    <section className="nc-perm-panel">
      <h3>{t('otherPoliciesHeading')}</h3>
      {others.status === 'error' ? (
        <p role="status">
          {t('otherPoliciesError')}{' '}
          {others.error === undefined ? '' : permissionsErrorText(others.error, t)}
        </p>
      ) : others.status !== 'ready' ? (
        <p aria-busy="true">{t('loading')}</p>
      ) : others.policies.length === 0 ? (
        <p className="nc-muted">{t('otherPoliciesEmpty')}</p>
      ) : (
        <ul className="nc-perm-list">
          {others.policies.map(({ policy, view }) => (
            <li key={policy.id}>
              <strong>{policyName(policy, t)}</strong> ·{' '}
              {view.kind === 'duplicate_requests' ? (
                <>
                  {view.afterRejection === 'ask_again'
                    ? t('duplicateAskAgain')
                    : t('duplicateDeny')}
                  {view.windowSeconds === undefined
                    ? ''
                    : ` ${t('duplicateWindow', { seconds: view.windowSeconds })}`}
                  {view.maxReasks === undefined
                    ? ''
                    : ` ${t('duplicateMaxReasks', { count: view.maxReasks })}`}
                </>
              ) : (
                <>
                  {t('cannotEvaluate', { kind: escapeInvisible(policy.kind) })}
                  <pre className="nc-perm-json">
                    {escapeInvisible(JSON.stringify(policy.config, null, 2))}
                  </pre>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Suggested({
  controller,
  t,
  subjectText,
}: {
  readonly controller: PoliciesController;
  readonly t: PermissionsTranslate;
  readonly subjectText: (subject: PolicySubject) => string;
}) {
  const { Badge } = useNc();
  const suggested = controller.suggested;
  if (suggested.status === 'off' || suggested.status === 'hidden') return null;
  return (
    <section className="nc-perm-panel">
      <h3>{t('suggestedHeading')}</h3>
      {suggested.status === 'loading' ? (
        <p aria-busy="true">{t('loading')}</p>
      ) : suggested.status === 'error' ? (
        <p role="status">{t('suggestedError')}</p>
      ) : suggested.policies.length === 0 ? (
        <p className="nc-muted">{t('suggestedEmpty')}</p>
      ) : (
        <ul className="nc-perm-list">
          {suggested.policies.map((policy) => (
            <li key={policy.id}>
              <strong>{policyName(policy, t)}</strong> · {modeName(policy.mode, t)} ·{' '}
              {policy.subjects.map((s) => subjectText(s)).join(', ')}{' '}
              <Badge variant="outline">{t('sourceSuggested')}</Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
