import { lintSpec } from '../spec/lint.js';

const findings = await lintSpec();
for (const f of findings)
  console.log(`${f.severity.padEnd(5)} ${f.code}  ${f.path}\n      ${f.message}`);
const errors = findings.filter((f) => f.severity === 'error').length;
const warnings = findings.filter((f) => f.severity === 'warn').length;
console.log(
  `spec:lint ${errors === 0 ? 'passed' : 'FAILED'}: ${String(errors)} error(s), ${String(warnings)} warning(s)`
);
process.exit(errors === 0 ? 0 : 1);
