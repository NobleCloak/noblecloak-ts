import { describe, expect, it } from 'vitest';

import { renderAdaptiveCard } from './adaptive-card.js';
import { MESSAGE_ID, OTHER_VIEWER, full, options } from './fixtures.test-support.js';
import { RESERVED_INPUT_NAMES } from './limits.js';
import type { Approval } from './model.js';
import { toApprovalCard } from './model.js';
import { encodeActionPayload } from './payload.js';

const withInput = (name: string): Partial<Approval> => ({
  available_actions: [
    { id: 'approve', kind: 'resolve', resolution: 'approved', label: 'Approve', inputs: [] },
    {
      id: 'deny',
      kind: 'resolve',
      resolution: 'rejected',
      label: 'Deny',
      inputs: [{ name, type: 'text', label: 'Why?', required: false }],
    },
  ] as never,
});

describe('an input named like a click-payload key', () => {
  it('reserves exactly the keys of the click payload', () => {
    const card = toApprovalCard(full(), OTHER_VIEWER, options());
    const keys = Object.keys(JSON.parse(encodeActionPayload(card, MESSAGE_ID)) as object);
    expect([...RESERVED_INPUT_NAMES].sort()).toEqual(keys.sort());
  });

  it.each([...RESERVED_INPUT_NAMES])(
    'drops the action that takes an input named %s, and keeps the others',
    (name) => {
      const card = toApprovalCard(full(withInput(name)), OTHER_VIEWER, options());
      expect(card.actions.map((a) => a.id)).toEqual(['approve']);
      const out = renderAdaptiveCard(card, { sentMessageId: MESSAGE_ID });
      expect(JSON.stringify(out.card)).not.toContain('Input.Text');
    }
  );

  it('keeps an input with an ordinary name', () => {
    const card = toApprovalCard(full(withInput('ticket')), OTHER_VIEWER, options());
    expect(card.actions.map((a) => a.id)).toEqual(['approve', 'deny']);
  });
});
