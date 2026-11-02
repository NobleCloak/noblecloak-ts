import { describe, expect, it } from 'vitest';

import { canonicalPolicy } from './canonical.js';
import { exportCedar } from './export.js';
import {
  asExportable,
  awkwardPolicies,
  cedar,
  slicesOf,
  supportedSubset,
} from './fixtures.test-support.js';
import { importCedar } from './import.js';
import { NOBLECLOAK_CEDAR_SCHEMA } from './schemas.js';
import type { ExportablePolicy } from './types.js';

/* eslint-disable no-control-regex -- the raw code points an export must never write */
const RAW = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/;
/* eslint-enable no-control-regex */

function validationErrors(text: string, schema: string): string[] {
  const answer = cedar.validate({ schema, policies: { staticPolicies: text } });
  if (answer.type === 'failure') return answer.errors.map((error) => error.message);
  return [
    ...answer.validationErrors.map((error) => `${error.policyId}: ${error.error.message}`),
    ...answer.validationWarnings.map((error) => `${error.policyId}: ${error.error.message}`),
  ];
}

/** (A) and (B) for one set of policies, with the reports of both directions empty. */
async function roundTrip(policies: readonly ExportablePolicy[], label: string): Promise<string> {
  const exported = exportCedar(policies);
  expect(exported.unsupported, label).toEqual([]);
  const imported = await importCedar(exported.text, { cedar });
  expect(imported.unsupported, label).toEqual([]);
  expect(imported.conflicts, label).toEqual([]);
  expect(imported.lossy, label).toEqual([]);
  expect(imported.notes, label).toEqual([]);
  // (A) the model round trip: the same policies, by key, in canonical form.
  const byKey = new Map(imported.policies.map((policy) => [policy.key, policy.write]));
  expect(byKey.size, label).toBe(policies.length);
  for (const policy of policies) {
    const back = byKey.get(policy.id);
    expect(back, `${label} ${policy.id}`).toBeDefined();
    if (back !== undefined)
      expect(canonicalPolicy(back), `${label} ${policy.id}`).toBe(canonicalPolicy(policy));
  }
  // (B) the file round trip: re-exporting what was imported writes the same bytes.
  const again = exportCedar(imported.policies.map(asExportable), imported.options);
  expect(again.text, label).toBe(exported.text);
  return exported.text;
}

describe('Cedar, NobleCloak dialect: round trip over the supported subset', () => {
  const subset = supportedSubset('noblecloak');

  it('covers every mode, subject type, target form and optional member', () => {
    const modes = new Set(subset.map((policy) => (policy.config as { mode: string }).mode));
    const types = new Set(
      subset.flatMap((policy) => policy.subjects.map((subject) => subject.type))
    );
    expect([...modes].sort()).toEqual(['always_allow', 'ask', 'deny', 'escalate', 'not_granted']);
    expect([...types].sort()).toEqual([
      'agent',
      'group',
      'organization',
      'role',
      'service',
      'user',
    ]);
    // 39 configs (3 plain modes, 2 approval modes × 3 on_deny × 2 expires_after × 3 approver_groups)
    // × 8 subject sets × 5 target forms × 2 names × 3 descriptions.
    expect(subset.length).toBe(39 * 8 * 5 * 2 * 3);
  });

  const slices = slicesOf(subset);

  it('the slices the per-policy cases run hold every policy of the subset exactly once', () => {
    expect(slices.length).toBe(5 * 5);
    expect(slices.flatMap((slice) => slice.policies.map((policy) => policy.id)).sort()).toEqual(
      subset.map((policy) => policy.id).sort()
    );
  });

  // One case per slice: the whole subset in one case risks the 60 s timeout on a CI runner.
  for (const slice of slices)
    it(`(A) and (B) hold for each policy exported on its own, ${slice.label}`, async () => {
      for (const policy of slice.policies) await roundTrip([policy], policy.id);
    });

  it('(A) and (B) hold for the whole subset in one file, given in reverse order', async () => {
    await roundTrip([...subset].reverse(), 'whole subset');
  });

  it('(A) and (B) hold for strings with quotes, line breaks, controls, separators and astral text', async () => {
    const text = await roundTrip(awkwardPolicies('noblecloak'), 'awkward');
    // Every control, separator and noncharacter is written as an escape, never raw.
    expect(text).not.toMatch(RAW);
  });

  it('(B) holds with the baseline statement', async () => {
    const policies = subset.slice(0, 50);
    const exported = exportCedar(policies, { baseline: 'allow' });
    const imported = await importCedar(exported.text, { cedar });
    expect(imported.options).toEqual({ baseline: 'allow' });
    expect(exportCedar(imported.policies.map(asExportable), imported.options).text).toBe(
      exported.text
    );
  });

  it('the export validates against schemas/noblecloak.cedarschema, with no warning', () => {
    const { text } = exportCedar(subset, { baseline: 'allow' });
    expect(validationErrors(text, NOBLECLOAK_CEDAR_SCHEMA)).toEqual([]);
  });

  it("an export of unusual ids validates; the only warnings are Cedar's about non-ASCII identifiers", () => {
    const { text } = exportCedar(awkwardPolicies('noblecloak'));
    const answer = cedar.validate({
      schema: NOBLECLOAK_CEDAR_SCHEMA,
      policies: { staticPolicies: text },
    });
    expect(answer.type).toBe('success');
    if (answer.type === 'success') {
      expect(answer.validationErrors).toEqual([]);
      for (const warning of answer.validationWarnings)
        expect(warning.error.message).toContain(
          'falls outside of the General Security Profile for Identifiers'
        );
    }
  });

  it('positive control: the validator reports a statement outside the dialect', () => {
    expect(
      validationErrors(
        'permit (principal == NobleCloak::Robot::"r", action, resource);',
        NOBLECLOAK_CEDAR_SCHEMA
      )
    ).not.toEqual([]);
  });

  it('never writes ask or escalate as a permit (a Cedar engine would allow the call)', () => {
    const approval = subset.filter((policy) =>
      ['ask', 'escalate'].includes((policy.config as { mode: string }).mode)
    );
    for (const policy of approval) {
      const { text } = exportCedar([policy]);
      expect(text, policy.id).not.toMatch(/^permit/m);
      expect(text, policy.id).toContain('@noblecloak_encoding("fail_closed")');
    }
  });
});
