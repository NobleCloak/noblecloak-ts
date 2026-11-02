import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The conformance and matrix files keep every core busy for minutes. Beside them, a test that packs
    // the tarball or lints the whole document has taken longer than vitest's default 5 s and timed out,
    // a different test on each run. Tests that set their own, longer timeout keep it.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**/*.ts'],
      // The bin wrappers run at import and call process.exit; everything they call is covered.
      exclude: [
        'src/**/*.test.ts',
        'src/cli/nc-conform.ts',
        'src/cli/nc-mock.ts',
        'src/cli/build-public.ts',
        'src/cli/conformance-mock.ts',
        'src/cli/generate-fixtures.ts',
        'src/cli/lint.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
