import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scanSource } from './testing/deployment-branch-scan.js';
import type { ScanFinding, ScanRule } from './testing/deployment-branch-scan.js';

// The modules are written against the contract, so one build serves the hosted service and the mock. This
// scans every published source file for a branch on where it runs, and proves with positive controls that
// the scan sees one.

const SRC = fileURLToPath(new URL('.', import.meta.url));

function moduleSources(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'testing') files.push(...moduleSources(path));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
  }
  return files.sort();
}

/**
 * The reads of a host or an origin that are not a choice between deployments. Each names the file, the rule, how many
 * findings it covers and why. A count that no longer matches fails the test, so this list can neither go stale nor
 * quietly cover a second read in the same file.
 */
const ALLOWED: readonly { file: string; rule: ScanRule; count: number; why: string }[] = [
  {
    file: 'auth/issuer.ts',
    rule: 'host-property',
    count: 1,
    why: 'a token or a client registration is sent over https, or over http to localhost: a rule about the scheme, the same for every deployment',
  },
  {
    file: 'auth/issuer.ts',
    rule: 'host-comparison',
    count: 1,
    why: 'the localhost half of the same scheme rule',
  },
  {
    file: 'auth/browser-auth.ts',
    rule: 'origin-comparison',
    count: 4,
    why: 'two origins the caller supplied are compared with each other (resource, redirect URI, issuer and its endpoints): a same-origin check, the same for every deployment',
  },
  {
    file: 'connections-parse.ts',
    rule: 'host-property',
    count: 1,
    why: 'an authorization URL is followed over https, or over http to this machine only: a rule about the scheme, the same for every deployment',
  },
  {
    file: 'auth/return-to.ts',
    rule: 'origin-comparison',
    count: 1,
    why: 'a return path is kept only when it stays on the application origin the caller supplied',
  },
];

const key = (f: Pick<ScanFinding, 'file' | 'rule'>): string => `${f.file}|${f.rule}`;

describe('no module source branches on the deployment', () => {
  const findings = moduleSources(SRC).flatMap((path) =>
    scanSource(relative(SRC, path), readFileSync(path, 'utf8'))
  );
  const allowed = new Set(ALLOWED.map(key));

  it('scans the module sources it should', () => {
    const files = moduleSources(SRC).map((p) => relative(SRC, p));
    expect(files).toContain('action-status-store.ts');
    expect(files).toContain('use-action-status.ts');
    expect(files).toContain('approvals-store.ts');
    expect(files).toContain('components/ActionStatus.tsx');
    expect(files).toContain('permissions-store.ts');
    expect(files).toContain('permissions-errors.ts');
    expect(files).toContain('components/Permissions.tsx');
    expect(files).toContain('components/permissions-labels.ts');
    expect(files).toContain('connections-store.ts');
    expect(files).toContain('connections-parse.ts');
    expect(files).toContain('components/Connections.tsx');
    expect(files).toContain('components/connections-labels.ts');
    expect(files).not.toContain('testing/approval-fixture.ts');
  });

  it('finds no hosted-versus-mock conditional and no host sniffing', () => {
    const unexpected = findings.filter((f) => !allowed.has(key(f)));
    expect(unexpected).toEqual([]);
  });

  it.each(ALLOWED)('allows exactly $count of $rule in $file', ({ file, rule, count }) => {
    expect(findings.filter((f) => f.file === file && f.rule === rule)).toHaveLength(count);
  });
});

// The react module reaches the service through `@noblecloak/client` (`approvals-exec.ts` calls its `createClient`), so
// the client's published sources are held to the same rule. `schema.ts` is generated from the contract and is not scanned.
const CLIENT_SRC = fileURLToPath(new URL('../../client/src/', import.meta.url));
const CLIENT_ALLOWED: readonly { file: string; rule: ScanRule; count: number; why: string }[] = [
  {
    file: 'service-principal-credential.ts',
    rule: 'host-property',
    count: 1,
    why: 'a credential URL must be https, or http to loopback: the scheme rule, the same for every deployment',
  },
  {
    file: 'service-principal-token.ts',
    rule: 'host-comparison',
    count: 1,
    why: 'an opaque origin ("null") is not an origin: the audience is refused for having no origin, not for which one',
  },
  {
    file: 'service-principal-token.ts',
    rule: 'origin-comparison',
    count: 1,
    why: 'the same check as above, seen by the origin rule',
  },
];

describe('the client the module sends through branches on no deployment either', () => {
  const files = readdirSync(CLIENT_SRC)
    .filter((n) => n.endsWith('.ts') && !/\.test(-support)?\.ts$/.test(n) && n !== 'schema.ts')
    .sort();
  const findings = files.flatMap((n) => scanSource(n, readFileSync(join(CLIENT_SRC, n), 'utf8')));

  it('scans the client sources it should', () => {
    expect(files).toContain('client.ts');
    expect(files).toContain('service-principal-token.ts');
    expect(files).not.toContain('schema.ts');
  });

  it('finds nothing beyond the allowed scheme and origin checks, and exactly those', () => {
    const counted = CLIENT_ALLOWED.map((a) => ({
      file: a.file,
      rule: a.rule,
      count: findings.filter((f) => f.file === a.file && f.rule === a.rule).length,
    }));
    expect(counted).toEqual(CLIENT_ALLOWED.map(({ file, rule, count }) => ({ file, rule, count })));
    const allowedKeys = new Set(CLIENT_ALLOWED.map(key));
    expect(findings.filter((f) => !allowedKeys.has(key(f)))).toEqual([]);
  });
});

describe('the scan, with positive controls', () => {
  const rules = (source: string): ScanRule[] => scanSource('x.ts', source).map((f) => f.rule);

  it.each([
    [
      'a branch on the deployment marker',
      `if (meta.deployment === 'edge') run();`,
      'deployment-word',
    ],
    [
      'a branch on a flag named for the mock',
      `const isMock = url === 'x'; if (isMock) run();`,
      'deployment-word',
    ],
    [
      'the deployment header',
      `const h = response.headers.get('x-noblecloak-deployment');`,
      'deployment-word',
    ],
    ['a hosted literal', `const mode = 'hosted';`, 'deployment-word'],
    [
      'host sniffing by property',
      `if (new URL(baseUrl).hostname === 'a.test') run();`,
      'host-property',
    ],
    ['host sniffing by string test', `if (baseUrl.includes('beta')) run();`, 'host-string-test'],
    ['host sniffing by pattern', `if (/beta/.test(origin)) run();`, 'host-string-test'],
    [
      'an equality on a URL held in a name',
      `if (baseUrl === 'https://govern.beta.example') run();`,
      'host-comparison',
    ],
    [
      'an equality on a host literal',
      `if (new URL(baseUrl).host === 'govern.beta.example') run();`,
      'host-comparison',
    ],
    ['a comparison with localhost', `if (name === 'localhost') run();`, 'host-comparison'],
    [
      'an origin compared with a constant',
      `if (new URL(baseUrl).origin === OTHER) run();`,
      'origin-comparison',
    ],
    [
      'an href compared with a constant',
      `if (location.href !== OTHER) run();`,
      'origin-comparison',
    ],
    [
      'a destructured hostname',
      `const { hostname } = new URL(baseUrl); run(hostname);`,
      'host-property',
    ],
    [
      'a renamed destructured host',
      `const { host: h } = new URL(baseUrl); run(h);`,
      'host-property',
    ],
    ['an element access on hostname', `if (u['hostname']) run();`, 'host-property'],
    [
      'a string test on a receiver named url',
      `if (url.endsWith('.beta.test')) run();`,
      'host-string-test',
    ],
  ] as const)('flags %s', (_name, source, rule) => {
    expect(rules(source)).toContain(rule);
  });

  it('flags a template that names the mock', () => {
    expect(rules('const url = `${base}/mock/tokens`;')).toContain('deployment-word');
  });

  it('flags the same code in a tsx file', () => {
    const found = scanSource('x.tsx', `const a = <p>{meta.deployment}</p>;`);
    expect(found.map((f) => f.rule)).toContain('deployment-word');
  });

  it('passes code that reads only the contract, and ignores comments', () => {
    const clean = `
      // hosted and mock services answer the same way; the code does not ask which one it is talking to
      /** The mock of the contract states on_deny; a hosted service may omit it. */
      export function onDenyOf(a: { on_deny?: string }): string {
        return a.on_deny === 'resume' || a.on_deny === 'halt' ? a.on_deny : 'not_stated';
      }
      export const url = (baseUrl: string): string => baseUrl.replace(/\\/+$/, '');
    `;
    expect(scanSource('clean.ts', clean)).toEqual([]);
  });

  it('does not flag a switch on an event name', () => {
    expect(
      scanSource('clean.ts', `switch (item.event) { case 'approval.updated': run(); }`)
    ).toEqual([]);
  });

  it('does not flag a comparison of a scheme, a type or an event name', () => {
    const clean = `
      if (url.protocol === 'https:') run();
      if (typeof body.token_endpoint !== 'string') run();
      if (item.event !== 'approval.updated') run();
    `;
    expect(scanSource('clean.ts', clean)).toEqual([]);
  });

  it('reports the line of a finding', () => {
    const found = scanSource('x.ts', `const a = 1;\nconst b = 2;\nconst isHosted = true;\n`);
    expect(found[0]).toMatchObject({ file: 'x.ts', line: 3, rule: 'deployment-word' });
  });
});
