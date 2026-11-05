// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ConnectionsController, UseConnectionsOptions } from '../connections-types.js';
import { axe } from '../testing/axe.js';
import {
  call,
  inProcessFetch,
  jsonResponse,
  recorder,
  startHarness,
} from '../testing/approvals-harness.js';
import type { Harness, Recorder } from '../testing/approvals-harness.js';
import { fakeConnectionsController } from '../testing/connections-fake.js';
import { useConnections } from '../use-connections.js';
import { ConnectionDetail } from './Connections.js';

/**
 * The tool facts editor on the real hook over the in-process mock, and its gate on a controller that says what the
 * service advertises and who the caller is.
 */
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});
afterEach(cleanup);

let unique = 0;

/** Registers a server and its tools as the administrator and returns its id. */
async function registeredWithTools(): Promise<string> {
  unique += 1;
  const created = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/connections', {
    name: `Facts ${String(unique)}`,
    url: `https://facts-ui-${String(unique)}.example.com/mcp`,
    transport: 'mcp',
    owner_kind: 'org',
  });
  const id = ((await created.json()) as { data: { id: string } }).data.id;
  const refreshed = await call(h.baseUrl, h.tokens.admin, 'POST', `/v1/connections/${id}/refresh`);
  if (refreshed.status !== 200) throw new Error(`refresh: ${String(refreshed.status)}`);
  return id;
}

function Detail(props: { readonly id: string; readonly options: UseConnectionsOptions }) {
  const controller = useConnections(props.options);
  return <ConnectionDetail controller={controller} connectionId={props.id} />;
}

const options = (rec: Recorder, token: string = h.tokens.admin): UseConnectionsOptions => ({
  baseUrl: h.baseUrl,
  getToken: () => token,
  fetch: rec.fetch,
});

const patches = (rec: Recorder) =>
  rec.calls.filter((c) => c.method === 'PATCH' && c.path.startsWith('/v1/tools/'));

async function openEditor(user: ReturnType<typeof userEvent.setup>, container: HTMLElement) {
  const edit = (await within(container).findAllByRole('button', { name: /^Edit facts of / }))[0];
  if (edit === undefined) throw new Error('no edit action');
  await user.click(edit);
  const editor = container.querySelector('.nc-conn-tool-facts');
  if (!(editor instanceof HTMLElement)) throw new Error('editor not open');
  return editor;
}

describe('the tool facts editor over the real hook', { timeout: 20_000 }, () => {
  it('declares a fact, saves it, and shows the count; the request carries { facts } alone', async () => {
    const id = await registeredWithTools();
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Detail id={id} options={options(rec)} />);
    const editor = await openEditor(user, container);
    expect(within(editor).getByText('This tool declares no facts.')).toBeDefined();
    await user.click(within(editor).getByRole('button', { name: 'Add a fact' }));
    await user.type(within(editor).getByLabelText('Name of fact 1'), 'amount');
    await user.type(within(editor).getByLabelText('Path of fact 1'), '.amount');
    await user.selectOptions(within(editor).getByLabelText('Type of fact 1'), 'number');
    await user.type(within(editor).getByLabelText('Description of fact 1'), 'how much');
    expect((await axe(container)).violations).toEqual([]);
    await user.click(within(editor).getByRole('button', { name: 'Save facts' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/^The facts of .* are saved\.$/);
    });
    expect(patches(rec).map((c) => c.body)).toEqual([
      { facts: { amount: { path: '.amount', type: 'number', description: 'how much' } } },
    ]);
    expect(container.querySelector('.nc-conn-tool-facts')).toBeNull();
    expect(within(container).getAllByText('1 declared')).toHaveLength(1);
  });

  it('marks each refused field and sends nothing until the rows are fixed', async () => {
    const id = await registeredWithTools();
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Detail id={id} options={options(rec)} />);
    const editor = await openEditor(user, container);
    await user.click(within(editor).getByRole('button', { name: 'Add a fact' }));
    await user.type(within(editor).getByLabelText('Name of fact 1'), 'Amount');
    await user.type(within(editor).getByLabelText('Path of fact 1'), '.items[[*].price');
    await user.click(within(editor).getByRole('button', { name: 'Save facts' }));
    expect(await within(editor).findByText(/A name starts with a lower-case letter/)).toBeDefined();
    expect(within(editor).getByText(/A wildcard \[\*\] or \.\. is not allowed/)).toBeDefined();
    expect(within(editor).getByText('Choose a type.')).toBeDefined();
    expect(within(editor).getByText('Fix the marked facts before saving.')).toBeDefined();
    expect(within(editor).getByLabelText('Name of fact 1').getAttribute('aria-invalid')).toBe(
      'true'
    );
    expect(patches(rec)).toEqual([]);
    // Fixing the rows clears the marks without another click.
    await user.clear(within(editor).getByLabelText('Name of fact 1'));
    await user.type(within(editor).getByLabelText('Name of fact 1'), 'amount');
    await user.clear(within(editor).getByLabelText('Path of fact 1'));
    await user.type(within(editor).getByLabelText('Path of fact 1'), '.amount');
    await user.selectOptions(within(editor).getByLabelText('Type of fact 1'), 'count');
    expect(within(editor).queryByText('Fix the marked facts before saving.')).toBeNull();
  });

  it('shows the service refusal of a fact at its row, from the problem member', async () => {
    const id = await registeredWithTools();
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.method === 'PATCH'
        ? new Response(
            JSON.stringify({
              type: 'https://x/problems/invalid_request',
              title: 'invalid',
              status: 400,
              detail: 'the path selects nothing the deployment reads',
              member: 'facts.second.path',
            }),
            { status: 400, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined
    );
    const { container } = render(<Detail id={id} options={options(rec)} />);
    const editor = await openEditor(user, container);
    for (const [row, name] of [
      [1, 'first'],
      [2, 'second'],
    ] as const) {
      await user.click(within(editor).getByRole('button', { name: 'Add a fact' }));
      await user.type(within(editor).getByLabelText(`Name of fact ${String(row)}`), name);
      await user.type(within(editor).getByLabelText(`Path of fact ${String(row)}`), '.a');
      await user.selectOptions(
        within(editor).getByLabelText(`Type of fact ${String(row)}`),
        'string'
      );
    }
    await user.click(within(editor).getByRole('button', { name: 'Save facts' }));
    const message = await within(editor).findByText(
      'The service refused this fact: the path selects nothing the deployment reads'
    );
    expect(message).toBeDefined();
    // It sits at the second row's path, and the first row is unmarked.
    expect(within(editor).getByLabelText('Path of fact 2').getAttribute('aria-invalid')).toBe(
      'true'
    );
    expect(within(editor).getByLabelText('Path of fact 1').getAttribute('aria-invalid')).toBeNull();
    // The editor stays open so the person can fix it.
    expect(container.querySelector('.nc-conn-tool-facts')).not.toBeNull();
  });

  it('removing every row and saving clears the facts with null', async () => {
    const id = await registeredWithTools();
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Detail id={id} options={options(rec)} />);
    let editor = await openEditor(user, container);
    await user.click(within(editor).getByRole('button', { name: 'Add a fact' }));
    await user.type(within(editor).getByLabelText('Name of fact 1'), 'amount');
    await user.type(within(editor).getByLabelText('Path of fact 1'), '.amount');
    await user.selectOptions(within(editor).getByLabelText('Type of fact 1'), 'number');
    await user.click(within(editor).getByRole('button', { name: 'Save facts' }));
    await waitFor(() => {
      expect(patches(rec)).toHaveLength(1);
    });
    editor = await openEditor(user, container);
    expect(within(editor).getByLabelText<HTMLInputElement>('Name of fact 1').value).toBe('amount');
    await user.click(within(editor).getByRole('button', { name: 'Remove fact 1' }));
    await user.click(within(editor).getByRole('button', { name: 'Save facts' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/are removed\.$/);
    });
    expect(patches(rec).map((c) => c.body)).toEqual([
      { facts: { amount: { path: '.amount', type: 'number' } } },
      { facts: null },
    ]);
  });

  it('Cancel closes the editor and sends nothing', async () => {
    const id = await registeredWithTools();
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Detail id={id} options={options(rec)} />);
    const editor = await openEditor(user, container);
    await user.click(within(editor).getByRole('button', { name: 'Add a fact' }));
    await user.click(within(editor).getByRole('button', { name: 'Cancel' }));
    expect(container.querySelector('.nc-conn-tool-facts')).toBeNull();
    expect(patches(rec)).toEqual([]);
  });

  it('offers no editing to a caller the host says is not an administrator', async () => {
    const id = await registeredWithTools();
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(
      <Detail id={id} options={{ ...options(rec, h.tokens.member), readOnly: true }} />
    );
    await within(container).findByRole('table', { name: /^Tools of / });
    expect(within(container).queryByRole('columnheader', { name: 'Facts' })).toBeNull();
    expect(within(container).queryAllByRole('button', { name: /^Edit facts/ })).toEqual([]);
  });

  it('offers no editing when the service does not advertise tools.facts', async () => {
    const id = await registeredWithTools();
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/capabilities') return undefined;
      const real = (await (await inProcessFetch(h.mock)(request)).json()) as {
        data: { features: string[] };
      };
      return jsonResponse({
        ...real,
        data: { ...real.data, features: real.data.features.filter((f) => f !== 'tools.facts') },
      });
    });
    const { container } = render(<Detail id={id} options={options(rec)} />);
    await within(container).findByRole('table', { name: /^Tools of / });
    expect(within(container).queryByRole('columnheader', { name: 'Facts' })).toBeNull();
    expect(within(container).queryAllByRole('button', { name: /^Edit facts/ })).toEqual([]);
  });
});

describe('the Facts column on a controller that states what is offered', () => {
  function detailOf(controller: ConnectionsController) {
    return render(<ConnectionDetail controller={controller} connectionId="conn_tracker" />);
  }

  it('shows the action to an administrator where tools.facts is advertised', async () => {
    const base = fakeConnectionsController();
    const { container } = detailOf(
      fakeConnectionsController({ facts: { ...baseFacts(base), toolFacts: true } })
    );
    expect(await within(container).findByRole('columnheader', { name: 'Facts' })).toBeDefined();
    expect(within(container).getAllByRole('button', { name: /^Edit facts of / }).length).toBe(3);
  });

  it('shows nothing where it is not advertised, and nothing to a read-only caller', async () => {
    const base = fakeConnectionsController();
    const without = detailOf(fakeConnectionsController());
    await within(without.container).findByRole('table', { name: /^Tools of / });
    expect(within(without.container).queryByRole('columnheader', { name: 'Facts' })).toBeNull();
    without.unmount();
    const readOnly = detailOf(
      fakeConnectionsController({
        facts: { ...baseFacts(base), toolFacts: true },
        administration: { readOnly: true, reason: 'host' },
      })
    );
    await within(readOnly.container).findByRole('table', { name: /^Tools of / });
    expect(within(readOnly.container).queryByRole('columnheader', { name: 'Facts' })).toBeNull();
  });
});

function baseFacts(controller: ConnectionsController) {
  const facts = controller.facts;
  if (facts === undefined) throw new Error('no facts');
  return facts;
}
