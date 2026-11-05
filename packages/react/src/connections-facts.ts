/**
 * Fact bindings of a tool (contract rev 16, `Tool.facts`), as the tool facts editor holds and checks them. Pure: no
 * timers, no network, no storage. The checks mirror the rules the service enforces, so a mistake is shown beside its
 * row before anything is sent; the service still decides, and a 400 it answers is mapped back to a row by
 * `factRowOfMember`.
 */

/** The JSON types a fact can have. `count`: the fact's value is the length of the array at `path`. */
export const FACT_TYPES = ['number', 'string', 'boolean', 'count'] as const;
export type FactType = (typeof FACT_TYPES)[number];

/** One binding: where in the arguments of a call the fact is read from, and the JSON type the value must have. */
export interface ToolFactBinding {
  readonly path: string;
  readonly type: FactType;
  readonly description?: string;
}

/** The facts of a tool, by name. */
export type ToolFacts = Readonly<Record<string, ToolFactBinding>>;

/** At most this many facts per tool. */
export const MAX_FACTS = 32;
/** A fact's description is at most this many characters. */
export const MAX_FACT_DESCRIPTION = 500;
/** A path is at most this many characters. */
export const MAX_FACT_PATH = 512;
/** A fact name: a lower-case letter, then up to 62 lower-case letters, digits or underscores. */
export const FACT_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/**
 * A path: one or more segments, each `.key` (`key` starts with a letter or `_` and holds letters, digits, `_` and
 * `-`) or `[N]` (a non-negative integer). Nothing that selects a set (`[*]`, `..key`) matches.
 */
export const FACT_PATH = /^(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])+$/;

export const isFactType = (value: unknown): value is FactType =>
  typeof value === 'string' && (FACT_TYPES as readonly string[]).includes(value);

/** One row of the editor: every field is the text the person typed. */
export interface FactRow {
  readonly name: string;
  readonly path: string;
  /** A `FactType`, or empty while the row is new. */
  readonly type: string;
  readonly description: string;
}

/** The rows of a tool's facts, in the order the service listed them. */
export function factRowsOf(facts: ToolFacts | undefined): FactRow[] {
  return Object.entries(facts ?? {}).map(([name, binding]) => ({
    name,
    path: binding.path,
    type: binding.type,
    description: binding.description ?? '',
  }));
}

export type FactField = 'name' | 'path' | 'type' | 'description';

/** Why a field is refused. A component says it in words. */
export type FactProblem =
  | 'name_invalid'
  | 'name_duplicate'
  | 'path_invalid'
  | 'type_missing'
  | 'description_too_long'
  | 'too_many';

export interface FactRowError {
  readonly row: number;
  readonly field: FactField;
  readonly problem: FactProblem;
}

export type FactsCheck =
  | { readonly ok: true; readonly facts: ToolFacts }
  | { readonly ok: false; readonly errors: readonly FactRowError[] };

/**
 * Checks the rows against the rules above and builds the map to send. A blank description is left out. Every
 * refusal is returned, not the first. More than `MAX_FACTS` rows is one `too_many` error on the first row over the
 * limit. No row at all is a valid, empty map: the caller sends `null` to clear the facts instead.
 */
export function checkFactRows(rows: readonly FactRow[]): FactsCheck {
  const errors: FactRowError[] = [];
  const firstOf = new Map<string, number>();
  rows.forEach((row, index) => {
    if (index === MAX_FACTS) errors.push({ row: index, field: 'name', problem: 'too_many' });
    if (!FACT_NAME.test(row.name))
      errors.push({ row: index, field: 'name', problem: 'name_invalid' });
    else if (firstOf.has(row.name))
      errors.push({ row: index, field: 'name', problem: 'name_duplicate' });
    else firstOf.set(row.name, index);
    if (!FACT_PATH.test(row.path) || row.path.length > MAX_FACT_PATH)
      errors.push({ row: index, field: 'path', problem: 'path_invalid' });
    if (!isFactType(row.type)) errors.push({ row: index, field: 'type', problem: 'type_missing' });
    if (row.description.length > MAX_FACT_DESCRIPTION)
      errors.push({ row: index, field: 'description', problem: 'description_too_long' });
  });
  if (errors.length > 0) return { ok: false, errors };
  const facts: Record<string, ToolFactBinding> = {};
  for (const row of rows) {
    facts[row.name] = {
      path: row.path,
      type: row.type as FactType,
      ...(row.description === '' ? {} : { description: row.description }),
    };
  }
  return { ok: true, facts };
}

/**
 * The row and field a refused member of the request body names (a 400's `member`, for example `facts.amount.path`),
 * or `undefined` when it names no row of `rows`. A member that names the fact alone (`facts.amount`) is its name field.
 */
export function factRowOfMember(
  member: string | undefined,
  rows: readonly FactRow[]
): { readonly row: number; readonly field: FactField } | undefined {
  const match =
    member === undefined ? null : /^facts\.([^.[\]]+)(?:\.(path|type|description))?$/.exec(member);
  if (match === null) return undefined;
  const row = rows.findIndex((candidate) => candidate.name === match[1]);
  if (row === -1) return undefined;
  const field = match[2];
  return {
    row,
    field: field === 'path' || field === 'type' || field === 'description' ? field : 'name',
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A tool's `facts` member: the map when every binding is readable, `undefined` when the member is absent (or `null`),
 * and `'unreadable'` when it is there and anything in it is not what the contract says. It is never read in part: a
 * write replaces the whole map, so a half-read one would lose the rest.
 */
export function toolFactsOf(value: unknown): ToolFacts | 'unreadable' | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return 'unreadable';
  const facts: Record<string, ToolFactBinding> = {};
  for (const [name, binding] of Object.entries(value)) {
    if (!isRecord(binding) || typeof binding.path !== 'string' || !isFactType(binding.type))
      return 'unreadable';
    if (binding.description !== undefined && typeof binding.description !== 'string')
      return 'unreadable';
    facts[name] = {
      path: binding.path,
      type: binding.type,
      ...(binding.description === undefined ? {} : { description: binding.description }),
    };
  }
  return facts;
}
