/**
 * A small JSON scanner over the text of a response, for the two questions `JSON.parse` cannot answer: which
 * characters of the text one member took (so a number can be shown as it was sent), and whether an object
 * names a key twice (`JSON.parse` keeps the last, and a server may have read the first). It never throws:
 * text that is not JSON gives `undefined`. It is iterative, so deep nesting cannot overflow the stack.
 */

const isSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r';

function skipSpace(text: string, from: number): number {
  let i = from;
  while (isSpace(text[i])) i += 1;
  return i;
}

/** The index after the string literal that starts at `start` (a quote); -1 when it is not closed. */
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0x22) return i + 1;
    // An escape takes the next character with it; the hex digits of \u escapes are never quotes.
    if (c === 0x5c) i += 1;
  }
  return -1;
}

/** The index after the value that starts at `start`; `start` itself (an empty span) when there is none. */
function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    const end = stringEnd(text, start);
    return end < 0 ? start : end;
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (c === '"') {
        const end = stringEnd(text, i);
        if (end < 0) return start;
        i = end - 1;
      } else if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return start;
  }
  let i = start;
  while (
    i < text.length &&
    !isSpace(text[i]) &&
    text[i] !== ',' &&
    text[i] !== '}' &&
    text[i] !== ']'
  ) {
    i += 1;
  }
  return i;
}

function decodeKey(literal: string): string | undefined {
  try {
    const key: unknown = JSON.parse(literal);
    return typeof key === 'string' ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The source text of every top-level member of the object `text` that is named `key`, in order (a key may
 * be repeated). `undefined` when `text` is not a JSON object.
 */
export function sliceJsonMembers(text: string, key: string): string[] | undefined {
  let i = skipSpace(text, 0);
  if (text[i] !== '{') return undefined;
  i = skipSpace(text, i + 1);
  const spans: string[] = [];
  if (text[i] === '}') return spans;
  for (;;) {
    if (text[i] !== '"') return undefined;
    const keyEnd = stringEnd(text, i);
    if (keyEnd < 0) return undefined;
    const name = decodeKey(text.slice(i, keyEnd));
    if (name === undefined) return undefined;
    i = skipSpace(text, keyEnd);
    if (text[i] !== ':') return undefined;
    i = skipSpace(text, i + 1);
    const end = valueEnd(text, i);
    if (end === i) return undefined;
    if (name === key) spans.push(text.slice(i, end));
    i = skipSpace(text, end);
    if (text[i] === '}') return spans;
    if (text[i] !== ',') return undefined;
    i = skipSpace(text, i + 1);
  }
}

/** The source text of the last top-level member named `key` (the one `JSON.parse` keeps); `undefined` when there is none. */
export function sliceJsonMember(text: string, key: string): string | undefined {
  return sliceJsonMembers(text, key)?.at(-1);
}

/**
 * The first key that some object in `text` names twice, at any depth, compared after unescaping;
 * `undefined` when there is none (or `text` is not JSON).
 */
export function findDuplicateKey(text: string): string | undefined {
  // One entry per open container: the keys of an object, or null for an array.
  const open: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      if (end < 0) return undefined;
      const keys = open.at(-1);
      if (expectKey && keys !== undefined && keys !== null) {
        const name = decodeKey(text.slice(i, end));
        if (name === undefined) return undefined;
        if (keys.has(name)) return name;
        keys.add(name);
        expectKey = false;
      }
      i = end - 1;
    } else if (c === '{') {
      open.push(new Set());
      expectKey = true;
    } else if (c === '[') {
      open.push(null);
      expectKey = false;
    } else if (c === '}' || c === ']') {
      open.pop();
      expectKey = false;
    } else if (c === ',') {
      expectKey = open.at(-1) instanceof Set;
    } else if (c === ':') {
      expectKey = false;
    }
  }
  return undefined;
}
