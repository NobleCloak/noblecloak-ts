import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests are `node` unless a file opts in with `// @vitest-environment jsdom`.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**/*.ts', 'src/**/*.tsx', 'tools/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
