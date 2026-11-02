import {
  argDigest,
  InMemoryReplayGuard,
  ResumptionError,
  verifyResumption,
} from '@noblecloak/client';
import type { Jwks } from '@noblecloak/client';

import { baseUrl, creator } from './connect.js';
import { unwrap } from './problem.js';
// Importing approve.js runs the approval first.
import './approve.js';
import { args, approvalId, digest, toolRef } from './step-up.js';

// Only the principal that created the approval can read its Resumption.
const { data: resumption } = unwrap(
  await creator.GET('/v1/approvals/{id}/resumption', { params: { path: { id: approvalId } } })
);

// The key set is public.
const jwks = (await (await fetch(`${baseUrl}/.well-known/jwks.json`)).json()) as Jwks;
const replayGuard = new InMemoryReplayGuard();

// Arguments that differ from the ones that were approved are refused.
export let refusal = '';
try {
  const changed = await argDigest({ ...args, to: 'mallory@example.com' });
  await verifyResumption(
    resumption.signature,
    jwks,
    { tool_ref: toolRef, arg_digest: changed },
    { replayGuard }
  );
} catch (error) {
  if (!(error instanceof ResumptionError)) throw error;
  refusal = error.code;
}
console.log(refusal); // digest_mismatch

// The arguments the runtime is about to send are the ones that were approved.
const verified = await verifyResumption(
  resumption.signature,
  jwks,
  { tool_ref: toolRef, arg_digest: digest },
  { replayGuard }
);
export const approvedBy = verified.approver.id;
console.log(verified.resolution, approvedBy); // approved user_approver

export const resumeToken = resumption.resume_token;
