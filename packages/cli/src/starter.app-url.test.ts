import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Config from './starter-config.js';
import { run } from './harness.test-support.js';
import { GATEWAY_AUDIENCE, installStarterRoutes, writeCredential } from './starter.test-support.js';
import { startStub, type Stub } from './stub.test-support.js';

const APP = 'https://app.test.example';

// The hosts a named deployment resolves to carry the app's address; the stub's loopback URLs do not, so
// this file gives them one to see both approvals print it.
vi.mock('./starter-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Config>();
  return {
    ...actual,
    resolveStarterHosts: (...args: Parameters<typeof actual.resolveStarterHosts>) => ({
      ...actual.resolveStarterHosts(...args),
      appUrl: 'https://app.test.example',
    }),
  };
});

let stub: Stub;
let dir: string;
let credential: string;

beforeEach(async () => {
  stub = await startStub();
  installStarterRoutes(stub);
  dir = await mkdtemp(join(tmpdir(), 'nc-starter-app-'));
  credential = await writeCredential(stub, dir);
});

afterEach(async () => {
  await stub.close();
  await rm(dir, { recursive: true, force: true });
});

describe('starter: the Approvals link', () => {
  it('both the setup and the write print the Approvals URL of the deployment', async () => {
    const result = await run(stub, [
      'starter',
      '--credentials',
      credential,
      '--auth-url',
      stub.url,
      '--govern-url',
      stub.url,
      '--mcp-url',
      stub.url,
      '--gateway-audience',
      GATEWAY_AUDIENCE,
    ]);
    expect(result.code, result.stderr).toBe(0);
    const lines = result.stderr.split('\n');
    expect(lines).toContain(
      `Setup proposed (approval ap_setup_1). Approve it in Approvals: ${APP}/approvals`
    );
    expect(lines).toContain(
      `Write requested (approval ap_write_1). Approve or deny it in Approvals: ${APP}/approvals`
    );
  });
});
