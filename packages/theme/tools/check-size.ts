/**
 * Size budget for `dist/index.css` (`bun run size`, after the build): fails above 20 KB gzip.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const BUDGET_BYTES = 20 * 1024;

export interface SizeReport {
  readonly file: string;
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly ok: boolean;
}

/** Measures `file` (raw and gzip at the default level) against `budget` gzip bytes. */
export function checkSize(file: string, budget = BUDGET_BYTES): SizeReport {
  if (!existsSync(file)) throw new Error(`${file} missing (build first)`);
  const content = readFileSync(file);
  const gzipBytes = gzipSync(content).length;
  return { file, bytes: content.length, gzipBytes, ok: gzipBytes <= budget };
}

export function formatReport(report: SizeReport, budget = BUDGET_BYTES): string {
  const kb = (n: number) => (n / 1024).toFixed(2);
  return `${report.file}: ${kb(report.bytes)} KB, ${kb(report.gzipBytes)} KB gzip (budget ${kb(budget)} KB gzip) ${report.ok ? 'OK' : 'OVER BUDGET'}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = checkSize(join(import.meta.dirname, '..', 'dist', 'index.css'));
  process.stdout.write(`${formatReport(report)}\n`);
  if (!report.ok) process.exit(1);
}
