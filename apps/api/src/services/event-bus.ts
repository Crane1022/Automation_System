import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import type { ExecutionEvent } from '@widebed/shared';

/**
 * Message bus between processes:
 *  - execution events (step started/finished, status) → SSE streams in the API
 *  - cancel requests → whichever worker is running the execution
 *
 * Local version for single-process mode; Redis pub/sub when API and workers
 * are separate processes.
 */
export interface EventBus {
  publish(event: ExecutionEvent): void;
  subscribe(executionId: string, fn: (e: ExecutionEvent) => void): () => void;
  requestCancel(executionId: string): Promise<void>;
  onCancelRequest(fn: (executionId: string) => void): void;
  close(): Promise<void>;
}

export function createLocalEventBus(): EventBus {
  const em = new EventEmitter();
  em.setMaxListeners(1000);
  return {
    publish: (e) => void em.emit(`exec:${e.executionId}`, e),
    subscribe(id, fn) {
      em.on(`exec:${id}`, fn);
      return () => em.off(`exec:${id}`, fn);
    },
    async requestCancel(id) {
      em.emit('cancel', id);
    },
    onCancelRequest: (fn) => void em.on('cancel', fn),
    async close() {},
  };
}

export function createRedisEventBus(url: string): EventBus {
  const pub = new Redis(url, { maxRetriesPerRequest: null });
  const sub = new Redis(url, { maxRetriesPerRequest: null });
  const local = new EventEmitter();
  local.setMaxListeners(1000);

  void sub.psubscribe('wb:exec:*');
  void sub.subscribe('wb:cancel');
  sub.on('pmessage', (_pattern, channel, message) => {
    try {
      local.emit(channel.slice(3), JSON.parse(message)); // "wb:exec:ID" → "exec:ID"
    } catch {
      /* ignore malformed */
    }
  });
  sub.on('message', (channel, message) => {
    if (channel === 'wb:cancel') local.emit('cancel', message);
  });
  for (const c of [pub, sub]) c.on('error', (err) => console.error('[redis] bus error', err.message));

  return {
    publish: (e) => void pub.publish(`wb:exec:${e.executionId}`, JSON.stringify(e)).catch(() => undefined),
    subscribe(id, fn) {
      local.on(`exec:${id}`, fn);
      return () => local.off(`exec:${id}`, fn);
    },
    async requestCancel(id) {
      await pub.publish('wb:cancel', id);
    },
    onCancelRequest: (fn) => void local.on('cancel', fn),
    async close() {
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}
