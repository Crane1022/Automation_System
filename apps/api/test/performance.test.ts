import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { costOf, myDay, priceFor } from '@widebed/shared';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';

/** AI Staff Phase 8: AI Performance (real counts only; cost only with Admin prices). */

let fail = false;
const people: Record<string, { role: string; department: string | null }> = {
  boss: { role: 'admin', department: null },
  it: { role: 'it_admin', department: 'IT' },
  fin: { role: 'department_manager', department: 'Finance' },
  amy: { role: 'employee', department: 'Finance' },
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
        if (body.messages?.at(-1)?.content === 'Reply with the word OK.') return { status: 200, json: { model: body.model, choices: [{ message: { content: 'OK' } }] } };
        if (fail) return { status: 400, json: { error: { message: 'bad request' } } };
        // A real-looking answer with token counts, from a dated model name.
        return { status: 200, json: { model: 'gpt-4o-mini-2024-07-18', usage: { prompt_tokens: 1000, completion_tokens: 200 }, choices: [{ message: { content: JSON.stringify({ answer: 'done' }) } }] } };
      },
    },
  },
);
startProcessing(ctx);
const app = createApp(ctx);
const ids: Record<string, string> = {};
const base = { avatar: '🤖', color: 'slate', description: '', personality: '', communicationStyle: '', responsibilities: [], expertise: [], instructions: '', aiCredentialId: null, model: null, temperature: null, maxOutputTokens: 4000, memoryEnabled: false, maxSteps: 8, allowedUserIds: [], managerIds: [], approverIds: [], allowedRoles: [], status: 'active', templateId: null, canDelegate: false, visibility: 'company', tools: { memory: false, workflows: false, pms: false, browser: false, websites: 'all', knowledge: false } };

beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid.toUpperCase(), email: `${uid}@x.com`, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
  const aiId = (await request(app).post('/api/credentials/ai').set(as('it')).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-test-key-0000' })).body.credentialId;
  await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: false });
  for (const [name, department] of [['Finance Bot', 'Finance'], ['Ops Bot', 'Operations']] as const) {
    ids[name] = (await request(app).post('/api/agents').set(as('boss')).send({ ...base, name, title: name, department })).body.agentId;
  }
});

describe('Prices', () => {
  it('match a model exactly or by its start, and give no cost without a price', () => {
    const prices = [
      { model: 'gpt-4o', inputPerMillion: 2.5, outputPerMillion: 10 },
      { model: 'gpt-4o-mini', inputPerMillion: 0.15, outputPerMillion: 0.6 },
    ];
    expect(priceFor('gpt-4o-mini-2024-07-18', prices)?.model).toBe('gpt-4o-mini');
    expect(priceFor('GPT-4o', prices)?.model).toBe('gpt-4o');
    expect(Math.abs((costOf('gpt-4o-mini', 1_000_000, 1_000_000, prices) ?? NaN) - (0.75)) < 1e-9).toBe(true);
    expect(costOf('gemini-2.5-flash', 1000, 1000, prices)).toBeNull();
  });
});

describe('AI Performance', () => {
  it('counts real chats and tasks per AI employee: success rate, time, tokens', async () => {
    // A chat with Finance Bot (1 AI call) …
    const chatId = (await request(app).post('/api/assistant/chats').set(as('amy')).send({ agentId: ids['Finance Bot'] })).body.chatId;
    await request(app).post(`/api/assistant/chats/${chatId}/messages`).set(as('amy')).send({ text: 'hi' });
    await ctx.assistant.idle(chatId);
    // … two tasks that work, one that fails (Ops Bot).
    for (const agent of ['Finance Bot', 'Finance Bot']) {
      const t = (await request(app).post('/api/agent-tasks').set(as('amy')).send({ agentId: ids[agent], instructions: 'Check bills' })).body.taskId;
      await ctx.agentTasks.idle(t);
    }
    fail = true;
    const bad = (await request(app).post('/api/agent-tasks').set(as('boss')).send({ agentId: ids['Ops Bot'], instructions: 'Check units' })).body.taskId;
    expect((await ctx.agentTasks.idle(bad)).status).toBe('failed');
    fail = false;

    const r = (await request(app).get('/api/ai-performance?days=7').set(as('boss'))).body;
    expect(r.to).toBe(myDay());
    expect(r.daily).toHaveLength(7);
    const fin = r.agents.find((a: any) => a.name === 'Finance Bot');
    expect(fin).toMatchObject({ tasks: 2, completed: 2, failed: 0, successRate: 1, calls: 3, chatCalls: 1, taskCalls: 2, inputTokens: 3000, outputTokens: 600, cost: null, costPartial: true });
    const ops = r.agents.find((a: any) => a.name === 'Ops Bot');
    expect(ops).toMatchObject({ tasks: 1, completed: 0, failed: 1, successRate: 0, calls: 0 });
    expect(r.totals).toMatchObject({ tasks: 3, completed: 2, failed: 1, inputTokens: 3000, outputTokens: 600 });
    expect(Math.abs((r.totals.successRate) - (2 / 3)) < 1e-9).toBe(true);
    expect(r.daily.at(-1)).toMatchObject({ success: 2, failed: 1 });
    expect(r.dailyTokens.at(-1).tokens).toBe(3600);
    expect(r.models).toEqual([{ model: 'gpt-4o-mini-2024-07-18', calls: 3, inputTokens: 3000, outputTokens: 600, cost: null }]);
    expect(r.unpricedModels).toEqual(['gpt-4o-mini-2024-07-18']);
  });

  it('shows cost once an Admin sets the price', async () => {
    expect((await request(app).put('/api/ai-performance/prices').set(as('fin')).send({ prices: [] })).status).toBe(403);
    const set = await request(app).put('/api/ai-performance/prices').set(as('boss')).send({ prices: [{ model: 'gpt-4o-mini', inputPerMillion: 0.15, outputPerMillion: 0.6 }] });
    expect(set.status).toBe(200);
    const r = (await request(app).get('/api/ai-performance?days=7').set(as('boss'))).body;
    // 3000 × 0.15/1M + 600 × 0.6/1M
    expect(Math.abs((r.totals.cost) - (0.00081)) < 1e-9).toBe(true);
    expect(r.totals.costPartial).toBe(false);
    expect(r.unpricedModels).toEqual([]);
  });

  it('department managers see only their department; employees can’t see it', async () => {
    const r = (await request(app).get('/api/ai-performance?days=30').set(as('fin'))).body;
    expect(r.agents.map((a: any) => a.name)).toEqual(['Finance Bot']);
    expect(r.departments.map((d: any) => d.department)).toEqual(['Finance']);
    expect((await request(app).get('/api/ai-performance').set(as('amy'))).status).toBe(403);
    expect((await request(app).get('/api/ai-performance?days=5').set(as('boss'))).status).toBe(400);
  });
});
