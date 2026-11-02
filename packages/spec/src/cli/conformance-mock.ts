/**
 * `bun run conformance:mock`: starts the mock, runs the suite against both deployments, a deployment that
 * restricts everything it can and one that serves no runs, then the broken-mock matrix. Exits non-zero unless
 * everything holds.
 */
import { NO_RUNS_RUN, RESTRICTED_RUN, runAgainstMock } from '../conformance/against-mock.js';
import { formatMatrix, runMatrix } from '../conformance/matrix.js';
import { formatReport } from '../conformance/run.js';

let ok = true;
// A deployment that restricts what the capabilities say it can, and one that serves no runs: the scenarios
// about a restriction run only there, and the rest of the suite must still pass.
for (const run of [
  { deployment: 'hosted' as const },
  { deployment: 'edge' as const },
  RESTRICTED_RUN,
  NO_RUNS_RUN,
]) {
  const report = await runAgainstMock(run);
  console.log(formatReport(report));
  ok &&= report.failed === 0;
}
const matrix = await runMatrix();
console.log(formatMatrix(matrix));
ok &&= matrix.ok;
process.exit(ok ? 0 : 1);
