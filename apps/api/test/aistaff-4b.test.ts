import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import { extractIssues } from '@widebed/shared';
import type { InProcessScheduler } from '../src/services/scheduler.js';

/** AI Staff Phase 4b: notifications and long-term responsibilities. */

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

const bell = async (uid: string) => (await request(app).get('/api/notifications').set(as(uid))).body;
const waitFor = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('condition not met');
};

describe('Reading problems out of an answer', () => {
  it('splits the ```issues block off and gives each problem a stable id', () => {
    const r = extractIssues('## Bills\nAll checked.\n\n```issues\n- A12 TNB overdue | Unit A-12 TNB bill is 14 days overdue\n- b03-water | Water bill for B-03 missing\nB03 water | duplicate\n```');
    expect(r.text).toBe('## Bills\nAll checked.');
    expect(r.issues).toEqual([
      { key: 'a12-tnb-overdue', text: 'Unit A-12 TNB bill is 14 days overdue' },
      { key: 'b03-water', text: 'Water bill for B-03 missing' },
    ]);
    expect(extractIssues('Fine.\n```issues\nnone\n```').issues).toEqual([]);
    expect(extractIssues('No block here').issues).toEqual([]);
  });
});

describe('Notifications', () => {
  it('tell the person who gave a task when it is done, with a link', async () => {
    brain = () => ({ answer: '## Result\nThree bills **outstanding**.' });
    const id = (await request(app).post('/api/agent-tasks').set(as('amy')).send({ agentId: finId, instructions: 'Check bills' })).body.taskId;
    await ctx.agentTasks.idle(id);
    await waitFor(async () => (await bell('amy')).unread === 1);
    const b = await bell('amy');
    expect(b.items[0]).toMatchObject({ kind: 'task.completed', title: 'Finance Assistant finished “Check bills”', link: `/ai-tasks?task=${id}`, read: false });
    expect(b.items[0].body).toBe('Result Three bills outstanding.');
    expect((await bell('bob')).items).toEqual([]);
    // Nobody else can mark it read.
    expect((await request(app).post(`/api/notifications/${b.items[0].notificationId}/read`).set(as('bob'))).status).toBe(404);
    expect((await request(app).post(`/api/notifications/${b.items[0].notificationId}/read`).set(as('amy'))).status).toBe(200);
    expect((await bell('amy')).unread).toBe(0);
  });

  it('follow each person’s preferences', async () => {
    expect((await request(app).get('/api/notifications/prefs').set(as('amy'))).body).toEqual({ taskCompleted: true, taskFailed: true, issues: true, approvals: true, browser: false });
    await request(app).put('/api/notifications/prefs').set(as('amy')).send({ taskCompleted: false, taskFailed: true, issues: true, browser: true });
    brain = () => ({ answer: 'ok' });
    const id = (await request(app).post('/api/agent-tasks').set(as('amy')).send({ agentId: finId, instructions: 'Quiet one' })).body.taskId;
    await ctx.agentTasks.idle(id);
    await new Promise((r) => setTimeout(r, 50));
    expect((await bell('amy')).unread).toBe(0);
    failNext = [401];
    const bad = (await request(app).post('/api/agent-tasks').set(as('amy')).send({ agentId: finId, instructions: 'Loud failure' })).body.taskId;
    await ctx.agentTasks.idle(bad);
    await waitFor(async () => (await bell('amy')).unread === 1);
    expect((await bell('amy')).items[0]).toMatchObject({ kind: 'task.failed', title: '“Loud failure” failed' });
    expect((await request(app).post('/api/notifications/read-all').set(as('amy'))).body.marked).toBe(1);
    await request(app).put('/api/notifications/prefs').set(as('amy')).send({ taskCompleted: true, taskFailed: true, issues: true, browser: false });
  });

  it('for schedules: only failures by default, to the schedule’s owner and the AI employee’s managers', async () => {
    const s = (await request(app).post('/api/agent-schedules').set(as('boss')).send(scheduleBody({ name: 'Nightly' }))).body;
    brain = () => ({ answer: 'fine' });
    const ok = await ctx.agentTasks.fire(s.scheduleId, '2026-12-01T00:00:00.000Z', 'n1');
    await ctx.agentTasks.idle(ok!.taskId);
    await new Promise((r) => setTimeout(r, 50));
    expect((await bell('carl')).unread).toBe(0);
    failNext = [401];
    const bad = await ctx.agentTasks.fire(s.scheduleId, '2026-12-02T00:00:00.000Z', 'n2');
    await ctx.agentTasks.idle(bad!.taskId);
    await waitFor(async () => (await bell('carl')).unread === 1 && (await bell('boss')).unread === 1);
    expect((await bell('amy')).unread).toBe(0); // amy didn't make it and doesn't manage the AI employee
    await request(app).delete(`/api/agent-schedules/${s.scheduleId}`).set(as('boss'));
    await request(app).post('/api/notifications/read-all').set(as('carl'));
    await request(app).post('/api/notifications/read-all').set(as('boss'));
  });
});

describe('Long-term responsibilities', () => {
  let sched = '';
  let resp = '';

  it('are set by Admins and managers, and linked to schedules of the same AI employee', async () => {
    sched = (await request(app).post('/api/agent-schedules').set(as('carl')).send(scheduleBody({ name: 'Daily bills check' }))).body.scheduleId;
    const body = { agentId: finId, title: 'Monitor outstanding utility bills', description: 'Every bill paid on time.', status: 'active', autoFollowUp: true, scheduleIds: [sched] };
    expect((await request(app).post('/api/agent-responsibilities').set(as('amy')).send(body)).status).toBe(403);
    const opsSched = (await request(app).post('/api/agent-schedules').set(as('boss')).send(scheduleBody({ agentId: opsId, name: 'Ops' }))).body.scheduleId;
    expect((await request(app).post('/api/agent-responsibilities').set(as('boss')).send({ ...body, scheduleIds: [opsSched] })).status).toBe(400);
    const res = await request(app).post('/api/agent-responsibilities').set(as('carl')).send(body);
    expect(res.status).toBe(201);
    resp = res.body.responsibilityId;
    const list = (await request(app).get('/api/agent-responsibilities').set(as('carl'))).body.items;
    expect(list[0]).toMatchObject({ title: 'Monitor outstanding utility bills', schedules: [{ scheduleId: sched, name: 'Daily bills check' }], canEdit: true });
    expect((await request(app).get('/api/agent-responsibilities').set(as('bob'))).body.items).toEqual([]);
  });

  it('keep a list of open problems, with ONE follow-up per new problem', async () => {
    brain = (prompt) =>
      prompt.includes('Follow up on this problem')
        ? { answer: 'Likely cause: bill not forwarded. Next: call TNB.' }
        : { answer: 'Checked 12 bills.\n\n```issues\na12-tnb | A-12 TNB bill 14 days overdue\nb03-water | B-03 water bill missing\n```' };
    const t1 = await ctx.agentTasks.fire(sched, '2026-12-03T00:00:00.000Z', 'r1');
    const done = await ctx.agentTasks.idle(t1!.taskId);
    expect(done.output).toBe('Checked 12 bills.');
    expect(done.issues).toHaveLength(2);
    // Problems are filed just after the task is marked done.
    await waitFor(async () => (await repos.responsibilities.get(resp))!.runs === 1);
    let r = (await repos.responsibilities.get(resp))!;
    expect(r.openIssues.map((i) => i.key)).toEqual(['a12-tnb', 'b03-water']);
    expect(r.runs).toBe(1);
    const followUps = (await repos.agentTasks.listRecent(100)).filter((t) => t.source === 'followup');
    expect(followUps).toHaveLength(2);
    expect(followUps[0]).toMatchObject({ parentTaskId: t1!.taskId, responsibilityId: resp, priority: 'high', runAsId: 'carl' });
    for (const f of followUps) expect((await ctx.agentTasks.idle(f.taskId)).status).toBe('completed');
    await waitFor(async () => (await bell('carl')).items.some((n: any) => n.kind === 'issue.new'));
    expect((await bell('carl')).items.find((n: any) => n.kind === 'issue.new').title).toBe('Finance Assistant found 2 new problems');

    // Next day: A-12 still there, B-03 fixed, a new one appears.
    brain = (prompt) =>
      prompt.includes('Follow up on this problem')
        ? { answer: 'ok' }
        : { answer: 'Checked.\n```issues\na12-tnb | A-12 TNB bill 15 days overdue\nc07-gas | C-07 gas bill doubled\n```' };
    const t2 = await ctx.agentTasks.fire(sched, '2026-12-04T00:00:00.000Z', 'r2');
    await ctx.agentTasks.idle(t2!.taskId);
    await waitFor(async () => (await repos.responsibilities.get(resp))!.runs === 2);
    r = (await repos.responsibilities.get(resp))!;
    expect(r.openIssues.map((i) => `${i.key}:${i.seenCount}`)).toEqual(['a12-tnb:2', 'c07-gas:1']);
    expect(r.openIssues[0]!.text).toBe('A-12 TNB bill 15 days overdue');
    expect(r.resolvedIssues.map((i) => i.key)).toEqual(['b03-water']);
    const all = (await repos.agentTasks.listRecent(100)).filter((t) => t.source === 'followup');
    expect(all).toHaveLength(3); // only C-07 got a new follow-up; A-12 did not get a second one
    for (const f of all) await ctx.agentTasks.idle(f.taskId);
  });

  it('can be resolved by hand, and paused (its schedules then wait)', async () => {
    expect((await request(app).post(`/api/agent-responsibilities/${resp}/issues/a12-tnb/resolve`).set(as('amy'))).status).toBe(404);
    expect((await request(app).post(`/api/agent-responsibilities/${resp}/issues/a12-tnb/resolve`).set(as('carl'))).status).toBe(200);
    let r = (await repos.responsibilities.get(resp))!;
    expect(r.openIssues.map((i) => i.key)).toEqual(['c07-gas']);
    expect(r.resolvedIssues[0]!.key).toBe('a12-tnb');
    await request(app).put(`/api/agent-responsibilities/${resp}`).set(as('carl')).send({ agentId: finId, title: 'Monitor outstanding utility bills', description: '', status: 'paused', autoFollowUp: true, scheduleIds: [sched] });
    expect(await ctx.agentTasks.fire(sched, '2026-12-05T00:00:00.000Z', 'r3')).toBeNull();
    // Deleting it unlinks the schedule, which then runs as a normal schedule.
    expect((await request(app).delete(`/api/agent-responsibilities/${resp}`).set(as('carl'))).status).toBe(204);
    expect((await repos.agentSchedules.get(sched))!.responsibilityId).toBeNull();
    brain = () => ({ answer: 'plain run' });
    const t = await ctx.agentTasks.fire(sched, '2026-12-06T00:00:00.000Z', 'r4');
    expect((await ctx.agentTasks.idle(t!.taskId)).responsibilityId).toBeNull();
    r = (await repos.responsibilities.get(resp)) as any;
    expect(r).toBeNull();
  });
});
