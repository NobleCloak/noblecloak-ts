// @vitest-environment jsdom
/**
 * The detail of a `tool:noblecloak:propose-policy-set` approval: the policies by subject, what the preview says
 * approving changes, the rows with no effect, the grants, the tools and the agent, above Approve and Deny. Any
 * other approval keeps the generic view.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CardProps } from '@noblecloak/theme';

import { PROPOSE_POLICY_SET_TOOL } from '../approvals-proposal.js';
import type { ApprovalDetailState, ApprovalSummary, JsonObject } from '../approvals-types.js';
import { axe } from '../testing/axe.js';
import { queueRows, renderController } from '../testing/component-harness.js';
import { detailStates, fakeController } from '../testing/fake-controller.js';
import type { ApprovalsProps } from './Approvals.js';

afterEach(cleanup);

const assessment = { side_effect_level: 'write', blast_radius: 'one_record' };
const entry = (role: string, subject: unknown, tool: string, mode: string): unknown => ({
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
const EVERYONE = { type: 'role', id: 'everyone' };
const MCP = 'mcp:crm/main/send_email';
const EXT = 'ext:crm:export';

/** A full proposal: a baseline, a role row, a tightening, a tool to register, an agent with a principal, a grant. */
const ARGUMENTS = {
  agent: { id: 'agent_1', principal_id: 'sp_1' },
  tools: [{ tool_ref: 'ext:crm:lookup', side_effect_level: 'read', owner_kind: 'org' }],
  policies: [
    entry('tightening', { type: 'agent', id: 'agent_1' }, MCP, 'deny'),
    entry('role', { type: 'role', id: 'member' }, EXT, 'always_allow'),
    entry('baseline', EVERYONE, MCP, 'ask'),
  ],
  tool_grants: ['ext:crm:report'],
} as unknown as JsonObject;

const PREVIEW = {
  simulations: [{ tool_ref: MCP, result: { decision: 'step_up' } }],
  loosening: [
    { tool_ref: MCP, from: 'deny', to: 'ask' },
    { tool_ref: EXT, from: 'ask', to: 'always_allow', subject: { type: 'role', id: 'member' } },
  ],
  ineffective: [{ tool_ref: EXT, subject: { type: 'role', id: 'auditor' } }],
  grants: [{ tool_ref: 'ext:crm:report' }],
};

function detailOf(
  args: JsonObject | undefined,
  preview: unknown,
  toolRef: string = PROPOSE_POLICY_SET_TOOL
): ApprovalDetailState {
  return detailStates('apr_1', {
    ...(args === undefined ? {} : { arguments: args }),
    approval:
      preview === undefined
        ? { tool_ref: toolRef }
        : { tool_ref: toolRef, preview: preview as NonNullable<ApprovalSummary['preview']> },
  }).loaded;
}

function show(detail: ApprovalDetailState, props: Partial<ApprovalsProps> = {}) {
  return renderController(fakeController({ approvals: queueRows(1), detail }), props);
}

const proposal = (): HTMLElement =>
  screen.getByRole('region', { name: 'What approving this does' });
/** The section a heading belongs to. */
function sectionOf(name: string): HTMLElement {
  const parent = screen.getByRole('heading', { name }).parentElement;
  if (parent === null) throw new Error(`no section for ${name}`);
  return parent;
}
const items = (container: HTMLElement): string[] =>
  within(container)
    .getAllByRole('listitem')
    .map((item) => item.textContent);

describe('SP-R1: a policy-set proposal in the approval detail', () => {
  it('groups the policies by subject, with the mode in words and the row kind visible', () => {
    show(detailOf(ARGUMENTS, PREVIEW));
    const policies = sectionOf('Policies');
    // Everyone first, then the role, then the agent, whatever the order in the call.
    const subjects = [...policies.querySelectorAll('strong')].map((node) => node.textContent);
    expect(subjects).toEqual(['Everyone', 'Role member', 'Agent agent_1']);
    expect(items(policies)).toEqual([
      'send_email on crm: Ask first (baseline)',
      `${EXT}: Allowed (role row)`,
      'send_email on crm: Denied (tightening)',
    ]);
  });

  it('keeps the full tool reference available on a shortened line', () => {
    show(detailOf(ARGUMENTS, PREVIEW));
    const row = within(proposal())
      .getByText('send_email on crm: Ask first (baseline)')
      .closest('li');
    expect(row?.getAttribute('title')).toBe(MCP);
  });

  it('lists each loosening as subject on tool: from to to', () => {
    show(detailOf(ARGUMENTS, PREVIEW));
    const changes = sectionOf('What changes');
    expect(items(changes)).toEqual([
      'Everyone on send_email on crm: Denied → Ask first',
      `Role member on ${EXT}: Ask first → Allowed`,
    ]);
    expect(within(proposal()).queryByText('Approving loosens no policy.')).toBeNull();
  });

  it('lists the rows with no effect, the grants under the agent, the tools to register and the binding', () => {
    show(detailOf(ARGUMENTS, PREVIEW));
    const section = within(proposal());
    const noEffect = sectionOf('Has no effect');
    expect(items(noEffect)).toEqual([
      `Role auditor on ${EXT}: a tighter policy for everyone already applies.`,
    ]);
    const grants = sectionOf('Tools granted');
    expect(grants.textContent).toContain('For Agent agent_1');
    expect(items(grants)).toEqual(['ext:crm:report']);
    const tools = sectionOf('New tools to register');
    expect(items(tools)).toEqual(['ext:crm:lookup (read level)']);
    expect(section.getByText('Agent agent_1 is bound to service principal sp_1.')).toBeDefined();
  });

  it('says an agent without a principal keeps its binding', () => {
    show(detailOf({ ...ARGUMENTS, agent: { id: 'agent_1' } }, PREVIEW));
    expect(within(proposal()).getByText('Agent agent_1 keeps its current binding.')).toBeDefined();
  });

  it('says approving loosens no policy when the preview lists no loosening', () => {
    show(detailOf(ARGUMENTS, { simulations: [], loosening: [] }));
    expect(within(proposal()).getByText('Approving loosens no policy.')).toBeDefined();
    expect(within(proposal()).queryByRole('heading', { name: 'Has no effect' })).toBeNull();
  });

  it('shows the proposal above Approve and Deny, and leaves them enabled', () => {
    show(detailOf(ARGUMENTS, PREVIEW));
    const approve = screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' });
    expect(
      proposal().compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(approve.disabled).toBe(false);
    // The full call stays on the page: the actions are enabled by it being whole.
    expect(
      screen.getByRole('heading', { name: 'The full call, as returned for this request' })
    ).toBeDefined();
  });

  it('shows the call alone, with no preview section and no claim about loosening, when no preview was served', () => {
    show(detailOf(ARGUMENTS, undefined));
    const section = within(proposal());
    expect(section.getByRole('heading', { name: 'Policies' })).toBeDefined();
    expect(section.queryByRole('heading', { name: 'What changes' })).toBeNull();
    expect(section.queryByRole('heading', { name: 'Has no effect' })).toBeNull();
    expect(section.queryByText(/loosens no policy/)).toBeNull();
    // The grants of the call itself are still shown.
    expect(items(sectionOf('Tools granted'))).toEqual(['ext:crm:report']);
  });

  it('shows the preview alone when the call was not served: no policies, the changes and the grants of the preview', () => {
    show(detailOf(undefined, PREVIEW));
    const section = within(proposal());
    expect(section.queryByRole('heading', { name: 'Policies' })).toBeNull();
    expect(items(sectionOf('What changes'))).toHaveLength(2);
    expect(items(sectionOf('Tools granted'))).toEqual(['ext:crm:report']);
  });

  it('shows a final approval, which has its call but no preview, as the call alone', () => {
    const detail = detailStates('apr_1', {
      arguments: ARGUMENTS,
      approval: { tool_ref: PROPOSE_POLICY_SET_TOOL },
    }).resolved;
    show(detail);
    expect(within(proposal()).queryByRole('heading', { name: 'What changes' })).toBeNull();
    expect(within(proposal()).getByRole('heading', { name: 'Policies' })).toBeDefined();
  });

  it('shows the generic digest-only view when neither the call nor a preview was served', () => {
    show(detailOf(undefined, undefined));
    expect(screen.queryByRole('region', { name: 'What approving this does' })).toBeNull();
    expect(screen.getByText(/The arguments of this call are not shown to you\./)).toBeDefined();
  });

  it('leaves an approval of any other tool on the generic view, even if it carries a proposal and a preview', () => {
    show(detailOf(ARGUMENTS, PREVIEW, 'ext:billing:charge'));
    expect(screen.queryByRole('region', { name: 'What approving this does' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('pre')?.textContent).toContain('"tool_grants"');
  });

  describe('a proposal that cannot be read', () => {
    const cases: readonly [string, JsonObject | undefined, unknown][] = [
      ['a preview that is not an object', ARGUMENTS, 'soon'],
      ['a preview whose loosening is missing', ARGUMENTS, { simulations: [] }],
      ['a preview entry without a mode', ARGUMENTS, { loosening: [{ tool_ref: MCP }] }],
      ['a call whose policies are not a list', { policies: 'all of them' }, PREVIEW],
    ];
    it.each(cases)(
      'falls back to the generic call with the unreadable notice: %s',
      (_n, args, preview) => {
        show(detailOf(args, preview));
        expect(screen.queryByRole('region', { name: 'What approving this does' })).toBeNull();
        const alert = screen.getByRole('alert');
        expect(alert.textContent).toContain('The service sent a reply this page could not read.');
        expect(alert.textContent).toContain('only the full call is shown');
        expect(
          screen.getByRole('heading', { name: 'The full call, as returned for this request' })
        ).toBeDefined();
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(
          false
        );
      }
    );
  });

  describe('a call that is not shown whole', () => {
    const repeated = (): ApprovalDetailState => {
      const d = detailOf(ARGUMENTS, PREVIEW);
      return { ...d, argumentsSource: '{"a":1,"a":2}' } as ApprovalDetailState;
    };
    it('leaves the panel out beside the repeated-key warning, says why, and keeps Approve off', () => {
      show(repeated());
      expect(screen.queryByRole('region', { name: 'What approving this does' })).toBeNull();
      expect(screen.getByText(/cannot be shown whole/)).toBeDefined();
      expect(screen.getByText(/names the key "a" more than once/)).toBeDefined();
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(
        true
      );
    });
    it('shows the panel on the first view of a call that is only cut, and keeps Approve off until it is whole', async () => {
      const rows = Array.from({ length: 10 }, (_, i) =>
        entry('baseline', EVERYONE, `mcp:crm/main/tool_${String(i)}`, 'ask')
      );
      const big = { ...ARGUMENTS, policies: rows } as unknown as JsonObject;
      show(detailOf(big, PREVIEW));
      expect(screen.getByRole('region', { name: 'What approving this does' })).toBeDefined();
      expect(screen.queryByText(/cannot be shown whole/)).toBeNull();
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(
        true
      );
      fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
      await screen.findByRole('region', { name: 'What approving this does' });
    });
    it('keeps the panel for a padded call cut on the first view', () => {
      const wide = { ...ARGUMENTS, note: 'x'.repeat(5000) } as unknown as JsonObject;
      show(detailOf(wide, PREVIEW));
      expect(screen.getByRole('region', { name: 'What approving this does' })).toBeDefined();
    });
  });

  it('shows what the service sent as inert text, with invisible characters escaped', () => {
    const args = {
      policies: [
        entry('role', { type: 'role', id: 'mem‮ber' }, '<img src=x onerror=alert(1)>', 'deny'),
      ],
    } as unknown as JsonObject;
    show(detailOf(args, { loosening: [] }));
    expect(document.querySelector('img')).toBeNull();
    const row = items(proposal()).join('|');
    expect(row).toContain('<img src=x onerror=alert(1)>');
    expect(proposal().textContent).toContain('Role mem\\u202Eber');
    expect(proposal().textContent).not.toContain('‮');
  });

  it('shows a mode named like an inherited object member as it came', () => {
    const args = {
      policies: [entry('toString', EVERYONE, EXT, 'constructor')],
    } as unknown as JsonObject;
    show(detailOf(args, undefined));
    expect(items(proposal())).toEqual([`${EXT}: constructor (toString)`]);
  });

  it('shows a mode or row kind this version does not know as it came', () => {
    const args = {
      policies: [entry('future_kind', EVERYONE, EXT, 'maybe')],
    } as unknown as JsonObject;
    show(detailOf(args, undefined));
    expect(items(proposal())).toEqual([`${EXT}: maybe (future_kind)`]);
  });

  it('has no accessibility violations', async () => {
    const { container } = show(detailOf(ARGUMENTS, PREVIEW));
    expect((await axe(container)).violations).toEqual([]);
  });

  describe('customisation', () => {
    it('replaces any of its words through labels', () => {
      show(detailOf(ARGUMENTS, { loosening: [] }), {
        labels: {
          proposalHeading: 'Effect of approving',
          proposalLoosensNothing: 'Nothing gets looser.',
          proposalModeAsk: 'Needs a person',
          proposalKindBaseline: 'for all',
        },
      });
      const section = within(screen.getByRole('region', { name: 'Effect of approving' }));
      expect(section.getByText('Nothing gets looser.')).toBeDefined();
      expect(items(sectionOf('Policies'))[0]).toBe('send_email on crm: Needs a person (for all)');
    });

    it('renders the section through the Card slot, so a replacement of that role reaches it', () => {
      const seen: string[] = [];
      function MyCard({ className, ...rest }: CardProps): ReactNode {
        seen.push(className ?? '');
        return <div data-mine="card" className={className} {...rest} />;
      }
      show(detailOf(ARGUMENTS, PREVIEW), { components: { Card: MyCard } });
      expect(seen).toContain('nc-proposal');
      const mine = proposal();
      expect(mine.getAttribute('data-mine')).toBe('card');
      expect(mine.className).toContain('nc-proposal');
    });
  });
});
