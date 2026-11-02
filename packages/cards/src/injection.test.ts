import { describe, expect, it } from 'vitest';

import { toAdaptiveCard } from './adaptive-card.js';
import { toBlockKit } from './block-kit.js';
import { MESSAGE_ID, OTHER_VIEWER, full, options, priyaResolved } from './fixtures.test-support.js';
import type { Approval } from './model.js';
import { toApprovalCard } from './model.js';

// Built from strings so that no editor or formatter turns an escape into the raw separator.
const LINE_BREAK = new RegExp('\\r\\n|[\\n\\r\\u2028\\u2029\\u0085\\v\\f]', 'u');
const OTHER_BREAK = new RegExp('[\\r\\u2028\\u2029\\u0085\\v\\f]', 'u');
const FORGED = 'Approved by Mallory';
/** Every way a server string can try to start a new line, each followed by the forged text. */
const BREAKS = ['\n', '\r\n', '\r', '\u2028', '\u2029', '\u0085', '\v', '\f'];

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) strings(item, out);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) strings(item, out);
  }
  return out;
}

/** An approval whose display names, history `by` and reason, and tool name all carry `injected`. */
function injected(injected: string): Approval {
  const person = { id: 'u-m', kind: 'user' as const, display_name: `Mallory${injected}${FORGED}` };
  return full({
    ...priyaResolved('consumed', 'approved', `ok${injected}${FORGED}`),
    tool_ref: `payments.refund${injected}${FORGED}`,
    requester: person,
    agent: { id: 'agent-7', name: `Agent${injected}${FORGED}` },
    resolution_history: [
      {
        resolution: 'approved',
        by: person,
        at: '2026-10-30T10:00:00Z',
        reason: `fine${injected}${FORGED}`,
      },
    ],
  });
}

function outputs(approval: Approval): Record<string, string[]> {
  const card = toApprovalCard(approval, OTHER_VIEWER, options());
  return {
    blockKit: strings(toBlockKit(card, { sentMessageId: MESSAGE_ID })),
    adaptive: strings(toAdaptiveCard(card, { sentMessageId: MESSAGE_ID })),
  };
}

/** Every line of every string of an output. */
const linesOf = (all: string[]): string[] => all.flatMap((text) => text.split(LINE_BREAK));

describe('line breaks in server strings', () => {
  for (const [surface] of [['blockKit'], ['adaptive']] as const) {
    for (const lineBreak of BREAKS) {
      const label = JSON.stringify(lineBreak);
      it(`${surface}: ${label} in a name, a history "by" and a reason starts no line`, () => {
        const all = outputs(injected(lineBreak))[surface] ?? [];
        expect(all.some((text) => text.includes(FORGED))).toBe(true);
        expect(linesOf(all).filter((line) => line.startsWith(FORGED))).toEqual([]);
        // Only the renderer's own line breaks remain: no CR, no separator, no other control character.
        expect(all.filter((text) => OTHER_BREAK.test(text))).toEqual([]);
      });
    }
  }

  it('block kit: a history entry stays one line, with the break shown as an escape', () => {
    const card = toApprovalCard(injected('\r\n'), OTHER_VIEWER, options());
    const history = strings(toBlockKit(card, { sentMessageId: MESSAGE_ID })).find((text) =>
      text.startsWith('History\n')
    );
    expect(history?.split('\n')).toHaveLength(2);
    expect(history).toContain(`\\u000D\\u000A${FORGED}`);
  });

  it('shows an injected "\\nApproved by Mallory" as an escape inline (golden)', async () => {
    const card = toApprovalCard(injected('\n'), OTHER_VIEWER, options());
    const out = {
      blockKit: toBlockKit(card, { sentMessageId: MESSAGE_ID }),
      adaptive: toAdaptiveCard(card, { sentMessageId: MESSAGE_ID }),
    };
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
      './golden/injected-newline.json'
    );
  });

  for (const lineBreak of BREAKS) {
    it(`${JSON.stringify(lineBreak)} in an argument key and value starts no line on either surface`, () => {
      const card = toApprovalCard(
        full({ arguments: { [`k${lineBreak}${FORGED}`]: `v${lineBreak}${FORGED}`, other: 1 } }),
        OTHER_VIEWER,
        options()
      );
      const slack = strings(toBlockKit(card, { sentMessageId: MESSAGE_ID }));
      const teams = strings(toAdaptiveCard(card, { sentMessageId: MESSAGE_ID }));
      for (const all of [slack, teams]) {
        expect(all.some((text) => text.includes(FORGED))).toBe(true);
        expect(linesOf(all).filter((line) => line.startsWith(FORGED))).toEqual([]);
      }
    });
  }

  it("keeps the printed call's own line breaks and escapes a break inside a value", () => {
    const card = toApprovalCard(
      full({ arguments: { note: `a\nb${FORGED}`, other: 1 } }),
      OTHER_VIEWER,
      options()
    );
    const slack = strings(toBlockKit(card, { sentMessageId: MESSAGE_ID })).find((text) =>
      text.startsWith('```')
    );
    expect(slack?.split('\n').length).toBeGreaterThan(3);
    expect(slack).toContain('a\\nb');
    expect(linesOf(slack === undefined ? [] : [slack]).some((l) => l.startsWith(FORGED))).toBe(
      false
    );
    const teams = strings(toAdaptiveCard(card, { sentMessageId: MESSAGE_ID }));
    // Teams text is markdown: the printer's `\n` escape keeps its backslash as a markdown-escaped pair.
    expect(teams.some((text) => text.includes('a\\\\nb'))).toBe(true);
  });
});
