import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import * as api from './index.js';

const read = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

describe('package', () => {
  it('has no runtime dependencies of any kind', async () => {
    const pkg = await read('package.json');
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
    expect(pkg.private).toBeUndefined();
    // The version is Changesets' to set (0.0.0 at birth, bumped by the version PR); pin only its shape.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it('typechecks and builds without the DOM library or runtime type packages', async () => {
    const tsconfig = await read('tsconfig.json');
    expect((tsconfig.compilerOptions as { lib: string[] }).lib).toEqual(['ES2022']);
    const build = await read('tsconfig.build.json');
    expect((build.compilerOptions as { types: string[] }).types).toEqual([]);
  });

  it('exports exactly the rule', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'FORKS',
        'GITHUB_ERROR_CODES',
        'NO_ARRIVAL',
        'SETUP_INTENTS',
        'SETUP_STEP_KEYS',
        'STEP_AVAILABILITIES',
        'STEP_STATES',
        'WIZARD_EVENT_STEP_KEYS',
        'WIZARD_STEPS',
        'WIZARD_STEP_IDS',
        'agentCredentials',
        'firstRunComplete',
        'firstUnfinished',
        'inferFork',
        'isSetupStepKey',
        'resolveInitialStep',
        'resolveWizardStart',
        'scanShown',
        'setupProgress',
        'toolsConnected',
        'wizardStepIds',
        'wizardSteps',
      ].sort()
    );
  });
});
