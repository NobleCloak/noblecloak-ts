import { describe, expect, it } from 'vitest';

import * as entry from '../approvals.js';
import { Approvals } from './Approvals.js';
import { DEFAULT_LABELS, createTranslate } from './labels.js';

describe('the approvals entry', () => {
  it('exports the component itself', () => {
    expect(entry.Approvals).toBe(Approvals);
  });
});

describe('labels', () => {
  it('fills placeholders, and leaves an unknown one as it is', () => {
    const t = createTranslate({ countMany: '{count} waiting, {other}' });
    expect(t('countMany', { count: 3 })).toBe('3 waiting, {other}');
    expect(createTranslate(undefined)('queueHeading')).toBe(DEFAULT_LABELS.queueHeading);
  });

  it('a host label wins over the default', () => {
    expect(createTranslate({ approve: 'Allow' })('approve')).toBe('Allow');
  });
});
