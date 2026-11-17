import { describe, expect, it } from 'vitest';

import {
  GITHUB_ERROR_CODES,
  NO_ARRIVAL,
  resolveInitialStep,
  type SetupArrival,
} from './arrival.js';

const arrival = (over: Partial<SetupArrival>): SetupArrival => ({ ...NO_ARRIVAL, ...over });

describe('resolveInitialStep', () => {
  it('is null with no arrival signal', () => {
    expect(resolveInitialStep(NO_ARRIVAL)).toBeNull();
  });
  it('a GitHub re-claim handoff opens github, before any step value', () => {
    expect(resolveInitialStep(arrival({ claim: {}, step: 'policy' }))).toBe('github');
  });
  it('a Core step key opens itself', () => {
    expect(resolveInitialStep(arrival({ step: 'policy' }))).toBe('policy');
    expect(resolveInitialStep(arrival({ step: 'admin' }))).toBe('admin');
  });
  it('integrations is github when the return names GitHub, else tools', () => {
    expect(resolveInitialStep(arrival({ step: 'integrations', connected: 'github' }))).toBe(
      'github'
    );
    expect(resolveInitialStep(arrival({ step: 'integrations', pending: 'github' }))).toBe('github');
    expect(resolveInitialStep(arrival({ step: 'integrations' }))).toBe('tools');
    expect(resolveInitialStep(arrival({ connected: 'slack' }))).toBe('tools');
    expect(resolveInitialStep(arrival({ pending: 'slack' }))).toBe('tools');
  });
  it('a GitHub install error code opens github; any other error opens tools', () => {
    for (const code of GITHUB_ERROR_CODES) {
      expect(resolveInitialStep(arrival({ error: code }))).toBe('github');
    }
    expect(resolveInitialStep(arrival({ error: 'unknown_error' }))).toBe('tools');
  });
  it('an unknown step value with nothing else is null', () => {
    expect(resolveInitialStep(arrival({ step: 'nonsense' }))).toBeNull();
  });
  it('a Checkout return opens people', () => {
    expect(resolveInitialStep(arrival({ checkoutReturn: true }))).toBe('people');
  });
  it('an integrations return wins over a Checkout return', () => {
    expect(resolveInitialStep(arrival({ step: 'integrations', checkoutReturn: true }))).toBe(
      'tools'
    );
  });
});

describe('GITHUB_ERROR_CODES', () => {
  it('is exactly the 12 codes the shell sends from the GitHub install path', () => {
    // Pinned literally so a dropped or added code is a deliberate change.
    expect([...GITHUB_ERROR_CODES].sort()).toEqual([
      'claim_store_unavailable',
      'github_app_not_configured',
      'github_app_signer_unavailable',
      'github_user_auth_failed',
      'github_user_auth_required',
      'installation_admin_required',
      'installation_choice_required',
      'installation_lookup_failed',
      'installation_not_found',
      'installation_not_owned',
      'installation_suspended',
      'invalid_installation_id',
    ]);
  });
});
