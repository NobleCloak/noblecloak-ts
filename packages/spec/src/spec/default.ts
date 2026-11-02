/** Which document the mock and the conformance runner use when none is named. */
import { loadSpec } from './load.js';
import type { JsonObject } from './load.js';
import { PUBLIC_SPEC } from './paths.js';

/**
 * The published document: `dist/openapi.public.yaml`, written by `bun run build:public`. A repository
 * checkout that has not built it yet fails with that instruction.
 */
export function loadDocument(): JsonObject {
  try {
    return loadSpec(PUBLIC_SPEC());
  } catch (error) {
    throw new Error('dist/openapi.public.yaml is missing: run `bun run build:public` first', {
      cause: error,
    });
  }
}
