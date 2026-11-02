// @vitest-environment jsdom
import type { ButtonProps } from '@noblecloak/theme';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ConnectionsController, UseConnectionsOptions } from '../connections-types.js';
import { axe } from '../testing/axe.js';
import {
  call,
  inProcessFetch,
  problemResponse,
  recorder,
  startHarness,
} from '../testing/approvals-harness.js';
import type { Harness, Recorder } from '../testing/approvals-harness.js';
import { WAITING_KEY } from '../connections-store.js';
import { NcProvider } from '../slots.js';
import { useConnections } from '../use-connections.js';
import { AddConnection, ConnectionDetail, Connections } from './Connections.js';
import type { ConnectionsProps } from './Connections.js';

/**
 * The components on the real hook over the in-process mock: what the person sees after a choice is what the store did,
 * with no fake controller between them.
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
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
});

interface Exposed {
  current: ConnectionsController | undefined;
}

function Probe(props: {
  readonly options: UseConnectionsOptions;
  readonly expose?: Exposed;
  readonly extra?: Partial<ConnectionsProps>;
}) {
  const controller = useConnections(props.options);
  if (props.expose !== undefined) props.expose.current = controller;
  return <Connections controller={controller} {...props.extra} />;
}

let unique = 0;
const server = (): string => {
  unique += 1;
  return `https://ui-${String(unique)}.example.com/mcp`;
};

function options(
  rec: Recorder,
  token: string,
  extra: Partial<UseConnectionsOptions> = {},
  harness: Harness = h
): UseConnectionsOptions {
  return {
    baseUrl: harness.baseUrl,
    getToken: () => token,
    fetch: rec.fetch,
    returnTo: 'https://module.mock.test/connections',
    onNavigate: () => undefined,
    ...extra,
  };
}

/** Registers a server as the administrator, straight through the API. */
async function registered(body: Record<string, unknown>): Promise<string> {
  const response = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/connections', {
    transport: 'mcp',
    owner_kind: 'org',
    ...body,
  });
  if (response.status !== 201) throw new Error(`register: ${String(response.status)}`);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

/** Completes an OAuth authorization of `id` as the administrator, through the mock's consent page. */
async function authorizedThroughConsent(id: string): Promise<void> {
  const started = await call(h.baseUrl, h.tokens.admin, 'POST', `/v1/connections/${id}/authorize`, {
    return_to: 'https://module.mock.test/connections',
  });
  if (started.status !== 200) throw new Error(`authorize: ${String(started.status)}`);
  const { data } = (await started.json()) as { data: { authorization_url: string } };
  const consent = await h.mock.app.request(new URL(data.authorization_url).pathname);
  if (consent.status !== 302) throw new Error(`consent: ${String(consent.status)}`);
}

const panel = (): Promise<HTMLElement> =>
  waitFor(() => {
    const open = document.querySelector('.nc-conn-open');
    if (!(open instanceof HTMLElement)) throw new Error('no open registration');
    return open;
  });

describe('Connections over the real hook', { timeout: 20_000 }, () => {
  it('lists the registrations with their state and owner, and passes axe', async () => {
    const name = `listed ${String(++unique)}`;
    await registered({ name, url: server() });
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    const table = await screen.findByRole('table', { name: 'Registered tool servers' });
    const row = within(table)
      .getAllByRole('row')
      .find((r) => r.textContent.includes(name));
    expect(row?.textContent).toContain('Connected');
    expect(row?.textContent).toContain('Organisation');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('registers a server from the form, opens it, and refreshes its tools', async () => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await user.click(await screen.findByRole('button', { name: 'Register a server' }));
    const form = screen.getByRole('form', { name: 'Register a tool server' });
    await user.type(within(form).getByLabelText('Name'), 'Tracker');
    await user.type(within(form).getByLabelText('Server URL'), server());
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    const open = await panel();
    expect(within(open).getByRole('heading', { name: 'Tracker' })).toBeDefined();
    await user.click(within(open).getByRole('button', { name: 'Refresh tools' }));
    await waitFor(() => {
      expect(document.querySelector('.nc-live')?.textContent).toContain(
        'The server offers 2 tools: 2 added, 0 withdrawn, 0 active again.'
      );
    });
    const tools = await within(open).findByRole('table', { name: 'Tools of Tracker' });
    expect(within(tools).getAllByText('Registered')).toHaveLength(2);
  });

  it('refuses a URL with a credential in it, and an http URL, without a request', async () => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await user.click(await screen.findByRole('button', { name: 'Register a server' }));
    const form = screen.getByRole('form', { name: 'Register a tool server' });
    await user.type(within(form).getByLabelText('Name'), 'x');
    await user.type(within(form).getByLabelText('Server URL'), 'https://u:p@x.example.com/mcp');
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    expect(await within(form).findByText('Leave credentials out of the URL.')).toBeDefined();
    await user.clear(within(form).getByLabelText('Server URL'));
    await user.type(within(form).getByLabelText('Server URL'), 'http://x.example.com/mcp');
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    expect(
      await within(form).findByText(
        'Enter an absolute https:// URL (http:// only to this machine).'
      )
    ).toBeDefined();
    expect(rec.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('registers a server on this machine over http', async () => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await user.click(await screen.findByRole('button', { name: 'Register a server' }));
    const form = screen.getByRole('form', { name: 'Register a tool server' });
    await user.type(within(form).getByLabelText('Name'), 'local');
    await user.type(
      within(form).getByLabelText('Server URL'),
      `http://localhost:${String(4000 + ++unique)}/mcp`
    );
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    expect(within(await panel()).getByRole('heading', { name: 'local' })).toBeDefined();
  });

  it('shows the existing registration a second registration of the same server names', async () => {
    const user = userEvent.setup();
    const url = server();
    await registered({ name: 'first', url });
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await user.click(await screen.findByRole('button', { name: 'Register a server' }));
    const form = screen.getByRole('form', { name: 'Register a tool server' });
    await user.type(within(form).getByLabelText('Name'), 'second');
    await user.type(within(form).getByLabelText('Server URL'), `${url}/`);
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    expect(
      await within(form).findByText('The organisation already has a registration of this server.')
    ).toBeDefined();
    await user.click(within(form).getByRole('button', { name: 'Open the existing registration' }));
    expect(within(await panel()).getByRole('heading', { name: 'first' })).toBeDefined();
  });

  it('a member links a bearer credential only after consenting, and the token is never shown again', async () => {
    const user = userEvent.setup();
    const name = `linkable ${String(++unique)}`;
    await registered({
      name,
      url: server(),
      auth: { kind: 'bearer' },
      credential_tier: 'per_user',
    });
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Probe options={options(rec, h.tokens.member)} />);
    await user.click(await screen.findByRole('button', { name: `Open ${name}` }));
    const open = await panel();
    const mine = within(open).getByRole('region', { name: 'My credential' });
    expect(within(mine).getByText('You have not linked a credential.')).toBeDefined();
    expect(within(mine).getByText(/the tools stay available to them/)).toBeDefined();
    await user.click(within(mine).getByRole('button', { name: 'Link my account' }));
    const consent = within(mine).getByRole('form', { name: 'Your consent' });
    const submit = within(consent).getByRole('button', { name: 'Link with my consent' });
    await user.type(within(consent).getByLabelText('My bearer token'), 'member-secret-token');
    // No link without the explicit consent.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.click(
      within(consent).getByRole('checkbox', { name: 'I consent to this use of my credential' })
    );
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    expect((await axe(container)).violations).toEqual([]);
    await user.click(submit);
    await waitFor(() => {
      expect(within(mine).getByTestId('nc-conn-my-state').textContent).toMatch(
        /^Your credential is linked/
      );
    });
    const sent = rec.calls.find((c) => c.method === 'POST' && c.path.endsWith('/link'));
    expect(sent?.body).toEqual({ consent: true, token: 'member-secret-token' });
    expect(container.innerHTML).not.toContain('member-secret-token');
    // Revoking consent says the tools stay available to others.
    await user.click(within(mine).getByRole('button', { name: 'Revoke my consent' }));
    const dialog = await screen.findByRole('dialog', { name: /^Revoke your consent/ });
    expect(dialog.textContent).toContain('The tools stay available to others.');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => {
      expect(within(mine).getByTestId('nc-conn-my-state').textContent).toBe(
        'You revoked your consent: your link is not used.'
      );
    });
    // The confirm dialog sits in the region too (jsdom keeps a closed dialog's buttons): click the region's own.
    const actions = mine.querySelector('.nc-conn-actions');
    if (!(actions instanceof HTMLElement)) throw new Error('no actions');
    await user.click(within(actions).getByRole('button', { name: 'Unlink' }));
    const unlink = await screen.findByRole('dialog', { name: /^Unlink your credential/ });
    await user.click(within(unlink).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => {
      expect(within(mine).getByTestId('nc-conn-my-state').textContent).toBe(
        'You have not linked a credential.'
      );
    });
  });

  it("a member gets no change controls after the service refuses one, and never the organisation's credential fields", async () => {
    const user = userEvent.setup();
    const name = `admins ${String(++unique)}`;
    await registered({ name, url: server() });
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.member)} />);
    await user.click(await screen.findByRole('button', { name: `Open ${name}` }));
    let open = await panel();
    await user.click(within(open).getByRole('button', { name: 'Refresh tools' }));
    expect(
      await within(open).findByText('Only an administrator of the organisation does this.')
    ).toBeDefined();
    await waitFor(() => {
      expect(
        screen.getByText(
          /Only an administrator of the organisation changes the organisation's registrations/
        )
      ).toBeDefined();
    });
    open = await panel();
    expect(within(open).queryByRole('button', { name: 'Delete registration' })).toBeNull();
    // Registration stays offered (any principal registers here), without the administrator's fields.
    await user.click(screen.getByRole('button', { name: 'Register a server' }));
    const form = screen.getByRole('form', { name: 'Register a tool server' });
    await user.selectOptions(
      within(form).getByLabelText('How the server authenticates callers'),
      'bearer'
    );
    expect(within(form).queryByLabelText('Whose credential calls use')).toBeNull();
  });

  it('takes the organisation credential out of the page before the registration is sent', async () => {
    const user = userEvent.setup();
    const base = inProcessFetch(h.mock);
    let seenDuring: string | undefined;
    const rec = recorder((input, init) => {
      // Read without consuming the request's body: the mock reads it next.
      const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
      const url = input instanceof Request ? input.url : String(input);
      if (method === 'POST' && new URL(url).pathname === '/v1/connections')
        seenDuring = document.body.innerHTML;
      return base(input, init);
    });
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await user.click(await screen.findByRole('button', { name: 'Register a server' }));
    const form = screen.getByRole('form', { name: 'Register a tool server' });
    await user.type(within(form).getByLabelText('Name'), 'shared');
    await user.type(within(form).getByLabelText('Server URL'), server());
    await user.selectOptions(
      within(form).getByLabelText('How the server authenticates callers'),
      'bearer'
    );
    await user.selectOptions(
      within(form).getByLabelText('Whose credential calls use'),
      'org_shared'
    );
    await user.type(
      within(form).getByLabelText('Organisation credential (bearer token)'),
      'org-secret-in-flight'
    );
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    await waitFor(() => {
      expect(seenDuring).toBeDefined();
    });
    expect(await screen.findByText('shared is registered.')).toBeDefined();
    expect(seenDuring).not.toContain('org-secret-in-flight');
  });

  it('sends the tier only while it is shown: a tier chosen for bearer is dropped when the server takes none', async () => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await user.click(await screen.findByRole('button', { name: 'Register a server' }));
    const form = screen.getByRole('form', { name: 'Register a tool server' });
    await user.type(within(form).getByLabelText('Name'), 'tiered');
    await user.type(within(form).getByLabelText('Server URL'), server());
    const auth = within(form).getByLabelText('How the server authenticates callers');
    await user.selectOptions(auth, 'bearer');
    await user.selectOptions(
      within(form).getByLabelText('Whose credential calls use'),
      'org_shared'
    );
    await user.selectOptions(auth, 'none');
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    await panel();
    const sent = rec.calls.find((c) => c.method === 'POST' && c.path === '/v1/connections');
    expect(sent?.body).not.toHaveProperty('credential_tier');
  });

  it('offers a member known not to be an administrator no bearer server where it would need the organisation credential', async () => {
    const user = userEvent.setup();
    const created = await call(edge.baseUrl, edge.tokens.admin, 'POST', '/v1/connections', {
      name: 'edge org',
      url: server(),
      transport: 'mcp',
      owner_kind: 'org',
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const rec = recorder(inProcessFetch(edge.mock));
    render(<Probe options={options(rec, edge.tokens.member, {}, edge)} />);
    await user.click(await screen.findByRole('button', { name: 'Open edge org' }));
    const open = await panel();
    await user.click(within(open).getByRole('button', { name: 'Refresh tools' }));
    await waitFor(() => {
      expect(
        screen.getByText(
          /Only an administrator of the organisation changes the organisation's registrations/
        )
      ).toBeDefined();
    });
    await user.click(screen.getByRole('button', { name: 'Register a server' }));
    const select = within(
      screen.getByRole('form', { name: 'Register a tool server' })
    ).getByLabelText('How the server authenticates callers');
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual(['none']);
    expect(id).not.toBe('');
  });

  it('reads a choice no longer offered as none, when the caller turns out not to be an administrator mid-form', async () => {
    const user = userEvent.setup();
    const name = `edge mid ${String(++unique)}`;
    await call(edge.baseUrl, edge.tokens.admin, 'POST', '/v1/connections', {
      name,
      url: server(),
      transport: 'mcp',
      owner_kind: 'org',
    });
    const rec = recorder(inProcessFetch(edge.mock));
    render(<Probe options={options(rec, edge.tokens.member, {}, edge)} />);
    await user.click(await screen.findByRole('button', { name: `Open ${name}` }));
    await user.click(screen.getByRole('button', { name: 'Register a server' }));
    const form = screen.getByRole('form', { name: 'Register a tool server' });
    const auth = within(form).getByLabelText('How the server authenticates callers');
    await user.selectOptions(auth, 'bearer');
    await user.click(within(await panel()).getByRole('button', { name: 'Refresh tools' }));
    await waitFor(() => {
      expect((auth as HTMLSelectElement).value).toBe('none');
    });
    await user.type(within(form).getByLabelText('Name'), 'plain');
    await user.type(within(form).getByLabelText('Server URL'), server());
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    await waitFor(() => {
      expect(rec.calls.some((c) => c.method === 'POST' && c.path === '/v1/connections')).toBe(true);
    });
    const sent = rec.calls.find((c) => c.method === 'POST' && c.path === '/v1/connections');
    expect(sent?.body).not.toHaveProperty('auth');
  });

  it('offers no OAuth where the service does not advertise it, and no link controls', async () => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(edge.mock));
    render(<Probe options={options(rec, edge.tokens.admin, {}, edge)} />);
    await user.click(await screen.findByRole('button', { name: 'Register a server' }));
    const select = within(
      screen.getByRole('form', { name: 'Register a tool server' })
    ).getByLabelText('How the server authenticates callers');
    const values = [...(select as HTMLSelectElement).options].map((o) => o.value);
    expect(values).toEqual(['none', 'bearer']);
    expect(screen.queryByRole('region', { name: 'My credential' })).toBeNull();
  });

  it('shows a neutral panel and reads no connection route where the family is not served', async () => {
    const off = await startHarness({ advertise: ['approvals'] });
    try {
      const rec = recorder(inProcessFetch(off.mock));
      const { container } = render(<Probe options={options(rec, off.tokens.admin, {}, off)} />);
      expect(await screen.findByText('Connections are not available here')).toBeDefined();
      expect(rec.calls.map((c) => c.path)).toEqual(['/v1/capabilities']);
      expect((await axe(container)).violations).toEqual([]);
    } finally {
      await off.stop();
    }
  });

  it('says what the OAuth round trip this browser started came back with, once, and takes it out of the address', async () => {
    const user = userEvent.setup();
    const name = `returned ${String(++unique)}`;
    const id = await registered({
      name,
      url: server(),
      auth: { kind: 'oauth' },
      credential_tier: 'org_shared',
    });
    window.sessionStorage.setItem(WAITING_KEY, JSON.stringify({ state: 'n1', connectionId: id }));
    window.history.replaceState(
      null,
      '',
      `/connections?nc_state=n1&nc_connection=${id}&nc_result=error&nc_error=consent_denied`
    );
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.admin)} />);
    expect(
      await screen.findByText(`Authorization of ${name} did not complete: consent was not given.`)
    ).toBeDefined();
    expect(window.location.search).toBe('');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/did not complete/)).toBeNull();
  });

  it('shows no notice for a crafted link, and no text of the address for an unknown code', async () => {
    const name = `crafted ${String(++unique)}`;
    const id = await registered({ name, url: server() });
    // No authorization of this browser waits: nothing is shown.
    window.history.replaceState(
      null,
      '',
      `/connections?nc_state=x&nc_connection=${id}&nc_result=error&nc_error=Call%20555-0100`
    );
    const rec = recorder(inProcessFetch(h.mock));
    const first = render(<Probe options={options(rec, h.tokens.admin)} />);
    await screen.findByRole('table', { name: 'Registered tool servers' });
    expect(screen.queryByText(/Authorization of/)).toBeNull();
    expect(window.location.search).toBe('');
    first.unmount();
    // One it started, coming back with a code outside the closed list: the generic words, nothing echoed.
    window.sessionStorage.setItem(WAITING_KEY, JSON.stringify({ state: 'n2', connectionId: id }));
    window.history.replaceState(
      null,
      '',
      `/connections?nc_state=n2&nc_connection=${id}&nc_result=error&nc_error=Call%20555-0100`
    );
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    expect(await screen.findByText(`Authorization of ${name} did not complete.`)).toBeDefined();
    expect(container.textContent).not.toContain('555');
  });

  it('replaces every button through one Button and takes the host labels', async () => {
    const name = `slots ${String(++unique)}`;
    await registered({ name, url: server() });
    const rec = recorder(inProcessFetch(h.mock));
    // The theme's own props are not a native button's: they are taken off before the rest is spread.
    const Button = (props: ButtonProps) => {
      const rest = { ...props };
      delete rest.variant;
      delete rest.loading;
      delete rest.size;
      return <button {...rest} data-host-button="true" />;
    };
    render(
      <NcProvider components={{ Button }}>
        <Probe
          options={options(rec, h.tokens.admin)}
          extra={{ labels: { heading: 'Tool servers', addOpen: 'Add one' } }}
        />
      </NcProvider>
    );
    expect(await screen.findByRole('heading', { name: 'Tool servers' })).toBeDefined();
    await screen.findByRole('button', { name: 'Add one' });
    const buttons = [...document.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons.every((b) => b.dataset.hostButton === 'true')).toBe(true);
  });
});

describe('the changes an administrator makes, and the round trips', { timeout: 20_000 }, () => {
  it('renames, replaces the organisation credential without showing it, and deletes after a confirm', async () => {
    const user = userEvent.setup();
    const name = `managed ${String(++unique)}`;
    await registered({
      name,
      url: server(),
      auth: { kind: 'bearer' },
      credential_tier: 'org_shared',
      org_credential: { token: 'first-org-token' },
    });
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await user.click(await screen.findByRole('button', { name: `Open ${name}` }));
    const open = await panel();
    expect(
      within(open).getByText(
        'Calls through this server use the organisation credential; there is nothing to link.'
      )
    ).toBeDefined();
    await user.click(within(open).getByRole('button', { name: 'Rename' }));
    const field = within(open).getByLabelText('New name');
    await user.clear(field);
    await user.type(field, `${name} renamed`);
    await user.click(within(open).getByRole('button', { name: 'Save name' }));
    await waitFor(() => {
      expect(document.querySelector('.nc-live')?.textContent).toBe(`Renamed to ${name} renamed.`);
    });
    await user.click(
      within(open).getByRole('button', { name: 'Replace the organisation credential' })
    );
    await user.type(
      within(open).getByLabelText('New organisation credential (bearer token)'),
      'second-org-token'
    );
    await user.click(within(open).getByRole('button', { name: 'Replace' }));
    await waitFor(() => {
      expect(document.querySelector('.nc-live')?.textContent).toContain('was replaced');
    });
    expect(
      rec.calls.find(
        (c) => c.method === 'PATCH' && JSON.stringify(c.body).includes('org_credential')
      )?.body
    ).toEqual({
      org_credential: { token: 'second-org-token' },
    });
    expect(container.innerHTML).not.toContain('second-org-token');
    await user.click(within(open).getByRole('button', { name: 'Delete registration' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain("Every user's link to it is removed.");
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(document.querySelector('.nc-live')?.textContent).toContain(
        'was deleted. Its tools are withdrawn.'
      );
    });
  });

  it("an OAuth link consents, then leaves for the authorization URL; the organisation's OAuth credential is the administrator's", async () => {
    const user = userEvent.setup();
    const mine = `mine oauth ${String(++unique)}`;
    const shared = `shared oauth ${String(++unique)}`;
    await registered({
      name: mine,
      url: server(),
      auth: { kind: 'oauth' },
      credential_tier: 'per_user',
    });
    await registered({
      name: shared,
      url: server(),
      auth: { kind: 'oauth' },
      credential_tier: 'org_shared',
    });
    const navigate = vi.fn();
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.admin, { onNavigate: navigate })} />);
    await user.click(await screen.findByRole('button', { name: `Open ${mine}` }));
    let open = await panel();
    const region = within(open).getByRole('region', { name: 'My credential' });
    await user.click(within(region).getByRole('button', { name: 'Link my account' }));
    const consent = within(region).getByRole('form', { name: 'Your consent' });
    expect(within(consent).queryByLabelText('My bearer token')).toBeNull();
    await user.click(
      within(consent).getByRole('checkbox', { name: 'I consent to this use of my credential' })
    );
    await user.click(
      within(consent).getByRole('button', { name: 'Consent and continue to authorize' })
    );
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(1);
    });
    expect(String(navigate.mock.calls[0]?.[0])).toContain('/__mock/consent/');
    await user.click(screen.getByRole('button', { name: `Open ${shared}` }));
    open = await panel();
    await user.click(
      within(open).getByRole('button', { name: 'Authorize the organisation credential' })
    );
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(2);
    });
  });

  it('authorizes a linked OAuth link and a connected organisation credential again, and keeps them in use meanwhile', async () => {
    const user = userEvent.setup();
    const mine = `reauth mine ${String(++unique)}`;
    const shared = `reauth shared ${String(++unique)}`;
    const mineId = await registered({
      name: mine,
      url: server(),
      auth: { kind: 'oauth' },
      credential_tier: 'per_user',
    });
    const sharedId = await registered({
      name: shared,
      url: server(),
      auth: { kind: 'oauth' },
      credential_tier: 'org_shared',
    });
    await call(h.baseUrl, h.tokens.admin, 'POST', `/v1/connections/${mineId}/link`, {
      consent: true,
    });
    await authorizedThroughConsent(mineId);
    await authorizedThroughConsent(sharedId);
    const navigate = vi.fn();
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.admin, { onNavigate: navigate })} />);
    const table = await screen.findByRole('table', { name: 'Registered tool servers' });
    // Both credentials work: the list offers no reconnect for them.
    expect(within(table).queryByRole('button', { name: `Reconnect ${mine}` })).toBeNull();
    expect(within(table).queryByRole('button', { name: `Reconnect ${shared}` })).toBeNull();
    await user.click(screen.getByRole('button', { name: `Open ${mine}` }));
    let open = await panel();
    const region = within(open).getByRole('region', { name: 'My credential' });
    expect(within(region).getByTestId('nc-conn-my-state').textContent).toContain('is linked');
    await user.click(within(region).getByRole('button', { name: 'Authorize my link again' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(1);
    });
    expect(String(navigate.mock.calls[0]?.[0])).toContain('/__mock/consent/');
    await user.click(screen.getByRole('button', { name: `Open ${shared}` }));
    open = await panel();
    await user.click(
      within(open).getByRole('button', { name: 'Authorize the organisation credential again' })
    );
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(2);
    });
    // Neither round trip has completed: the credentials in use stay in use.
    const after = (await (
      await call(h.baseUrl, h.tokens.admin, 'GET', `/v1/connections/${sharedId}`)
    ).json()) as { data: { status: string } };
    expect(after.data.status).toBe('connected');
  });

  it('offers Reconnect in the list where a credential is not in use: an OAuth link waiting is authorized at once, a revoked consent opens the registration', async () => {
    const user = userEvent.setup();
    const waiting = `waiting ${String(++unique)}`;
    const revoked = `revoked ${String(++unique)}`;
    const waitingId = await registered({
      name: waiting,
      url: server(),
      auth: { kind: 'oauth' },
      credential_tier: 'per_user',
    });
    const revokedId = await registered({
      name: revoked,
      url: server(),
      auth: { kind: 'bearer' },
      credential_tier: 'per_user',
    });
    await call(h.baseUrl, h.tokens.member, 'POST', `/v1/connections/${waitingId}/link`, {
      consent: true,
    });
    await call(h.baseUrl, h.tokens.member, 'POST', `/v1/connections/${revokedId}/link`, {
      consent: true,
      token: 'member-token',
    });
    await call(h.baseUrl, h.tokens.member, 'DELETE', `/v1/connections/${revokedId}/link/consent`);
    const navigate = vi.fn();
    const rec = recorder(inProcessFetch(h.mock));
    render(
      <Probe options={options(rec, h.tokens.member, { onNavigate: navigate, readOnly: true })} />
    );
    const table = await screen.findByRole('table', { name: 'Registered tool servers' });
    await user.click(within(table).getByRole('button', { name: `Reconnect ${waiting}` }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(1);
    });
    expect(document.querySelector('.nc-conn-open')).toBeNull();
    await user.click(within(table).getByRole('button', { name: `Reconnect ${revoked}` }));
    const open = await panel();
    expect(within(open).getByRole('heading', { name: revoked })).toBeDefined();
    expect(within(open).getByRole('button', { name: 'Give consent again' })).toBeDefined();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("shows a reconnect refused by the service in the list, as the caller's own act", async () => {
    const user = userEvent.setup();
    const name = `refused ${String(++unique)}`;
    const id = await registered({
      name,
      url: server(),
      auth: { kind: 'oauth' },
      credential_tier: 'per_user',
    });
    await call(h.baseUrl, h.tokens.member, 'POST', `/v1/connections/${id}/link`, {
      consent: true,
    });
    const rec = recorder(inProcessFetch(h.mock));
    render(
      <Probe
        options={options(rec, h.tokens.member, {
          // A return address the service does not admit: the authorization is refused with 400.
          returnTo: 'https://not-admitted.example.test/back',
          readOnly: true,
        })}
      />
    );
    const table = await screen.findByRole('table', { name: 'Registered tool servers' });
    await user.click(within(table).getByRole('button', { name: `Reconnect ${name}` }));
    expect(await screen.findByText(/The service refused the request/)).toBeDefined();
    // Dismissed, it is gone; opening a registration clears it too.
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/The service refused the request/)).toBeNull();
    await user.click(within(table).getByRole('button', { name: `Reconnect ${name}` }));
    expect(await screen.findByText(/The service refused the request/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: `Open ${name}` }));
    await waitFor(() => {
      expect(screen.queryByText(/The service refused the request/)).toBeNull();
    });
  });

  it("offers the host's catalog as tiles that fill in the form, and marks a server already registered", async () => {
    const user = userEvent.setup();
    const url = server();
    const known = server();
    // Written as the host might: another case and a trailing slash; still the same server.
    const knownAsWritten = known.replace('https://ui-', 'https://UI-') + '/';
    await registered({ name: `known ${String(++unique)}`, url: known });
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(
      <Probe
        options={options(rec, h.tokens.admin)}
        extra={{
          catalog: [
            {
              id: 'tracker',
              name: 'Tracker',
              url,
              description: 'Issues and boards.',
              authKind: 'oauth',
              oauth: { scopes: ['read', 'write'] },
            },
            { id: 'known', name: 'Known', url: knownAsWritten },
          ],
        }}
      />
    );
    const catalog = await screen.findByRole('region', { name: 'Catalog' });
    const tiles = within(catalog).getAllByRole('listitem');
    expect(tiles[0]?.textContent).toContain('Issues and boards.');
    expect(tiles[0]?.textContent).not.toContain('Registered');
    expect(tiles[1]?.textContent).toContain('Registered');
    expect((await axe(container)).violations).toEqual([]);
    await user.click(within(catalog).getByRole('button', { name: 'Connect Tracker' }));
    const form = screen.getByRole('form', { name: 'Register a tool server' });
    expect(within(form).getByLabelText<HTMLInputElement>('Name').value).toBe('Tracker');
    expect(within(form).getByLabelText<HTMLInputElement>('Server URL').value).toBe(url);
    expect(
      within(form).getByLabelText<HTMLInputElement>('OAuth scopes (space-separated, optional)')
        .value
    ).toBe('read write');
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    const open = await panel();
    expect(within(open).getByRole('heading', { name: 'Tracker' })).toBeDefined();
    const sent = rec.calls.find((c) => c.method === 'POST' && c.path === '/v1/connections');
    expect(sent?.body).toMatchObject({
      name: 'Tracker',
      url,
      auth: { kind: 'oauth', scopes: ['read', 'write'] },
    });
  });

  it("says when a preset's kind of authentication is not offered, instead of dropping it silently", async () => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(edge.mock));
    render(
      <Probe
        options={options(rec, edge.tokens.admin, {}, edge)}
        extra={{ catalog: [{ id: 'o', name: 'Needs OAuth', url: server(), authKind: 'oauth' }] }}
      />
    );
    await user.click(await screen.findByRole('button', { name: 'Connect Needs OAuth' }));
    expect(
      screen.getByText(/This server signs in with OAuth, which is not offered here\./)
    ).toBeDefined();
    // Once the person chooses a kind that is offered, the note has done its job.
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'How the server authenticates callers' }),
      'bearer'
    );
    expect(screen.queryByText(/which is not offered here/)).toBeNull();
  });

  it('asks to sign in again when the session has expired', async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn();
    render(
      <Probe
        options={{
          baseUrl: 'https://api.example.test',
          getToken: () => 't',
          fetch: () => Promise.resolve(problemResponse(401, 'invalid_token')),
        }}
        extra={{ onSignIn }}
      />
    );
    expect(await screen.findByText('Your session has expired.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('renders one registration and the form on their own', async () => {
    const name = `alone ${String(++unique)}`;
    const id = await registered({ name, url: server() });
    const rec = recorder(inProcessFetch(h.mock));
    function Parts() {
      const controller = useConnections(options(rec, h.tokens.admin));
      return (
        <>
          <ConnectionDetail controller={controller} connectionId={id} />
          <ConnectionDetail controller={controller} connectionId="conn_nowhere" />
          <AddConnection controller={controller} />
        </>
      );
    }
    const { container } = render(<Parts />);
    expect(await screen.findByRole('heading', { name })).toBeDefined();
    expect(screen.getByText('Not found, or not visible to you.')).toBeDefined();
    expect(screen.getByRole('form', { name: 'Register a tool server' })).toBeDefined();
    expect((await axe(container)).violations).toEqual([]);
  });
});
