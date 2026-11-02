import { describe, expect, it } from 'vitest';
import { unlessInterrupted } from './abortable.js';
import type { Io } from './io.js';

const ioWith = (signal: AbortSignal): Io => ({ signal }) as unknown as Io;

describe('unlessInterrupted', () => {
  it('settles with the work when no interrupt comes', async () => {
    await expect(
      unlessInterrupted(ioWith(new AbortController().signal), Promise.resolve('y'), 'd')
    ).resolves.toBe('y');
  });

  it('passes the work’s own failure through', async () => {
    const failure = new Error('stdin closed');
    await expect(
      unlessInterrupted(ioWith(new AbortController().signal), Promise.reject(failure), 'd')
    ).rejects.toBe(failure);
  });

  it('rejects at once, exit 3, when the command was already interrupted', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      unlessInterrupted(ioWith(abort.signal), new Promise<string>(() => undefined), 'Not revoked.')
    ).rejects.toMatchObject({ exitCode: 3, message: 'Interrupted. Not revoked.' });
  });
});
