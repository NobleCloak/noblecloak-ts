import { argDigest } from '@noblecloak/client';

import { creator } from './connect.js';
import { unwrap } from './problem.js';

// The tool call, as the model made it.
const args = { query: 'damaged' };
export const digest = await argDigest(args);

const { data: decision } = unwrap(
  await creator.POST('/v1/decisions', {
    body: { action: { tool_ref: 'mcp:tracker:search', arg_digest: digest } },
  })
);

export const verdict = decision.decision;
console.log(verdict); // allow
