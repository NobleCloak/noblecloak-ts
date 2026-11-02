import { escapeInvisible } from './format-json.js';

/**
 * A value the server controls (a string by contract, anything if a reply was malformed), as inert text: invisible and bidirectional-control characters are shown as
 * escapes, and the text is isolated (`<bdi>`) so what it contains cannot reorder its surroundings.
 */
export function Safe({ children }: { readonly children: unknown }) {
  return <bdi>{escapeInvisible(children)}</bdi>;
}
