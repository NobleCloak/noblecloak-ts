/**
 * A builder replacing one primitive: `Button` swapped for the builder's own through the provider, with the
 * defaults spread under it. Every action button in the gallery changes, including those inside ConfirmDialog
 * and Pagination, the Tabs toggles and the DataTable sort header; nothing else does. The Switch is its own
 * `role="switch"` button, not the Button slot, so it keeps the theme's look.
 */
import type { ButtonProps } from '../src/index.js';
import { defaultComponents, NcComponentsProvider } from '../src/index.js';
import { Gallery } from './Gallery.js';
import type { GalleryProps } from './Gallery.js';

/** The builder's button: their own markup and inline styles, ignoring the theme's variants. */
export function BuilderButton({
  variant,
  size,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      data-builder-button=""
      data-variant={variant}
      data-size={size}
      disabled={disabled === true || loading}
      style={{
        background: variant === 'destructive' ? '#7a0019' : '#14532d',
        color: '#ffffff',
        border: '2px solid #000000',
        borderRadius: '999px',
        padding: '0.25em 1.25em',
        font: 'inherit',
        fontWeight: 700,
        cursor: 'pointer',
      }}
      {...props}
    >
      {children}
    </button>
  );
}

export function SlotDemo(props: GalleryProps) {
  return (
    <NcComponentsProvider components={{ ...defaultComponents, Button: BuilderButton }}>
      <Gallery {...props} />
    </NcComponentsProvider>
  );
}
