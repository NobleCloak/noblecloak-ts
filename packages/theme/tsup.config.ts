import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

import { defineConfig } from 'tsup';

/**
 * The JavaScript is bundled by tsup (React stays external, as a peer). The CSS is hand-written and is not
 * processed: `dist/tokens.css`, `dist/components.css` and `dist/fonts.css` are copies, and `dist/index.css` is
 * `tokens.css` followed by `components.css`, so one import gives the tokens and the primitives (`components.css` alone
 * is what `@noblecloak/react` inlines after the tokens it already holds). No step adds an import, a reset or a font.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // Declarations are emitted by `tsc -p tsconfig.build.json` (see the build script): tsup's
  // dts step injects `baseUrl`, which TypeScript 6 rejects as deprecated.
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['react', 'react/jsx-runtime'],
  // The entry calls `createContext` and the primitives use state, which a React Server Component cannot import
  // (React's server build has neither). The directive makes the whole entry a client module under the App Router.
  banner: { js: "'use client';" },
  async onSuccess() {
    await mkdir('dist', { recursive: true });
    const tokens = await readFile('src/styles/tokens.css', 'utf8');
    const components = await readFile('src/styles/components.css', 'utf8');
    await writeFile('dist/index.css', `${tokens}\n${components}`);
    await copyFile('src/styles/tokens.css', 'dist/tokens.css');
    await copyFile('src/styles/components.css', 'dist/components.css');
    await copyFile('src/styles/fonts.css', 'dist/fonts.css');
    await copyFile('src/tokens.json', 'dist/tokens.json');
  },
});
