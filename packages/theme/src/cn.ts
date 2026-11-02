/** A class name part: a string, or a falsy value that is left out. */
export type ClassPart = string | false | null | undefined;

/**
 * Joins class names, dropping falsy parts. The theme's classes are plain `nc-*` names with no utility classes,
 * so nothing needs merging or deduplicating.
 */
export function cn(...parts: readonly ClassPart[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}
