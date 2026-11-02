import { describe, expect, it } from 'vitest';

import { AuthError } from './auth.js';

describe('AuthError', () => {
  it('carries its code, and the code is the message unless one is given', () => {
    const error = new AuthError('signed_out');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuthError');
    expect(error.code).toBe('signed_out');
    expect(error.message).toBe('signed_out');
    expect(new AuthError('invalid_grant', 'The session ended.').message).toBe('The session ended.');
  });
});
