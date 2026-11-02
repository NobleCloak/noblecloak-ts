import { escapeInvisible } from './format-json.js';
import type { Translate } from './labels.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `iso` was, in words; an unreadable time gives an empty string. */
export function formatAge(iso: string, now: number, t: Translate): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const elapsed = Math.max(0, now - then);
  if (elapsed < MINUTE) return t('ageNow');
  if (elapsed < HOUR) return t('ageMinutes', { count: Math.floor(elapsed / MINUTE) });
  if (elapsed < DAY) return t('ageHours', { count: Math.floor(elapsed / HOUR) });
  return t('ageDays', { count: Math.floor(elapsed / DAY) });
}

const TIME = /* @__PURE__ */ new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** A timestamp in UTC for display (the layout is en-US, the "UTC" suffix is a label); an unreadable value is shown as it came. */
export function formatTime(iso: string, t: Translate): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? escapeInvisible(iso) : t('timeUtc', { time: TIME.format(parsed) });
}

/** The most characters of a tool reference a row or the heading shows; the detail's facts hold the whole value. */
export const MAX_REF_CHARS = 200;

/** `value` as text of at most `max` UTF-16 code units, cut with an ellipsis; a pair of surrogates is never split. */
export function clipText(value: unknown, max: number = MAX_REF_CHARS): string {
  // A field that should be a string may be anything if a reply was malformed; its String() form is shown.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** The first characters of a digest, as the queue shows it. */
export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}
