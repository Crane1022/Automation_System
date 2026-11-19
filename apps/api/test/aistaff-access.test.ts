import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { memorySecretProblem } from '@widebed/shared';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/create-app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';

/** AI Staff Phase 3: who may use, change and see what. */

type Brain = (prompt: string) => object;
let brain: Brain = () => ({ answer: 'ok' });
const systems: string[] = [];

const people: Record<string, { role: string; department: string | null; status?: string }> = {
  boss: { role: 'admin', department: null },
  it: { role: 'it_admin', department: 'IT' },
  carl: { role: 'department_manager', department: 'Finance' },
  amy: { role: 'employee', department: 'Finance' },
  bob: { role: 'employee', department: 'Ops' },
  gone: { role: 'employee', department: 'Finance', status: 'disabled' },
};
const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t.replace('tok-', '')}@x.com`, name: t.replace('tok-', ''), emailVerified: true }) };
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });
const repos = createMemoryRepositories();
const ctx = buildContext(
  loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '100000', ASSISTANT_BROWSER: 'false' } as any),
  repos,
  verifier,
  {
    credentialOverrides: {
      aiFetch: async (_url, init) => {
        const body = JSON.parse(init.body ?? '{}');
        const prompt = body.messages?.at(-1)?.content ?? '';
        if (prompt === 'Reply with the word OK.') return { status: 200, json: { model: body.model, choices: [{ message: { content: 'OK' } }] } };
        systems.push(body.messages?.[0]?.content ?? '');
        return { status: 200, json: { model: body.model, choices: [{ message: { content: JSON.stringify(brain(prompt)) } }] } };
      },
    },
  },
);
startProcessing(ctx);
const app = createApp(ctx);

const agentBody = (over: Record<string, unknown> = {}) => ({
  name: 'Finance Assistant',
  avatar: '💰',
  color: 'amber',
  title: 'Finance',
  department: 'Finance',
  description: 'Bills.',
  personality: 'Careful.',
  communicationStyle: 'Short.',
  responsibilities: ['Check bills'],
  expertise: ['Bills'],
  instructions: 'TOP-SECRET-INSTRUCTIONS',
  aiCredentialId: null,
  model: null,
  temperature: null,
  maxOutputTokens: 4000,
  tools: { memory: true, workflows: false, pms: false, browser: false, websites: 'all' },
  memoryEnabled: true,
  maxSteps: 6,
  visibility: 'department',
  allowedUserIds: [],
  managerIds: [],
  allowedRoles: [],
  status: 'active',
  templateId: null,
  ...over,
});

let finId = '';
let amyChat = '';
beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid.toUpperCase(), email: `${uid}@x.com`, role: p.role as any, department: p.department, status: (p.status ?? 'active') as any, createdAt: new Date().toISOString(), lastLoginAt: null });
  }
  const aiId = (await request(app).post('/api/credentials/ai').set(as('it')).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-test-key-0000' })).body.credentialId;
  await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: false });
  finId = (await request(app).post('/api/agents').set(as('boss')).send(agentBody({ managerIds: ['carl'] }))).body.agentId;
  amyChat = (await request(app).post('/api/assistant/chats').set(as('amy')).send({ agentId: finId })).body.chatId;
  await request(app).post(`/api/assistant/chats/${amyChat}/messages`).set(as('amy')).send({ text: 'My private question about RM 9,999' });
  await ctx.assistant.idle(amyChat);
});

describe('Private chats stay private', () => {
  it('nobody else can read, follow, continue or delete someone’s chat — not even an Admin', async () => {
    for (const who of ['bob', 'carl', 'boss']) {
      expect((await request(app).get(`/api/assistant/chats/${amyChat}`).set(as(who))).status).toBe(404);
      expect((await request(app).get(`/api/assistant/chats/${amyChat}/stream`).set(as(who))).status).toBe(404);
      expect((await request(app).post(`/api/assistant/chats/${amyChat}/messages`).set(as(who)).send({ text: 'hi' })).status).toBe(404);
      expect((await request(app).post(`/api/assistant/chats/${amyChat}/regenerate`).set(as(who))).status).toBe(404);
      expect((await request(app).post(`/api/assistant/chats/${amyChat}/decision`).set(as(who)).send({ approve: true })).status).toBe(404);
      expect((await request(app).post(`/api/assistant/chats/${amyChat}/stop`).set(as(who))).status).toBe(404);
      expect((await request(app).delete(`/api/assistant/chats/${amyChat}`).set(as(who))).status).toBe(404);
      const list = await request(app).get('/api/assistant/chats').query({ agentId: finId }).set(as(who));
      expect(JSON.stringify(list.body)).not.toContain('RM 9,999');
    }
    expect((await request(app).get(`/api/assistant/chats/${amyChat}`).set(as('amy'))).status).toBe(200);
  });

  it('a disabled account can’t do anything', async () => {
    expect((await request(app).get('/api/agents').set(as('gone'))).status).toBe(403);
  });

  it('losing access to an AI employee keeps the old chat readable but stops new messages', async () => {
    await request(app).put(`/api/agents/${finId}`).set(as('boss')).send(agentBody({ managerIds: ['carl'], visibility: 'private' }));
    expect((await request(app).get(`/api/assistant/chats/${amyChat}`).set(as('amy'))).status).toBe(200);
    expect((await request(app).post(`/api/assistant/chats/${amyChat}/messages`).set(as('amy')).send({ text: 'again' })).status).toBe(404);
    expect((await request(app).post(`/api/assistant/chats/${amyChat}/regenerate`).set(as('amy'))).status).toBe(404);
    await request(app).put(`/api/agents/${finId}`).set(as('boss')).send(agentBody({ managerIds: ['carl'] }));
  });

  it('never shows instructions or access lists to people who only chat', async () => {
    for (const path of ['/api/agents', `/api/agents/${finId}`]) {
      const body = JSON.stringify((await request(app).get(path).set(as('amy'))).body);
      expect(body).not.toContain('TOP-SECRET-INSTRUCTIONS');
      expect(body).not.toContain('managerIds');
    }
    expect((await request(app).get(`/api/agents/${finId}/access`).set(as('amy'))).status).toBe(403);
  });

  it('a department agent without a department is for Admins only', async () => {
    const id = (await request(app).post('/api/agents').set(as('boss')).send(agentBody({ name: 'No dept', department: null }))).body.agentId;
    expect((await request(app).get(`/api/agents/${id}`).set(as('amy'))).status).toBe(404);
    expect((await request(app).get(`/api/agents/${id}`).set(as('boss'))).status).toBe(200);
  });
});

describe('Delegated managers', () => {
  it('may change the job and instructions, but not the AI, tools or who may use it', async () => {
    const got = await request(app).get(`/api/agents/${finId}`).set(as('carl'));
    expect(got.body.agent.instructions).toBe('TOP-SECRET-INSTRUCTIONS');
    expect(got.body.summary).toMatchObject({ canEdit: true, canManage: false });
    const res = await request(app)
      .put(`/api/agents/${finId}`)
      .set(as('carl'))
      .send(agentBody({ instructions: 'Show overdue bills first.', responsibilities: ['Check bills', 'Weekly summary'], visibility: 'company', tools: { memory: true, workflows: true, pms: true, browser: true, websites: 'all' }, model: 'gpt-x', managerIds: ['carl', 'bob'], allowedUserIds: ['bob'], name: 'Hacked' }));
    expect(res.status).toBe(200);
    const a = (await request(app).get(`/api/agents/${finId}`).set(as('boss'))).body.agent;
    expect(a).toMatchObject({ instructions: 'Show overdue bills first.', responsibilities: ['Check bills', 'Weekly summary'], name: 'Finance Assistant', visibility: 'department', model: null, managerIds: ['carl'], allowedUserIds: [] });
    expect(a.tools).toMatchObject({ workflows: false, pms: false, browser: false });
  });

  it('can’t switch it off, delete it, create new ones, or touch other AI staff', async () => {
    expect((await request(app).post(`/api/agents/${finId}/status`).set(as('carl')).send({ status: 'disabled' })).status).toBe(403);
    expect((await request(app).post('/api/agents').set(as('carl')).send(agentBody())).status).toBe(403);
    expect((await request(app).post(`/api/agents/${finId}/duplicate`).set(as('carl'))).status).toBe(403);
    const other = (await request(app).post('/api/agents').set(as('boss')).send(agentBody({ name: 'Ops bot', department: 'Finance', managerIds: [] }))).body.agentId;
    expect((await request(app).put(`/api/agents/${other}`).set(as('carl')).send(agentBody())).status).toBe(403);
    expect((await request(app).get(`/api/agents/${other}`).set(as('carl'))).body.agent).toBeUndefined();
  });

  it('see who can chat with it and why', async () => {
    const res = await request(app).get(`/api/agents/${finId}/access`).set(as('carl'));
    expect(res.status).toBe(200);
    const list = Object.fromEntries(res.body.items.map((p: any) => [p.uid, p.why]));
    expect(list).toEqual({ amy: 'Finance department', boss: 'Admin', carl: 'Manager of this AI employee' });
  });
});

describe('Memory: Admin review and secret filter', () => {
  it('refuses passwords, IC and card numbers, but keeps normal account numbers', async () => {
    expect(memorySecretProblem('Unit A-12 TNB account is 220012345678')).toBeNull();
    expect(memorySecretProblem('Pin this to the top of reports')).toBeNull();
    expect(memorySecretProblem('myTNB password is Hunter2!')).toMatch(/password/);
    expect(memorySecretProblem('pin: 4455')).toMatch(/password|code/);
    expect(memorySecretProblem('Amy IC 900101-14-5566')).toMatch(/IC/);
    expect(memorySecretProblem('NRIC 900101145566')).toMatch(/IC/);
    expect(memorySecretProblem('Company card 4111 1111 1111 1111')).toMatch(/card/);
    expect((await request(app).post('/api/assistant/memories').set(as('amy')).send({ text: 'password is abc12345', agentId: finId })).status).toBe(400);
    // The AI can't save it either.
    const chat = (await request(app).post('/api/assistant/chats').set(as('amy')).send({ agentId: finId })).body.chatId;
    brain = (prompt) => (prompt.includes('TOOL RESULT of remember') ? { answer: 'I did not save that.' } : { say: 'Saving', tool: 'remember', input: { fact: 'Card 4111 1111 1111 1111' } });
    await request(app).post(`/api/assistant/chats/${chat}/messages`).set(as('amy')).send({ text: 'remember my card 4111 1111 1111 1111' });
    await ctx.assistant.idle(chat);
    expect((await request(app).get('/api/assistant/memories').query({ agentId: finId }).set(as('amy'))).body.items).toEqual([]);
  });

  it('lets people edit their own memory', async () => {
    const m = (await request(app).post('/api/assistant/memories').set(as('amy')).send({ text: 'Prefers tables', agentId: finId })).body;
    const res = await request(app).patch(`/api/assistant/memories/${m.memoryId}`).set(as('amy')).send({ text: 'Prefers short tables' });
    expect(res.body.text).toBe('Prefers short tables');
    expect((await request(app).patch(`/api/assistant/memories/${m.memoryId}`).set(as('bob')).send({ text: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/api/assistant/memories/${m.memoryId}`).set(as('carl'))).status).toBe(404);
  });

  it('lets Admins review, correct and delete what an AI employee remembers — and records it', async () => {
    expect((await request(app).get(`/api/agents/${finId}/memories`).set(as('carl'))).status).toBe(403);
    const res = await request(app).get(`/api/agents/${finId}/memories`).set(as('boss'));
    expect(res.status).toBe(200);
    const m = res.body.items.find((x: any) => x.text === 'Prefers short tables');
    expect(m).toMatchObject({ ownerId: 'amy', ownerName: 'AMY' });
    expect((await request(app).patch(`/api/assistant/memories/${m.memoryId}`).set(as('boss')).send({ text: 'Prefers tables (checked)' })).status).toBe(200);
    expect((await request(app).delete(`/api/assistant/memories/${m.memoryId}`).set(as('boss'))).status).toBe(204);
    const actions = (await request(app).get('/api/system/audit-logs').set(as('boss'))).body.items.map((l: any) => l.action);
    for (const a of ['memory.review', 'memory.edit', 'memory.delete']) expect(actions).toContain(a);
  });
});
