import { defineConfig } from '@playwright/test';

/**
 * The theme's end-to-end lane (`bun run e2e`, after `bun run build`; not part of `test`): the leak, inward,
 * no-network and contrast tests in a real browser. Pages are served by `page.route` (e2e/harness.ts), so there
 * is no web server, and every request off the page's origin is aborted and recorded.
 */
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: { browserName: 'chromium', colorScheme: 'light' },
});
