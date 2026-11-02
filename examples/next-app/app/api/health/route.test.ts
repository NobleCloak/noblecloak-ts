import { describe, expect, it } from 'vitest';

import { GET } from './route.js';

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
