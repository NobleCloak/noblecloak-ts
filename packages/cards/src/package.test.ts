import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import * as api from './index.js';

const read = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

describe('package', () => {
  it('depends on the client alone, with no react, react-dom, DOM or jsdom', async () => {
    const pkg = await read('package.json');
    expect(pkg.dependencies).toEqual({ '@noblecloak/client': 'workspace:*' });
    const all = JSON.stringify([pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]);
    expect(all).not.toMatch(/react|jsdom|happy-dom|slack|teams|adaptivecards/iu);
    expect(pkg.private).toBeUndefined();
    // The version is Changesets' to set (0.0.0 at birth, bumped by the version PR); pin only its shape.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it('typechecks and builds without the DOM library or runtime type packages', async () => {
    const tsconfig = await read('tsconfig.json');
    const lib = (tsconfig.compilerOptions as { lib: string[] }).lib;
    expect(lib).toEqual(['ES2022']);
    const build = await read('tsconfig.build.json');
    expect((build.compilerOptions as { types: string[] }).types).toEqual([]);
  });

  it('runs its tests in node', async () => {
    const config = await readFile(new URL('../vitest.config.ts', import.meta.url), 'utf8');
    expect(config).toContain("environment: 'node'");
  });

  it('exports the names the next unit imports', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'CALL_MAX_DEPTH',
        'CALL_MAX_STRING',
        'CARD_DEGRADATIONS',
        'CARD_MODEL_VERSION',
        'CARD_TEXT',
        'CHAT_RESOLUTIONS',
        'SLACK_LIMITS',
        'TEAMS_LIMITS',
        'clickIntent',
        'encodeActionPayload',
        'findCardAction',
        'isResolveAction',
        'parseActionPayload',
        'parseExecuteData',
        'renderAdaptiveCard',
        'renderBlockKit',
        'toAdaptiveCard',
        'toApprovalCard',
        'toBlockKit',
      ].sort()
    );
    expect(api.SLACK_LIMITS.maxActions).toBe(10);
    expect(api.TEAMS_LIMITS.maxActions).toBe(5);
    expect(api.SLACK_LIMITS.messageBytes).toBe(40_000);
    expect(api.CARD_MODEL_VERSION).toBe(3);
    expect(api.CHAT_RESOLUTIONS).toEqual(['approved', 'rejected']);
  });
});
