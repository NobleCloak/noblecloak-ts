import { describe, expect, it } from 'vitest';

import { loadScenarios } from './scenarios.js';
import { formatSkipWarning } from './run.js';
import type { Report } from './types.js';

/** Every `as:` alias a scenario's steps act as, wherever it nests (a step, a stream step's requests). */
function actors(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const item of node) actors(item, found);
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'as' && typeof value === 'string') found.add(value);
      else actors(value, found);
    }
  }
  return found;
}

describe('the scenario corpus declares the approver it acts as', () => {
  it('every scenario with an `as: approver` step lists `approver` in `needs`, so a run without --approver-token skips it', () => {
    const undeclared = loadScenarios()
      .filter((s) => actors(s.steps).has('approver') && !(s.needs ?? []).includes('approver'))
      .map((s) => s.id);
    expect(undeclared).toEqual([]);
  });
});

/** Whether a request line authors a policy: create, replace or publish (rev 10). */
const authors = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(authors);
  if (node === null || typeof node !== 'object') return false;
  const { method, path } = node as { method?: unknown; path?: unknown };
  if (
    typeof method === 'string' &&
    typeof path === 'string' &&
    ((method === 'POST' && /^\/v1\/policies(\/[^/]+\/(publish|retire))?$/.test(path)) ||
      (method === 'PUT' && /^\/v1\/policies\/[^/]+$/.test(path)) ||
      // Rev 11: discarding a draft is the authors' too.
      (method === 'DELETE' && /^\/v1\/policies\/[^/]+\/draft$/.test(path)))
  )
    return true;
  return Object.values(node).some(authors);
};

describe('the scenario corpus declares the administrator it authors policies as (rev 10)', () => {
  it('every scenario that creates, replaces or publishes a policy lists `admin` in `needs`, so a run without --admin-token skips it instead of authoring as the creator', () => {
    const scenarios = loadScenarios();
    expect(scenarios.filter((s) => authors(s.steps)).length).toBeGreaterThan(5);
    const undeclared = scenarios
      .filter((s) => authors(s.steps) && !(s.needs ?? []).includes('admin'))
      .map((s) => s.id);
    expect(undeclared).toEqual([]);
  });
});

/**
 * The config members a deployment may refuse with 422 `unsupported_policy_form` when it does not implement
 * them for the kind (noblecloak-ui#60). The legality matrix allows them, but a deployment need not implement
 * them and may refuse them, so a scenario that expects success must not set them.
 */
const REFUSABLE_CONFIG_MEMBERS = ['expires_after', 'approver_groups'] as const;

/**
 * The body of every policy write (create or replace) a scenario sends that expects success and does not also
 * accept 422, the answer of a deployment that refuses a member it does not implement. The method is compared
 * case-insensitively and the path may carry a trailing slash or a query, so a spelling variant does not slip past.
 */
function successfulPolicyWrites(
  node: unknown,
  found: Record<string, unknown>[] = []
): Record<string, unknown>[] {
  if (Array.isArray(node)) for (const item of node) successfulPolicyWrites(item, found);
  else if (node !== null && typeof node === 'object') {
    const step = node as {
      request?: { method?: unknown; path?: unknown; body?: unknown };
      expect?: { status?: unknown };
    };
    const { method, path, body } = step.request ?? {};
    const statuses = Array.isArray(step.expect?.status)
      ? step.expect.status
      : [step.expect?.status];
    if (
      typeof method === 'string' &&
      typeof path === 'string' &&
      ((method.toUpperCase() === 'POST' && /^\/v1\/policies\/?(\?.*)?$/.test(path)) ||
        (method.toUpperCase() === 'PUT' && /^\/v1\/policies\/[^/?]+\/?(\?.*)?$/.test(path))) &&
      statuses.some((status) => typeof status === 'number' && status < 300) &&
      !statuses.includes(422) &&
      body !== null &&
      typeof body === 'object'
    )
      found.push(body as Record<string, unknown>);
    for (const value of Object.values(node)) successfulPolicyWrites(value, found);
  }
  return found;
}

describe('the scenario corpus asks no deployment to enforce a config member it may refuse (noblecloak-ui#60)', () => {
  it('the walker finds a write by method case, path variant, status list and nesting, and leaves out one that also accepts 422', () => {
    const write = (method: string, path: string, status: unknown) => ({
      request: { method, path, body: { config: { mode: 'ask', expires_after: 'PT1H' } } },
      expect: { status },
    });
    expect(
      successfulPolicyWrites([
        write('post', '/v1/policies', 201),
        write('POST', '/v1/policies/?x=1', [201]),
        write('PUT', '/v1/policies/pol_1/', 200),
        { stream_events: { during: [write('PUT', '/v1/policies/pol_2', [200, 409])] } },
      ])
    ).toHaveLength(4);
    expect(
      successfulPolicyWrites([
        write('POST', '/v1/policies', [201, 422]),
        write('POST', '/v1/policies/pol_1/publish', 200),
        write('POST', '/v1/policies', 400),
      ])
    ).toEqual([]);
  });

  it('no policy write that expects success sets expires_after or approver_groups, which a deployment that does not implement them refuses with 422', () => {
    const scenarios = loadScenarios();
    expect(scenarios.flatMap((s) => successfulPolicyWrites(s.steps)).length).toBeGreaterThan(5);
    const offending = scenarios.flatMap((s) =>
      successfulPolicyWrites(s.steps)
        .filter((body) => {
          const config = body.config;
          return (
            config !== null &&
            typeof config === 'object' &&
            REFUSABLE_CONFIG_MEMBERS.some((member) => member in config)
          );
        })
        .map(() => s.id)
    );
    expect(offending).toEqual([]);
  });
});

describe('the skip warning for an absent approver', () => {
  it('names --approver-token, and does not mistake it for the longer approver flags', () => {
    const skipped = (id: string, skipReason: string): Report['results'][number] => ({
      id,
      title: id,
      tags: ['both'],
      outcome: 'skipped',
      failures: [],
      skipReason,
      skipKind: 'unconfigured',
    });
    const report: Report = {
      deployment: 'hosted',
      results: [
        skipped('plain', 'no token for approver'),
        skipped('surface', 'no token for approver_surface_token'),
      ],
      passed: 0,
      failed: 0,
      skipped: 2,
      exercised: [],
    };
    const warning = formatSkipWarning(report);
    expect(warning).toContain('plain: no token for approver (pass --approver-token)');
    expect(warning).toContain(
      'surface: no token for approver_surface_token (pass --approver-surface-token)'
    );
  });

  it('names the fixture flags beside the token flags when the every-route check names both (rev 11)', () => {
    const report: Report = {
      deployment: 'hosted',
      results: [
        {
          id: 'every-route-responds-per-schema',
          title: 'coverage',
          tags: ['both'],
          outcome: 'skipped',
          failures: [],
          skipReason:
            'no token for admin; no fixture for connection_server_url, oauth_return_to: 3 routes not exercised (refreshConnection)',
          skipKind: 'unconfigured',
        },
      ],
      passed: 0,
      failed: 0,
      skipped: 1,
      exercised: [],
    };
    expect(formatSkipWarning(report)).toContain(
      '(pass --admin-token, --connection-server-url, --oauth-return-to)'
    );
  });
});

/** Whether a request line registers origins or manages webhooks (rev 12): the administrator's, wherever it nests. */
const managesOrganisation = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(managesOrganisation);
  if (node === null || typeof node !== 'object') return false;
  const { method, path } = node as { method?: unknown; path?: unknown };
  if (
    typeof method === 'string' &&
    typeof path === 'string' &&
    ((method === 'PUT' && /^\/v1\/origins$/.test(path)) ||
      (method === 'POST' && /^\/v1\/webhooks$/.test(path)) ||
      (method === 'DELETE' && /^\/v1\/webhooks\/[^/]+$/.test(path)))
  )
    return true;
  return Object.values(node).some(managesOrganisation);
};

describe('the scenario corpus declares the administrator it registers origins and manages webhooks as (rev 12)', () => {
  it('every scenario that writes origins or creates or deletes a webhook lists `admin` in `needs`, so a run without --admin-token skips it instead of acting as the creator and being refused', () => {
    const scenarios = loadScenarios();
    expect(scenarios.filter((s) => managesOrganisation(s.steps)).length).toBeGreaterThan(15);
    const undeclared = scenarios
      .filter((s) => managesOrganisation(s.steps) && !(s.needs ?? []).includes('admin'))
      .map((s) => s.id);
    expect(undeclared).toEqual([]);
  });
});
