import { createHash } from 'node:crypto';
import { MARK_4C } from './callback-mark.js';

/**
 * The pages the sign-in loopback listener serves. Each is one self-contained HTML document: inline CSS, an
 * inline SVG mark, no script, no font, no request to any other origin. `callbackHeaders` pins that with a
 * Content-Security-Policy that allows nothing but the one inline stylesheet (by hash).
 */

/** Official palette (designer sheet, 2026-11-12). */
const NAVY = '#204B68';
const GREEN = '#00A46E';

// Light and dark values for text, surfaces and the error accent. The error accent is the theme package's
// --nc-danger pair.
const CSS = `
:root{color-scheme:light dark;--bg:#f4f8fa;--card:#ffffff;--fg:${NAVY};--muted:#4a5f6d;--line:#d3e0e8;--ok:${GREEN};--bad:#b3261e;--word:${NAVY};--word2:${GREEN}}
@media (prefers-color-scheme:dark){:root{--bg:#0d1a23;--card:#132632;--fg:#eaf3f8;--muted:#a9bcc8;--line:#2a4252;--ok:#2fd49a;--bad:#f2b8b5;--word:#eaf3f8;--word2:#2fd49a}}
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:28rem;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px 24px}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 24px;font-weight:700;font-size:1.125rem;letter-spacing:.01em;color:var(--word)}
.brand b{color:var(--word2);font-weight:700}
.brand svg{flex:none}
.status{display:flex;align-items:center;gap:10px;margin:0 0 8px}
.status svg{flex:none}
h1{margin:0;font-size:1.375rem;line-height:1.3;font-weight:700}
p{margin:0 0 12px;color:var(--muted)}
p.next{color:var(--fg)}
.reason{margin:16px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;color:var(--muted);font:0.875rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.ok{color:var(--ok)}
.bad{color:var(--bad)}
`;

const cssHash = createHash('sha256').update(CSS).digest('base64');

/** Response headers for every page: no other origin may load or receive anything, nothing may frame it. */
export const callbackHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': `default-src 'none'; style-src 'sha256-${cssHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  connection: 'close',
} as const;

/** Escapes text for an HTML text node or a quoted attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const OK_ICON = `<svg class="ok" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m7.5 12.5 3 3 6-7"/></svg>`;
const BAD_ICON = `<svg class="bad" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 7v6m0 3.5v.01"/></svg>`;

interface Content {
  readonly title: string;
  readonly icon: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly reason?: string | undefined;
}

function render(content: Content): string {
  const paragraphs = content.paragraphs
    .map((p, i) => `<p${i === 0 ? ' class="next"' : ''}>${escapeHtml(p)}</p>`)
    .join('');
  const reason =
    content.reason === undefined || content.reason === ''
      ? ''
      : `<div class="reason">${escapeHtml(content.reason)}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(content.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<div class="brand">${MARK_4C}<span>Noble<b>Cloak</b></span></div>
<div class="status">${content.icon}<h1>${escapeHtml(content.heading)}</h1></div>
${paragraphs}${reason}
</main>
</body>
</html>
`;
}

/** The sign-in finished and the code was accepted. */
export function successPage(): string {
  return render({
    title: 'Signed in - NobleCloak',
    icon: OK_ICON,
    heading: 'Signed in',
    paragraphs: ['Return to the terminal. The command continues there.', 'You can close this tab.'],
  });
}

/** Longest reason text shown, in code points: the server's words, cut, never trusted. */
const REASON_MAX = 300;

/**
 * The authorization server answered with an error, or without a code. `error` and `description` come from
 * the query string: they are escaped as text and cut to a short length, and the page has no script.
 */
export function failurePage(error: string | null, description: string | null): string {
  const parts = [error, description].filter((v): v is string => v !== null && v !== '');
  // By code point, so the cut never splits a surrogate pair (an emoji) into a lone surrogate.
  const reason = Array.from(parts.join(': ')).slice(0, REASON_MAX).join('');
  return render({
    title: 'Sign-in not completed - NobleCloak',
    icon: BAD_ICON,
    heading: 'Sign-in not completed',
    paragraphs: ['Return to the terminal. The command has stopped.', 'To try again, run it again.'],
    reason,
  });
}

/** A callback with the wrong `state`: ignored, and the listener keeps waiting. */
export function mismatchPage(): string {
  return render({
    title: 'Response ignored - NobleCloak',
    icon: BAD_ICON,
    heading: 'Response ignored',
    paragraphs: [
      'This response does not match the sign-in the terminal started.',
      'Use the URL the command printed, or run it again.',
    ],
  });
}
