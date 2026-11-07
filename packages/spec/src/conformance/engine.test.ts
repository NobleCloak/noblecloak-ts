import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { check, getPath, interpolate, runScenario, sameJson } from './engine.js';
import type { EngineDeps } from './engine.js';
import { loadCommittedDocument } from '../spec/testing.js';
import type { Family } from '../spec/families.js';
import { SpecIndex } from '../spec/validate.js';
import {
  assertGate,
  assertPredicates,
  assertRequires,
  assertRestrictions,
  loadScenarios,
} from './scenarios.js';
import { formatSkipWarning, unconfiguredSkips } from './run.js';
import { CONTINUATION_KINDS } from './types.js';
import type { ContinuationKind, Report, Scenario, ScenarioResult, Target } from './types.js';

describe('getPath', () => {
  const body = { data: { items: [{ id: 'a' }, { id: 'b' }], n: 1 } };

  it('walks objects and array indices', () => {
    expect(getPath(body, 'data.items.1.id')).toBe('b');
    expect(getPath(body, 'data.n')).toBe(1);
  });

  it('returns the whole value for $ and undefined for a missing path', () => {
    expect(getPath(body, '$')).toBe(body);
    expect(getPath(body, 'data.nope.deeper')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
  });
});

describe('check: member predicates', () => {
  const body = { data: [{ id: 'a' }, { id: 'b' }, 3, null] };
  const run = (predicate: Parameters<typeof check>[0]): string[] => {
    const failures: string[] = [];
    check(predicate, body, failures, 'step');
    return failures;
  };

  it('contains_where finds an element by one member, and fails when none has it', () => {
    expect(run({ path: 'data', contains_where: { key: 'id', equals: 'b' } })).toEqual([]);
    expect(run({ path: 'data', contains_where: { key: 'id', equals: 'z' } })).toHaveLength(1);
    expect(run({ path: 'nope', contains_where: { key: 'id', equals: 'a' } })).toHaveLength(1);
  });

  it('contains_members needs one element with every member, each the same JSON value in any member order', () => {
    const entries = {
      data: [
        { id: 'p1', subject: { type: 'role', id: 'member' }, result: 'ask' },
        { id: 'p2', subject: { id: 'policy_admin', type: 'role' }, result: 'deny' },
      ],
    };
    const runOn = (predicate: Parameters<typeof check>[0]): string[] => {
      const failures: string[] = [];
      check(predicate, entries, failures, 'step');
      return failures;
    };
    expect(
      runOn({
        path: 'data',
        contains_members: { id: 'p2', subject: { type: 'role', id: 'policy_admin' } },
      })
    ).toEqual([]);
    // Each member matches some element, but no one element has both.
    expect(
      runOn({
        path: 'data',
        contains_members: { id: 'p1', subject: { type: 'role', id: 'policy_admin' } },
      })
    ).toHaveLength(1);
    // A member the element lacks never matches.
    expect(runOn({ path: 'data', contains_members: { id: 'p1', source: 'default' } })).toHaveLength(
      1
    );
    expect(runOn({ path: 'nope', contains_members: { id: 'p1' } })).toHaveLength(1);
  });

  it('lacks_members (rev 11) passes only for an array with no element that has every member', () => {
    const data = {
      data: [{ id: 'p1', contributed: true }, { id: 'p2', contributed: false }, { id: 'p3' }],
    };
    const runOn = (predicate: Parameters<typeof check>[0]): string[] => {
      const failures: string[] = [];
      check(predicate, data, failures, 'step');
      return failures;
    };
    expect(runOn({ path: 'data', lacks_members: { id: 'p2', contributed: true } })).toEqual([]);
    expect(runOn({ path: 'data', lacks_members: { id: 'p3', contributed: true } })).toEqual([]);
    expect(runOn({ path: 'data', lacks_members: { id: 'p1', contributed: true } })).toHaveLength(1);
    // Not an array: absence cannot be shown.
    expect(runOn({ path: 'nope', lacks_members: { id: 'p1' } })).toHaveLength(1);
  });

  it('lacks_where passes only for an array with no such element', () => {
    expect(run({ path: 'data', lacks_where: { key: 'id', equals: 'z' } })).toEqual([]);
    expect(run({ path: 'data', lacks_where: { key: 'id', equals: 'a' } })).toHaveLength(1);
    // Not an array: absence cannot be shown, so it is a failure rather than a pass.
    expect(run({ path: 'nope', lacks_where: { key: 'id', equals: 'a' } })).toHaveLength(1);
  });

  it('lacks_where_matches (rev 13) passes only for an array with no element whose string member matches', () => {
    const data = {
      data: [
        { id: 'role:Everyone', display_name: 'All' },
        { id: 'r2', display_name: 'EVERYONE' },
        { id: 'r3', display_name: 'everyone else' },
        { id: 3 },
      ],
    };
    const runOn = (predicate: Parameters<typeof check>[0]): string[] => {
      const failures: string[] = [];
      check(predicate, data, failures, 'step');
      return failures;
    };
    const id = '(^|[:/])everyone$';
    expect(runOn({ path: 'data', lacks_where_matches: { key: 'id', matches: id } })).toEqual([]);
    expect(
      runOn({ path: 'data', lacks_where_matches: { key: 'id', matches: id, ignore_case: true } })
    ).toHaveLength(1);
    expect(
      runOn({
        path: 'data',
        lacks_where_matches: { key: 'display_name', matches: '^everyone$', ignore_case: true },
      })
    ).toHaveLength(1);
    expect(
      runOn({ path: 'data', lacks_where_matches: { key: 'display_name', matches: '^everyone$' } })
    ).toEqual([]);
    // Not an array: absence cannot be shown.
    expect(runOn({ path: 'nope', lacks_where_matches: { key: 'id', matches: id } })).toHaveLength(
      1
    );
  });
});

describe('check: differs_from', () => {
  const run = (predicate: Parameters<typeof check>[0], body: unknown): string[] => {
    const failures: string[] = [];
    check(predicate, body, failures, 'step');
    return failures;
  };

  it('passes when the member is absent or differs from the other path, and fails when it repeats it', () => {
    const named = { who: { id: 'user_a', display_name: 'A' } };
    expect(run({ path: 'who.display_name', differs_from: 'who.id' }, named)).toEqual([]);
    // Optional: a deployment that cannot name the principal omits the member, which is allowed.
    expect(
      run({ path: 'who.display_name', differs_from: 'who.id' }, { who: { id: 'user_a' } })
    ).toEqual([]);
    const repeated = { who: { id: 'user_a', display_name: 'user_a' } };
    expect(run({ path: 'who.display_name', differs_from: 'who.id' }, repeated)).toEqual([
      'step: who.display_name should not repeat who.id (got "user_a")',
    ]);
  });
});

describe('check: lacks', () => {
  const run = (predicate: Parameters<typeof check>[0], body: unknown): string[] => {
    const failures: string[] = [];
    check(predicate, body, failures, 'step');
    return failures;
  };

  it('passes for an array with no equal element and fails for one that has it', () => {
    const body = { features: ['runs', 'policies.publish'] };
    expect(run({ path: 'features', lacks: 'evidence' }, body)).toEqual([]);
    expect(run({ path: 'features', lacks: 'policies.publish' }, body)).toHaveLength(1);
  });

  it('is a failure, not a pass, when the value is not an array', () => {
    expect(run({ path: 'features', lacks: 'evidence' }, {})).toHaveLength(1);
    expect(run({ path: 'features', lacks: 'evidence' }, { features: 'evidence' })).toHaveLength(1);
  });
});

describe('check: equals_canonical', () => {
  const run = (expected: unknown, body: unknown): string[] => {
    const failures: string[] = [];
    check({ path: 'data.continuation', equals_canonical: expected }, body, failures, 'step');
    return failures;
  };
  const sent = { kind: 'langgraph', delivery: 'pull', correlation: { thread: 't', ns: '' } };

  it('passes for the same value with the members in another order, at any depth', () => {
    const reordered = { correlation: { ns: '', thread: 't' }, delivery: 'pull', kind: 'langgraph' };
    expect(run(sent, { data: { continuation: reordered } })).toEqual([]);
    expect(run(sent, { data: { continuation: sent } })).toEqual([]);
  });

  it('fails for a changed value, a changed nested value, a missing member and an extra one', () => {
    expect(run(sent, { data: { continuation: { ...sent, delivery: 'push' } } })).toHaveLength(1);
    expect(
      run(sent, { data: { continuation: { ...sent, correlation: { thread: 'u', ns: '' } } } })
    ).toHaveLength(1);
    expect(
      run(sent, { data: { continuation: { kind: 'langgraph', delivery: 'pull' } } })
    ).toHaveLength(1);
    expect(run(sent, { data: { continuation: { ...sent, extra: 1 } } })).toHaveLength(1);
  });

  it('fails, rather than passes, when the value is absent', () => {
    expect(run(sent, { data: {} })).toHaveLength(1);
  });

  it('keeps array order significant, as JCS does', () => {
    expect(run({ a: [1, 2] }, { data: { continuation: { a: [2, 1] } } })).toHaveLength(1);
  });

  it('is the one predicate that ignores member order: equals still fails on a reordered value', () => {
    const failures: string[] = [];
    const reordered = { delivery: 'pull', kind: 'langgraph', correlation: sent.correlation };
    check({ path: 'v', equals: sent }, { v: reordered }, failures, 'step');
    expect(failures).toHaveLength(1);
  });

  it('sameJson treats numbers as the JCS library does: one value, however spelled', () => {
    expect(sameJson(JSON.parse('{"n":1.0}'), JSON.parse('{"n":1}'))).toBe(true);
    expect(sameJson(JSON.parse('{"n":1e2}'), JSON.parse('{"n":100}'))).toBe(true);
    expect(sameJson(JSON.parse('{"n":1.50}'), JSON.parse('{"n":1.5}'))).toBe(true);
    expect(sameJson(JSON.parse('{"n":-0}'), JSON.parse('{"n":0}'))).toBe(true);
    expect(sameJson(JSON.parse('{"n":1e-7}'), JSON.parse('{"n":0.0000001}'))).toBe(true);
    // An integer beyond 2^53 is a number the JCS library refuses, so it is never the same as anything.
    expect(sameJson({ n: 1e21 }, { n: 1e21 })).toBe(false);
    expect(sameJson({ n: 1 }, { n: 2 })).toBe(false);
    expect(sameJson({ n: 1 }, { n: '1' })).toBe(false);
  });

  it('sameJson is false for a value that is not JSON, on either side', () => {
    expect(sameJson(undefined, undefined)).toBe(false);
    expect(sameJson({ n: Number.NaN }, { n: Number.NaN })).toBe(false);
    expect(sameJson({ f: () => 1 }, { f: () => 1 })).toBe(false);
  });
});

describe('check: scalar predicates', () => {
  const body = { s: 'abc-1', n: 3, list: [1, 2, 3], none: null };
  const run = (predicate: Parameters<typeof check>[0]): string[] => {
    const failures: string[] = [];
    check(predicate, body, failures, 'step');
    return failures;
  };

  it('equals and not_equals compare by value, including null', () => {
    expect(run({ path: 'n', equals: 3 })).toEqual([]);
    expect(run({ path: 'n', equals: 4 })).toHaveLength(1);
    expect(run({ path: 'none', equals: null })).toEqual([]);
    expect(run({ path: 'n', not_equals: 4 })).toEqual([]);
    expect(run({ path: 'n', not_equals: 3 })).toHaveLength(1);
  });

  it('exists is true for a present value and false for an absent one, either way', () => {
    expect(run({ path: 's', exists: true })).toEqual([]);
    expect(run({ path: 'nope', exists: true })).toHaveLength(1);
    expect(run({ path: 'nope', exists: false })).toEqual([]);
    expect(run({ path: 's', exists: false })).toHaveLength(1);
  });

  it('matches needs a string that fits the pattern', () => {
    expect(run({ path: 's', matches: '^abc-\\d$' })).toEqual([]);
    expect(run({ path: 's', matches: '^z' })).toHaveLength(1);
    expect(run({ path: 'n', matches: '3' })).toHaveLength(1);
  });

  it('in, length and contains', () => {
    expect(run({ path: 'n', in: [1, 3] })).toEqual([]);
    expect(run({ path: 'n', in: [1, 2] })).toHaveLength(1);
    expect(run({ path: 'list', length: 3 })).toEqual([]);
    expect(run({ path: 'list', length: 2 })).toHaveLength(1);
    expect(run({ path: 's', length: 5 })).toHaveLength(1);
    expect(run({ path: 'list', contains: 2 })).toEqual([]);
    expect(run({ path: 'list', contains: 9 })).toHaveLength(1);
    expect(run({ path: 's', contains: 'a' })).toHaveLength(1);
  });
});

describe('loading predicates', () => {
  const scenario = (predicate: unknown): Scenario =>
    ({
      id: 's',
      title: 't',
      tags: ['both'],
      steps: [
        {
          request: { method: 'GET', path: '/x' },
          expect: { status: 200, body: [predicate] },
        },
      ],
    }) as unknown as Scenario;

  it('refuses a predicate that checks nothing', () => {
    expect(() => {
      assertPredicates(scenario({ path: 'data' }), 'f.yaml');
    }).toThrow(/needs a path/);
    expect(() => {
      assertPredicates(scenario({ path: 'data', equls: 1 }), 'f.yaml');
    }).toThrow(/needs a path/);
    expect(() => {
      assertPredicates(scenario({ equals: 1 }), 'f.yaml');
    }).toThrow(/needs a path/);
  });

  it('accepts one with an operator, including a falsy one', () => {
    expect(() => {
      assertPredicates(scenario({ path: 'a', equals: null }), 'f.yaml');
    }).not.toThrow();
    expect(() => {
      assertPredicates(scenario({ path: 'a', exists: false }), 'f.yaml');
    }).not.toThrow();
  });

  it('is applied when a scenario file is loaded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-scn-'));
    try {
      writeFileSync(
        join(dir, 'a.yaml'),
        '- id: bad\n  title: t\n  tags: [both]\n  steps:\n    - request: { method: GET, path: /x }\n      expect: { status: 200, body: [{ path: data }] }\n'
      );
      expect(() => loadScenarios([dir])).toThrow(/a predicate needs a path/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('loading stream steps', () => {
  const during = [{ request: { method: 'POST', path: '/v1/decisions' }, expect: { status: 200 } }];
  const stream = (expectation: unknown, sub: unknown[] = during): Scenario =>
    ({
      id: 's',
      title: 't',
      tags: ['both'],
      steps: [
        { stream_events: { path: '/v1/approvals/stream', during: sub, expect: expectation } },
      ],
    }) as unknown as Scenario;

  it('refuses a delivered event whose predicate has an operator the engine does not know', () => {
    expect(() => {
      assertPredicates(
        stream({ delivers: [{ id: 'a', body: [{ path: 'continuation', equls: 1 }] }] }),
        'f.yaml'
      );
    }).toThrow(/a predicate needs a path/);
  });

  it('refuses a delivered event whose predicate has no path, or whose body is not a list', () => {
    expect(() => {
      assertPredicates(stream({ delivers: [{ id: 'a', body: [{ equals: 1 }] }] }), 'f.yaml');
    }).toThrow(/a predicate needs a path/);
    expect(() => {
      assertPredicates(
        stream({ delivers: [{ id: 'a', body: { path: 'x', equals: 1 } }] }),
        'f.yaml'
      );
    }).toThrow(/must be a list/);
  });

  it('refuses an every_event that is not true', () => {
    expect(() => {
      assertPredicates(
        stream({
          delivers: [{ id: 'a', every_event: false, body: [{ path: 'x', exists: false }] }],
        }),
        'f.yaml'
      );
    }).toThrow(/every_event must be true/);
  });

  it('refuses a predicate in a request run during the stream', () => {
    expect(() => {
      assertPredicates(
        stream({ delivers: ['a'] }, [
          {
            request: { method: 'GET', path: '/x' },
            expect: { status: 200, body: [{ path: 'data', equls: 1 }] },
          },
        ]),
        'f.yaml'
      );
    }).toThrow(/a predicate needs a path/);
  });

  it('refuses a stream step that expects neither a delivery nor an absence', () => {
    expect(() => {
      assertPredicates(stream({}), 'f.yaml');
    }).toThrow(/at least one of expect.delivers and expect.lacks/);
    expect(() => {
      assertPredicates(stream({ delivers: [], lacks: [] }), 'f.yaml');
    }).toThrow(/at least one of expect.delivers and expect.lacks/);
  });

  it('refuses an absence with nothing to show the stream works, and accepts it with a delivery or an explicit open', () => {
    expect(() => {
      assertPredicates(stream({ lacks: ['b'] }), 'f.yaml');
    }).toThrow(/lacks alone proves nothing/);
    expect(() => {
      assertPredicates(stream({ delivers: ['a'], lacks: ['b'] }), 'f.yaml');
    }).not.toThrow();
    expect(() => {
      assertPredicates(stream({ lacks: ['b'], open: true }), 'f.yaml');
    }).not.toThrow();
  });

  it('accepts a delivery with valid predicates, and a stream with no requests is still refused', () => {
    expect(() => {
      assertPredicates(
        stream({ delivers: [{ id: 'a', body: [{ path: 'continuation', exists: false }] }] }),
        'f.yaml'
      );
    }).not.toThrow();
    expect(() => {
      assertPredicates(stream({ delivers: ['a'] }, []), 'f.yaml');
    }).toThrow(/needs requests to run during/);
  });

  it('is applied when a scenario file is loaded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-scn-'));
    try {
      writeFileSync(
        join(dir, 'a.yaml'),
        "- id: bad\n  title: t\n  tags: [both]\n  steps:\n    - stream_events:\n        path: /v1/approvals/stream\n        during:\n          - request: { method: GET, path: /x }\n            expect: { status: 200 }\n        expect: { lacks: ['x'] }\n"
      );
      expect(() => loadScenarios([dir])).toThrow(/lacks alone proves nothing/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('interpolate', () => {
  const vars = { id: 'x1', n: 5, obj: { a: 1 } };

  it('keeps the type of a whole-string reference and stringifies an embedded one', () => {
    expect(interpolate('${n}', vars)).toBe(5);
    expect(interpolate('${obj}', vars)).toEqual({ a: 1 });
    expect(interpolate('/v1/${id}/n${n}', vars)).toBe('/v1/x1/n5');
  });

  it('refuses a name nothing bound, instead of writing "undefined" into a request', () => {
    expect(() => interpolate('/v1/approvals/${approval_id}', vars)).toThrow(
      /approval_id.*not bound/
    );
    expect(() => interpolate('${missing}', vars)).toThrow(/not bound/);
    expect(interpolate('${zero}', { zero: 0 })).toBe(0);
  });

  it('descends into arrays and objects and leaves other values alone', () => {
    expect(interpolate({ a: ['${id}', 2, true, null] }, vars)).toEqual({
      a: ['x1', 2, true, null],
    });
  });

  it('expands $repeat into that many interpolated copies of its item', () => {
    expect(interpolate({ list: { $repeat: 3, item: { id: '${id}' } } }, vars)).toEqual({
      list: [{ id: 'x1' }, { id: 'x1' }, { id: 'x1' }],
    });
    expect(interpolate({ $repeat: 0, item: 1 }, vars)).toEqual([]);
  });

  it('adds a literal to a bound number, and takes a $repeat count from a variable', () => {
    expect(interpolate('${n+1}', vars)).toBe(6);
    expect(interpolate({ $repeat: '${n+1}', item: 'x' }, vars)).toEqual(
      Array.from({ length: 6 }, () => 'x')
    );
    expect(() => interpolate('${id+1}', vars)).toThrow(/not bound/);
    expect(() => interpolate('${missing+1}', vars)).toThrow(/not bound/);
  });

  it('refuses a $repeat without a whole count and an item', () => {
    expect(() => interpolate({ $repeat: 'many', item: 1 }, vars)).toThrow(/count and an item/);
    expect(() => interpolate({ $repeat: 1.5, item: 1 }, vars)).toThrow(/count and an item/);
    expect(() => interpolate({ $repeat: -1, item: 1 }, vars)).toThrow(/count and an item/);
    expect(() => interpolate({ $repeat: 2 }, vars)).toThrow(/count and an item/);
  });
});

describe('runScenario', () => {
  const target: Target = {
    baseUrl: 'http://127.0.0.1:1',
    deployment: 'hosted',
    tokens: { creator: 't' },
    fixtures: { proxied_tool: 'a', allow_tool: 'b', deny_tool: 'c', default_tool: 'd' },
  };
  const deps = {
    target,
    index: undefined as never,
    advertised: new Set<Family>(['approvals']),
    exercised: new Set<string>(),
    corpus: [],
  } satisfies EngineDeps;
  const base = { id: 's', title: 't', tags: ['both'], steps: [] } satisfies Scenario;

  it('runs a scenario that needs admin only when an admin token was given, and one that merely acts as admin on the fallback', async () => {
    const needsAdmin = { ...base, needs: ['admin'] } satisfies Scenario;
    const absent = await runScenario(needsAdmin, deps);
    expect(absent.outcome).toBe('skipped');
    expect(absent.skipKind).toBe('unconfigured');
    expect(absent.skipReason).toMatch(/--admin-token/);
    // The creator token is not an admin token: `needs: admin` never falls back to it.
    const given = { ...deps, target: { ...target, tokens: { creator: 't', admin: 'a' } } };
    expect((await runScenario(needsAdmin, given)).skipKind).toBeUndefined();
    // `as: admin` without `needs: admin` is not skipped; it runs with the creator token (the connection fails here, so it fails, not skips).
    const acts = {
      ...base,
      steps: [{ as: 'admin', request: { method: 'GET', path: '/v1/tools' } }],
    } as unknown as Scenario;
    const ran = await runScenario(acts, deps);
    expect(ran.outcome).not.toBe('skipped');
    expect(ran.skipKind).toBeUndefined();
  });

  it('skips a scenario for the other deployment, one that needs a missing token, and one that needs clock control', async () => {
    expect((await runScenario({ ...base, only: 'edge' }, deps)).skipReason).toMatch(
      /only runs against edge/
    );
    expect((await runScenario({ ...base, needs: ['approver'] }, deps)).skipReason).toMatch(
      /no token for approver/
    );
    expect((await runScenario({ ...base, tags: ['needs-mock-control'] }, deps)).skipReason).toMatch(
      /clock control/
    );
  });

  it('skips a scenario whose family the deployment did not advertise, as a capability skip that is neither inapplicable nor unconfigured', async () => {
    const needsRuns = await runScenario({ ...base, requires: 'runs' }, deps);
    expect(needsRuns).toMatchObject({
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: 'the deployment does not advertise runs',
    });
    const both = await runScenario({ ...base, requires: ['approvals', 'webhooks'] }, deps);
    expect(both.skipKind).toBe('capability');
    expect(both.skipReason).toBe('the deployment does not advertise webhooks');
    // The capability check comes before the token check: a scenario for a family nobody serves is
    // not reported as "unconfigured".
    const tokens = await runScenario({ ...base, requires: 'runs', needs: ['entitled'] }, deps);
    expect(tokens.skipKind).toBe('capability');
    expect(unconfiguredSkips({ results: [needsRuns, both, tokens] } as unknown as Report)).toEqual(
      []
    );
  });

  it('skips a scenario whose feature the deployment did not advertise (rev 10) as a capability skip, before the token check', async () => {
    const needsRule = {
      ...base,
      features: ['approvals.rejected_duplicate'],
      needs: ['approver'],
    } satisfies Scenario;
    for (const features of [undefined, new Set(['policies', 'policies.publish'])]) {
      const skipped = await runScenario(needsRule, {
        ...deps,
        ...(features === undefined ? {} : { features }),
      });
      expect(skipped).toMatchObject({
        outcome: 'skipped',
        skipKind: 'capability',
        skipReason: 'the deployment does not advertise approvals.rejected_duplicate',
      });
    }
    // Advertised: the scenario goes on to the token check.
    const advertised = await runScenario(needsRule, {
      ...deps,
      features: new Set(['approvals.rejected_duplicate']),
    });
    expect(advertised.skipKind).toBe('unconfigured');
    // A name that is not a feature fails the scenario instead of skipping it.
    const typo = await runScenario(
      { ...base, features: ['policies'] } as unknown as Scenario,
      deps
    );
    expect(typo.outcome).toBe('failed');
    expect(typo.failures[0]).toMatch(/features \["policies"\]/);
  });

  it('skips a scenario about a restriction the deployment does not advertise (rev 6) as a capability skip, and runs it where it does', async () => {
    const restricted = {
      approval_arguments_max_bytes: 512,
      continuation_deliveries: ['pull', 'held'] as const,
      tool_registration: 'administrators' as const,
      resolutions: ['approved', 'rejected'],
    };
    const skipKind = async (
      scenario: Partial<Scenario>,
      restrictions?: typeof restricted
    ): Promise<unknown> =>
      (
        await runScenario(
          { ...base, ...scenario },
          { ...deps, ...(restrictions === undefined ? {} : { restrictions }) }
        )
      ).skipKind;
    // Nothing advertised: each is a capability skip, never unconfigured.
    expect(await skipKind({ advertises: ['approval_arguments_max_bytes'] })).toBe('capability');
    expect(await skipKind({ tool_registration: 'administrators' })).toBe('capability');
    expect(await skipKind({ unserved_delivery: 'push' })).toBe('capability');
    expect(await skipKind({ unserved_resolution: 'escalated' })).toBe('capability');
    // A scenario for an unrestricted deployment runs where the member is absent (`any`), and not where it is not.
    expect(await skipKind({ tool_registration: 'any' })).toBeUndefined();
    expect(await skipKind({ tool_registration: 'any' }, restricted)).toBe('capability');
    // Advertised, and the scenario is about it: it runs (an empty scenario then fails for having no steps).
    const ran = (s: Partial<Scenario>): Promise<unknown> =>
      runScenario({ ...base, ...s }, { ...deps, restrictions: restricted }).then(
        (r) => r.skipReason
      );
    expect(await ran({ advertises: ['approval_arguments_max_bytes'] })).toBeUndefined();
    expect(await ran({ unserved_delivery: 'push' })).toBeUndefined();
    expect(await ran({ unserved_resolution: 'escalated' })).toBeUndefined();
    // And the converse: a delivery or resolution the deployment serves does not run a scenario about its absence.
    expect(await skipKind({ unserved_delivery: 'pull' }, restricted)).toBe('capability');
    expect(await skipKind({ unserved_resolution: 'approved' }, restricted)).toBe('capability');
    // A scenario whose success needs a delivery or resolution is skipped where the deployment lacks it.
    expect(await skipKind({ serves_delivery: 'push' }, restricted)).toBe('capability');
    expect(await skipKind({ serves_delivery: 'pull' }, restricted)).toBeUndefined();
    expect(await skipKind({ serves_resolution: 'escalated' }, restricted)).toBe('capability');
    expect(await skipKind({ serves_resolution: 'approved' }, restricted)).toBeUndefined();
    // Where nothing is advertised the scenario that needs a delivery runs as before.
    expect(await skipKind({ serves_delivery: 'push' })).toBeUndefined();
  });

  it('skips a scenario whose continuation kind the deployment does not accept (rev 17), reading an absent continuation_kinds as the seven kinds of rev 16', async () => {
    const run = (
      scenario: Partial<Scenario>,
      kinds?: readonly ContinuationKind[]
    ): Promise<ScenarioResult> =>
      runScenario(
        { ...base, ...scenario },
        {
          ...deps,
          restrictions: {
            tool_registration: 'any',
            resolutions: ['approved'],
            ...(kinds === undefined ? {} : { continuation_kinds: kinds }),
          },
        }
      );
    const skipped = {
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: 'the deployment does not accept the claude_agent_sdk continuation kind',
    };
    // Advertised and listed: it runs (an empty scenario then fails for having no steps).
    expect(
      (await run({ serves_kind: 'claude_agent_sdk' }, [...CONTINUATION_KINDS])).skipReason
    ).toBeUndefined();
    // Advertised and not listed: a capability skip naming the kind.
    expect(await run({ serves_kind: 'claude_agent_sdk' }, ['adk', 'langgraph'])).toMatchObject(
      skipped
    );
    expect(await run({ serves_kind: 'langgraph' }, ['adk'])).toMatchObject({
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: 'the deployment does not accept the langgraph continuation kind',
    });
    // Absent: a rev 16 kind runs, and the kind rev 17 added is a capability skip.
    expect((await run({ serves_kind: 'agt' })).skipReason).toBeUndefined();
    expect(await run({ serves_kind: 'claude_agent_sdk' })).toMatchObject(skipped);
    // No restrictions read at all (a run with no capabilities) is the same as the member absent.
    expect(await runScenario({ ...base, serves_kind: 'claude_agent_sdk' }, deps)).toMatchObject(
      skipped
    );
    expect((await runScenario({ ...base, serves_kind: 'adk' }, deps)).skipReason).toBeUndefined();
  });

  it('refuses a serves_kind that is not one of the eight continuation kinds, and accepts each of them', () => {
    expect(() => {
      assertRestrictions({ ...base, serves_kind: 'foo' as never }, 'f.yaml');
    }).toThrow(/serves_kind "foo"; it must be one of adk, .*, claude_agent_sdk/);
    for (const kind of CONTINUATION_KINDS)
      expect(() => {
        assertRestrictions({ ...base, serves_kind: kind }, 'f.yaml');
      }).not.toThrow();
  });

  it('accepts continuation_kinds in advertises (rev 17), skipping where the member is absent and running where it is advertised', async () => {
    const scenario = { ...base, advertises: ['continuation_kinds'] } satisfies Scenario;
    expect(() => {
      assertRestrictions(scenario, 'f.yaml');
    }).not.toThrow();
    const restrictions = { tool_registration: 'any', resolutions: ['approved'] } as const;
    expect(await runScenario(scenario, { ...deps, restrictions })).toMatchObject({
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: 'the deployment does not advertise continuation_kinds',
    });
    const advertised = await runScenario(scenario, {
      ...deps,
      restrictions: { ...restrictions, continuation_kinds: ['adk'] },
    });
    expect(advertised.skipReason).toBeUndefined();
  });

  it('skips a scenario whose policy subject type policy_forms does not advertise (rev 11 errata), and runs it where policy_forms is absent or lists it', async () => {
    const forms = (subjectTypes: readonly string[]) => ({
      tool_registration: 'any' as const,
      resolutions: ['approved'],
      policy_forms: {
        tool_invocation: {
          modes: ['ask'],
          subject_types: subjectTypes,
          targets_all: false,
          config_members: [],
        },
      },
    });
    const outcome = (restrictions?: ReturnType<typeof forms>): Promise<unknown[]> =>
      runScenario(
        { ...base, serves_policy_subject_type: 'organization' },
        { ...deps, ...(restrictions === undefined ? {} : { restrictions }) }
      ).then((r) => [r.skipKind, r.skipReason]);
    expect(await outcome(forms(['role', 'user']))).toEqual([
      'capability',
      'the deployment does not advertise organization subjects in policy_forms',
    ]);
    expect((await outcome(forms(['organization'])))[0]).toBeUndefined();
    expect((await outcome())[0]).toBeUndefined();
    // policy_forms with no tool_invocation entry promises no tool_invocation form at all.
    const noToolInvocation = await runScenario(
      { ...base, serves_policy_subject_type: 'organization' },
      {
        ...deps,
        restrictions: { tool_registration: 'any', resolutions: ['approved'], policy_forms: {} },
      }
    );
    expect(noToolInvocation.skipKind).toBe('capability');
    // A list: each must be advertised, and the reason names those that are not.
    const listed = await runScenario(
      { ...base, serves_policy_subject_type: ['role', 'agent', 'user'] },
      { ...deps, restrictions: forms(['role']) }
    );
    expect(listed.skipReason).toBe(
      'the deployment does not advertise agent, user subjects in policy_forms'
    );
    expect(
      (
        await runScenario(
          { ...base, serves_policy_subject_type: ['role', 'user'] },
          { ...deps, restrictions: forms(['role', 'user']) }
        )
      ).skipKind
    ).toBeUndefined();
  });

  it('gates a scenario on self_approval_from_approver_surface (rev 7): a capability skip with the exact reason, false when the member is absent', async () => {
    const reason = (advertised: boolean | undefined, wanted: boolean): Promise<unknown[]> =>
      runScenario(
        { ...base, self_approval_from_approver_surface: wanted },
        {
          ...deps,
          restrictions: {
            tool_registration: 'any',
            resolutions: ['approved'],
            ...(advertised === undefined
              ? {}
              : { self_approval_from_approver_surface: advertised }),
          },
        }
      ).then((r) => [r.outcome, r.skipKind, r.skipReason]);
    // Absent is false, so a scenario that needs `true` is skipped and one that needs `false` runs.
    expect(await reason(undefined, true)).toEqual([
      'skipped',
      'capability',
      "the deployment's self_approval_from_approver_surface is false, not true",
    ]);
    expect(await reason(false, true)).toEqual([
      'skipped',
      'capability',
      "the deployment's self_approval_from_approver_surface is false, not true",
    ]);
    expect(await reason(true, false)).toEqual([
      'skipped',
      'capability',
      "the deployment's self_approval_from_approver_surface is true, not false",
    ]);
    // Advertised and matching: it runs (an empty scenario then fails for having no steps).
    expect((await reason(true, true))[0]).not.toBe('skipped');
    expect((await reason(undefined, false))[0]).not.toBe('skipped');
    // A scenario that does not carry the field runs whatever is advertised.
    expect(
      (
        await runScenario(base, {
          ...deps,
          restrictions: {
            tool_registration: 'any',
            resolutions: ['approved'],
            self_approval_from_approver_surface: true,
          },
        })
      ).skipKind
    ).toBeUndefined();
  });

  it('checks self_approval_from_approver_surface before the token: no approver_surface_token against a deployment without the rule is a capability skip, with the rule an unconfigured one', async () => {
    const needsToken: Scenario = {
      ...base,
      self_approval_from_approver_surface: true,
      needs: ['approver_surface_token'],
    };
    const withRule = (rule: boolean | undefined): EngineDeps => ({
      ...deps,
      restrictions: {
        tool_registration: 'any',
        resolutions: ['approved'],
        ...(rule === undefined ? {} : { self_approval_from_approver_surface: rule }),
      },
    });
    for (const rule of [undefined, false])
      expect(await runScenario(needsToken, withRule(rule))).toMatchObject({
        outcome: 'skipped',
        skipKind: 'capability',
        skipReason: "the deployment's self_approval_from_approver_surface is false, not true",
      });
    expect(await runScenario(needsToken, withRule(true))).toMatchObject({
      outcome: 'skipped',
      skipKind: 'unconfigured',
    });
  });

  it('gates a scenario on advertises: [user_resolve_scope] (rev 8), before the token: a capability skip where the member is absent, unconfigured where it is advertised and the token is missing', async () => {
    const scoped: Scenario = {
      ...base,
      advertises: ['user_resolve_scope'],
      needs: ['approver_token_without_resolve_scope'],
    };
    const withScope = (scope: string | undefined): EngineDeps => ({
      ...deps,
      restrictions: {
        tool_registration: 'any',
        resolutions: ['approved'],
        ...(scope === undefined ? {} : { user_resolve_scope: scope }),
      },
    });
    expect(await runScenario(scoped, withScope(undefined))).toMatchObject({
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: 'the deployment does not advertise user_resolve_scope',
    });
    expect(await runScenario(scoped, withScope('approvals:resolve'))).toMatchObject({
      outcome: 'skipped',
      skipKind: 'unconfigured',
    });
  });

  it('skips a scenario that registers tools as admin, as unconfigured, when only administrators register and no admin token was given', async () => {
    const registersAsAdmin: Scenario = {
      ...base,
      steps: [
        { as: 'admin', request: { method: 'GET', path: '/v1/tools' }, expect: { status: 200 } },
      ],
    };
    const restrictions = {
      tool_registration: 'administrators' as const,
      resolutions: ['approved'],
    };
    expect(await runScenario(registersAsAdmin, { ...deps, restrictions })).toMatchObject({
      outcome: 'skipped',
      skipKind: 'unconfigured',
    });
    // With an administrator's token the alias is that token, and the scenario runs.
    const withAdmin = {
      ...deps,
      restrictions,
      target: { ...target, tokens: { ...target.tokens, admin: 'adm' } },
    };
    expect((await runScenario(registersAsAdmin, withAdmin)).skipKind).toBeUndefined();
    // Where registration is open the creator stands in, as before.
    expect((await runScenario(registersAsAdmin, deps)).skipKind).toBeUndefined();
    // A stream whose requests are sent as admin counts too.
    const streamAsAdmin: Scenario = {
      ...base,
      steps: [
        {
          stream_events: {
            path: '/v1/approvals/stream',
            during: [
              {
                as: 'admin',
                request: { method: 'GET', path: '/v1/tools' },
                expect: { status: 200 },
              },
            ],
            expect: { open: true, lacks: ['x'] },
          },
        },
      ],
    };
    expect((await runScenario(streamAsAdmin, { ...deps, restrictions })).skipKind).toBe(
      'unconfigured'
    );
  });

  it('skips a `limits` scenario when the deployment advertises no such limit, or 100, and binds the limit when it runs', async () => {
    const withLimits: Scenario = { ...base, limits: ['decisions_batch_max_items'] };
    expect(await runScenario(withLimits, deps)).toMatchObject({
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: 'the deployment does not advertise decisions_batch_max_items',
    });
    expect(
      await runScenario(withLimits, { ...deps, limits: { records_batch_max_items: 5 } })
    ).toMatchObject({ skipKind: 'capability' });
    const unbounded = await runScenario(withLimits, {
      ...deps,
      limits: { decisions_batch_max_items: 100 },
    });
    expect(unbounded.skipKind).toBe('capability');
    expect(unbounded.skipReason).toMatch(/is 100/);
    const ran = await runScenario(withLimits, {
      ...deps,
      limits: { decisions_batch_max_items: 7 },
    });
    expect(ran.outcome).toBe('failed');
    expect(ran.failures.join()).toMatch(/no steps/);
  });

  it('refuses a `limits` list that names nothing Capabilities.limits has', async () => {
    const bad = await runScenario({ ...base, limits: ['nope' as never] }, deps);
    expect(bad.outcome).toBe('failed');
    expect(bad.failures.join()).toMatch(/limits/);
  });

  it('skips an `unless` scenario on a deployment that advertises the family, and runs it on one that does not', async () => {
    const skipped = await runScenario({ ...base, unless: 'approvals' }, deps);
    expect(skipped).toMatchObject({
      outcome: 'skipped',
      skipKind: 'capability',
      skipReason: 'the deployment advertises approvals',
    });
    const ran = await runScenario(
      { ...base, unless: 'approvals' },
      { ...deps, advertised: new Set<Family>() }
    );
    expect(ran.outcome).toBe('failed');
    expect(ran.failures.join()).toMatch(/no steps/);
  });

  it('runs a scenario whose family is advertised, and every scenario with no requires', async () => {
    const advertised = await runScenario({ ...base, requires: 'approvals' }, deps);
    expect(advertised.outcome).toBe('failed');
    expect(advertised.failures.join()).toMatch(/no steps/);
    const floor = await runScenario({ ...base }, { ...deps, advertised: new Set<Family>() });
    expect(floor.outcome).toBe('failed');
    expect(floor.failures.join()).toMatch(/no steps/);
  });

  it('tells a skip by design from a skip for lack of configuration, and warns about the latter', async () => {
    const results = [
      await runScenario({ ...base, id: 'edge-only', only: 'edge' }, deps),
      await runScenario({ ...base, id: 'needs-approver', needs: ['approver'] }, deps),
      await runScenario({ ...base, id: 'needs-entitled', needs: ['entitled'] }, deps),
      await runScenario({ ...base, id: 'expiry', tags: ['needs-mock-control'] }, deps),
    ];
    expect(results.map((r) => r.skipKind)).toEqual([
      'inapplicable',
      'unconfigured',
      'unconfigured',
      'unconfigured',
    ]);
    const report: Report = {
      deployment: 'hosted',
      results,
      passed: 0,
      failed: 0,
      skipped: 4,
      exercised: [],
    };
    expect(unconfiguredSkips(report).map((r) => r.id)).toEqual([
      'needs-approver',
      'needs-entitled',
      'expiry',
    ]);
    const warning = formatSkipWarning(report);
    expect(warning).toContain('3 scenario(s) did not run');
    expect(warning).toContain('needs-entitled: no token for entitled (pass --entitled-token)');
    expect(warning).toContain(
      'expiry: needs a server that offers clock control (pass --clock-control)'
    );
    expect(warning).not.toContain('edge-only');
    expect(formatSkipWarning({ ...report, results: results.slice(0, 1) })).toBe('');
  });

  it('fails a step whose body claims JSON and does not parse, instead of treating it as text', async () => {
    const fetchStub: typeof fetch = () =>
      Promise.resolve(
        new Response('{"data": ', { status: 200, headers: { 'content-type': 'application/json' } })
      );
    const result = await runScenario(
      {
        ...base,
        steps: [
          {
            as: 'creator',
            request: { method: 'GET', path: '/v1/anything' },
            expect: { status: 200 },
          },
        ],
      },
      { ...deps, target: { ...target, fetch: fetchStub } }
    );
    expect(result.outcome).toBe('failed');
    expect(result.failures.join('\n')).toMatch(/body is not valid JSON/);
  });

  it('fails a scenario with no steps, and a corpus loop over an empty corpus', async () => {
    const empty = await runScenario({ ...base }, deps);
    expect(empty.outcome).toBe('failed');
    expect(empty.failures.join()).toMatch(/no steps/);
    const loop = await runScenario(
      {
        ...base,
        foreach: 'corpus',
        steps: [{ request: { method: 'GET', path: '/x' }, expect: { status: 200 } }],
      },
      deps
    );
    expect(loop.outcome).toBe('failed');
    expect(loop.failures.join()).toMatch(/corpus is empty/);
  });

  it('fails the step, and sends nothing, when a variable was never saved', async () => {
    const sent: string[] = [];
    const fetchStub: typeof fetch = (input) => {
      sent.push(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(Response.json({}));
    };
    const result = await runScenario(
      {
        ...base,
        steps: [
          {
            request: { method: 'GET', path: '/v1/approvals/${approval_id}' },
            expect: { status: 200 },
          },
        ],
      },
      { ...deps, target: { ...target, fetch: fetchStub } }
    );
    expect(result.outcome).toBe('failed');
    expect(result.failures[0]).toMatch(/approval_id.*not bound/);
    expect(sent).toEqual([]);
  });

  it('reports a failed step instead of throwing', async () => {
    const result = await runScenario(
      {
        ...base,
        steps: [{ request: { method: 'GET', path: '/v1/capabilities' }, expect: { status: 200 } }],
      },
      deps
    );
    expect(result.outcome).toBe('failed');
    expect(result.failures[0]).toMatch(/step 1/);
  });
});

describe('the steps of rev 4', () => {
  const target: Target = {
    baseUrl: 'http://127.0.0.1:1',
    deployment: 'hosted',
    tokens: { creator: 't', approver: 'a' },
    fixtures: { proxied_tool: 'a', allow_tool: 'b', deny_tool: 'c', default_tool: 'd' },
  };
  const index = new SpecIndex(loadCommittedDocument());
  const depsFor = (fetchStub: typeof fetch, extra: Partial<Target> = {}): EngineDeps => ({
    target: { ...target, ...extra, fetch: fetchStub },
    index,
    advertised: new Set<Family>(['approvals']),
    exercised: new Set<string>(),
    corpus: [],
  });
  const base = { id: 's', title: 't', tags: ['both'], steps: [] } satisfies Scenario;
  const problem = (status: number, code: string): Response =>
    new Response(
      JSON.stringify({
        type: `https://docs.noblecloak.com/problems/${code}`,
        title: code,
        status,
        request_id: 'req_1',
      }),
      { status, headers: { 'content-type': 'application/problem+json' } }
    );
  const approval = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    state: 'approved',
    tool_ref: 'mcp:t:x',
    obligation_kind: 'tool_invocation',
    action_digest: '0'.repeat(64),
    scope_id: 'scope',
    side_effect_level: 'write',
    policy: { id: 'pol', version: 1 },
    created_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
  const event = (data: unknown): string =>
    `event: approval.updated\ndata: ${JSON.stringify(data)}\n\n`;
  /** A fetch that answers the stream request with `frames` and every other request with a 404 problem. */
  const streamStub = (frames: string[], status = 200): typeof fetch => {
    return (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.includes('/v1/approvals/stream')) return Promise.resolve(problem(404, 'not_found'));
      const encoder = new TextEncoder();
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(': connected\n\n'));
              for (const frame of frames) controller.enqueue(encoder.encode(frame));
            },
          }),
          { status, headers: { 'content-type': 'text/event-stream' } }
        )
      );
    };
  };
  const streamScenario = (expect: Record<string, unknown>): Scenario => ({
    ...base,
    steps: [
      {
        stream_events: {
          as: 'approver',
          path: '/v1/approvals/stream',
          settle_ms: 10,
          during: [
            {
              as: 'creator',
              request: { method: 'GET', path: '/v1/approvals/a1' },
              expect: { status: 404, problem: 'not_found' },
            },
          ],
          expect,
        },
      } as never,
    ],
  });

  it('a stream step passes when the events it must deliver arrive, with the predicates that hold, and the ones it must not are absent', async () => {
    const stub = streamStub([event(approval('a1', { continuation_kind: 'langgraph' }))]);
    const result = await runScenario(
      streamScenario({
        delivers: ['a1', { id: 'a1', body: [{ path: 'continuation_kind', equals: 'langgraph' }] }],
        lacks: ['a2'],
      }),
      depsFor(stub)
    );
    expect(result.failures).toEqual([]);
    expect(result.outcome).toBe('passed');
  });

  it('a stream step fails when an expected event is missing, an unwanted one arrived, a predicate does not hold, or an event is not an Approval', async () => {
    const frames = [event(approval('a1')), event({ id: 'broken' })];
    const result = await runScenario(
      streamScenario({
        delivers: ['a9', { id: 'a1', body: [{ path: 'continuation', exists: true }] }],
        lacks: ['a1'],
      }),
      depsFor(streamStub(frames))
    );
    const failures = result.failures.join('\n');
    expect(result.outcome).toBe('failed');
    expect(failures).toMatch(/no event was delivered for a9/);
    expect(failures).toMatch(/continuation should exist/);
    expect(failures).toMatch(/an event was delivered for a1, which must not be visible/);
    expect(failures).toMatch(/does not match the Approval schema/);
  });

  it('every_event applies a predicate to each event delivered for the id, where the default reads the last alone', async () => {
    // The first event (a creation) carries the member the last one lacks.
    const frames = [
      event(approval('a1', { state: 'pending', on_deny: 'resume' })),
      event(approval('a1')),
    ];
    const absent = [{ path: 'on_deny', exists: false }];
    const last = await runScenario(
      streamScenario({ delivers: [{ id: 'a1', body: absent }] }),
      depsFor(streamStub(frames))
    );
    expect(last.failures).toEqual([]);
    const every = await runScenario(
      streamScenario({ delivers: [{ id: 'a1', every_event: true, body: absent }] }),
      depsFor(streamStub(frames))
    );
    expect(every.outcome).toBe('failed');
    expect(every.failures.join()).toMatch(/\(1 of 2\)/);
    const clean = await runScenario(
      streamScenario({ delivers: [{ id: 'a1', every_event: true, body: absent }] }),
      depsFor(streamStub([event(approval('a1', { state: 'pending' })), event(approval('a1'))]))
    );
    expect(clean.failures).toEqual([]);
  });

  it('serves_on_deny skips as a capability, not as unconfigured, where the deployment implements no on_deny', async () => {
    const scenario: Scenario = { ...base, serves_on_deny: true, fixtures: ['on_deny_tool_ref'] };
    const none = await runScenario(scenario, depsFor(streamStub([]), { noOnDeny: true }));
    expect(none).toMatchObject({ outcome: 'skipped', skipKind: 'capability' });
    // Without the declaration the missing fixture is what skips it.
    const unset = await runScenario(scenario, depsFor(streamStub([])));
    expect(unset).toMatchObject({ outcome: 'skipped', skipKind: 'unconfigured' });
  });

  it('refuses a serves_on_deny that is not true', () => {
    expect(() => {
      assertRestrictions({ ...base, serves_on_deny: false as never }, 'f.yaml');
    }).toThrow(/serves_on_deny must be true/);
  });

  it('a stream step fails when the stream does not open, and when an event is not JSON', async () => {
    const refused = await runScenario(
      streamScenario({ delivers: ['a1'] }),
      depsFor(streamStub([], 400))
    );
    expect(refused.failures.join()).toMatch(/expected a 200 text\/event-stream, got 400/);
    const garbled = await runScenario(
      streamScenario({ delivers: ['a1'] }),
      depsFor(streamStub(['event: approval.updated\ndata: {nope\n\n']))
    );
    expect(garbled.failures.join()).toMatch(/an event is not JSON/);
  });

  it('a stream step stops at a failed request of its own and reports it', async () => {
    const stub: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      return Promise.resolve(
        url.includes('/stream')
          ? new Response(new ReadableStream<Uint8Array>(), {
              headers: { 'content-type': 'text/event-stream' },
            })
          : problem(500, 'internal_error')
      );
    };
    const result = await runScenario(streamScenario({ delivers: ['a1'] }), depsFor(stub));
    expect(result.outcome).toBe('failed');
    expect(result.failures.join()).toMatch(
      /during 1 GET \/v1\/approvals\/a1: expected status 404, got 500/
    );
  });

  it('a header expectation fails when the header is missing, present when it must not be, or does not match', async () => {
    const stub: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'https://docs.noblecloak.com/problems/not_found',
            title: 'x',
            status: 404,
            request_id: 'r',
          }),
          {
            status: 404,
            headers: { 'content-type': 'application/problem+json', 'retry-after': 'soon' },
          }
        )
      );
    const run = (headers: unknown[]): Promise<{ failures: readonly string[] }> =>
      runScenario(
        {
          ...base,
          steps: [
            {
              as: 'creator',
              request: { method: 'GET', path: '/v1/approvals/a1' },
              expect: { status: 404, headers },
            } as never,
          ],
        },
        depsFor(stub)
      );
    expect(
      (
        await run([
          { name: 'retry-after', matches: '^soon$' },
          { name: 'x-absent', exists: false },
        ])
      ).failures
    ).toEqual([]);
    expect((await run([{ name: 'x-missing' }])).failures.join()).toMatch(
      /x-missing should be present/
    );
    expect((await run([{ name: 'retry-after', exists: false }])).failures.join()).toMatch(
      /retry-after should be absent/
    );
    expect((await run([{ name: 'retry-after', matches: '^\\d+$' }])).failures.join()).toMatch(
      /should match/
    );
  });

  it('a scenario with a control step is skipped without mock control, and otherwise sends the control and resets it afterwards, pass or fail', async () => {
    const scenario: Scenario = {
      ...base,
      steps: [{ control: { limits: { decisions_batch_max_items: 3 } } }],
    };
    expect(
      (
        await runScenario(
          scenario,
          depsFor(() => Promise.reject(new Error('unreachable')))
        )
      ).skipKind
    ).toBe('unconfigured');
    const bodies: unknown[] = [];
    const stub: typeof fetch = (_input, init) => {
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      return Promise.resolve(Response.json({}));
    };
    const passed = await runScenario(
      scenario,
      depsFor(stub, { mockControl: 'http://control.test/c' })
    );
    expect(passed.outcome).toBe('passed');
    expect(bodies).toEqual([{ limits: { decisions_batch_max_items: 3 } }, { reset: true }]);
    // A failing step after the control still resets it.
    bodies.length = 0;
    const failing = await runScenario(
      {
        ...scenario,
        steps: [
          ...scenario.steps,
          { request: { method: 'GET', path: '/v1/nope' }, expect: { status: 200 } },
        ],
      },
      depsFor(stub, { mockControl: 'http://control.test/c' })
    );
    expect(failing.outcome).toBe('failed');
    expect(bodies.at(-1)).toEqual({ reset: true });
    // A control that refuses is a failure of the scenario.
    const refusing = await runScenario(
      scenario,
      depsFor(() => Promise.resolve(new Response('no', { status: 500 })), {
        mockControl: 'http://control.test/c',
      })
    );
    expect(refusing.failures.join()).toMatch(/mock control answered 500/);
  });

  it('the skip warning names the flag that supplies a missing fixture and the one that enables mock control', async () => {
    const never: typeof fetch = () => Promise.reject(new Error('unreachable'));
    const results = [
      await runScenario(
        { ...base, id: 'needs-fixture', fixtures: ['system_tool_ref'] },
        depsFor(never)
      ),
      await runScenario(
        { ...base, id: 'needs-control', steps: [{ control: { reset: true } } as never] },
        depsFor(never)
      ),
    ];
    const warning = formatSkipWarning({
      deployment: 'hosted',
      results,
      passed: 0,
      failed: 0,
      skipped: 2,
      exercised: [],
    });
    expect(warning).toContain(
      'needs-fixture: no fixture for system_tool_ref (pass --system-tool-ref)'
    );
    expect(warning).toContain(
      'needs-control: needs a server that offers mock control (pass --mock-control)'
    );
  });

  it('a scenario that needs a fixture is skipped as unconfigured when the run was not given it', async () => {
    const scenario: Scenario = { ...base, fixtures: ['reserved_tool_ref'] };
    const skipped = await runScenario(
      scenario,
      depsFor(() => Promise.reject(new Error('unreachable')))
    );
    expect(skipped).toMatchObject({ outcome: 'skipped', skipKind: 'unconfigured' });
    expect(skipped.skipReason).toBe('no fixture for reserved_tool_ref');
    const ran = await runScenario(
      scenario,
      depsFor(() => Promise.reject(new Error('unreachable')), {
        fixtures: { ...target.fixtures, reserved_tool_ref: 'reserved:x' },
      })
    );
    expect(ran.outcome).toBe('failed');
    expect(ran.failures.join()).toMatch(/no steps/);
  });

  it('a step gate skips the rest of the scenario by capability when the step answers another status, and runs it when it matches', async () => {
    let calls = 0;
    const stub: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(problem(422, 'unsupported_policy_form'));
    };
    const scenario = (status: number, other = status === 200 ? 422 : 200): Scenario => ({
      ...base,
      steps: [
        {
          request: {
            method: 'POST',
            path: '/v1/policies/pol_1/simulate',
            body: { subject: { type: 'agent', id: 'a' }, action: { tool_ref: 't', arguments: {} } },
          },
          expect: { status: [200, 422] },
          gate: {
            status,
            reason: 'not simulated as an agent',
            otherwise: { status: other, problem: 'unsupported_policy_form' },
          },
        },
        {
          request: {
            method: 'POST',
            path: '/v1/policies/pol_1/simulate',
            body: { subject: { type: 'agent', id: 'a' }, action: { tool_ref: 't', arguments: {} } },
          },
          expect: { status: 200 },
        },
      ],
    });
    const skipped = await runScenario(scenario(200), depsFor(stub));
    expect([skipped.outcome, skipped.skipKind, skipped.skipReason]).toEqual([
      'skipped',
      'capability',
      'not simulated as an agent',
    ]);
    expect(calls).toBe(1);
    calls = 0;
    const ran = await runScenario(scenario(422), depsFor(stub));
    expect(ran.outcome).toBe('failed');
    expect(calls).toBe(2);
    // A 422 for another reason is a failure, never read as the gate's refusal.
    const other: typeof fetch = () => Promise.resolve(problem(422, 'invalid_request'));
    const wrong = await runScenario(scenario(200), depsFor(other));
    expect(wrong.outcome).toBe('failed');
    expect(wrong.failures[0]).toMatch(/problem unsupported_policy_form/);
    // A detail that does not name the member is a failure too.
    const detailed = {
      ...scenario(200),
      steps: scenario(200).steps.map((step) =>
        'gate' in step
          ? {
              ...step,
              gate: {
                ...step.gate,
                otherwise: { ...step.gate.otherwise, detail_matches: '^subject' },
              },
            }
          : step
      ),
    };
    const noDetail = await runScenario(detailed, depsFor(stub));
    expect(noDetail.outcome).toBe('failed');
    expect(noDetail.failures[0]).toMatch(/detail should match/);
  });

  it("a gate's otherwise may name the member (rev 13): a matching member skips, another fails, and a rev 12 problem without one is read by detail_matches or fails", async () => {
    const answer =
      (extra: Record<string, unknown>): typeof fetch =>
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'https://docs.noblecloak.com/problems/unsupported_policy_form',
              title: 't',
              status: 422,
              request_id: 'req_1',
              ...extra,
            }),
            { status: 422, headers: { 'content-type': 'application/problem+json' } }
          )
        );
    const gated = (otherwise: Record<string, unknown>): Scenario => ({
      ...base,
      steps: [
        {
          request: {
            method: 'POST',
            path: '/v1/policies/pol_1/simulate',
            body: { subject: { type: 'agent', id: 'a' }, action: { tool_ref: 't', arguments: {} } },
          },
          expect: { status: [200, 422] },
          gate: {
            status: 200,
            reason: 'not simulated as an agent',
            otherwise: { status: 422, problem: 'unsupported_policy_form', ...otherwise },
          },
        },
      ],
    });
    const member = { member: 'subject', detail_matches: '\\bsubject\\b' };
    const run = (otherwise: Record<string, unknown>, extra: Record<string, unknown>) =>
      runScenario(gated(otherwise), depsFor(answer(extra)));
    expect((await run(member, { member: 'subject' })).outcome).toBe('skipped');
    const wrong = await run(member, { member: 'config.mode', detail: 'subject: x' });
    expect(wrong.outcome).toBe('failed');
    expect(wrong.failures[0]).toMatch(/member should be "subject" \(got "config.mode"\)/);
    // A rev 12 deployment sends no member: its detail is read.
    expect((await run(member, { detail: 'subject: cannot simulate' })).outcome).toBe('skipped');
    const vague = await run(member, { detail: 'cannot simulate' });
    expect(vague.outcome).toBe('failed');
    expect(vague.failures[0]).toMatch(/detail should match/);
    // A member that is present and malformed fails: it is never read as a rev 12 problem without one.
    // (On an undocumented route, so that the response schema, which also rejects it, does not answer first.)
    const probe = (extra: Record<string, unknown>) => {
      const scenario = gated(member);
      const [first] = scenario.steps as unknown as { request: { path: string }; expect: object }[];
      if (first === undefined) throw new Error('no step');
      first.request.path = '/v1/undocumented-probe';
      first.expect = { status: [200, 422], undocumented: true };
      return runScenario(scenario, depsFor(answer(extra)));
    };
    expect((await probe({ member: 'subject' })).outcome).toBe('skipped');
    for (const malformed of ['', 7, null, ['subject']]) {
      const bad = await probe({ member: malformed, detail: 'subject: cannot simulate' });
      expect(bad.outcome, JSON.stringify(malformed)).toBe('failed');
      expect(bad.failures[0]).toMatch(/member should be a non-empty string/);
    }
    // With a member and no detail_matches there is no rev 12 reading.
    const bare = await run({ member: 'subject' }, { detail: 'subject: x' });
    expect(bare.outcome).toBe('failed');
    expect(bare.failures[0]).toMatch(/should carry member "subject"/);
    expect(() => {
      assertGate(
        {
          request: { method: 'POST', path: '/v1/x' },
          expect: { status: [200, 422] },
          gate: {
            status: 200,
            reason: 'r',
            otherwise: { status: 422, problem: 'p', member: '' },
          },
        },
        'w'
      );
    }).toThrow(/gate/);
  });
});

describe('a scenario cleanup (rev 13)', () => {
  const target = {
    baseUrl: 'http://x',
    deployment: 'hosted',
    tokens: { creator: 't' },
  };
  const index = new SpecIndex(loadCommittedDocument());
  const calls: string[] = [];
  const answering =
    (answers: Record<string, number>): typeof fetch =>
    (_url, init) => {
      const method = String(init?.method);
      calls.push(method);
      const status = answers[method] ?? 500;
      const agent = {
        data: { id: 'agent_1', name: 'a', parent_id: null, created_at: '2026-10-28T12:00:00Z' },
        meta: { request_id: 'req_1', deployment: 'hosted' },
      };
      return Promise.resolve(
        status === 204
          ? new Response(null, { status })
          : new Response(JSON.stringify(status === 200 ? agent : {}), {
              status,
              headers: { 'content-type': 'application/json' },
            })
      );
    };
  const depsFor = (fetchStub: typeof fetch): EngineDeps => ({
    target: { ...target, fetch: fetchStub } as unknown as Target,
    index,
    advertised: new Set<Family>(['agents']),
    exercised: new Set<string>(),
    corpus: [],
  });
  const scenario = {
    id: 's',
    title: 't',
    tags: ['both'],
    steps: [
      {
        request: { method: 'GET', path: '/v1/agents/agent_1' },
        expect: { status: 200 },
      },
    ],
    cleanup: [
      {
        request: { method: 'DELETE', path: '/v1/agents/agent_1/principal' },
        expect: { status: 204 },
      },
    ],
  } as unknown as Scenario;

  it('runs after a failed step, and a failing cleanup does not hide the failure it follows', async () => {
    calls.length = 0;
    const cleaned = await runScenario(scenario, depsFor(answering({ GET: 500, DELETE: 204 })));
    expect(cleaned.outcome).toBe('failed');
    expect(calls).toEqual(['GET', 'DELETE']);
    expect(cleaned.failures).toHaveLength(1);
    expect(cleaned.failures[0]).toMatch(/^step 1/);
    calls.length = 0;
    const both = await runScenario(scenario, depsFor(answering({ GET: 500, DELETE: 500 })));
    expect(calls).toEqual(['GET', 'DELETE']);
    expect(both.failures[0]).toMatch(/^step 1/);
    expect(both.failures.some((f) => f.startsWith('cleanup 1'))).toBe(true);
  });

  it('is refused when it names a variable saved at or after a gate, which a gated run never saves', () => {
    const gate = {
      status: 200,
      reason: 'r',
      otherwise: { status: 422, problem: 'unsupported_policy_form' },
    };
    const gated = (cleanupPath: string): Scenario => {
      const scenario: unknown = {
        id: 'g',
        title: 't',
        tags: ['both'],
        steps: [
          {
            request: { method: 'POST', path: '/v1/agents', body: { name: 'a' } },
            expect: { status: 201 },
            save: { before: 'data.id' },
          },
          {
            request: { method: 'GET', path: '/v1/agents/${before}' },
            expect: { status: [200, 422] },
            gate,
            save: { at: 'data.id' },
          },
          {
            request: { method: 'POST', path: '/v1/agents', body: { name: 'b' } },
            expect: { status: 201 },
            save: { after: 'data.id' },
          },
        ],
        cleanup: [{ request: { method: 'DELETE', path: cleanupPath }, expect: { status: 204 } }],
      };
      return scenario as Scenario;
    };
    expect(() => {
      assertRestrictions(gated('/v1/agents/${before}/principal'), 'f');
    }).not.toThrow();
    expect(() => {
      assertRestrictions(gated('/v1/agents/${after}/principal'), 'f');
    }).toThrow(/cleanup names \$\{after\}/);
    expect(() => {
      assertRestrictions(gated('/v1/agents/${at}/principal'), 'f');
    }).toThrow(/cleanup names \$\{at\}/);
  });

  it('a passing scenario whose cleanup fails is failed, and a clean one passes', async () => {
    const dirty = await runScenario(scenario, depsFor(answering({ GET: 200, DELETE: 500 })));
    expect(dirty.outcome).toBe('failed');
    expect(dirty.failures.every((f) => f.startsWith('cleanup 1'))).toBe(true);
    const clean = await runScenario(scenario, depsFor(answering({ GET: 200, DELETE: 204 })));
    expect(clean.outcome).toBe('passed');
  });
});

describe('following pages (rev 13)', () => {
  const index = new SpecIndex(loadCommittedDocument());
  const requested: string[] = [];
  const listing =
    (pages: Record<string, { ids: string[]; next: string | null }>): typeof fetch =>
    (url) => {
      const cursor =
        new URL(
          typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
        ).searchParams.get('cursor') ?? 'first';
      requested.push(cursor);
      const page = pages[cursor] ?? { ids: [], next: null };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: page.ids.map((id) => ({ id, kind: 'role', display_name: id })),
            meta: { request_id: 'req_1', deployment: 'hosted', next: page.next },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    };
  const run = (stub: typeof fetch) =>
    runScenario(
      {
        id: 's',
        title: 't',
        tags: ['both'],
        steps: [
          {
            request: { method: 'GET', path: '/v1/principals?type=role&limit=2' },
            expect: {
              status: 200,
              follow_pages: true,
              body: [{ path: 'data', lacks_where: { key: 'id', equals: 'everyone' } }],
            },
          },
        ],
      } as unknown as Scenario,
      {
        target: {
          baseUrl: 'http://x',
          deployment: 'hosted',
          tokens: { creator: 't' },
          fetch: stub,
        } as unknown as Target,
        index,
        advertised: new Set<Family>(['principals']),
        exercised: new Set<string>(),
        corpus: [],
      }
    );

  it('checks every page to the last, so an entry on a later page is found', async () => {
    requested.length = 0;
    const clean = await run(
      listing({ first: { ids: ['a'], next: 'p2' }, p2: { ids: ['b'], next: null } })
    );
    expect(clean.outcome).toBe('passed');
    expect(requested).toEqual(['first', 'p2']);
    const late = await run(
      listing({ first: { ids: ['a'], next: 'p2' }, p2: { ids: ['everyone'], next: null } })
    );
    expect(late.outcome).toBe('failed');
    expect(late.failures[0]).toMatch(/should be an array with no element/);
  });

  it('fails a listing that never ends', async () => {
    const endless = await run(
      listing(
        Object.fromEntries(
          ['first', ...Array.from({ length: 60 }, (_, i) => `c${String(i)}`)].map((cursor, i) => [
            cursor,
            { ids: ['a'], next: `c${String(i)}` },
          ])
        )
      )
    );
    expect(endless.outcome).toBe('failed');
    expect(endless.failures.join()).toMatch(/more than 50 pages/);
  });
});

describe('the problem types of rev 3', () => {
  // The scenario files, plus the generated every-route scenario for header_identity_rejected.
  const expected = (): string[] =>
    loadScenarios().flatMap((s) =>
      s.steps.flatMap((step) => ('expect' in step ? [step.expect.problem ?? ''] : []))
    );

  it.each([
    'continuation_unsupported',
    'dpop_unsupported',
    'organization_context_required',
    'insufficient_scope',
  ])('%s has a scenario that expects it', (type) => {
    expect(expected()).toContain(type);
  });
});

describe('assertRequires', () => {
  const scenario = { id: 's', title: 't', tags: ['both'], steps: [] } satisfies Scenario;
  const accepts = (requires: unknown): boolean => {
    try {
      assertRequires({ ...scenario, requires } as Scenario, 'f');
      return true;
    } catch {
      return false;
    }
  };
  it('accepts a family or a list of them and rejects the floor, an unknown name and an empty list', () => {
    expect(accepts('runs')).toBe(true);
    expect(accepts(['runs', 'records.chain'])).toBe(true);
    expect(accepts(undefined)).toBe(true);
    for (const bad of ['decisions', 'records', 'nonsense', [], ['runs', 'tools']])
      expect(accepts(bad), JSON.stringify(bad)).toBe(false);
    const call = (unless: string) => () => {
      assertRequires({ ...scenario, unless: unless as Family }, 'f');
    };
    expect(call('approvals')).not.toThrow();
    expect(call('decisions')).toThrow(/unless "decisions"/);
  });
});

describe('an unknown requires, unless or dpop name', () => {
  it('fails in the engine, not skipped as a capability, so a caller that bypasses the loader is told', async () => {
    const base = { id: 's', title: 't', tags: ['both'], steps: [] } satisfies Scenario;
    const deps = {
      index: undefined,
      advertised: new Set<Family>(),
      target: { baseUrl: 'http://x', deployment: 'hosted', tokens: {} },
      exercised: new Set<string>(),
      corpus: [],
    } as unknown as EngineDeps;
    for (const typo of [
      { requires: 'run' },
      { requires: ['runs', 'nonsense'] },
      { unless: 'approval' },
      { dpop: 'on' },
    ]) {
      const result = await runScenario({ ...base, ...typo } as unknown as Scenario, deps);
      expect(result.outcome, JSON.stringify(typo)).toBe('failed');
      expect(result.failures.join(), JSON.stringify(typo)).toMatch(/must (name|be one)/);
    }
  });

  it('is also a loadScenarios error for a typo in a scenario file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-scn-'));
    try {
      writeFileSync(
        join(dir, 'a.yaml'),
        '- id: typo\n  title: t\n  tags: [both]\n  requires: run\n  steps:\n    - request: { method: GET, path: /x }\n      expect: { status: 200 }\n'
      );
      expect(() => loadScenarios([dir])).toThrow(/typo requires "run"/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('the scenario files', () => {
  const scenarios = loadScenarios();

  it('have unique ids and tags that name where they apply', () => {
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
    for (const s of scenarios) expect(s.tags.length, s.id).toBeGreaterThan(0);
  });

  it('cover every scenario the contract requires, by id', () => {
    const ids = new Set(scenarios.map((s) => s.id));
    for (const required of [
      'negative-replayed-resume-token',
      'negative-ineligible-resolve',
      'negative-service-cannot-resolve',
      'tenancy-approvals-isolated',
      'tenancy-records-isolated',
      'tenancy-record-chain-isolated',
      'tenancy-runs-isolated',
      'tenancy-tools-isolated',
      'tenancy-connections-isolated',
      'negative-stale-digest',
      'negative-caller-supplied-attestation',
      'negative-caller-supplied-approval-id',
      'negative-wrong-audience',
      'identity-corpus-digests',
      'dedupe-across-both-doors',
      'lifecycle-proxied-tool-run-scoped',
      'lifecycle-proxied-tool-principal-scoped',
      'lifecycle-external-tool',
      'continuation-multiplicity',
      'creator-cannot-self-approve-through-either-door',
      'terminal-withdrawn-frees-identity',
      'terminal-expiry-frees-identity',
      'resumption-external-has-token-proxied-does-not',
      'resumption-signature-verification',
      'negative-resumption-audience',
      'idempotency-records',
      'callback-unroutable-loopback',
      'callback-unroutable-metadata',
      'callback-unroutable-rfc1918',
      'callback-unroutable-hostname-resolving-to-loopback',
      'authzen-unmodified-client',
      'capabilities-edge-features',
      'negative-consume-wrong-action',
    ]) {
      expect(ids.has(required), required).toBe(true);
    }
  });
});

describe('assertGate and serves_policy_subject_type at load (rev 11)', () => {
  const step = (gate: unknown, status: unknown = [200, 422]): unknown => ({
    request: { method: 'POST', path: '/v1/x' },
    expect: { status },
    gate,
  });
  const good = {
    status: 200,
    reason: 'r',
    otherwise: { status: 422, problem: 'unsupported_policy_form' },
  };
  it('accepts a gate whose statuses the step expects, and refuses one that could never match', () => {
    expect(() => {
      assertGate(step(good), 'w');
    }).not.toThrow();
    for (const bad of [
      { ...good, status: '200' },
      { ...good, status: 201 },
      { ...good, reason: '' },
      { status: 200, reason: 'r' },
      { ...good, otherwise: { status: 200, problem: 'x' } },
      { ...good, otherwise: { status: 422 } },
      { ...good, otherwise: { status: 409, problem: 'x' } },
      { ...good, otherwise: { ...good.otherwise, detail_matches: '(' } },
      { ...good, otherwise: null },
      null,
    ])
      expect(() => {
        assertGate(step(bad), 'w');
      }).toThrow(/gate/);
    expect(() => {
      assertGate({ control: {}, gate: good }, 'w');
    }).toThrow(/gate/);
  });
  it('refuses a subject type outside PolicySubjectType', () => {
    const scenario = (value: unknown): Scenario =>
      ({ id: 's', title: 't', tags: [], steps: [], serves_policy_subject_type: value }) as Scenario;
    expect(() => {
      assertRestrictions(scenario(['role', 'agent']), 'f');
    }).not.toThrow();
    for (const bad of ['roles', [], ['role', 'nobody'], 3])
      expect(() => {
        assertRestrictions(scenario(bad), 'f');
      }).toThrow(/serves_policy_subject_type/);
  });
});

describe("the steps of rev 12: verify a webhook delivery, and read the mock's deliveries", () => {
  const NOW = '2026-10-24T12:00:00Z';
  const base: Scenario = { id: 'rev12', title: 't', tags: ['both'], steps: [] };
  const depsWith = (fetchImpl: typeof fetch): EngineDeps => ({
    index: new SpecIndex(loadCommittedDocument()),
    advertised: new Set(),
    target: {
      baseUrl: 'http://x.test',
      deployment: 'hosted',
      tokens: { creator: 'c' },
      fixtures: { proxied_tool: 'p', allow_tool: 'a', deny_tool: 'd', default_tool: 'f' },
      fetch: fetchImpl,
      mockControl: 'http://x.test/__mock/control',
    },
    exercised: new Set(),
    corpus: [],
  });
  const never: typeof fetch = () => Promise.reject(new Error('unreachable'));
  const eventOf = (data: Record<string, unknown>): Record<string, unknown> => ({
    specversion: '1.0',
    id: 'evt_1',
    type: 'record.appended',
    source: 'https://govern.example.test',
    subject: 'rec_1',
    time: NOW,
    datacontenttype: 'application/json',
    data,
  });
  const DATA = { record_id: 'rec_1', tool_ref: 'ext:t', decision: 'allow', ts: NOW };

  const signed = async (
    covered: Record<string, unknown>,
    body: Record<string, unknown> = covered
  ): Promise<{ delivery: Record<string, unknown>; jwks: unknown }> => {
    const { generateSigningKey, jwksOf, signJws } = await import('../mock/jws.js');
    const key = await generateSigningKey('k1');
    return {
      delivery: { ...body, signature: await signJws(covered as never, key) },
      jwks: jwksOf([key]),
    };
  };
  const verifyScenario = (
    delivery: unknown,
    jwks: unknown,
    extra: Record<string, unknown>
  ): Scenario =>
    ({
      ...base,
      steps: [{ verify: { kind: 'webhook_delivery', object: delivery, jwks, ...extra } }],
    }) as unknown as Scenario;

  it('verifies a genuine delivery, and rejects a tampered data', async () => {
    const { delivery, jwks } = await signed(eventOf(DATA));
    const valid = await runScenario(
      verifyScenario(delivery, jwks, { result: 'valid' }),
      depsWith(never)
    );
    expect(valid.failures).toEqual([]);
    const tampered = await runScenario(
      verifyScenario(delivery, jwks, { tamper: 'data', result: 'bad_signature' }),
      depsWith(never)
    );
    expect(tampered.failures).toEqual([]);
    // Expecting the wrong outcome is a failure of the scenario.
    const wrong = await runScenario(
      verifyScenario(delivery, jwks, { tamper: 'data', result: 'valid' }),
      depsWith(never)
    );
    expect(wrong.failures.join()).toMatch(/rejected with bad_signature, expected valid/);
  });

  it('fails a verify step whose tamper belongs to the other kind', async () => {
    const { delivery, jwks } = await signed(eventOf(DATA));
    const misused = await runScenario(
      verifyScenario(delivery, jwks, { tamper: 'tool_ref', result: 'bad_signature' }),
      depsWith(never)
    );
    expect(misused.failures.join()).toMatch(/tamper tool_ref does not apply to a webhook_delivery/);
    const resumption = await runScenario(
      {
        id: 'verify-misuse',
        title: 't',
        tags: ['both'],
        steps: [
          {
            verify: {
              kind: 'resumption',
              object: delivery,
              jwks,
              expect: { tool_ref: 't', arg_digest: 'd' },
              tamper: 'data',
              result: 'bad_signature',
            },
          },
        ],
      } as unknown as Scenario,
      depsWith(never)
    );
    expect(resumption.failures.join()).toMatch(/tamper data does not apply to a resumption/);
  });

  it('fails a delivery whose signature does not cover its data, an unsigned one and an unknown key', async () => {
    const leftOut = await signed(eventOf({}), eventOf(DATA));
    const result = await runScenario(
      verifyScenario(leftOut.delivery, leftOut.jwks, { result: 'valid' }),
      depsWith(never)
    );
    expect(result.failures.join()).toMatch(/signed payload is not the delivery object/);
    const { jwks } = await signed(eventOf(DATA));
    const unsigned = await runScenario(
      verifyScenario({ ...eventOf(DATA), signature: 'unsigned' }, jwks, { result: 'valid' }),
      depsWith(never)
    );
    expect(unsigned.failures.join()).toMatch(/rejected with malformed/);
    const other = await signed(eventOf(DATA));
    const unknown = await runScenario(
      verifyScenario(other.delivery, jwks, { result: 'valid' }),
      depsWith(never)
    );
    expect(unknown.failures.join()).toMatch(/rejected with (bad_signature|unknown_kid)/);
  });

  it('still runs the rev 11 verify_resumption form', async () => {
    const scenario = {
      ...base,
      steps: [
        {
          verify_resumption: {
            resumption: { signature: 'x.y.z' },
            jwks: { keys: [] },
            expect: { tool_ref: 'ext:t', arg_digest: 'd' },
            result: 'malformed',
          },
        },
      ],
    } as unknown as Scenario;
    expect((await runScenario(scenario, depsWith(never))).failures).toEqual([]);
  });

  it("a control step saves the mock's answer, checks predicates over it, and holds every delivery to WebhookDelivery", async () => {
    const answers =
      (deliveries: unknown[]): typeof fetch =>
      (_input, init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >;
        return Promise.resolve(Response.json(body.reset === true ? {} : { ok: true, deliveries }));
      };
    const scenario = (predicates: unknown[]): Scenario =>
      ({
        ...base,
        steps: [
          {
            control: { deliveries: { webhook_id: 'wh_1' } },
            save: { first: 'deliveries.0.id' },
            expect_body: predicates,
          },
        ],
      }) as unknown as Scenario;
    const thin = { ...eventOf(DATA), signature: 'a.b.c' };
    const passed = await runScenario(
      scenario([
        { path: 'deliveries', length: 1 },
        { path: 'deliveries', lacks_key: 'arguments' },
      ]),
      depsWith(answers([thin]))
    );
    expect(passed.failures).toEqual([]);
    const leaking = { ...eventOf({ ...DATA, arguments: { a: 1 } }), signature: 'a.b.c' };
    const result = await runScenario(
      scenario([{ path: 'deliveries', lacks_key: 'arguments' }]),
      depsWith(answers([leaking]))
    );
    expect(result.failures.join('\n')).toMatch(
      /should hold no member named arguments at any depth/
    );
  });

  it('lacks_key finds a member at any depth, in an object or an array, and is a loaded operator', () => {
    const run = (value: unknown): string[] => {
      const failures: string[] = [];
      check({ path: '$', lacks_key: 'arguments' }, value, failures, 'step');
      return failures;
    };
    expect(run({ a: [{ b: { c: 1 } }] })).toEqual([]);
    expect(run({ a: [{ b: { arguments: {} } }] })).toHaveLength(1);
    expect(run([{ arguments: null }])).toHaveLength(1);
    expect(run('arguments')).toEqual([]);
    expect(() => {
      assertPredicates(
        {
          ...base,
          steps: [{ control: { reset: true }, expect_body: [{ path: 'a', lacks_key: 'x' }] }],
        } as unknown as Scenario,
        'f.yaml'
      );
    }).not.toThrow();
    expect(() => {
      assertPredicates(
        {
          ...base,
          steps: [{ control: { reset: true }, expect_body: [{ path: 'a' }] }],
        } as unknown as Scenario,
        'f.yaml'
      );
    }).toThrow(/needs a path/);
  });

  it('keys_exactly holds an object to its member names, in any order, and is a loaded operator', () => {
    const run = (value: unknown): string[] => {
      const failures: string[] = [];
      check({ path: '$', keys_exactly: ['a', 'b'] }, value, failures, 'step');
      return failures;
    };
    expect(run({ b: 1, a: 2 })).toEqual([]);
    expect(run({ a: 1, b: 2, c: 3 })).toHaveLength(1);
    expect(run({ a: 1 })).toHaveLength(1);
    expect(run({ a: 1, b: undefined, c: null })).toHaveLength(1);
    expect(run([{ a: 1, b: 2 }])).toHaveLength(1);
    expect(run(null)).toHaveLength(1);
    expect(run('ab')).toHaveLength(1);
    expect(() => {
      assertPredicates(
        {
          ...base,
          steps: [{ control: { reset: true }, expect_body: [{ path: 'a', keys_exactly: ['x'] }] }],
        } as unknown as Scenario,
        'f.yaml'
      );
    }).not.toThrow();
  });
});
