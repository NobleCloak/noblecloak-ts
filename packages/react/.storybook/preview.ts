import type { Preview } from '@storybook/react-vite';

// `dist/styles.css` as the build composes it (src/styles.css with the theme's tokens.css and components.css
// inlined), served by the `nc-react-styles` plugin of main.ts, so the stories need no build of this package.
import 'virtual:nc-react-styles.css';

const preview: Preview = {
  parameters: { layout: 'padded' },
};

export default preview;
