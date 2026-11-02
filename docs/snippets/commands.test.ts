/**
 * The guide's sh blocks, run as separate processes: `bun docs/snippets/<name>.ts` against a mock.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startMock } from '@noblecloak/spec';
import type { RunningMock } from '@noblecloak/spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let mock: RunningMock;

beforeEach(async () => {
  mock = await startMock({ control: true });
});

afterEach(async () => {
  await mock.stop();
});

function run(name: string): Promise<{ code: number | null; out: string; err: string }> {
  const file = fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
  return new Promise((resolve) => {
    const child = spawn('bun', [file], { env: { ...process.env, NC_BASE_URL: mock.baseUrl } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ code, out, err });
    });
  });
}

describe('the guide commands as separate processes', () => {
  it('consume-and-record.ts alone carries out steps 4 to 6', async () => {
    const result = await run('consume-and-record');
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('consumed');
    expect(result.out).toContain('true');
  }, 30_000);

  it('consume-and-record.ts can be run again against the same mock', async () => {
    expect((await run('consume-and-record')).code).toBe(0);
    const again = await run('consume-and-record');
    expect(again.err).toBe('');
    expect(again.code).toBe(0);
    expect(again.out).toContain('consumed');
  }, 60_000);

  it('approve.ts then resume.ts on one mock is refused, which is why the guide says to restart the mock', async () => {
    expect((await run('approve')).code).toBe(0);
    const second = await run('resume');
    expect(second.code).not.toBe(0);
    expect(second.err).toContain('409 already_resolved');
  }, 30_000);

  it('resume.ts runs against a fresh mock', async () => {
    const result = await run('resume');
    expect(result.code).toBe(0);
    expect(result.out).toContain('digest_mismatch');
  }, 30_000);
});
