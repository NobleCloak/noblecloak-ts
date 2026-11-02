/** Loading the document: parse the YAML and inline the `$ref`s that point at sibling files. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parse } from 'yaml';

/** A parsed OpenAPI document. Plain JSON-compatible data. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = Record<string, Json>;

export const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses a YAML document and replaces every `{ $ref: ./file.yaml#/Pointer }` that names another file
 * with the value it points to. Internal `#/...` references are left alone. Used for the edge
 * placeholder, which is the only external reference the document makes.
 */
export function loadSpec(path: string): JsonObject {
  const doc = parse(readFileSync(path, 'utf8')) as Json;
  if (!isObject(doc)) throw new Error(`${path} is not a mapping`);
  return inlineExternalRefs(doc, dirname(path)) as JsonObject;
}

function inlineExternalRefs(node: Json, baseDir: string): Json {
  if (Array.isArray(node)) return node.map((item) => inlineExternalRefs(item, baseDir));
  if (!isObject(node)) return node;
  const ref = node.$ref;
  if (typeof ref === 'string' && !ref.startsWith('#')) {
    const [file = '', pointer = ''] = ref.split('#');
    const target = loadExternal(resolve(baseDir, file), pointer);
    const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref'));
    return inlineExternalRefs(
      { ...(target as JsonObject), ...siblings },
      dirname(resolve(baseDir, file))
    );
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, inlineExternalRefs(value, baseDir)])
  );
}

function loadExternal(file: string, pointer: string): Json {
  let node = parse(readFileSync(file, 'utf8')) as Json;
  for (const segment of pointer.split('/').filter((s) => s !== '')) {
    if (!isObject(node) || !(segment in node)) throw new Error(`${file}#${pointer}: no ${segment}`);
    node = node[segment] as Json;
  }
  return node;
}

/** The operations of a document: `[path, method, operation]`. */
export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

export function operationsOf(doc: JsonObject): [string, string, JsonObject][] {
  const out: [string, string, JsonObject][] = [];
  const paths = doc.paths;
  if (!isObject(paths)) return out;
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (isObject(op)) out.push([path, method, op]);
    }
  }
  return out;
}
