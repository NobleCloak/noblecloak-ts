// @vitest-environment jsdom
/**
 * SP-R1 scenario: the mock deployment opens real `tool:noblecloak:propose-policy-set` approvals, and `<Approvals>`
 * on a real `useApprovals` shows what approving does to the approver, to the person who proposed it and to a
 * reader the deployment does not serve the call to; the approver then approves, and the mock applies the set.
 * Also the deep link: a host opens one approval's detail by id with `openDetail`, whether or not the queue lists it.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useCallback, useEffect } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PROPOSE_POLICY_SET_TOOL } from '../approvals-proposal.js';
import type { UseApprovalsOptions } from '../approvals-types.js';
import { useApprovals } from '../use-approvals.js';
import { call, recorder, startHarness } from '../testing/approvals-harness.js';
import type { Harness, Recorder } from '../testing/approvals-harness.js';
import { findRowById, hasRow } from '../testing/rows.js';
import { Approvals } from './Approvals.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});
afterEach(cleanup);

const assessment = {
  side_effect_level: 'write',
  blast_radius: 'one_record',
  reversible: true,
  external_party: false,
  financial: false,
};
const row = (role: string, subject: unknown, tool: string, mode: string): unknown => ({
  role,
  rationale: 'Because.',
  assessment,
  policy: {
    kind: 'tool_invocation',
    subjects: [subject],
    targets: { tools: [tool] },
    config: { mode },
  },
});
const registration = (toolRef: string): unknown => ({
  tool_ref: toolRef,
  transport: 'external',
  input_schema: { type: 'object' },
  side_effect_level: 'write',
  owner_kind: 'org',
});

let counter = 0;
interface Proposed {
  readonly id: string;
  readonly digest: string;
  readonly tool: string;
}

/** A person with the role-subject entitlement proposes: the tool, a baseline of `baselineMode` and a `member` role row that denies. */
async function propose(baselineMode: string): Promise<Proposed> {
  counter += 1;
  const tool = `ext:scenario:t${String(counter)}`;
  const answer = await call(h.baseUrl, h.tokens.entitled, 'POST', '/v1/approvals', {
    action: {
      tool_ref: PROPOSE_POLICY_SET_TOOL,
      arguments: {
        tools: [registration(tool)],
        policies: [
          row('baseline', { type: 'role', id: 'everyone' }, tool, baselineMode),
          row('role', { type: 'role', id: 'member' }, tool, 'deny'),
        ],
      },
    },
    continuation: { kind: 'mcp_held', delivery: 'held' },
  });
  expect(answer.status).toBe(201);
  const { id } = ((await answer.json()) as { data: { id: string } }).data;
  const read = await call(h.baseUrl, h.tokens.admin, 'GET', `/v1/approvals/${id}`);
  const digest = ((await read.json()) as { data: { action_digest: string } }).data.action_digest;
  return { id, digest, tool };
}

const optionsFor = (token: string, rec: Recorder): UseApprovalsOptions => ({
  baseUrl: h.baseUrl,
  getToken: () => token,
  fetch: rec.fetch,
  reconcileMs: 600_000,
});

function Probe(props: { readonly options: UseApprovalsOptions; readonly openId?: string }) {
  const controller = useApprovals(props.options);
  const open = useCallback(
    (id: string) => {
      controller.openDetail(id);
    },
    [controller]
  );
  const { openId } = props;
  // A host that honours `?approval=<id>`: it opens that approval's detail once, when it mounts.
  useEffect(() => {
    if (openId !== undefined) open(openId);
    // Once, on mount: `open` changes with every snapshot of the controller.
  }, [openId]);
  return <Approvals controller={controller} />;
}

const region = (): HTMLElement => screen.getByRole('region', { name: 'What approving this does' });
function listOf(heading: string): string[] {
  const section = within(region()).getByRole('heading', { name: heading }).parentElement;
  if (section === null) throw new Error(`no section for ${heading}`);
  return within(section)
    .getAllByRole('listitem')
    .map((item) => item.textContent);
}

describe('a propose-policy-set approval in <Approvals>', () => {
  it('shows the approver what approving changes, then approves and the deployment applies the set', async () => {
    const user = userEvent.setup();
    const proposed = await propose('always_allow');
    render(<Probe options={optionsFor(h.tokens.admin, recorder())} />);

    await user.click(await findRowById(proposed.id));
    await screen.findByRole('region', { name: 'What approving this does' });

    expect(listOf('Policies')).toEqual([
      `${proposed.tool}: Allowed (baseline)`,
      `${proposed.tool}: Denied (role row)`,
    ]);
    // The deployment's default for the tool is to ask: the baseline loosens it.
    expect(listOf('What changes')).toEqual([`Everyone on ${proposed.tool}: Ask first → Allowed`]);
    expect(listOf('New tools to register')).toEqual([`${proposed.tool} (write level)`]);
    expect(screen.queryByText('Approving loosens no policy.')).toBeNull();

    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(
        false
      );
    });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const confirm = screen.queryByRole('button', { name: 'Confirm approval' });
    if (confirm !== null) await user.click(confirm);
    await screen.findByText('Approved. The request has left your queue.');

    const policies = (await (
      await call(h.baseUrl, h.tokens.admin, 'GET', `/v1/policies?tool=${proposed.tool}&limit=200`)
    ).json()) as { data: { subjects: { id: string }[]; state: string }[] };
    expect(policies.data.map((p) => [p.subjects[0]?.id, p.state]).sort()).toEqual([
      ['everyone', 'published'],
      ['member', 'published'],
    ]);
  });

  it('says approving loosens no policy when the deployment lists no loosening', async () => {
    const user = userEvent.setup();
    const proposed = await propose('ask');
    render(<Probe options={optionsFor(h.tokens.admin, recorder())} />);
    await user.click(await findRowById(proposed.id));
    await screen.findByRole('region', { name: 'What approving this does' });
    expect(within(region()).getByText('Approving loosens no policy.')).toBeDefined();
  });

  it('shows the person who proposed it the policies alone: the deployment serves them no preview', async () => {
    const proposed = await propose('always_allow');
    render(<Probe options={optionsFor(h.tokens.entitled, recorder())} openId={proposed.id} />);
    await screen.findByRole('region', { name: 'What approving this does' });
    expect(listOf('Policies')).toHaveLength(2);
    expect(within(region()).queryByRole('heading', { name: 'What changes' })).toBeNull();
    expect(screen.queryByText(/loosens no policy/)).toBeNull();
  });

  it('shows a reader the call is withheld from the digest alone, as for any approval', async () => {
    const proposed = await propose('always_allow');
    render(<Probe options={optionsFor(h.tokens.approver, recorder())} openId={proposed.id} />);
    await screen.findByText(/The call itself is not shown to you\./);
    expect(screen.queryByRole('region', { name: 'What approving this does' })).toBeNull();
  });
});

describe('opening an approval by id (the deep link)', () => {
  it('opens the detail of an approval the first page of the queue does not list', async () => {
    const proposed = await propose('always_allow');
    const rec = recorder();
    // The queue's first page is empty and says more follow, as a deployment with a long queue answers.
    rec.intercept((c) =>
      c.method === 'GET' && c.path === '/v1/approvals'
        ? Response.json({ data: [], meta: { next: 'cursor-2' } })
        : undefined
    );
    render(<Probe options={optionsFor(h.tokens.admin, rec)} openId={proposed.id} />);
    await screen.findByRole('region', { name: 'What approving this does' });
    expect(listOf('What changes')).toHaveLength(1);
    expect(hasRow(proposed.id)).toBe(false);
  });
});
