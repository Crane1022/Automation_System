import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/create-app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import { partialJsonString } from '../src/assistant/agent.js';
import { aiStream, listAiModels, type AiStreamFetch } from '../src/services/ai-client.js';

/* ------------------------------------------------------------- fake AI (streamed) */

type Brain = (prompt: string, system: string) => object;
let brain: Brain = () => ({ answer: 'Hello!' });
const calls: { model: string; system: string; prompt: string; temperature?: number }[] = [];

/** Sends the JSON reply in small pieces, like a real streamed answer. */
const streamFetch: AiStreamFetch = async (_url, init) => {
  const body = JSON.parse(init.body ?? '{}');
  const system = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
  const prompt = body.messages?.at(-1)?.content ?? '';
  calls.push({ model: body.model, system, prompt, temperature: body.temperature });
  const reply = JSON.stringify(brain(prompt, system));
  const pieces = reply.match(/.{1,7}/gs) ?? [];
  async function* lines() {
    for (const p of pieces) {
      yield `data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: p } }] })}`;
      yield '';
      await new Promise((r) => setTimeout(r, 1));
    }
    yield `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}`;
    yield 'data: [DONE]';
  }
  return { status: 200, lines: lines() };
};

const people: Record<string, { role: string; department: string | null }> = {
  boss: { role: 'admin', department: null },
  it: { role: 'it_admin', department: 'IT' },
  amy: { role: 'employee', department: 'Finance' },
  bob: { role: 'employee', department: 'Ops' },
};
const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t}@x.com`, name: t.replace('tok-', ''), emailVerified: true }) };
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });
const repos = createMemoryRepositories();
const ctx = buildContext(
  loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '100000', ASSISTANT_BROWSER: 'false' } as any),
  repos,
  verifier,
  {
    credentialOverrides: {
      // Non-streamed calls: the connection test and the model list.
      aiFetch: async (url, init) => {
        if (url.endsWith('/v1/models')) return { status: 200, json: { data: [{ id: 'gpt-5-mini' }, { id: 'gpt-4o-audio-preview' }, { id: 'text-embedding-3' }, { id: 'gpt-5' }] } };
        const body = JSON.parse(init.body ?? '{}');
        const system = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
        const prompt = body.messages?.at(-1)?.content ?? '';
        if (prompt === 'Reply with the word OK.') return { status: 200, json: { model: body.model, choices: [{ message: { content: 'OK' } }] } };
        calls.push({ model: body.model, system, prompt, temperature: body.temperature });
        return { status: 200, json: { model: body.model, choices: [{ message: { content: JSON.stringify(brain(prompt, system)) } }] } };
      },
      aiStreamFetch: streamFetch,
    },
  },
);
startProcessing(ctx);
const app = createApp(ctx);

let aiId = '';
async function turn(uid: string, chatId: string, text: string) {
  const r = await request(app).post(`/api/assistant/chats/${chatId}/messages`).set(as(uid)).send({ text });
  expect(r.status).toBe(202);
  await ctx.assistant.idle(chatId);
  return (await request(app).get(`/api/assistant/chats/${chatId}`).set(as(uid))).body;
}
const agentBody = (over: Record<string, unknown> = {}) => ({
  name: 'Finance Assistant',
  avatar: '💰',
  color: 'amber',
  title: 'Finance & Utilities',
  department: 'Finance',
  description: 'Checks bills.',
  personality: 'Careful.',
  communicationStyle: 'Use RM amounts.',
  responsibilities: ['Check outstanding utility bills'],
  expertise: ['Bills'],
  instructions: 'Always end with SECRET-INSTRUCTION-OK.',
  aiCredentialId: null,
  model: 'gpt-5-mini',
  temperature: 0.2,
  maxOutputTokens: 4000,
  tools: { memory: true, workflows: false, pms: false, browser: false, websites: 'all' },
  memoryEnabled: true,
  maxSteps: 6,
  visibility: 'department',
  allowedUserIds: [],
  allowedRoles: [],
  status: 'active',
  templateId: null,
  ...over,
});

beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid.toUpperCase(), email: `${uid}@x.com`, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
  aiId = (await request(app).post('/api/credentials/ai').set(as('it')).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-test-key-0000' })).body.credentialId;
  await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: false });
});

describe('AI Staff registry', () => {
  it('turns the existing Widebed Assistant into the first AI employee', async () => {
    const res = await request(app).get('/api/agents').set(as('bob'));
    expect(res.status).toBe(200);
    expect(res.body.canManage).toBe(false);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ agentId: 'widebed-assistant', name: 'Widebed Assistant', builtIn: true, problem: null });
    expect(res.body.items[0].aiName).toContain('OpenAI');
    // Employees never get instructions or access lists.
    expect((await request(app).get('/api/agents/widebed-assistant').set(as('bob'))).body.agent).toBeUndefined();
  });

  it('lets only Admins create agents, from scratch or a template', async () => {
    expect((await request(app).post('/api/agents').set(as('bob')).send(agentBody())).status).toBe(403);
    expect((await request(app).post('/api/agents').set(as('boss')).send(agentBody({ name: '' }))).status).toBe(400);
    const tpl = await request(app).post('/api/agents').set(as('boss')).send({ templateId: 'pms-assistant' });
    expect(tpl.status).toBe(201);
    expect(tpl.body).toMatchObject({ name: 'PMS Assistant', templateId: 'pms-assistant', tools: { pms: true, workflows: false } });
    const t = await request(app).get('/api/agents/templates').set(as('bob'));
    expect(t.body.items.map((x: any) => x.templateId)).toContain('main-manager');
  });

  it('shows department agents only to that department', async () => {
    const fin = await request(app).post('/api/agents').set(as('boss')).send(agentBody());
    expect(fin.status).toBe(201);
    const id = fin.body.agentId;
    expect((await request(app).get('/api/agents').set(as('amy'))).body.items.map((a: any) => a.name)).toContain('Finance Assistant');
    expect((await request(app).get('/api/agents').set(as('bob'))).body.items.map((a: any) => a.name)).not.toContain('Finance Assistant');
    expect((await request(app).get(`/api/agents/${id}`).set(as('bob'))).status).toBe(404);
    expect((await request(app).post('/api/assistant/chats').set(as('bob')).send({ agentId: id })).status).toBe(404);
    // Named people get access whatever the visibility.
    await request(app).put(`/api/agents/${id}`).set(as('boss')).send(agentBody({ allowedUserIds: ['bob'] }));
    expect((await request(app).get(`/api/agents/${id}`).set(as('bob'))).status).toBe(200);
    await request(app).put(`/api/agents/${id}`).set(as('boss')).send(agentBody());
    // A private agent is only for its creator (and admins).
    const priv = await request(app).post('/api/agents').set(as('boss')).send(agentBody({ name: 'Boss helper', visibility: 'private' }));
    expect((await request(app).get(`/api/agents/${priv.body.agentId}`).set(as('amy'))).status).toBe(404);
    // Role filter.
    const mgr = await request(app).post('/api/agents').set(as('boss')).send(agentBody({ name: 'Managers only', visibility: 'company', allowedRoles: ['department_manager'] }));
    expect((await request(app).get(`/api/agents/${mgr.body.agentId}`).set(as('amy'))).status).toBe(404);
  });
});

describe('Chatting with an AI employee', () => {
  let finId = '';
  beforeAll(async () => {
    finId = (await request(app).get('/api/agents').set(as('amy'))).body.items.find((a: any) => a.name === 'Finance Assistant').agentId;
  });

  it('speaks as itself, with its own model, temperature and tools, and streams the answer', async () => {
    const chat = await request(app).post('/api/assistant/chats').set(as('amy')).send({ agentId: finId });
    expect(chat.status).toBe(201);
    expect(chat.body.agentId).toBe(finId);
    const live: string[] = [];
    const stop = await ctx.assistant.subscribe((await repos.users.get('amy'))!, chat.body.chatId, (e) => {
      if (e.type === 'text') live.push(e.text);
    });
    brain = () => ({ answer: 'Two bills are unpaid: TNB RM 120.50 and Air Selangor RM 33.10. SECRET-INSTRUCTION-OK' });
    calls.length = 0;
    const body = await turn('amy', chat.body.chatId, 'Any unpaid bills?');
    stop();
    expect(body.messages.at(-1)).toMatchObject({ role: 'assistant', status: 'done' });
    expect(body.messages.at(-1).text).toContain('RM 120.50');
    expect(calls[0]).toMatchObject({ model: 'gpt-5-mini', temperature: 0.2 });
    expect(calls[0]!.system).toContain('You are Finance Assistant, Finance & Utilities in the Finance department');
    expect(calls[0]!.system).toContain('Always end with SECRET-INSTRUCTION-OK.');
    expect(calls[0]!.system).toContain('- remember:');
    expect(calls[0]!.system).not.toContain('list_workflows');
    // Several partial texts arrived before the final one, each longer than the last.
    expect(live.length).toBeGreaterThan(3);
    expect(live.at(-1)).toContain('SECRET-INSTRUCTION-OK');
    expect(live[0]!.length).toBeLessThan(live.at(-1)!.length);
    // Chats are listed per agent.
    expect((await request(app).get('/api/assistant/chats').query({ agentId: finId }).set(as('amy'))).body.items).toHaveLength(1);
    expect((await request(app).get('/api/assistant/chats').set(as('amy'))).body.items).toHaveLength(0);
  });

  it('keeps a separate memory per AI employee', async () => {
    const chat = await request(app).post('/api/assistant/chats').set(as('amy')).send({ agentId: finId });
    brain = (prompt) => (prompt.includes('TOOL RESULT of remember') ? { answer: 'Noted.' } : { say: 'Saving', tool: 'remember', input: { fact: 'Unit A-12 TNB account is 2200-1111' } });
    await turn('amy', chat.body.chatId, 'Remember A-12 TNB account 2200-1111');
    const fin = await request(app).get('/api/assistant/memories').query({ agentId: finId }).set(as('amy'));
    expect(fin.body.items.map((m: any) => m.text)).toEqual(['Unit A-12 TNB account is 2200-1111']);
    expect((await request(app).get('/api/assistant/memories').set(as('amy'))).body.items).toEqual([]);
    // An old memory (made before AI Staff, no agentId) still belongs to the Widebed Assistant.
    await repos.assistant.addMemory({ memoryId: 'mem_old', ownerId: 'amy', text: 'Prefers Malay', createdAt: '2026-11-01T00:00:00.000Z' });
    expect((await request(app).get('/api/assistant/memories').set(as('amy'))).body.items.map((m: any) => m.text)).toEqual(['Prefers Malay']);
    // And the next chat with Finance knows its own fact, not the other one.
    brain = () => ({ answer: 'ok' });
    calls.length = 0;
    const c2 = await request(app).post('/api/assistant/chats').set(as('amy')).send({ agentId: finId });
    await turn('amy', c2.body.chatId, 'hi');
    expect(calls[0]!.system).toContain('2200-1111');
    expect(calls[0]!.system).not.toContain('Prefers Malay');
  });

  it('answers again with Regenerate, replacing the old answer', async () => {
    const chat = await request(app).post('/api/assistant/chats').set(as('amy')).send({ agentId: finId });
    brain = () => ({ answer: 'First try' });
    await turn('amy', chat.body.chatId, 'Summarise');
    brain = () => ({ answer: 'Second try' });
    expect((await request(app).post(`/api/assistant/chats/${chat.body.chatId}/regenerate`).set(as('amy'))).status).toBe(202);
    await ctx.assistant.idle(chat.body.chatId);
    const msgs = (await request(app).get(`/api/assistant/chats/${chat.body.chatId}`).set(as('amy'))).body.messages;
    expect(msgs.map((m: any) => `${m.role}:${m.text}`)).toEqual(['user:Summarise', 'assistant:Second try']);
  });

  it('stops working when switched off; archive before delete; the built-in one stays', async () => {
    expect((await request(app).post(`/api/agents/${finId}/status`).set(as('amy')).send({ status: 'disabled' })).status).toBe(403);
    expect((await request(app).post(`/api/agents/${finId}/status`).set(as('boss')).send({ status: 'disabled' })).status).toBe(200);
    expect((await request(app).post('/api/assistant/chats').set(as('amy')).send({ agentId: finId })).status).toBe(404);
    expect((await request(app).delete(`/api/agents/${finId}`).set(as('boss'))).status).toBe(409);
    const copy = await request(app).post(`/api/agents/${finId}/duplicate`).set(as('boss'));
    expect(copy.body).toMatchObject({ name: 'Finance Assistant (copy)', instructions: 'Always end with SECRET-INSTRUCTION-OK.' });
    await request(app).post(`/api/agents/${finId}/status`).set(as('boss')).send({ status: 'archived' });
    expect((await request(app).delete(`/api/agents/${finId}`).set(as('boss'))).status).toBe(204);
    expect((await request(app).post('/api/agents/widebed-assistant/status').set(as('boss')).send({ status: 'archived' })).status).toBe(400);
    const log = await request(app).get('/api/system/audit-logs').set(as('boss'));
    const actions = log.body.items.map((l: any) => l.action);
    for (const a of ['agent.create', 'agent.update', 'agent.disable', 'agent.archive', 'agent.delete']) expect(actions).toContain(a);
  });

  it('lists the models of an AI connection from the AI service', async () => {
    expect((await request(app).get('/api/agents/models').query({ credentialId: aiId }).set(as('amy'))).status).toBe(403);
    const res = await request(app).get('/api/agents/models').query({ credentialId: aiId }).set(as('boss'));
    expect(res.body.models.map((m: any) => m.id)).toEqual(['gpt-5-mini', 'gpt-5']);
  });

  it('lets the AI Agent workflow step work as a named AI employee', async () => {
    const ops = await request(app).post('/api/agents').set(as('boss')).send(agentBody({ name: 'Ops Bot', visibility: 'company', department: 'Ops', instructions: 'OPS-MARKER' }));
    brain = () => ({ answer: 'done' });
    calls.length = 0;
    const res = await ctx.assistant.runHeadless((await repos.users.get('bob'))!, { goal: 'daily check', usePms: false, useWorkflows: false, websites: [], allowActions: false, agentId: ops.body.agentId });
    expect(res.answer).toBe('done');
    expect(calls[0]!.system).toContain('OPS-MARKER');
  });
});

describe('Streaming helpers', () => {
  it('reads the answer text from JSON that is still being written', () => {
    expect(partialJsonString('{"say":"x","tool"', 'answer')).toBeNull();
    expect(partialJsonString('{"answer": "Hel', 'answer')).toBe('Hel');
    expect(partialJsonString('{"answer":"a\\nb \\"q\\" \\u00e9', 'answer')).toBe('a\nb "q" é');
    expect(partialJsonString('{"answer":"half \\', 'answer')).toBe('half ');
    expect(partialJsonString('{"answer":"done"}', 'answer')).toBe('done');
  });

  const sse = (events: object[]): AiStreamFetch => async () => ({
    status: 200,
    lines: (async function* () {
      for (const e of events) yield `data: ${JSON.stringify(e)}`;
    })(),
  });

  it('understands the streams of Claude and Gemini too', async () => {
    const seen: string[] = [];
    const claude = await aiStream(
      { service: 'anthropic', model: 'claude-x', apiKey: 'k' },
      { prompt: 'hi' },
      (t) => seen.push(t),
      sse([
        { type: 'message_start', message: { model: 'claude-x-1', usage: { input_tokens: 9 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      ]),
    );
    expect(claude).toEqual({ text: 'Hello', model: 'claude-x-1', inputTokens: 9, outputTokens: 2 });
    expect(seen).toEqual(['Hel', 'Hello']);
    const gemini = await aiStream(
      { service: 'gemini', model: 'g', apiKey: 'k' },
      { prompt: 'hi' },
      () => undefined,
      sse([
        { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Hi ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'there' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 }, modelVersion: 'g-2' },
      ]),
    );
    expect(gemini).toEqual({ text: 'Hi there', model: 'g-2', inputTokens: 5, outputTokens: 2 });
    const err = await aiStream({ service: 'openai', model: 'm', apiKey: 'bad' }, { prompt: 'x' }, () => undefined, async () => ({ status: 401, json: { error: { message: 'bad key' } } })).catch((e) => e);
    expect(err.message).toMatch(/refused the API key/);
  });

  it('filters the model lists of Gemini and Claude', async () => {
    const g = await listAiModels({ service: 'gemini', apiKey: 'k' }, async () => ({
      status: 200,
      json: { models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }] },
    }));
    expect(g).toEqual([{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }]);
    const c = await listAiModels({ service: 'anthropic', apiKey: 'k' }, async () => ({ status: 200, json: { data: [{ id: 'claude-x', display_name: 'Claude X' }] } }));
    expect(c).toEqual([{ id: 'claude-x', label: 'Claude X' }]);
  });
});
