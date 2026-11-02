import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The app's own modules are imported as `@app/...`: Next's bundler does not map a `.js` suffix to a `.ts` file.
  resolve: { alias: { '@app': join(import.meta.dirname, 'app') } },
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts', 'app/**/*.test.tsx', 'next.config.test.ts', 'proxy.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['*.ts', 'app/**/*.ts', 'app/**/*.tsx'],
      exclude: [
        '*.test.ts',
        'app/**/*.test.ts',
        'app/**/*.test.tsx',
        'vitest.config.ts',
        'playwright.config.ts',
        'next-env.d.ts',
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
