import type { Meta, StoryObj } from '@storybook/react-vite';

import { ModeLegend, Permissions, PolicyEditor, PolicySimulation } from '../src/permissions.js';
import { FAKE_POLICIES, fakePoliciesController } from '../src/testing/permissions-fake.js';

/**
 * The permissions components over a fixture controller (no service), rendered with the stylesheet the package ships.
 * A cell shows the published policy that governs the pair, or "No policy"; a cell never shows a composed value (the
 * Effective access view, which needs a service, does).
 */
const meta: Meta<typeof Permissions> = {
  title: 'Permissions/Permissions',
  component: Permissions,
  parameters: { layout: 'padded' },
};

export default meta;

type Story = StoryObj<typeof Permissions>;

export const Table: Story = {
  render: () => (
    <Permissions
      controller={fakePoliciesController({
        roles: [{ id: 'member' }, { id: 'admin', label: 'Administrators' }],
      })}
    />
  ),
};

export const ReadOnly: Story = {
  render: () => (
    <Permissions
      controller={fakePoliciesController({
        snapshot: {
          authoring: { readOnly: true, reason: 'not_offered', canPublish: false, canRetire: false },
        },
      })}
    />
  ),
};

export const Loading: Story = {
  render: () => (
    <Permissions controller={fakePoliciesController({ snapshot: { status: 'loading' } })} />
  ),
};

export const NotOffered: Story = {
  render: () => (
    <Permissions controller={fakePoliciesController({ snapshot: { status: 'unavailable' } })} />
  ),
};

export const ReadFailed: Story = {
  render: () => (
    <Permissions
      controller={fakePoliciesController({
        snapshot: {
          status: 'error',
          error: { kind: 'unavailable', code: 'service_unavailable', title: 'down', status: 503 },
        },
      })}
    />
  ),
};

export const Editor: Story = {
  render: () => (
    <PolicyEditor controller={fakePoliciesController()} policyId={FAKE_POLICIES[0]?.id ?? ''} />
  ),
};

export const Simulation: Story = {
  render: () => (
    <PolicySimulation
      controller={fakePoliciesController({
        simulation: {
          status: 'done',
          draftVersion: 3,
          result: {
            decision: 'step_up',
            reason: 'approval_required',
            actionDigest: 'a'.repeat(64),
            enforced: false,
            wouldBe: 'step_up',
            policy: { id: 'pol_ask', version: 3 },
            appliesToCaller: true,
            considered: {
              policies: [
                {
                  kind: 'tool_invocation',
                  id: 'pol_ask',
                  version: 3,
                  result: 'ask',
                  subject: { type: 'role', id: 'member' },
                  name: 'Ask before tracker writes',
                },
                {
                  kind: 'duplicate_requests',
                  id: null,
                  version: null,
                  result: 'none',
                  source: 'default',
                },
              ],
              composed: { decision: 'step_up', reason: 'approval_required' },
            },
          },
        },
      })}
      policyId="pol_ask"
    />
  ),
};

export const Legend: Story = {
  render: () => <ModeLegend />,
};
