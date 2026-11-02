import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { MAX_REF_CHARS, clipText } from './format.js';

describe('c2-9 clipText', () => {
  it('leaves a short value alone and cuts a long one at 200 with an ellipsis', () => {
    expect(clipText('mcp:tracker:create_issue')).toBe('mcp:tracker:create_issue');
    expect(clipText('x'.repeat(MAX_REF_CHARS))).toHaveLength(MAX_REF_CHARS);
    const cut = clipText('x'.repeat(5000));
    expect(cut).toBe(`${'x'.repeat(MAX_REF_CHARS)}…`);
  });

  it('does not split a surrogate pair, and shows a non-string as text', () => {
    const cut = clipText('x'.repeat(MAX_REF_CHARS - 1) + '\u{1F600}'.repeat(3));
    expect(cut).toBe(`${'x'.repeat(MAX_REF_CHARS - 1)}…`);
    expect(clipText(undefined)).toBe('');
    expect(clipText(42)).toBe('42');
  });
});

describe('c2-9 the stylesheet clips server text in rows and the heading', () => {
  it('has overflow hidden, contain paint and a max-height on both containers', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    const rule = /\.nc-root \.nc-row-tool,\s*\.nc-root \.nc-detail > h3 \{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/overflow:\s*hidden/);
    expect(rule?.[1]).toMatch(/contain:\s*paint/);
    expect(rule?.[1]).toMatch(/max-height:/);
  });
});
