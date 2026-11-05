/**
 * Golden files (B): the bytes each exporter writes for a fixed policy set are pinned, and importing a
 * golden file and exporting it again writes it unchanged. `UPDATE_GOLDEN=1 bun run test` rewrites them;
 * a change to them is a change to the format and needs a changeset.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { exportAgt } from './agt/export.js';
import { exportCedar } from './export.js';
import { asExportable, cedar, fixture } from './fixtures.test-support.js';
import { importAgt, importCedar } from './import.js';
import type { ExportablePolicy, InventoryTool } from './types.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'golden');

/** A hosted-publishable policy (role × tools × ask with on_deny and approver_groups) and every other form. */
export const CEDAR_POLICIES: ExportablePolicy[] = [
  {
    id: 'pol_finance_payments',
    kind: 'tool_invocation',
    name: 'Payments need finance approval',
    description: 'Any payment or refund by a member is approved by finance first.',
    subjects: [{ type: 'role', id: 'member' }],
    targets: { tools: ['mcp:stripe:main:create_refund', 'mcp:stripe:main:create_payment'] },
    config: {
      mode: 'ask',
      on_deny: 'halt',
      expires_after: 'PT1H',
      approver_groups: ['finance', 'owners'],
    },
  },
  {
    id: 'pol_contractor_deny',
    kind: 'tool_invocation',
    name: 'Contractors never send mail',
    subjects: [
      { type: 'user', id: 'usr_contractor_7' },
      { type: 'group', id: 'grp_contractors' },
    ],
    targets: { tools: ['mcp:gmail:main:send_email'] },
    config: { mode: 'deny' },
  },
  {
    id: 'pol_agent_escalate',
    kind: 'tool_invocation',
    name: 'Deploys escalate',
    subjects: [
      { type: 'agent', id: 'agt_release_bot' },
      { type: 'service', id: 'svc_ci' },
    ],
    targets: { tools: ['external:deploy'] },
    config: { mode: 'escalate', on_deny: 'resume' },
  },
  {
    id: 'pol_org_read',
    kind: 'tool_invocation',
    name: 'Everyone may read',
    description: '',
    subjects: [{ type: 'organization' }],
    config: { mode: 'always_allow' },
  },
  {
    id: 'pol_not_granted',
    kind: 'tool_invocation',
    name: 'Billing is not granted',
    subjects: [{ type: 'role', id: 'viewer' }],
    targets: { tools: ['mcp:stripe:main:create_payment', 'mcp:stripe:main:create_payment'] },
    config: { mode: 'not_granted' },
  },
];

export const AGT_POLICIES: ExportablePolicy[] = [
  {
    id: 'pol_agent_refunds',
    kind: 'tool_invocation',
    name: 'Refunds need approval',
    subjects: [{ type: 'agent', id: 'agt_support' }],
    targets: { tools: ['mcp:stripe:main:create_refund'] },
    config: { mode: 'ask', approver_groups: ['finance'] },
  },
  {
    id: 'pol_org_deploy',
    kind: 'tool_invocation',
    name: 'Deploys escalate',
    subjects: [{ type: 'organization' }],
    targets: { tools: ['external:deploy', 'mcp:gmail:main:send_email'] },
    config: { mode: 'escalate', expires_after: 'PT30M' },
  },
  {
    id: 'pol_agent_mail_deny',
    kind: 'tool_invocation',
    name: 'The support agent sends no mail',
    subjects: [
      { type: 'agent', id: 'agt_support' },
      { type: 'agent', id: 'agt_triage' },
    ],
    targets: { tools: ['mcp:gmail:main:send_email'] },
    config: { mode: 'deny' },
  },
  {
    id: 'pol_org_read',
    kind: 'tool_invocation',
    name: 'Everyone may read',
    subjects: [{ type: 'organization' }],
    config: { mode: 'always_allow' },
  },
];

/** Rev 16 forms: rules over facts, rule and policy approvers, exclude, and a rule-free policy with approvers. */
export const RULES_POLICIES: ExportablePolicy[] = [
  {
    id: 'pol_payments_by_amount',
    kind: 'tool_invocation',
    name: 'Large payments need finance',
    subjects: [{ type: 'agent', id: 'agt_support' }],
    targets: { tools: ['mcp:stripe:main:create_refund'] },
    config: {
      mode: 'always_allow',
      rules: [
        {
          when: [
            { fact: 'amount', op: 'gt', value: 500 },
            { fact: 'currency', op: 'in', value: ['eur', 'usd'] },
          ],
          then: 'ask',
          approvers: [
            { role: 'finance' },
            { user: 'usr_cfo', when: [{ fact: 'amount', op: 'gte', value: 5000 }] },
          ],
        },
        { when: [{ fact: 'reason', op: 'exists' }], then: 'always_allow' },
        { when: [{ fact: 'amount', op: 'lte', value: 1 }], then: 'deny' },
      ],
      approvers: [{ role: 'finance' }],
      exclude: ['requester'],
    },
  },
  {
    id: 'pol_deploy_by_env',
    kind: 'tool_invocation',
    name: 'Production deploys escalate',
    subjects: [{ type: 'agent', id: 'agt_release_bot' }],
    targets: { tools: ['external:deploy'] },
    config: {
      mode: 'escalate',
      expires_after: 'PT30M',
      rules: [
        { when: [{ fact: 'env', op: 'eq', value: 'staging' }], then: 'always_allow' },
        { when: [{ fact: 'env', op: 'not_in', value: ['staging', 'dev'] }], then: 'ask' },
      ],
    },
  },
  {
    id: 'pol_mail_exclude',
    kind: 'tool_invocation',
    name: 'Mail needs a second person',
    subjects: [{ type: 'agent', id: 'agt_support' }],
    targets: { tools: ['mcp:gmail:main:send_email'] },
    config: {
      mode: 'ask',
      approvers: [{ role: 'manager' }],
      exclude: ['requester'],
    },
  },
  {
    id: 'pol_open_read',
    kind: 'tool_invocation',
    name: 'Reads with a declared scope stay open',
    subjects: [{ type: 'organization' }],
    config: {
      mode: 'always_allow',
      rules: [{ when: [{ fact: 'scope', op: 'exists' }], then: 'always_allow' }],
    },
  },
  {
    id: 'pol_never_wire',
    kind: 'tool_invocation',
    name: 'Wires over the limit are denied',
    subjects: [{ type: 'agent', id: 'agt_support' }],
    config: {
      mode: 'ask',
      rules: [{ when: [{ fact: 'lines', op: 'lt', value: 0 }], then: 'deny' }],
    },
  },
];

const INVENTORY: InventoryTool[] = [
  { tool_ref: 'mcp:stripe:main:create_refund' },
  { tool_ref: 'mcp:gmail:main:send_email' },
  { tool_ref: 'mcp:gmail:main:list_messages' },
  { tool_ref: 'external:deploy' },
];

const TOOL_NAMES = {
  'mcp:stripe:main:create_refund': 'create_refund',
  'mcp:gmail:main:send_email': 'send_email',
  'mcp:gmail:main:list_messages': 'list_messages',
};

const CASES = [
  { file: 'noblecloak.cedar', text: () => exportCedar(CEDAR_POLICIES).text },
  {
    file: 'noblecloak-baseline.cedar',
    text: () => exportCedar(CEDAR_POLICIES, { baseline: 'allow' }).text,
  },
  { file: 'noblecloak-rules.cedar', text: () => exportCedar(RULES_POLICIES).text },
  { file: 'agt-5.0.yaml', text: () => exportAgt(AGT_POLICIES, INVENTORY).text },
  {
    file: 'agt-5.0-tool-names.yaml',
    text: () => exportAgt(AGT_POLICIES, INVENTORY, { toolNames: TOOL_NAMES }).text,
  },
  {
    file: 'agt-main.yaml',
    text: () =>
      exportAgt(AGT_POLICIES, INVENTORY, {
        agtVersion: 'main',
        toolNames: TOOL_NAMES,
        resolver: {
          default_resolver: 'noblecloak',
          on_timeout: 'deny',
          resolvers: { noblecloak: { type: 'webhook', url: 'https://example.test/approvals' } },
          timeout_seconds: 3600,
        },
      }).text,
  },
  {
    file: 'agt-main-rules.yaml',
    text: () =>
      exportAgt(RULES_POLICIES, INVENTORY, { agtVersion: 'main', toolNames: TOOL_NAMES }).text,
  },
] as const;

describe('golden files', () => {
  for (const { file, text } of CASES) {
    it(`${file}: the export writes the golden bytes`, () => {
      if (process.env.UPDATE_GOLDEN === '1') writeFileSync(join(GOLDEN, file), text());
      expect(text()).toBe(fixture(`golden/${file}`));
    });

    it(`${file}: importing it and exporting again writes it unchanged`, async () => {
      const golden = fixture(`golden/${file}`);
      if (file.endsWith('.cedar')) {
        const imported = await importCedar(golden, { cedar });
        expect(imported.unsupported).toEqual([]);
        expect(exportCedar(imported.policies.map(asExportable), imported.options).text).toBe(
          golden
        );
      } else {
        const imported = await importAgt(golden, { cedar });
        expect(imported.unsupported).toEqual([]);
        expect(
          exportAgt(imported.policies.map(asExportable), imported.tools, imported.options).text
        ).toBe(golden);
      }
    });
  }
});
