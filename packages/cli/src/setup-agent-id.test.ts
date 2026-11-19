import { describe, expect, it } from 'vitest';
import { SETUP_AGENT_NAMESPACE, setupAgentId } from './setup-agent-id.js';

const ORG = '1111aaaa-2222-4333-8444-5555bbbb5555';
const SP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('setupAgentId', () => {
  it('is the RFC 9562 UUIDv5 of org:principal in coo namespace (value from python uuid.uuid5)', () => {
    expect(SETUP_AGENT_NAMESPACE).toBe('6f0c9a52-3b1e-4d7a-9c58-2e41b7a0d3f6');
    expect(setupAgentId(ORG, SP)).toBe('b3d74a9e-5a16-5a9b-b668-82c9486b7b1a');
  });

  it('lower-cases both inputs, as coo does', () => {
    expect(setupAgentId(ORG.toUpperCase(), SP.toUpperCase())).toBe(setupAgentId(ORG, SP));
  });
});
