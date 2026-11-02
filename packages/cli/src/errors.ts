/** The exit codes of the command line. */
export const EXIT = {
  ok: 0,
  /** A server or unexpected error. */
  failed: 1,
  /** Input refused: a bad flag, missing configuration, an existing `--out`. */
  usage: 2,
  /** Not signed in: sign-in failed, timed out or was cancelled, the server answered 401, or the user interrupted (Ctrl-C). */
  unauthenticated: 3,
  /** The server answered 403: not an administrator of that organisation. */
  forbidden: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * An error the command line reports and turns into an exit code. Its message is written to stderr, so it
 * never holds key material, a code, a verifier or a token.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, message: string) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
