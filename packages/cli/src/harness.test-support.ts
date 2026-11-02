import { createServer } from 'node:http';
import { runCli } from './cli.js';
import type { Io } from './io.js';
import { ADMIN_AUDIENCE, CODE, type Stub } from './stub.test-support.js';

export interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HarnessOptions {
  /** What the stand-in browser does with the authorize URL. Default: complete the sign-in. */
  browser?: (authorize: URL, stub: Stub) => Promise<void>;
  env?: Record<string, string | undefined>;
  stdinIsTTY?: boolean;
  answers?: string[];
  signInTimeoutMs?: number;
  /** The interrupt signal. Default: one that is never aborted, as the bin always passes a signal. */
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  /** Called when the revoke prompt is shown; the prompt then never answers (the user is thinking). */
  onPrompt?: () => void;
  platform?: NodeJS.Platform;
  /** Skip openUrl and drive the browser from the URL printed on stderr (the `--no-open` path). */
  printedUrlOnly?: boolean;
  openUrlThrows?: boolean;
  /**
   * Make every service-principal route unreachable (the sign-in still works): the request goes to a closed
   * loopback port, so fetch fails the way it does in production when the connection is refused.
   */
  apiUnreachable?: boolean;
}

/** Visits the redirect URI of an authorize URL with a code and the state. */
export async function completeSignIn(authorize: URL, stub: Stub): Promise<void> {
  stub.challenge = authorize.searchParams.get('code_challenge') ?? undefined;
  const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
  redirect.searchParams.set('code', CODE);
  redirect.searchParams.set('state', authorize.searchParams.get('state') ?? '');
  await fetch(redirect);
}

/** An http origin on 127.0.0.1 whose port was just released, so a connection to it is refused. */
async function closedLoopbackOrigin(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://127.0.0.1:${String(port)}`;
}

/** Runs the command line against the stub with captured output. */
export async function run(
  stub: Stub,
  argv: string[],
  options: HarnessOptions = {}
): Promise<Run & { opened: URL[]; prompts: string[] }> {
  let stdout = '';
  let stderr = '';
  const opened: URL[] = [];
  const prompts: string[] = [];
  const browser = options.browser ?? completeSignIn;
  const answers = [...(options.answers ?? [])];
  const pending: Promise<void>[] = [];
  const printedOnly = options.printedUrlOnly === true || options.openUrlThrows === true;
  const closedOrigin = options.apiUnreachable === true ? await closedLoopbackOrigin() : undefined;

  const drive = (href: string): void => {
    const url = new URL(href);
    opened.push(url);
    pending.push(browser(url, stub));
  };
  const io: Io = {
    env: options.env ?? {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
      if (printedOnly) {
        const line = text.split('\n').find((l) => l.startsWith('http'));
        if (line !== undefined) drive(line);
      }
    },
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (closedOrigin !== undefined && url.includes('/organizations/')) {
        return fetch(url.replace(stub.url, closedOrigin), init);
      }
      return fetch(input, init);
    },
    openUrl: (href) => {
      if (options.openUrlThrows === true) throw new Error('no opener');
      if (!printedOnly) drive(href);
    },
    stdinIsTTY: options.stdinIsTTY ?? false,
    readLine: (prompt) => {
      prompts.push(prompt);
      if (options.onPrompt !== undefined) {
        options.onPrompt();
        return new Promise<string>(() => undefined);
      }
      return Promise.resolve(answers.shift() ?? '');
    },
    platform: options.platform ?? 'linux',
    signInTimeoutMs: options.signInTimeoutMs ?? 5_000,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    signal: options.signal ?? new AbortController().signal,
  };
  const code = await runCli(argv, io);
  await Promise.allSettled(pending);
  return { code, stdout, stderr, opened, prompts };
}

/** The flags every signed-in command needs. */
export function config(stub: Stub): string[] {
  return ['--auth-url', stub.url, '--admin-audience', ADMIN_AUDIENCE];
}
