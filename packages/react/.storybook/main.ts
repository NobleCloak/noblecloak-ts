import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { StorybookConfig } from '@storybook/react-vite';

import {
  composeStyles,
  readThemeComponents,
  readThemeTokens,
} from '../../../scripts/build-react-styles.js';

const PACKAGE = join(import.meta.dirname, '..');

/** The id the preview imports; the stories get the stylesheet the build ships, composed by the same function. */
const STYLES_ID = 'virtual:nc-react-styles.css';
const RESOLVED_STYLES_ID = `\0${STYLES_ID}`;

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../stories/**/*.stories.tsx'],
  core: { disableTelemetry: true },
  viteFinal(vite) {
    vite.plugins = [
      ...(vite.plugins ?? []),
      {
        name: 'nc-react-styles',
        resolveId: (id: string) => (id === STYLES_ID ? RESOLVED_STYLES_ID : undefined),
        load: (id: string) =>
          id === RESOLVED_STYLES_ID
            ? composeStyles(
                readFileSync(join(PACKAGE, 'src', 'styles.css'), 'utf8'),
                readThemeTokens(PACKAGE),
                readThemeComponents(PACKAGE)
              )
            : undefined,
      },
    ];
    return vite;
  },
};

export default config;
