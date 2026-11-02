/**
 * Generates `src/schema.ts` from the module API document the spec package
 * publishes, `openapi.public.yaml`: `bun tools/generate-schema.ts` writes it, `--check` fails when the committed
 * file is stale.
 *
 * The file is `.ts`, not `.d.ts`: a declaration file under `include` is treated as input and never
 * emitted, so a `.ts` file is what lets the build emit `dist/schema.d.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import openapiTS, { astToString } from 'openapi-typescript';
import type { OpenAPI3 } from 'openapi-typescript';
import { parse } from 'yaml';

const CLIENT_ROOT = resolve(import.meta.dirname, '..');
const SPEC_ROOT = resolve(CLIENT_ROOT, '../spec');
export const SCHEMA_PATH = resolve(CLIENT_ROOT, 'src/schema.ts');

const HEADER = `/**
 * Generated from the NobleCloak module API document (\`@noblecloak/spec\`'s \`openapi.public.yaml\`) by
 * \`bun tools/generate-schema.ts\`. Do not edit.
 */
`;

/** The text `src/schema.ts` must have. */
export async function generateSchemaText(): Promise<string> {
  const document = parse(
    readFileSync(resolve(SPEC_ROOT, 'openapi.public.yaml'), 'utf8')
  ) as OpenAPI3;
  const ast = await openapiTS(document, { alphabetize: false, exportType: false });
  return `${HEADER}${astToString(ast)}`;
}

if (import.meta.main) {
  const text = await generateSchemaText();
  if (process.argv.includes('--check')) {
    if (readFileSync(SCHEMA_PATH, 'utf8') !== text) {
      console.error('src/schema.ts is stale: run `bun tools/generate-schema.ts`');
      process.exit(1);
    }
  } else {
    writeFileSync(SCHEMA_PATH, text);
    console.log(`wrote ${SCHEMA_PATH}`);
  }
}
