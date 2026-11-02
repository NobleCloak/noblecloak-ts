import { readFileSync } from 'node:fs';

import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { lintDocument, lintSpec, TENANCY_SENTENCE } from './lint.js';
import type { LintFinding } from './lint.js';
import type { JsonObject } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';
import { obj, str } from './testing.js';

const source = readFileSync(PUBLIC_SOURCE(), 'utf8');

/** Findings of `code` after `mutate` is applied to a parsed copy of the document. */
async function brokenFindings(
  mutate: (doc: JsonObject) => void,
  code: string
): Promise<LintFinding[]> {
  const doc = parse(source) as JsonObject;
  mutate(doc);
  const mutated = stringify(doc, { lineWidth: 0 });
  expect(mutated, 'the mutation must change the document').not.toBe(
    stringify(parse(source), { lineWidth: 0 })
  );
  return (await lintDocument(mutated)).filter((f) => f.code === code);
}

async function broken(mutate: (doc: JsonObject) => void, code: string): Promise<string[]> {
  return (await brokenFindings(mutate, code)).map((f) => f.path);
}

/** The operation `method` of `path` in `doc`. */
const op = (doc: JsonObject, path: string, method: string): JsonObject =>
  obj(obj(obj(doc.paths, 'paths')[path], path)[method], `${method} ${path}`);

/** The first response component whose problem types are exactly `[type]`. */
const responseListing = (doc: JsonObject, type: string): JsonObject => {
  const responses = obj(obj(doc.components, 'components').responses, 'responses');
  const found = Object.values(responses).find((r) => {
    const types = obj(r)['x-noblecloak-problem-types'];
    return Array.isArray(types) && types.length === 1 && types[0] === type;
  });
  return obj(found, `a response listing only ${type}`);
};

describe('spec:lint', () => {
  it('passes on the document as committed', async () => {
    const errors = (await lintSpec()).filter((f) => f.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('rejects an operation with no deployment tag', async () => {
    const paths = await broken((doc) => {
      delete op(doc, '/.well-known/jwks.json', 'get')['x-noblecloak-deployment'];
    }, 'nc-operation-deployment');
    expect(paths).toEqual(['paths./.well-known/jwks.json.get']);
  });

  it('rejects a deployment tag outside both | hosted', async () => {
    const paths = await broken((doc) => {
      op(doc, '/v1/capabilities', 'get')['x-noblecloak-deployment'] = 'edge';
    }, 'nc-operation-deployment');
    expect(paths).toEqual(['paths./v1/capabilities.get']);
  });

  it('rejects a 4xx response with no problem types', async () => {
    const paths = await broken((doc) => {
      delete responseListing(doc, 'not_found')['x-noblecloak-problem-types'];
    }, 'nc-4xx-problem-type');
    expect(paths.length).toBeGreaterThan(0);
  });

  it('rejects a problem type that is not in the registry', async () => {
    const paths = await broken((doc) => {
      responseListing(doc, 'not_found')['x-noblecloak-problem-types'] = ['not_a_registered_type'];
    }, 'nc-4xx-problem-type');
    expect(paths.length).toBeGreaterThan(0);
  });

  it('rejects a write route without the tenancy sentence', async () => {
    const paths = await broken((doc) => {
      const post = op(doc, '/v1/tools', 'post');
      post.description = str(post.description).replace(TENANCY_SENTENCE, 'Trust the body.');
    }, 'nc-write-tenancy-sentence');
    expect(paths).toEqual(['paths./v1/tools.post.description']);
  });

  it('rejects a $ref that resolves to nothing, naming where it is', async () => {
    const findings = await brokenFindings((doc) => {
      const schemas = obj(obj(doc.components, 'components').schemas, 'schemas');
      Object.assign(obj(obj(schemas.Approval, 'Approval').properties, 'properties'), {
        dangling: { $ref: '#/components/schemas/NoSuchSchema' },
      });
    }, 'nc-no-dangling-refs');
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining('/components/schemas/Approval/properties/dangling'),
    ]);
  });
});
