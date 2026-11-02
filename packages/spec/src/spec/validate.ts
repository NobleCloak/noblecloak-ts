/**
 * Validation against the document itself: the mock checks request bodies with it, the conformance
 * runner checks every response with it. One compiled copy of the document is the source of both.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { familyOf, featureOf } from './families.js';
import type { Family, Feature } from './families.js';
import { HTTP_METHODS, isObject, operationsOf } from './load.js';
import type { Json, JsonObject } from './load.js';

const SPEC_ID = 'urn:noblecloak:module-api';

/** One operation of the document, with the pieces the mock and the runner need. */
export interface OperationInfo {
  readonly operationId: string;
  readonly method: string;
  /** The path template, for example `/v1/approvals/{id}`. */
  readonly path: string;
  readonly deployment: 'both' | 'hosted';
  readonly entitlement: string | undefined;
  /** False for the routes that carry `security: []`. */
  readonly authenticated: boolean;
  /** The route family the operation belongs to; undefined for the floor. */
  readonly family: Family | undefined;
  /**
   * The feature that serves the operation within its family (`x-noblecloak-feature`), when one does: a
   * deployment that serves the family and does not advertise the feature does not serve the operation.
   */
  readonly feature: Feature | undefined;
  readonly operation: JsonObject;
}

/** The `$ref` target of `node` when it is a reference into the document, else `node`. */
function deref(doc: JsonObject, node: Json | undefined): JsonObject | undefined {
  let current = node;
  for (let hops = 0; hops < 8 && isObject(current) && typeof current.$ref === 'string'; hops++) {
    let target: Json = doc;
    for (const raw of current.$ref.slice(2).split('/')) {
      const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!isObject(target)) return undefined;
      target = target[segment] as Json;
    }
    current = target;
  }
  return isObject(current) ? current : undefined;
}

/** A compiled view of a document. */
export class SpecIndex {
  readonly doc: JsonObject;
  readonly operations: readonly OperationInfo[];
  readonly #ajv: Ajv2020;
  readonly #compiled = new Map<string, ValidateFunction>();
  readonly #matchers: { info: OperationInfo; regex: RegExp; literals: number }[];

  /**
   * `rejectUndeclared` makes every object schema that lists `properties` and says nothing about
   * `additionalProperties` closed, so a response carrying a field the document does not declare fails
   * validation. Off by default: an additive field is
   * normally forward compatible.
   */
  constructor(doc: JsonObject, options: { readonly rejectUndeclared?: boolean } = {}) {
    this.doc = options.rejectUndeclared === true ? closeObjects(doc) : doc;
    this.#ajv = new Ajv2020({ strict: false, allErrors: true });
    (addFormats as unknown as (ajv: Ajv2020) => void)(this.#ajv);
    this.#ajv.addSchema(this.doc, SPEC_ID);
    this.operations = operationsOf(this.doc).map(([path, method, operation]) => ({
      operationId: typeof operation.operationId === 'string' ? operation.operationId : '',
      method,
      path,
      deployment: operation['x-noblecloak-deployment'] === 'hosted' ? 'hosted' : 'both',
      entitlement:
        typeof operation['x-noblecloak-entitlement'] === 'string'
          ? operation['x-noblecloak-entitlement']
          : undefined,
      authenticated: !(Array.isArray(operation.security) && operation.security.length === 0),
      family: familyOf(operation),
      feature: featureOf(operation),
      operation,
    }));
    this.#matchers = this.operations.map((info) => ({
      info,
      regex: new RegExp(
        `^${info.path
          .split(/\{[^}]+\}/)
          .map(escapeRegex)
          .join('[^/]+')}$`
      ),
      literals: info.path.replace(/\{[^}]+\}/g, '').length,
    }));
  }

  /** The operation a request line belongs to; the most specific template wins. */
  match(method: string, path: string): OperationInfo | undefined {
    const candidates = this.#matchers.filter(
      (m) => m.info.method === method.toLowerCase() && m.regex.test(path)
    );
    candidates.sort((a, b) => b.literals - a.literals);
    return candidates[0]?.info;
  }

  /** The named component schema, as a validator. */
  schema(name: string): ValidateFunction {
    return this.#compile({ $ref: `#/components/schemas/${name}` }, `schema:${name}`);
  }

  /** A validator for the request body of `info` with media type `contentType`, if it declares one. */
  requestBody(info: OperationInfo, contentType: string): ValidateFunction | undefined {
    const node = this.#mediaSchema(deref(this.doc, info.operation.requestBody), contentType);
    return node === undefined
      ? undefined
      : this.#compile(node, `request:${info.method} ${info.path}:${contentType}`);
  }

  /** The media types the request body of `info` accepts. */
  requestContentTypes(info: OperationInfo): string[] {
    const content = deref(this.doc, info.operation.requestBody)?.content;
    return isObject(content ?? null) ? Object.keys(content as JsonObject) : [];
  }

  /** The statuses `info` documents. */
  responseStatuses(info: OperationInfo): string[] {
    const responses = info.operation.responses;
    return isObject(responses ?? null) ? Object.keys(responses as JsonObject) : [];
  }

  /**
   * A validator for a response of `info`. `documented` is false when the status is not declared;
   * `validate` is undefined when it is declared without a body of that media type.
   */
  response(
    info: OperationInfo,
    status: number,
    contentType: string
  ): { documented: boolean; validate: ValidateFunction | undefined } {
    const responses = info.operation.responses;
    const declared = isObject(responses ?? null)
      ? (responses as JsonObject)[String(status)]
      : undefined;
    if (declared === undefined) return { documented: false, validate: undefined };
    const node = this.#mediaSchema(deref(this.doc, declared), contentType);
    return {
      documented: true,
      validate:
        node === undefined
          ? undefined
          : this.#compile(
              node,
              `response:${info.method} ${info.path}:${String(status)}:${contentType}`
            ),
    };
  }

  #mediaSchema(holder: JsonObject | undefined, contentType: string): Json | undefined {
    const content = holder?.content;
    if (!isObject(content ?? null)) return undefined;
    const media = (content as JsonObject)[contentType];
    return isObject(media ?? null) ? (media as JsonObject).schema : undefined;
  }

  /** Compiles a schema node of the document; its local `$ref`s point back into the document. */
  #compile(node: Json, key: string): ValidateFunction {
    const cached = this.#compiled.get(key);
    if (cached !== undefined) return cached;
    const validate = this.#ajv.compile(absolutize(node) as object);
    this.#compiled.set(key, validate);
    return validate;
  }
}

// A `not` declares no member, so the node stays closed.
const COMPOSITION = ['allOf', 'oneOf', 'anyOf', 'if', 'then', 'else', '$ref'];

/** A copy of the schema `node` with `additionalProperties: false` added where it is silent. */
function closeSchema(node: Json): Json {
  if (!isObject(node)) return node;
  const out: Record<string, Json> = { ...node };
  const properties = node.properties;
  if (isObject(properties)) {
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [name, closeSchema(child)])
    );
    if (!('additionalProperties' in node) && !COMPOSITION.some((key) => key in node)) {
      out.additionalProperties = false;
    }
  }
  if (isObject(node.additionalProperties))
    out.additionalProperties = closeSchema(node.additionalProperties);
  if (node.items !== undefined) out.items = closeSchema(node.items);
  for (const key of ['allOf', 'oneOf', 'anyOf', 'prefixItems']) {
    const list = node[key];
    if (Array.isArray(list)) out[key] = list.map(closeSchema);
  }
  return out;
}

/**
 * A copy of `doc` with its schemas closed (see `rejectUndeclared`). Schemas are reached through
 * `components.schemas` and every `schema` member of a media type, never by guessing at key names.
 */
function closeObjects(doc: JsonObject): JsonObject {
  const walk = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        key === 'schema' && isObject(value) ? closeSchema(value) : walk(value),
      ])
    );
  };
  const closed = walk(doc) as Record<string, Json>;
  const components = closed.components;
  if (isObject(components) && isObject(components.schemas)) {
    closed.components = {
      ...components,
      schemas: Object.fromEntries(
        Object.entries(components.schemas).map(([name, schema]) => [name, closeSchema(schema)])
      ),
    };
  }
  return closed;
}

/** A copy of `node` whose `#/...` references name the document, so it compiles on its own. */
function absolutize(node: Json): Json {
  if (Array.isArray(node)) return node.map(absolutize);
  if (!isObject(node)) return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      key === '$ref' && typeof value === 'string' && value.startsWith('#/')
        ? `${SPEC_ID}${value}`
        : absolutize(value),
    ])
  );
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A short text for the first few validation errors. */
export function describeErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .slice(0, 4)
    .map((e) => `${e.instancePath === '' ? '(body)' : e.instancePath} ${e.message ?? 'is invalid'}`)
    .join('; ');
}

export { HTTP_METHODS };
