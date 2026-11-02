import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The stylesheet puts the module's own plain elements back to the browser's defaults inside `.nc-root`, from a
// list of element names. This derives the elements the components render from their sources, so an element added
// to a component without adding it to that list fails here rather than on a host page. The reset also leaves out
// the classes the modules pass to a replaceable component (a builder's Card that merges `nc-detail` into its own
// classes keeps its rules); a class passed to one that the list misses fails here too.

const SRC = fileURLToPath(new URL('.', import.meta.url));
const COMPONENTS = join(SRC, 'components');
/** The theme's Tabs renders its toggles through the `Button` slot, with a class of its own. */
const THEME_TABS = fileURLToPath(new URL('../../theme/src/components/Tabs.tsx', import.meta.url));

/** The replaceable components (`NcComponents`'s roles). */
const SLOTS = ['Button', 'Checkbox', 'Textarea', 'Alert', 'Card', 'Tabs'];

/** The element names in the `:where(...)` list of the rule that sets `all: revert`. */
function resetElements(css: string): Set<string> {
  const rule = /:where\(([^)]*)\)[^{]*\{\s*all:\s*revert;/.exec(css);
  if (rule?.[1] === undefined) throw new Error('styles.css has no `all: revert` reset');
  return new Set(rule[1].split(',').map((name) => name.trim()));
}

/** The classes the reset leaves out: the `.nc-*` names in its `:not(...)` list. */
function resetExclusions(css: string): Set<string> {
  const rule = /:where\(([^{]*)\{\s*all:\s*revert;/.exec(css);
  const list = rule?.[1] === undefined ? undefined : /:not\((\.nc-[^)]*)\)/.exec(rule[1]);
  if (list?.[1] === undefined)
    throw new Error('the `all: revert` reset has no `:not(.nc-...)` list');
  return new Set(list[1].split(',').map((name) => name.trim().replace(/^\./, '')));
}

/**
 * The classes passed to a replaceable component: each `className` of an opening `<Button ...>` (or another slot)
 * up to its first `>` that is not part of `=>`. A `className={...}` expression throws, so a class this cannot read
 * is never missed.
 */
function slotClasses(source: string): Set<string> {
  const classes = new Set<string>();
  const opening = new RegExp(`<(?:${SLOTS.join('|')})\\b((?:=>|[^>])*)>`, 'g');
  for (const match of source.matchAll(opening)) {
    const props = match[1] ?? '';
    if (props.includes('className={'))
      throw new Error(`unreadable className in <${match[0].slice(1, 40)}`);
    for (const literal of props.matchAll(/className="([^"]*)"/g)) {
      for (const name of (literal[1] ?? '').split(/\s+/)) if (name !== '') classes.add(name);
    }
  }
  return classes;
}

/** Lower-case JSX tags (intrinsic elements); a `<` after an identifier is a type argument, not a tag. */
function intrinsicTags(source: string): Set<string> {
  const tags = new Set<string>();
  for (const match of source.matchAll(/(?<![\w$.)\]])<([a-z][a-z0-9]*)(?=[\s/>])/g)) {
    if (match[1] !== undefined) tags.add(match[1]);
  }
  return tags;
}

describe('the plain-element reset', () => {
  it('lists every element a component renders', () => {
    const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
    const listed = resetElements(css);
    const rendered = new Set<string>();
    for (const name of readdirSync(COMPONENTS)) {
      if (!name.endsWith('.tsx') || name.includes('.test.')) continue;
      for (const tag of intrinsicTags(readFileSync(join(COMPONENTS, name), 'utf8')))
        rendered.add(tag);
    }
    expect(rendered.size).toBeGreaterThan(10);
    expect([...rendered].filter((tag) => !listed.has(tag)).sort()).toEqual([]);
  });

  it('leaves out every class a module passes to a replaceable component', () => {
    const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
    const excluded = resetExclusions(css);
    const passed = slotClasses(readFileSync(THEME_TABS, 'utf8'));
    for (const name of readdirSync(COMPONENTS)) {
      if (!name.endsWith('.tsx') || name.includes('.test.')) continue;
      for (const cls of slotClasses(readFileSync(join(COMPONENTS, name), 'utf8'))) passed.add(cls);
    }
    expect([...passed].sort()).toEqual(['nc-detail', 'nc-error', 'nc-row', 'nc-tabs', 'nc-toggle']);
    expect([...passed].filter((cls) => !excluded.has(cls)).sort()).toEqual([]);
  });

  it('reads a slot class and its exclusion (positive and negative controls)', () => {
    expect([
      ...slotClasses(
        '<Card role="region" className="nc-detail a" onClick={() => go()}>x</Card><div className="nc-no" />'
      ),
    ]).toEqual(['nc-detail', 'a']);
    expect(() => slotClasses('<Alert className={cls} />')).toThrow(/unreadable/);
    expect(
      resetExclusions('.nc-root :where(div):where(:is(.x):not(.nc-a, .nc-b)) { all: revert; }')
    ).toEqual(new Set(['nc-a', 'nc-b']));
  });

  it('sees a tag and skips a type argument (positive and negative controls)', () => {
    expect([
      ...intrinsicTags('const a = useState<string>(); return <ol><li key="x">{a}</li></ol>;'),
    ]).toEqual(['ol', 'li']);
    expect(resetElements('.nc-root :where(div, ol) { all: revert; }')).toEqual(
      new Set(['div', 'ol'])
    );
  });
});
