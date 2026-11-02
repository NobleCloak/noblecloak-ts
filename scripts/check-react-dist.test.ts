import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkDeclarations,
  checkDist,
  checkExampleBundle,
  checkHeadless,
  checkNoConverter,
  checkOneContext,
  checkProbeCoverage,
  checkStylesheetSize,
  checkThemeComponents,
  checkThemeControl,
  checkThemeless,
  checkThemeTokens,
  HEADLESS_HOOKS,
  run,
  SHIPPED_INPUT_DEFAULTS,
  STYLES_GZIP_BUDGET,
  stylesheetSize,
  UNPUBLISHED_NAMES,
} from './check-react-dist.js';

let root: string;

const MANIFEST = {
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './approvals': { types: './dist/approvals.d.ts', import: './dist/approvals.js' },
    './action-status': { types: './dist/action-status.d.ts', import: './dist/action-status.js' },
    './auth': { types: './dist/auth.d.ts', import: './dist/auth.js' },
    './permissions': { types: './dist/permissions.d.ts', import: './dist/permissions.js' },
    './connections': { types: './dist/connections.d.ts', import: './dist/connections.js' },
    './audit': { types: './dist/audit.d.ts', import: './dist/audit.js' },
    './slots': { types: './dist/slots.d.ts', import: './dist/slots.js' },
    './styles.css': './dist/styles.css',
  },
};

/**
 * The approvals entry as a build would leave it: the hook, and a component that a bundler drops when only
 * the hook is imported (a function declaration that nothing at the top level calls).
 */
const APPROVALS_JS = [
  "'use client';",
  "import { jsx } from 'react/jsx-runtime';",
  'export function useApprovals() { return 1; }',
  'export function useApprovalRequest() { return 2; }',
  "export function Approvals() { return jsx('div', { className: 'nc-root' }); }",
  "export function ApprovalRequest() { return jsx('div', { className: 'nc-request' }); }",
].join('\n');

/**
 * The action-status entry as a build would leave it: the hook, and a component that a bundler drops when only
 * the hook is imported.
 */
const ACTION_STATUS_JS = [
  "'use client';",
  "import { jsx } from 'react/jsx-runtime';",
  'export function useActionStatus() { return 3; }',
  "export function ActionStatus() { return jsx('div', { className: 'nc-root' }); }",
].join('\n');

/**
 * The slots entry as a build would leave it: `useSlot` reads a context and renders nothing; the provider and the map
 * hook render (their text holds a JSX call), and a bundler drops them when only `useSlot` is imported.
 */
const SLOTS_JS = [
  "'use client';",
  "import { jsx } from 'react/jsx-runtime';",
  'export function useSlot(name, fallback) { return fallback; }',
  "export function NcComponentsProvider(props) { return jsx('div', props); }",
  "export function useNcComponents() { return { Button: () => jsx('button', {}) }; }",
  'export { NcComponentsProvider as NcProvider, useNcComponents as useNc };',
].join('\n');

/**
 * The permissions entry as a build would leave it: four hooks, and components a bundler drops when only a hook is
 * imported. `Permissions` renders the import/export panel.
 */
const PERMISSIONS_JS = [
  "'use client';",
  "import { jsx } from 'react/jsx-runtime';",
  'export function usePolicies() { return 4; }',
  'export function usePolicyEditor() { return 5; }',
  'export function usePolicySimulate() { return 6; }',
  'export function useEffectivePolicies() { return 8; }',
  "export function PolicyRoundTrip() { return jsx('div', { className: 'nc-root nc-permissions-roundtrip' }); }",
  'export function Permissions() { return jsx(PolicyRoundTrip, {}); }',
  "export function EffectiveAccess() { return jsx('div', { className: 'nc-root' }); }",
  "export function PolicyEditor() { return jsx('div', { className: 'nc-root' }); }",
  "export function PolicySimulation() { return jsx('div', { className: 'nc-root' }); }",
  "export function ModeLegend() { return jsx('div', { className: 'nc-root' }); }",
].join('\n');

/**
 * The connections entry as a build would leave it: two hooks, and components a bundler drops when only a hook is
 * imported.
 */
const CONNECTIONS_JS = [
  "'use client';",
  "import { jsx } from 'react/jsx-runtime';",
  'export function useConnections() { return 7; }',
  'export function useConnection() { return 8; }',
  "export function Connections() { return jsx('div', { className: 'nc-root' }); }",
  "export function ConnectionDetail() { return jsx('div', { className: 'nc-root' }); }",
  "export function AddConnection() { return jsx('div', { className: 'nc-root' }); }",
].join('\n');

function write(path: string, text = ''): void {
  writeFileSync(join(root, path), text);
}

/** The theme's real token CSS: the fixtures install it as the `@noblecloak/theme` the package resolves. */
const THEME_TOKENS = readFileSync(
  join(import.meta.dirname, '..', 'packages', 'theme', 'src', 'styles', 'tokens.css'),
  'utf8'
);

/** The theme's real primitives' CSS: the fixtures install it as the theme's `./components.css`. */
const THEME_COMPONENTS = readFileSync(
  join(import.meta.dirname, '..', 'packages', 'theme', 'src', 'styles', 'components.css'),
  'utf8'
);

/** A `dist/styles.css` as the build composes it: the module rules around the theme's tokens and primitives. */
const composedStyles = (tokens = THEME_TOKENS, components = THEME_COMPONENTS): string =>
  `/* header */\n${tokens}\n${components}\n.nc-root .nc-row{color:red}\n`;

/** Installs a `@noblecloak/theme` under `root/node_modules` that exports `tokens` and `components`. */
function installTheme(tokens = THEME_TOKENS, components = THEME_COMPONENTS): void {
  const theme = join(root, 'node_modules', '@noblecloak', 'theme');
  mkdirSync(join(theme, 'dist'), { recursive: true });
  writeFileSync(
    join(theme, 'package.json'),
    JSON.stringify({
      name: '@noblecloak/theme',
      exports: { './tokens.css': './dist/tokens.css', './components.css': './dist/components.css' },
    })
  );
  writeFileSync(join(theme, 'dist', 'tokens.css'), tokens);
  writeFileSync(join(theme, 'dist', 'components.css'), components);
}

/** A package whose build is as the manifest says. */
function goodBuild(): void {
  mkdirSync(join(root, 'dist'));
  write('package.json', JSON.stringify(MANIFEST));
  for (const name of [
    'index',
    'approvals',
    'action-status',
    'auth',
    'permissions',
    'slots',
    'connections',
    'audit',
  ]) {
    write(`dist/${name}.d.ts`);
  }
  write('dist/index.js', 'export {};');
  write('dist/approvals.js', APPROVALS_JS);
  write('dist/action-status.js', ACTION_STATUS_JS);
  write('dist/auth.js', "'use client';\nexport {};");
  write('dist/slots.js', SLOTS_JS);
  write('dist/permissions.js', PERMISSIONS_JS);
  write('dist/connections.js', CONNECTIONS_JS);
  write('dist/audit.js', 'export {};');
  write('dist/styles.css', composedStyles());
  write('README.md', '# R');
  installTheme();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-react-dist-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkDist', () => {
  it('accepts a build that matches the manifest', () => {
    goodBuild();
    expect(checkDist(root)).toEqual([]);
  });

  it('reports a missing export-map target and a missing stylesheet', () => {
    goodBuild();
    rmSync(join(root, 'dist/auth.d.ts'));
    rmSync(join(root, 'dist/styles.css'));
    expect(checkDist(root)).toEqual([
      'export-map target missing: ./dist/auth.d.ts',
      'export-map target missing: ./dist/styles.css',
      'dist/styles.css missing',
    ]);
  });

  it('reports a client entry without the directive', () => {
    goodBuild();
    write('dist/approvals.js', APPROVALS_JS.replace("'use client';\n", ''));
    expect(checkDist(root)).toEqual(["dist/approvals.js lacks 'use client'"]);
  });

  it('reports a non-client entry that has the directive', () => {
    goodBuild();
    write('dist/index.js', "'use client';\nexport {};");
    expect(checkDist(root)).toEqual(["dist/index.js has 'use client'"]);
  });

  it('reports a client entry that is missing', () => {
    goodBuild();
    rmSync(join(root, 'dist/auth.js'));
    expect(checkDist(root)).toEqual([
      'export-map target missing: ./dist/auth.js',
      'dist/auth.js missing',
    ]);
  });

  it('reports a README that is missing: it is published with the package', () => {
    goodBuild();
    rmSync(join(root, 'README.md'));
    expect(checkDist(root)).toEqual(['README.md missing']);
  });

  it('checks a server entry the manifest declares without a list of names', () => {
    goodBuild();
    write('dist/audit.js', "'use client';\nexport {};");
    expect(checkDist(root)).toEqual(["dist/audit.js has 'use client'"]);
  });
});

describe('checkHeadless', () => {
  it('accepts an entry whose component a bundler drops when only the hook is imported', () => {
    goodBuild();
    expect(checkHeadless(root)).toEqual([]);
  });

  it('reports a component that the hook import still bundles', () => {
    goodBuild();
    // A top-level call that a bundler cannot prove pure keeps the component it names.
    write('dist/approvals.js', `${APPROVALS_JS}\nglobalThis.register(Approvals);`);
    // The module-level call is kept in both hook bundles, so each hook is named.
    expect(checkHeadless(root)).toEqual([
      'an import of only useApprovals bundles a component',
      'an import of only useApprovalRequest bundles a component',
    ]);
    expect(checkDist(root)).toEqual([
      'an import of only useApprovals bundles a component',
      'an import of only useApprovalRequest bundles a component',
    ]);
  });

  it('reports a class name of the component even without a JSX call', () => {
    goodBuild();
    write('dist/approvals.js', `${APPROVALS_JS}\nglobalThis.className = 'nc-error';`);
    expect(checkHeadless(root)).toEqual([
      'an import of only useApprovals bundles a component',
      'an import of only useApprovalRequest bundles a component',
    ]);
  });

  it('reports a stylesheet that the hook import still bundles', () => {
    goodBuild();
    write('dist/approvals.js', `import './styles.css';\n${APPROVALS_JS}`);
    expect(checkHeadless(root)).toEqual([
      'an import of only useApprovals bundles a stylesheet',
      'an import of only useApprovalRequest bundles a stylesheet',
    ]);
  });

  it('probes useApprovalRequest on its own: a component its import keeps is reported by name', () => {
    goodBuild();
    write(
      'dist/approvals.js',
      [
        "import { jsx } from 'react/jsx-runtime';",
        'export function useApprovals() { return 1; }',
        "export function ApprovalRequest() { return jsx('div', {}); }",
        'export function useApprovalRequest() { return ApprovalRequest; }',
      ].join('\n')
    );
    expect(checkHeadless(root)).toEqual([
      'an import of only useApprovalRequest bundles a component',
    ]);
  });

  it('reports a bundle that fails, naming the reason', () => {
    goodBuild();
    write('dist/approvals.js', 'export const useApprovalRequest = 1;');
    const [problem, ...rest] = checkHeadless(root);
    expect(problem).toMatch(/^headless bundle of useApprovals failed: [\s\S]*No matching export/);
    expect(rest).toEqual([]);
  });

  it('does nothing when the entry is missing (checkDist reports that)', () => {
    goodBuild();
    rmSync(join(root, 'dist/approvals.js'));
    expect(checkHeadless(root)).toEqual([]);
  });
});

describe('checkHeadless: useActionStatus', () => {
  it('probes the ten hooks by name', () => {
    expect(HEADLESS_HOOKS).toEqual([
      'useApprovals',
      'useApprovalRequest',
      'useActionStatus',
      'useSlot',
      'usePolicies',
      'usePolicyEditor',
      'usePolicySimulate',
      'useEffectivePolicies',
      'useConnections',
      'useConnection',
    ]);
  });

  it('accepts an entry that exports the hook and whose component a bundler drops', () => {
    goodBuild();
    expect(checkHeadless(root)).toEqual([]);
    write(
      'dist/action-status.js',
      'function useActionStatus() { return 3; }\nexport { useActionStatus };'
    );
    expect(checkHeadless(root)).toEqual([]);
  });

  it('reports an entry that no longer exports the hook, instead of probing nothing', () => {
    goodBuild();
    write('dist/action-status.js', "'use client';\nexport const MODULE_ID = 'action-status';");
    const [problem, ...rest] = checkHeadless(root);
    expect(problem).toMatch(
      /^headless bundle of useActionStatus failed: [\s\S]*No matching export/
    );
    expect(rest).toEqual([]);
  });

  it('reports an exported hook whose import keeps a component, naming the hook', () => {
    goodBuild();
    write(
      'dist/action-status.js',
      [
        "import { jsx } from 'react/jsx-runtime';",
        "function ActionStatus() { return jsx('div', {}); }",
        'export function useActionStatus() { return ActionStatus; }',
      ].join('\n')
    );
    expect(checkHeadless(root)).toEqual(['an import of only useActionStatus bundles a component']);
  });
});

describe('checkHeadless: JSX emit shapes', () => {
  it('detects a component emitted as _jsx or jsxDEV', () => {
    goodBuild();
    write(
      'dist/action-status.js',
      "function A() { return jsxDEV('div', {}); }\nexport function useActionStatus() { return A; }"
    );
    expect(checkHeadless(root)).toEqual(['an import of only useActionStatus bundles a component']);
    write(
      'dist/action-status.js',
      "function A() { return _jsx('div', {}); }\nexport function useActionStatus() { return A; }"
    );
    expect(checkHeadless(root)).toEqual(['an import of only useActionStatus bundles a component']);
  });
});

describe('checkThemeless', () => {
  it('accepts a component entry that does not import the stylesheet', () => {
    goodBuild();
    expect(checkThemeless(root)).toEqual([]);
    expect(checkDist(root)).toEqual([]);
  });

  it('reports a component entry that imports the stylesheet, naming both components', () => {
    goodBuild();
    // The components are exported next to the hooks, so an import of either carries the stylesheet.
    write('dist/approvals.js', `import './styles.css';\n${APPROVALS_JS}`);
    expect(checkThemeless(root)).toEqual([
      'an import of only Approvals bundles the stylesheet',
      'an import of only ApprovalRequest bundles the stylesheet',
    ]);
    expect(checkDist(root)).toContain('an import of only Approvals bundles the stylesheet');
  });

  it('reports a stylesheet reached through another module of the entry', () => {
    goodBuild();
    write('dist/theme-loader.js', "import './styles.css';\nexport const theme = 1;");
    write(
      'dist/approvals.js',
      `import { theme } from './theme-loader.js';\n${APPROVALS_JS}\nglobalThis.theme = theme;`
    );
    expect(checkThemeless(root)).toEqual([
      'an import of only Approvals bundles the stylesheet',
      'an import of only ApprovalRequest bundles the stylesheet',
    ]);
  });

  it('reports a stylesheet the build emitted next to an entry from a CSS import', () => {
    goodBuild();
    write('dist/approvals.css', '.nc-root{color:red}');
    const expected =
      'dist/approvals.css is a stylesheet the build emitted from a CSS import; only dist/styles.css ships';
    expect(checkThemeless(root)).toEqual([expected]);
    expect(checkDist(root)).toEqual([expected]);
  });

  it('reports a probe that finds no component, so the check cannot pass vacuously', () => {
    goodBuild();
    write(
      'dist/approvals.js',
      [
        'export function useApprovals() { return 1; }',
        'export function useApprovalRequest() { return 2; }',
        'export function Approvals() { return 3; }',
        'export function ApprovalRequest() { return 4; }',
      ].join('\n')
    );
    expect(checkThemeless(root)).toEqual([
      'an import of only Approvals bundles no component (the probe is vacuous)',
      'an import of only ApprovalRequest bundles no component (the probe is vacuous)',
    ]);
  });

  it('reports a bundle that fails, naming the component and the reason', () => {
    goodBuild();
    write('dist/approvals.js', 'export const ApprovalRequest = 1;');
    const [problem, ...rest] = checkThemeless(root);
    expect(problem).toMatch(/^component bundle of Approvals failed: [\s\S]*No matching export/);
    expect(rest).toEqual([
      'an import of only ApprovalRequest bundles no component (the probe is vacuous)',
    ]);
  });

  it('does nothing when the entry is missing (checkDist reports that)', () => {
    goodBuild();
    rmSync(join(root, 'dist/approvals.js'));
    rmSync(join(root, 'dist/action-status.js'));
    expect(checkThemeless(root)).toEqual([]);
  });

  it('probes ActionStatus from its own entry: a stylesheet there is reported by name', () => {
    goodBuild();
    write('dist/action-status.js', `import './styles.css';\n${ACTION_STATUS_JS}`);
    expect(checkThemeless(root)).toEqual(['an import of only ActionStatus bundles the stylesheet']);
    expect(checkDist(root)).toContain('an import of only ActionStatus bundles the stylesheet');
  });

  it('reports an ActionStatus probe that finds no component, so it cannot pass vacuously', () => {
    goodBuild();
    write(
      'dist/action-status.js',
      "'use client';\nexport function useActionStatus() { return 3; }\nexport function ActionStatus() { return 4; }"
    );
    expect(checkThemeless(root)).toEqual([
      'an import of only ActionStatus bundles no component (the probe is vacuous)',
    ]);
  });
});

describe('checkThemeControl', () => {
  it('accepts a stylesheet that bundles to a CSS output with a .nc- selector', () => {
    goodBuild();
    expect(checkThemeControl(root)).toEqual([]);
  });

  it('fails the control when the stylesheet has no .nc- rule', () => {
    goodBuild();
    write('dist/styles.css', '.other{color:red}');
    expect(checkThemeControl(root)).toEqual([
      'theme control failed: importing dist/styles.css produced no .nc- selector',
    ]);
    expect(checkDist(root)).toContain(
      'theme control failed: importing dist/styles.css produced no .nc- selector'
    );
  });

  it('fails the control when the stylesheet is empty (a bundle with no rule to carry)', () => {
    goodBuild();
    write('dist/styles.css', '');
    expect(checkThemeControl(root)).toEqual([
      'theme control failed: importing dist/styles.css produced no .nc- selector',
    ]);
  });

  it('leaves a missing stylesheet to checkDist, which reports it', () => {
    goodBuild();
    rmSync(join(root, 'dist/styles.css'));
    expect(checkThemeControl(root)).toEqual([]);
    expect(checkDist(root)).toContain('dist/styles.css missing');
  });
});

describe('checkThemeTokens', () => {
  it("accepts a stylesheet that holds the theme's tokens once, with the eight defaults", () => {
    goodBuild();
    expect(checkThemeTokens(root)).toEqual([]);
  });

  it('pins every default of the eight shipped inputs, light and dark', () => {
    expect(SHIPPED_INPUT_DEFAULTS).toEqual([
      { input: '--nc-bg', property: '--nc-i-bg', light: '#ffffff', dark: '#121212' },
      { input: '--nc-fg', property: '--nc-i-fg', light: '#1a1a1a', dark: '#ececec' },
      { input: '--nc-muted', property: '--nc-i-muted', light: '#595959', dark: '#b0b0b0' },
      { input: '--nc-border', property: '--nc-i-border', light: '#bdbdbd', dark: '#5c5c5c' },
      { input: '--nc-accent', property: '--nc-i-accent', light: '#0b57d0', dark: '#8ab4f8' },
      { input: '--nc-danger', property: '--nc-i-danger', light: '#b3261e', dark: '#f2b8b5' },
      { input: '--nc-radius', property: '--nc-i-radius', light: '4px' },
      { input: '--nc-font-sans', property: 'font-family', light: 'inherit' },
    ]);
  });

  it("fails when the stylesheet differs from the theme's tokens by one byte", () => {
    goodBuild();
    installTheme(THEME_TOKENS.replace('#1b6e33', '#1b6e34'));
    expect(checkThemeTokens(root)).toEqual([
      "dist/styles.css does not contain @noblecloak/theme's tokens.css byte for byte",
    ]);
    expect(checkDist(root)).toContain(
      "dist/styles.css does not contain @noblecloak/theme's tokens.css byte for byte"
    );
  });

  it('fails when the tokens occur twice', () => {
    goodBuild();
    write('dist/styles.css', composedStyles(`${THEME_TOKENS}${THEME_TOKENS}`));
    expect(checkThemeTokens(root)).toEqual([
      "dist/styles.css contains @noblecloak/theme's tokens.css 2 times, not once",
    ]);
  });

  it('fails on an @import, in the tokens or anywhere else', () => {
    goodBuild();
    const imported = `@import url(https://example.com/x.css);\n${THEME_TOKENS}`;
    installTheme(imported);
    write('dist/styles.css', composedStyles(imported));
    expect(checkThemeTokens(root)).toEqual([
      'dist/styles.css has an @import',
      'dist/styles.css has a url() to another origin',
    ]);
    installTheme();
    write('dist/styles.css', `@import 'x.css';\n${composedStyles()}`);
    expect(checkThemeTokens(root)).toEqual(['dist/styles.css has an @import']);
  });

  it('fails on a url() to another origin, with or without a scheme, and accepts a local one', () => {
    goodBuild();
    for (const form of ["url('https://x.test/a.png')", 'url(//x.test/a.png)', 'url( "http://x")']) {
      write('dist/styles.css', `${composedStyles()}.nc-root .nc-a{background:${form}}\n`);
      expect(checkThemeTokens(root), form).toEqual([
        'dist/styles.css has a url() to another origin',
      ]);
    }
    write('dist/styles.css', `${composedStyles()}.nc-root .nc-a{background:url(a.png)}\n`);
    expect(checkThemeTokens(root)).toEqual([]);
  });

  it('fails when the build marker survives', () => {
    goodBuild();
    write('dist/styles.css', `${composedStyles()}/* @nc-theme-tokens */\n`);
    expect(checkThemeTokens(root)).toEqual([
      'dist/styles.css still holds the build marker /* @nc-theme-tokens */',
    ]);
  });

  it('fails when a shipped default changes in the output and in the theme alike', () => {
    goodBuild();
    const changed = THEME_TOKENS.replace('var(--nc-accent, #0b57d0)', 'var(--nc-accent, #0b57d1)');
    installTheme(changed);
    write('dist/styles.css', composedStyles(changed));
    expect(checkThemeTokens(root)).toEqual([
      'dist/styles.css does not declare --nc-i-accent: var(--nc-accent, #0b57d0) in its light .nc-root rule',
    ]);
  });

  it('does not count a default that only a comment holds', () => {
    goodBuild();
    const commented = THEME_TOKENS.replace(
      '--nc-i-accent: var(--nc-accent, #0b57d0);',
      '--nc-i-accent: var(--nc-accent, #0b57d1); /* var(--nc-accent, #0b57d0) */'
    );
    installTheme(commented);
    write('dist/styles.css', composedStyles(commented));
    expect(checkThemeTokens(root)).toEqual([
      'dist/styles.css does not declare --nc-i-accent: var(--nc-accent, #0b57d0) in its light .nc-root rule',
    ]);
  });

  it('holds the light and the two dark rules to their own defaults', () => {
    goodBuild();
    const [light, media, attribute] = THEME_TOKENS.split('--nc-i-fg: var(--nc-fg, #ececec);');
    const swapped = `${light ?? ''}--nc-i-fg: var(--nc-fg, #ececec);${media ?? ''}--nc-i-fg: var(--nc-fg, #1a1a1a);${attribute ?? ''}`;
    installTheme(swapped);
    write('dist/styles.css', composedStyles(swapped));
    expect(checkThemeTokens(root)).toEqual([
      "dist/styles.css does not declare --nc-i-fg: var(--nc-fg, #ececec) in its [data-nc-theme='dark'] rule",
    ]);
  });

  it('reads the last declaration of a scope, so a later .nc-root rule that overrides a token fails', () => {
    goodBuild();
    write('dist/styles.css', `${composedStyles()}.nc-root { --nc-i-radius: 0; }\n`);
    expect(checkThemeTokens(root)).toEqual([
      'dist/styles.css does not declare --nc-i-radius: var(--nc-radius, 4px) in its light .nc-root rule',
    ]);
  });

  it('reports every dark default when the stylesheet has no dark rules', () => {
    goodBuild();
    const lightOnly = THEME_TOKENS.slice(
      0,
      THEME_TOKENS.indexOf('@media (prefers-color-scheme: dark)')
    );
    installTheme(lightOnly);
    write('dist/styles.css', composedStyles(lightOnly));
    const problems = checkThemeTokens(root);
    expect(problems).toHaveLength(12);
    expect(problems[0]).toBe(
      'dist/styles.css does not declare --nc-i-bg: var(--nc-bg, #121212) in its prefers-color-scheme: dark rule'
    );
  });

  it('fails when the theme cannot be resolved or is empty', () => {
    goodBuild();
    rmSync(join(root, 'node_modules'), { recursive: true });
    const [problem, ...rest] = checkThemeTokens(root);
    expect(rest).toEqual([]);
    expect(problem).toMatch(/^cannot read @noblecloak\/theme's tokens\.css: /);
    installTheme('');
    expect(checkThemeTokens(root)).toEqual(["@noblecloak/theme's tokens.css is empty"]);
  });

  it('leaves a missing stylesheet to checkDist', () => {
    goodBuild();
    rmSync(join(root, 'dist/styles.css'));
    expect(checkThemeTokens(root)).toEqual([]);
  });
});

describe('checkThemeComponents', () => {
  it("accepts a stylesheet that holds the theme's components.css once, after the tokens", () => {
    goodBuild();
    expect(checkThemeComponents(root)).toEqual([]);
  });

  it('fails when the primitives differ by one byte, occur twice, come first or the marker survives', () => {
    goodBuild();
    installTheme(THEME_TOKENS, THEME_COMPONENTS.replace('0.875em', '0.876em'));
    expect(checkThemeComponents(root)).toEqual([
      "dist/styles.css does not contain @noblecloak/theme's components.css byte for byte",
    ]);
    expect(checkDist(root)).toContain(
      "dist/styles.css does not contain @noblecloak/theme's components.css byte for byte"
    );
    installTheme();
    write(
      'dist/styles.css',
      composedStyles(THEME_TOKENS, `${THEME_COMPONENTS}${THEME_COMPONENTS}`)
    );
    expect(checkThemeComponents(root)).toEqual([
      "dist/styles.css contains @noblecloak/theme's components.css 2 times, not once",
    ]);
    write('dist/styles.css', `${THEME_COMPONENTS}\n${THEME_TOKENS}\n`);
    expect(checkThemeComponents(root)).toEqual([
      "dist/styles.css has @noblecloak/theme's components.css before its tokens.css",
    ]);
    write('dist/styles.css', `${composedStyles()}/* @nc-theme-components */\n`);
    expect(checkThemeComponents(root)).toEqual([
      'dist/styles.css still holds the build marker /* @nc-theme-components */',
    ]);
  });

  it('fails when the theme cannot be resolved or its components.css is empty', () => {
    goodBuild();
    rmSync(join(root, 'node_modules'), { recursive: true });
    const [problem, ...rest] = checkThemeComponents(root);
    expect(rest).toEqual([]);
    expect(problem).toMatch(/^cannot read @noblecloak\/theme's components\.css: /);
    installTheme(THEME_TOKENS, ' ');
    expect(checkThemeComponents(root)).toEqual(["@noblecloak/theme's components.css is empty"]);
  });

  it('leaves a missing stylesheet to checkDist', () => {
    goodBuild();
    rmSync(join(root, 'dist/styles.css'));
    expect(checkThemeComponents(root)).toEqual([]);
  });
});

describe('checkStylesheetSize', () => {
  it('accepts a stylesheet under the gzip budget and reports its size', () => {
    goodBuild();
    expect(checkStylesheetSize(root)).toEqual([]);
    const size = stylesheetSize(root);
    expect(size?.gzipBytes).toBeGreaterThan(0);
    expect(size?.gzipBytes).toBeLessThanOrEqual(STYLES_GZIP_BUDGET);
    expect(STYLES_GZIP_BUDGET).toBe(20 * 1024);
  });

  it('fails a stylesheet over the budget, from checkDist too', () => {
    goodBuild();
    // Random bytes, base64-encoded, gzip to about three quarters of their length: well over the budget.
    write(
      'dist/styles.css',
      `${composedStyles()}/* ${randomBytes(32 * 1024).toString('base64')} */\n`
    );
    const size = stylesheetSize(root);
    expect(size?.gzipBytes).toBeGreaterThan(STYLES_GZIP_BUDGET);
    expect(checkStylesheetSize(root)).toEqual([
      `dist/styles.css is ${String(size?.gzipBytes)} bytes gzip, over the budget of ${String(STYLES_GZIP_BUDGET)}`,
    ]);
    expect(checkDist(root)).toContain(checkStylesheetSize(root)[0]);
    write('dist/styles.css', composedStyles());
    expect(checkStylesheetSize(root, 8)).toEqual([
      `dist/styles.css is ${String(stylesheetSize(root)?.gzipBytes)} bytes gzip, over the budget of 8`,
    ]);
  });

  it('leaves a missing stylesheet to checkDist', () => {
    goodBuild();
    rmSync(join(root, 'dist/styles.css'));
    expect(checkStylesheetSize(root)).toEqual([]);
    expect(stylesheetSize(root)).toBeUndefined();
  });
});

describe('checkOneContext', () => {
  it('accepts a build that creates no context of its own', () => {
    goodBuild();
    expect(checkOneContext(root)).toEqual([]);
  });

  it('reports every built file that calls createContext (an inlined theme or a second context)', () => {
    goodBuild();
    mkdirSync(join(root, 'dist', 'auth'));
    write(
      'dist/chunk-ABC.js',
      "import { createContext } from 'react';\nexport const c = createContext(null);"
    );
    write('dist/auth/x.js', 'const c = React.createContext(null);');
    write('dist/approvals.d.ts', 'export declare const createContext: number;');
    expect(checkOneContext(root)).toEqual([
      "dist/auth/x.js calls createContext: the slot context must be @noblecloak/theme's, imported",
      "dist/chunk-ABC.js calls createContext: the slot context must be @noblecloak/theme's, imported",
    ]);
  });
});

describe('checkDeclarations', () => {
  it('accepts declarations that name no unpublished name', () => {
    goodBuild();
    write('dist/approvals.d.ts', 'export declare function createBrowserAuth(): void;');
    expect(checkDeclarations(root)).toEqual([]);
  });

  it.each(UNPUBLISHED_NAMES)('reports a declaration that names %s', (name) => {
    goodBuild();
    mkdirSync(join(root, 'dist/nested'));
    write('dist/nested/x.d.ts', `export declare function ${name}(): void;`);
    expect(checkDeclarations(root)).toEqual([`dist/nested/x.d.ts names ${name}`]);
    expect(checkDist(root)).toEqual([`dist/nested/x.d.ts names ${name}`]);
  });

  it('does not report a longer name, and reads declarations only', () => {
    goodBuild();
    write('dist/a.d.ts', 'export declare const createBrowserAuthWithout: 1;');
    write('dist/a.js', 'export const escapeInvisible = 1;');
    expect(checkDeclarations(root)).toEqual([]);
  });
});

describe('checkExampleBundle', () => {
  const bundle = (css: string): void => {
    mkdirSync(join(root, 'example/.next/static/chunks'), { recursive: true });
    writeFileSync(join(root, 'example/.next/static/chunks/a.css'), css);
  };
  const react = (css = '.nc-root{color:red}'): void => {
    mkdirSync(join(root, 'react/dist'), { recursive: true });
    writeFileSync(join(root, 'react/dist/styles.css'), css);
  };
  const check = (): string[] => checkExampleBundle(join(root, 'example'), join(root, 'react'));

  it('accepts a bundle that carries the package stylesheet', () => {
    react();
    bundle('body{margin:0}.nc-root{color:red}');
    expect(check()).toEqual([]);
  });

  it('reports a bundle whose stylesheets lack the module rules', () => {
    react();
    bundle('body{margin:0}');
    expect(check()).toEqual([
      "the production bundle dropped the module's stylesheet (no .nc-root)",
    ]);
  });

  it('reports a bundle with no stylesheet at all, a missing package stylesheet and one with no rule', () => {
    react();
    expect(check()).toEqual(['the production bundle has no stylesheet (.next/static/**/*.css)']);
    rmSync(join(root, 'react'), { recursive: true });
    expect(check()).toEqual(['dist/styles.css missing']);
    react('body{}');
    expect(check()).toEqual(['dist/styles.css has no .nc- rule']);
  });
});

describe('run', () => {
  it('runs the package checks by default and by name', () => {
    goodBuild();
    expect(run([], root)).toEqual([]);
    expect(run(['package'], root)).toEqual([]);
    rmSync(join(root, 'dist/styles.css'));
    expect(run([], root)).toContain('dist/styles.css missing');
    // Three runs of the package checks scan the fixture build, which took about 6 s on a lightly loaded
    // machine, over vitest's 5 s default, so this test carries its own limit.
  }, 30_000);

  it('runs the example-bundle check in the directory it is given', () => {
    mkdirSync(join(root, 'examples/app/.next/static'), { recursive: true });
    expect(run(['example-bundle', 'examples/app'], root)).toEqual(['dist/styles.css missing']);
  });

  it('names a mode it does not know', () => {
    expect(run(['nonsense'], root)).toEqual(['unknown mode: nonsense']);
  });
});

describe('the command line', () => {
  const script = join(import.meta.dirname, 'check-react-dist.ts');

  it('exits 0 for a good build and 1 with the problems on stderr for a bad one', () => {
    goodBuild();
    const ok = spawnSync('bun', [script], { cwd: root, encoding: 'utf8' });
    expect([ok.status, ok.stderr]).toEqual([0, '']);
    rmSync(join(root, 'dist/styles.css'));
    const bad = spawnSync('bun', [script], { cwd: root, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('check-react-dist: dist/styles.css missing');
  });
});

describe('checkProbeCoverage', () => {
  it('accepts declarations whose hooks and components are all probed', () => {
    goodBuild();
    write(
      'dist/approvals.d.ts',
      [
        'export declare const MODULE_ID = "approvals";',
        "export type { Approval } from './t.js';",
        "export { createApprovalsStore } from './s.js';",
        "export { useApprovals } from './a.js';",
        "export { useApprovalRequest } from './b.js';",
        "export { Approvals } from './c.js';",
        "export { ApprovalRequest } from './d.js';",
      ].join('\n')
    );
    expect(checkProbeCoverage(root)).toEqual([]);
  });

  it('reports a new hook, a new component and a component of another probed entry', () => {
    goodBuild();
    write(
      'dist/approvals.d.ts',
      "export { useApprovals, useApprovalSummary } from './a.js';\nexport { ApprovalBadge as Badge } from './c.js';\nexport declare function ApprovalList(): null;"
    );
    write(
      'dist/action-status.d.ts',
      'export declare function ActionStatus(): null;\nexport declare function ActionStatusBadge(): null;\nexport declare function useActionHistory(): null;'
    );
    expect(checkProbeCoverage(root)).toEqual([
      'approvals.js exports the hook useApprovalSummary, which no headless probe covers',
      'approvals.js exports Badge, which no themeless probe covers',
      'approvals.js exports ApprovalList, which no themeless probe covers',
      'action-status.js exports the hook useActionHistory, which no headless probe covers',
      'action-status.js exports ActionStatusBadge, which no themeless probe covers',
    ]);
    expect(checkDist(root)).toHaveLength(5);
  });

  it('ignores a type export and a type-only list', () => {
    goodBuild();
    write('dist/approvals.d.ts', "export type { ApprovalBadge, useThing } from './t.js';");
    expect(checkProbeCoverage(root)).toEqual([]);
  });
});

describe('checkNoConverter', () => {
  it('accepts a build that names neither the converter nor the Cedar parser as a module', () => {
    goodBuild();
    write('dist/permissions.d.ts', '/** Loads `@noblecloak/policy-formats` (a dynamic import). */');
    expect(checkNoConverter(root)).toEqual([]);
  });

  it('reports a shipped file that imports the converter or the Cedar parser', () => {
    goodBuild();
    write('dist/chunk-a.js', "export const f = () => import('@noblecloak/policy-formats/import');");
    write('dist/permissions.d.ts', 'import type { X } from "@cedar-policy/cedar-wasm";');
    expect(checkNoConverter(root)).toEqual([
      'dist/chunk-a.js names @noblecloak/policy-formats',
      'dist/permissions.d.ts names @cedar-policy/cedar-wasm',
    ]);
  });

  it('reports a Permissions bundle that holds the Cedar parser, or no panel at all', () => {
    goodBuild();
    write(
      'dist/permissions.js',
      PERMISSIONS_JS.replace(
        'jsx(PolicyRoundTrip, {})',
        "jsx(PolicyRoundTrip, { parse: 'policySetTextToParts' })"
      )
    );
    expect(checkNoConverter(root)).toEqual([
      'an import of only Permissions bundles the Cedar parser',
    ]);
    write('dist/permissions.js', PERMISSIONS_JS.replaceAll('nc-permissions-roundtrip', 'nc-x'));
    expect(checkNoConverter(root)).toEqual([
      'an import of only Permissions holds no import/export panel (the probe is vacuous)',
    ]);
  });
});
