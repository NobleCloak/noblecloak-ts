// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { UsePoliciesOptions } from '../permissions-types.js';
import { axe } from '../testing/axe.js';
import {
  inProcessFetch,
  jsonResponse,
  recorder,
  startHarness,
} from '../testing/approvals-harness.js';
import type { Harness, Recorder } from '../testing/approvals-harness.js';
import { usePolicies } from '../use-policies.js';
import { EffectiveAccess } from './EffectiveAccess.js';
import { Permissions } from './Permissions.js';

/** The effective view on the real hooks over the in-process mock (jsdom has no IntersectionObserver: every row is asked for). */
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});
afterEach(() => {
  cleanup();
});

function Probe({ options, standalone }: { options: UsePoliciesOptions; standalone?: boolean }) {
  const controller = usePolicies(options);
  return standalone === true ? (
    <EffectiveAccess controller={controller} />
  ) : (
    <Permissions controller={controller} />
  );
}

const options = (rec: Recorder, token: string, extra: Partial<UsePoliciesOptions> = {}) => ({
  baseUrl: h.baseUrl,
  getToken: () => token,
  fetch: rec.fetch,
  roles: [{ id: 'member' }],
  ...extra,
});

const simulations = (rec: Recorder): number =>
  rec.calls.filter((c) => c.path.endsWith('/simulate')).length;

const effectiveCell = (tool: string, column: string): HTMLElement => {
  const table = document.querySelector('table.nc-perm-effective');
  if (!(table instanceof HTMLTableElement)) throw new Error('no effective table');
  const index = [...table.querySelectorAll('thead th')].findIndex(
    (th) => th.textContent === column
  );
  const row = table.querySelector(`tr[data-tool="${tool}"]`);
  const cell = row?.children[index];
  if (!(cell instanceof HTMLElement)) throw new Error(`no cell ${tool} × ${column}`);
  return cell;
};

describe('Effective access', { timeout: 20_000 }, () => {
  it('shows, per role and tool, the decision and which subject and policy set it; nothing is sent before it is shown', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { container } = render(<Probe options={options(rec, h.tokens.admin)} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    expect(simulations(rec)).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Effective access' }));
    await screen.findByRole('table', { name: /which policies set it/ });
    await waitFor(() => {
      expect(effectiveCell('mcp:tracker:search', 'member').textContent).toContain(
        'Set by: role member · Ask the members before a call v3'
      );
    });
    expect(effectiveCell('mcp:tracker:search', 'member').textContent).toContain('step_up');
    await waitFor(() => {
      expect(effectiveCell('mcp:tracker:search', 'Organisation').textContent).toContain(
        'Set by: Deployment default (default)'
      );
    });
    expect(
      screen.getByRole('button', { name: 'Effective access' }).getAttribute('aria-pressed')
    ).toBe('true');
    await waitFor(() => {
      expect(container.querySelector('.nc-perm-effective td[data-state="loading"]')).toBeNull();
    });
    expect((await axe(container)).violations).toEqual([]);
  });

  it('without the composition rule advertised, lists what matched and claims nothing set it', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/capabilities') return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: { features: string[] } };
      return jsonResponse({
        ...body,
        data: {
          ...body.data,
          features: body.data.features.filter((f) => f !== 'policies.tightest_wins'),
        },
      });
    });
    render(<Probe options={options(rec, h.tokens.admin)} standalone />);
    await screen.findByRole('table', { name: /does not say how it combines policies/ });
    await waitFor(() => {
      expect(effectiveCell('mcp:tracker:search', 'member').textContent).toContain(
        'Matched: role member · Ask the members before a call v3 → ask'
      );
    });
    const table = document.querySelector('table.nc-perm-effective');
    expect(table?.textContent).not.toMatch(/Set by/);
  });

  it('a member sees a neutral note after one refused dry run, and a host that says not an administrator sees no switch', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.member)} standalone />);
    await screen.findByText(/shown to administrators of the organisation only/);
    expect(simulations(rec)).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
    const quiet = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(quiet, h.tokens.admin, { readOnly: true })} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    expect(screen.queryByRole('button', { name: 'Effective access' })).toBeNull();
    expect(simulations(quiet)).toBe(0);
  });

  it('asks only for the rows on screen when the browser reports them', async () => {
    const observed: Element[] = [];
    let report: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | undefined;
    class FakeObserver {
      constructor(callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
        report = callback;
      }
      observe(target: Element): void {
        observed.push(target);
      }
      disconnect(): void {
        observed.length = 0;
      }
      unobserve(): void {
        // Not used by the view.
      }
    }
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
    try {
      const rec = recorder(inProcessFetch(h.mock));
      render(<Probe options={options(rec, h.tokens.admin)} standalone />);
      await screen.findByRole('table', { name: /which policies set it/ });
      await waitFor(() => {
        expect(observed.length).toBeGreaterThan(2);
      });
      expect(simulations(rec)).toBe(0);
      const row = observed.find((el) => (el as HTMLElement).dataset.tool === 'mcp:tracker:search');
      if (row === undefined || report === undefined) throw new Error('row not observed');
      report([{ target: row, isIntersecting: true }]);
      await waitFor(() => {
        expect(effectiveCell('mcp:tracker:search', 'member').textContent).toContain('Set by');
        expect(effectiveCell('mcp:tracker:search', 'Organisation').textContent).toContain('Set by');
      });
      // One row, two columns.
      expect(
        new Set(
          rec.calls
            .filter((c) => c.path.endsWith('/simulate'))
            .map((c) => (c.body as { action: { tool_ref: string } }).action.tool_ref)
        )
      ).toEqual(new Set(['mcp:tracker:search']));
      expect(simulations(rec)).toBe(2);
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });

  it('offers no switch to a host that passes readOnly where authoring is not offered (merge gate)', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept(async (c, request) => {
      if (c.path !== '/v1/capabilities') return undefined;
      const answer = await h.mock.app.fetch(request);
      const body = (await answer.json()) as { data: { features: string[] } };
      return jsonResponse({
        ...body,
        data: {
          ...body.data,
          features: body.data.features.filter((f) => f !== 'policies.author'),
        },
      });
    });
    render(<Probe options={options(rec, h.tokens.admin, { readOnly: true })} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    expect(screen.queryByRole('button', { name: 'Effective access' })).toBeNull();
    expect(simulations(rec)).toBe(0);
  });

  it('switches back to the policies', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    render(<Probe options={options(rec, h.tokens.admin)} />);
    await screen.findByRole('table', { name: /Tool policies by role/ });
    const group = screen.getByRole('group', { name: 'Show' });
    await userEvent.click(within(group).getByRole('button', { name: 'Effective access' }));
    await screen.findByRole('table', { name: /which policies set it/ });
    await userEvent.click(within(group).getByRole('button', { name: 'Policies' }));
    await screen.findByRole('table', { name: /Tool policies by role/ });
  });
});
