/** The one failure `GovernanceApi` throws: the module API could not be read as an answer. */
export type ModuleApiErrorCode = 'unreachable';

/**
 * Thrown for a network failure, a 5xx, or a body that cannot be read. A 4xx is never thrown: it comes back as
 * a `Problem`. `code` is the stable part; the message is for people.
 */
export class ModuleApiError extends Error {
  readonly code: ModuleApiErrorCode;

  constructor(code: ModuleApiErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'ModuleApiError';
    this.code = code;
  }
}

/** The message of any thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
