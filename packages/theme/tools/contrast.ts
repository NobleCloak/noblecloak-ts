/**
 * WCAG 2.x contrast ratio between two colours given as `#rrggbb`, or as `color-mix(in srgb, #a N%, #b)` (the
 * form `--nc-subtle` defaults to), which is mixed here channel by channel in sRGB the way the CSS function does.
 */

type Rgb = readonly [number, number, number];

function hex(value: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) throw new Error(`not a #rrggbb colour: ${value}`);
  const n = Number.parseInt(match[1] ?? '', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Parses `#rrggbb` or `color-mix(in srgb, #a P%, #b)`. */
export function parseColour(value: string): Rgb {
  const mix = /^color-mix\(in srgb, (#[0-9a-f]{6}) ([\d.]+)%, (#[0-9a-f]{6})\)$/i.exec(
    value.trim()
  );
  if (mix === null) return hex(value);
  const a = hex(mix[1] ?? '');
  const b = hex(mix[3] ?? '');
  const p = Number(mix[2]) / 100;
  return [0, 1, 2].map((i) =>
    Math.round((a[i] ?? 0) * p + (b[i] ?? 0) * (1 - p))
  ) as unknown as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast ratio, 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(parseColour(foreground));
  const b = luminance(parseColour(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
