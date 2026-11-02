import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**/*.ts'],
      // The bin wrapper runs at import: it binds stdio, SIGINT and the browser opener into an Io and sets
      // process.exitCode from runCli. runCli and the modules it calls are measured here.
      exclude: ['src/**/*.test.ts', 'src/**/*.test-support.ts', 'src/noblecloak.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
