# @noblecloak/theme

## 0.1.2

### Patch Changes

- First release on the public npm registry. No code change: the versions step past the ones published to the organisation's package registry so that the public release is strictly newer.

## 0.1.1

### Patch Changes

- a3fe662: `Dialog` reports a close the browser forces (Chromium's cancel that cannot be prevented, after repeated Escapes) from that cancel, instead of waiting for the close event the browser dispatches in a later task. `ConfirmDialog` no longer draws a confirm failure that lands in between into the closed dialog; the failure still reaches `onError` (noblecloak-ui#57). The close is reported once, not again on its close event.

## 0.1.0

### Minor Changes

- b8f48d4: `@noblecloak/react`: bring your own components. `Approvals`, `ApprovalRequest` and `ActionStatus` now render their controls and panels with `@noblecloak/theme`'s primitives (`Button` for every button, the queue rows and the Pending/Recent toggles included; `Checkbox`, `Textarea`, `Alert`, `Card`, `Tabs`). A new client subpath, `@noblecloak/react/slots`, exports `NcProvider` (also `NcComponentsProvider`), `useNc`, `useSlot`, `defaultComponents` and the `NcComponents` type; each component also takes a `components` prop shaped like `labels`. A replaced `Button` replaces every button of every module, and `labels` is unchanged. `@noblecloak/theme` is now a dependency (one slot context for a builder's provider and the modules) and publishes in the same release. `styles.css` inlines the theme's primitive styles after its tokens (still one file, no import), so the look of the controls changes to the theme's, their focus ring included (the theme's 2px ring in `--nc-ring`, which falls back to the accent, where the module drew a 3px accent ring; the detail heading keeps the module's); the module's own plain elements are reset inside `.nc-root` so a host's element rules do not reach them; `code` and the call's JSON use `--nc-font-mono`. The import line and the eight `--nc-*` inputs are unchanged, and the theme's further `--nc-*` names now re-theme the modules too.

  `@noblecloak/theme`: `Tabs` toggles and the `DataTable` sort header render through the `Button` slot (their look is unchanged), `Tabs` takes `onReselect`, called when the pressed item is pressed again (the module uses it so choosing Recent again still re-reads it), `NcComponentsContext` and `useSlot` are exported, `components.css` is exported on its own, the entry carries `'use client'` (it calls `createContext`, which a React Server Component cannot import), and `NcComponentsProvider` keeps its merged map while its `components` and the enclosing map are unchanged, so consumers below it do not re-render with its parent.

- a356619: First content: the token contract and twenty primitives for builders who bring no design system. `index.css` (tokens and primitive styles, scoped to `.nc-root`, no import, no reset of the host page, no web font), `tokens.css`, `tokens.json` and an opt-in `fonts.css`. The tokens keep the eight `--nc-*` names `@noblecloak/react` reads and add `--nc-accent-fg`, `--nc-danger-fg`, `--nc-surface`, `--nc-subtle`, `--nc-success`, `--nc-warning`, `--nc-font-mono` and `--nc-ring`. Primitives on native elements: Button, Textarea, Checkbox, Alert, Tabs, Card, Input, Label, Select, Switch, Badge, Dialog, ConfirmDialog, DataTable, Pagination, EmptyState, Skeleton, Spinner, Tooltip, Avatar and Separator, with a11y helpers. `NcComponents`, `defaultComponents` and `NcComponentsProvider` replace a primitive everywhere it renders.
