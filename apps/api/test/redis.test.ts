import crypto from 'node:crypto';
import request from 'supertest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@widebed/shared';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import { SCHEDULE_QUEUE } from '../src/services/scheduler.js';

/**
 * Runs only when REDIS_URL is set (e.g. REDIS_URL=redis://127.0.0.1:6379/15 npm test).
 * Simulates production: an API process that only enqueues, and a separate worker
 * process that runs jobs. They share the database but talk only through Redis.
 */
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)('Redis / BullMQ mode (API + separate worker)', () => {
  const verifier: TokenVerifier = { verify: async () => ({ uid: 'boss', email: 'boss@widebed.com', name: 'Boss', emailVerified: true }) };
  const env = {
    NODE_ENV: 'test', FIREBASE_PROJECT_ID: 'test', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    SUPER_ADMIN_EMAILS: 'boss@widebed.com', REDIS_URL, RATE_LIMIT_PER_MINUTE: '10000', HTTP_ALLOW_PRIVATE_NETWORKS: 'true',
  } as any;
  const repos = createMemoryRepositories(); // stands in for the shared Firestore
  let api: ReturnType<typeof buildContext>;
  let worker: ReturnType<typeof buildContext>;
  let app: ReturnType<typeof createApp>;
  const auth = { Authorization: 'Bearer x' };

  beforeAll(async () => {
    // Fail fast with a clear message instead of a 10 s timeout when Redis is not running.
    const r = new Redis(REDIS_URL!, { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 0, retryStrategy: () => null });
    r.on('error', () => undefined);
    try {
      await r.connect();
    } catch {
      throw new Error(`Redis is not reachable at ${REDIS_URL}. Start it first (Docker Desktop must be running), or run the tests without REDIS_URL.`);
    }
    await r.flushdb();
    await r.quit();
    api = buildContext(loadConfig(env), repos, verifier); // PROCESS_JOBS off: never calls startProcessing
    worker = buildContext(loadConfig(env), repos, verifier);
    startProcessing(worker);
    app = createApp(api);
  });
  afterAll(async () => {
    await api?.shutdown();
    await worker?.shutdown();
  });

  async function waitFor(id: string, statuses = ['success', 'failed', 'cancelled']) {
    for (let i = 0; i < 200; i++) {
      const res = await request(app).get(`/api/executions/${id}`).set(auth);
      if (statuses.includes(res.body.status)) return res.body;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`execution ${id} did not reach ${statuses}`);
  }
  async function create(def: WorkflowDefinition) {
    const wf = await request(app).post('/api/workflows').set(auth).send({ name: 'redis' });
    await request(app).put(`/api/workflows/${wf.body.workflowId}/draft`).set(auth).send({ definition: def });
    return wf.body.workflowId as string;
  }

  it('the worker runs jobs queued by the API, and live events reach the API’s SSE stream', async () => {
    const id = await create({
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'w', type: 'logic.wait', name: 'Pause', position: { x: 0, y: 0 }, config: { amount: 0.3, unit: 'seconds' } },
      ],
      connections: [{ id: 'c', source: 't', sourceHandle: 'main', target: 'w', targetHandle: 'main' }],
    });
    const run = await request(app).post(`/api/workflows/${id}/run`).set(auth).send({ mode: 'draft' });
    const stream = await request(app).get(`/api/executions/${run.body.executionId}/stream`).set(auth).buffer(true).parse((r, cb) => {
      let data = '';
      r.on('data', (c: Buffer) => (data += c.toString()));
      r.on('end', () => cb(null, data));
    });
    const text = stream.body as string;
    expect(text).toContain('"status":"waiting"'); // published by the worker over Redis
    expect(text).toContain('"status":"success"');
    const health = await request(app).get('/api/system/health').set(auth);
    expect(health.body.queue.mode).toBe('redis');
    expect(health.body.scheduler).toBe('redis');
  });

  it('a cancel sent to the API stops the run inside the worker', async () => {
    const id = await create({
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'w', type: 'logic.wait', name: 'Pause', position: { x: 0, y: 0 }, config: { amount: 10, unit: 'seconds' } },
      ],
      connections: [{ id: 'c', source: 't', sourceHandle: 'main', target: 'w', targetHandle: 'main' }],
    });
    const run = await request(app).post(`/api/workflows/${id}/run`).set(auth).send({ mode: 'draft' });
    await waitFor(run.body.executionId, ['waiting']);
    const c = await request(app).post(`/api/executions/${run.body.executionId}/cancel`).set(auth);
    expect(c.body.status).toBe('requested');
    const t0 = Date.now();
    expect((await waitFor(run.body.executionId)).status).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a worker that died mid-run is reported as failed, never re-run', async () => {
    const exec = { executionId: 'exe_orphan', workflowId: 'w', workflowName: 'w', department: null, workflowVersion: null, workflowVersionId: null, isTestRun: true, status: 'running' as const, triggerType: 'manual' as const, initiatedBy: 'boss', idempotencyKey: null, retryOf: null, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null, duration: null, errorSummary: null, stepCount: 1, triggerItems: [], triggerNodeId: 't' };
    await repos.executions.createIfAbsent(exec);
    await worker.executions.process('exe_orphan'); // job delivered again after a crash
    const res = await request(app).get('/api/executions/exe_orphan').set(auth);
    expect(res.body.status).toBe('failed');
    expect(res.body.errorSummary).toMatch(/worker stopped/);
  });

  it('activating a scheduled workflow registers a Redis job scheduler; deactivating removes it', async () => {
    const id = await create({ schemaVersion: 1, nodes: [{ id: 's', type: 'trigger.schedule', name: 'Every hour', position: { x: 0, y: 0 }, config: { mode: 'interval', every: 1, unit: 'hours' } }], connections: [] });
    await request(app).post(`/api/workflows/${id}/publish`).set(auth);
    await request(app).post(`/api/workflows/${id}/activate`).set(auth);
    const q = new Queue(SCHEDULE_QUEUE, { connection: { url: REDIS_URL } });
    const keys = async () => (await q.getJobSchedulers(0, -1)).map((s) => s.key);
    expect(await keys()).toContain(`wf:${id}:s`);
    await request(app).post(`/api/workflows/${id}/deactivate`).set(auth);
    expect(await keys()).not.toContain(`wf:${id}:s`);
    await q.close();
  });
});
