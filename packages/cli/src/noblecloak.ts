#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { runCli } from './cli.js';
import type { Io } from './io.js';

/** Opens a URL with the platform opener. No shell: the URL is one element of an argument array. */
function openUrl(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // The URL is printed as well, so a missing opener costs nothing.
  });
  child.unref();
}

const interrupt = new AbortController();

function readLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const reader = createInterface({ input: process.stdin });
  // On Ctrl-C the prompt closes, so a waiting stdin does not keep the process alive after the cleanup.
  interrupt.signal.addEventListener('abort', () => {
    reader.close();
  });
  return new Promise((resolve) => {
    reader.once('line', (line) => {
      reader.close();
      resolve(line);
    });
    reader.once('close', () => {
      resolve('');
    });
  });
}

// Kept for the whole run (on, not once): Ctrl-C aborts the in-flight request or prompt, the command ends its
// session (revokes the refresh token, bounded by the request timeout) and exits 3. Pressing Ctrl-C again
// during that cleanup does nothing more.
process.on('SIGINT', () => {
  interrupt.abort();
});

const io: Io = {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  fetch,
  openUrl,
  stdinIsTTY: process.stdin.isTTY,
  readLine,
  platform: process.platform,
  signInTimeoutMs: 5 * 60_000,
  signal: interrupt.signal,
};

process.exitCode = await runCli(process.argv.slice(2), io);
