#!/usr/bin/env bun
/**
 * nc-mock: serves the mock module API from fixtures, so modules and adapters can build before the
 * facade exists. It is not a reference implementation of policy: its decide is a fixture lookup.
 *
 *   nc-mock [--port 8787] [--deployment hosted|edge] [--break <flag>]...
 *
 * Prints the base URL and a set of dev tokens, then serves until interrupted. `--break` flips one
 * behaviour on purpose (see src/mock/breaks.ts); it exists to prove conformance negatives can fail.
 */
import { startMockCli } from './nc-mock-main.js';

const started = await startMockCli(process.argv.slice(2), {
  out: (text) => {
    console.log(text);
  },
  err: (text) => {
    console.error(text);
  },
});
if ('exit' in started) process.exit(started.exit);
