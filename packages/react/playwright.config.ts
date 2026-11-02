import { defineConfig } from '@playwright/test';

/**
 * The end-to-end lane (`bun run e2e`, after `bun run build`; not part of `test`), in a real browser: the built
 * `dist/styles.css` against the stylesheet 0.4.2 shipped (`test-fixtures/styles-0.4.2.css`), compared by computed
 * style (e2e/styles-golden.spec.ts), and the built modules on a hostile host, with a replaced Button and re-themed
 * by `--nc-*` only (e2e/modules.spec.ts, whose page script e2e/global-setup.ts bundles). Pages are served by
 * `page.route`, so there is no web server, and every request off the page's origin is aborted and recorded.
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
