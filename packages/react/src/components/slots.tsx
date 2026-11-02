import { NcComponentsProvider, useNcComponents } from '@noblecloak/theme';
import type { NcComponents } from '@noblecloak/theme';
import type { ReactNode } from 'react';

/**
 * The primitives in force here: `@noblecloak/theme`'s defaults with the replacements of every enclosing `NcProvider`
 * and of the module's own `components` prop applied. Every module element that is a control or a panel renders
 * through this map, so a replacement reaches it.
 */
export const useNc = useNcComponents;

/** A module's `components` prop: replacements by role, applied over any `NcProvider` around the module. */
export type ModuleComponents = Partial<NcComponents>;

/** The `components` of a module given none: stable, so the provider's merged map is kept across renders. */
const NONE: ModuleComponents = /* @__PURE__ */ Object.freeze({});

/**
 * Applies a module's `components` prop to its subtree, over the enclosing providers (the prop wins per role). Without
 * the prop, the subtree reads the enclosing providers alone. The provider is always rendered, so giving or dropping
 * the prop never changes the tree's shape and the module keeps its state.
 */
export function WithComponents({
  components,
  children,
}: {
  readonly components: ModuleComponents | undefined;
  readonly children: ReactNode;
}) {
  return <NcComponentsProvider components={components ?? NONE}>{children}</NcComponentsProvider>;
}
