import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import { aiComplete, type AiFetch } from '../src/services/ai-client.js';

/* ------------------------------------------------------------ the AI client */

describe('AI client', () => {
  const capture = (status: number, json: any) => {
    const calls: { url: string; init: any }[] = [];
    const f: AiFetch = async (url, init) => { calls.push({ url, init }); return { status, json }; };
    return { f, calls };
  };

  it('talks to OpenAI, Claude and Gemini with their own request shapes', async () => {
    const o = capture(200, { model: 'gpt-x', choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    expect(await aiComplete({ service: 'openai', model: 'gpt-x', apiKey: 'sk-1' }, { prompt: 'hi', system: 'be nice', json: true, maxTokens: 50 }, o.f)).toEqual({ text: '{"a":1}', model: 'gpt-x', inputTokens: 3, outputTokens: 2 });
    expect(o.calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(o.calls[0]!.init.headers.authorization).toBe('Bearer sk-1');
    const ob = JSON.parse(o.calls[0]!.init.body);
    expect(ob).toMatchObject({ model: 'gpt-x', max_completion_tokens: 50, response_format: { type: 'json_object' } });
    expect(ob.messages[0].content).toMatch(/be nice[\s\S]*JSON/);
    expect(ob.temperature).toBeUndefined();

    const a = capture(200, { model: 'claude-x', content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 4, output_tokens: 1 } });
    expect((await aiComplete({ service: 'anthropic', model: 'claude-x', apiKey: 'sk-ant' }, { prompt: 'hi' }, a.f)).text).toBe('Hello');
    expect(a.calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(a.calls[0]!.init.headers['x-api-key']).toBe('sk-ant');
    expect(JSON.parse(a.calls[0]!.init.body)).toMatchObject({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });

    const g = capture(200, { candidates: [{ content: { parts: [{ text: 'Hi' }, { text: '!' }] } }], modelVersion: 'gemini-z' });
    expect(await aiComplete({ service: 'gemini', model: 'gemini-flash-latest', apiKey: 'AIza' }, { prompt: 'hi', json: true }, g.f)).toMatchObject({ text: 'Hi!', model: 'gemini-z' });
    expect(g.calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
    expect(JSON.parse(g.calls[0]!.init.body).generationConfig.responseMimeType).toBe('application/json');
  });

  it('turns service errors into plain-language messages', async () => {
    const err = async (status: number, json: any) => aiComplete({ service: 'openai', model: 'gpt-nope', apiKey: 'k' }, { prompt: 'x' }, capture(status, json).f).catch((e) => e);
    expect((await err(401, { error: { message: 'Incorrect API key' } })).code).toBe('AI_AUTH');
    expect((await err(404, { error: { message: 'The model `gpt-nope` does not exist' } })).message).toMatch(/model “gpt-nope” is not available/);
    const busy = await err(429, { error: { message: 'Rate limit' } });
    expect([busy.code, busy.retryable]).toEqual(['AI_RATE_LIMIT', true]);
    expect((await err(503, {})).retryable).toBe(true);
  });
});

/* ----------------------------------------------------- connection + workflow */

const people: Record<string, { role: string; department: string | null }> = {
  it: { role: 'it_admin', department: 'IT' },
  ops: { role: 'department_manager', department: 'Ops' },
};
const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t}@x.com`, name: t, emailVerified: true }) };
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });
const repos = createMemoryRepositories();
const aiCalls: { url: string; body: any; key: string }[] = [];
let aiStatus = 200;
const ctx = buildContext(
  loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '10000' } as any),
  repos,
  verifier,
  {
    credentialOverrides: {
      aiFetch: async (url, init) => {
        const body = JSON.parse(init.body ?? '{}');
        aiCalls.push({ url, body, key: init.headers?.authorization ?? '' });
        if (aiStatus !== 200) return { status: aiStatus, json: { error: { message: 'Incorrect API key provided' } } };
        const prompt = body.messages?.at(-1)?.content ?? '';
        const content = prompt.includes('Choose the ONE category') ? (prompt.includes('refund') ? '{"category":"Cancellation","reason":"wants refund"}' : '{"category":"Other","reason":"-"}') : 'OK';
        return { status: 200, json: { model: body.model, choices: [{ message: { content } }] } };
      },
    },
  },
);
startProcessing(ctx);
const app = createApp(ctx);

beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid, email: `${uid}@x.com`, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
});

async function waitFor(id: string) {
  for (let i = 0; i < 200; i++) {
    const res = await request(app).get(`/api/executions/${id}`).set(as('it'));
    if (['success', 'failed', 'cancelled'].includes(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('execution did not finish');
}

describe('AI connections', () => {
  let credId = '';

  it('checks the key before saving, stores it encrypted and never returns it', async () => {
    aiStatus = 401;
    const bad = await request(app).post('/api/credentials/ai').set(as('it')).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-wrong-key-123456' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/refused the API key/);
    aiStatus = 200;

    const ok = await request(app).post('/api/credentials/ai').set(as('it')).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-secret-key-ABCD' });
    expect(ok.status).toBe(201);
    credId = ok.body.credentialId;
    expect(ok.body.details).toEqual({ aiService: 'openai', model: 'gpt-5.4-mini', keyEnding: 'ABCD' });
    expect(ok.body.lastTestResult).toMatch(/Connected/);
    expect(JSON.stringify(ok.body)).not.toContain('sk-secret');
    expect(await repos.credentialSecrets.get(credId)).not.toContain('sk-secret');
    expect(aiCalls.at(-1)!.key).toBe('Bearer sk-secret-key-ABCD');

    expect((await request(app).post('/api/credentials/ai').set(as('ops')).send({ name: 'x', service: 'openai', apiKey: 'sk-0123456789' })).status).toBe(403);
  });

  it('can change the model (tested first) and run AI steps in a workflow', async () => {
    const patch = await request(app).patch(`/api/credentials/${credId}`).set(as('it')).send({ model: 'gpt-5.5' });
    expect(patch.body.details.model).toBe('gpt-5.5');

    const created = await request(app).post('/api/workflows').set(as('ops')).send({ name: 'Sort mail' });
    const id = created.body.workflowId;
    const definition = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: { testData: '[{"body":"I want a refund"},{"body":"hello"}]' } },
        { id: 'c', type: 'ai.classify', name: 'Sort', position: { x: 200, y: 0 }, credentialId: credId, config: { text: '{{ $json.body }}', categories: [{ id: 'c_x', label: 'Cancellation', value: '' }, { id: 'c_y', label: 'Complaint', value: '' }] } },
      ],
      connections: [{ id: 'e', source: 't', sourceHandle: 'main', target: 'c', targetHandle: 'main' }],
    };
    expect((await request(app).put(`/api/workflows/${id}/draft`).set(as('ops')).send({ definition })).status).toBe(200);
    const exec = await waitFor((await request(app).post(`/api/workflows/${id}/run`).set(as('ops')).send({ mode: 'draft' })).body.executionId);
    expect(exec.status).toBe('success');
    const step = exec.steps.find((s: any) => s.nodeId === 'c');
    expect(step.outputData.c_x).toEqual([{ body: 'I want a refund', category: 'Cancellation', reason: 'wants refund' }]);
    expect(step.outputData.otherwise.map((x: any) => x.category)).toEqual(['Other']);
    expect(aiCalls.at(-1)!.body.model).toBe('gpt-5.5');
  });
});
