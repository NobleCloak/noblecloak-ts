export { createClient } from './client.js';
export type { ClientOptions, DpopRequest, ModuleApiClient } from './client.js';
export { DigestError, MAX_NESTING_DEPTH, argDigest, jcs, sha256Hex } from './digest.js';
export type { DigestErrorCode, JsonValue } from './digest.js';
export { InMemoryReplayGuard, ResumptionError, verifyResumption } from './resumption.js';
export type {
  ExpectedAction,
  Jwks,
  ResumptionErrorCode,
  ResumptionPayload,
  ResumptionReplayGuard,
  VerifyOptions,
} from './resumption.js';
export type { components, operations, paths } from './schema.js';
