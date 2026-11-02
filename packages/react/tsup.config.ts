import { defineConfig } from 'tsup';
import type { Options } from 'tsup';

import { buildReactStyles } from '../../scripts/build-react-styles.js';

const common: Options = {
  format: ['esm'],
  // Declarations are emitted by `tsc -p tsconfig.build.json` (see the build script): tsup's
  // dts step injects `baseUrl`, which TypeScript 6 rejects as deprecated.
  dts: false,
  sourcemap: true,
  target: 'es2022',
};

export default defineConfig([
  {
    ...common,
    entry: ['src/index.ts'],
    // Only this config cleans: two cleans would race and delete each other's output.
    clean: true,
  },
  {
    ...common,
    // The approvals, action-status, auth, slots, permissions and connections entries are client modules under the App Router, so they carry
    // `'use client'`. It also makes `MODULE_ID` and `AuthError` client references to a server component (README,
    // "Client-only entries"). A banner applies to a whole config, so they have their own. `@noblecloak/theme` is a
    // dependency, so tsup leaves it external: every entry imports the one context the theme owns.
    entry: [
      'src/approvals.ts',
      'src/action-status.ts',
      'src/auth.ts',
      'src/slots.ts',
      'src/permissions.ts',
      'src/connections.ts',
    ],
    banner: { js: "'use client';" },
    clean: false,
    // dist/styles.css is src/styles.css with its marker replaced by @noblecloak/theme's tokens.css, inlined.
    onSuccess() {
      buildReactStyles(process.cwd());
      return Promise.resolve();
    },
  },
]);
