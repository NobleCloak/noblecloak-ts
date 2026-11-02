import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { noblecloak: 'src/noblecloak.ts' },
  format: ['esm'],
  // The package is a command, not a library: it ships no declarations.
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
