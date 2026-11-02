import { describe, expect, it } from 'vitest';

import { createPermissionsTranslate } from './permissions-labels.js';
import { subjectTextWith } from './permissions-parts.js';
import type { SubjectLabel } from './permissions-parts.js';

const t = createPermissionsTranslate(undefined);

describe('subjectTextWith', () => {
  it('writes a subject by type and id without a label, and the organisation in words', () => {
    const text = subjectTextWith(t, undefined);
    expect(text({ type: 'user', id: 'u1' })).toBe('user u1');
    expect(text({ type: 'organization' })).toBe(t('subjectOrganisation'));
  });

  it("puts the host's name before the type and id, escaped, and only where it gives one", () => {
    const text = subjectTextWith(t, (s) =>
      s.id === 'u1' ? 'Dana' : s.id === 'u2' ? 'Ro‮se' : undefined
    );
    expect(text({ type: 'user', id: 'u1' })).toBe('Dana (user u1)');
    expect(text({ type: 'user', id: 'u2' })).toBe('Ro\\u202Ese (user u2)');
    expect(text({ type: 'agent', id: 'a1' })).toBe('agent a1');
  });

  it('leaves out a label that throws, is empty, or is not text', () => {
    const subject = { type: 'user', id: 'u1' };
    expect(
      subjectTextWith(t, () => {
        throw new Error('directory down');
      })(subject)
    ).toBe('user u1');
    expect(subjectTextWith(t, () => '  ')(subject)).toBe('user u1');
    expect(subjectTextWith(t, (() => 42) as unknown as SubjectLabel)(subject)).toBe('user u1');
  });
});
