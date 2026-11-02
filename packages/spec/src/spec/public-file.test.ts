import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PUBLIC_SOURCE } from './paths.js';
import { buildPublic } from './public-file.js';
import { findDanglingRefs } from './refs.js';
import { loadCommittedDocument } from './testing.js';

describe('build:public', () => {
  it('copies the committed document byte for byte', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'build-public-')), 'dist/openapi.public.yaml');
    expect(buildPublic(PUBLIC_SOURCE(), out)).toBe(out);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(PUBLIC_SOURCE(), 'utf8'));
  });

  it('refuses a document with a reference that resolves to nothing, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-public-'));
    const source = join(dir, 'openapi.public.yaml');
    writeFileSync(
      source,
      'openapi: 3.1.0\ncomponents:\n  schemas:\n    A: { $ref: "#/components/schemas/Missing" }\n'
    );
    const out = join(dir, 'dist/openapi.public.yaml');
    expect(() => buildPublic(source, out)).toThrow(
      /\/components\/schemas\/A -> #\/components\/schemas\/Missing/
    );
    expect(existsSync(out)).toBe(false);
  });
});

describe('findDanglingRefs', () => {
  it('finds none in the document, and reads an escaped pointer segment', () => {
    expect(findDanglingRefs(loadCommittedDocument())).toEqual([]);
    const doc = { paths: { '/a/b': { get: {} } }, x: { $ref: '#/paths/~1a~1b/get' } };
    expect(findDanglingRefs(doc)).toEqual([]);
    expect(findDanglingRefs({ x: [{ $ref: '#/nowhere' }] })).toEqual([
      { ref: '#/nowhere', at: '/x/0' },
    ]);
  });
});
