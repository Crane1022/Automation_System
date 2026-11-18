// Re-exports used by the node tests. nextScheduleCheck mirrors the API scheduler's nextRun().
import cronParser from 'cron-parser';
export * from '@widebed/nodes';

export function nextScheduleCheck(cfg: { mode: 'interval' | 'cron'; every: number; unit: 'minutes' | 'hours' | 'days'; cron: string; timezone: string }, from: number): number {
  const unit = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[cfg.unit];
  if (cfg.mode === 'interval') return from + cfg.every * unit;
  return cronParser.parseExpression(cfg.cron, { tz: cfg.timezone, currentDate: new Date(from) }).next().getTime();
}
