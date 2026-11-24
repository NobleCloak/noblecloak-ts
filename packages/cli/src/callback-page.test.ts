import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  callbackHeaders,
  escapeHtml,
  failurePage,
  mismatchPage,
  successPage,
} from './callback-page.js';
import { config, completeSignIn, run } from './harness.test-support.js';
import { CODE, ORG, startStub, type Stub } from './stub.test-support.js';

const PROBE = `"><script>alert(1)</script><img src=x onerror=alert(2)>'&`;

const pages = (): Record<string, string> => ({
  success: successPage(),
  failure: failurePage('access_denied', 'The user said no'),
  mismatch: mismatchPage(),
});

describe('callback pages', () => {
  it('the success page says what happens next, in NobleCloak branding', () => {
    const html = successPage();
    expect(html).toContain('<title>Signed in - NobleCloak</title>');
    expect(html).toContain('Return to the terminal. The command continues there.');
    expect(html).toContain('You can close this tab.');
    expect(html).toContain('Noble<b>Cloak</b>');
    expect(html).toContain('<svg');
  });

  it('the logo is the official four-colour mark, hidden from screen readers, with no inline style', () => {
    for (const html of Object.values(pages())) {
      const mark = /<div class="brand">(<svg[\s\S]*?<\/svg>)/.exec(html)?.[1] ?? '';
      expect(mark).toContain('viewBox="42.739 48.434 150.114 118.796"');
      for (const fill of ['#E1CF99', '#00A46E', '#48B3D5', '#204B68']) {
        expect(mark).toContain(`fill="${fill}"`);
      }
      expect(mark).toContain('aria-hidden="true"');
      expect(mark).not.toContain('aria-label');
      expect(mark).not.toContain('role=');
      expect(html).not.toMatch(/\sstyle\s*=/i);
    }
  });

  it('every attribute in every page is separated from the one before it by a space', () => {
    for (const html of Object.values(pages())) {
      expect(html).not.toMatch(/="[^"]*"[a-zA-Z-]+=/);
    }
  });

  it('the failure page says the command stopped and how to try again, and shows the reason', () => {
    const html = failurePage('access_denied', 'The user said no');
    expect(html).toContain('Sign-in not completed');
    expect(html).toContain('Return to the terminal. The command has stopped.');
    expect(html).toContain('To try again, run it again.');
    expect(html).toContain('access_denied: The user said no');
  });

  it('the failure page without a reason has no reason box', () => {
    expect(failurePage(null, null)).not.toContain('class="reason"');
    expect(failurePage('', '')).not.toContain('class="reason"');
  });

  it('escapes error and error_description from the query string', () => {
    for (const html of [
      failurePage(PROBE, null),
      failurePage(null, PROBE),
      failurePage(PROBE, PROBE),
    ]) {
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('onerror=alert(2)>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('&quot;&gt;');
      expect(html).toContain('&#39;&amp;');
    }
  });

  it('cuts a long reason', () => {
    const html = failurePage('x'.repeat(5000), null);
    expect(html).toContain('x'.repeat(300));
    expect(html).not.toContain('x'.repeat(301));
  });

  it('cuts by code point: an emoji at the boundary is kept whole or dropped whole', () => {
    // 299 characters then a 2-code-unit emoji: a cut by UTF-16 unit at 300 would leave half of it.
    const kept = failurePage('a'.repeat(299) + '\u{1F600}', null);
    expect(kept).toContain('a'.repeat(299) + '\u{1F600}');
    const dropped = failurePage('a'.repeat(300) + '\u{1F600}', null);
    expect(dropped).toContain('a'.repeat(300));
    expect(dropped).not.toContain('\u{1F600}');
    for (const html of [kept, dropped]) {
      expect(html).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      );
    }
  });

  it('escapeHtml covers the five characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('no page has a script, an external URL or a request to another origin', () => {
    for (const [name, html] of Object.entries(pages())) {
      expect(html, name).not.toMatch(/<script/i);
      expect(html, name).not.toMatch(/<link\b/i);
      expect(html, name).not.toMatch(/<img\b/i);
      expect(html, name).not.toMatch(/<iframe/i);
      expect(html, name).not.toMatch(/@import/i);
      expect(html, name).not.toMatch(/url\(/i);
      expect(html, name).not.toMatch(/\b(?:src|href|action)\s*=/i);
      // The only URL-shaped text is the SVG namespace, which is never fetched.
      const urls = html.match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
      expect(
        urls.filter((u) => u !== 'http://www.w3.org/2000/svg'),
        name
      ).toEqual([]);
    }
  });

  it('supports light and dark and a phone width', () => {
    const html = successPage();
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
  });

  it('the CSP allows the one inline stylesheet by hash and nothing else', () => {
    const csp = callbackHeaders['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('script-src');
    const hash = /style-src 'sha256-([^']+)'/.exec(csp)?.[1];
    const css = /<style>([\s\S]*?)<\/style>/.exec(successPage())?.[1];
    expect(hash).toBeDefined();
    expect(css).toBeDefined();
    expect(
      createHash('sha256')
        .update(css ?? '')
        .digest('base64')
    ).toBe(hash);
  });
});

describe('the loopback listener serves the pages', () => {
  let stub: Stub;
  let dir: string;
  beforeEach(async () => {
    stub = await startStub();
    dir = await mkdtemp(join(tmpdir(), 'nc-cb-'));
  });
  afterEach(async () => {
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const args = (): string[] => [
    'sp',
    'create',
    '--org',
    ORG,
    '--name',
    'ci agent',
    '--audience',
    'https://govern.example.com',
    '--out',
    join(dir, 'cred.json'),
    ...config(stub),
  ];

  it('serves the success page as html with the CSP on a good callback', async () => {
    let status = 0;
    let type = '';
    let csp = '';
    let nosniff = '';
    let cache = '';
    let body = '';
    await run(stub, args(), {
      browser: async (authorize, s) => {
        const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
        s.challenge = authorize.searchParams.get('code_challenge') ?? undefined;
        redirect.searchParams.set('code', CODE);
        redirect.searchParams.set('state', authorize.searchParams.get('state') ?? '');
        const response = await fetch(redirect);
        status = response.status;
        type = response.headers.get('content-type') ?? '';
        csp = response.headers.get('content-security-policy') ?? '';
        nosniff = response.headers.get('x-content-type-options') ?? '';
        cache = response.headers.get('cache-control') ?? '';
        body = await response.text();
      },
    });
    expect(status).toBe(200);
    expect(type).toBe('text/html; charset=utf-8');
    expect(csp).toBe(callbackHeaders['content-security-policy']);
    expect(nosniff).toBe('nosniff');
    expect(cache).toBe('no-store');
    expect(body).toBe(successPage());
  });

  it('serves the failure page with the query-string error escaped, never as markup', async () => {
    let status = 0;
    let body = '';
    const result = await run(stub, args(), {
      browser: async (authorize) => {
        const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('error_description', PROBE);
        redirect.searchParams.set('state', authorize.searchParams.get('state') ?? '');
        const response = await fetch(redirect);
        status = response.status;
        body = await response.text();
      },
    });
    expect(result.code).toBe(3);
    expect(status).toBe(400);
    expect(body).toContain('Sign-in not completed');
    expect(body).toContain('access_denied: &quot;&gt;&lt;script&gt;');
    expect(body).not.toContain('<script');
    expect(body).not.toContain('<img');
  });

  it('shows nothing from the query string when the state does not match', async () => {
    let status = 0;
    let body = '';
    await run(stub, args(), {
      browser: async (authorize, s) => {
        const wrong = new URL(authorize.searchParams.get('redirect_uri') ?? '');
        wrong.searchParams.set('error', PROBE);
        wrong.searchParams.set('state', 'wrong');
        const response = await fetch(wrong);
        status = response.status;
        body = await response.text();
        await completeSignIn(authorize, s);
      },
    });
    expect(status).toBe(400);
    expect(body).toBe(mismatchPage());
    expect(body).not.toContain('script');
  });

  it('answers a request target that does not parse with 400 and keeps waiting for the sign-in', async () => {
    let raw = '';
    const result = await run(stub, args(), {
      browser: async (authorize, s) => {
        const port = Number(new URL(authorize.searchParams.get('redirect_uri') ?? '').port);
        raw = await new Promise<string>((resolve, reject) => {
          const socket = connect(port, '127.0.0.1', () => {
            socket.write('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
          });
          let data = '';
          socket.on('data', (chunk: Buffer) => {
            data += chunk.toString('utf8');
          });
          socket.on('close', () => {
            resolve(data);
          });
          socket.on('error', reject);
        });
        await completeSignIn(authorize, s);
      },
    });
    expect(raw).toMatch(/^HTTP\/1\.1 400 /);
    expect(raw).toContain('Bad request.');
    // The listener survived and the real callback afterwards completed the sign-in.
    expect(result.code, result.stderr).toBe(0);
  });
});
