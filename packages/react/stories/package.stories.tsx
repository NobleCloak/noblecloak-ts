import type { Meta, StoryObj } from '@storybook/react-vite';

import { PACKAGE_NAME, VERSION } from '../src/index.js';

function PackageInfo() {
  return (
    <p>
      {PACKAGE_NAME} {VERSION}: module previews appear here as modules land.
    </p>
  );
}

const meta: Meta<typeof PackageInfo> = {
  title: 'Package/Info',
  component: PackageInfo,
};

export default meta;

export const Default: StoryObj<typeof PackageInfo> = {};
