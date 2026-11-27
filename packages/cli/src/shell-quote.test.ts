import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellQuote } from './terminal.js';

const paths = [
  '/tmp/cred.json',
  '=ls',
  '/x:=ls',
  '/x:~/y',
  '~/x',
  'a=b',
  "it's here.json",
  'a b',
  'a;b',
  '$HOME/x',
  '*',
];

describe('shellQuote', () => {
  it('leaves an ordinary path alone', () => {
    expect(shellQuote('/tmp/dir-1/cred_2.json')).toBe('/tmp/dir-1/cred_2.json');
  });

  it.each(['=ls', '/x:=ls', '/x:~/y', '~/x', 'a=b', '/x:y'])('quotes %s', (value) => {
    expect(shellQuote(value)).toBe(`'${value}'`);
  });

  it('writes a single quote as quote, backslash, quote, quote', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

function available(shell: string): boolean {
  try {
    execFileSync(shell, ['-c', ':']);
    return true;
  } catch {
    return false;
  }
}

describe.each(['sh', 'zsh'])('shellQuote under %s', (shell) => {
  it.skipIf(!available(shell))(
    'the printed export line sets the variable to the path exactly',
    () => {
      for (const path of paths) {
        const out = execFileSync(shell, ['-c', `export V=${shellQuote(path)}; printf %s "$V"`], {
          encoding: 'utf8',
        });
        expect(out, path).toBe(path);
      }
    }
  );
});
