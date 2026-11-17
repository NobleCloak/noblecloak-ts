/** The exit codes of the command line. */
export const EXIT = {
  ok: 0,
  /** A server or unexpected error. */
  failed: 1,
  /** Input refused: a bad flag, missing configuration, an existing `--out`. */
  usage: 2,
  /** Not signed in: sign-in failed, timed out or was cancelled, the server answered 401, or the user interrupted (Ctrl-C). */
  unauthenticated: 3,
  /** The server answered 403: for `sp`, not an administrator of that organisation; for `starter`, the person or principal may not do that (not an administrator, not an eligible approver, or not granted the tool). */
  forbidden: 4,
  /** `starter`: no service-principal credential was given. (An unreadable or invalid one is exit 2.) */
  noCredentials: 10,
  /** `starter`: the service principal may not ask for a token for the govern origin or the gateway audience. */
  audienceMissing: 11,
  /** `starter`: the deployment has no sandbox tool to ask an approval for. */
  sandboxUnavailable: 12,
  /** `starter`: the setup proposal was denied, or the deployment refused to apply it. */
  proposalRejected: 13,
  /** `starter`: the sandbox write was denied, withdrawn or refused by the gateway. */
  writeDenied: 14,
  /** `starter`: nobody decided an approval before `--wait` seconds passed (or it expired). */
  timeout: 15,
  /** `starter`: the approval for the write was already used by an earlier call. */
  replay: 16,
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
