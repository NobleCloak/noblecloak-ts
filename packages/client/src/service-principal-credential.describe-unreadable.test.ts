import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { describeUnreadableFile } from './service-principal.js';

const enoent = Object.assign(new Error('ENOENT: no such file, open /secret/place'), {
  code: 'ENOENT',
});

describe('describeUnreadableFile', () => {
  it('words the message from the cause and the resolved path, and returns the fs code as the cause', async () => {
    const out = await describeUnreadableFile('nope/gone.json', enoent, { what: 'the thing' });
    expect(out).toEqual({
      message: `Cannot read the thing ${resolve('nope/gone.json')}: no such file.`,
      cause: 'ENOENT',
    });
  });

  it('uses the given path and "named by" when they are passed', async () => {
    const out = await describeUnreadableFile('x.json', enoent, {
      what: 'the file',
      path: '/abs/x.json',
      namedBy: 'the flag',
    });
    expect(out.message).toBe('Cannot read the file /abs/x.json (named by the flag): no such file.');
  });

  it('leaves out the path for a token and never copies the fs error message', async () => {
    const token = 'ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6';
    const out = await describeUnreadableFile(token, enoent, { what: 'the file' });
    expect(out.message).toBe('Cannot read the file: no such file.');
    expect(out.message).not.toContain('/secret/place');
  });

  it('reports an error with no code as unknown', async () => {
    const out = await describeUnreadableFile('a.json', new Error('boom'), {
      what: 'the file',
      path: '/a.json',
    });
    expect(out).toEqual({
      message: 'Cannot read the file /a.json: error unknown.',
      cause: 'unknown',
    });
  });
});
