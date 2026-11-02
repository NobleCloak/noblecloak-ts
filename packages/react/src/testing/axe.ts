import axeCore from 'axe-core';
import type { AxeResults } from 'axe-core';

/** Runs axe-core over a rendered container (jsdom has no layout, so colour contrast is off). */
export function axe(container: Element): Promise<AxeResults> {
  return axeCore.run(container, { rules: { 'color-contrast': { enabled: false } } });
}
