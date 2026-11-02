/**
 * Build assertions for `@noblecloak/react`, run after its build (`bun ../../scripts/check-react-dist.ts`).
 * They check the built `dist/` against the package manifest: every export-map target exists, the
 * stylesheet is shipped, and the client entries (`approvals.js`, `action-status.js`, `auth.js`, `slots.js`, `permissions.js`, `connections.js`), and only they among the ones
 * declared in the export map, start with a `'use client'` directive. They also check what the package
 * publishes: an import of only one hook (`HEADLESS_PROBES`) bundles no component and no stylesheet, an
 * import of only `Approvals`, or of only `ApprovalRequest`, bundles the component and no stylesheet,
 * and so does an import of only `ActionStatus` (`checkThemeless`), a consumer that imports `dist/styles.css` does get one (`checkThemeControl`, which keeps
 * the other two from passing vacuously), the stylesheet holds `@noblecloak/theme`'s `tokens.css` once and the eight inputs with
 * their shipped defaults (`checkThemeTokens`), the stylesheet gzips within `STYLES_GZIP_BUDGET` (`checkStylesheetSize`), no declaration names a test seam or a private helper, and the README
 * that is published with the package exists.
 *
 * The example app has one more check, `example-bundle <dir>`, after its build: the production bundle keeps the
 * module's stylesheet.
 * The checks run in the build, not in a test, so they read the output of the build that is running and
 * never start a second build into the same `dist/`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

import { buildSync } from 'esbuild';

import {
  COMPONENTS_MARKER,
  COMPONENTS_MARKER_NAME,
  readThemeComponents,
  readThemeTokens,
  TOKENS_MARKER,
  TOKENS_MARKER_NAME,
} from './build-react-styles.js';

const CLIENT_ENTRIES = [
  'approvals.js',
  'action-status.js',
  'auth.js',
  'slots.js',
  'permissions.js',
  'connections.js',
] as const;

const isClientEntry = (name: string): boolean =>
  (CLIENT_ENTRIES as readonly string[]).includes(name);

interface Manifest {
  readonly exports: Readonly<
    Record<string, string | { readonly types: string; readonly import: string }>
  >;
}

/** What is wrong with the build in `root` (a package directory); empty when it is as the manifest says. */
export function checkDist(root: string): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;
  for (const entry of Object.values(manifest.exports)) {
    const targets = typeof entry === 'string' ? [entry] : [entry.types, entry.import];
    for (const target of targets) {
      if (!existsSync(join(root, target))) problems.push(`export-map target missing: ${target}`);
    }
  }
  if (!existsSync(join(root, 'dist/styles.css'))) problems.push('dist/styles.css missing');
  const startsWithDirective = (name: string): boolean | undefined => {
    const path = join(root, 'dist', name);
    return existsSync(path) ? readFileSync(path, 'utf8').startsWith("'use client';") : undefined;
  };
  // The JavaScript entries are the `import` targets of the export map; the client ones are named above and
  // every other one must be a server entry, so a new export is checked without a list to keep in step.
  const jsEntries = Object.values(manifest.exports)
    .filter((entry): entry is { types: string; import: string } => typeof entry !== 'string')
    .map((entry) => basename(entry.import));
  const serverEntries = jsEntries.filter((name) => !isClientEntry(name));
  for (const name of CLIENT_ENTRIES) {
    const has = startsWithDirective(name);
    if (has === undefined) problems.push(`dist/${name} missing`);
    else if (!has) problems.push(`dist/${name} lacks 'use client'`);
  }
  for (const name of serverEntries) {
    if (startsWithDirective(name) === true) problems.push(`dist/${name} has 'use client'`);
  }
  problems.push(...checkHeadless(root));
  problems.push(...checkThemeless(root));
  problems.push(...checkThemeControl(root));
  problems.push(...checkThemeTokens(root));
  problems.push(...checkThemeComponents(root));
  problems.push(...checkStylesheetSize(root));
  problems.push(...checkOneContext(root));
  problems.push(...checkProbeCoverage(root));
  problems.push(...checkDeclarations(root));
  problems.push(...checkNoConverter(root));
  // The README is published with the package.
  if (!existsSync(join(root, 'README.md'))) problems.push('README.md missing');
  return problems;
}

/** Names that exist for the package's own tests or internals and must not appear in a published declaration. */
export const UNPUBLISHED_NAMES: readonly string[] = [
  'createBrowserAuthWith',
  'BrowserAuthHooks',
  'escapeInvisible',
  'ApprovalsErrorBase',
  'PlainError',
];

/** Modules the headless probe leaves out of the bundle: peers and dependencies, not the package's own code. */
const PROBE_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', '@noblecloak/client'];

/** A hook that must tree-shake to no UI, and the `dist/` entry that exports it. */
interface HeadlessProbe {
  readonly hook: string;
  readonly entry: string;
}

/**
 * The hooks that must tree-shake to no UI: each is imported alone from its entry and bundled. A build whose entry
 * does not export the hook fails the bundle, so a probe can never pass by finding nothing to probe.
 */
export const HEADLESS_PROBES: readonly HeadlessProbe[] = [
  { hook: 'useApprovals', entry: 'approvals.js' },
  { hook: 'useApprovalRequest', entry: 'approvals.js' },
  { hook: 'useActionStatus', entry: 'action-status.js' },
  // Reading one slot pulls in none of the theme's primitives, so a builder's own component can call it.
  { hook: 'useSlot', entry: 'slots.js' },
  { hook: 'usePolicies', entry: 'permissions.js' },
  { hook: 'usePolicyEditor', entry: 'permissions.js' },
  { hook: 'usePolicySimulate', entry: 'permissions.js' },
  { hook: 'useEffectivePolicies', entry: 'permissions.js' },
  { hook: 'useConnections', entry: 'connections.js' },
  { hook: 'useConnection', entry: 'connections.js' },
];

/** The hooks of `HEADLESS_PROBES`, by name. */
export const HEADLESS_HOOKS = HEADLESS_PROBES.map((probe) => probe.hook);

/**
 * A component that must not carry the stylesheet, and the `dist/` entry that exports it. A hook that returns
 * components (`useNc`, the map of the theme's primitives) is probed here too: it bundles components, and no stylesheet.
 */
interface ThemelessProbe {
  readonly component: string;
  readonly entry: string;
}

/** The components that must not carry the stylesheet: each is imported alone from its entry and bundled. */
export const THEMELESS_PROBES: readonly ThemelessProbe[] = [
  { component: 'Approvals', entry: 'approvals.js' },
  { component: 'ApprovalRequest', entry: 'approvals.js' },
  { component: 'ActionStatus', entry: 'action-status.js' },
  { component: 'NcProvider', entry: 'slots.js' },
  { component: 'NcComponentsProvider', entry: 'slots.js' },
  { component: 'useNc', entry: 'slots.js' },
  { component: 'useNcComponents', entry: 'slots.js' },
  { component: 'Permissions', entry: 'permissions.js' },
  { component: 'PolicyEditor', entry: 'permissions.js' },
  { component: 'PolicySimulation', entry: 'permissions.js' },
  { component: 'EffectiveAccess', entry: 'permissions.js' },
  { component: 'PolicyRoundTrip', entry: 'permissions.js' },
  { component: 'ModeLegend', entry: 'permissions.js' },
  { component: 'Connections', entry: 'connections.js' },
  { component: 'ConnectionDetail', entry: 'connections.js' },
  { component: 'AddConnection', entry: 'connections.js' },
];

/** The components of `THEMELESS_PROBES`, by name. */
export const THEMELESS_COMPONENTS = THEMELESS_PROBES.map((probe) => probe.component);

interface ProbeBundle {
  readonly outputs: readonly { readonly path: string; readonly text: string }[];
}

/**
 * Bundles `contents` (resolved from `root`) with esbuild, `react` and the client left external, and returns
 * the output files, or `{ error }` when the bundle fails. An `outdir` is set so that a CSS output would appear
 * among the files.
 */
function bundleProbe(root: string, contents: string): ProbeBundle | { readonly error: string } {
  try {
    const result = buildSync({
      stdin: { contents, resolveDir: root, sourcefile: 'bundle-probe.js' },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      external: PROBE_EXTERNALS,
      outdir: join(root, 'dist-headless-probe'),
      logLevel: 'silent',
    });
    return { outputs: result.outputFiles };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** A CSS input always produces a CSS output under these options (probed, empty files included), so the output is the signal. */
const hasCssOutput = (bundle: ProbeBundle): boolean =>
  bundle.outputs.some((file) => file.path.endsWith('.css'));

const jsOf = (bundle: ProbeBundle): string =>
  bundle.outputs
    .filter((file) => file.path.endsWith('.js'))
    .map((file) => file.text)
    .join('\n');

/** Text of a bundle that shows a component: a call of the JSX runtime or a `nc-` class name. */
const holdsComponent = (js: string): boolean =>
  /\b_?jsx(?:s|DEV)?\d*\(/.test(js) || /["'`]nc-/.test(js);

/**
 * An import of only one hook (each of `HEADLESS_PROBES`) from its entry, bundled, must contain no
 * component and no stylesheet: the hook is usable with the host's own markup. A component shows as a call of
 * the JSX runtime or a `nc-` class name (an unused import of the runtime stays, because the probe leaves
 * `react` external and a bundler cannot know the import has no effect; the code behind it is what counts); a
 * stylesheet as a CSS output. A top-level call that a bundler cannot
 * prove pure keeps its component, so the source marks them with a pure annotation. The built `approvals.js`
 * and `action-status.js` share their components with a `chunk-*.js`, and `@noblecloak/theme` (a dependency, not
 * external to the probe) is bundled in, so no input path can name a component module; the text test above is what
 * detects one.
 */
export function checkHeadless(root: string): string[] {
  return HEADLESS_PROBES.flatMap((probe) => {
    if (!existsSync(join(root, 'dist', probe.entry))) return [];
    return checkHeadlessHook(root, probe);
  });
}

function checkHeadlessHook(root: string, { hook, entry }: HeadlessProbe): string[] {
  const bundle = bundleProbe(
    root,
    `import { ${hook} } from './dist/${entry}'; console.log(${hook});`
  );
  if ('error' in bundle) return [`headless bundle of ${hook} failed: ${bundle.error}`];
  const problems: string[] = [];
  if (hasCssOutput(bundle)) problems.push(`an import of only ${hook} bundles a stylesheet`);
  if (holdsComponent(jsOf(bundle))) problems.push(`an import of only ${hook} bundles a component`);
  return problems;
}

/**
 * An import of only a component (each of `THEMELESS_PROBES`) from its entry, bundled, must carry
 * the component and no stylesheet: the theme is the host's choice (`@noblecloak/react/styles.css`) and the
 * JavaScript never pulls it in. A probe that finds no component proves nothing, so it is reported as well.
 */
export function checkThemeless(root: string): string[] {
  // tsup does not leave a CSS import in the JavaScript: it writes the stylesheet next to the entry (dist/approvals.css)
  // and the entry itself carries no import, so only the file betrays it. `dist/styles.css` is the one stylesheet shipped.
  const stray = filesUnder(join(root, 'dist'))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.css') && file !== 'dist/styles.css')
    .map(
      (file) =>
        `${file} is a stylesheet the build emitted from a CSS import; only dist/styles.css ships`
    );
  return [
    ...stray,
    ...THEMELESS_PROBES.flatMap(({ component, entry }) => {
      if (!existsSync(join(root, 'dist', entry))) return [];
      const bundle = bundleProbe(
        root,
        `import { ${component} } from './dist/${entry}'; console.log(${component});`
      );
      if ('error' in bundle) return [`component bundle of ${component} failed: ${bundle.error}`];
      const problems: string[] = [];
      if (hasCssOutput(bundle))
        problems.push(`an import of only ${component} bundles the stylesheet`);
      if (!holdsComponent(jsOf(bundle))) {
        problems.push(`an import of only ${component} bundles no component (the probe is vacuous)`);
      }
      return problems;
    }),
  ];
}

/** The policy converter, its importer and the Cedar parser: a host loads them, so nothing shipped here names them. */
const CONVERTER_SPECIFIERS = ['@noblecloak/policy-formats', '@cedar-policy/cedar-wasm'] as const;

/**
 * The policy import/export panel takes the converter from the host (`formats`, `loadImporter`), so an app that does not
 * use the panel neither bundles nor installs `@noblecloak/policy-formats`, and only one that imports files loads the
 * importer and its Cedar parser (`@cedar-policy/cedar-wasm`, about 4.4 MB). No shipped file, declarations included,
 * names either package, and an import of only `Permissions`, bundled, holds no Cedar parser.
 */
export function checkNoConverter(root: string): string[] {
  const problems = filesUnder(join(root, 'dist'))
    .filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'))
    .flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      // As a module specifier (quoted), not in prose: a doc comment may name the package.
      return CONVERTER_SPECIFIERS.filter(
        (specifier) => text.includes(`'${specifier}`) || text.includes(`"${specifier}`)
      ).map((specifier) => `${relative(root, file)} names ${specifier}`);
    });
  if (!existsSync(join(root, 'dist', 'permissions.js'))) return problems;
  const bundle = bundleProbe(
    root,
    "import { Permissions } from './dist/permissions.js'; console.log(Permissions);"
  );
  if ('error' in bundle) return [...problems, `bundle of Permissions failed: ${bundle.error}`];
  const js = jsOf(bundle);
  if (!js.includes('nc-permissions-roundtrip'))
    problems.push(
      'an import of only Permissions holds no import/export panel (the probe is vacuous)'
    );
  if (/cedar[-_]wasm|policySetTextToParts/.test(js))
    problems.push('an import of only Permissions bundles the Cedar parser');
  return problems;
}

/** The value (non-`export type`) names a declaration file exports: `export { A } from`, `export declare function|const|class A`. */
function valueExports(dts: string): string[] {
  const names: string[] = [];
  for (const match of dts.matchAll(/^export\s+(?!type\b)\{([^}]*)\}/gm)) {
    for (const item of (match[1] ?? '').split(',')) {
      const name = item
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name) names.push(name);
    }
  }
  for (const match of dts.matchAll(/^export\s+(?:declare\s+)?(?:function|const|class)\s+(\w+)/gm)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

/**
 * The probe lists (`HEADLESS_PROBES`, `THEMELESS_COMPONENTS`) are kept by hand, so this ties them to the
 * declarations: every `use*` hook and every PascalCase value export (a component) of `dist/approvals.d.ts` and of
 * the `.d.ts` of each other probed entry must be probed, or the build fails until it is listed. A hook is covered
 * by a headless probe or, when it returns components, by a themeless one of its entry. A component is
 * probed for a stylesheet from the entry `THEMELESS_PROBES` names, so a component exported from any other entry
 * is unprobed and reported. `MODULE_ID` is not PascalCase and is ignored.
 */
export function checkProbeCoverage(root: string): string[] {
  const entries = [
    ...new Set([
      'approvals.js',
      ...HEADLESS_PROBES.map((probe) => probe.entry),
      ...THEMELESS_PROBES.map((probe) => probe.entry),
    ]),
  ];
  return entries.flatMap((entry) => {
    const dts = join(root, 'dist', entry.replace(/\.js$/, '.d.ts'));
    if (!existsSync(dts)) return [];
    const names = valueExports(readFileSync(dts, 'utf8'));
    const probedHooks = HEADLESS_PROBES.filter((probe) => probe.entry === entry).map(
      (probe) => probe.hook
    );
    const probedComponents = THEMELESS_PROBES.filter((probe) => probe.entry === entry).map(
      (probe) => probe.component
    );
    return [
      ...names
        .filter(
          (name) =>
            /^use[A-Z]/.test(name) &&
            !probedHooks.includes(name) &&
            !probedComponents.includes(name)
        )
        .map((name) => `${entry} exports the hook ${name}, which no headless probe covers`),
      ...names
        .filter((name) => /^[A-Z][a-z]/.test(name) && !probedComponents.includes(name))
        .map((name) => `${entry} exports ${name}, which no themeless probe covers`),
    ];
  });
}

/**
 * The positive control for `checkHeadless` and `checkThemeless`: a consumer that also imports
 * `dist/styles.css` gets a CSS output with a `.nc-` selector. When it does not, the "no stylesheet" checks
 * would pass on any build, so the control reports itself as failed. A missing `dist/styles.css` is
 * reported by `checkDist`, not here.
 */
export function checkThemeControl(root: string): string[] {
  if (!existsSync(join(root, 'dist/styles.css'))) return [];
  const bundle = bundleProbe(root, `import './dist/styles.css';`);
  if ('error' in bundle) return [`theme control failed: the bundle failed: ${bundle.error}`];
  const css = bundle.outputs.filter((file) => file.path.endsWith('.css'));
  if (!css.some((file) => /\.nc-[a-z0-9-]+/.test(file.text))) {
    return ['theme control failed: importing dist/styles.css produced no .nc- selector'];
  }
  return [];
}

/** One of the eight shipped inputs: `property` is declared as `var(<input>, <default>)` in each scope. */
export interface ShippedInputDefault {
  readonly input: string;
  readonly property: string;
  readonly light: string;
  /** The default in the two dark rules; absent for an input whose default does not change with the scheme. */
  readonly dark?: string;
}

/**
 * The eight inputs `@noblecloak/react` has shipped since 0.4.2, with their light and dark defaults. Changing a row is
 * changing the public contract. `checkThemeTokens` holds each scope of `dist/styles.css` to its own default: the
 * light `.nc-root` rules, the rules under `@media (prefers-color-scheme: dark)`, and the `[data-nc-theme='dark']`
 * rules.
 */
export const SHIPPED_INPUT_DEFAULTS: readonly ShippedInputDefault[] = [
  { input: '--nc-bg', property: '--nc-i-bg', light: '#ffffff', dark: '#121212' },
  { input: '--nc-fg', property: '--nc-i-fg', light: '#1a1a1a', dark: '#ececec' },
  { input: '--nc-muted', property: '--nc-i-muted', light: '#595959', dark: '#b0b0b0' },
  { input: '--nc-border', property: '--nc-i-border', light: '#bdbdbd', dark: '#5c5c5c' },
  { input: '--nc-accent', property: '--nc-i-accent', light: '#0b57d0', dark: '#8ab4f8' },
  { input: '--nc-danger', property: '--nc-i-danger', light: '#b3261e', dark: '#f2b8b5' },
  { input: '--nc-radius', property: '--nc-i-radius', light: '4px' },
  { input: '--nc-font-sans', property: 'font-family', light: 'inherit' },
];

/** A style rule: the at-rule preludes around it (outermost first), its selector, and its declarations in order. */
interface CssRule {
  readonly context: readonly string[];
  readonly selector: string;
  readonly declarations: readonly (readonly [string, string])[];
}

/**
 * The style rules of `css`, comments removed, whitespace collapsed. Enough for a stylesheet of flat rules, optionally
 * inside at-rules (no nested style rules, no `{` or `}` in a string), which is what `tokens.css` is.
 */
function cssRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const stack: string[] = [];
  let buffer = '';
  for (const char of text) {
    if (char === '{') {
      // A statement at-rule before the selector (`@import ...;`) ends at its `;`, which no selector holds.
      stack.push(
        buffer
          .slice(buffer.lastIndexOf(';') + 1)
          .trim()
          .replace(/\s+/g, ' ')
      );
      buffer = '';
    } else if (char === '}') {
      const selector = stack.pop() ?? '';
      const declarations = buffer
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.includes(':'))
        .map((part) => {
          const colon = part.indexOf(':');
          return [
            part.slice(0, colon).trim(),
            part
              .slice(colon + 1)
              .trim()
              .replace(/\s+/g, ' '),
          ] as const;
        });
      if (declarations.length > 0) rules.push({ context: [...stack], selector, declarations });
      buffer = '';
    } else buffer += char;
  }
  return rules;
}

/** The scopes the shipped defaults are pinned in: a name for the report, the rules it covers, which default. */
const DEFAULT_SCOPES: readonly {
  readonly name: string;
  readonly covers: (rule: CssRule) => boolean;
  readonly scheme: 'light' | 'dark';
}[] = [
  {
    name: 'light .nc-root',
    covers: (rule) => rule.context.length === 0 && rule.selector === '.nc-root',
    scheme: 'light',
  },
  {
    name: 'prefers-color-scheme: dark',
    covers: (rule) => rule.context.some((prelude) => /prefers-color-scheme:\s*dark/.test(prelude)),
    scheme: 'dark',
  },
  {
    name: "[data-nc-theme='dark']",
    covers: (rule) =>
      rule.context.length === 0 && /\[data-nc-theme=(['"]?)dark\1\]/.test(rule.selector),
    scheme: 'dark',
  },
];

/**
 * For each scope and each of `SHIPPED_INPUT_DEFAULTS` with a default for that scope's scheme, the last declaration
 * of the property in the scope's rules (the one that wins) must be `var(<input>, <default>)`.
 */
function checkShippedDefaults(css: string): string[] {
  const rules = cssRules(css);
  const problems: string[] = [];
  for (const scope of DEFAULT_SCOPES) {
    const declarations = rules.filter(scope.covers).flatMap((rule) => rule.declarations);
    for (const shipped of SHIPPED_INPUT_DEFAULTS) {
      const value = shipped[scope.scheme];
      if (value === undefined) continue;
      const expected = `var(${shipped.input}, ${value})`;
      const last = declarations.filter(([property]) => property === shipped.property).at(-1);
      if (last?.[1] !== expected) {
        problems.push(
          `dist/styles.css does not declare ${shipped.property}: ${expected} in its ${scope.name} rule`
        );
      }
    }
  }
  return problems;
}

/** How many times `needle` occurs in `text`, without overlaps. */
function occurrences(text: string, needle: string): number {
  if (needle === '') return 0;
  return text.split(needle).length - 1;
}

/**
 * `dist/styles.css` is composed from `@noblecloak/theme`'s `tokens.css` (`build-react-styles.ts`): it holds that file,
 * as the package resolves it, byte for byte and exactly once; the build marker is gone; it has no `@import` and no
 * `url()` to another origin (the stylesheet makes no request); and each scope declares `SHIPPED_INPUT_DEFAULTS` with
 * its own defaults (`checkShippedDefaults`). A missing `dist/styles.css` is reported by `checkDist`, not here.
 */
export function checkThemeTokens(root: string): string[] {
  const path = join(root, 'dist/styles.css');
  if (!existsSync(path)) return [];
  const css = readFileSync(path, 'utf8');
  const problems: string[] = [];
  let tokens: string;
  try {
    tokens = readThemeTokens(root);
  } catch (error) {
    return [
      `cannot read @noblecloak/theme's tokens.css: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const found = occurrences(css, tokens);
  if (tokens.trim() === '') problems.push("@noblecloak/theme's tokens.css is empty");
  else if (found === 0) {
    problems.push("dist/styles.css does not contain @noblecloak/theme's tokens.css byte for byte");
  } else if (found > 1) {
    problems.push(
      `dist/styles.css contains @noblecloak/theme's tokens.css ${String(found)} times, not once`
    );
  }
  if (/@import\b/i.test(css)) problems.push('dist/styles.css has an @import');
  if (/url\(\s*['"]?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(css)) {
    problems.push('dist/styles.css has a url() to another origin');
  }
  if (css.includes(TOKENS_MARKER_NAME)) {
    problems.push(`dist/styles.css still holds the build marker ${TOKENS_MARKER}`);
  }
  problems.push(...checkShippedDefaults(css));
  return problems;
}

/**
 * `dist/styles.css` also holds `@noblecloak/theme`'s `components.css` (the primitives' rules), as the package resolves
 * it, byte for byte, exactly once, and after the tokens: the modules render the primitives, and the module rules that
 * follow can still adjust them. A missing `dist/styles.css` is reported by `checkDist`, not here.
 */
export function checkThemeComponents(root: string): string[] {
  const path = join(root, 'dist/styles.css');
  if (!existsSync(path)) return [];
  const css = readFileSync(path, 'utf8');
  let components: string;
  let tokens: string;
  try {
    components = readThemeComponents(root);
    tokens = readThemeTokens(root);
  } catch (error) {
    return [
      `cannot read @noblecloak/theme's components.css: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (components.trim() === '') return ["@noblecloak/theme's components.css is empty"];
  const found = occurrences(css, components);
  if (found === 0) {
    return ["dist/styles.css does not contain @noblecloak/theme's components.css byte for byte"];
  }
  if (found > 1) {
    return [
      `dist/styles.css contains @noblecloak/theme's components.css ${String(found)} times, not once`,
    ];
  }
  const problems: string[] = [];
  if (css.includes(COMPONENTS_MARKER_NAME)) {
    problems.push(`dist/styles.css still holds the build marker ${COMPONENTS_MARKER}`);
  }
  if (css.indexOf(components) < css.indexOf(tokens)) {
    problems.push("dist/styles.css has @noblecloak/theme's components.css before its tokens.css");
  }
  return problems;
}

/**
 * The gzip budget of `dist/styles.css`, in bytes: the 20 KB `@noblecloak/theme` sets for its own `index.css`
 * (`packages/theme/tools/check-size.ts`), which this stylesheet inlines. It holds the theme's tokens and components
 * and the module rules, so the theme's ceiling is the one a builder already budgets for.
 */
export const STYLES_GZIP_BUDGET = 20 * 1024;

/** The raw and gzip (default level) size of `dist/styles.css`, or undefined when it is missing. */
export function stylesheetSize(root: string): { bytes: number; gzipBytes: number } | undefined {
  const path = join(root, 'dist/styles.css');
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path);
  return { bytes: content.length, gzipBytes: gzipSync(content).length };
}

/**
 * `dist/styles.css` gzips to at most `budget` bytes (`STYLES_GZIP_BUDGET`). The build prints the measured size, so
 * the number a release reports is the one this build produced. A missing stylesheet is reported by `checkDist`.
 */
export function checkStylesheetSize(root: string, budget = STYLES_GZIP_BUDGET): string[] {
  const size = stylesheetSize(root);
  if (size === undefined || size.gzipBytes <= budget) return [];
  return [
    `dist/styles.css is ${String(size.gzipBytes)} bytes gzip, over the budget of ${String(budget)}`,
  ];
}

/**
 * The slot context is `@noblecloak/theme`'s, imported by every entry, so a provider from `./slots` reaches the modules of
 * `./approvals` and `./action-status`. A `createContext` in any built file means a second context (the theme inlined
 * into an entry, or one of the package's own), which a builder's provider would not reach.
 */
export function checkOneContext(root: string): string[] {
  return filesUnder(join(root, 'dist'))
    .filter((file) => file.endsWith('.js'))
    .filter((file) => /\bcreateContext\b/.test(readFileSync(file, 'utf8')))
    .map(
      (file) =>
        `${relative(root, file).replaceAll('\\', '/')} calls createContext: the slot context must be @noblecloak/theme's, imported`
    );
}

/** The declarations (`dist/**\/*.d.ts`) must not name a test seam or a private helper (`UNPUBLISHED_NAMES`). */
export function checkDeclarations(root: string): string[] {
  const problems: string[] = [];
  for (const file of filesUnder(join(root, 'dist')).filter((path) => path.endsWith('.d.ts'))) {
    const text = readFileSync(file, 'utf8');
    for (const name of UNPUBLISHED_NAMES) {
      if (new RegExp(`\\b${name}\\b`).test(text)) {
        problems.push(`${relative(root, file)} names ${name}`);
      }
    }
  }
  return problems;
}

/** Every file under `dir`, depth first; `[]` when it does not exist. */
export function filesUnder(dir: string, skip: readonly string[] = []): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (skip.includes(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path, skip) : [path];
  });
}

/**
 * The example's production bundle (`.next/static`) keeps the module's stylesheet: a stylesheet there
 * carries the first `.nc-` selector of the package's `dist/styles.css`. Run after `next build`.
 */
export function checkExampleBundle(exampleRoot: string, reactRoot: string): string[] {
  const stylesheet = join(reactRoot, 'dist/styles.css');
  if (!existsSync(stylesheet)) return ['dist/styles.css missing'];
  const selector = /\.nc-[a-z0-9-]+/.exec(readFileSync(stylesheet, 'utf8'))?.[0];
  if (selector === undefined) return ['dist/styles.css has no .nc- rule'];
  const bundled = filesUnder(join(exampleRoot, '.next/static')).filter((path) =>
    path.endsWith('.css')
  );
  if (bundled.length === 0)
    return ['the production bundle has no stylesheet (.next/static/**/*.css)'];
  return bundled.some((path) => readFileSync(path, 'utf8').includes(selector))
    ? []
    : [`the production bundle dropped the module's stylesheet (no ${selector})`];
}

/** Runs the check named by `argv` (`[]` or `['package']`, `['example-bundle', dir]`) in `cwd`; returns the problems. */
export function run(argv: readonly string[], cwd: string): string[] {
  const [mode = 'package', dir = '.'] = argv;
  if (mode === 'package') return checkDist(cwd);
  if (mode === 'example-bundle')
    return checkExampleBundle(join(cwd, dir), join(cwd, dir, '../../packages/react'));
  return [`unknown mode: ${mode}`];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const problems = run(argv, process.cwd());
  const size = (argv[0] ?? 'package') === 'package' ? stylesheetSize(process.cwd()) : undefined;
  if (size !== undefined) {
    console.log(
      `check-react-dist: dist/styles.css is ${String(size.bytes)} bytes, ${String(size.gzipBytes)} bytes gzip (budget ${String(STYLES_GZIP_BUDGET)})`
    );
  }
  for (const problem of problems) console.error(`check-react-dist: ${problem}`);
  process.exit(problems.length === 0 ? 0 : 1);
}
