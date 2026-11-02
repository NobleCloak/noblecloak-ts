import type { Meta, StoryObj } from '@storybook/react-vite';

import { Gallery } from '../demo/Gallery.js';
import { SlotDemo } from '../demo/SlotDemo.js';

/** Every primitive at once, under each mode the theme promises to handle. */
const meta: Meta<typeof Gallery> = {
  title: 'Theme/Gallery',
  component: Gallery,
};

export default meta;

type Story = StoryObj<typeof Gallery>;

export const DefaultLight: Story = { parameters: { ncMode: 'light' } };
export const DefaultDark: Story = { parameters: { ncMode: 'dark' } };

/** demo/hostile.css on the whole page: universal all: unset, a preflight-style reset, loud element rules. */
export const HostileHost: Story = { parameters: { ncMode: 'hostile' } };

/** The ConfirmDialog open on the hostile host: a native dialog inside the root, no portal. */
export const HostileHostConfirmDialog: Story = {
  args: { only: ['Dialog'], dialogOpen: true },
  parameters: { ncMode: 'hostile' },
};

/** A builder's Button through the provider: every Button changes (ConfirmDialog's and Pagination's too). */
export const SlotDemoStory: Story = {
  name: 'SlotDemo',
  render: (args) => <SlotDemo {...args} />,
  parameters: { ncMode: 'light' },
};

/** A second palette from one CSS file that sets only the eight shipped --nc-* names (demo/builder-brand.css). */
export const BuilderBrand: Story = { parameters: { ncMode: 'brand' } };
