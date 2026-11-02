// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakePoliciesController } from '../testing/permissions-fake.js';
import type { EffectivePoliciesController } from '../use-effective-policies.js';
import { EffectiveBody } from './EffectiveAccess.js';
import { createPermissionsTranslate } from './permissions-labels.js';

afterEach(() => {
  cleanup();
});

const effective = (extra: Partial<EffectivePoliciesController>): EffectivePoliciesController => ({
  status: 'ready',
  basis: { kind: 'published' },
  composition: true,
  cells: new Map(),
  unsupportedSubjects: new Set(),
  round: 1,
  request: vi.fn(),
  setBasis: vi.fn(),
  retry: vi.fn(),
  ...extra,
});

describe('EffectiveBody', () => {
  const t = createPermissionsTranslate(undefined);
  it('falls back to the published policies when the draft basis names a draft no longer known (R-B1)', () => {
    const controller = fakePoliciesController();
    const gone = effective({ basis: { kind: 'draft', policyId: 'pol_gone', version: 3 } });
    render(<EffectiveBody controller={controller} effective={gone} t={t} />);
    expect(gone.setBasis).toHaveBeenCalledWith({ kind: 'published' });
    const draft = controller.drafts[0];
    if (draft === undefined) throw new Error('the fixture has a draft');
    const kept = effective({
      basis: { kind: 'draft', policyId: draft.policyId, version: draft.version },
    });
    render(<EffectiveBody controller={controller} effective={kept} t={t} />);
    expect(kept.setBasis).not.toHaveBeenCalled();
  });

  it('asks again for the rows on screen in a new round', () => {
    const controller = fakePoliciesController();
    const first = effective({});
    const { rerender } = render(<EffectiveBody controller={controller} effective={first} t={t} />);
    // Without IntersectionObserver every row is on screen.
    const asked = (first.request as ReturnType<typeof vi.fn>).mock.calls.flat(2) as {
      toolRef: string;
    }[];
    expect(new Set(asked.map((c) => c.toolRef))).toEqual(
      new Set(controller.tools.map((tool) => tool.toolRef))
    );
    const next = effective({ round: 2, request: first.request });
    (first.request as ReturnType<typeof vi.fn>).mockClear();
    rerender(<EffectiveBody controller={controller} effective={next} t={t} />);
    expect((first.request as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
});
