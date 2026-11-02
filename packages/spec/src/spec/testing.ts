/** Helpers for tests: the package's document, and narrowing for tests that read it as untyped data. */
import { isObject, loadSpec } from './load.js';
import type { Json, JsonObject } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';

/** The package's document, read from the committed `openapi.public.yaml` (no build needed). */
export const loadCommittedDocument = (): JsonObject => loadSpec(PUBLIC_SOURCE());

/** `value` as an object, or a thrown error naming what was expected. */
export function obj(value: Json | undefined, what = 'value'): JsonObject {
  if (!isObject(value)) throw new Error(`${what} is not an object`);
  return value;
}

/** `value` as a string, or a thrown error naming what was expected. */
export function str(value: Json | undefined, what = 'value'): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string`);
  return value;
}
