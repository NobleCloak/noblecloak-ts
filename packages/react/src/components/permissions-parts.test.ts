import { describe, expect, it } from 'vitest';

import type { ToolInfo } from '../permissions-types.js';
import { createPermissionsTranslate } from './permissions-labels.js';
import { toolRefLabel } from './permissions-parts.js';

const tool = (toolRef: string, status: string): ToolInfo => ({
  id: toolRef,
  toolRef,
  connectionId: null,
  status,
  statusKnown: status === 'active' || status === 'withdrawn',
});

describe('toolRefLabel', () => {
  const t = createPermissionsTranslate(undefined);
  const tools = [tool('t:a', 'active'), tool('t:w', 'withdrawn'), tool('t:p', 'paused\u200B')];
  it('marks a tool that is not callable, and leaves an active or unlisted one as its reference', () => {
    expect(toolRefLabel('t:a', tools, t)).toBe('t:a');
    expect(toolRefLabel('t:gone', tools, t)).toBe('t:gone');
    expect(toolRefLabel('t:w', tools, t)).toBe('t:w (withdrawn)');
    expect(toolRefLabel('t:p', tools, t)).toBe('t:p (status "paused\\u200B")');
  });
});
