/** `returnTo` is where the host sends the person after sign-in; only a same-origin path is accepted. */

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

/**
 * `value` when it is a path on `appOrigin`: it starts with `/`, not `//` or `/\`, has no control
 * character and parses against the app origin to that same origin. Anything else (and `undefined`) is `/`.
 */
export function sanitizeReturnTo(value: string | undefined, appOrigin: string): string {
  if (value === undefined) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (hasControlCharacter(value)) return '/';
  try {
    return new URL(value, appOrigin).origin === appOrigin ? value : '/';
  } catch {
    return '/';
  }
}
