#!/usr/bin/env bun
/**
 * nc-conform: runs the conformance suite against any server that claims to implement the module API.
 *
 *   nc-conform --base-url https://govern.example.com --token <jwt> [--approver-token <jwt>] \
 *     [--deployment hosted|edge] [--allow-undeclared]
 *
 * --webhook-sink <https-base> --webhook-sink-token <token> [--webhook-sink-wait <1-300 s>] [--webhook-sink-settle <0-60 s>]
 * name a public receiver: scenarios register their webhooks under it and read the deliveries back from it (a bearer GET
 * of the registered URL), polling every 2 s up to the wait and re-reading after the settle.
 *
 * A response that carries a field its schema does not declare fails the run; --allow-undeclared
 * turns that off. --json prints the report as JSON.
 *
 * A run reads GET /v1/capabilities first; a scenario for a route family the deployment does not
 * advertise is printed `skipped: capability` and does not affect the exit code.
 *
 * Exits 0 only when every scenario passed and none was skipped for lack of configuration (a missing
 * --approver-token (every scenario that has the approver act), --creator-user-token, --other-org-token, --entitled-token, --wrong-audience-token, --forged-token,
 * --expired-token, --dpop-bound-token, --no-org-token, --no-scope-token, --other-service-token, --approver-surface-token, --approver-token-without-resolve-scope, --member-token, --reserved-tool-ref, --system-tool-ref, --tool-ref-in-use, --on-deny-tool-ref, --on-deny-silent-tool-ref, --admin-role (rev 11: a role the --admin-token holds), --connection-server-url (rev 11: a tool server the deployment can enumerate), --oauth-return-to (rev 11: a return_to the deployment admits), --clock-control or --mock-control). --admin-token is the token of the steps that register or change a
 * tool (`as: admin`); absent, it is --token, except that the one scenario that needs a real administrator user
 * (tools-principal-owned-seen-by-administrator-users-only) is skipped as unconfigured. Pass --allow-skips to exit on failures alone; the skipped
 * scenarios are still listed in a warning. A usage error exits 2.
 */
import { runConformCli } from './nc-conform-main.js';

process.exit(
  await runConformCli(process.argv.slice(2), {
    out: (text) => {
      console.log(text);
    },
    err: (text) => {
      console.error(text);
    },
  })
);
