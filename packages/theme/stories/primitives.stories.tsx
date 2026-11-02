import type { Meta, StoryObj } from '@storybook/react-vite';

import { Gallery } from '../demo/Gallery.js';
import type { GallerySection } from '../demo/Gallery.js';

/**
 * One story per primitive. The toolbar's Mode switches each between the default light and dark palettes, the
 * hostile host, the builder's slot (Button replaced) and the builder's brand file.
 */
const meta: Meta<typeof Gallery> = {
  title: 'Theme/Primitives',
  component: Gallery,
};

export default meta;

type Story = StoryObj<typeof Gallery>;

const only = (section: GallerySection): Story => ({ args: { only: [section] } });

export const Button: Story = only('Button');
export const Input: Story = only('Input');
export const Label: Story = only('Label');
export const Textarea: Story = only('Textarea');
export const Select: Story = only('Select');
export const Checkbox: Story = only('Checkbox');
export const Switch: Story = only('Switch');
export const Tabs: Story = only('Tabs');
export const Badge: Story = only('Badge');
export const Alert: Story = only('Alert');
export const Card: Story = only('Card');
export const Avatar: Story = only('Avatar');
export const Tooltip: Story = only('Tooltip');
export const Separator: Story = only('Separator');
export const Skeleton: Story = only('Skeleton');
export const Spinner: Story = only('Spinner');
export const EmptyState: Story = only('EmptyState');
export const DataTable: Story = only('DataTable');
export const Pagination: Story = only('Pagination');
export const DialogAndConfirmDialog: Story = only('Dialog');
