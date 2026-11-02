/** Everything the command line touches outside its own process, so tests can replace each piece. */
export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Human and `--json` output. */
  readonly stdout: (text: string) => void;
  /** Diagnostics, prompts and the sign-in URL. */
  readonly stderr: (text: string) => void;
  readonly fetch: typeof fetch;
  /** Opens a URL in the user's browser. May throw; the URL is always printed as well. */
  readonly openUrl: (url: string) => void;
  readonly stdinIsTTY: boolean;
  /** Reads one line from stdin after writing `prompt` to stderr. */
  readonly readLine: (prompt: string) => Promise<string>;
  readonly platform: NodeJS.Platform;
  /** How long to wait for the browser callback. */
  readonly signInTimeoutMs: number;
  /** How long one request may take before it is abandoned. Default 30 seconds. */
  readonly requestTimeoutMs?: number;
  /**
   * Aborted when the user interrupts the command (Ctrl-C). Every request and the revoke prompt observe it;
   * the command then exits 3 after ending the session. */
  readonly signal: AbortSignal;
}
