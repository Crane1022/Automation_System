import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowNode } from '@widebed/shared';
import { scheduleTriggerSchema } from '@widebed/nodes';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/create-app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import { lastRun, runDueSchedules } from '../src/services/schedule-tick.js';

const SECRET = 'test-cron-secret-0123456789abcdef';
const verifier: TokenVerifier = {
  async verify(token) {
    if (token !== 'tok-boss') throw new Error('bad token');
    return { uid: 'boss', email: 'boss@widebed.com', name: 'boss', emailVerified: false };
  },
};
const as = { Authorization: 'Bearer tok-boss' };
const config = loadConfig({
  NODE_ENV: 'test',
  FIREBASE_PROJECT_ID: 'widebed-automation',
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  PUBLIC_BASE_URL: 'https://automation.test',
  RATE_LIMIT_PER_MINUTE: '10000',
  CRON_SECRET: SECRET,
  CRON_WAIT_SECONDS: '5',
} as any);
const repos = createMemoryRepositories();
const ctx = buildContext(config, repos, verifier);
startProcessing(ctx);
const app = createApp(ctx);

const n = (id: string, type: string, cfg: Record<string, unknown> = {}): WorkflowNode => ({ id, type, name: id, position: { x: 0, y: 0 }, config: cfg });
async function activeWorkflow(name: string, schedule: Record<string, unknown>) {
  const def: WorkflowDefinition = { schemaVersion: 1, nodes: [n('s', 'trigger.schedule', schedule)], connections: [] };
  const id = (await request(app).post('/api/workflows').set(as).send({ name })).body.workflowId;
  await request(app).put(`/api/workflows/${id}/draft`).set(as).send({ definition: def });
  await request(app).post(`/api/workflows/${id}/publish`).set(as);
  await request(app).post(`/api/workflows/${id}/activate`).set(as);
  return id as string;
}

beforeAll(async () => {
  await repos.users.create({ uid: 'boss', name: 'boss', email: 'boss@widebed.com', role: 'super_admin', department: null, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
});

describe('lastRun', () => {
  const cfg = (c: Record<string, unknown>) => scheduleTriggerSchema.parse({ timezone: 'Asia/Kuala_Lumpur', ...c });
  it('finds the latest daily occurrence in Malaysia time', () => {
    const daily = cfg({ mode: 'daily', time: '09:00' });
    // 20 Nov 2026 9:05 AM KL = 01:05 UTC → today's 9:00 AM
    expect(new Date(lastRun(daily, Date.parse('2026-11-20T01:05:00Z'))!).toISOString()).toBe('2026-11-20T01:00:00.000Z');
    // 8:59 AM KL → yesterday's 9:00 AM
    expect(new Date(lastRun(daily, Date.parse('2026-11-20T00:59:00Z'))!).toISOString()).toBe('2026-11-19T01:00:00.000Z');
    // exactly 9:00 AM counts
    expect(new Date(lastRun(daily, Date.parse('2026-11-20T01:00:00Z'))!).toISOString()).toBe('2026-11-20T01:00:00.000Z');
  });
  it('handles once and interval', () => {
    const once = cfg({ mode: 'once', date: '2026-11-21', time: '10:00' });
    expect(lastRun(once, Date.parse('2026-11-20T01:00:00Z'))).toBeNull();
    expect(new Date(lastRun(once, Date.parse('2026-11-21T03:00:00Z'))!).toISOString()).toBe('2026-11-21T02:00:00.000Z');
    const every15 = cfg({ mode: 'interval', every: 15, unit: 'minutes' });
    expect(new Date(lastRun(every15, Date.parse('2026-11-20T01:07:00Z'))!).toISOString()).toBe('2026-11-20T01:00:00.000Z');
  });
});

describe('/cron/run-schedules', () => {
  it('is hidden without the right secret', async () => {
    expect((await request(app).get('/cron/run-schedules')).status).toBe(404);
    expect((await request(app).get('/cron/run-schedules').query({ key: 'wrong' })).status).toBe(404);
    expect((await request(app).get('/cron/run-schedules').set('Authorization', 'Bearer wrong')).status).toBe(404);
  });

  it('answers with the secret (query or Bearer)', async () => {
    const a = await request(app).get('/cron/run-schedules').query({ key: SECRET });
    expect(a.status).toBe(200);
    expect(a.body.ok).toBe(true);
    const b = await request(app).post('/cron/run-schedules').set('Authorization', `Bearer ${SECRET}`);
    expect(b.status).toBe(200);
  });

  it('starts a due occurrence once, waits for it, and skips old or inactive ones', async () => {
    const id = await activeWorkflow('every-minute', { mode: 'interval', every: 1, unit: 'minutes' });
    const later = Date.now() + 2 * 60_000; // two minutes later, the latest occurrence is after publishing

    const first = await runDueSchedules(ctx, { now: later, catchUpMs: 3 * 3_600_000, waitMs: 5000, pollMs: 20 });
    const mine = first.runs.filter((r) => r.workflowId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.alreadyStarted).toBe(false);
    expect(mine[0]!.status).toBe('success'); // waited for the run to finish

    const again = await runDueSchedules(ctx, { now: later, catchUpMs: 3 * 3_600_000, waitMs: 5000, pollMs: 20 });
    expect(again.runs.filter((r) => r.workflowId === id)[0]!.alreadyStarted).toBe(true);
    const list = await request(app).get('/api/executions').query({ workflowId: id }).set(as);
    expect(list.body.items).toHaveLength(1);

    // An occurrence from before the version was published is not run.
    const before = await runDueSchedules(ctx, { now: Date.now() - 2 * 60_000, catchUpMs: 3 * 3_600_000, waitMs: 0 });
    expect(before.runs.filter((r) => r.workflowId === id)).toHaveLength(0);

    // Too late (outside the catch-up window) is not run.
    const daily = await activeWorkflow('daily', { mode: 'daily', time: '09:00', timezone: 'Asia/Kuala_Lumpur' });
    const tooLate = await runDueSchedules(ctx, { now: Date.now() + 2 * 86_400_000, catchUpMs: 1, waitMs: 0 });
    expect(tooLate.runs.filter((r) => r.workflowId === daily)).toHaveLength(0);

    // Inactive workflows are not run.
    await request(app).post(`/api/workflows/${id}/deactivate`).set(as);
    const off = await runDueSchedules(ctx, { now: later + 60_000, catchUpMs: 3 * 3_600_000, waitMs: 0 });
    expect(off.runs.filter((r) => r.workflowId === id)).toHaveLength(0);
  });
});
