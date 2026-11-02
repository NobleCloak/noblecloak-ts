import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LookupError,
  fetchLatest,
  findLags,
  makeFetchJson,
  newestLts,
  readPins,
  requestHeaders,
  runCheck,
} from './check-toolchain.js';
import type { FetchJson } from './check-toolchain.js';

const DIGEST = 'a'.repeat(64);

let root: string;

function writeTree(packageManager: string, node: string, actionlint: string): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager }));
  writeFileSync(join(root, '.node-version'), `${node}\n`);
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(root, '.github/workflows/ci.yml'),
    `      - uses: docker://rhysd/actionlint@sha256:${DIGEST} # ${actionlint}\n`
  );
}

function registry(bun: string, nodeIndex: unknown, actionlint: string): FetchJson {
  return (url) => {
    if (url.includes('registry.npmjs.org/bun')) return Promise.resolve({ version: bun });
    if (url.includes('nodejs.org')) return Promise.resolve(nodeIndex);
    if (url.includes('rhysd/actionlint')) return Promise.resolve({ tag_name: `v${actionlint}` });
    return Promise.reject(new Error(`unexpected ${url}`));
  };
}

type NodeIndex = { version: string; lts: string | false }[];

const NODE_INDEX: NodeIndex = [
  { version: 'v25.3.0', lts: false },
  { version: 'v24.21.0', lts: 'Krypton' },
  { version: 'v22.30.0', lts: 'Jod' },
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'toolchain-fixture-'));
  writeTree('bun@1.4.2', '24.21.0', '1.7.12');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readPins', () => {
  it('reads bun, Node and actionlint from the tree', () => {
    expect(readPins(root)).toEqual({ bun: '1.4.2', node: '24.21.0', actionlint: '1.7.12' });
  });

  it('refuses a packageManager that is not an exact bun pin', () => {
    writeTree('bun@^1.4.2', '24.21.0', '1.7.12');
    expect(() => readPins(root)).toThrow(/packageManager/);
  });

  it('refuses a ci.yml without a versioned actionlint image', () => {
    writeTree('bun@1.4.2', '24.21.0', 'latest');
    expect(() => readPins(root)).toThrow(/actionlint/);
  });

  it('reads the pins of this repository', () => {
    expect(readPins(join(import.meta.dirname, '..'))).toEqual({
      bun: expect.stringMatching(/^\d+\.\d+\.\d+$/) as unknown,
      node: expect.stringMatching(/^\d+\.\d+\.\d+$/) as unknown,
      actionlint: expect.stringMatching(/^\d+\.\d+\.\d+$/) as unknown,
    });
  });
});

describe('newestLts', () => {
  it('skips Current releases and returns the newest LTS', () => {
    expect(newestLts(NODE_INDEX)).toBe('24.21.0');
  });

  it('throws when no release is LTS', () => {
    expect(() => newestLts([{ version: 'v25.0.0', lts: false }])).toThrow(/no LTS/);
  });
});

describe('findLags', () => {
  it('reports each pin that differs from the latest release', () => {
    const pins = { bun: '1.4.1', node: '24.21.0', actionlint: '1.7.11' };
    const latest = { bun: '1.4.2', node: '24.21.0', actionlint: '1.7.12' };
    expect(findLags(pins, latest).map((lag) => [lag.tool, lag.pinned, lag.latest])).toEqual([
      ['bun', '1.4.1', '1.4.2'],
      ['actionlint', '1.7.11', '1.7.12'],
    ]);
  });
});

describe('fetchLatest', () => {
  it('normalises the three registry answers', async () => {
    await expect(fetchLatest(registry('1.4.2', NODE_INDEX, '1.7.12'))).resolves.toEqual({
      bun: '1.4.2',
      node: '24.21.0',
      actionlint: '1.7.12',
    });
  });
});

describe('runCheck', () => {
  it('passes when every pin is current', async () => {
    const lines: string[] = [];
    const status = await runCheck(
      root,
      (l) => lines.push(l),
      registry('1.4.2', NODE_INDEX, '1.7.12')
    );
    expect(status).toBe(0);
    expect(lines).toEqual(['toolchain: bun, Node LTS and actionlint pins are current']);
  });

  it('fails with one error per stale pin, naming where it lives', async () => {
    const lines: string[] = [];
    const newerLts: NodeIndex = [{ version: 'v26.1.0', lts: 'Lithium' }, ...NODE_INDEX];
    const status = await runCheck(
      root,
      (l) => lines.push(l),
      registry('1.5.0', newerLts, '1.7.12')
    );
    expect(status).toBe(1);
    expect(lines).toEqual([
      '::error::bun is pinned to 1.4.2; latest is 1.5.0 (package.json packageManager)',
      '::error::node is pinned to 24.21.0; latest is 26.1.0 (.node-version)',
    ]);
  });
});

describe('lookups', () => {
  const GH = 'https://api.github.com/repos/rhysd/actionlint/releases/latest';

  it('sends GITHUB_TOKEN to api.github.com only', () => {
    const env = { GITHUB_TOKEN: 'ghs_x' };
    expect(requestHeaders(GH, env)).toEqual({
      accept: 'application/json',
      authorization: 'Bearer ghs_x',
    });
    expect(requestHeaders('https://registry.npmjs.org/bun/latest', env)).toEqual({
      accept: 'application/json',
    });
    expect(requestHeaders(GH, {})).toEqual({ accept: 'application/json' });
    expect(requestHeaders(GH, { GITHUB_TOKEN: '' })).toEqual({ accept: 'application/json' });
  });

  it('turns an HTTP failure or a network error into a LookupError', async () => {
    const seen: Record<string, string>[] = [];
    const get = makeFetchJson(
      (_url, init) => {
        seen.push(init.headers);
        return Promise.resolve(new Response('{}', { status: 403 }));
      },
      { GITHUB_TOKEN: 't' }
    );
    await expect(get(GH)).rejects.toThrow(new LookupError(`GET ${GH} failed: 403`));
    expect(seen[0]?.authorization).toBe('Bearer t');
    const offline = makeFetchJson(() => Promise.reject(new Error('ENOTFOUND')), {});
    await expect(offline(GH)).rejects.toBeInstanceOf(LookupError);
  });

  it('returns the parsed body on success', async () => {
    const get = makeFetchJson(() => Promise.resolve(Response.json({ tag_name: 'v1.7.12' })), {});
    await expect(get(GH)).resolves.toEqual({ tag_name: 'v1.7.12' });
  });

  it('reports a failed lookup with exit 2 and a message that is not a lag', async () => {
    const lines: string[] = [];
    const failing: FetchJson = (url) =>
      url.includes('api.github.com')
        ? Promise.reject(new LookupError(`GET ${url} failed: 403`))
        : registry('1.4.2', NODE_INDEX, '1.7.12')(url);
    expect(await runCheck(root, (l) => lines.push(l), failing)).toBe(2);
    expect(lines).toEqual([
      `::error::toolchain lookup failed, so no pin was checked (not a stale pin): GET ${GH} failed: 403`,
    ]);
  });

  it('rethrows an error that is not a lookup failure', async () => {
    const broken: FetchJson = () => Promise.resolve(null);
    await expect(runCheck(root, () => undefined, broken)).rejects.toThrow(TypeError);
  });
});
