/** The claims of a token, decoded in the page and sent nowhere. */
/** The payload of a JWT, decoded locally; null when the token is not one. */
export function decodeClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (part === undefined) return null;
  try {
    const binary = atob(part.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
