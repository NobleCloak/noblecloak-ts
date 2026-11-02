// @vitest-environment jsdom
import type { ButtonProps, SelectProps } from '@noblecloak/theme';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { PoliciesController, UsePoliciesOptions } from '../permissions-types.js';
import { axe } from '../testing/axe.js';
import {
  call,
  inProcessFetch,
  jsonResponse,
  recorder,
  startHarness,
} from '../testing/approvals-harness.js';
import type { Harness, Recorder } from '../testing/approvals-harness.js';
import { NcProvider } from '../slots.js';
import { usePolicies } from '../use-policies.js';
import { ModeLegend } from './ModeLegend.js';
import { Permissions } from './Permissions.js';
import type { PermissionsProps } from './Permissions.js';
import { PolicyEditor, refusedField } from './PolicyEditor.js';

/**
 * The components on the real hooks over the in-process mock: what the person sees after a choice is what the store
 * did, with no fake controller between them.
 */
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
afterEach(() => {
  cleanup();
});

interface Exposed {
  current: PoliciesController | undefined;
}

function Probe(props: {
  readonly options: UsePoliciesOptions;
  readonly expose?: Exposed;
  readonly extra?: Partial<PermissionsProps>;
}) {
  const controller = usePolicies(props.options);
  if (props.expose !== undefined) props.expose.current = controller;
  return <Permissions controller={controller} {...props.extra} />;
}

let unique = 0;
const freshRole = (): string => {
  unique += 1;
  return `ui_role_${String(unique)}`;
};

function options(
  rec: Recorder,
  token: string,
  extra: Partial<UsePoliciesOptions> = {},
  harness: Harness = h
): UsePoliciesOptions {
  return { baseUrl: harness.baseUrl, getToken: () => token, fetch: rec.fetch, ...extra };
}

/*
 * These tests run the real hook over the in-process mock, so each is several round trips and renders the whole
 * table. The helpers below find the table and its cells by structure (a role query computes the accessible name of
 * every element on the page, on every poll), and the heavy queries are scoped to the part under test: on a slow CI
 * runner the whole-page queries took a test past vitest's default 5 s.
 */

/** The role × tool table, found by structure; a test asserts its accessible name once. */
const matrix = (): HTMLTableElement => {
  const table = document.querySelector('table.nc-perm-matrix');
  if (!(table instanceof HTMLTableElement)) throw new Error('no matrix table');
  return table;
};

/** Waits until the table has rendered. */
const tableShown = (): Promise<HTMLTableElement> => waitFor(matrix);

const cellOf = (tool: string, column: string): HTMLElement => {
  const table = matrix();
  const headers = [...table.querySelectorAll('thead th')];
  const index = headers.findIndex((th) => th.textContent === column);
  if (index < 0) throw new Error(`no column ${column}`);
  const row = [...table.querySelectorAll('tbody tr')].find(
    (r) => r.querySelector('th[scope="row"] code')?.textContent === tool
  );
  if (row === undefined) throw new Error(`no row ${tool}`);
  const cell = row.children[index];
  if (!(cell instanceof HTMLElement)) throw new Error('no cell');
  return cell;
};

/** The open policy's editor and dry run, where the per-policy queries look. */
const openPolicy = (): Promise<HTMLElement> =>
  waitFor(() => {
    const panel = document.querySelector('.nc-perm-open');
    if (!(panel instanceof HTMLElement)) throw new Error('no open policy');
    return panel;
  });

// The real hook over the in-process mock: each test is several round trips and renders the whole table, which a slow
// CI runner takes seconds over (the 5 s default timed one out); this bounds a stall without failing a slow pass.
describe('Permissions over the real hook', { timeout: 20_000 }, () => {
  it('renders the table of the seeded policies, with headers and a named control per cell', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await tableShown();
    // The table's accessible name, asserted once here; the other tests find it by structure.
    const table = screen.getByRole('table', { name: /Tool policies by role/ });
    const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toEqual(['Tool', 'member', 'Organisation']);
    const governed = cellOf('mcp:tracker:search', 'member');
    expect(governed.textContent).toContain('Ask');
    expect(governed.textContent).toContain('Ask the members before a call · v3');
    // A policy that governs several pairs is edited as a whole, never from one cell.
    // Its control is named for the cell first, then for what it does.
    expect(
      within(governed).getByRole('button', {
        name: 'Ask for member on mcp:tracker:search: Edit Ask the members before a call',
      })
    ).toBeDefined();
    const none = cellOf('mcp:tracker:list_labels', 'Organisation');
    expect(none.textContent).toContain('No policy');
    expect(none.textContent).toContain("the deployment's default applies");
    expect(
      within(none).getByRole('combobox', {
        name: 'No policy for Organisation on mcp:tracker:list_labels',
      })
    ).toBeDefined();
    const sole = cellOf('mcp:tracker:add_comment', 'member');
    expect(
      within(sole).getByRole('combobox', { name: 'Ask for member on mcp:tracker:add_comment' })
    ).toBeDefined();
    // No cell says what a person holding the role gets.
    expect(table.textContent).not.toMatch(/effective|wins|winner|overrid|precedence/i);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('sets a cell: a draft is written and the cell shows it pending', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const role = freshRole();
    render(<Probe options={options(rec, h.tokens.admin, { roles: [{ id: role }] })} />);
    await tableShown();
    await userEvent.selectOptions(
      within(cellOf('mcp:tracker:search', role)).getByRole('combobox', {
        name: `No policy for ${role} on mcp:tracker:search`,
      }),
      'deny'
    );
    await waitFor(() => {
      expect(cellOf('mcp:tracker:search', role).textContent).toContain('Draft pending v1');
    });
    expect(rec.calls.find((c) => c.method === 'POST' && c.path === '/v1/policies')?.body).toEqual({
      kind: 'tool_invocation',
      name: `${role} · mcp:tracker:search`,
      subjects: [{ type: 'role', id: role }],
      targets: { tools: ['mcp:tracker:search'] },
      config: { mode: 'deny' },
    });
    expect(screen.getByText(/^Draft v1 written for/)).toBeDefined();
  });

  it('publishes a draft from the tray, and the cell shows the published policy', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const role = freshRole();
    render(<Probe options={options(rec, h.tokens.admin, { roles: [{ id: role }] })} />);
    await tableShown();
    await userEvent.selectOptions(
      within(cellOf('mcp:tracker:search', role)).getByRole('combobox', {
        name: `No policy for ${role} on mcp:tracker:search`,
      }),
      'always_allow'
    );
    const publish = await screen.findByRole('button', {
      name: `Publish ${role} · mcp:tracker:search`,
    });
    await userEvent.click(publish);
    // The cell's own options name every mode, so the state is what tells a published policy.
    await waitFor(() => {
      expect(cellOf('mcp:tracker:search', role).getAttribute('data-state')).toBe('governed');
    });
    expect(cellOf('mcp:tracker:search', role).querySelector('.nc-perm-mode')?.textContent).toBe(
      'Always allow'
    );
    expect(screen.getByText(/^Published v1\. Enforcement follows/)).toBeDefined();
  });

  it('opens a policy: the editor, its governed cells highlighted, and a dry run as the caller', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await tableShown();
    await userEvent.click(
      within(cellOf('mcp:tracker:search', 'member')).getByRole('button', {
        name: /: Edit Ask the members before a call$/,
      })
    );
    const panel = within(await openPolicy());
    await panel.findByRole('heading', { name: 'Policy: Ask the members before a call' });
    await panel.findByRole('textbox', { name: 'Name' });
    expect(cellOf('mcp:tracker:create_issue', 'member').getAttribute('data-highlighted')).toBe(
      'true'
    );
    expect(cellOf('mcp:tracker:add_comment', 'member').hasAttribute('data-highlighted')).toBe(
      false
    );
    expect(panel.getByRole('heading', { name: 'Simulated as you' })).toBeDefined();
    await userEvent.click(panel.getByRole('button', { name: 'Simulate' }));
    await panel.findByText(/^Decision: /);
    expect(
      panel.getByText(
        'This policy does not apply to you, so the result shows what you would get without it.'
      )
    ).toBeDefined();
    expect(panel.getByText('Dry run — nothing was enforced.')).toBeDefined();
    const result = container.querySelector('.nc-perm-result');
    expect(result?.textContent).toContain('Deployment default (default)');
    expect(result?.textContent).not.toMatch(/win|overrid|not reached|precedence/i);
    // The editor and the dry run; the table was checked by axe in the first test.
    expect((await axe(await openPolicy())).violations).toEqual([]);
  });

  it('simulates a policy that names the caller: the decision names it', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const created = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/policies', {
      kind: 'tool_invocation',
      name: 'Admin denied labels',
      subjects: [{ type: 'user', id: 'user_admin' }],
      targets: { tools: ['mcp:tracker:list_labels'] },
      config: { mode: 'deny' },
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await tableShown();
    await userEvent.click(await screen.findByRole('button', { name: 'Open Admin denied labels' }));
    await within(await openPolicy()).findByRole('textbox', { name: 'Name' });
    await userEvent.click(within(await openPolicy()).getByRole('button', { name: 'Simulate' }));
    await screen.findByText('Decision: deny');
    expect(screen.getByText('The decision names policy Admin denied labels v1.')).toBeDefined();
    expect(screen.queryByText(/does not apply to you/)).toBeNull();
    expect(id).toMatch(/^pol_/);
  });

  it('shows a 422 detail next to the mode, verbatim, and keeps the draft', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const role = freshRole();
    const expose: Exposed = { current: undefined };
    render(
      <Probe options={options(rec, h.tokens.admin, { roles: [{ id: role }] })} expose={expose} />
    );
    await tableShown();
    await userEvent.selectOptions(
      within(cellOf('mcp:tracker:search', role)).getByRole('combobox', {
        name: `No policy for ${role} on mcp:tracker:search`,
      }),
      'ask'
    );
    await userEvent.click(
      await screen.findByRole('button', { name: `Simulate ${role} · mcp:tracker:search` })
    );
    const mode = await within(await openPolicy()).findByRole('combobox', { name: 'Mode' });
    await userEvent.selectOptions(mode, 'not_granted');
    await userEvent.click(within(await openPolicy()).getByRole('button', { name: 'Save draft' }));
    const refused = await screen.findByText(/config\.mode: not_granted is provisional/);
    // Next to the mode: after its control, before the next field set.
    expect(mode.compareDocumentPosition(refused) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(refused.closest('.nc-perm-refused')).not.toBeNull();
    expect((mode as HTMLSelectElement).value).toBe('not_granted');
  });

  it('links the governing policy of a 409', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const expose: Exposed = { current: undefined };
    render(<Probe options={options(rec, h.tokens.admin)} expose={expose} />);
    await tableShown();
    const created = await expose.current?.create({
      kind: 'tool_invocation',
      name: 'Members deny search',
      subjects: [{ type: 'role', id: 'member' }],
      targets: ['mcp:tracker:search'],
      config: { mode: 'deny' },
    });
    expect(created?.ok).toBe(true);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Simulate Members deny search' })
    );
    await userEvent.click(
      await within(await openPolicy()).findByRole('button', { name: 'Publish' })
    );
    const link = await screen.findByRole('button', { name: 'Open Ask the members before a call' });
    await userEvent.click(link);
    await screen.findByRole('heading', { name: 'Policy: Ask the members before a call' });
  });

  it('links the governing policy of a 409 from the Drafts tray, and says which publish failed', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const expose: Exposed = { current: undefined };
    render(<Probe options={options(rec, h.tokens.admin)} expose={expose} />);
    await tableShown();
    const created = await expose.current?.create({
      kind: 'tool_invocation',
      name: 'Members ask again',
      subjects: [{ type: 'role', id: 'member' }],
      targets: ['mcp:tracker:create_issue'],
      config: { mode: 'deny' },
    });
    expect(created?.ok).toBe(true);
    await userEvent.click(await screen.findByRole('button', { name: 'Publish Members ask again' }));
    const alert = await screen.findByText('While publishing Members ask again.');
    const box = alert.closest('[role="alert"]');
    if (!(box instanceof HTMLElement)) throw new Error('no alert');
    await userEvent.click(
      within(box).getByRole('button', { name: 'Open Ask the members before a call' })
    );
    await screen.findByRole('heading', { name: 'Policy: Ask the members before a call' });
  });

  it('shows a refusal of a member the editor does not show at the top, never nowhere', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const expose: Exposed = { current: undefined };
    render(<Probe options={options(rec, h.tokens.admin)} expose={expose} />);
    await tableShown();
    const role = freshRole();
    const created = await expose.current?.create({
      kind: 'tool_invocation',
      name: 'Refused by kind',
      subjects: [{ type: 'role', id: role }],
      targets: ['mcp:tracker:search'],
      config: { mode: 'ask' },
    });
    if (created?.ok !== true) throw new Error('create failed');
    rec.intercept((c) =>
      c.method === 'PUT' && c.path === `/v1/policies/${created.policy.id}`
        ? new Response(
            JSON.stringify({
              type: 'https://x/problems/unsupported_policy_form',
              title: 'refused',
              status: 422,
              detail: 'kind: this deployment does not implement it',
              request_id: 'req_k',
            }),
            { status: 422, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Simulate Refused by kind' }));
    const name = await within(await openPolicy()).findByRole('textbox', { name: 'Name' });
    await userEvent.type(name, '!');
    await userEvent.click(within(await openPolicy()).getByRole('button', { name: 'Save draft' }));
    const shown = await screen.findByText(
      'The service cannot enforce this form: kind: this deployment does not implement it'
    );
    expect(shown.closest('[role="alert"]')).not.toBeNull();
  });

  it('keeps the approver groups field to what will be saved across a mode change', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const expose: Exposed = { current: undefined };
    render(<Probe options={options(rec, h.tokens.admin)} expose={expose} />);
    await tableShown();
    const created = await expose.current?.create({
      kind: 'tool_invocation',
      name: 'Groups draft',
      subjects: [{ type: 'role', id: freshRole() }],
      targets: ['mcp:tracker:search'],
      config: { mode: 'ask' },
    });
    if (created?.ok !== true) throw new Error('create failed');
    await userEvent.click(await screen.findByRole('button', { name: 'Simulate Groups draft' }));
    const groups = await within(await openPolicy()).findByRole('textbox', {
      name: /Approver groups/,
    });
    await userEvent.type(groups, 'ops, finance');
    expect(screen.getByText('Approver groups: ops, finance')).toBeDefined();
    const mode = within(await openPolicy()).getByRole('combobox', { name: 'Mode' });
    await userEvent.selectOptions(mode, 'deny');
    await userEvent.selectOptions(mode, 'ask');
    expect(
      within(await openPolicy()).getByRole<HTMLInputElement>('textbox', { name: /Approver groups/ })
        .value
    ).toBe('');
    expect(screen.getByText('No approver groups: any eligible approver.')).toBeDefined();
  });

  it('says a cell opened the editor because its policy has a draft the table does not show', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const role = freshRole();
    const expose: Exposed = { current: undefined };
    render(
      <Probe options={options(rec, h.tokens.admin, { roles: [{ id: role }] })} expose={expose} />
    );
    await tableShown();
    const created = await expose.current?.create({
      kind: 'tool_invocation',
      name: 'Sole policy',
      subjects: [{ type: 'role', id: role }],
      targets: ['ext:local:send_email'],
      config: { mode: 'ask' },
    });
    if (created?.ok !== true) throw new Error('create failed');
    expect((await expose.current?.publish(created.policy.id, created.policy))?.ok).toBe(true);
    await waitFor(() => {
      expect(cellOf('ext:local:send_email', role).getAttribute('data-state')).toBe('governed');
    });
    await call(h.baseUrl, h.tokens.admin, 'PUT', `/v1/policies/${created.policy.id}`, {
      kind: 'tool_invocation',
      subjects: [{ type: 'role', id: role }],
      targets: { tools: ['ext:local:send_email'] },
      config: { mode: 'escalate' },
    });
    await userEvent.selectOptions(
      within(cellOf('ext:local:send_email', role)).getByRole('combobox'),
      'deny'
    );
    await screen.findByText(/^Sole policy has a newer draft than this table shows/);
    await screen.findByRole('heading', { name: 'Policy: Sole policy' });
  });

  it('does not publish from the tray while the open editor holds unsaved changes (A6)', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const expose: Exposed = { current: undefined };
    render(<Probe options={options(rec, h.tokens.admin)} expose={expose} />);
    await tableShown();
    const created = await expose.current?.create({
      kind: 'tool_invocation',
      name: 'Dirty draft',
      subjects: [{ type: 'role', id: freshRole() }],
      targets: ['mcp:tracker:search'],
      config: { mode: 'ask' },
    });
    if (created?.ok !== true) throw new Error('create failed');
    await userEvent.click(await screen.findByRole('button', { name: 'Simulate Dirty draft' }));
    await userEvent.type(
      await within(await openPolicy()).findByRole('textbox', { name: 'Name' }),
      '!'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Publish Dirty draft' }));
    await screen.findByText('While publishing Dirty draft.');
    expect(screen.getAllByText('Save the draft before publishing it.').length).toBeGreaterThan(0);
    expect(rec.count('POST', `/v1/policies/${created.policy.id}/publish`)).toBe(0);
  });

  it('a 403 on a dry run is not explained as authoring (A3)', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.path.endsWith('/simulate')
        ? new Response(
            JSON.stringify({
              type: 'https://x/problems/forbidden',
              title: 'no',
              status: 403,
              request_id: 'req_f',
            }),
            { status: 403, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined
    );
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await tableShown();
    await userEvent.click(
      within(cellOf('mcp:tracker:search', 'member')).getByRole('button', {
        name: /: Edit Ask the members before a call$/,
      })
    );
    await userEvent.click(
      await within(await openPolicy()).findByRole('button', { name: 'Simulate' })
    );
    await screen.findByText('The service does not allow you to do this.');
    expect(
      screen.queryByText('Only an administrator of the organisation authors policies.')
    ).toBeNull();
  });

  it('marks a withdrawn tool and writes nothing from its cells; lists a target the tool list does not show', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/tools') return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: Record<string, unknown>[]; meta: unknown };
      return jsonResponse({
        ...body,
        data: body.data
          // The seeded pol_silent's only target, gone from the list.
          .filter((row) => row.tool_ref !== 'mcp:tracker:add_comment')
          .map((row) =>
            row.tool_ref === 'mcp:tracker:search'
              ? { ...row, status: 'withdrawn' }
              : row.tool_ref === 'mcp:tracker:create_issue'
                ? { ...row, status: 'paused' }
                : row
          ),
      });
    });
    const role = freshRole();
    render(<Probe options={options(rec, h.tokens.admin, { roles: [{ id: role }] })} />);
    await tableShown();
    const row = cellOf('mcp:tracker:search', 'member').parentElement;
    expect(row?.getAttribute('data-status')).toBe('withdrawn');
    expect(row?.querySelector('th')?.textContent).toContain('Withdrawn');
    // The policy that governs it is still shown, and no cell of the row has a control that writes.
    expect(cellOf('mcp:tracker:search', 'member').textContent).toContain('Ask');
    expect(within(cellOf('mcp:tracker:search', role)).queryByRole('combobox')).toBeNull();
    expect(within(cellOf('mcp:tracker:search', 'Organisation')).queryByRole('combobox')).toBeNull();
    // An unknown status is shown as sent, and the tool is treated as not callable: no cell writes.
    expect(cellOf('mcp:tracker:create_issue', 'member').parentElement?.textContent).toContain(
      'Status "paused"'
    );
    expect(within(cellOf('mcp:tracker:create_issue', role)).queryByRole('combobox')).toBeNull();
    // An active row is editable.
    expect(within(cellOf('ext:local:send_email', role)).getByRole('combobox')).toBeDefined();
    // A target with no row is listed with its policy.
    const unplaced = await screen.findByRole('heading', {
      name: 'Policies this table cannot place',
    });
    expect(unplaced.parentElement?.textContent).toContain(
      'Ask before a comment · Ask: governs tools the tool list does not show: mcp:tracker:add_comment.'
    );
    expect(
      rec.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/v1/policies'))
    ).toEqual([]);
  });

  it('opens a policy that governs only a withdrawn cell in the editor, where it is edited', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/tools') return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: Record<string, unknown>[]; meta: unknown };
      return jsonResponse({
        ...body,
        data: body.data.map((row) =>
          // pol_silent governs this one pair alone.
          row.tool_ref === 'mcp:tracker:add_comment' ? { ...row, status: 'withdrawn' } : row
        ),
      });
    });
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await tableShown();
    const withdrawnCell = cellOf('mcp:tracker:add_comment', 'member');
    expect(within(withdrawnCell).queryByRole('combobox')).toBeNull();
    await userEvent.click(
      within(withdrawnCell).getByRole('button', { name: /: Edit Ask before a comment$/ })
    );
    const panel = within(await openPolicy());
    await panel.findByRole('heading', { name: 'Policy: Ask before a comment' });
    // In the editor's tools and in the dry run's tool picker.
    expect(panel.getAllByText('mcp:tracker:add_comment (withdrawn)')).toHaveLength(2);
    expect(
      panel.getByRole('option', { name: 'mcp:tracker:add_comment (withdrawn)' })
    ).toBeDefined();
  });

  it('does not offer a withdrawn tool as a new target in the editor', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/tools') return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: Record<string, unknown>[]; meta: unknown };
      return jsonResponse({
        ...body,
        data: body.data.map((row) =>
          row.tool_ref === 'mcp:tracker:list_labels' ? { ...row, status: 'withdrawn' } : row
        ),
      });
    });
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await tableShown();
    await userEvent.click(
      within(cellOf('mcp:tracker:search', 'member')).getByRole('button', {
        name: /: Edit Ask the members before a call$/,
      })
    );
    const panel = within(await openPolicy());
    await panel.findByRole('checkbox', { name: 'mcp:tracker:search' });
    expect(panel.queryByText(/mcp:tracker:list_labels/)).toBeNull();
  });

  it("shows a policy's unenforced targets in the editor", async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/policies/pol_default') return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: Record<string, unknown> };
      return jsonResponse({
        ...body,
        data: { ...body.data, unenforced_targets: ['mcp:tracker:search'] },
      });
    });
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await tableShown();
    await userEvent.click(
      within(cellOf('mcp:tracker:search', 'member')).getByRole('button', {
        name: /: Edit Ask the members before a call$/,
      })
    );
    const panel = within(await openPolicy());
    expect(await panel.findByText('not enforced: mcp:tracker:search')).toBeDefined();
  });

  it('retires the policy of a cell after a confirm that says what it does, and the cell has no policy again', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const role = freshRole();
    render(<Probe options={options(rec, h.tokens.admin, { roles: [{ id: role }] })} />);
    await tableShown();
    await userEvent.selectOptions(
      within(cellOf('mcp:tracker:search', role)).getByRole('combobox', {
        name: `No policy for ${role} on mcp:tracker:search`,
      }),
      'deny'
    );
    // A cell with no published policy has nothing to retire.
    expect(
      within(cellOf('mcp:tracker:search', role)).queryByRole('option', {
        name: 'No policy (retire it)…',
      })
    ).toBeNull();
    await userEvent.click(
      await screen.findByRole('button', { name: `Publish ${role} · mcp:tracker:search` })
    );
    await waitFor(() => {
      expect(cellOf('mcp:tracker:search', role).getAttribute('data-state')).toBe('governed');
    });
    const control = (): HTMLElement =>
      within(cellOf('mcp:tracker:search', role)).getByRole('combobox', {
        name: `Deny for ${role} on mcp:tracker:search`,
      });
    // Keep it: nothing is sent.
    await userEvent.selectOptions(control(), 'nc:retire');
    let dialog = await screen.findByRole('dialog', {
      name: `Retire ${role} · mcp:tracker:search?`,
    });
    expect(dialog.textContent).toContain('Its history is kept.');
    expect(dialog.textContent).toContain('no new decision or approval names it');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(rec.count('POST', /\/retire$/)).toBe(0);
    expect(cellOf('mcp:tracker:search', role).getAttribute('data-state')).toBe('governed');
    await userEvent.selectOptions(control(), 'nc:retire');
    dialog = await screen.findByRole('dialog', { name: `Retire ${role} · mcp:tracker:search?` });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire' }));
    await waitFor(() => {
      expect(cellOf('mcp:tracker:search', role).getAttribute('data-state')).toBe('none');
    });
    expect(rec.count('POST', /\/retire$/)).toBe(1);
    expect(
      screen.getByText(`${role} · mcp:tracker:search was retired. Its history is kept.`)
    ).toBeDefined();
  });

  it('discards a draft from the tray after a confirm: a policy never published is deleted', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const role = freshRole();
    render(<Probe options={options(rec, h.tokens.admin, { roles: [{ id: role }] })} />);
    await tableShown();
    await userEvent.selectOptions(
      within(cellOf('mcp:tracker:search', role)).getByRole('combobox', {
        name: `No policy for ${role} on mcp:tracker:search`,
      }),
      'ask'
    );
    await waitFor(() => {
      expect(cellOf('mcp:tracker:search', role).textContent).toContain('Draft pending v1');
    });
    await userEvent.click(
      screen.getByRole('button', { name: `Discard the draft of ${role} · mcp:tracker:search` })
    );
    const dialog = await screen.findByRole('dialog', {
      name: `Delete ${role} · mcp:tracker:search?`,
    });
    expect(dialog.textContent).toContain('It was never published, so nothing enforces it.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => {
      expect(cellOf('mcp:tracker:search', role).textContent).not.toContain('Draft pending');
    });
    expect(rec.count('DELETE', /\/draft$/)).toBe(1);
    expect(
      screen.queryByRole('button', { name: `Discard the draft of ${role} · mcp:tracker:search` })
    ).toBeNull();
    expect(screen.getByText(`${role} · mcp:tracker:search was deleted.`)).toBeDefined();
  });

  it("discards a published policy's draft in its editor and keeps the policy; retiring it closes the editor", async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const role = freshRole();
    const expose: Exposed = { current: undefined };
    render(
      <Probe options={options(rec, h.tokens.admin, { roles: [{ id: role }] })} expose={expose} />
    );
    await tableShown();
    const created = await expose.current?.create({
      kind: 'tool_invocation',
      name: `Editor ${role}`,
      subjects: [{ type: 'role', id: role }, { type: 'organization' }],
      targets: ['mcp:tracker:search'],
      config: { mode: 'ask' },
    });
    if (created?.ok !== true) throw new Error('create failed');
    expect((await expose.current?.publish(created.policy.id, created.policy))?.ok).toBe(true);
    await waitFor(() => {
      expect(cellOf('mcp:tracker:search', role).getAttribute('data-state')).toBe('governed');
    });
    await userEvent.click(
      within(cellOf('mcp:tracker:search', role)).getByRole('button', {
        name: new RegExp(`: Edit Editor ${role}$`),
      })
    );
    let panel = await openPolicy();
    await within(panel).findByRole('textbox', { name: 'Name' });
    // Published, no draft: Retire, and nothing to discard.
    expect(within(panel).queryByRole('button', { name: 'Discard draft' })).toBeNull();
    expect(within(panel).queryByText(/does not offer retiring/)).toBeNull();
    await userEvent.click(within(panel).getByRole('combobox', { name: 'Mode' }));
    await userEvent.selectOptions(within(panel).getByRole('combobox', { name: 'Mode' }), 'deny');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save draft' }));
    await within(panel).findByRole('button', { name: 'Discard draft' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Discard draft' }));
    let dialog = await screen.findByRole('dialog', { name: `Discard draft v2 of Editor ${role}?` });
    expect(dialog.textContent).toContain('The published version stays in force');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    panel = await openPolicy();
    await within(panel).findByText(`The draft of Editor ${role} was discarded.`);
    await waitFor(() => {
      expect(within(panel).queryByRole('button', { name: 'Discard draft' })).toBeNull();
    });
    expect(cellOf('mcp:tracker:search', role).querySelector('.nc-perm-mode')?.textContent).toBe(
      'Ask'
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Retire policy' }));
    dialog = await screen.findByRole('dialog', { name: `Retire Editor ${role}?` });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire' }));
    await waitFor(() => {
      expect(document.querySelector('.nc-perm-open')).toBeNull();
    });
    expect(screen.getByText(`Editor ${role} was retired. Its history is kept.`)).toBeDefined();
    await waitFor(() => {
      expect(cellOf('mcp:tracker:search', role).getAttribute('data-state')).toBe('none');
    });
  });

  it('renders host-supplied subject UI in the panel of other subjects, and the host display name beside each subject', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const expose: Exposed = { current: undefined };
    const user = `user_${String(++unique)}`;
    const seen: { entries: number; opened?: string } = { entries: -1 };
    render(
      <Probe
        options={options(rec, h.tokens.admin)}
        expose={expose}
        extra={{
          subjectLabel: (subject) =>
            subject.type === 'user' && subject.id === user ? 'Dana\u200B Reyes' : undefined,
          renderSubjects: ({ controller, entries, openPolicy }) => {
            seen.entries = entries.length;
            const mine = entries.find((e) => e.subject.id === user);
            return (
              <div data-testid="host-subjects">
                <span>{`${String(controller.policies.length)} policies`}</span>
                {mine === undefined ? null : (
                  <button
                    type="button"
                    onClick={() => {
                      seen.opened = mine.policy.id;
                      openPolicy(mine.policy.id);
                    }}
                  >
                    Host opens it
                  </button>
                )}
              </div>
            );
          },
        }}
      />
    );
    await tableShown();
    const created = await expose.current?.create({
      kind: 'tool_invocation',
      name: `For ${user}`,
      subjects: [{ type: 'user', id: user }],
      targets: ['mcp:tracker:search'],
      config: { mode: 'deny' },
    });
    if (created?.ok !== true) throw new Error('create failed');
    expect((await expose.current?.publish(created.policy.id, created.policy))?.ok).toBe(true);
    const slot = await screen.findByTestId('host-subjects');
    const panel = slot.closest('section');
    if (panel === null) throw new Error('no panel');
    expect(within(panel).getByRole('heading').textContent).toBe(
      'Policies for users, agents and groups'
    );
    // The host's name is shown beside the type and id, its invisible characters escaped.
    await waitFor(() => {
      expect(panel.textContent).toContain(`Dana\\u200B Reyes (user ${user})`);
    });
    expect(seen.entries).toBeGreaterThan(0);
    await userEvent.click(within(slot).getByRole('button', { name: 'Host opens it' }));
    const open = await openPolicy();
    expect(seen.opened).toBe(created.policy.id);
    expect(open.textContent).toContain(`Dana\\u200B Reyes (user ${user})`);
  });

  it('a PolicyEditor on its own, with no onRemoved, says a retired policy was retired in its place', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const expose: Exposed = { current: undefined };
    const role = freshRole();
    function Alone(props: { readonly policyId: string }) {
      const controller = usePolicies(options(rec, h.tokens.admin));
      expose.current = controller;
      return props.policyId === '' ? null : (
        <PolicyEditor controller={controller} policyId={props.policyId} />
      );
    }
    const { rerender } = render(<Alone policyId="" />);
    await waitFor(() => {
      expect(expose.current?.status).toBe('ready');
    });
    const created = await expose.current?.create({
      kind: 'tool_invocation',
      name: `Alone ${role}`,
      subjects: [{ type: 'role', id: role }],
      targets: ['mcp:tracker:search'],
      config: { mode: 'ask' },
    });
    if (created?.ok !== true) throw new Error('create failed');
    const id = created.policy.id;
    expect((await expose.current?.publish(id, created.policy))?.ok).toBe(true);
    rerender(<Alone policyId={id} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retire policy' }));
    const dialog = await screen.findByRole('dialog', { name: `Retire Alone ${role}?` });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire' }));
    expect(
      await screen.findByText(`Alone ${role} was retired. Its history is kept.`)
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retire policy' })).toBeNull();
    expect(
      screen.queryByText('This draft changed since you opened it.', { exact: false })
    ).toBeNull();
  });

  it('turns read-only after a 403 on a write, and says why', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const role = freshRole();
    render(<Probe options={options(rec, h.tokens.member, { roles: [{ id: role }] })} />);
    await tableShown();
    await userEvent.selectOptions(
      within(cellOf('mcp:tracker:search', role)).getByRole('combobox', {
        name: `No policy for ${role} on mcp:tracker:search`,
      }),
      'deny'
    );
    await screen.findByText(
      'Only an administrator of the organisation authors policies. Editing is off.'
    );
    expect(screen.queryAllByRole('combobox')).toEqual([]);
  });
});

describe('X1: a service that offers neither authoring nor publishing', () => {
  it('shows the version, no Publish control and no alert', async () => {
    const rec = recorder(inProcessFetch(edge.mock));
    render(<Probe options={options(rec, edge.tokens.admin, {}, edge)} />);
    await tableShown();
    expect(screen.getByText('Policies can be read here but not authored.')).toBeDefined();
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    await userEvent.click(
      within(cellOf('mcp:tracker:search', 'member')).getByRole('button', {
        name: /: Open Ask the members before a call$/,
      })
    );
    expect((await screen.findAllByText(/^v3 · published /)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryAllByRole('alert')).toEqual([]);
    expect(
      rec.calls.filter(
        (c) =>
          c.method !== 'GET' && c.path.startsWith('/v1/policies') && !c.path.endsWith('/simulate')
      )
    ).toEqual([]);
  });
});

describe('a service that offers authoring but not publishing', () => {
  it('saves a draft, shows its version, and offers no Publish', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.path === '/v1/capabilities'
        ? new Response(
            JSON.stringify({
              data: {
                features: ['policies', 'policies.author'],
                entitlements: [],
                resolutions: [],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        : undefined
    );
    const expose: Exposed = { current: undefined };
    render(<Probe options={options(rec, h.tokens.admin)} expose={expose} />);
    await tableShown();
    const created = await expose.current?.create({
      kind: 'tool_invocation',
      name: 'Unpublishable',
      subjects: [{ type: 'role', id: freshRole() }],
      targets: ['mcp:tracker:search'],
      config: { mode: 'ask' },
    });
    if (created?.ok !== true) throw new Error('create failed');
    await userEvent.click(await screen.findByRole('button', { name: 'Simulate Unpublishable' }));
    await within(await openPolicy()).findByRole('textbox', { name: 'Name' });
    expect(screen.getAllByText('v1 · draft').length).toBeGreaterThan(0);
    expect(within(await openPolicy()).getByRole('button', { name: 'Save draft' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Publish / })).toBeNull();
    expect(screen.queryAllByRole('alert')).toEqual([]);
    // Without policies.retire nothing is retired or discarded, and the editor says so.
    const panel = await openPolicy();
    expect(
      within(panel).getByText(
        'This service does not offer retiring a policy or discarding a draft.'
      )
    ).toBeDefined();
    expect(within(panel).queryByRole('button', { name: 'Discard draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Discard the draft of / })).toBeNull();
  });
});

describe('a service that does not serve policies', () => {
  it('shows a neutral empty state', async () => {
    const harness = await startHarness({ advertise: ['runs'] });
    try {
      const rec = recorder(inProcessFetch(harness.mock));
      render(<Probe options={options(rec, harness.tokens.admin, {}, harness)} />);
      await screen.findByText('Policies are not offered here');
      expect(screen.queryAllByRole('alert')).toEqual([]);
    } finally {
      await harness.stop();
    }
  });
});

/** A replaced primitive: marked, so a test can tell it from the theme's. */
function MarkedButton({ variant, loading, ...props }: ButtonProps) {
  return <button data-replaced="button" data-variant={variant} data-loading={loading} {...props} />;
}
function MarkedSelect({
  options: choices,
  placeholder,
  onValueChange,
  onChange,
  ...props
}: SelectProps) {
  return (
    <select
      data-replaced="select"
      data-placeholder={placeholder}
      onChange={(event) => {
        onChange?.(event);
        onValueChange?.(event.currentTarget.value);
      }}
      {...props}
    >
      {choices?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

describe('slots', () => {
  async function renderOpen(
    wrap: (node: ReactNode) => ReactNode,
    extra: Partial<PermissionsProps>
  ) {
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(
      wrap(<Probe options={options(rec, h.tokens.admin)} extra={extra} />)
    );
    await tableShown();
    await userEvent.click(
      within(cellOf('mcp:tracker:search', 'member')).getByRole('button', {
        name: /: Edit Ask the members before a call$/,
      })
    );
    await within(await openPolicy()).findByRole('textbox', { name: 'Name' });
    return container;
  }

  it.each([
    [
      'NcProvider',
      (node: ReactNode) => (
        <NcProvider components={{ Button: MarkedButton, Select: MarkedSelect }}>{node}</NcProvider>
      ),
      {},
    ],
    [
      'the components prop',
      (node: ReactNode) => node,
      { components: { Button: MarkedButton, Select: MarkedSelect } },
    ],
  ] as const)(
    'a replaced Button and Select through %s reach every control',
    async (_name, wrap, extra) => {
      const container = await renderOpen(wrap, extra);
      const buttons = [...container.querySelectorAll('button')];
      const selects = [...container.querySelectorAll('select')];
      expect(buttons.length).toBeGreaterThan(3);
      expect(selects.length).toBeGreaterThan(3);
      expect(buttons.filter((b) => b.dataset.replaced !== 'button')).toEqual([]);
      expect(selects.filter((s) => s.dataset.replaced !== 'select')).toEqual([]);
    }
  );
});

describe('ModeLegend', () => {
  it('shows each mode with its wire decision and marks the provisional one', async () => {
    const { container } = render(<ModeLegend />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('code')?.textContent)).toEqual([
      'allow',
      'step_up',
      'step_up, routing escalated',
      'deny',
      'deny, reason not_granted',
    ]);
    expect(rows[4]?.textContent).toContain('Provisional in the contract.');
    expect(rows[1]?.textContent).toContain('never the principal that made the call');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('takes the host words', () => {
    render(<ModeLegend labels={{ mode_ask: 'Needs approval' }} />);
    expect(screen.getByRole('rowheader', { name: 'Needs approval' })).toBeDefined();
  });
});

describe('refusedField', () => {
  it.each([
    ['config.mode: not_granted is provisional', 'mode'],
    ['subjects: a duplicate_requests policy takes the organization subject only.', 'subjects'],
    ['subjects[0].type: user is not enforced', 'subjects'],
    ['config.approver_groups: not enforced', 'approver_groups'],
    ['targets: every tool', 'targets'],
    ['something else entirely', undefined],
  ])('%s → %s', (detail, field) => {
    expect(
      refusedField({ kind: 'unprocessable', code: 'unsupported_policy_form', title: 'x', detail })
    ).toBe(field);
  });

  it('reads only a refusal', () => {
    expect(
      refusedField({ kind: 'forbidden', code: 'forbidden', title: 'x', detail: 'name: x' })
    ).toBe(undefined);
  });
});
