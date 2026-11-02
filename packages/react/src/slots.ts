/**
 * The `slots` entry: bring your own components. `NcProvider` (also exported as `NcComponentsProvider`) replaces
 * primitives, by role, for every module rendered below it; `useNc` (also `useNcComponents`) returns the map in
 * force; `useSlot` reads one role; `defaultComponents` is the shipped map to spread under a replacement. They are
 * `@noblecloak/theme`'s, re-exported, so a provider from this entry and the modules share one context.
 */
export {
  defaultComponents,
  NcComponentsProvider,
  NcComponentsProvider as NcProvider,
  useNcComponents,
  useNcComponents as useNc,
  useSlot,
} from '@noblecloak/theme';
export type {
  NcComponents,
  NcComponentsProviderProps,
  NcComponentsProviderProps as NcProviderProps,
} from '@noblecloak/theme';
