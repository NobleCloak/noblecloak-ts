import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: the root one never reaches @cedar-policy/cedar-wasm (export, canonical form, diff,
  // format detection), and `import` loads it with a dynamic import() only when a file is imported.
  entry: ['src/index.ts', 'src/import.ts'],
  format: ['esm'],
  // Declarations are emitted by `tsc -p tsconfig.build.json` (see the build script): tsup's
  // dts step injects `baseUrl`, which TypeScript 6 rejects as deprecated.
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
