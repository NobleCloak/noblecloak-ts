import { describe, expect, it } from 'vitest';

import * as actionStatus from './action-status.js';
import * as approvals from './approvals.js';
import * as connections from './connections.js';
import * as permissions from './permissions.js';

describe('module entries', () => {
  it.each([
    ['approvals', approvals.MODULE_ID],
    ['action-status', actionStatus.MODULE_ID],
    ['connections', connections.MODULE_ID],
    ['permissions', permissions.MODULE_ID],
  ])('%s exports its module id', (expected, actual) => {
    expect(actual).toBe(expected);
  });
});
