import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildContext, startProcessing } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { TokenVerifier } from '../src/auth/verifier.js';
import { hashAction } from '../src/assistant/approvals.js';

/** AI Staff Phase 5: the Approval Center. */

type Brain = (prompt: string) => object;
let brain: Brain = () => ({ answer: 'ok' });

const people: Record<string, { role: string; department: string | null }> = {
  boss: { role: 'admin', department: null },
  it: { role: 'it_admin', department: 'IT' },
  ops: { role: 'department_manager', department: 'Ops' },
  bob: { role: 'employee', department: 'Ops' },
  eve: { role: 'employee', department: 'Finance' },
};
const verifier: TokenVerifier = { verify: async (t) => ({ uid: t.replace('tok-', ''), email: `${t.replace('tok-', '')}@x.com`, name: t.replace('tok-', ''), emailVerified: true }) };
const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });
const repos = createMemoryRepositories();
const ctx = buildContext(
  loadConfig({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 't', ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), RATE_LIMIT_PER_MINUTE: '100000', ASSISTANT_BROWSER: 'false' } as any),
  repos,
  verifier,
  {
    assistantWorkflowWait: { waitMs: 5000, pollMs: 20 },
    agentRetryDelayMs: 10,
    credentialOverrides: {
      aiFetch: async (_url, init) => {
        const body = JSON.parse(init.body ?? '{}');
        const prompt = body.messages?.at(-1)?.content ?? '';
        if (prompt === 'Reply with the word OK.') return { status: 200, json: { model: body.model, choices: [{ message: { content: 'OK' } }] } };
        return { status: 200, json: { model: body.model, choices: [{ message: { content: JSON.stringify(brain(prompt)) } }] } };
      },
    },
  },
);
startProcessing(ctx);
const app = createApp(ctx);

let agentId = '';
let wfId = '';
const runs = async () => (await repos.executions.list({ workflowId: wfId }, 50)).items;
const pending = async (uid: string) => (await request(app).get('/api/approvals').query({ status: 'pending' }).set(as(uid))).body.items;
const waitFor = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('condition not met');
};
/** The AI asks to run the workflow (with `who`), then reports. */
const workflowBrain = (who: string): Brain => (prompt) =>
  prompt.includes('said NO')
    ? { answer: 'OK, I did not run it.' }
    : prompt.includes('TOOL RESULT of run_workflow')
      ? { answer: prompt.includes('"status": "success"') ? 'Ran it.' : 'It failed.' }
      : { say: 'I need to run it.', tool: 'run_workflow', input: { workflowId: wfId, workflowName: 'Say hi', data: { who } } };

beforeAll(async () => {
  for (const [uid, p] of Object.entries(people)) {
    await repos.users.create({ uid, name: uid.toUpperCase(), email: `${uid}@x.com`, role: p.role as any, department: p.department, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null });
  }
  const aiId = (await request(app).post('/api/credentials/ai').set(as('it')).send({ name: 'OpenAI', service: 'openai', apiKey: 'sk-test-key-0000' })).body.credentialId;
  await request(app).put('/api/assistant/settings').set(as('it')).send({ enabled: true, aiCredentialId: aiId, pmsCredentialId: null, browserEnabled: false });
  wfId = (await request(app).post('/api/workflows').set(as('ops')).send({ name: 'Say hi' })).body.workflowId;
  await request(app).put(`/api/workflows/${wfId}/draft`).set(as('ops')).send({
    definition: {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'f', type: 'logic.filter', name: 'Keep', position: { x: 200, y: 0 }, config: { conditions: [{ left: '{{ $json.who }}', operator: 'isNotEmpty', right: '' }] } },
      ],
      connections: [{ id: 'c', source: 't', sourceHandle: 'main', target: 'f', targetHandle: 'main' }],
    },
  });
  await request(app).post(`/api/workflows/${wfId}/publish`).set(as('ops'));
  agentId = (
    await request(app).post('/api/agents').set(as('boss')).send({
      name: 'Ops Bot', avatar: '⚙️', color: 'slate', title: 'Automation', department: 'Ops', description: '', personality: '', communicationStyle: '', responsibilities: [], expertise: [], instructions: '',
      aiCredentialId: null, model: null, temperature: null, maxOutputTokens: 4000, tools: { memory: false, workflows: true, pms: false, browser: false, websites: 'all' }, memoryEnabled: false, maxSteps: 6,
      visibility: 'company', allowedUserIds: [], managerIds: [], approverIds: ['eve'], allowedRoles: [], status: 'active', templateId: null,
    })
  ).body.agentId;
});

describe('Chats', () => {
  it('put the request in the Approval Center, tied to the exact parameters', async () => {
    brain = workflowBrain('Ana');
    const chat = (await request(app).post('/api/assistant/chats').set(as('ops')).send({ agentId })).body.chatId;
    await request(app).post(`/api/assistant/chats/${chat}/messages`).set(as('ops')).send({ text: 'Run Say hi' });
    await ctx.assistant.idle(chat);
    const msg = (await request(app).get(`/api/assistant/chats/${chat}`).set(as('ops'))).body.messages.at(-1);
    expect(msg.pending).toMatchObject({ tool: 'run_workflow', level: 3, target: 'Workflows' });
    const [a] = await pending('ops');
    expect(a).toMatchObject({ approvalId: msg.pending.approvalId, source: 'chat', level: 3, status: 'pending', requestedFor: 'ops', canDecide: true, input: { workflowId: wfId, workflowName: 'Say hi', data: { who: 'Ana' } } });
    expect(a.inputHash).toBe(hashAction('run_workflow', { data: { who: 'Ana' }, workflowName: 'Say hi', workflowId: wfId }));
    // Not visible to a random employee; the named approver sees it and may decide.
    expect(await pending('bob')).toEqual([]);
    expect((await pending('eve'))[0]).toMatchObject({ canDecide: true });
    expect((await request(app).post(`/api/approvals/${a.approvalId}/decide`).set(as('bob')).send({ approve: true })).status).toBe(404);

    // Approving in the Approval Center continues the chat, which runs the workflow once.
    expect((await request(app).post(`/api/approvals/${a.approvalId}/decide`).set(as('eve')).send({ approve: true })).status).toBe(200);
    await waitFor(async () => (await request(app).get(`/api/assistant/chats/${chat}`).set(as('ops'))).body.messages.at(-1).status === 'done');
    const done = (await request(app).get(`/api/assistant/chats/${chat}`).set(as('ops'))).body.messages.at(-1);
    expect(done.text).toBe('Ran it.');
    expect(done.steps.map((s: any) => s.label)).toContain('EVE approved');
    expect(await runs()).toHaveLength(1);
    const used = (await repos.approvals.get(a.approvalId))!;
    expect(used).toMatchObject({ status: 'approved', decidedBy: 'eve' });
    expect(used.usedAt).toBeTruthy();
    // Single use: it can't be decided again.
    expect((await request(app).post(`/api/approvals/${a.approvalId}/decide`).set(as('boss')).send({ approve: true })).status).toBe(409);
  });

  it('withdraw the request when the person sends another message instead', async () => {
    brain = workflowBrain('Ben');
    const chat = (await request(app).post('/api/assistant/chats').set(as('ops')).send({ agentId })).body.chatId;
    await request(app).post(`/api/assistant/chats/${chat}/messages`).set(as('ops')).send({ text: 'Run Say hi' });
    await ctx.assistant.idle(chat);
    const id = (await pending('ops'))[0].approvalId;
    brain = () => ({ answer: 'Sure, never mind.' });
    await request(app).post(`/api/assistant/chats/${chat}/messages`).set(as('ops')).send({ text: 'Actually, don’t' });
    await ctx.assistant.idle(chat);
    expect((await repos.approvals.get(id))!.status).toBe('rejected');
    expect(await pending('ops')).toEqual([]);
  });
});

describe('Background tasks', () => {
  it('wait for approval instead of giving up, then carry on', async () => {
    brain = workflowBrain('Cara');
    const before = (await runs()).length;
    const task = (await request(app).post('/api/agent-tasks').set(as('ops')).send({ agentId, instructions: 'Run Say hi for Cara' })).body.taskId;
    await waitFor(async () => (await repos.agentTasks.get(task))!.status === 'waiting_approval');
    const t = (await repos.agentTasks.get(task))!;
    expect(t.steps.at(-1)).toMatchObject({ label: 'Waiting for approval: Running workflow Say hi', status: 'running' });
    // The person it runs for and the named approver are told.
    await waitFor(async () => (await request(app).get('/api/notifications').set(as('eve'))).body.items.some((n: any) => n.kind === 'approval.needed'));
    expect((await request(app).get('/api/notifications').set(as('ops'))).body.items.some((n: any) => n.kind === 'approval.needed')).toBe(true);

    const a = (await pending('ops')).find((x: any) => x.taskId === task);
    expect((await request(app).post(`/api/approvals/${a.approvalId}/decide`).set(as('ops')).send({ approve: true })).status).toBe(200);
    const done = await ctx.agentTasks.idle(task);
    expect(done).toMatchObject({ status: 'completed', output: 'Ran it.' });
    expect(done.steps.map((s) => s.label)).toContain('Approved by OPS: Running workflow Say hi');
    expect((await runs()).length).toBe(before + 1);
    const log = (await request(app).get('/api/system/audit-logs').set(as('boss'))).body.items;
    expect(log.find((l: any) => l.action === 'approval.approve' && l.resourceId === a.approvalId).metadata).toMatchObject({ tool: 'run_workflow', level: 3 });
  });

  it('when rejected, carry on without doing it', async () => {
    brain = workflowBrain('Dan');
    const before = (await runs()).length;
    const task = (await request(app).post('/api/agent-tasks').set(as('ops')).send({ agentId, instructions: 'Run it for Dan' })).body.taskId;
    await waitFor(async () => (await repos.agentTasks.get(task))!.status === 'waiting_approval');
    const a = (await pending('eve')).find((x: any) => x.taskId === task);
    await request(app).post(`/api/approvals/${a.approvalId}/decide`).set(as('eve')).send({ approve: false, note: 'Not today' });
    const done = await ctx.agentTasks.idle(task);
    expect(done).toMatchObject({ status: 'completed', output: 'OK, I did not run it.' });
    expect(done.steps.some((s) => s.label === 'Not approved by EVE (“Not today”): Running workflow Say hi')).toBe(true);
    expect((await runs()).length).toBe(before);
  });

  it('can be edited: the new parameters must be confirmed, and exactly those are used', async () => {
    brain = workflowBrain('Eli');
    const task = (await request(app).post('/api/agent-tasks').set(as('ops')).send({ agentId, instructions: 'Run it for Eli' })).body.taskId;
    await waitFor(async () => (await repos.agentTasks.get(task))!.status === 'waiting_approval');
    const a = (await pending('eve')).find((x: any) => x.taskId === task);
    expect((await request(app).post(`/api/approvals/${a.approvalId}/edit`).set(as('bob')).send({ input: { ...a.input, data: { who: 'X' } } })).status).toBe(404);
    expect((await request(app).post(`/api/approvals/${a.approvalId}/edit`).set(as('eve')).send({ input: a.input })).status).toBe(400);
    const edited = await request(app).post(`/api/approvals/${a.approvalId}/edit`).set(as('eve')).send({ input: { ...a.input, data: { who: 'Elena' } }, note: 'Full name' });
    expect(edited.status).toBe(201);
    expect(edited.body).toMatchObject({ status: 'pending', editedFrom: a.approvalId, editedBy: 'eve', input: { data: { who: 'Elena' } } });
    expect((await repos.approvals.get(a.approvalId))!.status).toBe('replaced');
    expect((await request(app).post(`/api/approvals/${a.approvalId}/decide`).set(as('eve')).send({ approve: true })).status).toBe(409);
    expect((await repos.agentTasks.get(task))!.approvalId).toBe(edited.body.approvalId);
    await request(app).post(`/api/approvals/${edited.body.approvalId}/decide`).set(as('ops')).send({ approve: true });
    expect(await ctx.agentTasks.idle(task)).toMatchObject({ status: 'completed' });
    const last = (await runs())[0]!;
    const exec = await repos.executions.get(last.executionId);
    expect(JSON.stringify(exec)).toContain('Elena');
  });

  it('expire if nobody decides: nothing is done and the task stops', async () => {
    brain = workflowBrain('Fay');
    const before = (await runs()).length;
    const task = (await request(app).post('/api/agent-tasks').set(as('ops')).send({ agentId, instructions: 'Run it for Fay' })).body.taskId;
    await waitFor(async () => (await repos.agentTasks.get(task))!.status === 'waiting_approval');
    const id = (await repos.agentTasks.get(task))!.approvalId!;
    await repos.approvals.transition(id, 'pending', { expiresAt: '2000-01-01T00:00:00.000Z' });
    expect((await request(app).post(`/api/approvals/${id}/decide`).set(as('ops')).send({ approve: true })).status).toBe(409);
    expect((await repos.approvals.get(id))!.status).toBe('expired');
    const t = await ctx.agentTasks.idle(task);
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/expired\. Nothing was done/);
    expect((await runs()).length).toBe(before);
  });

  it('stopping a waiting task withdraws its request', async () => {
    brain = workflowBrain('Gus');
    const task = (await request(app).post('/api/agent-tasks').set(as('ops')).send({ agentId, instructions: 'Run it for Gus' })).body.taskId;
    await waitFor(async () => (await repos.agentTasks.get(task))!.status === 'waiting_approval');
    const id = (await repos.agentTasks.get(task))!.approvalId!;
    expect((await request(app).post(`/api/agent-tasks/${task}/cancel`).set(as('ops'))).status).toBe(200);
    expect((await repos.agentTasks.get(task))!.status).toBe('cancelled');
    expect((await repos.approvals.get(id))!.status).toBe('rejected');
  });
});

describe('Levels and policy', () => {
  it('critical actions need an Admin or named approver who types APPROVE', async () => {
    const agent = (await repos.agents.get(agentId))!;
    const a = await ctx.approvals.create({ source: 'task', taskId: 'task_none', agent, requestedFor: 'ops', title: 'Pay bill', tool: 'browser_click', toolLabel: 'Clicking “Pay now”', input: { text: 'Pay now' }, details: 'Click “Pay now” on the website.', target: 'Saved website', level: 4, reason: '' });
    expect(Date.parse(a.expiresAt) - Date.parse(a.createdAt)).toBeLessThanOrEqual(2 * 3600_000);
    const view = (await pending('ops')).find((x: any) => x.approvalId === a.approvalId);
    expect(view).toMatchObject({ canDecide: false, whyNot: 'Critical actions need an Admin or a named approver' });
    expect((await request(app).post(`/api/approvals/${a.approvalId}/decide`).set(as('ops')).send({ approve: true })).status).toBe(403);
    expect((await request(app).post(`/api/approvals/${a.approvalId}/decide`).set(as('boss')).send({ approve: true })).status).toBe(400);
    expect((await request(app).post(`/api/approvals/${a.approvalId}/decide`).set(as('boss')).send({ approve: true, confirmWord: 'approve' })).status).toBe(200);
    // Admins were told about the critical request.
    expect((await request(app).get('/api/notifications').set(as('boss'))).body.items.some((n: any) => n.title === 'Ops Bot needs approval (critical)')).toBe(true);
  });

  it('an approval only lets that exact action run, once', async () => {
    const agent = (await repos.agents.get(agentId))!;
    const gate = ctx.approvals.gateFor({ taskId: 'task_x', inChat: false });
    const input = { workflowId: wfId, data: { who: 'Hal' } };
    expect(await gate({ tool: 'run_workflow', input, level: 3, details: '', target: '' })).toBe('ask');
    const a = await ctx.approvals.create({ source: 'task', taskId: 'task_x', agent, requestedFor: 'ops', title: 't', tool: 'run_workflow', toolLabel: 'x', input, details: '', target: 'Workflows', level: 3, reason: '' });
    await request(app).post(`/api/approvals/${a.approvalId}/decide`).set(as('ops')).send({ approve: true });
    expect(await gate({ tool: 'run_workflow', input: { data: { who: 'Hal' }, workflowId: wfId }, level: 3, details: '', target: '' })).toBe('run');
    expect(await gate({ tool: 'run_workflow', input: { workflowId: wfId, data: { who: 'Ivy' } }, level: 3, details: '', target: '' })).toBe('ask');
    expect(await ctx.approvals.gateFor({ taskId: 'task_other', inChat: false })({ tool: 'run_workflow', input, level: 3, details: '', target: '' })).toBe('ask');
    await ctx.approvals.markUsedIfGranted({ taskId: 'task_x' }, 'run_workflow', input);
    expect(await gate({ tool: 'run_workflow', input, level: 3, details: '', target: '' })).toBe('ask');
  });

  it('low-risk actions follow the Admin policy', async () => {
    const l2 = { tool: 'browser_type', input: { field: 'Search', text: 'bill' }, level: 2 as const, details: '', target: '' };
    expect((await request(app).put('/api/approvals/policy').set(as('ops')).send({ lowRiskPolicy: 'auto', approvalHours: 24 })).status).toBe(403);
    expect((await request(app).get('/api/approvals/policy').set(as('ops'))).body).toEqual({ lowRiskPolicy: 'auto_in_chat', approvalHours: 24 });
    expect(await ctx.approvals.gateFor({ chatId: 'c', inChat: true })(l2)).toBe('run');
    expect(await ctx.approvals.gateFor({ taskId: 't', inChat: false })(l2)).toBe('ask');
    await request(app).put('/api/approvals/policy').set(as('boss')).send({ lowRiskPolicy: 'ask', approvalHours: 12 });
    expect(await ctx.approvals.gateFor({ chatId: 'c', inChat: true })(l2)).toBe('ask');
    await request(app).put('/api/approvals/policy').set(as('boss')).send({ lowRiskPolicy: 'auto', approvalHours: 12 });
    expect(await ctx.approvals.gateFor({ taskId: 't', inChat: false })(l2)).toBe('run');
    expect(await ctx.approvals.gateFor({ taskId: 't', inChat: false })({ ...l2, level: 1 })).toBe('run');
    // The alert e-mail settings keep the policy when saved.
    const s = (await request(app).get('/api/system/settings').set(as('boss'))).body;
    await request(app).put('/api/system/settings').set(as('boss')).send({ alerts: s.alerts });
    expect((await request(app).get('/api/approvals/policy').set(as('boss'))).body).toEqual({ lowRiskPolicy: 'auto', approvalHours: 12 });
  });
});
