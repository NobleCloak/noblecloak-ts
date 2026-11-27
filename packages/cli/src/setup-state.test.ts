import { describe, expect, it } from 'vitest';
import { nextLines, tokenClaims } from './login.js';
import type { LoginHosts } from './login-config.js';
import { progressOf, parseSetupState } from './setup-state.js';
import { ORG, accessToken, freshSetup } from './login.test-support.js';

interface Row {
  key: string;
  state: string;
  availability: string;
}

/** `freshSetup()` with the named step keys changed. */
function withSteps(over: Record<string, string>, extra: Record<string, unknown> = {}) {
  const base = freshSetup();
  const steps = (base.steps as Row[]).map((s) =>
    s.key in over ? { ...s, state: over[s.key] } : s
  );
  return freshSetup({ steps, ...extra });
}

describe('the setup read, by the pill rule', () => {
  it('a fresh org has every screen left', () => {
    expect(progressOf(freshSetup())).toEqual({ kind: 'unfinished', left: 4, total: 4 });
  });

  it('counts a done screen out of the left', () => {
    expect(progressOf(withSteps({ tools: 'done' }, { app_authorized: { done: true } }))).toEqual({
      kind: 'unfinished',
      left: 3,
      total: 4,
    });
  });

  it('counts an own-agent fork by the stored fork, not the apps signals', () => {
    // An authorized app finishes Connect under apps; under own_agent only the agent's credentials do.
    const over = { app_authorized: { done: true } };
    expect(progressOf(withSteps({ tools: 'done' }, { ...over, fork: 'apps' }))).toEqual({
      kind: 'unfinished',
      left: 3,
      total: 4,
    });
    expect(progressOf(withSteps({ tools: 'done' }, { ...over, fork: 'own_agent' }))).toEqual({
      kind: 'unfinished',
      left: 4,
      total: 4,
    });
  });

  it('is finished when the first run is complete', () => {
    const done = withSteps(
      { tools: 'done', policy: 'done', ai_client: 'done' },
      { app_authorized: { done: true } }
    );
    expect(progressOf(done)).toEqual({ kind: 'finished' });
  });

  it('is finished when the checklist was dismissed', () => {
    expect(progressOf(freshSetup({ dismissed: true }))).toEqual({ kind: 'finished' });
  });

  it('is unreadable, never finished, when the body has no step list or no dismissed flag', () => {
    expect(progressOf(undefined)).toEqual({ kind: 'unreadable' });
    expect(progressOf({ ...freshSetup(), steps: 'x' })).toEqual({ kind: 'unreadable' });
    expect(progressOf({ ...freshSetup(), dismissed: undefined })).toEqual({ kind: 'unreadable' });
  });

  it('degrades an unknown state, availability, intent and signal as the rule documents', () => {
    const parsed = parseSetupState({
      steps: [{ key: 'tools', state: 'weird', availability: 'strange' }],
      intent: 'galaxy',
      fork: 'sideways',
      dismissed: false,
      app_authorized: { done: null },
    });
    expect(parsed?.state.steps).toEqual([
      { key: 'tools', state: 'unknown', availability: 'disabled' },
    ]);
    expect(parsed?.state.intent).toBeNull();
    expect(parsed?.state.app_authorized).toEqual({ done: null });
    expect(parsed?.state.setup_proposal_approved).toEqual({ done: null });
    expect(parsed?.fork).toBeUndefined();
  });

  it('refuses the whole body, as the shell schema does, for a step that is not an object with a string key', () => {
    const good = { key: 'tools', state: 'done', availability: 'live' };
    for (const bad of [{ key: 7, state: 'done' }, 'junk', null]) {
      expect(progressOf({ ...freshSetup(), steps: [good, bad] })).toEqual({ kind: 'unreadable' });
    }
  });

  it('refuses the whole body for a signal that is present but not { done: boolean | null }', () => {
    for (const bad of [{ done: 'yes' }, {}, null, 'x', { done: undefined }]) {
      for (const member of ['app_authorized', 'setup_proposal_approved', 'held_action_decided']) {
        expect(progressOf({ ...freshSetup(), [member]: bad })).toEqual({ kind: 'unreadable' });
      }
    }
    expect(progressOf({ ...freshSetup(), app_authorized: { done: null } }).kind).toBe('unfinished');
    expect(progressOf({ ...freshSetup(), app_authorized: undefined }).kind).toBe('unfinished');
  });
});

describe('the Next line', () => {
  const hosts: LoginHosts = {
    authUrl: 'https://auth.example.com',
    origin: 'https://auth.example.com',
    adminAudience: 'urn:admin',
    appUrl: 'https://app.example.com',
  };

  it('names the count, the command and the /setup URL for an unfinished org', () => {
    expect(nextLines(hosts, { kind: 'unfinished', left: 3, total: 6 })).toEqual([
      'Next: finish setup (3 of 6 steps left)',
      '  noblecloak setup   or   https://app.example.com/setup',
    ]);
  });

  it('names only the command when the deployment has no known app', () => {
    expect(
      nextLines({ ...hosts, appUrl: undefined }, { kind: 'unfinished', left: 1, total: 4 })
    ).toEqual(['Next: finish setup (1 of 4 steps left)', '  noblecloak setup']);
  });

  it.each(['finished', 'not_admin', 'rejected', 'unreadable'] as const)(
    'has no Next line for %s',
    (kind) => {
      expect(nextLines(hosts, { kind })).toEqual([]);
    }
  );
});

describe('the claims read from an access token', () => {
  it('reads the organization and the person', () => {
    expect(tokenClaims(accessToken())).toEqual({ orgId: ORG, sub: 'user-sub-1' });
  });

  it('lower-cases the organization id and drops one that is not a UUID', () => {
    expect(tokenClaims(accessToken({ org_id: ORG.toUpperCase() })).orgId).toBe(ORG);
    expect(tokenClaims(accessToken({ org_id: 'not-a-uuid' })).orgId).toBeUndefined();
  });

  it('never throws on a token that is not a JWT', () => {
    expect(tokenClaims('opaque')).toEqual({});
    expect(tokenClaims('a.!!!.c')).toEqual({});
    expect(tokenClaims(`a.${Buffer.from('"text"').toString('base64url')}.c`)).toEqual({});
  });
});
