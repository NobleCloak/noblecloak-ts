// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { queueRows, renderController } from '../testing/component-harness.js';
import { approvalSummary, detailStates, fakeController } from '../testing/fake-controller.js';

afterEach(cleanup);

const RLO = String.fromCharCode(0x202e);
/** The escape as the component prints it: a backslash, then `u202E`. */
const ESC = String.fromCharCode(0x5c) + 'u202E';
const HIDDEN_CODES = [
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200e, 0x200f,
  0x2028, 0x2029, 0xfff9, 0xfffa, 0xfffb,
];
const hasRaw = (text: string): boolean =>
  HIDDEN_CODES.some((code) => text.includes(String.fromCharCode(code)));

function hostile(): ReturnType<typeof approvalSummary> {
  return approvalSummary({
    tool_ref: `ext:evil:${RLO}tpircs`,
    scope_id: `scope${RLO}1`,
    agent: { id: `agent${RLO}x`, parent: `par${RLO}ent` },
    run: { id: `run${RLO}1`, kind: `kind${RLO}z` as 'external' },
    policy: { id: `pol${RLO}icy`, version: 1 },
    continuation_kind: `cont${RLO}k`,
    resolution_history: [
      {
        resolution: 'escalated',
        by: { id: `by${RLO}someone`, kind: 'user' },
        at: '2026-10-05T12:00:00Z',
        reason: `Approved ✓${RLO}`,
      },
    ],
  });
}

describe('c1-2 every server-controlled string is escaped and isolated', () => {
  it('renders no raw bidirectional control anywhere, in the queue and in the detail', () => {
    const approval = hostile();
    const { container } = renderController(
      fakeController({
        approvals: [approval, ...queueRows(1)],
        detail: { id: approval.id, status: 'loaded', approval, arguments: { a: 1 } },
      })
    );
    expect(hasRaw(container.textContent)).toBe(false);
    expect(container.textContent).toContain(ESC);
  });

  it('puts the tool name, the history reason and the ids in <bdi>', () => {
    const approval = hostile();
    const { container } = renderController(
      fakeController({
        approvals: [approval],
        detail: { id: approval.id, status: 'loaded', approval, arguments: { a: 1 } },
      })
    );
    const isolated = [...container.querySelectorAll('bdi')].map((node) => node.textContent);
    expect(isolated).toContain(`ext:evil:${ESC}tpircs`);
    expect(isolated).toContain(`Approved ✓${ESC}`);
    expect(isolated).toContain(`agent${ESC}x`);
    expect(isolated).toContain(`run${ESC}1`);
    expect(isolated).toContain(`pol${ESC}icy`);
    expect(isolated).toContain(`scope${ESC}1`);
    expect(isolated.some((text) => text.includes(`by${ESC}someone`))).toBe(true);
    expect(screen.getByRole('heading', { level: 3 }).querySelector('bdi')?.textContent).toBe(
      `ext:evil:${ESC}tpircs`
    );
  });

  it('a history reason that reads "Approved ✓" is never the component status text', () => {
    const approval = hostile();
    const { container } = renderController(
      fakeController({
        approvals: [approval],
        detail: { id: approval.id, status: 'loaded', approval, arguments: { a: 1 } },
      })
    );
    const live = container.querySelector('.nc-live');
    expect(live?.textContent).toBe('1 request is waiting for you.');
    expect(live?.textContent).not.toContain('Approved');
    const reason = [...container.querySelectorAll('li p')].find((p) =>
      p.textContent.includes('Approved ✓')
    );
    expect(reason?.querySelector('bdi')).not.toBeNull();
  });
});

describe('c2-9 a very long tool reference is cut in a row and the heading, whole in the facts', () => {
  it('shows 200 characters and an ellipsis, with the full value in the detail facts', () => {
    const long = 'tool-' + 'x'.repeat(1000);
    renderController(
      fakeController({
        approvals: [approvalSummary({ id: 'apr_1', tool_ref: long })],
        detail: detailStates('apr_1', { approval: { tool_ref: long } }).loaded,
      })
    );
    const row = document.querySelector('.nc-row-tool');
    expect(row?.textContent).toBe(`${long.slice(0, 200)}…`);
    expect(document.querySelector('.nc-detail > h3')?.textContent).toBe(`${long.slice(0, 200)}…`);
    expect(document.querySelector('.nc-facts dd')?.textContent).toBe(long);
  });
});
