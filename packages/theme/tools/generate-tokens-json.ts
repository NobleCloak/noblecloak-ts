/** Writes `src/tokens.json` from `src/styles/tokens.css` (`bun run tokens:generate`). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildTokensJson, serializeTokensJson } from './tokens.js';

const root = join(import.meta.dirname, '..');
const css = readFileSync(join(root, 'src/styles/tokens.css'), 'utf8');
writeFileSync(join(root, 'src/tokens.json'), serializeTokensJson(buildTokensJson(css)));
process.stdout.write('wrote src/tokens.json\n');
