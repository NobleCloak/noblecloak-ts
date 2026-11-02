import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { useApprovals } from './use-approvals.js';

describe('T26 a server render', () => {
  it('renders under renderToString from the constant snapshot, with no request and no browser global', () => {
    const fetchSpy = vi.fn();
    const getToken = vi.fn(() => 'token');
    expect(typeof window).toBe('undefined');
    function Probe(): ReturnType<typeof createElement> {
      const c = useApprovals({ baseUrl: 'https://api.example', getToken, fetch: fetchSpy });
      return createElement(
        'p',
        null,
        `${c.status}|${c.connection}|${String(c.approvals.length)}|${String(c.truncated)}`
      );
    }
    const html = renderToString(createElement(Probe));
    expect(html).toContain('idle|offline|0|false');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it('is the same constant for every store', async () => {
    const { createApprovalsStore } = await import('./approvals-store.js');
    const a = createApprovalsStore({ baseUrl: 'https://a', getToken: () => 't' });
    const b = createApprovalsStore({ baseUrl: 'https://b', getToken: () => 't', enabled: false });
    expect(a.getServerSnapshot()).toBe(b.getServerSnapshot());
    expect(Object.isFrozen(a.getServerSnapshot())).toBe(true);
  });
});
