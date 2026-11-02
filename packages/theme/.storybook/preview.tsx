import type { Decorator, Preview } from '@storybook/react-vite';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

import '../src/styles/tokens.css';
import '../src/styles/components.css';
import '../demo/builder-brand.css';
// Vite's query suffix: the file is .css, and `?inline` returns its text instead of injecting it.
// eslint-disable-next-line no-restricted-syntax
import hostileCss from '../demo/hostile.css?inline';
import { BuilderButton } from '../demo/SlotDemo.js';
import { defaultComponents, NcComponentsProvider } from '../src/index.js';

/**
 * Every story renders under one of five modes, picked in the toolbar (or fixed by a story's `ncMode`
 * parameter): the default light or dark palette, a hostile host page (demo/hostile.css on the whole
 * preview), a builder's slot (Button replaced), or a builder's brand file (the eight shipped names only).
 */
export type NcMode = 'light' | 'dark' | 'hostile' | 'slot' | 'brand';

function HostileStyles({ children }: { children: ReactNode }) {
  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.ncHostile = '';
    style.textContent = hostileCss;
    document.head.append(style);
    return () => {
      style.remove();
    };
  }, []);
  return children;
}

const withMode: Decorator = (Story, context) => {
  const mode =
    (context.parameters.ncMode as NcMode | undefined) ??
    (context.globals.ncMode as NcMode | undefined) ??
    'light';
  const root = (
    <div className={mode === 'brand' ? 'builder-brand' : undefined}>
      <div
        className="nc-root"
        data-nc-theme={mode === 'dark' ? 'dark' : 'light'}
        style={{ padding: '1rem' }}
      >
        <Story />
      </div>
    </div>
  );
  if (mode === 'hostile') return <HostileStyles>{root}</HostileStyles>;
  if (mode === 'slot') {
    return (
      <NcComponentsProvider components={{ ...defaultComponents, Button: BuilderButton }}>
        {root}
      </NcComponentsProvider>
    );
  }
  return root;
};

const preview: Preview = {
  decorators: [withMode],
  globalTypes: {
    ncMode: {
      description: 'Theme mode',
      toolbar: {
        title: 'Mode',
        icon: 'paintbrush',
        items: [
          { value: 'light', title: 'Default light' },
          { value: 'dark', title: 'Default dark' },
          { value: 'hostile', title: 'Hostile host' },
          { value: 'slot', title: 'Builder slot (Button replaced)' },
          { value: 'brand', title: 'Builder brand (eight names)' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { ncMode: 'light' },
  parameters: { layout: 'fullscreen' },
};

export default preview;
