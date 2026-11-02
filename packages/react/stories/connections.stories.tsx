import type { Meta, StoryObj } from '@storybook/react-vite';

import { ConnectionDetail, Connections } from '../src/connections.js';
import { fakeConnectionsController } from '../src/testing/connections-fake.js';

/**
 * The connections components over a fixture controller (no service), rendered with the stylesheet the package ships.
 * No credential is ever shown: a token is typed into a write-only field and sent once.
 */
const meta: Meta<typeof Connections> = {
  title: 'Connections/Connections',
  component: Connections,
  parameters: { layout: 'padded' },
};

export default meta;

type Story = StoryObj<typeof Connections>;

export const List: Story = {
  render: () => <Connections controller={fakeConnectionsController()} />,
};

export const OpenRegistration: Story = {
  render: () => (
    <ConnectionDetail controller={fakeConnectionsController()} connectionId="conn_tracker" />
  ),
};

export const MemberAfterRefusal: Story = {
  render: () => (
    <Connections
      controller={fakeConnectionsController({
        administration: { readOnly: true, reason: 'forbidden' },
      })}
    />
  ),
};

export const ReturnedWithError: Story = {
  render: () => (
    <Connections
      controller={fakeConnectionsController({
        lastReturn: { connectionId: 'conn_crm', result: 'error', error: 'consent_denied' },
      })}
    />
  ),
};

export const NotOffered: Story = {
  render: () => <Connections controller={fakeConnectionsController({ status: 'unavailable' })} />,
};

export const Loading: Story = {
  render: () => <Connections controller={fakeConnectionsController({ status: 'loading' })} />,
};
