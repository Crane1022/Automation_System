/**
 * Schedule Trigger helpers shared by the API (scheduler) and the web app (editor).
 *
 * Beginners pick a simple option (once / every day / every week / every month /
 * every N minutes). Each simple option is turned into a 5-field cron pattern here,
 * so the scheduler only ever deals with two things: a cron pattern or an interval.
 */

export type ScheduleMode = 'once' | 'daily' | 'weekly' | 'monthly' | 'interval' | 'cron';

export interface ScheduleSettings {
  mode: ScheduleMode;
  /** once: "YYYY-MM-DD" */
  date?: string;
  /** once / daily / weekly / monthly: "HH:MM" (24-hour) */
  time?: string;
  /** weekly: "0".."6" (0 = Sunday) */
  weekdays?: string[];
  /** monthly: "1".."31" or "L" (last day of the month) */
  dayOfMonth?: string;
  /** interval */
  every?: number;
  unit?: 'minutes' | 'hours' | 'days';
  /** cron (advanced) */
  cron?: string;
  timezone?: string;
}

export const SCHEDULE_MODE_OPTIONS: { label: string; value: ScheduleMode }[] = [
  { label: 'Once, on a date and time', value: 'once' },
  { label: 'Every day', value: 'daily' },
  { label: 'Every week', value: 'weekly' },
  { label: 'Every month', value: 'monthly' },
  { label: 'Every few minutes / hours', value: 'interval' },
  { label: 'Advanced (cron expression)', value: 'cron' },
];

export const WEEKDAY_OPTIONS = [
  { label: 'Mon', value: '1' },
  { label: 'Tue', value: '2' },
  { label: 'Wed', value: '3' },
  { label: 'Thu', value: '4' },
  { label: 'Fri', value: '5' },
  { label: 'Sat', value: '6' },
  { label: 'Sun', value: '0' },
];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const DAY_OF_MONTH_OPTIONS = [
  ...Array.from({ length: 31 }, (_, i) => ({ label: ordinal(i + 1), value: String(i + 1) })),
  { label: 'Last day of the month', value: 'L' },
];

/** Common time zones for the picker (any valid IANA zone is still accepted). */
export const TIMEZONE_OPTIONS = [
  { label: 'Malaysia (Kuala Lumpur)', value: 'Asia/Kuala_Lumpur' },
  { label: 'Singapore', value: 'Asia/Singapore' },
  { label: 'Indonesia (Jakarta)', value: 'Asia/Jakarta' },
  { label: 'Thailand (Bangkok)', value: 'Asia/Bangkok' },
  { label: 'Philippines (Manila)', value: 'Asia/Manila' },
  { label: 'Hong Kong', value: 'Asia/Hong_Kong' },
  { label: 'China (Shanghai)', value: 'Asia/Shanghai' },
  { label: 'Japan (Tokyo)', value: 'Asia/Tokyo' },
  { label: 'Australia (Sydney)', value: 'Australia/Sydney' },
  { label: 'United Kingdom (London)', value: 'Europe/London' },
  { label: 'UTC', value: 'UTC' },
];

export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

function hm(time: string | undefined): [number, number] {
  const m = TIME_RE.exec(time ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [9, 0];
}

/**
 * Cron pattern for every mode except "interval" (which has none).
 * "once" gives a yearly pattern; the scheduler makes sure it fires only on the chosen date.
 */
export function scheduleCron(s: ScheduleSettings): string | null {
  const [h, m] = hm(s.time);
  switch (s.mode) {
    case 'once': {
      const d = DATE_RE.exec(s.date ?? '');
      return d ? `${m} ${h} ${Number(d[3])} ${Number(d[2])} *` : null;
    }
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly': {
      const days = [...new Set(s.weekdays ?? [])].sort().join(',');
      return `${m} ${h} * * ${days || '1'}`;
    }
    case 'monthly':
      return `${m} ${h} ${s.dayOfMonth || '1'} * *`;
    case 'cron':
      return (s.cron ?? '').trim();
    default:
      return null;
  }
}

/** "9:00 AM" */
export function formatTime12(time: string | undefined): string {
  const [h, m] = hm(time);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "14 Nov 2026" */
export function formatDateShort(date: string | undefined): string {
  const d = DATE_RE.exec(date ?? '');
  if (!d) return '(no date)';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(d[3])} ${months[Number(d[2]) - 1] ?? '?'} ${d[1]}`;
}

/** Plain-English description, e.g. "Every Monday and Friday at 9:00 AM". */
export function describeSchedule(s: ScheduleSettings): string {
  const at = `at ${formatTime12(s.time)}`;
  switch (s.mode) {
    case 'once':
      return `Once, on ${formatDateShort(s.date)} ${at}`;
    case 'daily':
      return `Every day ${at}`;
    case 'weekly': {
      const days = [...new Set(s.weekdays ?? [])].map(Number).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      if (!days.length) return `Every week (choose at least one day) ${at}`;
      if (days.length === 7) return `Every day ${at}`;
      if (days.join(',') === '1,2,3,4,5') return `Every weekday (Mon–Fri) ${at}`;
      const names = days.map((d) => WEEKDAY_NAMES[d]);
      const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return `Every ${list} ${at}`;
    }
    case 'monthly':
      return s.dayOfMonth === 'L' ? `On the last day of every month ${at}` : `On the ${ordinal(Number(s.dayOfMonth || 1))} of every month ${at}`;
    case 'interval': {
      const n = Number(s.every ?? 15);
      const unit = s.unit ?? 'minutes';
      return n === 1 ? `Every ${unit.replace(/s$/, '')}` : `Every ${n} ${unit}`;
    }
    case 'cron':
      return `Cron “${s.cron ?? ''}”`;
    default:
      return 'Unknown schedule';
  }
}

/** Current date and time in a time zone as "YYYY-MM-DD HH:MM" (for "is this in the past?"). */
export function nowInZone(timezone: string, now = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** True when a "once" schedule's date and time have already passed in its time zone. */
export function oncePassed(s: ScheduleSettings, now = new Date()): boolean {
  if (s.mode !== 'once' || !DATE_RE.test(s.date ?? '') || !TIME_RE.test(s.time ?? '')) return false;
  return `${s.date} ${s.time}` <= nowInZone(s.timezone || 'Asia/Kuala_Lumpur', now);
}
