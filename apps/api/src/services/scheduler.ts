import { Queue, Worker, type ConnectionOptions, type RepeatOptions } from 'bullmq';
import cronParser from 'cron-parser';
import { DATE_RE, TIME_RE, scheduleCron, type WorkflowNode, type WorkflowVersion } from '@widebed/shared';
import { scheduleTriggerSchema, type ScheduleConfig } from '@widebed/nodes';

/**
 * Keeps Schedule Trigger nodes of ACTIVE, PUBLISHED workflows registered.
 *  - BullScheduler: BullMQ job schedulers in Redis. Survives restarts, and each
 *    occurrence is one job, so only one worker fires it.
 *  - InProcessScheduler: timers in this process (single-process dev / tests).
 */
export type FireFn = (workflowId: string, nodeId: string, scheduledFor: string, occurrenceKey: string) => Promise<void>;

export interface Scheduler {
  readonly mode: 'in-process' | 'redis';
  /** Replace the schedules of a workflow with those in `version` (null = remove all). */
  sync(workflowId: string, version: WorkflowVersion | null): Promise<void>;
  startProcessing(fire: FireFn): void;
  close(): Promise<void>;
}

const UNIT = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

export function scheduleNodes(version: WorkflowVersion | null): { node: WorkflowNode; cfg: ScheduleConfig }[] {
  if (!version) return [];
  return version.nodes
    .filter((n) => n.type === 'trigger.schedule' && !n.disabled)
    .map((n) => ({ node: n, cfg: scheduleTriggerSchema.parse(n.config ?? {}) }));
}

/** The exact moment of a "once" schedule (ms), or null if the date/time is incomplete. */
export function onceAt(cfg: ScheduleConfig): number | null {
  const d = DATE_RE.exec(cfg.date);
  const pattern = scheduleCron(cfg);
  if (!d || !TIME_RE.test(cfg.time) || !pattern) return null;
  // Let cron-parser do the time-zone maths: the first match starting two days before
  // the chosen date is exactly that date and time in the chosen time zone.
  const from = new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]) - 2 * 86_400_000);
  return cronParser.parseExpression(pattern, { tz: cfg.timezone, currentDate: from }).next().getTime();
}

/** Next fire time after `from` (ms), or null when it will never run again (a "once" in the past). */
export function nextRun(cfg: ScheduleConfig, from: number): number | null {
  if (cfg.mode === 'interval') return from + cfg.every * UNIT[cfg.unit];
  if (cfg.mode === 'once') {
    const at = onceAt(cfg);
    return at !== null && at > from ? at : null;
  }
  return cronParser.parseExpression(scheduleCron(cfg)!, { tz: cfg.timezone, currentDate: new Date(from) }).next().getTime();
}

/* ------------------------------------------------------------------ in-process */

export class InProcessScheduler implements Scheduler {
  readonly mode = 'in-process' as const;
  private timers = new Map<string, NodeJS.Timeout>();
  private fire: FireFn | null = null;

  async sync(workflowId: string, version: WorkflowVersion | null) {
    for (const [key, t] of this.timers) {
      if (key.startsWith(`${workflowId}:`)) {
        clearTimeout(t);
        this.timers.delete(key);
      }
    }
    for (const { node, cfg } of scheduleNodes(version)) this.arm(workflowId, node.id, cfg, Date.now());
  }

  private arm(workflowId: string, nodeId: string, cfg: ScheduleConfig, from: number) {
    const key = `${workflowId}:${nodeId}`;
    const at = nextRun(cfg, from);
    if (at === null) {
      this.timers.delete(key); // a "once" schedule that has already run / passed
      return;
    }
    const delay = Math.min(at - Date.now(), 2_147_000_000); // setTimeout max ~24.8 days
    const t = setTimeout(() => {
      if (at > Date.now() + 1000) return this.arm(workflowId, nodeId, cfg, Date.now()); // long delay re-arm
      this.arm(workflowId, nodeId, cfg, at);
      void this.fire?.(workflowId, nodeId, new Date(at).toISOString(), `sched:${nodeId}:${at}`).catch((e) => console.error('[scheduler]', e.message));
    }, Math.max(0, delay));
    t.unref();
    this.timers.set(key, t);
  }

  /** Test helper. */
  armed() {
    return [...this.timers.keys()];
  }

  startProcessing(fire: FireFn) {
    this.fire = fire;
  }

  async close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/* ------------------------------------------------------------------ BullMQ */

export const SCHEDULE_QUEUE = 'wb-schedules';

export class BullScheduler implements Scheduler {
  readonly mode = 'redis' as const;
  private queue: Queue;
  private worker: Worker | null = null;

  constructor(private connection: ConnectionOptions) {
    this.queue = new Queue(SCHEDULE_QUEUE, { connection });
    this.queue.on('error', (err) => console.error('[scheduler] Redis error:', err.message));
  }

  async sync(workflowId: string, version: WorkflowVersion | null) {
    await Promise.race([
      this.queue.waitUntilReady(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('The job queue (Redis) is not reachable. Is Redis running?')), 5000).unref()),
    ]);
    const prefix = `wf:${workflowId}:`;
    const wanted = scheduleNodes(version);
    const existing = (await this.queue.getJobSchedulers(0, -1)).filter((s) => s.key.startsWith(prefix));
    for (const s of existing) {
      if (!wanted.some((w) => `${prefix}${w.node.id}` === s.key)) await this.queue.removeJobScheduler(s.key);
    }
    for (const { node, cfg } of wanted) {
      const key = `${prefix}${node.id}`;
      let repeat: RepeatOptions;
      if (cfg.mode === 'interval') {
        repeat = { every: cfg.every * UNIT[cfg.unit] };
      } else if (cfg.mode === 'once') {
        const at = nextRun(cfg, Date.now());
        if (at === null) {
          // Already passed: make sure nothing is left registered.
          if (existing.some((s) => s.key === key)) await this.queue.removeJobScheduler(key);
          continue;
        }
        repeat = { pattern: scheduleCron(cfg)!, tz: cfg.timezone, limit: 1, endDate: new Date(at + 60_000) };
      } else {
        repeat = { pattern: scheduleCron(cfg)!, tz: cfg.timezone };
      }
      await this.queue.upsertJobScheduler(key, repeat, {
        name: 'fire',
        data: { workflowId, nodeId: node.id },
        opts: { removeOnComplete: 100, removeOnFail: 500 },
      });
    }
  }

  startProcessing(fire: FireFn) {
    this.worker = new Worker(
      SCHEDULE_QUEUE,
      async (job) => {
        const scheduledFor = new Date(job.timestamp + (job.opts.delay ?? 0)).toISOString();
        await fire(job.data.workflowId, job.data.nodeId, scheduledFor, `sched:${job.id}`);
      },
      { connection: this.connection, concurrency: 5 },
    );
    this.worker.on('error', (err) => console.error('[scheduler] error', err.message));
  }

  async close() {
    await this.worker?.close();
    await this.queue.close();
  }
}
