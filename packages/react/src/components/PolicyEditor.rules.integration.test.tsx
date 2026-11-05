// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
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
import { usePolicies } from '../use-policies.js';
import { PolicyEditor } from './PolicyEditor.js';

/**
 * The rules, approvers and exclusion sections of the policy editor on the real hook over the in-process mock: what
 * the person sees after a choice is what the store did.
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

/** Registers a tool with facts and returns its reference. */
async function registerTool(): Promise<string> {
  unique += 1;
  const ref = `ext:ruleui:${String(unique)}`;
  const response = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/tools', {
    tool_ref: ref,
    transport: 'external',
    input_schema: { type: 'object' },
    side_effect_level: 'write',
    owner_kind: 'org',
    facts: {
      amount: { path: '.amount', type: 'number' },
      env: { path: '.env', type: 'string' },
      urgent: { path: '.urgent', type: 'boolean' },
    },
  });
  if (response.status !== 201) throw new Error(`tool: ${String(response.status)}`);
  return ref;
}

interface Exposed {
  current: PoliciesController | undefined;
}

function Alone(props: {
  readonly options: UsePoliciesOptions;
  readonly policyId: string;
  readonly expose: Exposed;
}) {
  const controller = usePolicies(props.options);
  props.expose.current = controller;
  return props.policyId === '' ? null : (
    <PolicyEditor controller={controller} policyId={props.policyId} />
  );
}

const optionsOf = (rec: Recorder, extra: Partial<UsePoliciesOptions> = {}): UsePoliciesOptions => ({
  baseUrl: h.baseUrl,
  getToken: () => h.tokens.admin,
  fetch: rec.fetch,
  ...extra,
});

/** Renders the editor of a new draft policy on a tool with facts. */
async function openEditor(
  config: Record<string, unknown> = { mode: 'ask' },
  rec: Recorder = recorder(inProcessFetch(h.mock)),
  extra: Partial<UsePoliciesOptions> = {},
  /** The group that says the editor is up: `Mode` waits for the mode field instead (no section offered). */
  ready = 'Rules'
) {
  const ref = await registerTool();
  const expose: Exposed = { current: undefined };
  const options = optionsOf(rec, extra);
  const view = render(<Alone options={options} policyId="" expose={expose} />);
  await waitFor(() => {
    expect(expose.current?.status).toBe('ready');
  });
  const created = await expose.current?.create({
    kind: 'tool_invocation',
    name: `Rules ${String(unique)}`,
    subjects: [{ type: 'organization' }],
    targets: [ref],
    config,
  });
  if (created?.ok !== true) throw new Error('create failed');
  view.rerender(<Alone options={options} policyId={created.policy.id} expose={expose} />);
  const rules =
    ready === 'Mode'
      ? await screen.findByLabelText('Mode').then((mode) => mode)
      : await screen.findByRole('group', { name: ready }, { timeout: 5000 });
  return { rec, ref, id: created.policy.id, expose, view, rules };
}

const puts = (rec: Recorder) => rec.calls.filter((c) => c.method === 'PUT');
const lastBody = (rec: Recorder) => puts(rec).at(-1)?.body as { config: Record<string, unknown> };

describe('the rules editor', { timeout: 30_000 }, () => {
  it('writes a rule as a sentence, from the facts of the tool, and saves it', async () => {
    const user = userEvent.setup();
    const { rec, rules } = await openEditor();
    await user.click(within(rules).getByRole('button', { name: 'Add a rule' }));
    const item = within(rules).getAllByRole('listitem')[0];
    if (item === undefined) throw new Error('no rule');
    // A new rule tests the first fact and asks; nothing is chosen for its value yet.
    expect(within(item).getByText('Rule 1')).toBeDefined();
    expect(item.textContent).toContain('If amount is …, ask');
    await user.selectOptions(
      within(item).getByLabelText('Test of condition 1, rule 1'),
      'is greater than'
    );
    await user.type(within(item).getByLabelText('Value of condition 1, rule 1'), '5000');
    await user.selectOptions(within(item).getByLabelText('Outcome of rule 1'), 'Deny');
    expect(item.textContent).toContain('If amount is greater than 5000, deny');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(puts(rec)).toHaveLength(1);
    });
    expect(lastBody(rec).config).toEqual({
      mode: 'ask',
      rules: [{ when: [{ fact: 'amount', op: 'gt', value: 5000 }], then: 'deny' }],
    });
  });

  it('offers the tests of the fact’s type, a list for in, and true or false for a boolean fact', async () => {
    const user = userEvent.setup();
    const { rec, rules } = await openEditor();
    await user.click(within(rules).getByRole('button', { name: 'Add a rule' }));
    const test = within(rules).getByLabelText('Test of condition 1, rule 1');
    expect(
      within(test)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toContain('is at least');
    // A string fact takes no ordering test.
    await user.selectOptions(within(rules).getByLabelText('Fact of condition 1, rule 1'), 'env');
    expect(
      within(within(rules).getByLabelText('Test of condition 1, rule 1'))
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['is', 'is not', 'is one of', 'is none of', 'has a value']);
    await user.selectOptions(
      within(rules).getByLabelText('Test of condition 1, rule 1'),
      'is one of'
    );
    const values = within(rules).getByLabelText('Value of condition 1, rule 1');
    await user.type(values, 'prod{Enter}dr');
    expect(rules.textContent).toContain('If env is one of prod, dr, ask');
    // A boolean fact is true or false.
    await user.selectOptions(within(rules).getByLabelText('Fact of condition 1, rule 1'), 'urgent');
    const flag = within(rules).getByLabelText('Value of condition 1, rule 1');
    expect(
      within(flag)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['true', 'false']);
    await user.selectOptions(flag, 'false');
    expect(rules.textContent).toContain('If urgent is false, ask');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(puts(rec)).toHaveLength(1);
    });
    expect(lastBody(rec).config.rules).toEqual([
      { when: [{ fact: 'urgent', op: 'eq', value: false }], then: 'ask' },
    ]);
  });

  it('orders the rules: move up and down, with the ends disabled, and remove', async () => {
    const user = userEvent.setup();
    const { rules } = await openEditor({
      mode: 'ask',
      rules: [
        { when: [{ fact: 'amount', op: 'gt', value: 5000 }], then: 'deny' },
        { when: [{ fact: 'amount', op: 'lte', value: 50 }], then: 'always_allow' },
        { when: [{ fact: 'env', op: 'eq', value: 'prod' }], then: 'ask' },
      ],
    });
    const sentences = () =>
      within(rules)
        .getAllByRole('listitem')
        .filter((li) => li.textContent.startsWith('Rule'))
        .map((li) => /If .*?, (allow|ask|deny)/.exec(li.textContent)?.[0]);
    expect(sentences()).toEqual([
      'If amount is greater than 5000, deny',
      'If amount is at most 50, allow',
      'If env is prod, ask',
    ]);
    expect(
      within(rules).getByRole('button', { name: 'Move rule 1 up' }).hasAttribute('disabled')
    ).toBe(true);
    expect(
      within(rules).getByRole('button', { name: 'Move rule 3 down' }).hasAttribute('disabled')
    ).toBe(true);
    await user.click(within(rules).getByRole('button', { name: 'Move rule 3 up' }));
    expect(sentences()).toEqual([
      'If amount is greater than 5000, deny',
      'If env is prod, ask',
      'If amount is at most 50, allow',
    ]);
    await user.click(within(rules).getByRole('button', { name: 'Move rule 1 down' }));
    expect(sentences()[0]).toBe('If env is prod, ask');
    await user.click(within(rules).getByRole('button', { name: 'Remove rule 1' }));
    expect(sentences()).toEqual([
      'If amount is greater than 5000, deny',
      'If amount is at most 50, allow',
    ]);
  });

  it('labels the mode as the fallback once there are rules, and says Mode before', async () => {
    const user = userEvent.setup();
    await openEditor();
    expect(screen.getByLabelText('Mode')).toBeDefined();
    expect(screen.queryByLabelText('When no rule matches')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add a rule' }));
    expect(screen.getByLabelText('When no rule matches')).toBeDefined();
  });

  it('gives a rule that asks its own approvers, and drops them when it stops asking', async () => {
    const user = userEvent.setup();
    const { rec, rules } = await openEditor({
      mode: 'deny',
      rules: [
        {
          when: [{ fact: 'amount', op: 'gt', value: 500 }],
          then: 'ask',
          approvers: [{ role: 'lead' }],
        },
      ],
    });
    expect(rules.textContent).toContain('If amount is greater than 500, ask (role lead)');
    expect(
      within(rules).getByLabelText<HTMLInputElement>('Role key or user id of approver 1 of rule 1')
        .value
    ).toBe('lead');
    await user.click(within(rules).getByRole('button', { name: 'Add an approver to rule 1' }));
    await user.selectOptions(within(rules).getByLabelText('Kind of approver 2 of rule 1'), 'User');
    await user.type(
      within(rules).getByLabelText('Role key or user id of approver 2 of rule 1'),
      'u-7'
    );
    expect(rules.textContent).toContain('(role lead, user u-7)');
    await user.selectOptions(within(rules).getByLabelText('Outcome of rule 1'), 'Deny');
    expect(rules.textContent).toContain('If amount is greater than 500, deny');
    expect(within(rules).queryByText('Who may approve when this rule asks')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(puts(rec)).toHaveLength(1);
    });
    expect(lastBody(rec).config.rules).toEqual([
      { when: [{ fact: 'amount', op: 'gt', value: 500 }], then: 'deny' },
    ]);
  });

  it('marks what the contract refuses once a save was refused, and sends nothing', async () => {
    const user = userEvent.setup();
    const { rec, rules } = await openEditor();
    await user.click(within(rules).getByRole('button', { name: 'Add a rule' }));
    // Nothing is marked while the person is still writing.
    expect(within(rules).queryByText('Enter a value.')).toBeNull();
    await user.selectOptions(
      within(rules).getByLabelText('Test of condition 1, rule 1'),
      'is greater than'
    );
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await within(rules).findByText('Enter a value.')).toBeDefined();
    expect(screen.getByText('Fix the marked rules and approvers before saving.')).toBeDefined();
    expect(puts(rec)).toEqual([]);
    await user.type(within(rules).getByLabelText('Value of condition 1, rule 1'), '1');
    expect(within(rules).queryByText('Enter a value.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(puts(rec)).toHaveLength(1);
    });
  });

  it('shows a refusal of the service at the rule it names, not at the top', async () => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.method === 'PUT'
        ? new Response(
            JSON.stringify({
              type: 'https://x/problems/invalid_request',
              title: 'invalid',
              status: 400,
              detail: 'the fact is not one the tool declares',
              member: 'config.rules[1].when[0].fact',
            }),
            { status: 400, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined
    );
    const { rules } = await openEditor(
      {
        mode: 'ask',
        rules: [
          { when: [{ fact: 'amount', op: 'gt', value: 1 }], then: 'deny' },
          { when: [{ fact: 'amount', op: 'lt', value: 1 }], then: 'deny' },
        ],
      },
      rec
    );
    await user.type(screen.getByLabelText('Name'), ' x');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const message = await within(rules).findByText(
      'The service refused this: the fact is not one the tool declares'
    );
    const second = within(rules)
      .getAllByRole('listitem')
      .find((li) => li.textContent.startsWith('Rule 2'));
    expect(second?.contains(message)).toBe(true);
    // Not repeated as the generic alert at the top.
    expect(screen.queryAllByText(/the fact is not one the tool declares/)).toHaveLength(1);
  });

  it.each([
    ['an approver of the policy', 'config.approvers[0].role', 'Approvers'],
    ['an approver of a rule', 'config.rules[0].approvers[0].role', 'Rules'],
    ['the exclusion', 'config.exclude', 'Exclusions'],
    ['the rules as a whole', 'config.rules', 'Rules'],
  ])('shows a refusal that names %s in its section, once', async (_what, member, section) => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.method === 'PUT'
        ? new Response(
            JSON.stringify({
              type: 'https://x/problems/invalid_request',
              title: 'invalid',
              status: 400,
              detail: 'refused-by-the-service',
              member,
            }),
            { status: 400, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined
    );
    await openEditor(
      {
        mode: 'ask',
        rules: [
          {
            when: [{ fact: 'amount', op: 'gt', value: 1 }],
            then: 'ask',
            approvers: [{ role: 'finance' }],
          },
        ],
        approvers: [{ role: 'ops' }],
        exclude: ['requester'],
      },
      rec
    );
    await user.type(screen.getByLabelText('Name'), ' x');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const message = await screen.findByText(/refused-by-the-service/);
    expect(screen.getAllByText(/refused-by-the-service/)).toHaveLength(1);
    expect(screen.getByRole('group', { name: section }).contains(message)).toBe(true);
  });

  it('drops a refusal once the rules change, so it never sits on another row', async () => {
    const user = userEvent.setup();
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.method === 'PUT'
        ? new Response(
            JSON.stringify({
              type: 'https://x/problems/invalid_request',
              title: 'invalid',
              status: 400,
              detail: 'refused-by-the-service',
              member: 'config.rules[1].when[0].fact',
            }),
            { status: 400, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined
    );
    const { rules } = await openEditor(
      {
        mode: 'ask',
        rules: [
          { when: [{ fact: 'amount', op: 'gt', value: 1 }], then: 'deny' },
          { when: [{ fact: 'amount', op: 'lt', value: 1 }], then: 'deny' },
        ],
      },
      rec
    );
    await user.type(screen.getByLabelText('Name'), ' x');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await within(rules).findByText(/refused-by-the-service/);
    await user.click(within(rules).getByRole('button', { name: 'Move rule 2 up' }));
    expect(screen.queryByText(/refused-by-the-service/)).toBeNull();
  });

  it('says so when a rule stops asking and its approvers are removed', async () => {
    const user = userEvent.setup();
    const { rules } = await openEditor({
      mode: 'ask',
      rules: [
        {
          when: [{ fact: 'amount', op: 'gt', value: 1 }],
          then: 'ask',
          approvers: [{ role: 'finance' }],
        },
        { when: [{ fact: 'amount', op: 'lt', value: 1 }], then: 'ask' },
      ],
    });
    const notice = /so its approvers were removed/;
    // A rule that had no approvers of its own loses nothing, so nothing is said.
    await user.selectOptions(within(rules).getByLabelText('Outcome of rule 2'), 'Deny');
    expect(screen.queryByText(notice)).toBeNull();
    await user.selectOptions(within(rules).getByLabelText('Outcome of rule 1'), 'Deny');
    expect(screen.getByText(notice)).toBeDefined();
    expect(
      within(rules).queryByLabelText('Role key or user id of approver 1 of rule 1')
    ).toBeNull();
    await user.selectOptions(within(rules).getByLabelText('Outcome of rule 1'), 'Ask for approval');
    expect(screen.queryByText(notice)).toBeNull();
  });

  it('does not carry the removed-approvers note to the rule that takes its place after a move', async () => {
    const user = userEvent.setup();
    const { rules } = await openEditor({
      mode: 'ask',
      rules: [
        {
          when: [{ fact: 'amount', op: 'gt', value: 1 }],
          then: 'ask',
          approvers: [{ role: 'finance' }],
        },
        { when: [{ fact: 'amount', op: 'lt', value: 1 }], then: 'deny' },
      ],
    });
    const notice = /so its approvers were removed/;
    await user.selectOptions(within(rules).getByLabelText('Outcome of rule 1'), 'Deny');
    expect(screen.getByText(notice)).toBeDefined();
    await user.click(within(rules).getByRole('button', { name: 'Move rule 1 down' }));
    expect(screen.queryByText(notice)).toBeNull();
  });

  it('keeps rules it cannot read as they are, and says so', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { id } = await openEditor(
      {
        mode: 'ask',
        rules: [{ when: [{ fact: 'amount', op: 'gt', value: 1 }], then: 'deny' }],
      },
      rec
    );
    cleanup();
    const odd = recorder(inProcessFetch(h.mock));
    odd.intercept(async (c, request) => {
      if (c.method !== 'GET' || !c.path.startsWith(`/v1/policies/${id}`)) return undefined;
      const text = await (await inProcessFetch(h.mock)(request)).text();
      return jsonResponse(JSON.parse(text.replaceAll('"rules":[', '"rules":"weird","was":[')));
    });
    const expose: Exposed = { current: undefined };
    render(<Alone options={optionsOf(odd)} policyId={id} expose={expose} />);
    const rules = await screen.findByRole('group', { name: 'Rules' });
    expect(
      within(rules).getByText(/cannot show\. They are kept exactly as they are/)
    ).toBeDefined();
    expect(
      within(rules).queryByRole('button', { name: 'Add a rule' })?.hasAttribute('disabled') ?? true
    ).toBe(true);
  });
});

describe('the approvers and exclusion sections', { timeout: 30_000 }, () => {
  it('sets the policy approvers, each optionally only when conditions hold, and the exclusion', async () => {
    const user = userEvent.setup();
    const { rec } = await openEditor();
    const approvers = screen.getByRole('group', { name: 'Approvers' });
    await user.click(within(approvers).getByRole('button', { name: 'Add an approver' }));
    await user.type(
      within(approvers).getByLabelText('Role key or user id of approver 1 of the policy'),
      'finance'
    );
    await user.click(within(approvers).getByRole('button', { name: 'Add an approver' }));
    await user.selectOptions(
      within(approvers).getByLabelText('Kind of approver 2 of the policy'),
      'User'
    );
    await user.type(
      within(approvers).getByLabelText('Role key or user id of approver 2 of the policy'),
      'u-1'
    );
    await user.click(
      within(approvers).getByLabelText('Approver 2 of the policy applies only when conditions hold')
    );
    await user.selectOptions(
      within(approvers).getByLabelText('Fact of condition 1, approver 2 of the policy'),
      'env'
    );
    await user.type(
      within(approvers).getByLabelText('Value of condition 1, approver 2 of the policy'),
      'prod'
    );
    const exclusions = screen.getByRole('group', { name: 'Exclusions' });
    await user.click(
      within(exclusions).getByLabelText("The requester can't approve their own call")
    );
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(puts(rec)).toHaveLength(1);
    });
    expect(lastBody(rec).config).toEqual({
      mode: 'ask',
      approvers: [
        { role: 'finance' },
        { user: 'u-1', when: [{ fact: 'env', op: 'eq', value: 'prod' }] },
      ],
      exclude: ['requester'],
    });
  });

  it('removing the last approver and unticking the exclusion removes both members', async () => {
    const user = userEvent.setup();
    const { rec } = await openEditor({
      mode: 'ask',
      approvers: [{ role: 'finance' }],
      exclude: ['requester'],
    });
    const approvers = screen.getByRole('group', { name: 'Approvers' });
    await user.click(
      within(approvers).getByRole('button', { name: 'Remove approver 1 of the policy' })
    );
    await user.click(
      within(screen.getByRole('group', { name: 'Exclusions' })).getByLabelText(
        "The requester can't approve their own call"
      )
    );
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(puts(rec)).toHaveLength(1);
    });
    expect(lastBody(rec).config).toEqual({ mode: 'ask' });
  });

  it('warns, and does not block, when no outcome can ask the approvers', async () => {
    const user = userEvent.setup();
    const { rec } = await openEditor({ mode: 'deny' });
    const approvers = screen.getByRole('group', { name: 'Approvers' });
    await user.click(within(approvers).getByRole('button', { name: 'Add an approver' }));
    await user.type(
      within(approvers).getByLabelText('Role key or user id of approver 1 of the policy'),
      'finance'
    );
    expect(
      within(approvers).getByText(
        /No outcome of this policy asks for approval, so these approvers are never used/
      )
    ).toBeDefined();
    expect(
      within(screen.getByRole('group', { name: 'Exclusions' })).queryByText(/does nothing/)
    ).toBeNull();
    await user.click(
      within(screen.getByRole('group', { name: 'Exclusions' })).getByLabelText(
        "The requester can't approve their own call"
      )
    );
    expect(
      within(screen.getByRole('group', { name: 'Exclusions' })).getByText(/does nothing/)
    ).toBeDefined();
    const save = screen.getByRole('button', { name: 'Save draft' });
    expect(save.hasAttribute('disabled')).toBe(false);
    await user.click(save);
    await waitFor(() => {
      expect(puts(rec)).toHaveLength(1);
    });
  });

  it('checks an approver with no id once a save was refused', async () => {
    const user = userEvent.setup();
    const { rec } = await openEditor();
    const approvers = screen.getByRole('group', { name: 'Approvers' });
    await user.click(within(approvers).getByRole('button', { name: 'Add an approver' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await within(approvers).findByText('Enter a role key or a user id.')).toBeDefined();
    expect(puts(rec)).toEqual([]);
  });
});

describe('gating by what the service lists', { timeout: 30_000 }, () => {
  /** A service whose `policy_forms.tool_invocation.config_members` lacks `omit`. */
  function without(omit: string[]): Recorder {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/capabilities') return undefined;
      const body = (await (await inProcessFetch(h.mock)(request)).json()) as {
        data: { policy_forms: { tool_invocation: { config_members: string[] } } };
      };
      body.data.policy_forms.tool_invocation.config_members =
        body.data.policy_forms.tool_invocation.config_members.filter((m) => !omit.includes(m));
      return jsonResponse(body);
    });
    return rec;
  }

  it.each([
    [['rules'], ['Rules'], ['Approvers', 'Exclusions']],
    [['approvers'], ['Approvers'], ['Rules', 'Exclusions']],
    [['exclude'], ['Exclusions'], ['Rules', 'Approvers']],
    [['rules', 'approvers', 'exclude'], ['Rules', 'Approvers', 'Exclusions'], []],
  ])('without %j, the sections %j are gone and %j stay', async (omit, gone, stay) => {
    await openEditor({ mode: 'ask' }, without(omit), {}, stay[0] ?? 'Mode');
    for (const name of gone) expect(screen.queryByRole('group', { name })).toBeNull();
    for (const name of stay) expect(screen.getByRole('group', { name })).toBeDefined();
  });

  it('shows the sections read-only to a caller who cannot author', async () => {
    const { id } = await openEditor({
      mode: 'ask',
      rules: [
        {
          when: [{ fact: 'amount', op: 'gt', value: 1 }],
          then: 'ask',
          approvers: [{ role: 'lead' }],
        },
      ],
      approvers: [{ user: 'u-1' }],
      exclude: ['requester'],
    });
    cleanup();
    const expose: Exposed = { current: undefined };
    render(
      <Alone
        options={optionsOf(recorder(inProcessFetch(h.mock)), { readOnly: true })}
        policyId={id}
        expose={expose}
      />
    );
    const rules = await screen.findByRole('group', { name: 'Rules' });
    const editor = rules.closest('form');
    if (editor === null) throw new Error('no form');
    for (const name of ['Add a rule', 'Add an approver', 'Add an approver to rule 1']) {
      expect(within(editor).queryByRole('button', { name })).toBeNull();
    }
    expect(within(editor).queryByRole('button', { name: /^(Move|Remove) / })).toBeNull();
    expect(
      within(editor).getByText(/If amount is greater than 1, ask \(role lead\)/)
    ).toBeDefined();
    for (const control of within(editor).getAllByRole('combobox'))
      expect(control).toHaveProperty('disabled', true);
    expect(
      within(editor)
        .getByLabelText("The requester can't approve their own call")
        .hasAttribute('disabled')
    ).toBe(true);
    expect(
      within(editor).getByLabelText('Role key or user id of approver 1 of the policy')
    ).toHaveProperty('readOnly', true);
  });
});

describe('accessibility', { timeout: 30_000 }, () => {
  it('passes axe with rules, approvers and an exclusion on screen', async () => {
    const { view } = await openEditor({
      mode: 'ask',
      rules: [
        {
          when: [
            { fact: 'env', op: 'in', value: ['prod', 'dr'] },
            { fact: 'urgent', op: 'eq', value: true },
          ],
          then: 'ask',
          approvers: [{ role: 'lead', when: [{ fact: 'amount', op: 'gt', value: 5 }] }],
        },
      ],
      approvers: [{ user: 'u-1' }],
      exclude: ['requester'],
    });
    expect((await axe(view.container)).violations).toEqual([]);
  });
});
