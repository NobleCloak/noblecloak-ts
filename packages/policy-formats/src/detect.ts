import { parse } from 'yaml';

import { HEADER_MARK } from './report.js';

/**
 * The format of a file: `agt` for a YAML mapping with `agent_control_specification_version`, `cedar` for
 * text whose first content (after `//` comments) is an annotation or a `permit`/`forbid`, else undefined.
 * It looks at the shape only; an import still reports or refuses what it cannot read.
 */
export function detectFormat(text: string): 'agt' | 'cedar' | undefined {
  const body = text.replace(/^\ufeff/, '');
  let value: unknown;
  try {
    value = parse(body, { version: '1.2' });
  } catch {
    value = undefined;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'agent_control_specification_version' in value
  )
    return 'agt';
  // A manifest the YAML parser rejects is still AGT: its import then says why it does not parse.
  if (value === undefined && /^agent_control_specification_version\s*:/m.test(body)) return 'agt';
  // An export of no policy is its comment block alone.
  if (body.startsWith(`// ${HEADER_MARK}`)) return 'cedar';
  const content = body.replace(/^(?:\s*\/\/[^\n]*\n?)*\s*/, '');
  return /^(?:@|permit\b|forbid\b)/.test(content) ? 'cedar' : undefined;
}
