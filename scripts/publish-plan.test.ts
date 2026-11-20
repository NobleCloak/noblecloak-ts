import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasUnpublished, main } from './publish-plan.js';
import { NPMJS_REGISTRY } from './release.js';
import type { RegistryState } from './release.js';

let root = '';

const writePackage = (dir: string, manifest: Record<string, unknown>): void => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'publish-plan-'));
  writePackage('.', { name: 'root', private: true, workspaces: ['packages/*', 'tools'] });
  writePackage('packages/langgraph', { name: '@noblecloak/langgraph', version: '1.0.0' });
  writePackage('packages/other', { name: '@noblecloak/other', version: '0.1.0' });
  writePackage('tools', { name: '@noblecloak/tools', version: '0.0.0', private: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const has = (...versions: string[]): RegistryState => ({ kind: 'versions', versions });

describe('hasUnpublished', () => {
  const run = (entries: Record<string, RegistryState | Error>) => {
    const lines: string[] = [];
    const asked: string[] = [];
    const answer = hasUnpublished(
      root,
      (line) => lines.push(line),
      (name) => {
        asked.push(name);
        const entry = entries[name];
        if (entry === undefined) throw new Error(`unexpected lookup of ${name}`);
        if (entry instanceof Error) throw entry;
        return entry;
      }
    );
    return { answer, lines, asked };
  };

  it('is false when npm has every public package at its version, and asks about no private package', () => {
    const result = run({
      '@noblecloak/langgraph': has('0.9.0', '1.0.0'),
      '@noblecloak/other': has('0.1.0'),
    });
    expect(result.answer).toBe(false);
    expect(result.asked.sort()).toEqual(['@noblecloak/langgraph', '@noblecloak/other']);
    expect(result.lines.sort()).toEqual([
      '@noblecloak/langgraph@1.0.0 is on npm already.',
      '@noblecloak/other@0.1.0 is on npm already.',
    ]);
  });

  it('is true when npm lacks one package at its version', () => {
    const result = run({
      '@noblecloak/langgraph': has('0.9.0'),
      '@noblecloak/other': has('0.1.0'),
    });
    expect(result.answer).toBe(true);
    expect(result.lines).toContain('@noblecloak/langgraph@1.0.0 is not on npm.');
    expect(result.lines).toContain('@noblecloak/other@0.1.0 is on npm already.');
  });

  it('is true for a package npm has never seen, so the release script still checks its dependencies', () => {
    const result = run({
      '@noblecloak/langgraph': has('1.0.0'),
      '@noblecloak/other': { kind: 'not-found' },
    });
    expect(result.answer).toBe(true);
    expect(result.lines).toContain(
      '@noblecloak/other is not on npm at any version; the release script decides.'
    );
  });

  it('is true when a lookup fails, and still looks the other packages up', () => {
    const result = run({
      '@noblecloak/langgraph': new Error('npm view failed (exit 1): ETIMEDOUT'),
      '@noblecloak/other': has('0.1.0'),
    });
    expect(result.answer).toBe(true);
    expect(result.asked).toHaveLength(2);
    expect(result.lines).toContain(
      '::warning::could not look @noblecloak/langgraph up on npm (npm view failed (exit 1): ETIMEDOUT); the release script decides.'
    );
  });
});

describe('the publish-plan command line', () => {
  const runMain = (env: NodeJS.ProcessEnv, stdout: string) => {
    const lines: string[] = [];
    const views: string[][] = [];
    const appended: [string, string][] = [];
    const code = main(env, {
      cwd: root,
      out: (line) => lines.push(line),
      spawn: (args) => {
        views.push([...args]);
        return { status: 0, stdout, stderr: '' };
      },
      append: (file, text) => appended.push([file, text]),
    });
    return { code, lines, views, appended };
  };

  it('asks npm, by its registry flags, and appends the answer to GITHUB_OUTPUT', () => {
    const result = runMain({ GITHUB_OUTPUT: '/tmp/output' }, '["1.0.0","0.1.0"]');
    expect(result.code).toBe(0);
    expect(result.views).toContainEqual([
      'view',
      '@noblecloak/langgraph',
      'versions',
      '--json',
      '--registry',
      NPMJS_REGISTRY,
      `--@noblecloak:registry=${NPMJS_REGISTRY}`,
    ]);
    expect(result.lines.at(-1)).toBe('has_unpublished=false');
    expect(result.appended).toEqual([['/tmp/output', 'has_unpublished=false\n']]);
  });

  it('prints the answer and writes no file when GITHUB_OUTPUT is unset or empty', () => {
    for (const env of [{}, { GITHUB_OUTPUT: '' }]) {
      const result = runMain(env, '["0.0.1"]');
      expect(result.code).toBe(0);
      expect(result.lines.at(-1)).toBe('has_unpublished=true');
      expect(result.appended).toEqual([]);
    }
  });

  it('appends to the real file when no append is given', () => {
    const file = join(root, 'github-output');
    writeFileSync(file, 'earlier=1\n');
    const code = main(
      { GITHUB_OUTPUT: file },
      {
        cwd: root,
        out: () => undefined,
        spawn: () => ({ status: 0, stdout: '["1.0.0","0.1.0"]', stderr: '' }),
      }
    );
    expect(code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('earlier=1\nhas_unpublished=false\n');
  });
});
