/**
 * Calendar-date helpers for beginner date checks ("is tomorrow", "more than 3 days ago").
 * Everything works on whole days in one time zone (Malaysia by default), so a booking
 * arriving "2026-12-01" is tomorrow on 30 Nov in Kuala Lumpur, whatever the server's clock zone.
 */

export const DEFAULT_TIMEZONE = 'Asia/Kuala_Lumpur';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of a moment in a time zone. */
export function dayInZone(moment: Date, timezone = DEFAULT_TIMEZONE): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(moment).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

function valid(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * Reads a date in the forms that appear in Widebed data and returns "YYYY-MM-DD", or null.
 *   "2026-12-01" · "2026-12-01T09:30:00.000Z" (moment → day in the time zone) · "01/12/2026" (day first, Malaysian style)
 *   "1 Dec 2026" · "Dec 1, 2026" · Firestore-like { seconds } · a Date · milliseconds since 1970
 */
export function parseDay(value: unknown, timezone = DEFAULT_TIMEZONE): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : dayInZone(value, timezone);
  if (typeof value === 'number') return value > 1e11 ? dayInZone(new Date(value), timezone) : null;
  if (typeof value === 'object') {
    const s = (value as { seconds?: unknown; _seconds?: unknown }).seconds ?? (value as { _seconds?: unknown })._seconds;
    return typeof s === 'number' ? dayInZone(new Date(s * 1000), timezone) : null;
  }
  const t = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return valid(+m[1]!, +m[2]!, +m[3]!);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) {
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(t);
    if (!hasZone) return valid(+t.slice(0, 4), +t.slice(5, 7), +t.slice(8, 10)); // local wall-clock time: keep its day
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : dayInZone(d, timezone);
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return valid(+m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/.exec(t);
  if (m) return valid(+m[3]!, MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1, +m[1]!);
  m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  if (m) return valid(+m[3]!, MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1, +m[2]!);
  return null;
}

/** Whole days from a to b ("YYYY-MM-DD"): b − a. */
export function daysBetween(a: string, b: string): number {
  const ms = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

export function addDays(day: string, n: number): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** "1 Dec 2026" */
export function displayDay(day: string): string {
  return `${+day.slice(8, 10)} ${MONTH_NAMES[+day.slice(5, 7) - 1]!.slice(0, 3)} ${day.slice(0, 4)}`;
}

/**
 * The values behind {{ $today }} in expressions, e.g.
 *   {{ $today }} → 2026-11-14 · {{ $today.tomorrow }} → 2026-11-15 · {{ $today.display }} → 14 Nov 2026
 */
export function todayInfo(now = new Date(), timezone = DEFAULT_TIMEZONE) {
  const date = dayInZone(now, timezone);
  const weekday = WEEKDAYS[new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10))).getUTCDay()]!;
  return {
    date,
    tomorrow: addDays(date, 1),
    yesterday: addDays(date, -1),
    display: displayDay(date),
    weekday,
    month: date.slice(0, 7),
    monthName: `${MONTH_NAMES[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`,
    year: date.slice(0, 4),
  };
}
