import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';

/** AI Staff Phase 6: the Main Manager hands work to AI colleagues. */

type Brain = (who: string, prompt: string, system: string) => object | Promise<object>;
let brain: Brain = () => ({ answer: 'ok' });
const systems: Record<string, string[]> = {};
const timeline: string[] = [];

const people: Record<string, { role: string; department: string | null }> = {
  boss: { role: 'admin', department: null },
  it: { role: 'it_admin', department: 'IT' },
  bob: { role: 'department_manager', department: 'Ops' },
  amy: { role: 'employee', department: 'Ops' },
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
        const system: string = body.messages?.[0]?.content ?? '';
        const who = /You are ([A-Za-z ]+?)(,| —)/.exec(system)?.[1] ?? 'Widebed';
        (systems[who] ??= []).push(system);
        const reply = await brain(who, prompt, system);
        return { status: 200, json: { model: body.model, choices: [{ message: { content: JSON.stringify(reply) } }] } };
      },
    },
  },
);
startProcessing(ctx);
const app = createApp(ctx);

const base = { avatar: '🤖', color: 'slate', description: '', personality: '', communicationStyle: '', responsibilities: [], expertise: [], instructions: '', aiCredentialId: null, model: null, temperature: null, maxOutputTokens: 4000, memoryEnabled: false, maxSteps: 8, allowedUserIds: [], managerIds: [], approverIds: [], allowedRoles: [], status: 'active', templateId: null };
const tools = (o: Record<string, boolean> = {}) => ({ memory: false, workflows: false, pms: false, browser: false, websites: 'all', ...o });
const ids: Record<string, string> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function chat(uid: string, agent: string, text: string) {
  const id = (await request(app).post('/api/assistant/chats').set(as(uid)).send({ agentId: ids[agent] })).body.chatId;
  await request(app).post(`/api/assistant/chats/${id}/messages`).set(as(uid)).send({ text });
  await ctx.assistant.idle(id);
  return { id, body: (await request(app).get(`/api/assistant/chats/${id}`).set(as(uid))).body };
}

beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid.toUpperCase(), email: `${uid}@x.com`, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
  const aiId = (await request(app).post('/api/credentials/ai').set(as('it')).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-test-key-0000' })).body.credentialId;
  await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: false });
  const make = async (name: string, o: Record<string, unknown>) => {
    const res = await request(app).post('/api/agents').set(as('boss')).send({ ...base, name, title: name, department: null, visibility: 'company', tools: tools(), canDelegate: false, ...o });
    expect(res.status).toBe(201);
    ids[name] = res.body.agentId;
  };
  await make('Main Manager', { canDelegate: true, tools: tools({ memory: true }), managerIds: ['bob'] });
  await make('Front Desk', { expertise: ['Bookings'] });
  await make('Fixer', { tools: tools({ workflows: true }), responsibilities: ['Fix issues'] });
  await make('Second Manager', { canDelegate: true });
  await make('HR Bot', { visibility: 'department', department: 'HR' });
});

describe('The team', () => {
  it('only includes colleagues the person may use — never the manager itself or other managers', async () => {
    brain = (who, prompt) => (who === 'Main Manager' && !prompt.includes('TOOL RESULT') ? { tool: 'list_team', input: {} } : { answer: 'done' });
    const { body } = await chat('amy', 'Main Manager', 'Who is on the team?');
    expect(body.messages.at(-1).text).toBe('done');
    const sys = systems['Main Manager']!.at(-1)!;
    expect(sys).toContain('- delegate:');
    const team = await ctx.agentTasks.delegation.team((await repos.users.get('amy'))!, (await repos.agents.get(ids['Main Manager']!))!);
    expect(team.map((a) => a.name).sort()).toEqual(['Fixer', 'Front Desk', 'Widebed Assistant']);
  });
});

describe('Delegating', () => {
  it('runs independent parts at the same time, hands results to the part that waits, and combines', async () => {
    timeline.length = 0;
    brain = async (who, prompt) => {
      if (who === 'Main Manager') {
        if (!prompt.includes('TOOL RESULT of delegate'))
          return {
            say: 'Splitting the work',
            tool: 'delegate',
            input: {
              assignments: [
                { agent: 'Front Desk', task: 'List tomorrow’s arrivals' },
                { agent: 'Fixer', task: 'List open issues' },
                { agent: 'Front Desk', task: 'Match arrivals with issues', after: [0, 1] },
              ],
            },
          };
        const parts = (prompt.match(/"status": "done"/g) ?? []).length;
        return { answer: `Report: ${parts} parts done. ${prompt.includes('A-12 has a leak') ? 'A-12 guest affected.' : ''}` };
      }
      if (who === 'Front Desk' && prompt.includes('Match arrivals')) {
        return { answer: prompt.includes('Results from your colleagues') && prompt.includes('Guest Lee → A-12') && prompt.includes('A-12 leaking') ? 'A-12 has a leak and Lee arrives tomorrow.' : 'missing input' };
      }
      timeline.push(`${who} start`);
      await sleep(60);
      timeline.push(`${who} end`);
      return { answer: who === 'Front Desk' ? 'Guest Lee → A-12' : 'A-12 leaking' };
    };
    const { id, body } = await chat('amy', 'Main Manager', 'Prepare tomorrow’s report');
    const last = body.messages.at(-1);
    expect(last.text).toBe('Report: 3 parts done. A-12 guest affected.');
    expect(last.steps.map((s: any) => s.label)).toContain('Handing work to Front Desk, Fixer');
    // The two independent parts overlapped.
    expect(timeline.indexOf('Fixer start')).toBeLessThan(timeline.indexOf('Front Desk end'));
    // Saved as a project with three sub-tasks run for amy.
    const projects = (await request(app).get('/api/agent-projects').set(as('amy'))).body.items;
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ status: 'done', managerName: 'Main Manager', chatId: id, requestedFor: 'amy' });
    expect(projects[0].subtasks.map((t: any) => `${t.agentName}:${t.status}`)).toEqual(['Front Desk:completed', 'Fixer:completed', 'Front Desk:completed']);
    expect(projects[0].subtasks[2].dependsOn).toEqual([projects[0].subtasks[0].taskId, projects[0].subtasks[1].taskId]);
    const sub = (await repos.agentTasks.get(projects[0].subtasks[1].taskId))!;
    expect(sub).toMatchObject({ source: 'delegation', runAsId: 'amy', projectId: projects[0].projectId });
    // Visible to the manager's managers and Admins, not to others.
    expect((await request(app).get('/api/agent-projects').set(as('bob'))).body.items).toHaveLength(1);
    expect((await request(app).get('/api/agent-projects').set(as('it'))).body.items).toHaveLength(0);
  });

  it('never gives a helper more than the manager has, and helpers can’t delegate further', async () => {
    delete systems['Fixer'];
    brain = (who, prompt) =>
      who === 'Main Manager'
        ? prompt.includes('TOOL RESULT of delegate')
          ? { answer: 'ok' }
          : { tool: 'delegate', input: { assignments: [{ agent: 'Fixer', task: 'Check workflows' }] } }
        : { answer: 'checked' };
    await chat('bob', 'Main Manager', 'Check');
    const helper = systems['Fixer']!.at(-1)!;
    expect(helper).not.toContain('list_workflows'); // Fixer has workflows, but the manager doesn't
    expect(helper).not.toContain('- delegate:');
    // Talking to Fixer directly, it does have its workflow tools.
    brain = () => ({ answer: 'hi' });
    await chat('bob', 'Fixer', 'hi');
    expect(systems['Fixer']!.at(-1)!).toContain('list_workflows');
  });

  it('refuses colleagues the person can’t use, too many parts, and endless re-delegating', async () => {
    let round = 0;
    const results: string[] = [];
    brain = (who, prompt) => {
      if (who !== 'Main Manager') return { answer: 'x' };
      const m = /TOOL RESULT of delegate[^\n]*\n<<<\n([\s\S]*?)\n>>>/g;
      const all = [...prompt.matchAll(m)].map((x) => x[1]!);
      if (all.length > results.length) results.push(all.at(-1)!);
      round++;
      if (round === 1) return { tool: 'delegate', input: { assignments: [{ agent: 'HR Bot', task: 'x' }] } };
      if (round === 2) return { tool: 'delegate', input: { assignments: Array.from({ length: 7 }, () => ({ agent: 'Fixer', task: 'x' })) } };
      if (round === 3) return { tool: 'delegate', input: { assignments: [{ agent: 'Fixer', task: 'x', after: [0] }] } };
      if (round === 4) return { tool: 'delegate', input: { assignments: [{ agent: 'Second Manager', task: 'x' }] } };
      if (round <= 7) return { tool: 'delegate', input: { assignments: [{ agent: 'Fixer', task: 'x' }] } };
      return { answer: 'gave up' };
    };
    await chat('amy', 'Main Manager', 'Try things');
    expect(results[0]).toMatch(/“HR Bot” is not an available colleague/);
    expect(results[1]).toMatch(/At most 6 assignments/);
    expect(results[2]).toMatch(/"after" may only list earlier assignments/);
    expect(results[3]).toMatch(/“Second Manager” is not an available colleague/);
    expect(results[4]).not.toMatch(/ERROR/);
    expect(results[5]).not.toMatch(/ERROR/);
    expect(results[6]).toMatch(/already delegated 2 times/);
  });

  it('skips a part whose input failed, and reports it', async () => {
    brain = (who, prompt) => {
      if (who === 'Main Manager') return prompt.includes('TOOL RESULT of delegate') ? { answer: prompt.includes('Skipped: it needed the result') ? 'partial report' : 'full report' } : { tool: 'delegate', input: { assignments: [{ agent: 'Fixer', task: 'Fail please' }, { agent: 'Front Desk', task: 'Use it', after: [0] }] } };
      if (prompt.includes('Fail please')) throw new Error('boom');
      return { answer: 'fine' };
    };
    // Make the Fixer's AI call fail with a refused key.
    const orig = brain;
    brain = (who, prompt, system) => (who === 'Fixer' ? Promise.reject(new Error('down')) : orig(who, prompt, system));
    const { body } = await chat('amy', 'Main Manager', 'Go');
    expect(body.messages.at(-1).text).toBe('partial report');
    const p = (await request(app).get('/api/agent-projects').set(as('amy'))).body.items[0];
    expect(p.status).toBe('failed');
    expect(p.subtasks.map((t: any) => t.status)).toEqual(['failed', 'cancelled']);
  });

  it('stops the helpers when the manager is stopped', async () => {
    let release: (() => void) | null = null;
    brain = (who, prompt) =>
      who === 'Main Manager'
        ? prompt.includes('TOOL RESULT') ? { answer: 'stopped?' } : { tool: 'delegate', input: { assignments: [{ agent: 'Fixer', task: 'Slow one' }, { agent: 'Front Desk', task: 'Later', after: [0] }] } }
        : new Promise((r) => (release = () => r({ answer: 'late' })));
    const id = (await request(app).post('/api/assistant/chats').set(as('amy')).send({ agentId: ids['Main Manager'] })).body.chatId;
    await request(app).post(`/api/assistant/chats/${id}/messages`).set(as('amy')).send({ text: 'Go slow' });
    for (let i = 0; i < 100 && !release; i++) await sleep(10);
    await request(app).post(`/api/assistant/chats/${id}/stop`).set(as('amy'));
    release!();
    await ctx.assistant.idle(id);
    await sleep(50);
    const p = (await request(app).get('/api/agent-projects').set(as('amy'))).body.items[0];
    expect(p.status).toBe('cancelled');
    expect(p.subtasks.map((t: any) => t.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('also works as a background task given to the manager', async () => {
    brain = (who, prompt) =>
      who === 'Main Manager'
        ? prompt.includes('TOOL RESULT of delegate') ? { answer: 'Combined: arrivals + issues' } : { tool: 'delegate', input: { assignments: [{ agent: 'Front Desk', task: 'Arrivals' }, { agent: 'Fixer', task: 'Issues' }] } }
        : { answer: `${who} result` };
    const t = (await request(app).post('/api/agent-tasks').set(as('amy')).send({ agentId: ids['Main Manager'], instructions: 'Daily report' })).body.taskId;
    expect(await ctx.agentTasks.idle(t)).toMatchObject({ status: 'completed', output: 'Combined: arrivals + issues' });
    const p = (await request(app).get('/api/agent-projects').set(as('amy'))).body.items[0];
    expect(p).toMatchObject({ taskId: t, status: 'done' });
    const subs = await Promise.all(p.subtasks.map((s: any) => repos.agentTasks.get(s.taskId)));
    expect(subs.every((s) => s!.parentTaskId === t)).toBe(true);
    // Helpers report to the manager; they don't send their own notifications.
    const kinds = (await request(app).get('/api/notifications').set(as('amy'))).body.items.map((n: any) => n.title);
    expect(kinds.filter((k: string) => k.includes('Front Desk finished'))).toEqual([]);
    expect(kinds).toContain('Main Manager finished “Daily report”');
  });
});
