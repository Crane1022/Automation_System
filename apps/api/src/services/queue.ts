import { Queue, Worker, QueueEvents, type ConnectionOptions } from 'bullmq';

/**
 * Execution queue contract. A job is just an execution id; everything the run
 * needs is stored on the execution document, so any worker can pick it up.
 *
 *  - InProcessQueue: memory only (tests, or a single dev process without Redis).
 *  - BullExecutionQueue: Redis + BullMQ, durable, shared by API and worker containers.
 */
export interface ExecutionQueue {
  readonly mode: 'in-process' | 'redis';
  add(executionId: string): Promise<void>;
  /** Removes a job that has not started yet. Returns true if it was removed. */
  remove(executionId: string): Promise<boolean>;
  stats(): Promise<{ waiting: number; active: number; concurrency: number | null }>;
  /** Starts consuming jobs in this process (worker role). */
  startProcessing(handler: (executionId: string) => Promise<void>, onLost?: (executionId: string, reason: string) => Promise<void>): void;
  /** Stops taking new jobs and waits for running ones (graceful shutdown). */
  close(): Promise<void>;
}

export class QueueFullError extends Error {}
export class QueueUnavailableError extends Error {}

/** Redis commands wait forever while disconnected; give up after a few seconds instead. */
function withTimeout<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new QueueUnavailableError('The job queue (Redis) is not reachable. Is Redis running?')), ms).unref()),
  ]);
}

/* ------------------------------------------------------------------ in-process */

export class InProcessQueue implements ExecutionQueue {
  readonly mode = 'in-process' as const;
  private waiting: string[] = [];
  private active = new Set<string>();
  private handler: ((id: string) => Promise<void>) | null = null;
  private idle: (() => void)[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxWaiting: number,
  ) {}

  async add(id: string) {
    if (this.waiting.length >= this.maxWaiting) throw new QueueFullError('Execution queue is full, try again later');
    this.waiting.push(id);
    this.pump();
  }

  async remove(id: string) {
    const i = this.waiting.indexOf(id);
    if (i === -1) return false;
    this.waiting.splice(i, 1);
    return true;
  }

  async stats() {
    return { waiting: this.waiting.length, active: this.active.size, concurrency: this.concurrency };
  }

  startProcessing(handler: (id: string) => Promise<void>) {
    this.handler = handler;
    this.pump();
  }

  close() {
    this.handler = null;
    if (this.active.size === 0) return Promise.resolve();
    return new Promise<void>((r) => this.idle.push(r));
  }

  /** Test helper: resolves when nothing is queued or running. */
  drain() {
    if (!this.active.size && !this.waiting.length) return Promise.resolve();
    return new Promise<void>((r) => this.idle.push(r));
  }

  private pump() {
    while (this.handler && this.active.size < this.concurrency && this.waiting.length) {
      const id = this.waiting.shift()!;
      this.active.add(id);
      this.handler(id)
        .catch((err) => console.error(`[queue] job ${id} crashed`, err))
        .finally(() => {
          this.active.delete(id);
          this.pump();
          if (!this.active.size && (!this.waiting.length || !this.handler)) this.idle.splice(0).forEach((r) => r());
        });
    }
  }
}

/* ------------------------------------------------------------------ BullMQ */

export const EXECUTION_QUEUE = 'wb-executions';

export class BullExecutionQueue implements ExecutionQueue {
  readonly mode = 'redis' as const;
  private queue: Queue;
  private worker: Worker | null = null;
  private events: QueueEvents | null = null;

  constructor(
    private connection: ConnectionOptions,
    private concurrency: number,
    private maxWaiting: number,
    /** Queue name in Redis; AI Staff tasks use their own queue. */
    private name: string = EXECUTION_QUEUE,
  ) {
    this.queue = new Queue(name, { connection });
    this.queue.on('error', (err) => console.error('[queue] Redis error:', err.message));
  }

  async add(id: string) {
    const counts = await withTimeout(this.queue.getJobCounts('waiting'));
    if ((counts.waiting ?? 0) >= this.maxWaiting) throw new QueueFullError('Execution queue is full, try again later');
    // jobId = executionId: BullMQ ignores a second add with the same id.
    await withTimeout(this.queue.add('run', { executionId: id }, { jobId: id, attempts: 1, removeOnComplete: 1000, removeOnFail: 5000 }));
  }

  async remove(id: string) {
    const job = await withTimeout(this.queue.getJob(id));
    if (!job) return false;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      await job.remove();
      return true;
    }
    return false;
  }

  async stats() {
    const c = await withTimeout(this.queue.getJobCounts('waiting', 'active', 'delayed'), 2000);
    return { waiting: (c.waiting ?? 0) + (c.delayed ?? 0), active: c.active ?? 0, concurrency: this.worker ? this.concurrency : null };
  }

  startProcessing(handler: (id: string) => Promise<void>, onLost?: (id: string, reason: string) => Promise<void>) {
    this.worker = new Worker(this.name, async (job) => handler(job.data.executionId), {
      connection: this.connection,
      concurrency: this.concurrency,
      // A worker that dies mid-run is detected after ~lockDuration; the job is then failed
      // (not re-run) because nodes may already have had side effects such as sent emails.
      lockDuration: 60_000,
      maxStalledCount: 0,
    });
    this.worker.on('error', (err) => console.error('[worker] error', err.message));
    if (onLost) {
      this.events = new QueueEvents(this.name, { connection: this.connection });
      this.events.on('failed', ({ jobId, failedReason }) => void onLost(jobId, failedReason).catch(() => undefined));
    }
  }

  async close() {
    await this.worker?.close();
    await this.events?.close();
    await this.queue.close();
  }
}
