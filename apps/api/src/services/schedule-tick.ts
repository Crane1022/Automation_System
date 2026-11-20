import cronParser from 'cron-parser';
import { TERMINAL_STATUSES, scheduleCron } from '@widebed/shared';
import type { ScheduleConfig } from '@widebed/nodes';
import type { AppContext } from '../context.js';
import { onceAt, scheduleNodes } from './scheduler.js';

/**
 * "Run due schedules now" — for hosting without an always-on process (Vercel).
 *
 * On Vercel the API sleeps when nobody uses the app, so the in-process timers never fire.
 * An outside timer (cron-job.org, Vercel Cron…) calls GET /cron/run-schedules every few minutes.
 * Each call looks at every active, published workflow with a Schedule Trigger and starts the
 * most recent occurrence if it is due and has not run yet.
 *
 * No duplicates: each occurrence uses the key `sched:<nodeId>:<time>`, the same key the
 * in-process timer uses, so the execution id is the same and a second start is ignored.
 * Calling this every minute, or twice at once, still runs each occurrence once.
 */

const UNIT = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

/** The latest moment at or before `now` when this schedule should have run (ms), or null. */
export function lastRun(cfg: ScheduleConfig, now: number): number | null {
  if (cfg.mode === 'interval') {
    const every = cfg.every * UNIT[cfg.unit];
    return Math.floor(now / every) * every;
  }
  if (cfg.mode === 'once') {
    const at = onceAt(cfg);
    return at !== null && at <= now ? at : null;
  }
  const pattern = scheduleCron(cfg);
  if (!pattern) return null;
  // +1 ms so an occurrence at exactly `now` counts.
  return cronParser.parseExpression(pattern, { tz: cfg.timezone, currentDate: new Date(now + 1) }).prev().getTime();
}

export interface TickResult {
  checkedWorkflows: number;
  /** Runs that were stuck "running" (server paused) and are now marked failed. */
  closedStuckRuns: number;
  runs: { workflowId: string; workflowName: string; scheduledFor: string; executionId: string; alreadyStarted: boolean; status: string }[];
  errors: { workflowId: string; error: string }[];
}

export interface TickOptions {
  now?: number;
  /** How late an occurrence may still be started (e.g. the timer service was down). */
  catchUpMs: number;
  /** How long to wait for the runs to finish before answering (only without Redis). */
  waitMs: number;
  pollMs?: number;
}

export async function runDueSchedules(ctx: AppContext, opts: TickOptions): Promise<TickResult> {
  const now = opts.now ?? Date.now();
  const result: TickResult = { checkedWorkflows: 0, closedStuckRuns: 0, runs: [], errors: [] };
  result.closedStuckRuns = await ctx.executions.failAbandoned(now).catch(() => 0);

  const active = await ctx.repos.workflows.listActive(1000);
  for (const wf of active) {
    if (!wf.publishedVersionId) continue;
    try {
      const version = await ctx.repos.versions.get(wf.publishedVersionId);
      const schedules = scheduleNodes(version);
      if (!schedules.length) continue;
      result.checkedWorkflows++;
      const publishedAt = version?.publishedAt ? Date.parse(version.publishedAt) : 0;
      for (const { node, cfg } of schedules) {
        const at = lastRun(cfg, now);
        if (at === null || now - at > opts.catchUpMs) continue; // nothing due recently
        if (publishedAt && at < publishedAt) continue; // due before this version was published: don't run old occurrences
        const scheduledFor = new Date(at).toISOString();
        const started = await ctx.executions.fireSchedule(wf.workflowId, node.id, scheduledFor, `sched:${node.id}:${at}`);
        if (!started) continue;
        result.runs.push({
          workflowId: wf.workflowId,
          workflowName: wf.name,
          scheduledFor,
          executionId: started.executionId,
          alreadyStarted: started.deduplicated,
          status: 'queued',
        });
      }
    } catch (err) {
      result.errors.push({ workflowId: wf.workflowId, error: (err as Error).message });
    }
  }

  // Without Redis the runs happen inside this function. Vercel may pause the function once the
  // answer is sent, so wait for them to finish first. With Redis a worker runs them.
  const fresh = result.runs.filter((r) => !r.alreadyStarted);
  if (ctx.executions.queue.mode === 'in-process' && fresh.length && opts.waitMs > 0) {
    const until = Date.now() + opts.waitMs;
    const poll = opts.pollMs ?? 1000;
    while (Date.now() < until) {
      let done = true;
      for (const r of fresh) {
        const exec = await ctx.repos.executions.get(r.executionId);
        r.status = exec?.status ?? 'missing';
        if (exec && !TERMINAL_STATUSES.includes(exec.status)) done = false;
      }
      if (done) break;
      await new Promise((res) => setTimeout(res, poll));
    }
  }
  for (const r of result.runs.filter((x) => x.alreadyStarted)) {
    const exec = await ctx.repos.executions.get(r.executionId);
    r.status = exec?.status ?? 'missing';
  }
  return result;
}
