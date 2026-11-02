import type { components } from '@noblecloak/client';
import { useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import {
  contentOf,
  exportableOf,
  matchOf,
  refusedMembers,
  workingCopyOf,
} from '../permissions-roundtrip.js';
import type { PolicyContent } from '../permissions-roundtrip.js';
import type { PermissionsError, PoliciesController, PolicyInfo } from '../permissions-types.js';
import { escapeInvisible } from './format-json.js';
import { createPermissionsTranslate } from './permissions-labels.js';
import type { PermissionsLabels, PermissionsTranslate } from './permissions-labels.js';
import { precondition } from '../permissions-errors.js';
import { PermissionsErrorAlert, policyName } from './permissions-parts.js';
import { useNc, WithComponents } from './slots.js';
import type { ModuleComponents } from './slots.js';

/*
 * The converter is `@noblecloak/policy-formats`, which this package does not depend on: the host passes it in, so an
 * app without the panel never bundles or installs it, and only one that imports files loads its importer and the Cedar
 * parser. The types below are the parts of its API the panel uses, as it declares them.
 */

/** One thing a conversion could not carry: a JSON pointer, the reason, and the policy key when there is one. */
export interface RoundTripReportEntry {
  readonly path: string;
  readonly reason: string;
  readonly policy?: string;
}

/** What an export returns: the file (opening with a comment block that states what it lost) and that report. */
export interface RoundTripExport {
  readonly text: string;
  readonly lossy: readonly RoundTripReportEntry[];
  readonly unsupported: readonly RoundTripReportEntry[];
  readonly notes: readonly string[];
}

/** What an import returns. */
export interface RoundTripImport {
  readonly policies: readonly { readonly key?: string; readonly write: unknown }[];
  readonly unsupported: readonly RoundTripReportEntry[];
  readonly lossy: readonly RoundTripReportEntry[];
  readonly conflicts: readonly RoundTripReportEntry[];
  readonly notes: readonly string[];
  /** The file's format and the lowercase hex SHA-256 of its bytes. */
  readonly origin: { readonly format: 'agt' | 'cedar'; readonly digest: string };
}

/** One difference between two policies' canonical forms. */
export interface RoundTripChange {
  readonly path: string;
  readonly op: 'add' | 'remove' | 'replace';
  readonly before?: unknown;
  readonly after?: unknown;
}

/** The AGT release an export targets. */
export type AgtVersion = '5.0' | 'main';

/** The root entry of `@noblecloak/policy-formats`, as the panel uses it. */
export interface PolicyFormats {
  // Function-typed members, so a change to the converter's parameters fails a host's build where it passes the module.
  readonly exportCedar: (policies: readonly ExportablePolicy[]) => RoundTripExport;
  readonly exportAgt: (
    policies: readonly ExportablePolicy[],
    tools: readonly { readonly tool_ref: string }[],
    opts: { agtVersion: AgtVersion; toolNames?: Readonly<Record<string, string>> }
  ) => RoundTripExport;
  readonly detectFormat: (text: string) => 'agt' | 'cedar' | undefined;
  /** A comment line made safe: line breaks, bidirectional and invisible code points written as visible escapes. */
  readonly commentSafe: (line: string) => string;
  readonly diffPolicies: (
    current: components['schemas']['PolicyWrite'] | undefined,
    incoming: components['schemas']['PolicyWrite']
  ) => readonly RoundTripChange[];
}

/** A policy as the converter takes it: the contract's `PolicyWrite` and the policy's id. */
export type ExportablePolicy = components['schemas']['PolicyWrite'] & { readonly id: string };

/** The part of `@cedar-policy/cedar-wasm` an import uses, as the converter declares it. */
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

/** The Cedar parser an import uses, or a function that loads it. */
export type CedarSource = CedarParser | (() => Promise<CedarParser>);

/** `@noblecloak/policy-formats/import`, as the panel uses it. */
export interface PolicyImporter {
  readonly importCedar: (
    input: Uint8Array,
    opts: { cedar?: CedarSource }
  ) => Promise<RoundTripImport>;
  readonly importAgt: (
    input: Uint8Array,
    opts: { cedar?: CedarSource; toolNames?: Readonly<Record<string, string>> }
  ) => Promise<RoundTripImport>;
}

export interface PolicyRoundTripProps {
  /** What `usePolicies` returns. */
  readonly controller: PoliciesController;
  /** Loads the converter, the root entry of `@noblecloak/policy-formats` (a dynamic import), on the first export or import. */
  readonly formats: () => Promise<PolicyFormats>;
  /**
   * Loads the importer, the entry `@noblecloak/policy-formats/import` (a dynamic import), which loads the Cedar parser
   * (`@cedar-policy/cedar-wasm`, an optional peer of about 4.4 MB) on the first import. Absent, the panel exports only.
   */
  readonly loadImporter?: () => Promise<PolicyImporter>;
  /** The Cedar parser, or its loader, passed to the importer (a browser build of the parser, for example). */
  readonly cedar?: CedarSource;
  /** AGT tool names by `tool_ref`, for an AGT export and read back on an AGT import. */
  readonly toolNames?: Readonly<Record<string, string>>;
  /** Opens a policy (its editor, dry run and publish); the `Permissions` component passes its own. */
  readonly onOpenPolicy?: (id: string) => void;
  readonly className?: string;
  readonly labels?: PermissionsLabels;
  readonly components?: ModuleComponents;
  readonly onSignIn?: () => void;
}

/** One incoming policy of an import: what it is matched to, what it changes, and its save. */
interface ImportItem {
  readonly index: number;
  readonly key?: string;
  readonly content: PolicyContent;
  /** The organisation's policy it updates, by its policy key; absent for a new policy. */
  readonly match?: PolicyInfo;
  /** The version it is compared with: the pending draft when there is one, else the published version. */
  readonly current?: PolicyInfo;
  /** Why the current version could not be read. */
  readonly readError?: PermissionsError;
  readonly changes: readonly RoundTripChange[];
  /** The members the service's advertised policy forms do not take. */
  readonly refused: readonly string[];
  readonly save:
    | { readonly status: 'idle' }
    | { readonly status: 'saving' }
    | { readonly status: 'saved'; readonly policy: PolicyInfo }
    | { readonly status: 'error'; readonly error: PermissionsError };
}

type ImportState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'reading' }
  | { readonly phase: 'failed'; readonly message: string }
  | {
      readonly phase: 'ready';
      readonly format: 'agt' | 'cedar';
      readonly result: RoundTripImport;
      readonly items: readonly ImportItem[];
    };

type Prepared =
  | { readonly phase: 'idle' }
  | { readonly phase: 'preparing' }
  | { readonly phase: 'failed'; readonly message: string }
  | { readonly phase: 'ready'; readonly result: RoundTripExport; readonly filename: string };

/**
 * Import and export of the organisation's tool policies as Cedar or as an AGT manifest. Export writes the file with its
 * report (what the format does not carry) shown first and written at the top of the file. Import, where the host
 * passes an importer, reads a file, shows its report, matches each policy to the organisation's by its policy key and
 * shows what it would change, and saves a change as a draft (recording where it came from), which the policy's editor
 * then runs and publishes. Without authoring, an import is shown and nothing is saved.
 */
export function PolicyRoundTrip({ components, ...props }: PolicyRoundTripProps) {
  return (
    <WithComponents components={components}>
      <RoundTripView {...props} />
    </WithComponents>
  );
}

function RoundTripView({
  controller,
  formats,
  loadImporter,
  cedar,
  toolNames,
  onOpenPolicy,
  className,
  labels,
  onSignIn,
}: Omit<PolicyRoundTripProps, 'components'>) {
  const t = createPermissionsTranslate(labels);
  const rootClass = ['nc-root', 'nc-permissions-roundtrip', className].filter(Boolean).join(' ');
  if (controller.status !== 'ready') return null;
  return (
    <section className={rootClass}>
      <ExportPanel controller={controller} formats={formats} toolNames={toolNames} t={t} />
      {loadImporter === undefined ? null : (
        <ImportPanel
          controller={controller}
          formats={formats}
          loadImporter={loadImporter}
          cedar={cedar}
          toolNames={toolNames}
          onOpenPolicy={onOpenPolicy}
          onSignIn={onSignIn}
          t={t}
        />
      )}
    </section>
  );
}

/**
 * The module keeps open values (a subject type, a kind) as strings; the converter takes the contract's closed types and
 * reports what it cannot carry, so the content is handed over as it was read.
 */
const asWrite = (content: unknown): components['schemas']['PolicyWrite'] =>
  content as components['schemas']['PolicyWrite'];

/**
 * `text` with `lines` added at the end of the comment block the converter opens every file with (before the blank line
 * that closes it), so the file still opens with its own report, which an import recognises as such.
 */
function withHeaderLines(
  text: string,
  marker: string,
  lines: readonly string[],
  commentSafe: (line: string) => string
): string {
  // The converter's own rule for a comment line: no line break, no bidirectional or invisible code point.
  const added = lines.map((line) => `${marker} ${commentSafe(line)}\n`).join('');
  const end = text.indexOf('\n\n');
  return end === -1 ? `${text}${added}` : `${text.slice(0, end + 1)}${added}${text.slice(end + 1)}`;
}

const describeFault = (fault: unknown): string =>
  escapeInvisible(fault instanceof Error ? fault.message : String(fault));

/** Saves `text` as a file through a Blob; nothing else is needed. */
function download(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
  // Revoked once the browser has surely taken the file: some cancel a download whose URL is revoked at once.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

function ExportPanel({
  controller,
  formats,
  toolNames,
  t,
}: {
  readonly controller: PoliciesController;
  readonly formats: () => Promise<PolicyFormats>;
  readonly toolNames: Readonly<Record<string, string>> | undefined;
  readonly t: PermissionsTranslate;
}) {
  const { Button, Label, Select } = useNc();
  const ids = { format: useId(), scope: useId(), version: useId(), agt: useId(), heading: useId() };
  const [format, setFormat] = useState<'cedar' | 'agt'>('cedar');
  const [scope, setScope] = useState<string>('all');
  const [version, setVersion] = useState<'published' | 'draft'>('published');
  const [agtVersion, setAgtVersion] = useState<AgtVersion>('5.0');
  const [prepared, setPrepared] = useState<Prepared>({ phase: 'idle' });
  const attempt = useRef(0);

  const published = controller.policies.filter((p) => p.state === 'published');
  const unpublished = controller.policies.length - published.length;
  const single = format === 'cedar' && scope !== 'all' ? scope : undefined;
  const singleListed =
    single === undefined ? undefined : controller.policies.find((p) => p.id === single);
  // A draft of the chosen policy that the service or this page knows of.
  const draftKnown =
    singleListed?.state === 'published' &&
    (singleListed.draftVersion !== undefined ||
      controller.drafts.some((d) => d.policyId === singleListed.id));
  const reset = (): void => {
    attempt.current += 1;
    setPrepared({ phase: 'idle' });
  };

  const prepare = async (): Promise<void> => {
    attempt.current += 1;
    const mine = attempt.current;
    setPrepared({ phase: 'preparing' });
    try {
      const lib = await formats();
      let chosen: PolicyInfo[];
      if (single !== undefined) {
        const listed = singleListed;
        if (listed === undefined) throw new Error(t('exportNotListed'));
        if (version === 'draft' && draftKnown) {
          const latest = await controller.latest(listed.id);
          if (!latest.ok) throw new Error(t('exportDraftUnread'));
          chosen = [latest.policy];
        } else chosen = [listed];
      } else chosen = published;
      const exportable = chosen.flatMap((p) => {
        const e = exportableOf(p);
        return e === undefined ? [] : [e];
      });
      // A policy whose tools the service did not state cannot be written: it is reported, in the panel and in the file.
      const notExported = chosen
        .filter((p) => exportableOf(p) === undefined)
        .map((p) => ({
          path: `/policies/${p.id}`,
          reason: t('exportTargetsNotStated'),
          policy: p.id,
        }));
      const policies = exportable.map((p) => ({ ...asWrite(p), id: p.id }));
      const result =
        format === 'cedar'
          ? lib.exportCedar(policies)
          : lib.exportAgt(
              policies,
              // Only callable tools: a withdrawn one, or one of a status not known here, is denied by the service,
              // and AGT fails closed on a tool missing from its catalog.
              controller.tools
                .filter((tool) => tool.status === 'active')
                .map((tool) => ({ tool_ref: tool.toolRef })),
              { agtVersion, ...(toolNames === undefined ? {} : { toolNames }) }
            );
      if (mine !== attempt.current) return;
      // A tool the service no longer lets anyone call that an exported policy still names: the target engine may allow
      // what the service denies, so the report says so (AGT catalogs every tool a policy names).
      const notCallable = new Set(
        controller.tools.filter((tool) => tool.status !== 'active').map((tool) => tool.toolRef)
      );
      const lossyHere = exportable.flatMap((p) =>
        p.targets.tools === 'all'
          ? []
          : p.targets.tools
              .filter((ref) => notCallable.has(ref))
              .map((ref) => ({
                path: `/policies/${p.id}/targets/tools`,
                reason: t('exportToolNotCallable', { tool: ref }),
                policy: p.id,
              }))
      );
      const lines = [
        ...notExported.map((e) => `Not exported: policy ${JSON.stringify(e.policy)}: ${e.reason}`),
        ...lossyHere.map((e) => `Lossy: policy ${JSON.stringify(e.policy)}: ${e.reason}`),
      ];
      setPrepared({
        phase: 'ready',
        result:
          lines.length === 0
            ? result
            : {
                ...result,
                text: withHeaderLines(
                  result.text,
                  format === 'cedar' ? '//' : '#',
                  lines,
                  lib.commentSafe
                ),
                unsupported: [...notExported, ...result.unsupported],
                lossy: [...lossyHere, ...result.lossy],
              },
        filename: format === 'cedar' ? 'policies.cedar' : 'policies.agt.yaml',
      });
    } catch (fault) {
      if (mine === attempt.current) setPrepared({ phase: 'failed', message: describeFault(fault) });
    }
  };

  return (
    <section className="nc-perm-panel" aria-labelledby={ids.heading}>
      <h3 id={ids.heading}>{t('exportHeading')}</h3>
      <div className="nc-perm-row">
        <Label htmlFor={ids.format}>{t('exportFormat')}</Label>
        <Select
          id={ids.format}
          value={format}
          onValueChange={(value) => {
            setFormat(value === 'agt' ? 'agt' : 'cedar');
            reset();
          }}
          options={[
            { value: 'cedar', label: t('formatCedar') },
            { value: 'agt', label: t('formatAgt') },
          ]}
        />
        {format === 'cedar' ? (
          <>
            <Label htmlFor={ids.scope}>{t('exportScope')}</Label>
            <Select
              id={ids.scope}
              value={scope}
              onValueChange={(value) => {
                setScope(value);
                setVersion('published');
                reset();
              }}
              options={[
                { value: 'all', label: t('exportScopeAll') },
                ...controller.policies.map((p) => ({
                  value: p.id,
                  // A policy never published is exported as the draft it is.
                  label:
                    p.state === 'draft'
                      ? t('exportScopeDraft', { name: policyName(p, t) })
                      : policyName(p, t),
                })),
              ]}
            />
            {draftKnown ? (
              <>
                <Label htmlFor={ids.version}>{t('exportVersion')}</Label>
                <Select
                  id={ids.version}
                  value={version}
                  onValueChange={(value) => {
                    setVersion(value === 'draft' ? 'draft' : 'published');
                    reset();
                  }}
                  options={[
                    { value: 'published', label: t('exportVersionPublished') },
                    { value: 'draft', label: t('exportVersionDraft') },
                  ]}
                />
              </>
            ) : null}
          </>
        ) : (
          <>
            <Label htmlFor={ids.agt}>{t('exportAgtVersion')}</Label>
            <Select
              id={ids.agt}
              value={agtVersion}
              onValueChange={(value) => {
                setAgtVersion(value === 'main' ? 'main' : '5.0');
                reset();
              }}
              options={[
                { value: '5.0', label: t('agtVersion50') },
                { value: 'main', label: t('agtVersionMain') },
              ]}
            />
          </>
        )}
        <Button type="button" variant="secondary" onClick={() => void prepare()}>
          {t('exportPrepare')}
        </Button>
      </div>
      {format === 'agt' || scope === 'all' ? (
        <p className="nc-muted">
          {format === 'agt' ? t('exportAgtScope') : t('exportAllScope')}
          {unpublished > 0 ? ` ${t('exportUnpublished', { count: unpublished })}` : ''}
        </p>
      ) : null}
      {prepared.phase === 'preparing' ? <p aria-busy="true">{t('exportPreparing')}</p> : null}
      {prepared.phase === 'failed' ? (
        <p role="alert">{t('exportFailed', { message: prepared.message })}</p>
      ) : null}
      {prepared.phase === 'ready' ? (
        <>
          <ExportReport result={prepared.result} t={t} />
          <Button
            type="button"
            onClick={() => {
              download(
                prepared.result.text,
                prepared.filename,
                prepared.filename.endsWith('.yaml') ? 'application/yaml' : 'text/plain'
              );
            }}
          >
            {t('exportDownload', { filename: prepared.filename })}
          </Button>
        </>
      ) : null}
    </section>
  );
}

function Entries({
  entries,
  heading,
  t,
}: {
  readonly entries: readonly RoundTripReportEntry[];
  readonly heading: string;
  readonly t: PermissionsTranslate;
}) {
  return (
    <>
      <h5>{t('reportGroup', { heading, count: entries.length })}</h5>
      {entries.length === 0 ? (
        <p className="nc-muted">{t('reportNone')}</p>
      ) : (
        <ul className="nc-perm-list">
          {entries.map((e, i) => (
            <li key={`${e.path}:${String(i)}`}>
              <code>{escapeInvisible(e.path === '' ? '/' : e.path)}</code>:{' '}
              {escapeInvisible(e.reason)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Notes({
  notes,
  t,
}: {
  readonly notes: readonly string[];
  readonly t: PermissionsTranslate;
}) {
  if (notes.length === 0) return null;
  return (
    <>
      <h5>{t('reportNotes')}</h5>
      <ul className="nc-perm-list">
        {notes.map((note, i) => (
          <li key={String(i)}>{escapeInvisible(note)}</li>
        ))}
      </ul>
    </>
  );
}

function ExportReport({
  result,
  t,
}: {
  readonly result: RoundTripExport;
  readonly t: PermissionsTranslate;
}) {
  return (
    <div className="nc-perm-report" role="region" aria-label={t('exportReport')}>
      <h4>{t('exportReport')}</h4>
      <Entries entries={result.unsupported} heading={t('reportNotExported')} t={t} />
      <Entries entries={result.lossy} heading={t('reportExportLossy')} t={t} />
      <Notes notes={result.notes} t={t} />
    </div>
  );
}

function ImportPanel({
  controller,
  formats,
  loadImporter,
  cedar,
  toolNames,
  onOpenPolicy,
  onSignIn,
  t,
}: {
  readonly controller: PoliciesController;
  readonly formats: () => Promise<PolicyFormats>;
  readonly loadImporter: () => Promise<PolicyImporter>;
  readonly cedar: CedarSource | undefined;
  readonly toolNames: Readonly<Record<string, string>> | undefined;
  readonly onOpenPolicy: ((id: string) => void) | undefined;
  readonly onSignIn: (() => void) | undefined;
  readonly t: PermissionsTranslate;
}) {
  const { Button, Input, Label, Textarea } = useNc();
  const ids = { file: useId(), paste: useId(), heading: useId() };
  const [paste, setPaste] = useState('');
  const [state, setState] = useState<ImportState>({ phase: 'idle' });
  const attempt = useRef(0);
  /** Saves in flight: reading another file waits for them, so no answer lands on another file's row. */
  const [saving, setSaving] = useState(0);
  /** The rows of the file read as `attempt.current` that a save has started on: each is saved once. */
  const started = useRef(new Set<number>());
  const readOnly = controller.authoring.readOnly;

  const read = async (bytes: Uint8Array): Promise<void> => {
    attempt.current += 1;
    started.current = new Set();
    const mine = attempt.current;
    setState({ phase: 'reading' });
    try {
      const lib = await formats();
      const text = new TextDecoder().decode(bytes);
      const format = lib.detectFormat(text);
      if (format === undefined) {
        setState({ phase: 'failed', message: t('importUnknownFormat') });
        return;
      }
      const importer = await loadImporter();
      const opts = { ...(cedar === undefined ? {} : { cedar }) };
      const result =
        format === 'cedar'
          ? await importer.importCedar(bytes, opts)
          : await importer.importAgt(bytes, {
              ...opts,
              ...(toolNames === undefined ? {} : { toolNames }),
            });
      const items: ImportItem[] = [];
      for (const [index, incoming] of result.policies.entries()) {
        // The converter writes a `PolicyWrite`: the content a save takes.
        const content = incoming.write as PolicyContent;
        const match = matchOf(incoming.key, controller.policies);
        let current: PolicyInfo | undefined;
        let readError: PermissionsError | undefined;
        if (match !== undefined) {
          // Compared with the pending draft when there is one: that is what a save writes over.
          const latest = await controller.latest(match.id);
          if (latest.ok) current = latest.policy;
          else readError = latest.error;
        }
        const before = current === undefined ? undefined : contentOf(current);
        // Without the tools of the version it would replace, neither the difference nor a save can be made.
        if (current !== undefined && before === undefined)
          readError = precondition('targets_not_stated');
        items.push({
          index,
          ...(incoming.key === undefined ? {} : { key: incoming.key }),
          content,
          ...(match === undefined ? {} : { match }),
          ...(current === undefined ? {} : { current }),
          ...(readError === undefined ? {} : { readError }),
          changes:
            match !== undefined && before === undefined
              ? []
              : lib.diffPolicies(
                  before === undefined ? undefined : asWrite(before),
                  asWrite(incoming.write)
                ),
          refused: refusedMembers(content, controller.facts?.policyForms),
          save: { status: 'idle' },
        });
      }
      if (mine === attempt.current) setState({ phase: 'ready', format, result, items });
    } catch (fault) {
      if (mine === attempt.current) setState({ phase: 'failed', message: describeFault(fault) });
    }
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    // The bytes, not text: the recorded digest is of the file as it is.
    file.arrayBuffer().then(
      (buffer) => {
        // Chosen again, the same file is read again.
        input.value = '';
        return read(new Uint8Array(buffer));
      },
      (fault: unknown) => {
        setState({ phase: 'failed', message: describeFault(fault) });
      }
    );
  };

  const setItem = (mine: number, index: number, patch: Partial<ImportItem>): void => {
    setState((s) =>
      s.phase !== 'ready' || mine !== attempt.current
        ? s
        : {
            ...s,
            items: s.items.map((item) => (item.index === index ? { ...item, ...patch } : item)),
          }
    );
  };

  /** Saves one row of the file read as `mine`; false when that file is no longer the one shown. */
  const saveItem = async (
    mine: number,
    item: ImportItem,
    origin: RoundTripImport['origin']
  ): Promise<boolean> => {
    if (mine !== attempt.current) return false;
    // A row saved by hand while "Save every change" runs is not saved twice.
    if (started.current.has(item.index)) return true;
    started.current.add(item.index);
    setItem(mine, item.index, { save: { status: 'saving' } });
    setSaving((n) => n + 1);
    try {
      const result = await controller.saveImported(workingCopyOf(item.content), {
        origin,
        ...(item.match === undefined || item.current === undefined
          ? {}
          : { id: item.match.id, seen: item.current }),
      });
      // A failed save may be tried again.
      if (!result.ok && mine === attempt.current) started.current.delete(item.index);
      setItem(mine, item.index, {
        save: result.ok
          ? { status: 'saved', policy: result.policy }
          : { status: 'error', error: result.error },
      });
    } finally {
      setSaving((n) => n - 1);
    }
    return mine === attempt.current;
  };

  const savable = (item: ImportItem): boolean =>
    !readOnly &&
    item.changes.length > 0 &&
    item.refused.length === 0 &&
    item.readError === undefined &&
    item.save.status !== 'saving' &&
    item.save.status !== 'saved';

  return (
    <section className="nc-perm-panel" aria-labelledby={ids.heading}>
      <h3 id={ids.heading}>{t('importHeading')}</h3>
      {readOnly ? <p className="nc-muted">{t('importReadOnly')}</p> : null}
      <div className="nc-perm-row">
        <Label htmlFor={ids.file}>{t('importFile')}</Label>
        <Input
          id={ids.file}
          type="file"
          accept=".cedar,.yaml,.yml,.txt"
          disabled={saving > 0}
          onChange={onFile}
        />
      </div>
      <Label htmlFor={ids.paste}>{t('importPaste')}</Label>
      <Textarea
        id={ids.paste}
        value={paste}
        onChange={(event) => {
          setPaste(event.currentTarget.value);
        }}
      />
      <Button
        type="button"
        variant="secondary"
        disabled={paste.trim() === '' || saving > 0}
        onClick={() => void read(new TextEncoder().encode(paste))}
      >
        {t('importRead')}
      </Button>
      {state.phase === 'reading' ? <p aria-busy="true">{t('importReading')}</p> : null}
      {state.phase === 'failed' ? (
        <p role="alert">{t('importFailed', { message: state.message })}</p>
      ) : null}
      {state.phase === 'ready' ? (
        <>
          <div className="nc-perm-report" role="region" aria-label={t('importReport')}>
            <h4>{t('importReport')}</h4>
            <p>
              {t('importSummary', {
                format: state.format === 'cedar' ? t('formatCedar') : t('formatAgt'),
                count: state.result.policies.length,
              })}
            </p>
            <Entries entries={state.result.unsupported} heading={t('reportNotImported')} t={t} />
            <Entries entries={state.result.lossy} heading={t('reportImportLossy')} t={t} />
            <Entries entries={state.result.conflicts} heading={t('reportConflicts')} t={t} />
            <Notes notes={state.result.notes} t={t} />
          </div>
          <ul className="nc-perm-list nc-perm-import">
            {state.items.map((item) => (
              <ImportRow
                key={item.index}
                item={item}
                t={t}
                savable={savable(item)}
                readOnly={readOnly}
                onSave={() => void saveItem(attempt.current, item, state.result.origin)}
                onOpenPolicy={onOpenPolicy}
                onSignIn={onSignIn}
              />
            ))}
          </ul>
          {!readOnly && state.items.filter(savable).length > 1 ? (
            <Button
              type="button"
              onClick={() => {
                // One at a time: a failure part way leaves the earlier drafts saved, and says which.
                const mine = attempt.current;
                void (async () => {
                  for (const item of state.items.filter(savable))
                    if (!(await saveItem(mine, item, state.result.origin))) return;
                })();
              }}
            >
              {t('importSaveAll')}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function changeText(change: RoundTripChange): string {
  const json = (value: unknown): string => escapeInvisible(JSON.stringify(value));
  const path = escapeInvisible(change.path === '' ? '/' : change.path);
  if (change.op === 'add') return `+ ${path}: ${json(change.after)}`;
  if (change.op === 'remove') return `- ${path}: ${json(change.before)}`;
  return `~ ${path}: ${json(change.before)} → ${json(change.after)}`;
}

function ImportRow({
  item,
  t,
  savable,
  readOnly,
  onSave,
  onOpenPolicy,
  onSignIn,
}: {
  readonly item: ImportItem;
  readonly t: PermissionsTranslate;
  readonly savable: boolean;
  readonly readOnly: boolean;
  readonly onSave: () => void;
  readonly onOpenPolicy: ((id: string) => void) | undefined;
  readonly onSignIn: (() => void) | undefined;
}) {
  const { Badge, Button } = useNc();
  const name = policyName({ name: item.content.name, id: item.key ?? '' }, t);
  const saved = item.save.status === 'saved' ? item.save.policy : undefined;
  return (
    <li data-import={item.key ?? `new-${String(item.index)}`}>
      <strong>{name}</strong>{' '}
      {item.match === undefined ? (
        <Badge variant="outline">{t('importNew')}</Badge>
      ) : (
        <span className="nc-perm-meta">
          {item.current === undefined
            ? t('importMatches', { name: policyName(item.match, t) })
            : t('importComparedWith', {
                name: policyName(item.match, t),
                version: item.current.version,
                state:
                  item.current.state === 'draft'
                    ? t('importStateDraft')
                    : t('importStatePublished'),
              })}
        </span>
      )}
      {item.readError === undefined ? null : (
        <PermissionsErrorAlert error={item.readError} t={t} onSignIn={onSignIn} />
      )}
      {item.changes.length === 0 && item.readError === undefined ? (
        <p className="nc-muted">{t('importNoChange')}</p>
      ) : (
        <ul className="nc-perm-list nc-perm-diff" aria-label={t('importChanges', { name })}>
          {item.changes.map((change, i) => (
            <li key={`${change.path}:${String(i)}`}>
              <code>{changeText(change)}</code>
            </li>
          ))}
        </ul>
      )}
      {item.refused.length === 0 ? null : (
        <p className="nc-perm-note">
          {t('importRefusedForms', {
            members: item.refused.map((m) => escapeInvisible(m)).join(', '),
          })}
        </p>
      )}
      {item.save.status === 'error' ? (
        <PermissionsErrorAlert error={item.save.error} t={t} context="write" onSignIn={onSignIn} />
      ) : null}
      {saved === undefined ? null : (
        <p role="status">
          {t('importSaved', { name, version: saved.version })}{' '}
          {onOpenPolicy === undefined ? null : (
            <Button
              type="button"
              variant="link"
              onClick={() => {
                onOpenPolicy(saved.id);
              }}
            >
              {t('importOpen', { name })}
            </Button>
          )}
        </p>
      )}
      {savable && !readOnly ? (
        <Button type="button" variant="secondary" onClick={onSave}>
          {t('importSave', { name })}
        </Button>
      ) : null}
    </li>
  );
}
