// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { PoliciesController, UsePoliciesOptions } from '../permissions-types.js';
import { axe } from '../testing/axe.js';
import { call, inProcessFetch, recorder, startHarness } from '../testing/approvals-harness.js';
import type { Harness, Recorder } from '../testing/approvals-harness.js';
import { usePolicies } from '../use-policies.js';
import { Permissions } from './Permissions.js';
import { PolicySimulation } from './PolicySimulation.js';

/**
 * Rev 16 in the permissions module on the real hook over the in-process mock: the approval routing setting, and what
 * a dry run says about rules.
 */
let h: Harness;
let noApprovals: Harness;
beforeAll(async () => {
  h = await startHarness();
  noApprovals = await startHarness({ advertise: ['policies', 'agents', 'principals'] });
});
afterAll(async () => {
  await h.stop();
  await noApprovals.stop();
});
afterEach(cleanup);

interface Exposed {
  current: PoliciesController | undefined;
}

function View(props: {
  readonly options: UsePoliciesOptions;
  readonly expose: Exposed;
  readonly simulate?: string;
}) {
  const controller = usePolicies(props.options);
  props.expose.current = controller;
  return props.simulate === undefined ? (
    <Permissions controller={controller} />
  ) : (
    <PolicySimulation controller={controller} policyId={props.simulate} />
  );
}

const optionsOf = (
  rec: Recorder,
  harness: Harness = h,
  extra: Partial<UsePoliciesOptions> = {}
): UsePoliciesOptions => ({
  baseUrl: harness.baseUrl,
  getToken: () => harness.tokens.admin,
  fetch: rec.fetch,
  ...extra,
});

describe('the approval routing setting', { timeout: 30_000 }, () => {
  it('is on by default, says so, and turning it off writes and publishes the setting', async () => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    const expose: Exposed = { current: undefined };
    const { container } = render(<View options={optionsOf(rec)} expose={expose} />);
    const heading = await screen.findByRole('heading', { name: 'Approval routing' });
    const panel = heading.closest('section');
    if (panel === null) throw new Error('no panel');
    const box = within(panel).getByLabelText(
      'An administrator of the organisation may approve any request'
    );
    expect(box).toHaveProperty('checked', true);
    expect(within(panel).getByText('No setting is published here, so this is on.')).toBeDefined();
    expect(within(panel).getByText(/Off: only the approvers a policy names/)).toBeDefined();
    expect((await axe(container)).violations).toEqual([]);
    await user.click(box);
    await within(panel).findByText('Break-glass is now off.');
    const written = rec.calls.find((c) => c.method === 'POST' && c.path === '/v1/policies');
    expect(written?.body).toMatchObject({
      kind: 'approval_routing',
      subjects: [{ type: 'organization' }],
      config: { org_admin_break_glass: false },
    });
    expect(rec.count('POST', /\/publish$/)).toBe(1);
    await waitFor(() => {
      expect(
        within(panel).getByLabelText('An administrator of the organisation may approve any request')
      ).toHaveProperty('checked', false);
    });
    // The setting shown is the published one, so the note about the default is gone, and the policy is listed.
    await waitFor(() => {
      expect(within(panel).queryByText('No setting is published here, so this is on.')).toBeNull();
    });
    expect(await screen.findByText(/Break-glass off/)).toBeDefined();
    // Turned on again, the newest published policy wins.
    await user.click(
      within(panel).getByLabelText('An administrator of the organisation may approve any request')
    );
    await within(panel).findByText('Break-glass is now on.');
    await waitFor(() => {
      expect(
        within(panel).getByLabelText('An administrator of the organisation may approve any request')
      ).toHaveProperty('checked', true);
    });
  });

  it('keeps the chosen value while the policy lists are read again after the write', async () => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    const expose: Exposed = { current: undefined };
    render(<View options={optionsOf(rec)} expose={expose} />);
    const heading = await screen.findByRole('heading', { name: 'Approval routing' });
    const panel = heading.closest('section');
    if (panel === null) throw new Error('no panel');
    const label = 'An administrator of the organisation may approve any request';
    await waitFor(() => {
      expect(within(panel).getByLabelText(label)).toHaveProperty('checked', true);
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    rec.intercept(async (c) => {
      if (held && c.method === 'GET' && c.path === '/v1/policies') await gate;
      return undefined;
    });
    held = true;
    await user.click(within(panel).getByLabelText(label));
    await within(panel).findByText('Break-glass is now off.');
    // The lists have not come back yet: the box still shows what was chosen, not the old value.
    expect(within(panel).getByLabelText(label)).toHaveProperty('checked', false);
    held = false;
    release();
    await waitFor(() => {
      expect(within(panel).queryByText('No setting is published here, so this is on.')).toBeNull();
    });
    expect(within(panel).getByLabelText(label)).toHaveProperty('checked', false);
    await user.click(within(panel).getByLabelText(label));
    await within(panel).findByText('Break-glass is now on.');
  });

  it('is not shown where the service does not list the form', async () => {
    const rec = recorder(inProcessFetch(noApprovals.mock));
    const expose: Exposed = { current: undefined };
    render(<View options={optionsOf(rec, noApprovals)} expose={expose} />);
    await screen.findByRole('heading', { name: 'Permissions' });
    await waitFor(() => {
      expect(expose.current?.status).toBe('ready');
    });
    expect(screen.queryByRole('heading', { name: 'Approval routing' })).toBeNull();
  });

  it('is shown but not changeable to a caller who cannot author', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const expose: Exposed = { current: undefined };
    render(<View options={optionsOf(rec, h, { readOnly: true })} expose={expose} />);
    const heading = await screen.findByRole('heading', { name: 'Approval routing' });
    const panel = heading.closest('section');
    if (panel === null) throw new Error('no panel');
    expect(
      within(panel).getByLabelText('An administrator of the organisation may approve any request')
    ).toHaveProperty('disabled', true);
  });

  it('says why a change failed', async () => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      // A new policy is created when none is in force; otherwise the one in force is written over.
      (c.method === 'POST' && c.path === '/v1/policies') ||
      (c.method === 'PUT' && /^\/v1\/policies\/[^/]+$/.test(c.path))
        ? new Response(
            JSON.stringify({ type: 'https://x/problems/forbidden', title: 'no', status: 403 }),
            { status: 403, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined
    );
    const expose: Exposed = { current: undefined };
    render(<View options={optionsOf(rec)} expose={expose} />);
    const heading = await screen.findByRole('heading', { name: 'Approval routing' });
    const panel = heading.closest('section');
    if (panel === null) throw new Error('no panel');
    await user.click(
      within(panel).getByLabelText('An administrator of the organisation may approve any request')
    );
    expect(await within(panel).findByText('While setting break-glass.')).toBeDefined();
    expect(within(panel).queryByText(/Break-glass is now/)).toBeNull();
  });
});

describe('a dry run of a policy with rules', { timeout: 30_000 }, () => {
  let unique = 0;
  async function withPolicy(): Promise<{ id: string; ref: string }> {
    unique += 1;
    const ref = `ext:simui:${String(unique)}`;
    const tool = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/tools', {
      tool_ref: ref,
      transport: 'external',
      input_schema: { type: 'object' },
      side_effect_level: 'write',
      owner_kind: 'org',
      facts: { amount: { path: '.amount', type: 'number' } },
    });
    if (tool.status !== 201) throw new Error('tool');
    const policy = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/policies', {
      kind: 'tool_invocation',
      name: `Sim ${String(unique)}`,
      subjects: [{ type: 'organization' }],
      targets: { tools: [ref] },
      config: {
        mode: 'ask',
        rules: [{ when: [{ fact: 'amount', op: 'gt', value: 5000 }], then: 'deny' }],
      },
    });
    if (policy.status !== 201) throw new Error('policy');
    const { data } = (await policy.json()) as { data: { id: string } };
    return { id: data.id, ref };
  }

  async function run(args: string): Promise<HTMLElement> {
    const { id } = await withPolicy();
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    const expose: Exposed = { current: undefined };
    render(<View options={optionsOf(rec)} expose={expose} simulate={id} />);
    const field = await screen.findByLabelText('Arguments (JSON object)', undefined, {
      timeout: 5000,
    });
    // The tool is the policy's only target.
    fireEvent.change(field, { target: { value: args } });
    await user.click(screen.getByRole('button', { name: 'Simulate' }));
    return waitFor(() => {
      const result = document.querySelector('.nc-perm-result');
      if (!(result instanceof HTMLElement)) throw new Error('no result');
      return result;
    });
  }

  it('shows which rule decided, in a Rule column of the considered table', async () => {
    const result = await run('{"amount": 6000}');
    expect(within(result).getByRole('columnheader', { name: 'Rule' })).toBeDefined();
    const row = within(result)
      .getAllByRole('row')
      .find((r) => r.textContent.includes('Sim '));
    expect(row?.textContent).toContain('Rule 1: deny');
    expect(within(result).queryByText(/Facts missing from the call/)).toBeNull();
  });

  it('says the mode decided when no rule matched', async () => {
    const result = await run('{"amount": 10}');
    const row = within(result)
      .getAllByRole('row')
      .find((r) => r.textContent.includes('Sim '));
    expect(row?.textContent).toContain('The mode');
    expect(row?.textContent).not.toContain('Rule 1');
  });

  it('shows the facts the call did not carry', async () => {
    const result = await run('{}');
    expect(within(result).getByText('Facts missing from the call: amount')).toBeDefined();
    const row = within(result)
      .getAllByRole('row')
      .find((r) => r.textContent.includes('Sim '));
    expect(row?.textContent).toContain('Needs amount, which the call did not carry');
  });
});
