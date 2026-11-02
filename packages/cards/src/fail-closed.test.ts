import { describe, expect, it } from 'vitest';

import { renderAdaptiveCard } from './adaptive-card.js';
import { renderBlockKit } from './block-kit.js';
import {
  APPROVALS_URL,
  APPROVAL_ID,
  MESSAGE_ID,
  OTHER_VIEWER,
  full,
  minimal,
  options,
} from './fixtures.test-support.js';
import type { Approval, ApprovalCardOptions } from './model.js';
import { toApprovalCard } from './model.js';
import { CARD_TEXT } from './text.js';

const throwing = (name: string): Approval =>
  Object.defineProperty({ ...full() }, name, {
    get(): never {
      throw new Error('boom');
    },
    enumerable: true,
  });

describe('toApprovalCard never throws', () => {
  it('returns the minimal link-only card when the capabilities are missing', () => {
    const card = toApprovalCard(full(), OTHER_VIEWER, {
      blockCallInChat: false,
      approvalsUrl: APPROVALS_URL,
    } as unknown as ApprovalCardOptions);
    expect(card.degraded).toEqual(['minimal']);
    expect(card.approvalId).toBe(APPROVAL_ID);
    expect(card.actions).toEqual([]);
    expect(card.links.open).toBe(APPROVALS_URL);
    expect(card.facts.call.kind).toBe('link');
    expect(card.status.line).toBe(CARD_TEXT.statusUnknown);
    expect(card.status.requirements).toEqual([{ id: 'approval', state: 'unknown' }]);
    expect(card.header.headline).toBe(CARD_TEXT.headlineUnknown);
  });

  it.each([
    'state',
    'tool_ref',
    'requester',
    'arguments',
    'resolution_history',
    'available_actions',
  ])('returns it, with the id and the link, when reading %s throws', (member) => {
    const card = toApprovalCard(throwing(member), OTHER_VIEWER, options());
    expect(card.degraded).toEqual(['minimal']);
    expect(card.approvalId).toBe(APPROVAL_ID);
    expect(card.links.open).toBe(APPROVALS_URL);
    expect(card.actions).toEqual([]);
  });

  it('returns it from the approval id alone when the id cannot be read either', () => {
    const card = toApprovalCard(throwing('id'), OTHER_VIEWER, options());
    expect(card.degraded).toEqual(['minimal']);
    expect(card.approvalId).toBe('');
    expect(card.links.open).toBe(APPROVALS_URL);
  });

  it('returns it for a revoked proxy as the approval, and for revoked options', () => {
    const approval = Proxy.revocable({ ...full() }, {});
    approval.revoke();
    const fromProxy = toApprovalCard(approval.proxy, OTHER_VIEWER, options());
    expect(fromProxy.degraded).toEqual(['minimal']);
    expect(fromProxy.approvalId).toBe('');
    expect(fromProxy.links.open).toBe(APPROVALS_URL);
    const opts = Proxy.revocable({ ...options() }, {});
    opts.revoke();
    const fromOptions = toApprovalCard(full(), OTHER_VIEWER, opts.proxy);
    expect(fromOptions.degraded).toEqual(['minimal']);
    expect(fromOptions.approvalId).toBe(APPROVAL_ID);
    expect(fromOptions.links.open).toBe('');
  });

  it('returns it for a revoked proxy as the arguments', () => {
    const args = Proxy.revocable({}, {});
    args.revoke();
    const card = toApprovalCard(full({ arguments: args.proxy }), OTHER_VIEWER, options());
    expect(card.degraded).toEqual(['minimal']);
  });

  it('renders as the minimal message on both surfaces, with the link', () => {
    const card = toApprovalCard(full(), OTHER_VIEWER, {
      blockCallInChat: false,
      approvalsUrl: APPROVALS_URL,
    } as unknown as ApprovalCardOptions);
    const slack = renderBlockKit(card, { sentMessageId: MESSAGE_ID });
    const teams = renderAdaptiveCard(card, { sentMessageId: MESSAGE_ID });
    expect(slack.degraded).toEqual(['minimal']);
    expect(teams.degraded).toEqual(['minimal']);
    expect(slack.message.blocks.map((b) => b.type)).toEqual([
      'header',
      'section',
      'context',
      'actions',
    ]);
    expect(JSON.stringify(slack.message)).toContain(APPROVALS_URL);
    expect(JSON.stringify(teams.card)).toContain(APPROVALS_URL);
    expect(JSON.stringify(teams.card)).not.toContain('FactSet');
    expect(JSON.stringify(teams.card)).not.toContain('Action.Execute');
  });

  it('adds no_link when the link could not be read', () => {
    const opts = Proxy.revocable({ ...options() }, {});
    opts.revoke();
    const card = toApprovalCard(full(), OTHER_VIEWER, opts.proxy);
    expect(renderBlockKit(card, {}).degraded).toEqual(['no_link', 'minimal']);
    expect(renderAdaptiveCard(card, {}).degraded).toEqual(['no_link', 'minimal']);
  });
});

describe('a malformed read is labelled for what it is', () => {
  it.each([
    ['a string', 'text'],
    ['a number', 5],
    ['null', null],
    ['an array', [1]],
  ])('arguments that are %s are unreadable, not absent from the read', (_name, value) => {
    const card = toApprovalCard(full({ arguments: value as never }), OTHER_VIEWER, options());
    expect(card.facts.call).toEqual({ kind: 'link', why: 'unreadable' });
    const slack = JSON.stringify(renderBlockKit(card, {}).message);
    expect(slack).toContain(CARD_TEXT.callUnreadable);
    expect(slack).not.toContain(CARD_TEXT.callNotOnRead);
  });

  it('keeps not_on_read for arguments the read does not carry, and blocked over both', () => {
    const absent = full();
    delete (absent as { arguments?: unknown }).arguments;
    expect(toApprovalCard(absent, OTHER_VIEWER, options()).facts.call).toEqual({
      kind: 'link',
      why: 'not_on_read',
    });
    expect(
      toApprovalCard(
        full({ arguments: 'x' as never }),
        OTHER_VIEWER,
        options({ blockCallInChat: true })
      ).facts.call
    ).toEqual({ kind: 'link', why: 'blocked' });
  });

  it.each([['archived'], [5], [null], [undefined], ['']])(
    'a state of %s reads "Status unknown", never "Closed"',
    (state) => {
      const card = toApprovalCard(
        full({ state: state as never, resolution: 'approved' }),
        OTHER_VIEWER,
        options()
      );
      expect(card.status.line).toBe(CARD_TEXT.statusUnknown);
      expect(card.status.line).not.toBe(CARD_TEXT.statusClosed);
      expect(card.status.requirements[0]?.state).toBe('unknown');
      expect(card.actions).toEqual([]);
      expect(JSON.stringify(renderBlockKit(card, {}).message)).toContain(CARD_TEXT.statusUnknown);
    }
  );

  it('still words the known final states', () => {
    for (const [state, line] of [
      ['withdrawn', CARD_TEXT.statusWithdrawn],
      ['expired', CARD_TEXT.statusExpired],
    ] as const) {
      expect(toApprovalCard(minimal({ state }), OTHER_VIEWER, options()).status.line).toBe(line);
    }
  });
});

const listedWith = (input: Record<string, unknown>): Partial<Approval> => ({
  available_actions: [
    { id: 'approve', kind: 'resolve', resolution: 'approved', label: 'Approve', inputs: [] },
    {
      id: 'deny',
      kind: 'resolve',
      resolution: 'rejected',
      label: 'Deny',
      inputs: [{ name: 'why', type: 'text', label: 'Why', required: false, ...input }],
    },
  ] as never,
});

describe('a malformed input member drops the action', () => {
  it.each([
    ['max_length 0', { max_length: 0 }],
    ['max_length 1.5', { max_length: 1.5 }],
    ['max_length -3', { max_length: -3 }],
    ['max_length a string', { max_length: '10' }],
    ['max_length null', { max_length: null }],
    ['required a string', { required: 'yes' }],
    ['required 1', { required: 1 }],
    ['required null', { required: null }],
  ])('%s', (_name, input) => {
    const card = toApprovalCard(full(listedWith(input)), OTHER_VIEWER, options());
    expect(card.actions.map((a) => a.id)).toEqual(['approve']);
    expect(card.degraded).toEqual(['actions_dropped']);
  });

  it('keeps an action whose max_length and required are absent, valid or past the surface bound', () => {
    const ok = toApprovalCard(
      full(listedWith({ max_length: 200, required: true })),
      OTHER_VIEWER,
      options()
    );
    expect(ok.actions.map((a) => a.id)).toEqual(['approve', 'deny']);
    expect(ok.degraded).toEqual([]);
    const input = ok.actions[1]?.inputs[0];
    expect(input).toMatchObject({ maxLength: 200, required: true });
    const bare = toApprovalCard(
      full({
        available_actions: [
          {
            id: 'deny',
            kind: 'resolve',
            resolution: 'rejected',
            label: 'Deny',
            inputs: [{ name: 'why', type: 'text', label: 'Why' }],
          },
        ] as never,
      }),
      OTHER_VIEWER,
      options()
    );
    expect(bare.actions[0]?.inputs[0]).toMatchObject({ maxLength: 1000, required: false });
    const big = toApprovalCard(full(listedWith({ max_length: 99_999 })), OTHER_VIEWER, options());
    expect(big.actions[1]?.inputs[0]?.maxLength).toBe(3000);
  });
});
