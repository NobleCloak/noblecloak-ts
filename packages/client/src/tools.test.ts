import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { components } from './schema.js';
import { SCHEMA_PATH, generateSchemaText } from '../tools/generate-schema.js';
import { schemaDistProblems } from '../tools/assert-schema-dist.js';

import { readFileSync } from 'node:fs';

describe('src/schema.ts', () => {
  it('is the current output of the generator, from the published document', async () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(await generateSchemaText());
  }, 60_000);

  it('types the absent-means members as optional (the document gives them no default)', () => {
    // Type level: these literals omit the members, so tsc fails if the generator marks them required.
    const create: components['schemas']['RecordCreate'] = { tool_ref: 't', decision: 'allow' };
    const capabilities: Omit<components['schemas']['Capabilities'], 'dpop'> &
      Pick<Partial<components['schemas']['Capabilities']>, 'dpop'> = {
      deployment: 'edge',
      entitlements: [],
      jwks_uri: 'https://x.example/jwks',
      kids: [],
      resolutions: [],
      features: [],
      authzen_configuration: 'https://x.example/a',
    };
    expect(create.enforced).toBeUndefined();
    expect(capabilities.dpop).toBeUndefined();
    const text = readFileSync(SCHEMA_PATH, 'utf8');
    expect(text).toMatch(/\benforced\?: boolean;/);
    expect(text).toMatch(/\bdpop\?: /);
    expect(text).not.toMatch(/\bdpop: /);
  });

  it('exports paths', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8')).toMatch(/export interface paths\b/);
  });
});

describe('the dist schema assertion', () => {
  const root = mkdtempSync(join(tmpdir(), 'client-dist-'));
  const write = (text: string): void => {
    mkdirSync(resolve(root, 'dist'), { recursive: true });
    writeFileSync(resolve(root, 'dist/schema.d.ts'), text);
  };

  it('fails when dist/schema.d.ts is missing', () => {
    expect(schemaDistProblems(root)).toEqual(['dist/schema.d.ts is missing']);
  });

  it('fails when the file does not export paths', () => {
    write('export interface components {}\n');
    expect(schemaDistProblems(root)).toEqual(['dist/schema.d.ts does not export `paths`']);
  });

  it('passes when the file exists and exports paths', () => {
    write('export interface paths {}\n');
    expect(schemaDistProblems(root)).toEqual([]);
  });

  it('passes on the real build output when one exists', () => {
    const real = resolve(import.meta.dirname, '..');
    const problems = schemaDistProblems(real);
    expect(problems.length === 0 || problems[0] === 'dist/schema.d.ts is missing').toBe(true);
  });
});

describe('the decision policy type', () => {
  type Decision = components['schemas']['Decision'];
  it('is optional on the generated decision type, and never null', () => {
    const withoutPolicy: Decision = {
      decision: 'allow',
      action_digest: 'sha256:x',
      enforced: true,
    };
    const withPolicy: Decision = {
      ...withoutPolicy,
      policy: { id: 'pol_a', version: 1, side_effect_level: 'read' },
    };
    // @ts-expect-error policy is absent or an object; it is never null
    const withNull: Decision = { ...withoutPolicy, policy: null };
    // @ts-expect-error when present, id and version are required
    const partial: Decision = { ...withoutPolicy, policy: { side_effect_level: 'read' } };
    expect(withoutPolicy).not.toHaveProperty('policy');
    expect([withPolicy, withNull, partial]).toHaveLength(3);
  });
  it('is optional and never null on the generated record type', () => {
    type Rec = components['schemas']['Record'];
    const base: Rec = {
      id: 'r',
      ts: '2026-01-01T00:00:00Z',
      actor: { id: 'a', kind: 'user' },
      tool_ref: 't',
      decision: 'allow',
      attestation: 'asserted',
    };
    // @ts-expect-error policy is absent or a reference; it is never null
    const withNull: Rec = { ...base, policy: null };
    expect(base).not.toHaveProperty('policy');
    expect(withNull).toBeDefined();
  });
});

describe('the approval and Resumption policy types', () => {
  type Approval = components['schemas']['Approval'];
  type Resumption = components['schemas']['Resumption'];
  const digest = 'a'.repeat(64);
  // Type level: these literals omit `policy`, so tsc fails if the generator marks it required.
  const approval: Approval = {
    id: 'a',
    state: 'pending',
    tool_ref: 't',
    obligation_kind: 'tool_invocation',
    action_digest: digest,
    scope_id: 's',
    side_effect_level: 'write',
    created_at: '2026-01-01T00:00:00Z',
  };
  const resumption: Resumption = {
    approval_id: 'a',
    action_id: 'x',
    tool_ref: 't',
    obligation_kind: 'tool_invocation',
    resolution: 'approved',
    action_digest: digest,
    approver: { id: 'u', kind: 'user' },
    resolved_at: '2026-01-01T00:00:00Z',
    expires_at: '2026-01-01T01:00:00Z',
    continuation: { kind: 'adk', delivery: 'pull' },
    signature: 'h.p.s',
  };

  it('an Approval and a Resumption without a policy type-check, and policy is never null', () => {
    // @ts-expect-error policy is absent or a reference; it is never null
    const approvalNull: Approval = { ...approval, policy: null };
    // @ts-expect-error policy is absent or a reference; it is never null
    const resumptionNull: Resumption = { ...resumption, policy: null };
    expect(approval).not.toHaveProperty('policy');
    expect(resumption).not.toHaveProperty('policy');
    expect([approvalNull, resumptionNull]).toHaveLength(2);
  });

  it('reading policy without a check is a compile error, and a check makes it a PolicyRef', () => {
    // The reads are in functions that are never called: they would throw, and the point is the compiler.
    // @ts-expect-error policy may be absent: reading a member of it needs a check first
    const unchecked = (): string => approval.policy.id;
    // @ts-expect-error policy may be absent: reading a member of it needs a check first
    const uncheckedResumption = (): string => resumption.policy.id;
    const checked = approval.policy === undefined ? 'default' : approval.policy.id;
    expect(checked).toBe('default');
    expect([unchecked, uncheckedResumption]).toHaveLength(2);
  });
});
