/** `$ref` integrity: every reference inside the document points at something. */
import { isObject } from './load.js';
import type { Json, JsonObject } from './load.js';

/** A `$ref` that points at nothing. */
export interface DanglingRef {
  readonly ref: string;
  readonly at: string;
}

function resolvePointer(doc: JsonObject, ref: string): boolean {
  let node: Json = doc;
  for (const raw of ref.slice(2).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(node) || !(segment in node)) return false;
    node = node[segment] as Json;
  }
  return true;
}

/** Every internal (`#/...`) `$ref` of `doc` that does not resolve, with the JSON pointer of the object holding it. */
export function findDanglingRefs(doc: JsonObject): DanglingRef[] {
  const found: DanglingRef[] = [];
  const walk = (node: Json, at: string): void => {
    if (Array.isArray(node))
      node.forEach((item, i) => {
        walk(item, `${at}/${String(i)}`);
      });
    else if (isObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (
          key === '$ref' &&
          typeof value === 'string' &&
          value.startsWith('#/') &&
          !resolvePointer(doc, value)
        ) {
          found.push({ ref: value, at });
        } else walk(value, `${at}/${key}`);
      }
    }
  };
  walk(doc, '');
  return found;
}
