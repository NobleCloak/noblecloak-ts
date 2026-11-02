/**
 * `bun run spec:lint`: Spectral over the document, with the project's own rules on top of the OpenAPI
 * ruleset.
 *
 * - every operation names where it is served (`x-noblecloak-deployment: both | hosted`);
 * - every internal `$ref` resolves;
 * - every 4xx response is a problem document that names the problem types it can carry, each of
 *   which is in the registry at `info.x-noblecloak-problem-types`;
 * - every write route's description carries the tenancy sentence.
 */
import { readFileSync } from 'node:fs';

import { Document, Spectral } from '@stoplight/spectral-core';
import type { IFunctionResult, RulesetDefinition } from '@stoplight/spectral-core';
import * as Parsers from '@stoplight/spectral-parsers';
import { oas } from '@stoplight/spectral-rulesets';
import { isObject } from './load.js';
import type { Json } from './load.js';
import { PUBLIC_SOURCE } from './paths.js';
import { findDanglingRefs } from './refs.js';

/** The sentence every write route's description carries. */
export const TENANCY_SENTENCE =
  'Nothing identifying the organisation, principal or scope is accepted from the request body; it comes from the verified token.';

const DEPLOYMENTS = ['both', 'hosted'];

type RuleFunction = (
  value: unknown,
  options: null,
  context: { path: (string | number)[]; document: { data: unknown } }
) => IFunctionResult[] | undefined;

const deploymentTag: RuleFunction = (value, _options, context) => {
  const tag = isObject(value as Json)
    ? (value as Record<string, Json>)['x-noblecloak-deployment']
    : undefined;
  if (typeof tag === 'string' && DEPLOYMENTS.includes(tag)) return undefined;
  return [
    {
      message: 'Operation must set x-noblecloak-deployment to "both" or "hosted".',
      path: [...context.path],
    },
  ];
};

const danglingRefs: RuleFunction = (_value, _options, context) => {
  // `document.data` is the parsed document before `$ref` resolution, which is what shows a dangling ref.
  const raw = context.document.data as Json;
  if (!isObject(raw)) return undefined;
  return findDanglingRefs(raw).map((d) => ({
    message: `${d.ref}, referenced at ${d.at}, resolves to nothing in this document.`,
    path: d.at.split('/').slice(1),
  }));
};

const problemTypes: RuleFunction = (value, _options, context) => {
  const response = value as Record<string, Json> | undefined;
  const results: IFunctionResult[] = [];
  const content = response?.content;
  if (
    !isObject(content ?? null) ||
    !('application/problem+json' in (content as Record<string, Json>))
  ) {
    results.push({
      message: 'A 4xx response must be application/problem+json.',
      path: [...context.path],
    });
  }
  const types = response?.['x-noblecloak-problem-types'];
  if (!Array.isArray(types) || types.length === 0) {
    results.push({
      message:
        'A 4xx response must list the problem types it can carry in x-noblecloak-problem-types.',
      path: [...context.path],
    });
    return results;
  }
  const data = context.document.data as Record<string, Json>;
  const info = data.info;
  const registry = isObject(info ?? null)
    ? (info as Record<string, Json>)['x-noblecloak-problem-types']
    : undefined;
  for (const type of types) {
    if (
      typeof type !== 'string' ||
      !isObject(registry ?? null) ||
      !(type in (registry as Record<string, Json>))
    ) {
      results.push({
        message: `Problem type ${JSON.stringify(type)} is not in info.x-noblecloak-problem-types.`,
        path: [...context.path],
      });
    }
  }
  return results;
};

const tenancySentence: RuleFunction = (value, _options, context) => {
  const description = isObject(value as Json)
    ? (value as Record<string, Json>).description
    : undefined;
  if (
    typeof description === 'string' &&
    description.replace(/\s+/g, ' ').includes(TENANCY_SENTENCE)
  ) {
    return undefined;
  }
  return [
    {
      message: `A write route's description must contain: "${TENANCY_SENTENCE}"`,
      path: [...context.path, 'description'],
    },
  ];
};

/** The project's ruleset: the OpenAPI recommended rules plus the contract rules. */
export const ruleset: RulesetDefinition = {
  extends: [[oas as RulesetDefinition, 'recommended']],
  rules: {
    // Descriptions of operations and tags are required by this contract, not merely recommended.
    'operation-description': 'error',
    'nc-operation-deployment': {
      description: 'Every operation is tagged with where it is served.',
      message: '{{error}}',
      severity: 'error',
      given: '$.paths[*][get,put,post,delete,patch]',
      then: { function: deploymentTag },
    },
    'nc-no-dangling-refs': {
      description: 'Every internal $ref of the document resolves.',
      message: '{{error}}',
      severity: 'error',
      given: '$',
      then: { function: danglingRefs },
    },
    'nc-4xx-problem-type': {
      description: 'Every 4xx response documents a problem type.',
      message: '{{error}}',
      severity: 'error',
      given: '$.paths[*][get,put,post,delete,patch].responses[?(@property.match(/^4/))]',
      then: { function: problemTypes },
    },
    'nc-write-tenancy-sentence': {
      description: "Every write route's description contains the tenancy sentence.",
      message: '{{error}}',
      severity: 'error',
      given: '$.paths[*][put,post,delete,patch]',
      then: { function: tenancySentence },
    },
  },
};

export interface LintFinding {
  readonly code: string;
  readonly severity: 'error' | 'warn' | 'info' | 'hint';
  readonly message: string;
  readonly path: string;
}

const SEVERITY = ['error', 'warn', 'info', 'hint'] as const;

async function run(text: string, source: string): Promise<LintFinding[]> {
  const spectral = new Spectral();
  spectral.setRuleset(ruleset);
  const results = await spectral.run(new Document(text, Parsers.Yaml, source));
  return results.map((r) => ({
    code: String(r.code),
    severity: SEVERITY[r.severity],
    message: r.message,
    path: r.path.join('.'),
  }));
}

/** Lints the document at `path` and returns every finding. */
export function lintSpec(path: string = PUBLIC_SOURCE()): Promise<LintFinding[]> {
  return run(readFileSync(path, 'utf8'), path);
}

/** Lints document text as if it were the document at `source` (for tests that break it on purpose). */
export function lintDocument(
  text: string,
  source: string = PUBLIC_SOURCE()
): Promise<LintFinding[]> {
  return run(text, source);
}
