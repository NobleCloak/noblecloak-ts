import { originOf, readInput } from '../digest.js';
import type { CedarImportResult, ImportOptions } from '../types.js';
import { NOBLECLOAK } from './ast.js';
import { assemble, IDENTITY_TOOLS } from './decode.js';
import {
  COMMENTS_NOTE,
  EMPTY_NOTE,
  hasForeignCedarComments,
  loadCedar,
  parsePolicySet,
} from './parse.js';

/**
 * Cedar text in the NobleCloak dialect → policies. A statement this package wrote imports exactly (its
 * annotations carry what Cedar cannot); a statement written elsewhere imports by its body (permit →
 * `always_allow`, forbid → `deny`, a permit with `@advice` escalate → `ask`), each as a policy of its own.
 * Everything not imported, or imported in part, is listed in the result. Throws `parse_error` when the text
 * is not Cedar, and `cedar_unavailable` when the parser cannot be loaded.
 */
export async function importCedar(
  input: string | Uint8Array,
  opts: ImportOptions = {}
): Promise<CedarImportResult> {
  const { text, bytes } = readInput(input);
  const cedar = await loadCedar(opts.cedar);
  const { statements, templates } = parsePolicySet(cedar, text, '', NOBLECLOAK, IDENTITY_TOOLS);
  const assembled = assemble(statements);
  return {
    policies: assembled.policies,
    unsupported: [...assembled.unsupported, ...templates],
    lossy: assembled.lossy,
    conflicts: assembled.conflicts,
    notes: [
      ...(statements.length === 0 && templates.length === 0 ? [EMPTY_NOTE] : []),
      ...(assembled.encoding === 'advice' || assembled.encoding === 'mixed'
        ? [
            'Some ask or escalate statements are a permit with @advice: a Cedar engine that reads no @advice allows those calls. They import as ask or escalate; an export writes them as a fail-closed forbid.',
          ]
        : []),
      ...(hasForeignCedarComments(text) ? [COMMENTS_NOTE] : []),
    ],
    origin: await originOf('cedar', bytes),
    options: assembled.baseline ? { baseline: 'allow' } : {},
  };
}
