/** Why a conversion could not run at all (as opposed to a construct it reports and skips). */
export type PolicyFormatErrorCode =
  /** The input is not a policy set or manifest the format's grammar accepts. */
  | 'parse_error'
  /** The arguments break a rule of the API, such as two policies with the same id. */
  | 'invalid_input'
  /** `@cedar-policy/cedar-wasm` could not be loaded for an import. */
  | 'cedar_unavailable';

export class PolicyFormatError extends Error {
  override readonly name = 'PolicyFormatError';
  readonly code: PolicyFormatErrorCode;
  /** The parser's messages, for `parse_error`. */
  readonly issues: readonly string[];

  constructor(
    code: PolicyFormatErrorCode,
    message: string,
    issues: readonly string[] = [],
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.code = code;
    this.issues = issues;
  }
}
