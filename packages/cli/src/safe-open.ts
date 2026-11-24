import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

/**
 * Opens a file for reading without waiting on it. A plain open of a FIFO blocks until something writes to it,
 * so a path that is a FIFO would hang the command forever; O_NONBLOCK returns at once and the caller then
 * refuses anything that is not a regular file (`handle.stat().isFile()`). Windows has no O_NONBLOCK.
 */
export function openForRead(path: string): Promise<FileHandle> {
  const nonBlocking = process.platform === 'win32' ? 0 : constants.O_NONBLOCK;
  return open(path, constants.O_RDONLY | nonBlocking);
}
