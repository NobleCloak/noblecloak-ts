import { describe, expect, it } from 'vitest';

import { NO_ARRIVAL, type SetupArrival } from './arrival.js';
import { resolveWizardStart } from './start.js';
import {
  WIZARD_EVENT_STEP_KEYS,
  WIZARD_STEPS,
  WIZARD_STEP_IDS,
  agentCredentials,
  firstRunComplete,
  firstUnfinished,
  inferFork,
  scanShown,
  toolsConnected,
  wizardStepIds,
  wizardSteps,
} from './steps.js';
import { allDone, githubOnlyState, setupState, steps } from './fixtures.test-support.js';
import { isSetupStepKey, type SetupState } from './types.js';

// Ported from noblesos-team src/lib/wizardModel.test.ts @ fef4965: the rule's cases, with the
// copy, polling and waiting cases left in team (they are not part of this package).

const arrival = (over: Partial<SetupArrival>): SetupArrival => ({ ...NO_ARRIVAL, ...over });
const status = (s: SetupState, id: string): string | undefined =>
  wizardSteps(s).find((w) => w.id === id)?.status;

describe('wizardStepIds', () => {
  it('adds Invite only for the team intent', () => {
    expect(wizardStepIds('team')).toEqual(['connect', 'approve', 'invite', 'try', 'proof']);
    expect(wizardStepIds('solo')).toEqual(['connect', 'approve', 'try', 'proof']);
    expect(wizardStepIds('company')).toEqual(['connect', 'approve', 'try', 'proof']);
  });
  it('reads an unknown (null) intent as the base steps', () => {
    expect(wizardStepIds(null)).toEqual(['connect', 'approve', 'try', 'proof']);
  });
});

describe('connect status (apps fork)', () => {
  it('is done only when a tool is connected and an app is authorized', () => {
    expect(status(allDone(), 'connect')).toBe('done');
  });
  it('is todo when the tool is connected but no app is authorized yet', () => {
    expect(
      status(
        setupState({ steps: steps({ tools: { state: 'done' } }), app_authorized: { done: false } }),
        'connect'
      )
    ).toBe('todo');
  });
  it('is todo, not done, when an app is authorized but no tool is connected', () => {
    expect(status(setupState({ app_authorized: { done: true } }), 'connect')).toBe('todo');
  });
  it('is unknown, never done, when Core could not answer the authorization (null) or the tools check', () => {
    expect(
      status(
        setupState({ steps: steps({ tools: { state: 'done' } }), app_authorized: { done: null } }),
        'connect'
      )
    ).toBe('unknown');
    expect(
      status(
        setupState({
          steps: steps({ tools: { state: 'unknown' } }),
          app_authorized: { done: true },
        }),
        'connect'
      )
    ).toBe('unknown');
  });
  it('treats a skipped tools step as still to do', () => {
    expect(
      status(
        setupState({
          steps: steps({ tools: { state: 'skipped' } }),
          app_authorized: { done: true },
        }),
        'connect'
      )
    ).toBe('todo');
  });
});

describe('connect status with GitHub as the only tool (Core derives tools todo, github done)', () => {
  it('counts github done as a connected tool', () => {
    expect(toolsConnected(githubOnlyState())).toBe('done');
    expect(status(githubOnlyState({ app_authorized: { done: true } }), 'connect')).toBe('done');
    expect(status(githubOnlyState({ app_authorized: { done: false } }), 'connect')).toBe('todo');
    expect(status(githubOnlyState({ app_authorized: { done: null } }), 'connect')).toBe('unknown');
  });
  it('is todo when neither tools nor github is done, and unknown wins when either is unknown', () => {
    expect(toolsConnected(setupState())).toBe('todo');
    expect(
      toolsConnected(
        setupState({ steps: steps({ tools: { state: 'skipped' }, github: { state: 'skipped' } }) })
      )
    ).toBe('todo');
    expect(toolsConnected(setupState({ steps: steps({ tools: { state: 'unknown' } }) }))).toBe(
      'unknown'
    );
    expect(toolsConnected(setupState({ steps: steps({ github: { state: 'unknown' } }) }))).toBe(
      'unknown'
    );
    expect(
      status(
        setupState({
          steps: steps({ github: { state: 'unknown' } }),
          app_authorized: { done: true },
        }),
        'connect'
      )
    ).toBe('unknown');
  });
  it('a done step beats an unknown one', () => {
    expect(
      toolsConnected(
        setupState({ steps: steps({ tools: { state: 'unknown' }, github: { state: 'done' } }) })
      )
    ).toBe('done');
    expect(
      toolsConnected(
        setupState({ steps: steps({ tools: { state: 'done' }, github: { state: 'unknown' } }) })
      )
    ).toBe('done');
  });
});

describe('other statuses', () => {
  it('approve reads policy, try reads ai_client, invite reads people; unknown stays unknown', () => {
    const s = setupState({
      steps: steps({
        policy: { state: 'done' },
        ai_client: { state: 'unknown' },
        people: { state: 'skipped' },
      }),
    });
    expect(status(s, 'approve')).toBe('done');
    expect(status(s, 'try')).toBe('unknown');
    expect(status(s, 'invite')).toBe('skipped');
  });
  it('a skipped policy or ai_client is to do: only Invite can be skipped here', () => {
    const s = setupState({
      steps: steps({ policy: { state: 'skipped' }, ai_client: { state: 'skipped' } }),
    });
    expect(status(s, 'approve')).toBe('todo');
    expect(status(s, 'try')).toBe('todo');
  });
  it('a step missing from Core is unknown', () => {
    expect(status(setupState({ steps: [] }), 'approve')).toBe('unknown');
  });
  it('carries the availability of the Core step a screen reads', () => {
    const s = setupState({ steps: steps({ people: { availability: 'disabled' } }) });
    expect(wizardSteps(s).find((w) => w.id === 'invite')?.availability).toBe('disabled');
    expect(wizardSteps(s).find((w) => w.id === 'proof')?.availability).toBe('live');
  });
});

describe('firstUnfinished / firstRunComplete / reachable', () => {
  it('picks the first screen that is not done or skipped', () => {
    expect(firstUnfinished(wizardSteps(setupState()))).toBe('connect');
    const s = setupState({
      steps: steps({ tools: { state: 'done' }, people: { state: 'skipped' } }),
      app_authorized: { done: true },
    });
    expect(firstUnfinished(wizardSteps(s))).toBe('approve');
  });
  it('stops on an unknown screen rather than passing it', () => {
    const s = setupState({
      steps: steps({ tools: { state: 'done' }, policy: { state: 'unknown' } }),
      app_authorized: { done: true },
    });
    expect(firstUnfinished(wizardSteps(s))).toBe('approve');
  });
  it('is proof when every earlier screen is finished', () => {
    expect(firstUnfinished(wizardSteps(allDone()))).toBe('proof');
  });
  it('first run is complete when every required screen is done; Invite does not gate it', () => {
    expect(firstRunComplete(wizardSteps(allDone({ intent: 'team' })))).toBe(true);
    expect(
      firstRunComplete(
        wizardSteps(
          allDone({
            intent: 'team',
            steps: steps({
              tools: { state: 'done' },
              policy: { state: 'done' },
              ai_client: { state: 'done' },
            }),
          })
        )
      )
    ).toBe(true);
    expect(
      firstRunComplete(
        wizardSteps(
          allDone({
            steps: steps({
              tools: { state: 'done' },
              policy: { state: 'done' },
              ai_client: { state: 'unknown' },
            }),
          })
        )
      )
    ).toBe(false);
    expect(firstRunComplete(wizardSteps(setupState()))).toBe(false);
  });
});

/** A caller's richer object: Core's own `done` rides along and the rule never reads it. */
const withCoreDone = (s: SetupState, done: boolean): SetupState & { done: boolean } => ({
  ...s,
  done,
});

describe('resolveWizardStart', () => {
  const fresh = setupState({ intent: 'team' });
  it('opens the first unfinished screen with no arrival', () => {
    expect(resolveWizardStart(NO_ARRIVAL, fresh)).toEqual({ view: 'wizard', step: 'connect' });
  });
  it('maps Core step keys to the screen covering them', () => {
    expect(resolveWizardStart(arrival({ step: 'tools' }), fresh)).toEqual({
      view: 'wizard',
      step: 'connect',
    });
    expect(resolveWizardStart(arrival({ step: 'github' }), fresh)).toEqual({
      view: 'wizard',
      step: 'connect',
    });
    expect(resolveWizardStart(arrival({ step: 'policy' }), fresh)).toEqual({
      view: 'wizard',
      step: 'approve',
    });
    expect(resolveWizardStart(arrival({ step: 'first_tool' }), fresh)).toEqual({
      view: 'wizard',
      step: 'approve',
    });
    expect(resolveWizardStart(arrival({ step: 'people' }), fresh)).toEqual({
      view: 'wizard',
      step: 'invite',
    });
    expect(resolveWizardStart(arrival({ step: 'ai_client' }), fresh)).toEqual({
      view: 'wizard',
      step: 'try',
    });
  });
  it('maps the one alias: integrations is GitHub when connected, else tools; both are Connect', () => {
    expect(
      resolveWizardStart(arrival({ step: 'integrations', connected: 'github' }), fresh)
    ).toEqual({ view: 'wizard', step: 'connect' });
    expect(resolveWizardStart(arrival({ step: 'integrations' }), fresh)).toEqual({
      view: 'wizard',
      step: 'connect',
    });
  });
  it('opens the first unfinished screen for admin and for an unknown step value, never an error', () => {
    const later = setupState({
      steps: steps({ tools: { state: 'done' } }),
      app_authorized: { done: true },
    });
    expect(resolveWizardStart(arrival({ step: 'admin' }), later)).toEqual({
      view: 'wizard',
      step: 'approve',
    });
    expect(resolveWizardStart(arrival({ step: 'nonsense' }), later)).toEqual({
      view: 'wizard',
      step: 'approve',
    });
  });
  it('opens All steps for a key with no screen, and for people when Invite is not shown', () => {
    expect(resolveWizardStart(arrival({ step: 'sso' }), fresh)).toEqual({ view: 'all' });
    expect(resolveWizardStart(arrival({ step: 'automation' }), fresh)).toEqual({ view: 'all' });
    expect(resolveWizardStart(arrival({ step: 'people' }), setupState({ intent: 'solo' }))).toEqual(
      { view: 'all' }
    );
  });
  it('a Checkout return opens Invite for team and All steps otherwise', () => {
    expect(resolveWizardStart(arrival({ checkoutReturn: true }), fresh)).toEqual({
      view: 'wizard',
      step: 'invite',
    });
    expect(
      resolveWizardStart(arrival({ checkoutReturn: true }), setupState({ intent: 'solo' }))
    ).toEqual({ view: 'all' });
  });
  it('opens All steps once the first run is complete or the setup is dismissed', () => {
    expect(resolveWizardStart(NO_ARRIVAL, allDone())).toEqual({ view: 'all' });
    expect(resolveWizardStart(NO_ARRIVAL, setupState({ dismissed: true }))).toEqual({
      view: 'all',
    });
  });
  it("does not open All steps on Core's done alone: the wizard is judged by its own required screens", () => {
    expect(resolveWizardStart(NO_ARRIVAL, withCoreDone(setupState(), true))).toEqual({
      view: 'wizard',
      step: 'connect',
    });
  });
  it('opens All steps for a complete first run even when Core is not done', () => {
    expect(resolveWizardStart(NO_ARRIVAL, withCoreDone(allDone(), false))).toEqual({ view: 'all' });
  });
});

describe('WIZARD_STEPS structure', () => {
  it('keys each definition by its own id', () => {
    for (const [id, def] of Object.entries(WIZARD_STEPS)) expect(def.id).toBe(id);
    expect(Object.keys(WIZARD_STEPS)).toEqual([...WIZARD_STEP_IDS]);
  });
  it('only Scan and Invite are optional among the screens with a Core step', () => {
    expect(
      Object.values(WIZARD_STEPS)
        .filter((d) => !d.required && d.keys.length > 0)
        .map((d) => d.id)
    ).toEqual(['scan', 'invite']);
  });
  it('a screen has a Skip only when it is optional, and Skip writes the Core step it reads', () => {
    for (const def of Object.values(WIZARD_STEPS)) {
      if (def.skipKey === null) continue;
      expect(def.required).toBe(false);
      expect(def.keys[0]).toBe(def.skipKey);
    }
    expect(WIZARD_STEPS.scan.skipKey).toBe('discover');
    expect(WIZARD_STEPS.invite.skipKey).toBe('people');
  });
});

describe('WIZARD_EVENT_STEP_KEYS', () => {
  it('lists the event keys in screen order with the entry screen first (noblesos-shell#115 reads it), and scan last', () => {
    expect(WIZARD_EVENT_STEP_KEYS[0]).toBe(WIZARD_STEPS.connect.eventKey);
    expect(WIZARD_EVENT_STEP_KEYS.at(-1)).toBe('scan');
    const screens = WIZARD_STEP_IDS.filter((id) => id !== 'scan').map(
      (id) => WIZARD_STEPS[id].eventKey
    );
    expect([...WIZARD_EVENT_STEP_KEYS]).toEqual([...screens, WIZARD_STEPS.scan.eventKey]);
  });
  it('is Core step keys except proof and scan, which have no Core step of that name', () => {
    expect(
      WIZARD_EVENT_STEP_KEYS.filter((k) => k !== 'proof' && k !== 'scan').every((k) =>
        isSetupStepKey(k)
      )
    ).toBe(true);
    expect(isSetupStepKey('proof')).toBe(false);
    expect(isSetupStepKey('scan')).toBe(false);
    expect(WIZARD_STEPS.scan.keys).toEqual(['discover']);
  });
  it("keeps every key within Core's step_key pattern", () => {
    for (const k of WIZARD_EVENT_STEP_KEYS) expect(k).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
  });
  it('is every event key a screen sends, and nothing else', () => {
    expect([...WIZARD_EVENT_STEP_KEYS].sort()).toEqual(
      Object.values(WIZARD_STEPS)
        .map((d) => d.eventKey)
        .sort()
    );
  });
});

describe('Scan screen', () => {
  const withDiscover = (
    availability: 'live' | 'coming_soon' | 'assisted' | 'disabled',
    state: 'todo' | 'done' | 'skipped' | 'unknown' = 'todo'
  ): SetupState => setupState({ steps: steps({ discover: { availability, state } }) });

  it('is hidden while Core reports discover coming_soon (the production state today), and for every non-live availability', () => {
    expect(wizardStepIds('team', scanShown(setupState()))).not.toContain('scan');
    expect(wizardSteps(setupState()).map((s) => s.id)).toEqual([
      'connect',
      'approve',
      'invite',
      'try',
      'proof',
    ]);
    for (const a of ['coming_soon', 'assisted', 'disabled'] as const) {
      expect(scanShown(withDiscover(a))).toBe(false);
    }
  });
  it('is hidden when the discover step is absent', () => {
    expect(scanShown(setupState({ steps: steps().filter((s) => s.key !== 'discover') }))).toBe(
      false
    );
  });
  it('shows before Connect when discover is live', () => {
    expect(wizardSteps(withDiscover('live')).map((s) => s.id)).toEqual([
      'scan',
      'connect',
      'approve',
      'invite',
      'try',
      'proof',
    ]);
    expect(wizardStepIds('solo', true)).toEqual(['scan', 'connect', 'approve', 'try', 'proof']);
  });
  it("reads Core's discover step as it is, and never derives done", () => {
    expect(status(withDiscover('live', 'todo'), 'scan')).toBe('todo');
    expect(status(withDiscover('live', 'done'), 'scan')).toBe('done');
    expect(status(withDiscover('live', 'skipped'), 'scan')).toBe('skipped');
    expect(status(withDiscover('live', 'unknown'), 'scan')).toBe('unknown');
  });
  it('is optional: it never blocks first-run completion, and a todo Scan does not make the run incomplete', () => {
    const live = allDone({
      steps: steps({
        tools: { state: 'done' },
        policy: { state: 'done' },
        ai_client: { state: 'done' },
        people: { state: 'done' },
        discover: { availability: 'live', state: 'todo' },
      }),
    });
    expect(wizardSteps(live).find((s) => s.id === 'scan')?.required).toBe(false);
    expect(firstRunComplete(wizardSteps(live))).toBe(true);
    expect(resolveWizardStart(NO_ARRIVAL, live)).toEqual({ view: 'all' });
  });
  it('opens first on a fresh org when live and todo, and Connect once it is done or skipped', () => {
    expect(firstUnfinished(wizardSteps(withDiscover('live')))).toBe('scan');
    expect(firstUnfinished(wizardSteps(withDiscover('live', 'skipped')))).toBe('connect');
    expect(firstUnfinished(wizardSteps(withDiscover('live', 'done')))).toBe('connect');
  });
  it('opens from ?step=discover only when Scan is shown, else All steps', () => {
    expect(resolveWizardStart(arrival({ step: 'discover' }), withDiscover('live'))).toEqual({
      view: 'wizard',
      step: 'scan',
    });
    expect(resolveWizardStart(arrival({ step: 'discover' }), setupState())).toEqual({
      view: 'all',
    });
  });
  it('carries the discover availability for the screen', () => {
    expect(wizardSteps(withDiscover('live')).find((s) => s.id === 'scan')?.availability).toBe(
      'live'
    );
  });
});

describe('own-agent fork', () => {
  const own = (s: SetupState, id: string): string | undefined =>
    wizardSteps(s, 'own_agent').find((w) => w.id === id)?.status;
  const agent = (over: Partial<SetupState> = {}): SetupState =>
    setupState({
      steps: steps({ tools: { state: 'done' }, automation: { state: 'done' } }),
      ...over,
    });

  it('Connect is done with a tool and an active service principal (Core automation), not with an app grant', () => {
    expect(own(agent(), 'connect')).toBe('done');
    expect(
      own(
        setupState({ steps: steps({ tools: { state: 'done' } }), app_authorized: { done: true } }),
        'connect'
      )
    ).toBe('todo');
  });
  it('Connect needs a tool: a service principal alone is todo, and an unknown tools check wins', () => {
    expect(own(setupState({ steps: steps({ automation: { state: 'done' } }) }), 'connect')).toBe(
      'todo'
    );
    expect(
      own(
        setupState({
          steps: steps({ tools: { state: 'unknown' }, automation: { state: 'done' } }),
        }),
        'connect'
      )
    ).toBe('unknown');
  });
  it('reads a skipped or dismissed Automation step as todo and an unknown one as unknown, never done', () => {
    for (const state of ['skipped', 'dismissed', 'todo'] as const) {
      expect(agentCredentials(setupState({ steps: steps({ automation: { state } }) }))).toBe(
        'todo'
      );
    }
    expect(
      agentCredentials(setupState({ steps: steps({ automation: { state: 'unknown' } }) }))
    ).toBe('unknown');
    expect(
      agentCredentials(setupState({ steps: steps().filter((x) => x.key !== 'automation') }))
    ).toBe('unknown');
  });
  it('Approve reads setup_proposal_approved and Try it reads held_action_decided; null is unknown', () => {
    const a = (p: boolean | null, h: boolean | null): SetupState =>
      agent({ setup_proposal_approved: { done: p }, held_action_decided: { done: h } });
    expect(own(a(true, false), 'approve')).toBe('done');
    expect(own(a(false, true), 'approve')).toBe('todo');
    expect(own(a(null, null), 'approve')).toBe('unknown');
    expect(own(a(false, true), 'try')).toBe('done');
    expect(own(a(true, false), 'try')).toBe('todo');
    expect(own(a(null, null), 'try')).toBe('unknown');
  });
  it('ignores the apps-fork steps: policy and ai_client done do not finish Approve or Try it', () => {
    const s = agent({
      steps: steps({
        tools: { state: 'done' },
        policy: { state: 'done' },
        ai_client: { state: 'done' },
      }),
    });
    expect(own(s, 'approve')).toBe('todo');
    expect(own(s, 'try')).toBe('todo');
    expect(status(s, 'approve')).toBe('done');
  });
  it('first run completes on the own-agent signals, and an unknown one never completes it', () => {
    const done = agent({
      setup_proposal_approved: { done: true },
      held_action_decided: { done: true },
    });
    expect(firstRunComplete(wizardSteps(done, 'own_agent'))).toBe(true);
    expect(
      firstRunComplete(wizardSteps({ ...done, held_action_decided: { done: null } }, 'own_agent'))
    ).toBe(false);
  });
  it('keeps every screen event key, Core keys, Skip and required-ness on the own-agent fork', () => {
    const list = wizardSteps(agent(), 'own_agent');
    expect(list.length).toBeGreaterThan(0);
    for (const w of list) {
      const base = WIZARD_STEPS[w.id];
      expect(w.eventKey).toBe(base.eventKey);
      expect(w.keys).toEqual(base.keys);
      expect(w.skipKey).toBe(base.skipKey);
      expect(w.required).toBe(base.required);
    }
  });
  it('the step list and ids are the same on both forks', () => {
    const s = agent();
    expect(wizardSteps(s, 'own_agent').map((w) => w.id)).toEqual(
      wizardSteps(s, 'apps').map((w) => w.id)
    );
  });

  describe('a state complete under both forks', () => {
    const both = setupState({
      steps: steps({
        tools: { state: 'done' },
        policy: { state: 'done' },
        ai_client: { state: 'done' },
        automation: { state: 'done' },
      }),
      app_authorized: { done: true },
      setup_proposal_approved: { done: true },
      held_action_decided: { done: true },
    });

    it('reads own_agent, and every screen reports the own_agent fork', () => {
      expect(firstRunComplete(wizardSteps(both, 'apps'))).toBe(true);
      expect(firstRunComplete(wizardSteps(both, 'own_agent'))).toBe(true);
      expect(inferFork(both)).toBe('own_agent');
      const screens = wizardSteps(both);
      expect(screens.length).toBeGreaterThan(0);
      expect(screens.every((s) => s.fork === 'own_agent')).toBe(true);
    });
  });

  describe('inferFork', () => {
    const approved = {
      done: true,
      first_done_at: '2026-11-17T10:05:00Z',
      first_done_at_source: 'core_observed',
    } as const;
    const ownRun = (over: Partial<SetupState> = {}): SetupState =>
      agent({ setup_proposal_approved: approved, held_action_decided: approved, ...over });

    it('is apps by default, and own_agent from an approved setup proposal or a decided held action', () => {
      expect(inferFork(setupState())).toBe('apps');
      expect(inferFork(agent({ setup_proposal_approved: approved }))).toBe('own_agent');
      expect(inferFork(agent({ held_action_decided: approved }))).toBe('own_agent');
    });
    it('an active service principal alone is apps: a CI principal or the free-tier lane does not make an own-agent org', () => {
      expect(inferFork(agent())).toBe('apps');
      expect(wizardSteps(agent()).every((w) => w.fork === 'apps')).toBe(true);
    });
    it('an open setup proposal alone is apps (the rule does not read it)', () => {
      // The rule does not read `detail`; a caller's richer object carries it through untouched.
      const open = { obligation_id: 'o', opened_at: '2026-11-17T10:00:00Z' };
      const s = { ...agent(), detail: { open_setup_proposal: open } };
      expect(inferFork(s)).toBe('apps');
    });
    it('unanswered outcomes (done: null) are not evidence', () => {
      expect(
        inferFork(
          agent({ setup_proposal_approved: { done: null }, held_action_decided: { done: null } })
        )
      ).toBe('apps');
    });
    it('a finished own-agent run stays complete when the service principal expires', () => {
      const expired = ownRun({
        steps: steps({ tools: { state: 'done' }, automation: { state: 'todo' } }),
      });
      expect(inferFork(expired)).toBe('own_agent');
      // Connect reads todo again (no active principal), but Approve and Try it are still read as the own-agent signals.
      const s = wizardSteps(expired);
      expect(s.every((w) => w.fork === 'own_agent')).toBe(true);
      expect(s.find((w) => w.id === 'approve')?.status).toBe('done');
      expect(s.find((w) => w.id === 'try')?.status).toBe('done');
    });
    it('a finished own-agent run does not regress to the apps reading when an app is authorized later', () => {
      const s = ownRun({ app_authorized: { done: true } });
      expect(inferFork(s)).toBe('own_agent');
      expect(firstRunComplete(wizardSteps(s))).toBe(true);
    });
    it('a finished own-agent run is complete', () => {
      expect(firstRunComplete(wizardSteps(ownRun()))).toBe(true);
    });
    it('an apps org with a CI service principal opens on apps and its first run completes', () => {
      const s = allDone({
        steps: steps({
          tools: { state: 'done' },
          policy: { state: 'done' },
          ai_client: { state: 'done' },
          automation: { state: 'done' },
        }),
      });
      expect(inferFork(s)).toBe('apps');
      expect(firstRunComplete(wizardSteps(s))).toBe(true);
    });
    it('an org complete under apps never reads incomplete because an own-agent outcome also exists', () => {
      const s = allDone({ held_action_decided: approved });
      expect(firstRunComplete(wizardSteps(s, 'apps'))).toBe(true);
      expect(inferFork(s)).toBe('apps');
      expect(firstRunComplete(wizardSteps(s))).toBe(true);
    });
    it('is what wizardSteps uses when no fork is passed', () => {
      expect(wizardSteps(ownRun()).every((w) => w.fork === 'own_agent')).toBe(true);
      expect(wizardSteps(setupState()).every((w) => w.fork === 'apps')).toBe(true);
    });
  });
});
