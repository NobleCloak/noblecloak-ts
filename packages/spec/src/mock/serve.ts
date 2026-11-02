/** Serving the mock over HTTP. Works under Bun and Node. */
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';

import { createMock } from './app.js';
import type { Mock, MockOptions } from './app.js';

export interface RunningMock extends Mock {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/** Starts a mock on `port` (0 picks a free one). The audience defaults to the served origin. */
export async function startMock(
  options: MockOptions & { port?: number } = {}
): Promise<RunningMock> {
  const port = options.port ?? 0;
  const origin = (p: number): string => `http://127.0.0.1:${String(p)}`;
  // The audience must be known before tokens are minted, and the port before the server starts.
  const mock = await createMock({
    ...options,
    audience: options.audience ?? origin(port === 0 ? await freePort() : port),
  });
  const wanted = options.audience === undefined ? Number(new URL(mock.config.audience).port) : port;
  const server = serve({ fetch: mock.app.fetch, port: wanted, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    ...mock,
    baseUrl: origin(actual),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}
