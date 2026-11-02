# @noblecloak/theme

Design tokens and a small set of primitives for NobleCloak modules, for builders who bring no design system
of their own. Importing it changes nothing outside the module's root element, makes no network request, and
can be re-skinned through `--nc-*` variables or replaced primitive by primitive.

Licensed under Apache-2.0; see `LICENSE` and `NOTICE`.

## Install

```sh
bun add @noblecloak/theme
```

`react` (^19) is a peer dependency. There are no other runtime dependencies.

```tsx
import '@noblecloak/theme/index.css';
import { Button, ConfirmDialog } from '@noblecloak/theme';
```

| Import                             | What it is                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@noblecloak/theme`                | The primitives, the a11y helpers, `NcComponents`, `defaultComponents`, `cn` (a client module: `'use client'`) |
| `@noblecloak/theme/index.css`      | Tokens and primitive styles. No import, no reset of your page, no web font                                    |
| `@noblecloak/theme/tokens.css`     | The tokens alone                                                                                              |
| `@noblecloak/theme/components.css` | The primitive styles alone (they read the tokens, so load `tokens.css` first)                                 |
| `@noblecloak/theme/tokens.json`    | The token contract: each name, its meaning, its light and dark defaults                                       |
| `@noblecloak/theme/fonts.css`      | Opt-in brand fonts (the only file that makes a network request; see Fonts)                                    |

The JavaScript imports no CSS: importing a component alone adds no stylesheet.

## The root element

Everything renders inside an element with class `nc-root`, and every rule in `index.css` is scoped to it:
nothing targets `html`, `body`, `:root` or a bare element outside it.

```tsx
<div className="nc-root">
  <Button>Approve</Button>
</div>
```

Colours follow `prefers-color-scheme`. Set `data-nc-theme="light"` or `"dark"` on the root or any ancestor to
fix them. There is no `system` value: leave the attribute off to follow the OS.

## Theming with `--nc-*`

Set the variables on the root or an ancestor. One CSS file that sets only these is a complete re-theme; no
component changes.

The eight names `@noblecloak/react` already reads, unchanged:

| Name             | Meaning                                        | Light     | Dark      |
| ---------------- | ---------------------------------------------- | --------- | --------- |
| `--nc-bg`        | Surface behind the module                      | `#ffffff` | `#121212` |
| `--nc-fg`        | Text colour                                    | `#1a1a1a` | `#ececec` |
| `--nc-muted`     | Secondary text colour (not a surface)          | `#595959` | `#b0b0b0` |
| `--nc-border`    | Border colour                                  | `#bdbdbd` | `#5c5c5c` |
| `--nc-accent`    | Action colour and focus ring                   | `#0b57d0` | `#8ab4f8` |
| `--nc-danger`    | Errors and destructive actions                 | `#b3261e` | `#f2b8b5` |
| `--nc-radius`    | Corner radius                                  | `4px`     | `4px`     |
| `--nc-font-sans` | Text font family (unset: inherits your page's) | `inherit` | `inherit` |

The additions the primitives need, each defaulting to something derived from the eight, so a page that sets
only the eight still gets a coherent result:

| Name             | Meaning                                                  | Default                              |
| ---------------- | -------------------------------------------------------- | ------------------------------------ |
| `--nc-accent-fg` | Text on the accent colour                                | light `#ffffff`, dark `#121212`      |
| `--nc-danger-fg` | Text on the danger colour                                | light `#ffffff`, dark `#121212`      |
| `--nc-surface`   | A raised surface (Card, Dialog, Tooltip)                 | `--nc-bg`                            |
| `--nc-subtle`    | A quiet surface (Skeleton, Tabs track, row hover, Badge) | 8% of `--nc-fg` mixed into `--nc-bg` |
| `--nc-success`   | Success colour                                           | light `#1b6e33`, dark `#7fd18f`      |
| `--nc-warning`   | Warning colour                                           | light `#8a5300`, dark `#f2c066`      |
| `--nc-font-mono` | Monospace family (code Input)                            | `ui-monospace, monospace`            |
| `--nc-ring`      | Focus ring colour                                        | `--nc-accent`                        |

`tokens.json` carries the same table in machine-readable form, for generating a theme file. The `--nc-i-*`
variables in the CSS are internal and not a contract.

If you set `--nc-accent` or `--nc-danger` and the dark palette applies, also set `--nc-accent-fg` and
`--nc-danger-fg`: their dark defaults assume the default dark accent and danger colours.

## Fonts

`index.css` sets no font: the module inherits your page's family (`--nc-font-sans` unset) and size. For the
brand fonts (Space Grotesk and JetBrains Mono, SIL Open Font License 1.1), import
`@noblecloak/theme/fonts.css` as well. It loads them from Google Fonts, so your content-security policy needs
`fonts.googleapis.com` in `style-src` and `fonts.gstatic.com` in `font-src`. Its families are fallbacks: a
`--nc-font-sans` or `--nc-font-mono` you set on the root or an ancestor still wins, whichever file loads first.
To self-host, skip it and set the two variables yourself.

## Primitives

Button, Textarea, Checkbox, Alert, Tabs, Card, Input, Label, Select, Switch, Badge, Dialog and ConfirmDialog,
DataTable, Pagination, EmptyState, Skeleton, Spinner, Tooltip, Avatar and Separator; plus `VisuallyHidden`,
`AnnouncerProvider`/`useAnnouncer`, `useFocusReturn` and `useArrowNavigation`. All are native elements: Select
is a `<select>`, Checkbox an `<input type="checkbox">`, Switch a `<button role="switch">`, Tabs a group of
`aria-pressed` toggle buttons (one list or the other, not a tablist). There are no icons.

Overlays stay inside the root: Dialog is a native `<dialog>` opened with `showModal()`, which the browser draws
in the top layer while it stays a DOM descendant of the root (so it inherits the tokens; no portal); Select's
list is the browser's own; Tooltip renders beside its trigger.

`Button` is `type="button"` unless you pass `type`, so a module button never submits a form around it.

DataTable's `onRowClick` makes a row clickable and focusable (Enter or Space). A `<tr>` has no button role, so
assistive technology hears no action on it: put the same action in a link or button in a cell as well. A click
or key on a control inside a cell is that control's alone, so it does not also open the row. A
`sortable` column shows its `aria-sort` state, and becomes a sort button only when `onSortChange` is given.

## Restyling one instance

Every primitive forwards `className` and `style`. The theme's rules are two classes deep (`.nc-root .nc-x`), as
they must be to keep a page's own element and single-class rules out. So a single-class rule passed through
`className`, a utility such as `ml-2` or `p-4` included, does not apply. Scope it under the root instead, in a
stylesheet loaded after the theme's:

```css
.nc-root .approve-wide {
  margin-inline-start: 1rem;
}
```

An inline `style` also wins. To change the look everywhere, set the `--nc-*` variables or replace the
primitive (below).

## Slots: replacing a primitive

`NcComponents` names every primitive by role; `defaultComponents` maps each to the theme's own. Replace
entries under an `NcComponentsProvider`, and everything rendered below uses yours, including the theme's own
composites (ConfirmDialog, Pagination and DataTable render the `Button`, `Dialog`, `Alert`, `Checkbox` and
`Skeleton` of the map):

```tsx
import { defaultComponents, NcComponentsProvider, useNcComponents } from '@noblecloak/theme';

<NcComponentsProvider components={{ ...defaultComponents, Button: MyButton }}>
  <MyScreen />
</NcComponentsProvider>;

function MyScreen() {
  const { Button, ConfirmDialog } = useNcComponents();
  // ...
}
```

Replacing `Button` changes every action button: every `Button` slot, the composites' included, and the Tabs
toggles and a DataTable sort header, which are rendered by the `Button` slot (with `aria-pressed`, or the sort
header's glyph, passed through). It does not change a control whose button is its own role: the Switch is a
`<button role="switch">` styled by the Switch, so replace `Switch` to change it. A Checkbox, a Select and a
Tooltip render no button.

`MyButton` receives `ButtonProps` (native button props plus `variant`, `size` and `loading`). A replacement
`Dialog` receives `DialogProps`. Inside ConfirmDialog that means `open`, `onOpenChange`, `aria-label` (the
title), `onCancel` and the content as children. While a confirm is pending, `onCancel` calls `preventDefault`:
a replacement that closes on Escape should call it first and stay open if it was prevented. `DialogTitle` and
`DialogDescription` render as a plain heading and paragraph outside the theme's own `Dialog`, so the
replacement names itself from `aria-label`.

## The leak guarantee is a test

These run in a real browser (`bun run build && bun run e2e`, Playwright; the `e2e / theme` CI job):

- **Leak:** the computed styles of a host page's `html`, `body` and its own elements (and variables named
  `--background`, `--primary` and the like) are read before `index.css` loads and after it has loaded and a
  module has mounted, on a hostile page and on a plain one. They must be identical.
- **Inward:** on a hostile page (a universal `all: unset`, a preflight-style reset, loud `button`, `input`
  and `div` rules, its own utility classes) every theme element's computed style matches a clean page.
- **No network:** `index.css` and `tokens.css` hold no `@import` (in any form, the minified bare-string
  `@import"https://..."` included), no absolute or protocol-relative URL and no `@font-face`, and loading them
  makes no request off the page's origin.
- **Contrast:** axe's `color-contrast` rule passes for every primitive in its default state, and for the open
  ConfirmDialog and the open Tooltip. It is run with the default light and dark palettes and with a builder
  palette that sets only the eight names. axe exempts disabled controls from the rule, so disabled and
  loading states are not checked.

Each is shown able to fail. The suite runs house-written controls: one stylesheet with the three leaks a
typical design-system build has (a remote font import, a preflight reset, unprefixed `:root` variables), which
must break the leak and no-network checks, and one with the bare-string import form, which must break the
no-network checks. `NC_THEME_CSS=<path>` serves another file as the theme and `NC_THEME_CONTROL_CSS=<path>`
replaces the controls. One manual run against the design system's own build, which CI cannot fetch, is
recorded on 2026-10-20: the design system's published 0.4.0 `dist/index.css` (sha256
`5918b982…ebee`). Served as the theme, it fails both leak tests, the three inward tests and both no-network
tests. As the control, both control tests catch it.

How it holds: every selector starts with `.nc-root`, and every element a primitive renders carries `nc-ui`
plus its own class. The rules are not in a cascade layer, because a page's unlayered rules beat any layered
rule; unlayered, two classes outrank a page's element and single-class rules. A page's `!important` still
wins.

## Build output

`dist/` is not committed (the repository ignores it), so the built CSS is reviewed through its sources. That
works because the build does not process them: `dist/index.css` is `src/styles/tokens.css`, a newline and
`src/styles/components.css`, and `dist/tokens.css`, `dist/components.css`, `dist/fonts.css` and
`dist/tokens.json` are copies. The
e2e test `build-output.spec.ts` checks this after every build.

## Size

`bun run size` fails when `dist/index.css` is over 20 KB gzip (it is about 5.4 KB); the `e2e / theme` CI job runs it after the build.

## Preview

`bun run preview` (Storybook). Every primitive under default light, default dark, a hostile host, a builder's
slot and a builder's brand, chosen in the toolbar.
