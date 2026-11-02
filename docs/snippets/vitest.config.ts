import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['*.test.ts'],
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['*.ts'],
      exclude: ['*.test.ts', 'vitest.config.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
