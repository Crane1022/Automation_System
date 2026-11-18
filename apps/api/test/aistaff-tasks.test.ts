import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import type { InProcessScheduler } from '../src/services/scheduler.js';

/** AI Staff Phase 4a: background tasks, schedules and the Task Center. */

type Brain = (prompt: string) => object | Promise<object>;
let brain: Brain = () => ({ answer: 'done' });
/** Next AI calls fail with these HTTP statuses (then normal). */
let failNext: number[] = [];
let release: (() => void) | null = null;

const people: Record<string, { role: string; department: string | null }> = {
  boss: { role: 'admin', department: null },
  it: { role: 'it_admin', department: 'IT' },
  carl: { role: 'department_manager', department: 'Finance' },
  amy: { role: 'employee', department: 'Finance' },
  bob: { role: 'employee', department: 'Ops' },
};
const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t.replace('tok-', '')}@x.com`, name: t.replace('tok-', ''), emailVerified: true }) };
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });
const repos = createMemoryRepositories();
const ctx = buildContext(
  loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '100000', ASSISTANT_BROWSER: 'false' } as any),
  repos,
  verifier,
  {
    agentRetryDelayMs: 10,
    credentialOverrides: {
      aiFetch: async (_url, init) => {
        const body = JSON.parse(init.body ?? '{}');
        const prompt = body.messages?.at(-1)?.content ?? '';
        if (prompt === 'Reply with the word OK.') return { status: 200, json: { model: body.model, choices: [{ message: { content: 'OK' } }] } };
        const fail = failNext.shift();
        if (fail) return { status: fail, json: { error: { message: 'busy' } } };
        const reply = await brain(prompt);
        return { status: 200, json: { model: body.model, choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 50, completion_tokens: 10 } } };
      },
    },
  },
);
startProcessing(ctx);
const app = createApp(ctx);
const scheduler = ctx.scheduler as InProcessScheduler;

let finId = '';
let opsId = '';
const rule = (over: Record<string, unknown> = {}) => ({ mode: 'daily', time: '08:00', weekdays: ['1'], dayOfMonth: '1', every: 1, unit: 'hours', date: '', cron: '0 8 * * *', timezone: 'Asia/Kuala_Lumpur', ...over });
const scheduleBody = (over: Record<string, unknown> = {}) => ({ name: 'Outstanding bills', agentId: finId, instructions: 'List outstanding utility bills.', rule: rule(), startDate: null, endDate: null, priority: 'normal', enabled: true, ...over });

beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid.toUpperCase(), email: `${uid}@x.com`, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
  const aiId = (await request(app).post('/api/credentials/ai').set(as('it')).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-test-key-0000' })).body.credentialId;
  await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: false });
  const base = { avatar: '💰', color: 'amber', title: 'Finance', description: '', personality: '', communicationStyle: '', responsibilities: [], expertise: [], instructions: 'FIN', aiCredentialId: null, model: null, temperature: null, maxOutputTokens: 4000, tools: { memory: true, workflows: false, pms: false, browser: false, websites: 'all' }, memoryEnabled: true, maxSteps: 6, allowedUserIds: [], allowedRoles: [], status: 'active', templateId: null };
  finId = (await request(app).post('/api/agents').set(as('boss')).send({ ...base, name: 'Finance Assistant', department: 'Finance', visibility: 'department', managerIds: ['carl'] })).body.agentId;
  opsId = (await request(app).post('/api/agents').set(as('boss')).send({ ...base, name: 'Ops Assistant', department: 'Ops', visibility: 'department', managerIds: [] })).body.agentId;
});

describe('One-time background tasks', () => {
  it('runs in the background, records each step, tokens and the result', async () => {
    brain = (prompt) => (prompt.includes('TOOL RESULT of remember') ? { answer: '## Bills\n- TNB RM 120.50' } : { say: 'Noting', tool: 'remember', input: { fact: 'Bills are checked daily' } });
    const res = await request(app).post('/api/agent-tasks').set(as('amy')).send({ agentId: finId, instructions: 'Check the bills', priority: 'high' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'queued', source: 'manual', runAsId: 'amy', department: 'Finance', title: 'Check the bills', priority: 'high' });
    const t = await ctx.agentTasks.idle(res.body.taskId);
    expect(t).toMatchObject({ status: 'completed', output: '## Bills\n- TNB RM 120.50', inputTokens: 100, outputTokens: 20 });
    expect(t.steps.map((s) => `${s.label}:${s.status}`)).toEqual(['Remembering this:done']);
    expect(t.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('can only be given to AI staff you may chat with', async () => {
    expect((await request(app).post('/api/agent-tasks').set(as('bob')).send({ agentId: finId, instructions: 'x' })).status).toBe(404);
    expect((await request(app).post('/api/agent-tasks').set(as('amy')).send({ agentId: finId, instructions: '   ' })).status).toBe(400);
  });

  it('shows tasks only to the right people', async () => {
    brain = () => ({ answer: 'ok' });
    const mine = (await request(app).post('/api/agent-tasks').set(as('bob')).send({ agentId: opsId, instructions: 'Ops check' })).body.taskId;
    await ctx.agentTasks.idle(mine);
    const seen = async (uid: string) => (await request(app).get('/api/agent-tasks').set(as(uid))).body.items.map((t: any) => t.agentName);
    expect(await seen('bob')).toEqual(['Ops Assistant']);
    expect(await seen('amy')).toEqual(['Finance Assistant']);
    expect(await seen('carl')).toEqual(['Finance Assistant']); // manager of Finance + Finance department
    expect((await seen('boss')).sort()).toEqual(['Finance Assistant', 'Ops Assistant']);
    expect((await request(app).get(`/api/agent-tasks/${mine}`).set(as('amy'))).status).toBe(404);
    expect((await request(app).get('/api/agent-tasks').query({ agentId: opsId }).set(as('boss'))).body.items).toHaveLength(1);
  });

  it('can be stopped while running, and run again', async () => {
    brain = () => new Promise((r) => (release = () => r({ answer: 'late' })));
    const id = (await request(app).post('/api/agent-tasks').set(as('amy')).send({ agentId: finId, instructions: 'Slow job' })).body.taskId;
    for (let i = 0; i < 100 && (await repos.agentTasks.get(id))?.status !== 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await request(app).post(`/api/agent-tasks/${id}/cancel`).set(as('bob'))).status).toBe(404);
    expect((await request(app).post(`/api/agent-tasks/${id}/cancel`).set(as('amy'))).status).toBe(200);
    release?.();
    const t = await ctx.agentTasks.idle(id);
    expect(t.status).toBe('cancelled');
    expect((await request(app).post(`/api/agent-tasks/${id}/cancel`).set(as('amy'))).status).toBe(409);
    brain = () => ({ answer: 'second time' });
    expect((await request(app).post(`/api/agent-tasks/${id}/retry`).set(as('amy'))).status).toBe(202);
    expect(await ctx.agentTasks.idle(id)).toMatchObject({ status: 'completed', output: 'second time', attempt: 2 });
  });

  it('records the error when the AI fails, and never says it succeeded', async () => {
    failNext = [401];
    const id = (await request(app).post('/api/agent-tasks').set(as('amy')).send({ agentId: finId, instructions: 'Will fail' })).body.taskId;
    const t = await ctx.agentTasks.idle(id);
    expect(t.status).toBe('failed');
    expect(t.output).toBeNull();
    expect(t.error).toMatch(/refused the API key/);
  });

  it('fails clearly when the person it runs for no longer has an active account', async () => {
    brain = () => ({ answer: 'ok' });
    await repos.users.create({ uid: 'temp', name: 'TEMP', email: 'temp@x.com', role: 'employee', department: 'Finance', status: 'active', createdAt: '', lastLoginAt: null } as any);
    const id = (await request(app).post('/api/agent-tasks').set(as('temp')).send({ agentId: finId, instructions: 'x' })).body.taskId;
    await ctx.agentTasks.idle(id);
    await repos.users.update('temp', { status: 'disabled' } as any);
    await repos.agentTasks.update(id, { status: 'failed' });
    await request(app).post(`/api/agent-tasks/${id}/retry`).set(as('boss'));
    const t = await ctx.agentTasks.idle(id);
    expect(t).toMatchObject({ status: 'failed' });
    expect(t.error).toMatch(/no longer has an active account/);
  });
});

describe('Schedules', () => {
  let schedId = '';

  it('are made by Admins and the AI employee’s managers only, and checked', async () => {
    expect((await request(app).post('/api/agent-schedules').set(as('amy')).send(scheduleBody())).status).toBe(403);
    expect((await request(app).post('/api/agent-schedules').set(as('carl')).send(scheduleBody({ agentId: opsId }))).status).toBe(404);
    expect((await request(app).post('/api/agent-schedules').set(as('carl')).send(scheduleBody({ rule: rule({ time: '' }) }))).status).toBe(400);
    const res = await request(app).post('/api/agent-schedules').set(as('carl')).send(scheduleBody());
    expect(res.status).toBe(201);
    schedId = res.body.scheduleId;
    expect(res.body).toMatchObject({ runAsId: 'carl', describe: 'Every day at 8:00 AM', canEdit: true, agentName: 'Finance Assistant' });
    expect(Date.parse(res.body.nextRunAt)).toBeGreaterThan(Date.now());
    // Registered with the server-side scheduler (no browser needed).
    expect(scheduler.armed()).toContain(`ai-${schedId}:run`);
    expect((await request(app).get('/api/agent-schedules').set(as('amy'))).body.items).toEqual([]);
    expect((await request(app).get('/api/agent-schedules').set(as('boss'))).body.items).toHaveLength(1);
  });

  it('make exactly one task per occurrence, even if fired twice', async () => {
    brain = () => ({ answer: 'Bills: none outstanding' });
    const a = await ctx.agentTasks.fire(schedId, '2026-11-18T00:00:00.000Z', 'sched:occ-1');
    const b = await ctx.agentTasks.fire(schedId, '2026-11-18T00:00:00.000Z', 'sched:occ-1');
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    const t = await ctx.agentTasks.idle(a!.taskId);
    expect(t).toMatchObject({ status: 'completed', source: 'schedule', scheduleId: schedId, runAsId: 'carl', title: 'Outstanding bills' });
    const s = (await request(app).get('/api/agent-schedules').set(as('boss'))).body.items[0];
    expect(s).toMatchObject({ lastTaskId: a!.taskId, lastStatus: 'completed' });
  });

  it('retry once by themselves when the AI service is busy', async () => {
    failNext = [503];
    const t = await ctx.agentTasks.fire(schedId, '2026-11-19T00:00:00.000Z', 'sched:occ-2');
    const done = await ctx.agentTasks.idle(t!.taskId);
    expect(done).toMatchObject({ status: 'completed', attempt: 2 });
    expect(done.steps.some((s) => /Attempt 1 failed/.test(s.label))).toBe(true);
  });

  it('respect start and end dates', async () => {
    await request(app).put(`/api/agent-schedules/${schedId}`).set(as('carl')).send(scheduleBody({ startDate: '2099-01-01' }));
    expect(await ctx.agentTasks.fire(schedId, '2026-11-20T00:00:00.000Z', 'sched:occ-3')).toBeNull();
    await request(app).put(`/api/agent-schedules/${schedId}`).set(as('carl')).send(scheduleBody({ endDate: '2026-01-01' }));
    expect(await ctx.agentTasks.fire(schedId, '2026-11-20T00:00:00.000Z', 'sched:occ-4')).toBeNull();
    expect((await repos.agentSchedules.get(schedId))!.enabled).toBe(false);
    expect(scheduler.armed()).not.toContain(`ai-${schedId}:run`);
    await request(app).put(`/api/agent-schedules/${schedId}`).set(as('carl')).send(scheduleBody());
    expect(scheduler.armed()).toContain(`ai-${schedId}:run`);
  });

  it('“Run now” works, a switched-off AI employee gives a failed task, and deleting removes the timer', async () => {
    brain = () => ({ answer: 'ran now' });
    const now = await request(app).post(`/api/agent-schedules/${schedId}/run`).set(as('carl'));
    expect(now.status).toBe(202);
    expect(await ctx.agentTasks.idle(now.body.taskId)).toMatchObject({ status: 'completed', output: 'ran now' });

    await request(app).post(`/api/agents/${finId}/status`).set(as('boss')).send({ status: 'disabled' });
    const off = await ctx.agentTasks.fire(schedId, '2026-11-21T00:00:00.000Z', 'sched:occ-5');
    expect(off).toMatchObject({ status: 'failed' });
    expect(off!.error).toMatch(/switched off/);
    await request(app).post(`/api/agents/${finId}/status`).set(as('boss')).send({ status: 'active' });

    expect((await request(app).delete(`/api/agent-schedules/${schedId}`).set(as('amy'))).status).toBe(404);
    expect((await request(app).delete(`/api/agent-schedules/${schedId}`).set(as('carl'))).status).toBe(204);
    expect(scheduler.armed()).not.toContain(`ai-${schedId}:run`);
    const actions = (await request(app).get('/api/system/audit-logs').set(as('boss'))).body.items.map((l: any) => l.action);
    for (const a of ['agentSchedule.create', 'agentSchedule.update', 'agentSchedule.delete', 'agentTask.create']) expect(actions).toContain(a);
  });

  it('come back after a restart', async () => {
    const s = await request(app).post('/api/agent-schedules').set(as('boss')).send(scheduleBody({ name: 'Weekly', rule: rule({ mode: 'weekly', weekdays: ['1', '5'] }) }));
    expect(s.body.describe).toBe('Every Monday and Friday at 8:00 AM');
    await scheduler.close();
    expect(scheduler.armed()).toEqual([]);
    expect(await ctx.agentTasks.resyncAll()).toBe(1);
    expect(scheduler.armed()).toContain(`ai-${s.body.scheduleId}:run`);
  });
});
