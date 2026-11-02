// @vitest-environment jsdom
import { exportCedar } from '@noblecloak/policy-formats';
import { importCedar } from '@noblecloak/policy-formats/import';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsePoliciesOptions } from '../permissions-types.js';
import type { PermissionsLabels } from './permissions-labels.js';
import { axe } from '../testing/axe.js';
import {
  call,
  inProcessFetch,
  jsonResponse,
  recorder,
  startHarness,
} from '../testing/approvals-harness.js';
import type { Harness, Recorder } from '../testing/approvals-harness.js';
import { usePolicies } from '../use-policies.js';
import { Permissions } from './Permissions.js';
import type { PolicyFormats, PolicyImporter } from './PolicyRoundTrip.js';

/**
 * The import/export panel on the real hooks over the in-process mock. The importer is the real one, with the Node
 * build of the Cedar parser (a browser host passes its own).
 */
const cedar = () => import('@cedar-policy/cedar-wasm/nodejs');
const formats = (): Promise<PolicyFormats> => import('@noblecloak/policy-formats');
const loadImporter = (): Promise<PolicyImporter> => import('@noblecloak/policy-formats/import');

let h: Harness;
let edge: Harness;
beforeAll(async () => {
  h = await startHarness();
  edge = await startHarness({ deployment: 'edge' });
});
afterAll(async () => {
  await h.stop();
  await edge.stop();
});

/** The files the panel hands to the browser to save. */
let downloads: Blob[] = [];
beforeEach(() => {
  downloads = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    downloads.push(blob);
    return `blob:download-${String(downloads.length)}`;
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Probe({
  options,
  withImport = true,
  labels,
}: {
  readonly options: UsePoliciesOptions;
  readonly withImport?: boolean;
  readonly labels?: PermissionsLabels;
}) {
  const controller = usePolicies(options);
  return (
    <Permissions
      controller={controller}
      {...(labels === undefined ? {} : { labels })}
      roundTrip={withImport ? { formats, loadImporter, cedar } : { formats }}
    />
  );
}

const options = (rec: Recorder, token: string, harness: Harness = h): UsePoliciesOptions => ({
  baseUrl: harness.baseUrl,
  getToken: () => token,
  fetch: rec.fetch,
  roles: [{ id: 'member' }],
});

/** `row` without `keys`. */
const without = (row: Record<string, unknown>, ...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));

const section = (name: string): HTMLElement => {
  const heading = screen.getByRole('heading', { name });
  const panel = heading.closest('section');
  if (!(panel instanceof HTMLElement)) throw new Error(`no section ${name}`);
  return panel;
};

/** Exports every published tool policy as Cedar and returns the file the browser would save. */
async function exportAll(): Promise<string> {
  const panel = within(section('Export'));
  await userEvent.click(panel.getByRole('button', { name: 'Prepare the export' }));
  await panel.findByRole('region', { name: 'Export report' });
  await userEvent.click(panel.getByRole('button', { name: 'Download policies.cedar' }));
  const blob = downloads.at(-1);
  if (blob === undefined) throw new Error('nothing downloaded');
  return blob.text();
}

async function importText(text: string): Promise<HTMLElement> {
  const panel = within(section('Import'));
  await userEvent.click(panel.getByRole('textbox', { name: 'Or paste a file' }));
  await userEvent.paste(text);
  await userEvent.click(panel.getByRole('button', { name: 'Read the file' }));
  return panel.findByRole('region', { name: 'Import report' });
}

const listItems = (region: HTMLElement, heading: RegExp): string[] => {
  const h5 = within(region).getByRole('heading', { name: heading });
  const list = h5.nextElementSibling;
  return list?.tagName === 'UL' ? [...list.querySelectorAll('li')].map((li) => li.textContent) : [];
};

describe('the policy import/export panel', { timeout: 30_000 }, () => {
  it('exports the published tool policies with the report shown first, and its import changes nothing and loses exactly what the report says', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const text = await exportAll();
    // The report is shown before the download and is the file's own header.
    const report = screen.getByRole('region', { name: 'Export report' });
    // What the service lists, exported by the converter directly: the panel adds nothing and drops nothing.
    const listed = (await (
      await call(h.baseUrl, h.tokens.admin, 'GET', '/v1/policies?kind=tool_invocation&limit=200')
    ).json()) as { data: { id: string; state?: string }[] };
    const expected = exportCedar(listed.data.filter((p) => p.state === 'published') as never, {});
    expect(text).toBe(expected.text);
    expect(listItems(report, /^Exported, not enforced as here/)).toEqual(
      expected.lossy.map((e) => `${e.path}: ${e.reason}`)
    );
    expect(listItems(report, /^Not exported/)).toEqual([]);
    // The approval modes and their settings are what Cedar cannot carry, and nothing is left out.
    expect(expected.lossy.length).toBeGreaterThan(0);
    expect(
      expected.lossy.every((e) =>
        /^\/\d+\/config\/(mode|on_deny|expires_after|approver_groups)$/.test(e.path)
      )
    ).toBe(true);
    expect(expected.unsupported).toEqual([]);

    // Import the file: both policies match theirs, nothing would change, nothing is offered for saving.
    const imported = await importText(text);
    const known = await importCedar(text, { cedar });
    expect(listItems(imported, /^Not imported/)).toEqual([]);
    expect(listItems(imported, /^Imported in part/)).toEqual(
      known.lossy.map((e) => `${e.path}: ${e.reason}`)
    );
    expect(listItems(imported, /^Conflicts/)).toEqual([]);
    for (const key of ['pol_default', 'pol_silent']) {
      const row = container.querySelector(`li[data-import="${key}"]`);
      if (!(row instanceof HTMLElement)) throw new Error(`no row ${key}`);
      expect(row.textContent).toContain('No change.');
      expect(within(row).queryByRole('button', { name: /^Save/ })).toBeNull();
    }
    expect(
      rec.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/v1/policies'))
    ).toEqual([]);
    expect((await axe(section('Import'))).violations).toEqual([]);
  });

  it('shows an edit made in the file, saves it as a draft with its origin, and the editor simulates and publishes it', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const exported = await exportAll();
    const edited = exported.replace(
      '@noblecloak_name("Ask before a comment")',
      '@noblecloak_name("Ask before every comment")'
    );
    expect(edited).not.toBe(exported);
    await importText(edited);
    const row = container.querySelector('li[data-import="pol_silent"]');
    if (!(row instanceof HTMLElement)) throw new Error('no row');
    const diff = within(row).getByRole('list', { name: /Changes to/ });
    expect(diff.textContent).toBe('~ /name: "Ask before a comment" → "Ask before every comment"');
    expect(container.querySelector('li[data-import="pol_default"]')?.textContent).toContain(
      'No change.'
    );
    await userEvent.click(
      within(row).getByRole('button', { name: /^Save Ask before every comment/ })
    );
    await within(row).findByText(/Saved as draft v/);
    const put = rec.calls.find((c) => c.method === 'PUT' && c.path === '/v1/policies/pol_silent');
    expect(put?.body).toMatchObject({
      name: 'Ask before every comment',
      origin: { format: 'cedar', digest: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown },
    });
    // The module's own flow from here: open, simulate, publish.
    await userEvent.click(
      within(row).getByRole('button', { name: /^Open Ask before every comment/ })
    );
    const open = await waitFor(() => {
      const panel = document.querySelector('.nc-perm-open');
      if (!(panel instanceof HTMLElement)) throw new Error('not open');
      return panel;
    });
    const editor = within(open);
    await editor.findByRole('heading', { name: /^Policy: Ask before/ });
    await editor.findByDisplayValue('Ask before every comment');
    await userEvent.click(editor.getByRole('button', { name: 'Simulate' }));
    await editor.findByText(/^Decision: /);
    await userEvent.click(editor.getByRole('button', { name: 'Publish' }));
    await editor.findByText(/^Published v\d+\./);
    const read = await call(h.baseUrl, h.tokens.admin, 'GET', '/v1/policies/pol_silent');
    const body = (await read.json()) as { data: { name: string; state: string } };
    expect(body.data).toMatchObject({ name: 'Ask before every comment', state: 'published' });
  });

  it('a new policy in the file is created as an imported draft', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const file = exportCedar([
      {
        id: 'pol_from_elsewhere',
        kind: 'tool_invocation',
        name: 'Deny deleting accounts',
        subjects: [{ type: 'role', id: 'member' }],
        targets: { tools: ['mcp:crm:delete_account'] },
        config: { mode: 'deny' },
      },
    ] as never).text;
    await importText(file);
    const row = container.querySelector('li[data-import="pol_from_elsewhere"]');
    if (!(row instanceof HTMLElement)) throw new Error('no row');
    expect(row.textContent).toContain('New');
    await userEvent.click(
      within(row).getByRole('button', { name: /^Save Deny deleting accounts/ })
    );
    await within(row).findByText(/Saved as draft v1/);
    const post = rec.calls.find((c) => c.method === 'POST' && c.path === '/v1/policies');
    expect(post?.body).toMatchObject({ origin: { format: 'cedar' } });
    expect(rec.calls.filter((c) => c.method === 'POST' && c.path === '/v1/policies')).toHaveLength(
      1
    );
    // The service records it as imported.
    const listed = (await (
      await call(h.baseUrl, h.tokens.admin, 'GET', '/v1/policies?kind=tool_invocation&limit=200')
    ).json()) as { data: { name?: string; source: string; origin?: unknown }[] };
    expect(listed.data.find((p) => p.name === 'Deny deleting accounts')).toMatchObject({
      source: 'imported',
      origin: { format: 'cedar' },
    });
  });

  it('offers no save for a form the service does not advertise, and shows a 422 through the problem display', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.method === 'PUT' && c.path === '/v1/policies/pol_default'
        ? new Response(
            JSON.stringify({
              type: 'https://x/problems/unsupported_policy_form',
              title: 'unsupported_policy_form',
              status: 422,
              detail: 'config.approver_groups: not enforced here',
            }),
            { status: 422, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined
    );
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const file = exportCedar([
      {
        id: 'pol_new_ng',
        kind: 'tool_invocation',
        name: 'Not granted here',
        subjects: [{ type: 'role', id: 'member' }],
        targets: { tools: ['mcp:crm:delete_account'] },
        config: { mode: 'not_granted' },
      },
      {
        id: 'pol_default',
        kind: 'tool_invocation',
        name: 'Ask the members before a call',
        subjects: [{ type: 'role', id: 'member' }],
        targets: {
          tools: [
            'mcp:tracker:search',
            'mcp:tracker:create_issue',
            'ext:local:send_email',
            'mcp:crm:delete_account',
          ],
        },
        config: {
          mode: 'ask',
          on_deny: 'resume',
          expires_after: 'PT1H',
          approver_groups: ['leads'],
        },
      },
    ] as never).text;
    await importText(file);
    const refused = container.querySelector('li[data-import="pol_new_ng"]');
    if (!(refused instanceof HTMLElement)) throw new Error('no row');
    // The mock advertises its forms, and not_granted is not one of them.
    expect(refused.textContent).toContain('This service does not take: config.mode');
    expect(within(refused).queryByRole('button', { name: /^Save/ })).toBeNull();
    const changed = container.querySelector('li[data-import="pol_default"]');
    if (!(changed instanceof HTMLElement)) throw new Error('no row');
    await userEvent.click(within(changed).getByRole('button', { name: /^Save/ }));
    const alert = await within(changed).findByRole('alert');
    expect(alert.textContent).toContain(
      'The service cannot enforce this form: config.approver_groups: not enforced here'
    );
  });

  it('exports on the edge profile, and shows an import with no save and no publish', async () => {
    const rec = recorder(inProcessFetch(edge.mock));
    const { container } = render(<Probe options={options(rec, edge.tokens.admin, edge)} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const text = await exportAll();
    expect(text).toContain('@noblecloak_policy("pol_default")');
    await importText(text.replace('Ask before a comment', 'Ask before every comment'));
    expect(within(section('Import')).getByText(/shown, not saved/)).toBeDefined();
    const row = container.querySelector('li[data-import="pol_silent"]');
    if (!(row instanceof HTMLElement)) throw new Error('no row');
    expect(within(row).getByRole('list', { name: /Changes to/ }).textContent).toContain('/name');
    expect(within(section('Import')).queryByRole('button', { name: /^Save/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Publish/ })).toBeNull();
    expect(
      rec.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/v1/policies'))
    ).toEqual([]);
  });

  it('exports an AGT manifest of every tool policy and the tool inventory, for 5.0 by default or main', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.admin)} withImport={false} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const panel = within(section('Export'));
    await userEvent.selectOptions(panel.getByRole('combobox', { name: 'Format' }), 'agt');
    const release = panel.getByRole('combobox', { name: 'AGT release' });
    expect((release as HTMLSelectElement).value).toBe('5.0');
    await userEvent.click(panel.getByRole('button', { name: 'Prepare the export' }));
    const report = await panel.findByRole('region', { name: 'Export report' });
    // AGT names no end user: the role subjects are not exported, and the report says so.
    expect(listItems(report, /^Not exported/).length).toBeGreaterThan(0);
    await userEvent.click(panel.getByRole('button', { name: 'Download policies.agt.yaml' }));
    const v50 = await (downloads.at(-1) ?? new Blob()).text();
    expect(v50).toMatch(/^agent_control_specification_version: "?0\.3\.1-beta"?$/m);
    expect(v50).toContain('mcp:tracker:list_labels');
    await userEvent.selectOptions(release, 'main');
    await userEvent.click(panel.getByRole('button', { name: 'Prepare the export' }));
    await panel.findByRole('region', { name: 'Export report' });
    await userEvent.click(panel.getByRole('button', { name: 'Download policies.agt.yaml' }));
    const main = await (downloads.at(-1) ?? new Blob()).text();
    expect(main).toMatch(/^agent_control_specification_version: "?0\.4\.0-alpha\.1"?$/m);
  });

  it('reports a policy it cannot write, in the panel and in the file (R-C2)', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/policies' || !c.query.includes('kind=tool_invocation')) return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: Record<string, unknown>[]; meta: unknown };
      return jsonResponse({
        ...body,
        data: [
          ...body.data.map((row) => (row.id === 'pol_silent' ? without(row, 'targets') : row)),
          // An id that would end a YAML 1.1 comment, were it written raw.
          { ...without(body.data[0] ?? {}, 'targets'), id: 'pol\u0085evil' },
        ],
      });
    });
    render(<Probe options={options(rec, h.tokens.admin)} withImport={false} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const text = await exportAll();
    // In the file's own report block, which an import still recognises as the converter's.
    const block = text.slice(0, text.indexOf('\n\n'));
    expect(block.startsWith('// NobleCloak tool_invocation policies')).toBe(true);
    expect(block).toContain(
      '\n// Not exported: policy "pol_silent": the service did not say which tools this policy governs'
    );
    expect(block).toContain('// Not exported: policy "pol\\u0085evil"');
    expect(block).not.toContain('\u0085');
    expect((await importCedar(text, { cedar })).notes).toEqual([]);
    expect(text).not.toContain('@noblecloak_policy("pol_silent")');
    const report = screen.getByRole('region', { name: 'Export report' });
    const listed = listItems(report, /^Not exported/);
    expect(listed).toHaveLength(2);
    expect(listed).toContain(
      '/policies/pol_silent: the service did not say which tools this policy governs, so it cannot be written'
    );
  });

  it('writes no line break, bidirectional or invisible code point into the file from a policy id or a reason (Trojan Source)', async () => {
    const HIDDEN = '\u202E\u200B\u2028\r\u2066';
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/policies' || !c.query.includes('kind=tool_invocation')) return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: Record<string, unknown>[]; meta: unknown };
      return jsonResponse({
        ...body,
        data: [...body.data, { ...without(body.data[0] ?? {}, 'targets'), id: `pol${HIDDEN}evil` }],
      });
    });
    render(
      <Probe
        options={options(rec, h.tokens.admin)}
        withImport={false}
        labels={{ exportTargetsNotStated: `reason${HIDDEN}text` }}
      />
    );
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const text = await exportAll();
    const block = text.slice(0, text.indexOf('\n\n'));
    expect(block).not.toMatch(
      /[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}\u2028\u2029\r\u0085]/u
    );
    // One header line for the policy: the id and the reason could not break it.
    const lines = block.split('\n').filter((line) => line.includes('Not exported: policy "pol'));
    expect(lines).toEqual([
      '// Not exported: policy "pol\\u202e\\u200b\\u2028\\r\\u2066evil": reason\\u202e\\u200b\\u2028\\u000d\\u2066text',
    ]);
    expect((await importCedar(text, { cedar })).notes).toEqual([]);
  });

  it('compares with the pending draft, saves over it, and refuses a save over a draft that changed meanwhile', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const exported = await exportAll();
    // A pending draft of pol_default, written elsewhere before the file is read.
    const listed = (await (
      await call(h.baseUrl, h.tokens.admin, 'GET', '/v1/policies/pol_default')
    ).json()) as { data: Record<string, unknown> };
    const write = without(
      listed.data,
      'id',
      'version',
      'source',
      'state',
      'published_at',
      'updated_at',
      'updated_by',
      'unenforced_targets',
      'draft_version'
    );
    expect(
      (
        await call(h.baseUrl, h.tokens.admin, 'PUT', '/v1/policies/pol_default', {
          ...write,
          description: 'drafted elsewhere',
        })
      ).status
    ).toBe(200);
    await importText(exported);
    const row = container.querySelector('li[data-import="pol_default"]');
    if (!(row instanceof HTMLElement)) throw new Error('no row');
    expect(row.textContent).toMatch(/compared with v\d+ \(draft\)/);
    expect(within(row).getByRole('list', { name: /Changes to/ }).textContent).toContain(
      '- /description: "drafted elsewhere"'
    );
    // The draft changes again before the save: the save is refused, nothing is written over it.
    expect(
      (
        await call(h.baseUrl, h.tokens.admin, 'PUT', '/v1/policies/pol_default', {
          ...write,
          description: 'drafted again',
        })
      ).status
    ).toBe(200);
    const puts = () =>
      rec.calls.filter((c) => c.method === 'PUT' && c.path === '/v1/policies/pol_default').length;
    const before = puts();
    await userEvent.click(within(row).getByRole('button', { name: /^Save/ }));
    const alert = await within(row).findByRole('alert');
    expect(alert.textContent).toContain('This draft changed since it was shown.');
    expect(puts()).toBe(before);
  });

  it('exports one policy as its pending draft when chosen, and a draft never published as itself (R-C4)', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const made = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/policies', {
      kind: 'tool_invocation',
      name: 'never published',
      subjects: [{ type: 'role', id: 'member' }],
      targets: { tools: ['mcp:tracker:list_labels'] },
      config: { mode: 'deny' },
    });
    const id = ((await made.json()) as { data: { id: string } }).data.id;
    render(<Probe options={options(rec, h.tokens.admin)} withImport={false} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const panel = within(section('Export'));
    const scope = panel.getByRole('combobox', { name: 'Policies' });
    await userEvent.selectOptions(scope, id);
    expect(panel.queryByRole('combobox', { name: 'Version' })).toBeNull();
    expect(
      within(scope).getByRole('option', { name: 'never published (draft, never published)' })
    ).toBeDefined();
    await userEvent.click(panel.getByRole('button', { name: 'Prepare the export' }));
    await panel.findByRole('region', { name: 'Export report' });
    await userEvent.click(panel.getByRole('button', { name: 'Download policies.cedar' }));
    expect(await (downloads.at(-1) ?? new Blob()).text()).toContain(
      '@noblecloak_name("never published")'
    );
    // pol_default has a pending draft (the test before wrote it): the version can be chosen.
    await userEvent.selectOptions(scope, 'pol_default');
    await waitFor(() => {
      expect(panel.getByRole('combobox', { name: 'Version' })).toBeDefined();
    });
  });

  it('saves every change in turn, says which saved and which failed, and lands nothing on a file read after (R-C1)', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    rec.intercept(async (c) => {
      if (c.method === 'POST' && c.path === '/v1/policies') {
        const name = (c.body as { name?: string }).name;
        if (name === 'second new') await held;
        if (name === 'third new')
          return new Response(
            JSON.stringify({
              type: 'https://x/problems/unsupported_policy_form',
              title: 'unsupported_policy_form',
              status: 422,
              detail: 'config.mode: not here',
            }),
            { status: 422, headers: { 'content-type': 'application/problem+json' } }
          );
      }
      return undefined;
    });
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const file = exportCedar(
      ['first new', 'second new', 'third new'].map((name, i) => ({
        id: `pol_batch_${String(i)}`,
        kind: 'tool_invocation',
        name,
        subjects: [{ type: 'role', id: 'member' }],
        targets: { tools: ['mcp:tracker:list_labels'] },
        config: { mode: 'deny' },
      })) as never
    ).text;
    await importText(file);
    await userEvent.click(screen.getByRole('button', { name: 'Save every change as a draft' }));
    const first = container.querySelector('li[data-import="pol_batch_0"]');
    if (!(first instanceof HTMLElement)) throw new Error('no row');
    await within(first).findByText(/Saved as draft v1/);
    // While the second is held, reading is off; nothing of the batch may land on another file.
    expect(within(section('Import')).getByRole('button', { name: 'Read the file' })).toHaveProperty(
      'disabled',
      true
    );
    release();
    const third = container.querySelector('li[data-import="pol_batch_2"]');
    if (!(third instanceof HTMLElement)) throw new Error('no row');
    const alert = await within(third).findByRole('alert');
    expect(alert.textContent).toContain('config.mode: not here');
    const second = container.querySelector('li[data-import="pol_batch_1"]');
    expect(second?.textContent).toContain('Saved as draft v1');
  });

  it('saves a row once when it is saved by hand while every change is being saved (ADV-C1)', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    rec.intercept(async (c) => {
      if (c.method === 'POST' && (c.body as { name?: string } | undefined)?.name === 'once first')
        await held;
      return undefined;
    });
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const file = exportCedar(
      ['once first', 'once second'].map((name, i) => ({
        id: `pol_once_${String(i)}`,
        kind: 'tool_invocation',
        name,
        subjects: [{ type: 'role', id: 'member' }],
        targets: { tools: ['mcp:tracker:list_labels'] },
        config: { mode: 'deny' },
      })) as never
    ).text;
    await importText(file);
    await userEvent.click(screen.getByRole('button', { name: 'Save every change as a draft' }));
    const second = container.querySelector('li[data-import="pol_once_1"]');
    if (!(second instanceof HTMLElement)) throw new Error('no row');
    await userEvent.click(within(second).getByRole('button', { name: /^Save once second/ }));
    release();
    await within(second).findByText(/Saved as draft v1/);
    await waitFor(() => {
      expect(container.querySelector('li[data-import="pol_once_0"]')?.textContent).toContain(
        'Saved as draft v1'
      );
    });
    const posted = rec.calls.filter(
      (c) => c.method === 'POST' && (c.body as { name?: string }).name === 'once second'
    );
    expect(posted).toHaveLength(1);
  });

  it('says a match whose tools the service did not state can be neither compared nor saved (R-C3)', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const exported = await exportAll();
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/policies/pol_silent/versions') return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: Record<string, unknown>[]; meta: unknown };
      return jsonResponse({
        ...body,
        data: body.data.map((row) => {
          return without(row, 'targets');
        }),
      });
    });
    await importText(exported);
    const row = container.querySelector('li[data-import="pol_silent"]');
    if (!(row instanceof HTMLElement)) throw new Error('no row');
    expect((await within(row).findByRole('alert')).textContent).toContain(
      'The service did not say which tools this policy governs.'
    );
    expect(row.textContent).not.toContain('No change.');
    expect(within(row).queryByRole('button', { name: /^Save/ })).toBeNull();
  });

  it('catalogs only callable tools in an AGT manifest, and reports a policy that names one no longer callable (WB-1)', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/tools') return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: Record<string, unknown>[]; meta: unknown };
      return jsonResponse({
        ...body,
        data: body.data.map((row) =>
          row.tool_ref === 'mcp:tracker:list_labels' || row.tool_ref === 'mcp:tracker:search'
            ? { ...row, status: 'withdrawn' }
            : row
        ),
      });
    });
    render(<Probe options={options(rec, h.tokens.admin)} withImport={false} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const panel = within(section('Export'));
    await userEvent.selectOptions(panel.getByRole('combobox', { name: 'Format' }), 'agt');
    await userEvent.click(panel.getByRole('button', { name: 'Prepare the export' }));
    const report = await panel.findByRole('region', { name: 'Export report' });
    expect(listItems(report, /^Exported, not enforced as here/)).toContain(
      '/policies/pol_default/targets/tools: it names mcp:tracker:search, which this service no longer lets anyone call; a target engine may still allow it'
    );
    await userEvent.click(panel.getByRole('button', { name: 'Download policies.agt.yaml' }));
    const file = await (downloads.at(-1) ?? new Blob()).text();
    // Not catalogued: no policy names it.
    expect(file).not.toContain('mcp:tracker:list_labels');
    expect(file.slice(0, file.indexOf('\n\n'))).toContain(
      '# Lossy: policy "pol_default": it names mcp:tracker:search'
    );
  });

  it('without an importer it only exports, and never loads one', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.admin)} withImport={false} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    expect(screen.getByRole('heading', { name: 'Export' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Import' })).toBeNull();
  });
});
